import type { SQL } from "drizzle-orm";
import { createDb, sql } from "~/db/client.server";
import { privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";

/** At most 100 parent edges; malformed, broken, over-deep or cyclic chains fail closed. */
const MAX_ANCESTOR_DEPTH = 100;
type NodeKind = "file" | "directory";

export type FileAction =
  | "file_read" | "file_edit"
  | "private_comment_read" | "private_comment_create" | "private_comment_edit_own"
  | "private_comment_delete_own" | "private_comment_delete_any"
  | "collaborators_public_comment_read" | "public_audience_comment_read"
  | "public_audience_comment_post_device" | "share_manage" | "publication_manage"
  | "publication_request" | "export_owned_file";
export type DirectoryAction = "directory_read" | "child_create" | "import_target" | "share_manage";
export type StructuralAction = "rename" | "reorder" | "delete";

type AuthorityRow = { level: number; is_owner: number };

/** The anchor and every ancestor must be current, committed and owned by the content Owner.
 * A complete chain MUST terminate at that Owner's registered hidden root. Node IDs alone
 * (or the recipient's own root) never confer access. One primary-key parent seek per edge.
 * Once Import commits exist, replace `import_id IS NULL` with the commit-marker visibility check.
 */
function lineage(anchorId: string, ownerId: string, kind: NodeKind | null): SQL {
  return sql`WITH RECURSIVE lineage(id, kind, parent_node_id, depth) AS (
    SELECT n.id, n.kind, n.parent_node_id, 0 FROM vault_nodes n
      WHERE n.id = ${anchorId} AND n.owner_id = ${ownerId}
        AND (${kind} IS NULL OR n.kind = ${kind}) AND n.import_id IS NULL
    UNION ALL
    SELECT parent.id, parent.kind, parent.parent_node_id, child.depth + 1
      FROM lineage child JOIN vault_nodes parent ON parent.id = child.parent_node_id
      WHERE child.depth < ${MAX_ANCESTOR_DEPTH} AND parent.owner_id = ${ownerId}
        AND parent.kind = 'directory' AND parent.import_id IS NULL
  )`;
}

function rooted(ownerId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM lineage root
    JOIN account_encryption_identities identity ON identity.account_id = ${ownerId}
      AND identity.root_directory_id = root.id
    WHERE root.parent_node_id IS NULL AND root.kind = 'directory')`;
}

/** Composable current-authority SELECT. EXPLAIN this same query in storage tests.
 * No path, parent ID or Directory capability leaves this private SQL computation.
 */
export function fileAuthorityQuery(auth: AuthorizedDevice, ownerId: string, fileId: string): SQL {
  return scopeAuthorityQuery(auth, ownerId, fileId, "file");
}

function scopeAuthorityQuery(auth: AuthorizedDevice, ownerId: string, nodeId: string, kind: NodeKind): SQL {
  const isOwner = sql`CASE WHEN ${auth.accountId} = ${ownerId} THEN 1 ELSE 0 END`;
  return sql`${lineage(nodeId, ownerId, kind)}
    SELECT CASE WHEN ${isOwner} = 1 THEN 2
      ELSE COALESCE(MAX(CASE g.permission WHEN 'read_write' THEN 2 WHEN 'read_only' THEN 1 ELSE 0 END), 0)
      END AS level, ${isOwner} AS is_owner
    FROM lineage l
    LEFT JOIN grants g ON g.owner_id = ${ownerId} AND g.recipient_id = ${auth.accountId}
      AND g.target_node_id = l.id AND g.target_kind = l.kind
    WHERE ${privateReadGuard(auth)} AND ${rooted(ownerId)}
    HAVING COUNT(l.id) > 0`;
}

function authorityCondition(auth: AuthorizedDevice, ownerId: string, nodeId: string,
  kind: NodeKind, requirement: "read" | "write" | "owner" | "collaborator"): SQL {
  const authority = scopeAuthorityQuery(auth, ownerId, nodeId, kind);
  const allowed = requirement === "read" ? sql`effective.level >= 1`
    : requirement === "write" ? sql`effective.level >= 2`
      : requirement === "owner" ? sql`effective.is_owner = 1`
        : sql`effective.is_owner = 0 AND effective.level >= 1`;
  return sql`EXISTS (SELECT 1 FROM (${authority}) effective WHERE ${allowed})`;
}

/** Include directly in the ciphertext SELECT / guarded CAS, not as a cached preflight.
 * `auth` MUST be the result of authorizePrivateRequest and the mutation must also use
 * commitPrivateMutation/commitDirectoryMutation for proof consumption and epoch checks.
 * Comment `*_own` actions require an additional same-statement author_id = actor
 * predicate; owner delete-any never authorizes editing somebody else's Comment.
 * Public-comment device posting additionally requires the live Publication audience,
 * current thread epoch and device envelope. Anonymous link + fragment access is a
 * separate route contract, never inferred from an Account Grant.
 */
export function fileAccessGuard(auth: AuthorizedDevice, ownerId: string, fileId: string, action: FileAction): SQL {
  switch (action) {
    case "file_read": case "private_comment_read": case "private_comment_create":
    case "private_comment_edit_own": case "private_comment_delete_own":
    case "collaborators_public_comment_read": case "public_audience_comment_read":
    case "public_audience_comment_post_device":
      return authorityCondition(auth, ownerId, fileId, "file", "read");
    case "file_edit": return authorityCondition(auth, ownerId, fileId, "file", "write");
    case "private_comment_delete_any": case "share_manage": case "publication_manage":
    case "export_owned_file": return authorityCondition(auth, ownerId, fileId, "file", "owner");
    case "publication_request": return authorityCondition(auth, ownerId, fileId, "file", "collaborator");
    default: throw new Error("invalid File action");
  }
}

export function directoryAccessGuard(auth: AuthorizedDevice, ownerId: string,
  directoryId: string, action: DirectoryAction): SQL {
  switch (action) {
    case "directory_read": return authorityCondition(auth, ownerId, directoryId, "directory", "read");
    case "child_create": case "import_target":
      return authorityCondition(auth, ownerId, directoryId, "directory", "write");
    case "share_manage": return authorityCondition(auth, ownerId, directoryId, "directory", "owner");
    default: throw new Error("invalid Directory action");
  }
}

export type EffectiveFileAccess = Readonly<{
  isOwner: boolean;
  canReadPrivateFile: boolean;
  canEditMarkdown: boolean;
  canReadPrivateComments: boolean;
  canCreatePrivateComment: boolean;
  canEditOwnPrivateComment: boolean;
  canDeleteOwnPrivateComment: boolean;
  canDeleteAnyPrivateComment: boolean;
  canManageShares: boolean;
  canManagePublication: boolean;
  canRequestPublication: boolean;
  canReadCollaboratorsPublicComments: boolean;
  canReadPublicAudienceComments: boolean;
  canPostPublicAudienceCommentViaDevice: boolean;
  canExportOwnedFile: boolean;
}>;

/** A display hint only; use the SQL predicates again in each data SELECT or write CAS. */
export async function getEffectiveFileAccess(db: D1Database, auth: AuthorizedDevice,
  ownerId: string, fileId: string): Promise<EffectiveFileAccess | null> {
  const row = await createDb(db).get<AuthorityRow>(fileAuthorityQuery(auth, ownerId, fileId));
  if (!row || row.level < 1) return null;
  const isOwner = row.is_owner === 1;
  return { isOwner, canReadPrivateFile: true, canEditMarkdown: row.level >= 2,
    canReadPrivateComments: true, canCreatePrivateComment: true, canEditOwnPrivateComment: true,
    canDeleteOwnPrivateComment: true, canDeleteAnyPrivateComment: isOwner,
    canManageShares: isOwner, canManagePublication: isOwner, canRequestPublication: !isOwner,
    canReadCollaboratorsPublicComments: true, canReadPublicAudienceComments: true,
    canPostPublicAudienceCommentViaDevice: true, canExportOwnedFile: isOwner };
}

export type EffectiveDirectoryAccess = Readonly<{ isOwner: boolean; canReadDirectory: boolean;
  canCreateChild: boolean; canUseAsImportTarget: boolean; canManageShares: boolean }>;

export async function getEffectiveDirectoryAccess(db: D1Database, auth: AuthorizedDevice,
  ownerId: string, directoryId: string): Promise<EffectiveDirectoryAccess | null> {
  const row = await createDb(db).get<AuthorityRow>(scopeAuthorityQuery(auth, ownerId, directoryId, "directory"));
  if (!row || row.level < 1) return null;
  return { isOwner: row.is_owner === 1, canReadDirectory: true, canCreateChild: row.level >= 2,
    canUseAsImportTarget: row.level >= 2, canManageShares: row.is_owner === 1 };
}

/** A collaborator needs a read/write Directory Grant covering the PARENT:
 * a Grant on the changed node (including a direct File Grant) cannot authorize
 * its own root mutation. Other overlapping target Grants do not subtract that
 * ancestor's authority. Rooted lineage checks current Owner and containment
 * in the commit statement.
 */
export function structuralAccessGuard(auth: AuthorizedDevice, ownerId: string,
  nodeId: string, action: StructuralAction): SQL {
  if (action !== "rename" && action !== "reorder" && action !== "delete") {
    throw new Error("invalid structural action");
  }
  return sql`EXISTS (${lineage(nodeId, ownerId, null)}
    SELECT 1 FROM lineage target WHERE target.depth = 0 AND target.parent_node_id IS NOT NULL
      AND ${privateReadGuard(auth)} AND ${rooted(ownerId)}
      AND (${auth.accountId} = ${ownerId} OR (
        EXISTS (SELECT 1 FROM lineage ancestor JOIN grants g
          ON g.owner_id = ${ownerId} AND g.recipient_id = ${auth.accountId}
            AND g.target_node_id = ancestor.id AND g.target_kind = 'directory'
            AND g.permission = 'read_write' WHERE ancestor.depth > 0)
      )))`;
}

/** One SAME read/write Directory Grant must cover the source's parent AND the
 * destination; independently unioned source/destination writes are insufficient.
 * Source depth > 0 prevents a Grant rooted on the source from moving its own
 * root, but other overlapping Grants cannot veto an authorizing ancestor Grant.
 * Both chains must reach the same Owner's root; moving into one's descendant is
 * denied. The caller must still CAS both Directory revisions and apply
 * rekey/rotation requirements before a real move.
 */
export function moveAccessGuard(auth: AuthorizedDevice, ownerId: string,
  nodeId: string, destinationDirectoryId: string): SQL {
  return sql`EXISTS (WITH RECURSIVE walk(role, id, kind, parent_node_id, depth) AS (
    SELECT 'source', n.id, n.kind, n.parent_node_id, 0 FROM vault_nodes n
      WHERE n.id = ${nodeId} AND n.owner_id = ${ownerId}
        AND n.parent_node_id IS NOT NULL AND n.import_id IS NULL
    UNION ALL
    SELECT 'destination', n.id, n.kind, n.parent_node_id, 0 FROM vault_nodes n
      WHERE n.id = ${destinationDirectoryId} AND n.owner_id = ${ownerId}
        AND n.kind = 'directory' AND n.import_id IS NULL
    UNION ALL
    SELECT child.role, parent.id, parent.kind, parent.parent_node_id, child.depth + 1
      FROM walk child JOIN vault_nodes parent ON parent.id = child.parent_node_id
      WHERE child.depth < ${MAX_ANCESTOR_DEPTH} AND parent.owner_id = ${ownerId}
        AND parent.kind = 'directory' AND parent.import_id IS NULL
  )
  SELECT 1 WHERE ${privateReadGuard(auth)}
    AND EXISTS (SELECT 1 FROM walk root JOIN account_encryption_identities identity
      ON identity.account_id = ${ownerId} AND identity.root_directory_id = root.id
      WHERE root.role = 'source' AND root.kind = 'directory' AND root.parent_node_id IS NULL)
    AND EXISTS (SELECT 1 FROM walk root JOIN account_encryption_identities identity
      ON identity.account_id = ${ownerId} AND identity.root_directory_id = root.id
      WHERE root.role = 'destination' AND root.kind = 'directory' AND root.parent_node_id IS NULL)
    AND NOT EXISTS (SELECT 1 FROM walk d WHERE d.role = 'destination' AND d.id = ${nodeId})
    AND (${auth.accountId} = ${ownerId} OR (
      EXISTS (SELECT 1 FROM grants g
        JOIN walk source ON source.role = 'source' AND source.depth > 0
          AND source.id = g.target_node_id AND source.kind = 'directory'
        JOIN walk destination ON destination.role = 'destination' AND destination.id = g.target_node_id
        WHERE g.owner_id = ${ownerId} AND g.recipient_id = ${auth.accountId}
          AND g.permission = 'read_write' AND g.target_kind = 'directory')
    )))`;
}
