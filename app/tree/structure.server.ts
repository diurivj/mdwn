import type { SQL } from "drizzle-orm";
import { record } from "~/auth/request.server";
import { atomicSqlBatch, createDb, sql } from "~/db/client.server";
import { commitDirectoryMutation, type AuthorizedDevice } from "~/device/proof.server";
import { fileAccessGuard, moveAccessGuard, structuralAccessGuard } from "~/sharing/access.server";
import { begin, finish, marker, proofTime, spent } from "~/sharing/sharing.server";
import { unblocked } from "./file-v2.server";
import type { ListingVersion } from "./listing";
import { signedListing } from "./listing.server";
import { parseReceivingRotation, RECEIVING_ROTATION_FIELDS, ReceivingRotationError, receivingRotationGuard,
  receivingRotationStatements, verifyReceivingRotation, type ReceivingRotation } from "./receiving-rotation.server";
import { encodeTreeBytes, isV7, treeEnvelope } from "./wire";

/** Directory hard deletion is all-or-nothing for at most this many nodes, root included. */
export const MAX_TEARDOWN_NODES = 500;

const headers = { "Cache-Control": "no-store" };
const json = (value: object, status = 200) => Response.json(value, { status, headers });
const notFound = () => json({ error: "not_found" }, 404);
const badRequest = () => json({ error: "invalid_tree_request" }, 400);
const changed = () => json({ error: "namespace_changed" }, 409);
const fileChanged = () => json({ error: "file_changed" }, 409);
const rotationPending = () => json({ error: "rotation_pending" }, 409);
const overLimit = () => json({ error: "subtree_limit_exceeded", limit: MAX_TEARDOWN_NODES }, 409);
const exact = (value: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
const revision = (value: unknown): value is number => Number.isSafeInteger(value) &&
  (value as number) >= 1 && (value as number) < Number.MAX_SAFE_INTEGER - 1;
type Head = Awaited<ReturnType<typeof signedListing>>;
/** vault_nodes <-> directory_entries and files <-> current representation reference each
 * other with RESTRICT, which SQLite enforces at once even for deferrable keys. A move or
 * teardown batch defers every foreign key to its COMMIT, where all of them must hold. */
const deferForeignKeys = sql`PRAGMA defer_foreign_keys = on`;

async function nodeOwner(env: Env, nodeId: string): Promise<string | null> {
  return (await createDb(env.DB).get<{ owner_id: string }>(sql`SELECT owner_id FROM vault_nodes
    WHERE id = ${nodeId}`))?.owner_id ?? null;
}

/** A ticket-19 barrier on the node or an ancestor seals new structural writes beneath it. */
async function blocked(env: Env, ownerId: string, nodeId: string): Promise<boolean> {
  return !await createDb(env.DB).get(sql`SELECT 1 AS open WHERE ${unblocked(ownerId, nodeId)}`);
}

/** Entry name/order under the parent's capability at the parent's current epoch. */
function metadata(value: unknown, max: number, ownerId: string, nodeId: string, parentId: string,
  parentEpoch: number): Uint8Array {
  return treeEnvelope(value, max, { purpose: "directory-metadata", vaultId: ownerId,
    objectId: nodeId, keyId: parentId, keyEpoch: parentEpoch, revision: 1 });
}

/** Same signed-head CAS as commitDirectoryMutation, but gated by an invocation witness. */
export function listingUpdate(auth: AuthorizedDevice, ownerId: string, directoryId: string, expectedRevision: number,
  head: Head, previous: ListingVersion, next: ListingVersion, live: SQL): SQL {
  return sql`UPDATE directories SET entries_revision = entries_revision + 1, listing_version = ${next},
      capability_key_id = CASE WHEN ${previous} = 1 AND ${next} = 2 THEN ${directoryId} ELSE capability_key_id END,
      listing_ciphertext = ${head.ciphertext}, listing_digest = ${head.digest},
      listing_signature = ${head.signature}, listing_device_id = ${auth.deviceId}
    WHERE node_id = ${directoryId} AND owner_id = ${ownerId} AND listing_version = ${previous}
      AND entries_revision = ${expectedRevision} AND ${live}`;
}

/** Reorder changes only the encrypted order of one entry, never its name or key material. */
export async function reorderChild(env: Env, auth: AuthorizedDevice, nodeId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["expectedRevision", "orderCiphertext", "listingHead"]) ||
      !revision(input.expectedRevision)) return badRequest();
  const expectedRevision = input.expectedRevision;
  const ownerId = await nodeOwner(env, nodeId);
  if (!ownerId) return notFound();
  const row = await createDb(env.DB).get<{ parent_node_id: string; listing_version: ListingVersion;
    capability_epoch: number }>(sql`
    SELECT n.parent_node_id, d.listing_version, d.capability_epoch FROM vault_nodes n
    JOIN directory_entries e ON e.child_node_id = n.id AND e.owner_id = n.owner_id AND e.parent_node_id = n.parent_node_id
    JOIN directories d ON d.node_id = n.parent_node_id AND d.owner_id = n.owner_id
    WHERE n.id = ${nodeId} AND n.owner_id = ${ownerId}
      AND ${structuralAccessGuard(auth, ownerId, nodeId, "reorder")}`);
  if (!row) return notFound();
  const parentId = row.parent_node_id;
  let order: Uint8Array, head: Head;
  try {
    order = metadata(input.orderCiphertext, 4096, ownerId, nodeId, parentId, row.capability_epoch);
    head = await signedListing(input.listingHead, auth, { directoryId: parentId, expectedRevision, ownerId,
      version: row.listing_version, epoch: row.capability_epoch });
  } catch { return badRequest(); }
  if (await blocked(env, ownerId, nodeId)) return rotationPending();
  try {
    const committed = await commitDirectoryMutation(env, auth, parentId, expectedRevision, head,
      sql`EXISTS (SELECT 1 FROM directory_entries WHERE child_node_id = ${nodeId}
          AND owner_id = ${ownerId} AND parent_node_id = ${parentId})
        AND ${structuralAccessGuard(auth, ownerId, nodeId, "reorder")} AND ${unblocked(ownerId, nodeId)}`,
      (previous) => [sql`UPDATE directory_entries SET order_ciphertext = ${order}
        WHERE child_node_id = ${nodeId} AND owner_id = ${ownerId} AND parent_node_id = ${parentId} AND ${previous}`],
      { ownerId, previousVersion: row.listing_version });
    return committed ? json({ entriesRevision: expectedRevision + 1 }) : changed();
  } catch { return badRequest(); }
}

