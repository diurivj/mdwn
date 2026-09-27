import { record } from "~/auth/request.server";
import { createDb, sql } from "~/db/client.server";
import { commitDirectoryMutation, type AuthorizedDevice } from "~/device/proof.server";
import { directoryAccessGuard, fileAccessGuard } from "~/sharing/access.server";
import { unblocked } from "./file-v2.server";
import { signedListing } from "./listing.server";
import { isV7, MAX_REPRESENTATION_BYTES, treeEnvelope } from "./wire";

const headers = { "Cache-Control": "no-store" };
const invalid = () => Response.json({ error: "invalid_file_save" }, { status: 400, headers });
const missing = () => Response.json({ error: "not_found" }, { status: 404, headers });

/**
 * Legacy v1 requires parent-capability write authority; direct File editors use
 * only the v2 route. Old full-entry signatures and envelope bytes are unchanged.
 */
export async function saveFile(env: Env, auth: AuthorizedDevice, fileId: string, value: unknown): Promise<Response> {
  const input = record(value);
  const repr = record(input?.representation);
  if (!input || Object.keys(input).length !== 5 ||
      !["expectedRevision", "expectedEntriesRevision", "keyEnvelope", "representation", "listingHead"]
        .every((key) => Object.hasOwn(input, key)) ||
      !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1 ||
      (input.expectedRevision as number) >= Number.MAX_SAFE_INTEGER - 1 ||
      !Number.isSafeInteger(input.expectedEntriesRevision) || (input.expectedEntriesRevision as number) < 1 ||
      (input.expectedEntriesRevision as number) >= Number.MAX_SAFE_INTEGER - 1 ||
      !repr || Object.keys(repr).length !== 5 ||
      !["id", "contentKeyId", "keyEpoch", "revision", "ciphertext"].every((key) => Object.hasOwn(repr, key)) ||
      !isV7(repr.id) || !isV7(repr.contentKeyId) || repr.keyEpoch !== 1 ||
      repr.revision !== (input.expectedRevision as number) + 1) return invalid();
  const expectedRevision = input.expectedRevision as number;
  const expectedEntriesRevision = input.expectedEntriesRevision as number;
  const coordinates = await createDb(env.DB).get<{ owner_id: string; parent_node_id: string }>(sql`
    SELECT owner_id, parent_node_id FROM vault_nodes WHERE id = ${fileId} AND kind = 'file'`);
  if (!coordinates) return missing();
  const ownerId = coordinates.owner_id, parentId = coordinates.parent_node_id;
  const row = await createDb(env.DB).get<{ parent_node_id: string; current_revision: number;
    current_representation_id: string; content_key_id: string; listing_version: 1 | 2 }>(sql`
      SELECT n.parent_node_id, f.current_revision, f.current_representation_id, r.content_key_id,
        d.listing_version
      FROM vault_nodes n JOIN files f ON f.node_id = n.id AND f.owner_id = n.owner_id
      JOIN file_representations r ON r.id = f.current_representation_id AND r.file_node_id = f.node_id
        AND r.owner_id = f.owner_id AND r.revision = f.current_revision
      JOIN directory_entries e ON e.child_node_id = n.id AND e.parent_node_id = n.parent_node_id
        AND e.owner_id = n.owner_id AND e.encoding = 'legacy-file'
      JOIN directories d ON d.node_id = n.parent_node_id AND d.owner_id = n.owner_id
      WHERE n.id = ${fileId} AND n.owner_id = ${ownerId} AND n.parent_node_id = ${parentId}
        AND ${fileAccessGuard(auth, ownerId, fileId, "file_edit")}
        AND ${directoryAccessGuard(auth, ownerId, parentId, "child_create")}`);
  if (!row) return missing();
  if (row.current_revision !== expectedRevision) {
    return Response.json({ error: "file_changed" }, { status: 409, headers });
  }
  if (row.current_representation_id === repr.id || row.content_key_id === repr.contentKeyId) return invalid();
  let keyEnvelope: Uint8Array, ciphertext: Uint8Array;
  let head: Awaited<ReturnType<typeof signedListing>>;
  try {
    const context = { vaultId: ownerId, objectId: fileId, keyId: repr.contentKeyId,
      keyEpoch: 1, revision: expectedRevision + 1 };
    keyEnvelope = treeEnvelope(input.keyEnvelope, 16_384, { ...context, purpose: "file-content-key" });
    ciphertext = treeEnvelope(repr.ciphertext, MAX_REPRESENTATION_BYTES, { ...context, purpose: "file-content" });
    head = await signedListing(input.listingHead, auth, parentId, expectedEntriesRevision,
      ownerId, row.listing_version);
  } catch { return invalid(); }
  const now = Date.now();
  try {
    // The signed parent head commits to the changed key envelope. Parent and
    // File revisions are checked together; the old representation is deleted
    // only after the current pointer has been swapped inside the same D1 batch.
    const committed = await commitDirectoryMutation(env, auth, parentId, expectedEntriesRevision, head,
      sql`EXISTS (SELECT 1 FROM files f JOIN vault_nodes n ON n.id = f.node_id
        JOIN directory_entries e ON e.child_node_id = n.id AND e.parent_node_id = n.parent_node_id
        WHERE f.node_id = ${fileId} AND f.owner_id = ${ownerId}
          AND n.owner_id = f.owner_id AND n.parent_node_id = ${parentId}
          AND e.owner_id = f.owner_id AND e.encoding = 'legacy-file'
          AND f.current_revision = ${expectedRevision}
          AND f.current_representation_id = ${row.current_representation_id})
          AND ${fileAccessGuard(auth, ownerId, fileId, "file_edit")}
          AND ${directoryAccessGuard(auth, ownerId, parentId, "child_create")}
          AND ${unblocked(ownerId, fileId)}`,
      (previous) => [
        sql`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id,
          key_epoch, ciphertext, ciphertext_size, created_at)
          SELECT ${repr.id}, ${fileId}, ${ownerId}, ${expectedRevision + 1}, ${repr.contentKeyId},
            1, ${ciphertext}, ${ciphertext.byteLength}, ${now} WHERE ${previous}`,
        sql`UPDATE files SET current_representation_id = ${repr.id}, current_revision = ${expectedRevision + 1}
          WHERE node_id = ${fileId} AND owner_id = ${ownerId}
            AND current_revision = ${expectedRevision} AND ${previous}`,
        sql`UPDATE directory_entries SET key_envelope = ${keyEnvelope}
          WHERE child_node_id = ${fileId} AND parent_node_id = ${parentId}
            AND owner_id = ${ownerId} AND ${previous}`,
        sql`DELETE FROM file_representations WHERE id = ${row.current_representation_id}
          AND file_node_id = ${fileId} AND owner_id = ${ownerId} AND ${previous}`,
      ], { ownerId, previousVersion: row.listing_version });
    if (committed) return Response.json({ revision: expectedRevision + 1,
      entriesRevision: expectedEntriesRevision + 1 }, { headers });
    // A concurrent File write and a different parent mutation both lose the CAS.
    const current = await createDb(env.DB).get<{ current_revision: number }>(sql`
      SELECT current_revision FROM files WHERE node_id = ${fileId} AND owner_id = ${ownerId}
        AND ${fileAccessGuard(auth, ownerId, fileId, "file_edit")}`);
    if (!current) return missing();
    return Response.json({ error: current.current_revision !== expectedRevision ? "file_changed" : "namespace_changed" },
      { status: 409, headers });
  } catch { return invalid(); }
}
