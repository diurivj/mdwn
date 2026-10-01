import type { SQL } from "drizzle-orm";
import { createDb, sql } from "~/db/client.server";
import { privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";

export type EffectiveAccess = {
  accountId: string; nodeId: string; ownerId: string; kind: "directory" | "file";
  isOwner: boolean; permission: "read_only" | "read_write";
  canReadPrivateComments: boolean; canReadCollaboratorsPublicComments: boolean;
  directoryWriteRoots: string[]; directoryReadRoots: string[]; canChangeStructure: boolean;
};

type AccessRow = { node_id: string; owner_id: string; kind: "directory" | "file";
  permission_rank: number; can_read_private_comments: number; can_read_collaborators_public_comments: number;
  directory_write_roots: string; directory_read_roots: string; can_change_structure: number };

/** At most 101 indexed node lookups (100 edges). Grants are exact covering-index
 * probes for each ancestor, never a scan over an Account's Files or Grants.
 * Rows exist only for current, live authority; overflow/unrooted ancestry fails closed.
 * Keep this query inside the ciphertext SELECT or mutation's first CAS.
 */
export function effectiveAccessQuery(auth: AuthorizedDevice, nodeId: string | SQL): SQL {
  return sql`WITH RECURSIVE lineage(id, parent_node_id, owner_id, kind, depth) AS (
    SELECT id, parent_node_id, owner_id, kind, 0 FROM vault_nodes WHERE id = ${nodeId}
    UNION ALL
    SELECT parent.id, parent.parent_node_id, parent.owner_id, parent.kind, child.depth + 1
    FROM lineage child JOIN vault_nodes parent ON parent.id = child.parent_node_id
    WHERE parent.owner_id = child.owner_id AND child.depth < 100
  ), matching AS MATERIALIZED (
    SELECT g.target_id, g.target_kind, g.permission, a.depth
    FROM lineage a CROSS JOIN grants g INDEXED BY grants_recipient_target_idx
    WHERE g.recipient_id = ${auth.accountId} AND g.target_id = a.id AND g.owner_id = a.owner_id
      AND ((a.kind = 'directory' AND g.target_kind = 'directory')
        OR (a.depth = 0 AND a.kind = 'file' AND g.target_kind = 'file'))
  ), authority AS (
    SELECT n.id AS node_id, n.owner_id, n.kind,
      CASE WHEN n.owner_id = ${auth.accountId} THEN 3
        ELSE COALESCE((SELECT max(CASE permission WHEN 'read_write' THEN 2 ELSE 1 END) FROM matching), 0) END AS permission_rank,
      (SELECT json_group_array(target_id) FROM matching WHERE target_kind = 'directory' AND permission = 'read_write') AS directory_write_roots,
      (SELECT json_group_array(target_id) FROM matching WHERE target_kind = 'directory') AS directory_read_roots,
      n.parent_node_id IS NOT NULL AND (n.owner_id = ${auth.accountId} OR EXISTS (SELECT 1 FROM matching
        WHERE target_kind = 'directory' AND permission = 'read_write' AND depth > 0)) AS can_change_structure
    FROM vault_nodes n WHERE n.id = ${nodeId}
      AND (n.owner_id = ${auth.accountId} OR EXISTS (SELECT 1 FROM lineage WHERE parent_node_id IS NULL))
      AND ${privateReadGuard(auth)}
  ) SELECT *, kind = 'file' AND permission_rank > 0 AS can_read_private_comments,
    kind = 'file' AND permission_rank > 0 AS can_read_collaborators_public_comments
    FROM authority WHERE permission_rank > 0`;
}

export async function effectiveAccess(env: Env, auth: AuthorizedDevice, nodeId: string): Promise<EffectiveAccess | null> {
  const row = await createDb(env.DB).get<AccessRow>(effectiveAccessQuery(auth, nodeId));
  if (!row) return null;
  return { accountId: auth.accountId, nodeId: row.node_id, ownerId: row.owner_id, kind: row.kind,
    isOwner: row.permission_rank === 3, permission: row.permission_rank > 1 ? "read_write" : "read_only",
    canReadPrivateComments: !!row.can_read_private_comments,
    canReadCollaboratorsPublicComments: !!row.can_read_collaborators_public_comments,
    directoryWriteRoots: JSON.parse(row.directory_write_roots) as string[],
    directoryReadRoots: JSON.parse(row.directory_read_roots) as string[],
    canChangeStructure: !!row.can_change_structure };
}

export type Operation = "read_file" | "edit_markdown" | "create_child" | "rename" | "reorder" | "delete" | "move"
  | "import" | "read_private_comments" | "create_private_comment" | "edit_private_comment" | "delete_private_comment"
  | "delete_another_comment" | "manage_shares" | "manage_publication" | "request_publication"
  | "read_collaborators_public_comments" | "read_public_comments" | "post_public_comment" | "export";

/** Policy seam for the full matrix. Comment/Publication/Import/Export modules
 * must apply the corresponding predicate in their own current-epoch CAS.
 */
export function permits(access: EffectiveAccess | null, operation: Operation,
  context: { commentAuthorId?: string; destination?: EffectiveAccess } = {}): boolean {
  if (!access) return false;
  const file = access.kind === "file";
  switch (operation) {
    case "read_file": return file;
    case "edit_markdown": return file && access.permission === "read_write";
    case "create_child": case "import":
      return !file && (access.isOwner || access.directoryWriteRoots.length > 0);
    case "rename": case "reorder": case "delete": return access.canChangeStructure;
    case "move": {
      const destination = context.destination;
      return access.canChangeStructure && !!destination && destination.kind === "directory" &&
        destination.ownerId === access.ownerId && (access.isOwner ||
          access.directoryWriteRoots.some((root) => destination.directoryWriteRoots.includes(root)));
    }
    case "read_private_comments": case "create_private_comment": return access.canReadPrivateComments;
    case "edit_private_comment": return access.canReadPrivateComments && context.commentAuthorId === access.accountId;
    case "delete_private_comment": return access.canReadPrivateComments &&
      (context.commentAuthorId === access.accountId || access.isOwner);
    case "delete_another_comment": return file && access.isOwner;
    case "manage_shares": return access.isOwner;
    case "manage_publication": return file && access.isOwner;
    case "request_publication": return file && !access.isOwner;
    case "read_collaborators_public_comments": return access.canReadCollaboratorsPublicComments;
    case "read_public_comments": case "post_public_comment": return file;
    case "export": return file && access.isOwner;
  }
}

/** Revocation/leave/permission changes seal future writes before key rotation.
 * Reads and hard deletion stay available. Never expire this seal into an old key.
 */
export function sharingWriteBlocked(nodeId: string): SQL {
  return sql`EXISTS (WITH RECURSIVE lineage(id, parent_node_id, depth) AS (
    SELECT id, parent_node_id, 0 FROM vault_nodes WHERE id = ${nodeId}
    UNION ALL SELECT n.id, n.parent_node_id, a.depth + 1 FROM vault_nodes n JOIN lineage a ON n.id = a.parent_node_id
      WHERE a.depth < 100
  ) SELECT 1 FROM lineage a JOIN sharing_write_blocks b ON b.target_id = a.id)`;
}

/** A move needs one common write scope, not two independent writable islands. */
export function moveAccessPredicate(auth: AuthorizedDevice, nodeId: string, destinationId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM (${effectiveAccessQuery(auth, nodeId)}) source
    CROSS JOIN (${effectiveAccessQuery(auth, destinationId)}) destination
    WHERE source.owner_id = destination.owner_id AND source.can_change_structure = 1
      AND destination.kind = 'directory' AND (source.permission_rank = 3 OR EXISTS (
        SELECT 1 FROM json_each(source.directory_write_roots) s JOIN json_each(destination.directory_write_roots) d
          ON s.value = d.value)))`;
}

/** No scope exit without rotation, including an Owner move or an overlapping
 * Grant that would preserve the moving actor's access but remove someone else's.
 * A Grant on the moved Directory itself follows that Directory and is not an exit.
 */
export function exitsSharedScope(nodeId: string, destinationId: string): SQL {
  return sql`EXISTS (WITH RECURSIVE source(id, parent_node_id, depth) AS (
    SELECT id, parent_node_id, 0 FROM vault_nodes WHERE id = ${nodeId}
    UNION ALL SELECT n.id, n.parent_node_id, s.depth + 1 FROM vault_nodes n JOIN source s ON n.id = s.parent_node_id
      WHERE s.depth < 100
  ), destination(id, parent_node_id, depth) AS (
    SELECT id, parent_node_id, 0 FROM vault_nodes WHERE id = ${destinationId}
    UNION ALL SELECT n.id, n.parent_node_id, d.depth + 1 FROM vault_nodes n JOIN destination d ON n.id = d.parent_node_id
      WHERE d.depth < 100
  ) SELECT 1 FROM source s CROSS JOIN grants g INDEXED BY grants_target_idx
    WHERE g.target_id = s.id AND g.target_kind = 'directory'
      AND s.depth > 0 AND NOT EXISTS (SELECT 1 FROM destination d WHERE d.id = s.id))`;
}

/** Public-audience policy only: the Publication module establishes an active
 * complete link and the device-proof guard establishes private-capable Session
 * authority. Never take either fact from request JSON. This conveys no private
 * File, structural, or Collaborators-only Comment authority.
 */
export function permitsPublicAudience(operation: "read" | "post", verified: {
  completeActiveLink: boolean; privateCapableSession: boolean;
}): boolean {
  return verified.completeActiveLink && (operation === "read" || verified.privateCapableSession);
}

/** SQL authorization adapter used by the tree's read/CAS, not a cached preflight. */
export function accessPredicate(auth: AuthorizedDevice, nodeId: string | SQL,
  operation: "read" | "edit" | "create" | "structure" | "owner" = "read"): SQL {
  const condition = operation === "edit" ? sql`a.kind = 'file' AND a.permission_rank >= 2`
    : operation === "create" ? sql`a.kind = 'directory' AND (a.permission_rank = 3 OR json_array_length(a.directory_write_roots) > 0)`
    : operation === "structure" ? sql`a.can_change_structure = 1`
    : operation === "owner" ? sql`a.permission_rank = 3` : sql`1`;
  return sql`EXISTS (SELECT 1 FROM (${effectiveAccessQuery(auth, nodeId)}) a WHERE ${condition})`;
}