/** Every Directory Grant on a strict ancestor of the moved node must belong to a
 * recipient who also holds a Directory Grant covering the destination. Otherwise
 * that recipient loses scope while still holding the moved Directory's capability,
 * so a Directory move is rejected rather than exposing future writes (ticket 19
 * owns subtree rekeying). File moves rotate their receiving pair instead.
 */
export function sharedScopeRetained(ownerId: string, nodeId: string, destinationId: string): SQL {
  return sql`NOT EXISTS (WITH RECURSIVE source(id, depth) AS (
      SELECT parent_node_id, 1 FROM vault_nodes WHERE id = ${nodeId} AND owner_id = ${ownerId}
        AND parent_node_id IS NOT NULL
      UNION ALL
      SELECT n.parent_node_id, s.depth + 1 FROM source s JOIN vault_nodes n ON n.id = s.id
        WHERE n.owner_id = ${ownerId} AND n.parent_node_id IS NOT NULL AND s.depth <= 100
    ), destination(id, depth) AS (
      SELECT ${destinationId}, 0
      UNION ALL
      SELECT n.parent_node_id, d.depth + 1 FROM destination d JOIN vault_nodes n ON n.id = d.id
        WHERE n.owner_id = ${ownerId} AND n.parent_node_id IS NOT NULL AND d.depth <= 100
    )
    SELECT 1 FROM grants g JOIN source s ON s.id = g.target_node_id
    WHERE g.owner_id = ${ownerId} AND g.target_kind = 'directory'
      AND NOT EXISTS (SELECT 1 FROM grants kept JOIN destination d ON d.id = kept.target_node_id
        WHERE kept.owner_id = ${ownerId} AND kept.recipient_id = g.recipient_id
          AND kept.target_kind = 'directory'))`;
}

