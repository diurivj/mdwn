import { record } from "~/auth/request.server";
import { createDb, sql } from "~/db/client.server";
import { commitDirectoryMutation, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { signedListing } from "./listing.server";
import { isV7, MAX_REPRESENTATION_BYTES, treeEnvelope } from "./wire";

const headers = { "Cache-Control": "no-store" };
const invalid = () => Response.json({ error: "invalid_file_save" }, { status: 400, headers });
const missing = () => Response.json({ error: "not_found" }, { status: 404, headers });

/**
 * Owner-only until tickets 16–18 install the effective-Grant authority query and
 * direct-Grant key envelopes. Future direct-File editing MUST NOT expose a parent
 * Directory capability to the Collaborator. A save is invalid without all current
 * direct-Grant envelopes and, after ticket 22, the matching Public representation.
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
  const row = await createDb(env.DB).get<{ parent_node_id: string; current_revision: number;
    current_representation_id: string; content_key_id: string }>(sql`
      SELECT n.parent_node_id, f.current_revision, f.current_representation_id, r.content_key_id
      FROM vault_nodes n JOIN files f ON f.node_id = n.id AND f.owner_id = n.owner_id
      JOIN file_representations r ON r.id = f.current_representation_id AND r.file_node_id = f.node_id
        AND r.owner_id = f.owner_id AND r.revision = f.current_revision
      JOIN directory_entries e ON e.child_node_id = n.id AND e.parent_node_id = n.parent_node_id
        AND e.owner_id = n.owner_id
      WHERE n.id = ${fileId} AND n.owner_id = ${auth.accountId} AND ${privateReadGuard(auth)}`);
  if (!row) return missing();
  if (row.current_revision !== expectedRevision) {
    return Response.json({ error: "file_changed" }, { status: 409, headers });
  }
  if (row.current_representation_id === repr.id || row.content_key_id === repr.contentKeyId) return invalid();
  const parentId = row.parent_node_id;
  let keyEnvelope: Uint8Array, ciphertext: Uint8Array;
  let head: Awaited<ReturnType<typeof signedListing>>;
  try {
    const context = { vaultId: auth.accountId, objectId: fileId, keyId: repr.contentKeyId,
      keyEpoch: 1, revision: expectedRevision + 1 };
    keyEnvelope = treeEnvelope(input.keyEnvelope, 16_384, { ...context, purpose: "file-content-key" });
    ciphertext = treeEnvelope(repr.ciphertext, MAX_REPRESENTATION_BYTES, { ...context, purpose: "file-content" });
    head = await signedListing(input.listingHead, auth, parentId, expectedEntriesRevision);
  } catch { return invalid(); }
  const now = Date.now();
  try {
    // The signed parent head commits to the changed key envelope. Parent and
    // File revisions are checked together; the old representation is deleted
    // only after the current pointer has been swapped inside the same D1 batch.
    const committed = await commitDirectoryMutation(env, auth, parentId, expectedEntriesRevision, head,
      sql`EXISTS (SELECT 1 FROM files f JOIN vault_nodes n ON n.id = f.node_id
        JOIN directory_entries e ON e.child_node_id = n.id AND e.parent_node_id = n.parent_node_id
        WHERE f.node_id = ${fileId} AND f.owner_id = ${auth.accountId}
          AND n.owner_id = f.owner_id AND n.parent_node_id = ${parentId}
          AND e.owner_id = f.owner_id AND f.current_revision = ${expectedRevision}
          AND f.current_representation_id = ${row.current_representation_id})`,
      (previous) => [
        sql`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id,
          key_epoch, ciphertext, ciphertext_size, created_at)
          SELECT ${repr.id}, ${fileId}, ${auth.accountId}, ${expectedRevision + 1}, ${repr.contentKeyId},
            1, ${ciphertext}, ${ciphertext.byteLength}, ${now} WHERE ${previous}`,
        sql`UPDATE files SET current_representation_id = ${repr.id}, current_revision = ${expectedRevision + 1}
          WHERE node_id = ${fileId} AND owner_id = ${auth.accountId}
            AND current_revision = ${expectedRevision} AND ${previous}`,
        sql`UPDATE directory_entries SET key_envelope = ${keyEnvelope}
          WHERE child_node_id = ${fileId} AND parent_node_id = ${parentId}
            AND owner_id = ${auth.accountId} AND ${previous}`,
        sql`DELETE FROM file_representations WHERE id = ${row.current_representation_id}
          AND file_node_id = ${fileId} AND owner_id = ${auth.accountId} AND ${previous}`,
      ]);
    if (committed) return Response.json({ revision: expectedRevision + 1,
      entriesRevision: expectedEntriesRevision + 1 }, { headers });
    // A concurrent File write and a different parent mutation both lose the CAS.
    const current = await createDb(env.DB).get<{ current_revision: number }>(sql`
      SELECT current_revision FROM files WHERE node_id = ${fileId} AND owner_id = ${auth.accountId}
        AND ${privateReadGuard(auth)}`);
    if (!current) return missing();
    return Response.json({ error: current.current_revision !== expectedRevision ? "file_changed" : "namespace_changed" },
      { status: 409, headers });
  } catch { return invalid(); }
}