type MoveRow = {
  kind: "directory" | "file"; parent_node_id: string;
  encoding: "directory" | "legacy-file" | "receiving-file";
  receiving_key_id: string | null; receiving_epoch: number | null; wrap_revision: number | null;
  source_revision: number; source_version: ListingVersion; source_epoch: number;
  destination_revision: number; destination_version: ListingVersion; destination_epoch: number;
  own_epoch: number | null;
  current_revision: number | null; representation_id: string | null;
  content_key_id: string | null; key_epoch: number | null;
};
const MOVE_FIELDS = ["sourceId", "destinationId", "expectedSourceRevision", "expectedDestinationRevision",
  "nameCiphertext", "orderCiphertext", "keyEnvelope", "sourceListingHead", "destinationListingHead"] as const;
const ROTATION_FIELDS = RECEIVING_ROTATION_FIELDS;

/**
 * One same-Owner move: both parent revisions are CAS'd, the edge is replaced and
 * the node's parent changes together, and both parents install newly signed
 * listings. The name/order are re-encrypted and the key material rewrapped for
 * the destination capability. A v2 File always rotates its receiving key pair
 * (new wrapper, public target, parent File-key envelope and same-revision signed
 * File head), so no departing Directory reader keeps a write target, and starts
 * a new Private thread epoch sealed to the new receiving key; a legacy File's
 * future keys are wrapped under the destination capability anyway.
 */
export async function moveChild(env: Env, auth: AuthorizedDevice, nodeId: string, value: unknown): Promise<Response> {
  const input = record(value);
  const rotating = !!input && Object.hasOwn(input, "signedHead");
  if (!input || !exact(input, rotating ? [...MOVE_FIELDS, ...ROTATION_FIELDS] : MOVE_FIELDS) ||
      !isV7(input.sourceId) || !isV7(input.destinationId) || input.destinationId === nodeId ||
      input.sourceId === input.destinationId ||
      !revision(input.expectedSourceRevision) || !revision(input.expectedDestinationRevision)) return badRequest();
  const destinationId = input.destinationId;
  const expectedSource = input.expectedSourceRevision, expectedDestination = input.expectedDestinationRevision;
  const ownerId = await nodeOwner(env, nodeId);
  if (!ownerId) return notFound();
  const row = await createDb(env.DB).get<MoveRow>(sql`
    SELECT n.kind, n.parent_node_id, e.encoding, e.receiving_key_id, e.receiving_epoch, e.wrap_revision,
      src.entries_revision AS source_revision, src.listing_version AS source_version,
      src.capability_epoch AS source_epoch,
      dst.entries_revision AS destination_revision, dst.listing_version AS destination_version,
      dst.capability_epoch AS destination_epoch, own.capability_epoch AS own_epoch,
      f.current_revision, f.current_representation_id AS representation_id, r.content_key_id, r.key_epoch
    FROM vault_nodes n
    JOIN directory_entries e ON e.child_node_id = n.id AND e.owner_id = n.owner_id AND e.parent_node_id = n.parent_node_id
    JOIN directories src ON src.node_id = n.parent_node_id AND src.owner_id = n.owner_id
    JOIN directories dst ON dst.node_id = ${destinationId} AND dst.owner_id = n.owner_id
    LEFT JOIN directories own ON own.node_id = n.id AND own.owner_id = n.owner_id
    LEFT JOIN files f ON f.node_id = n.id AND f.owner_id = n.owner_id
    LEFT JOIN file_representations r ON r.id = f.current_representation_id AND r.file_node_id = f.node_id
      AND r.owner_id = f.owner_id AND r.revision = f.current_revision
    WHERE n.id = ${nodeId} AND n.owner_id = ${ownerId}
      AND ${moveAccessGuard(auth, ownerId, nodeId, destinationId)}`);
  if (!row) return notFound();
  const sourceId = row.parent_node_id;
  // A concurrent move or structural change of either parent is a namespace change, never a new target.
  if (sourceId !== input.sourceId || row.source_revision !== expectedSource ||
      row.destination_revision !== expectedDestination) return changed();
  if (rotating !== (row.encoding === "receiving-file") ||
      (row.kind === "file" && (!row.current_revision || !row.content_key_id || !row.key_epoch))) return badRequest();
  if (await blocked(env, ownerId, nodeId) || await blocked(env, ownerId, destinationId)) return rotationPending();
  if (row.kind === "directory" && !await createDb(env.DB).get(sql`SELECT 1 AS kept
      WHERE ${sharedScopeRetained(ownerId, nodeId, destinationId)}`)) {
    return json({ error: "move_leaves_shared_scope" }, 409);
  }
  const nextDestinationVersion: ListingVersion = rotating ? 2 : row.destination_version;
  let name: Uint8Array, order: Uint8Array, keyEnvelope: Uint8Array;
  let sourceHead: Head, destinationHead: Head;
  let rotation: ReceivingRotation | null = null;
  try {
    name = metadata(input.nameCiphertext, 1024, ownerId, nodeId, destinationId, row.destination_epoch);
    order = metadata(input.orderCiphertext, 4096, ownerId, nodeId, destinationId, row.destination_epoch);
    if (row.encoding === "directory") {
      // The moved Directory keeps its own capability and epoch; only its wrapper changes parent.
      keyEnvelope = treeEnvelope(input.keyEnvelope, 1024, { purpose: "directory-capability", vaultId: ownerId,
        objectId: nodeId, keyId: nodeId, keyEpoch: row.own_epoch!, revision: 1 });
    } else if (row.encoding === "legacy-file") {
      keyEnvelope = treeEnvelope(input.keyEnvelope, 16_384, { purpose: "file-content-key", vaultId: ownerId,
        objectId: nodeId, keyId: row.content_key_id!, keyEpoch: row.key_epoch!, revision: row.current_revision! });
    } else {
      rotation = parseReceivingRotation(input, ownerId, nodeId, row);
      keyEnvelope = rotation.keyEnvelope;
    }
    sourceHead = await signedListing(input.sourceListingHead, auth, { directoryId: sourceId,
      expectedRevision: expectedSource, ownerId, version: row.source_version, epoch: row.source_epoch });
    destinationHead = await signedListing(input.destinationListingHead, auth, { directoryId: destinationId,
      expectedRevision: expectedDestination, ownerId, version: nextDestinationVersion, epoch: row.destination_epoch });
  } catch { return badRequest(); }
  if (rotation) {
    try { rotation = await verifyReceivingRotation(env, auth, ownerId, nodeId, row, rotation); }
    catch (error) {
      const code = error instanceof ReceivingRotationError ? error.code : "invalid";
      return code === "missing" ? notFound() : code === "changed" ? fileChanged() : badRequest();
    }
  }
  const nodeState = row.encoding === "directory" ? sql`1 = 1` : row.encoding === "legacy-file" ?
    sql`EXISTS (SELECT 1 FROM files f WHERE f.node_id = ${nodeId} AND f.owner_id = ${ownerId}
      AND f.current_revision = ${row.current_revision} AND f.current_representation_id = ${row.representation_id})` :
    sql`${receivingRotationGuard(ownerId, nodeId, row, rotation!)}
      AND ${fileAccessGuard(auth, ownerId, nodeId, "file_edit")}`;
  const now = Date.now(), invocationId = crypto.randomUUID(), live = marker(auth, invocationId);
  try {
    const [, witness] = await atomicSqlBatch(env.DB, [
      deferForeignKeys,
      begin(auth, invocationId, sql`EXISTS (SELECT 1 FROM vault_nodes n
          JOIN directory_entries e ON e.child_node_id = n.id AND e.owner_id = n.owner_id
            AND e.parent_node_id = n.parent_node_id
          JOIN directories src ON src.node_id = n.parent_node_id AND src.owner_id = n.owner_id
          JOIN directories dst ON dst.node_id = ${destinationId} AND dst.owner_id = n.owner_id
          WHERE n.id = ${nodeId} AND n.owner_id = ${ownerId} AND n.parent_node_id = ${sourceId}
            AND src.entries_revision = ${expectedSource} AND src.listing_version = ${row.source_version}
            AND dst.entries_revision = ${expectedDestination} AND dst.listing_version = ${row.destination_version}
            AND e.encoding = ${row.encoding} AND e.receiving_key_id IS ${row.receiving_key_id}
            AND e.receiving_epoch IS ${row.receiving_epoch} AND e.wrap_revision IS ${row.wrap_revision})
        AND ${moveAccessGuard(auth, ownerId, nodeId, destinationId)}
        AND ${unblocked(ownerId, nodeId)} AND ${unblocked(ownerId, destinationId)}
        AND ${row.kind === "directory" ? sharedScopeRetained(ownerId, nodeId, destinationId) : sql`1 = 1`}
        AND ${nodeState}`),
      listingUpdate(auth, ownerId, sourceId, expectedSource, sourceHead, row.source_version, row.source_version, live),
      listingUpdate(auth, ownerId, destinationId, expectedDestination, destinationHead, row.destination_version,
        nextDestinationVersion, live),
      sql`DELETE FROM directory_entries WHERE child_node_id = ${nodeId} AND owner_id = ${ownerId}
        AND parent_node_id = ${sourceId} AND ${live}`,
      sql`UPDATE vault_nodes SET parent_node_id = ${destinationId}, updated_at = ${now}
        WHERE id = ${nodeId} AND owner_id = ${ownerId} AND parent_node_id = ${sourceId} AND ${live}`,
      sql`INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id, name_ciphertext,
          order_ciphertext, key_envelope, encoding, receiving_key_id, receiving_epoch, wrap_revision)
        SELECT ${nodeId}, ${ownerId}, ${destinationId}, ${name}, ${order}, ${keyEnvelope}, ${row.encoding},
          ${rotation?.receivingKeyId ?? null}, ${rotation?.receivingEpoch ?? null}, ${rotation?.wrapRevision ?? null}
        WHERE ${live}`,
      ...(rotation ? await receivingRotationStatements(auth, ownerId, nodeId, rotation, now, live) : []),
      spent(auth, invocationId),
      proofTime(auth, invocationId),
      finish(auth, invocationId),
    ]);
    if (witness?.meta.changes !== 1) return rotation ? fileChanged() : changed();
    return json({ sourceRevision: expectedSource + 1, destinationRevision: expectedDestination + 1,
      ...(rotation ? { headDigest: encodeTreeBytes(rotation.signed.digest) } : {}) });
  } catch { return badRequest(); }
}

/** Bounded descendant walk, root included. UNION is cycle-safe; LIMIT stops an oversized walk early. */
function subtree(ownerId: string, nodeId: string): SQL {
  return sql`WITH RECURSIVE subtree(id) AS (
    SELECT id FROM vault_nodes WHERE id = ${nodeId} AND owner_id = ${ownerId}
    UNION
    SELECT n.id FROM vault_nodes n JOIN subtree s ON n.parent_node_id = s.id WHERE n.owner_id = ${ownerId}
    LIMIT ${MAX_TEARDOWN_NODES + 1})`;
}

/**
 * Hard deletion of one File, or one Directory with at most 500 nodes: the whole
 * subtree is enumerated inside the transaction, authorized through its root,
 * marked for teardown and removed explicitly in dependency order. No trash,
 * soft-delete state or cascade. An over-cap or stale request changes nothing.
 */
export async function deleteNode(env: Env, auth: AuthorizedDevice, nodeId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["expectedRevision", "listingHead"]) || !revision(input.expectedRevision)) return badRequest();
  const expectedRevision = input.expectedRevision;
  const ownerId = await nodeOwner(env, nodeId);
  if (!ownerId) return notFound();
  const count = sql`(${subtree(ownerId, nodeId)} SELECT count(*) FROM subtree)`;
  const row = await createDb(env.DB).get<{ parent_node_id: string; entries_revision: number;
    listing_version: ListingVersion; capability_epoch: number; nodes: number }>(sql`
    SELECT n.parent_node_id, d.entries_revision, d.listing_version, d.capability_epoch, ${count} AS nodes
    FROM vault_nodes n
    JOIN directory_entries e ON e.child_node_id = n.id AND e.owner_id = n.owner_id AND e.parent_node_id = n.parent_node_id
    JOIN directories d ON d.node_id = n.parent_node_id AND d.owner_id = n.owner_id
    WHERE n.id = ${nodeId} AND n.owner_id = ${ownerId}
      AND ${structuralAccessGuard(auth, ownerId, nodeId, "delete")}`);
  if (!row) return notFound();
  if (row.nodes > MAX_TEARDOWN_NODES) return overLimit();
  if (row.entries_revision !== expectedRevision) return changed();
  const parentId = row.parent_node_id;
  let head: Head;
  try {
    head = await signedListing(input.listingHead, auth, { directoryId: parentId, expectedRevision, ownerId,
      version: row.listing_version, epoch: row.capability_epoch });
  }
  catch { return badRequest(); }
  // The deleted subtree's own barriers are drained below; its parent chain must be unsealed.
  if (await blocked(env, ownerId, parentId)) return rotationPending();
  const invocationId = crypto.randomUUID(), live = marker(auth, invocationId);
  const doomed = sql`SELECT node_id FROM tree_teardown_nodes WHERE invocation_id = ${invocationId}`;
  const shares = sql`SELECT id FROM shares WHERE owner_id = ${ownerId} AND target_node_id IN (${doomed})`;
  const grants = sql`SELECT id FROM grants WHERE owner_id = ${ownerId} AND target_node_id IN (${doomed})`;
  const threads = sql`SELECT id FROM comment_threads WHERE owner_id = ${ownerId} AND file_node_id IN (${doomed})`;
  try {
    const [, witness, marked] = await atomicSqlBatch(env.DB, [
      deferForeignKeys,
      begin(auth, invocationId, sql`EXISTS (SELECT 1 FROM vault_nodes n
          JOIN directory_entries e ON e.child_node_id = n.id AND e.owner_id = n.owner_id
            AND e.parent_node_id = n.parent_node_id
          JOIN directories d ON d.node_id = n.parent_node_id AND d.owner_id = n.owner_id
          WHERE n.id = ${nodeId} AND n.owner_id = ${ownerId} AND n.parent_node_id = ${parentId}
            AND d.entries_revision = ${expectedRevision} AND d.listing_version = ${row.listing_version})
        AND ${structuralAccessGuard(auth, ownerId, nodeId, "delete")} AND ${unblocked(ownerId, parentId)}
        AND ${count} <= ${MAX_TEARDOWN_NODES}`),
      sql`${subtree(ownerId, nodeId)} INSERT INTO tree_teardown_nodes (node_id, invocation_id, owner_id)
        SELECT id, ${invocationId}, ${ownerId} FROM subtree WHERE ${live}`,
      listingUpdate(auth, ownerId, parentId, expectedRevision, head, row.listing_version, row.listing_version, live),
      // Pending Shares and their presealed material (docs/sharing-server.md FK order).
      sql`DELETE FROM share_offer_labels WHERE share_id IN (${shares}) AND ${live}`,
      sql`DELETE FROM share_device_material WHERE share_id IN (${shares}) AND ${live}`,
      sql`DELETE FROM share_offers WHERE share_id IN (${shares}) AND ${live}`,
      sql`DELETE FROM share_material WHERE share_id IN (${shares}) AND ${live}`,
      sql`DELETE FROM shares WHERE owner_id = ${ownerId} AND target_node_id IN (${doomed}) AND ${live}`,
      // Active Grants, their envelopes, labels, retained keys and provisioning needs.
      sql`DELETE FROM grant_device_envelopes WHERE grant_id IN (${grants}) AND ${live}`,
      sql`DELETE FROM grant_retained_material WHERE grant_id IN (${grants}) AND ${live}`,
      sql`DELETE FROM provisioning_needs WHERE grant_id IN (${grants}) AND ${live}`,
      sql`DELETE FROM grant_label_deliveries WHERE grant_id IN (${grants}) AND ${live}`,
      sql`DELETE FROM grant_labels WHERE grant_id IN (${grants}) AND ${live}`,
      sql`DELETE FROM grants WHERE owner_id = ${ownerId} AND target_node_id IN (${doomed}) AND ${live}`,
      // Deleted content needs no rotation: the job outlives nothing, then its barrier.
      sql`DELETE FROM sharing_rotation_jobs WHERE owner_id = ${ownerId} AND target_node_id IN (${doomed}) AND ${live}`,
      sql`DELETE FROM rotation_barriers WHERE owner_id = ${ownerId} AND target_node_id IN (${doomed}) AND ${live}`,
      // Private Comment threads: Comments and attributions, device envelopes, key epochs, threads.
      sql`DELETE FROM comments WHERE thread_id IN (${threads}) AND ${live}`,
      sql`DELETE FROM thread_attributions WHERE thread_id IN (${threads}) AND ${live}`,
      sql`DELETE FROM comment_thread_device_envelopes WHERE thread_id IN (${threads}) AND ${live}`,
      sql`DELETE FROM comment_thread_epochs WHERE thread_id IN (${threads}) AND ${live}`,
      sql`DELETE FROM comment_threads WHERE owner_id = ${ownerId} AND file_node_id IN (${doomed}) AND ${live}`,
      // File envelopes, heads and representations before the File rows.
      sql`DELETE FROM file_device_envelopes WHERE owner_id = ${ownerId} AND file_node_id IN (${doomed}) AND ${live}`,
      sql`DELETE FROM file_heads WHERE owner_id = ${ownerId} AND file_node_id IN (${doomed}) AND ${live}`,
      sql`DELETE FROM file_representations WHERE owner_id = ${ownerId} AND file_node_id IN (${doomed}) AND ${live}`,
      sql`DELETE FROM files WHERE owner_id = ${ownerId} AND node_id IN (${doomed}) AND ${live}`,
      // Edges, then Directory namespaces, then the nodes themselves.
      sql`DELETE FROM directory_entries WHERE owner_id = ${ownerId} AND child_node_id IN (${doomed}) AND ${live}`,
      sql`DELETE FROM directories WHERE owner_id = ${ownerId} AND node_id IN (${doomed}) AND ${live}`,
      sql`DELETE FROM vault_nodes WHERE owner_id = ${ownerId} AND id IN (${doomed}) AND ${live}`,
      sql`DELETE FROM tree_teardown_nodes WHERE invocation_id = ${invocationId}`,
      spent(auth, invocationId),
      proofTime(auth, invocationId),
      finish(auth, invocationId),
    ]);
    if (witness?.meta.changes === 1) return json({ entriesRevision: expectedRevision + 1,
      deletedNodes: marked?.meta.changes ?? 0 });
  } catch { return badRequest(); }
  const after = await createDb(env.DB).get<{ nodes: number }>(sql`SELECT ${count} AS nodes`);
  if (!after?.nodes) return notFound();
  return after.nodes > MAX_TEARDOWN_NODES ? overLimit() : changed();
}
