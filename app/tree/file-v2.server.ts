import { record } from "~/auth/request.server";
import { inspectEnvelope } from "~/crypto/enc-v1";
import { atomicSqlBatch, createDb, sql } from "~/db/client.server";
import { coarseProofTime, commitDirectoryMutation, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { directoryAccessGuard, fileAccessGuard } from "~/sharing/access.server";
import { assertExactFileRecipientDescriptors, assertFileHeadCommitTransition, parseFileHeadBytes,
  verifyDirectFileRecipientEnvelope, verifyFileHead, verifyFileParentEnvelope, verifyFileReceivingTarget,
  verifyFileRepresentation, type SignedFileHead, type VerifiedFileHead } from "./file-head";
import { signedListing } from "./listing.server";
import { decodeTreeBytes, encodeTreeBytes, isV7, MAX_REPRESENTATION_BYTES, treeEnvelope } from "./wire";
import type { ListingVersion } from "./listing";

const headers = { "Cache-Control": "no-store" };
const invalid = () => Response.json({ error: "invalid_file_request" }, { status: 400, headers });
const changed = () => Response.json({ error: "file_changed" }, { status: 409, headers });
const absent = () => Response.json({ error: "not_found" }, { status: 404, headers });
const encode = (data: ArrayBuffer | Uint8Array) => encodeTreeBytes(new Uint8Array(data));
const bytes = (data: ArrayBuffer | Uint8Array) => new Uint8Array(data);
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((n, i) => n === b[i]);
const digest = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data)));
const exact = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));

export type Recipient = { accountId: string; deviceId: string; registryEpoch: number;
  publicKey: string; grants: { id: string; generation: number }[] };
type GrantRow = { account_id: string; device_id: string; registry_epoch: number; transport_public_key: ArrayBuffer;
  grant_id: string; generation: number };
/** Only direct File Grants require individual device envelopes. Directory Grants traverse their own capability. */
async function recipients(env: Env, ownerId: string, fileId: string): Promise<Recipient[]> {
  const rows = await createDb(env.DB).all<GrantRow>(sql`SELECT g.recipient_id AS account_id, d.id AS device_id,
      registry.registry_epoch, d.transport_public_key, g.id AS grant_id, g.generation
    FROM grants g JOIN encryption_devices d ON d.account_id = g.recipient_id AND d.state = 'active'
    JOIN account_encryption_identities registry ON registry.account_id = g.recipient_id
    WHERE g.owner_id = ${ownerId} AND g.target_node_id = ${fileId} AND g.target_kind = 'file'
    ORDER BY d.id, g.id`);
  const devices = new Map<string, Recipient>();
  for (const r of rows) {
    const key = bytes(r.transport_public_key);
    if (key.length !== 65 || key[0] !== 4) throw new Error("invalid registered key");
    const previous = devices.get(r.device_id);
    if (previous && (previous.accountId !== r.account_id || previous.registryEpoch !== r.registry_epoch ||
      previous.publicKey !== encode(key))) throw new Error("inconsistent device registry");
    const current = previous ?? { accountId: r.account_id, deviceId: r.device_id,
      registryEpoch: r.registry_epoch, publicKey: encode(key), grants: [] };
    current.grants.push({ id: r.grant_id, generation: r.generation });
    devices.set(r.device_id, current);
  }
  const result = [...devices.values()].sort((a, b) => a.accountId.localeCompare(b.accountId) ||
    a.deviceId.localeCompare(b.deviceId));
  if (result.length > 256 || result.some((r) => r.grants.length > 16)) throw new Error("recipient capacity exceeded");
  return result;
}

type HeadRow = { file_node_id: string; owner_id: string; bytes: ArrayBuffer; digest: ArrayBuffer;
  signature: ArrayBuffer; signer_device_id: string; assertion_public_key: ArrayBuffer;
  signer_account_id: string;
  receiving_public_key: ArrayBuffer; receiving_key_id: string; receiving_epoch: number;
  recipient_set_version: number; revision: number; representation_id: string; content_key_id: string;
  content_epoch: number; parent_envelope: ArrayBuffer };
async function verified(row: HeadRow): Promise<VerifiedFileHead> {
  const head = await verifyFileHead({ bytes: bytes(row.bytes), digest: bytes(row.digest), signature: bytes(row.signature) }, {
    ownerId: row.owner_id, vaultId: row.owner_id, fileId: row.file_node_id,
    signerDeviceId: row.signer_device_id, publicKey: bytes(row.assertion_public_key),
    revision: row.revision, digest: bytes(row.digest),
  });
  if (head.statement.representation.id !== row.representation_id ||
      head.statement.contentKey.id !== row.content_key_id || head.statement.contentKey.epoch !== row.content_epoch ||
      head.statement.receivingKey.id !== row.receiving_key_id || head.statement.receivingKey.epoch !== row.receiving_epoch ||
      head.statement.recipientSetVersion !== row.recipient_set_version) throw new Error("inconsistent File head");
  await verifyFileReceivingTarget(head, bytes(row.receiving_public_key));
  await verifyFileParentEnvelope(head, bytes(row.parent_envelope));
  return head;
}
function wireHead(row: HeadRow) {
  return { bytes: encode(row.bytes), digest: encode(row.digest), signature: encode(row.signature),
    signerDeviceId: row.signer_device_id, signerAccountId: row.signer_account_id,
    signerPublicKey: encode(row.assertion_public_key) };
}
async function fileOwner(env: Env, fileId: string): Promise<string | null> {
  return (await createDb(env.DB).get<{ owner_id: string }>(sql`SELECT owner_id FROM vault_nodes
    WHERE id = ${fileId} AND kind = 'file'`))?.owner_id ?? null;
}
async function headRow(env: Env, fileId: string): Promise<HeadRow | undefined> {
  return createDb(env.DB).get<HeadRow>(sql`SELECT h.*, signer.assertion_public_key, signer.account_id AS signer_account_id
    FROM file_heads h JOIN encryption_devices signer ON signer.id = h.signer_device_id
    WHERE h.file_node_id = ${fileId}`);
}

/** A File-only response never carries parent, path, sibling bytes or Directory correlation material. */
export async function fileWriteContext(env: Env, auth: AuthorizedDevice, fileId: string): Promise<Response> {
  const ownerId = await fileOwner(env, fileId);
  if (!ownerId) return absent();
  const row = await createDb(env.DB).get<HeadRow>(sql`SELECT h.*, signer.assertion_public_key, signer.account_id AS signer_account_id
    FROM file_heads h JOIN encryption_devices signer ON signer.id = h.signer_device_id
    WHERE h.file_node_id = ${fileId} AND h.owner_id = ${ownerId}
      AND ${fileAccessGuard(auth, ownerId, fileId, "file_edit")}`);
  if (!row) return absent();
  try {
    await verified(row);
    const current = await recipients(env, row.owner_id, fileId);
    return Response.json({ ownerId: row.owner_id, fileId, currentHead: wireHead(row),
      signerProvenance: { accountId: row.signer_account_id, deviceId: row.signer_device_id,
        publicKey: encode(row.assertion_public_key) },
      receivingPublicKey: encode(row.receiving_public_key), recipients: current,
      recipientSetVersion: row.recipient_set_version }, { headers });
  } catch { return invalid(); }
}

export async function migrationRecipients(env: Env, auth: AuthorizedDevice, fileId: string): Promise<Response> {
  const row = await createDb(env.DB).get<{ owner_id: string; parent_node_id: string }>(sql`
    SELECT owner_id, parent_node_id FROM vault_nodes WHERE id = ${fileId} AND kind = 'file'`);
  if (!row) return absent();
  const accessible = await createDb(env.DB).get<{ id: string }>(sql`
    SELECT id FROM vault_nodes WHERE id = ${fileId} AND owner_id = ${row.owner_id}
      AND ${directoryAccessGuard(auth, row.owner_id, row.parent_node_id, "child_create")}`);
  if (!accessible) return absent();
  try { return Response.json({ recipients: await recipients(env, row.owner_id, fileId) }, { headers }); }
  catch { return invalid(); }
}

type FileRow = HeadRow & { parent_node_id: string; has_parent_capability: number;
  current_revision: number; current_representation_id: string;
  ciphertext: ArrayBuffer; key_epoch: number; key_envelope: ArrayBuffer; name_ciphertext: ArrayBuffer;
  order_ciphertext: ArrayBuffer; encoding: string; receiving_entry_id: string | null;
  receiving_entry_epoch: number | null; wrap_revision: number | null; device_ciphertext: ArrayBuffer | null;
  device_digest: ArrayBuffer | null; device_registry_epoch: number | null };
export async function readV2File(env: Env, auth: AuthorizedDevice, fileId: string): Promise<Response> {
  const ownerId = await fileOwner(env, fileId);
  if (!ownerId) return absent();
  const parentId = (await createDb(env.DB).get<{ parent_node_id: string }>(sql`
    SELECT parent_node_id FROM vault_nodes WHERE id = ${fileId} AND owner_id = ${ownerId}`))?.parent_node_id;
  if (!parentId) return absent();
  const row = await createDb(env.DB).get<FileRow>(sql`SELECT h.*, signer.assertion_public_key, signer.account_id AS signer_account_id,
      n.parent_node_id, CASE WHEN ${directoryAccessGuard(auth, ownerId, parentId, "directory_read")}
        THEN 1 ELSE 0 END AS has_parent_capability,
      f.current_revision, f.current_representation_id, r.ciphertext, r.key_epoch,
      e.key_envelope, e.name_ciphertext, e.order_ciphertext, e.encoding,
      e.receiving_key_id AS receiving_entry_id, e.receiving_epoch AS receiving_entry_epoch, e.wrap_revision,
      own.ciphertext AS device_ciphertext, own.digest AS device_digest, own.registry_epoch AS device_registry_epoch
    FROM vault_nodes n JOIN files f ON f.node_id = n.id AND f.owner_id = n.owner_id
    JOIN file_heads h ON h.file_node_id = f.node_id AND h.owner_id = f.owner_id
    JOIN file_representations r ON r.id = f.current_representation_id AND r.file_node_id = f.node_id
      AND r.owner_id = f.owner_id AND r.revision = f.current_revision
    JOIN directory_entries e ON e.child_node_id = f.node_id AND e.owner_id = f.owner_id
    JOIN encryption_devices signer ON signer.id = h.signer_device_id
    LEFT JOIN file_device_envelopes own ON own.file_node_id = f.node_id AND own.device_id = ${auth.deviceId}
      AND own.recipient_id = ${auth.accountId} AND own.revision = f.current_revision
      AND own.content_key_id = h.content_key_id AND own.content_epoch = h.content_epoch
    WHERE n.id = ${fileId} AND n.owner_id = ${ownerId} AND n.parent_node_id = ${parentId}
      AND e.encoding = 'receiving-file'
      AND ${fileAccessGuard(auth, ownerId, fileId, "file_read")}`);
  if (!row) return absent();
  try {
    const head = await verified(row);
    if (row.current_revision !== row.revision || row.current_representation_id !== row.representation_id ||
        row.key_epoch !== row.content_epoch || row.receiving_entry_id !== row.receiving_key_id ||
        row.receiving_entry_epoch !== row.receiving_epoch) throw new Error("inconsistent current File");
    await verifyFileRepresentation(head, row.representation_id, bytes(row.ciphertext));
    const result = { ownerId: row.owner_id, fileId, revision: row.revision,
      representationId: row.representation_id, contentKeyId: row.content_key_id, keyEpoch: row.content_epoch,
      ciphertext: encode(row.ciphertext), receivingPublicKey: encode(row.receiving_public_key),
      fileHead: wireHead(row) };
    if (row.has_parent_capability === 1) {
      return Response.json({ ...result, parentId: row.parent_node_id, nameCiphertext: encode(row.name_ciphertext),
        orderCiphertext: encode(row.order_ciphertext), keyEnvelope: encode(row.key_envelope),
        receivingKeyId: row.receiving_entry_id, receivingEpoch: row.receiving_entry_epoch,
        wrapRevision: row.wrap_revision, parentEnvelope: encode(row.parent_envelope) }, { headers });
    }
    if (!row.device_ciphertext || !row.device_digest || row.device_registry_epoch !== auth.registryEpoch ||
        !head.statement.recipients.some((r) => r.deviceId === auth.deviceId && r.accountId === auth.accountId &&
          r.registryEpoch === row.device_registry_epoch)) {
      return Response.json({ error: "provisioning_required" }, { status: 202, headers });
    }
    const key = await createDb(env.DB).get<{ transport_public_key: ArrayBuffer }>(sql`SELECT transport_public_key
      FROM encryption_devices WHERE id = ${auth.deviceId} AND account_id = ${auth.accountId} AND state = 'active'
        AND ${privateReadGuard(auth)}`);
    if (!key) return absent();
    await verifyDirectFileRecipientEnvelope(head, auth.accountId, auth.deviceId, bytes(key.transport_public_key),
      bytes(row.device_ciphertext));
    if (!equal(bytes(row.device_digest), await digest(bytes(row.device_ciphertext)))) throw new Error("invalid device envelope");
    return Response.json({ ...result, recipientEnvelope: encode(row.device_ciphertext) }, { headers });
  } catch { return invalid(); }
}

function parseHead(value: unknown): SignedFileHead {
  const input = record(value);
  if (!input || !exact(input, ["bytes", "digest", "signature"])) throw new Error("invalid File head");
  return { bytes: decodeTreeBytes(input.bytes, 131_072), digest: decodeTreeBytes(input.digest, 32),
    signature: decodeTreeBytes(input.signature, 64) };
}
function parsePayload(value: unknown) {
  const input = record(value), repr = record(input?.representation);
  if (!input || !exact(input, ["expectedHeadDigest", "expectedRevision", "expectedRecipientSetVersion",
    "representation", "parentEnvelope", "recipientEnvelopes", "signedHead"]) ||
    !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1 ||
    !Number.isSafeInteger(input.expectedRecipientSetVersion) || (input.expectedRecipientSetVersion as number) < 1 ||
    !repr || !exact(repr, ["id", "contentKeyId", "keyEpoch", "revision", "ciphertext"]) ||
    !isV7(repr.id) || !isV7(repr.contentKeyId) || !Number.isSafeInteger(repr.keyEpoch) ||
    !Number.isSafeInteger(repr.revision) || !Array.isArray(input.recipientEnvelopes) ||
    input.recipientEnvelopes.length > 256) throw new Error("invalid File save");
  const direct = input.recipientEnvelopes.map((item: unknown) => {
    const r = record(item);
    if (!r || !exact(r, ["deviceId", "ciphertext"]) || !isV7(r.deviceId)) throw new Error("invalid recipient");
    return { deviceId: r.deviceId, ciphertext: decodeTreeBytes(r.ciphertext, 16_384) };
  });
  if (new Set(direct.map((r) => r.deviceId)).size !== direct.length) throw new Error("duplicate recipient");
  return { expectedHeadDigest: decodeTreeBytes(input.expectedHeadDigest, 32),
    expectedRevision: input.expectedRevision as number, expectedRecipientSetVersion: input.expectedRecipientSetVersion as number,
    representation: { id: repr.id, contentKeyId: repr.contentKeyId, keyEpoch: repr.keyEpoch as number,
      revision: repr.revision as number, ciphertext: decodeTreeBytes(repr.ciphertext, MAX_REPRESENTATION_BYTES) },
    parentEnvelope: decodeTreeBytes(input.parentEnvelope, 16_384), direct, signedHead: parseHead(input.signedHead) };
}

async function verifySubmitted(env: Env, auth: AuthorizedDevice, ownerId: string, fileId: string,
  input: ReturnType<typeof parsePayload>, target: Uint8Array, current: Recipient[]) {
  const next = await verifyFileHead(input.signedHead, { ownerId, vaultId: ownerId, fileId,
    signerDeviceId: auth.deviceId, publicKey: auth.assertionPublicKey, revision: input.representation.revision });
  const s = next.statement;
  if (s.publication.status !== "none" || s.representation.id !== input.representation.id ||
      s.contentKey.id !== input.representation.contentKeyId || s.contentKey.epoch !== input.representation.keyEpoch ||
      s.recipients.length !== input.direct.length || s.recipients.length !== current.length) throw new Error("invalid head shape");
  await verifyFileReceivingTarget(next, target);
  await verifyFileParentEnvelope(next, input.parentEnvelope);
  await verifyFileRepresentation(next, input.representation.id, input.representation.ciphertext);
  const expected = await Promise.all(current.map(async (r) => ({ accountId: r.accountId, deviceId: r.deviceId,
    registryEpoch: r.registryEpoch, publicKeyDigest: await digest(decodeTreeBytes(r.publicKey, 65)), grants: r.grants })));
  assertExactFileRecipientDescriptors(next, expected);
  for (const r of current) {
    const wrapped = input.direct.find((item) => item.deviceId === r.deviceId);
    if (!wrapped) throw new Error("missing recipient");
    await verifyDirectFileRecipientEnvelope(next, r.accountId, r.deviceId,
      decodeTreeBytes(r.publicKey, 65), wrapped.ciphertext);
  }
  return next;
}

/** Current live recipient set is rechecked inside the witness INSERT. A preflight is never authority. */
function exactRecipientGuard(ownerId: string, fileId: string, expected: Recipient[]) {
  const devices = expected.map((r) => r.deviceId);
  const membership = devices.length ? sql`d.id NOT IN (${sql.join(devices.map((id) => sql`${id}`), sql`, `)})` : sql`1 = 1`;
  const matches = expected.flatMap((r) => [
    sql`EXISTS (SELECT 1 FROM encryption_devices d JOIN account_encryption_identities registry
      ON registry.account_id = d.account_id WHERE d.id = ${r.deviceId} AND d.account_id = ${r.accountId}
      AND d.state = 'active' AND registry.registry_epoch = ${r.registryEpoch}
      AND d.transport_public_key = ${decodeTreeBytes(r.publicKey, 65)})`,
    sql`(SELECT COUNT(*) FROM grants g WHERE g.owner_id = ${ownerId} AND g.target_node_id = ${fileId}
      AND g.target_kind = 'file' AND g.recipient_id = ${r.accountId}) = ${r.grants.length}`,
    ...r.grants.map((g) => sql`EXISTS (SELECT 1 FROM grants current_grant WHERE current_grant.id = ${g.id}
      AND current_grant.owner_id = ${ownerId} AND current_grant.target_node_id = ${fileId}
      AND current_grant.target_kind = 'file' AND current_grant.recipient_id = ${r.accountId}
      AND current_grant.generation = ${g.generation})`),
  ]);
  return sql`NOT EXISTS (SELECT 1 FROM grants g JOIN encryption_devices d ON d.account_id = g.recipient_id
    AND d.state = 'active' WHERE g.owner_id = ${ownerId} AND g.target_node_id = ${fileId}
    AND g.target_kind = 'file' AND ${membership}) ${matches.length ? sql`AND ${sql.join(matches, sql` AND `)}` : sql``}`;
}
/** An active ticket-19 barrier on the File or any ancestor prevents all current writes. */
export function unblocked(ownerId: string, fileId: string) {
  return sql`NOT EXISTS (WITH RECURSIVE ancestors(id, parent_node_id, depth) AS (
    SELECT id, parent_node_id, 0 FROM vault_nodes WHERE id = ${fileId} AND owner_id = ${ownerId}
    UNION ALL SELECT n.id, n.parent_node_id, a.depth + 1 FROM ancestors a JOIN vault_nodes n
      ON n.id = a.parent_node_id WHERE n.owner_id = ${ownerId} AND a.depth < 100
  ) SELECT 1 FROM ancestors a JOIN rotation_barriers b ON b.target_node_id = a.id AND b.owner_id = ${ownerId})`;
}

export async function saveV2File(env: Env, auth: AuthorizedDevice, fileId: string, value: unknown): Promise<Response> {
  let input: ReturnType<typeof parsePayload>;
  try { input = parsePayload(value); } catch { return invalid(); }
  const current = await headRow(env, fileId);
  if (!current) return absent();
  try {
    const before = await verified(current), expected = await recipients(env, current.owner_id, fileId);
    if (input.expectedRevision !== current.revision || input.expectedRecipientSetVersion !== current.recipient_set_version ||
        !equal(input.expectedHeadDigest, bytes(current.digest)) ||
        input.representation.revision !== current.revision + 1 ||
        input.representation.keyEpoch !== current.content_epoch + 1 ||
        input.representation.id === current.representation_id || input.representation.contentKeyId === current.content_key_id) return changed();
    const after = await verifySubmitted(env, auth, current.owner_id, fileId, input,
      bytes(current.receiving_public_key), expected);
    assertFileHeadCommitTransition(before, after);
    const membership = (head: VerifiedFileHead) => JSON.stringify(head.statement.recipients.map((r) => [
      r.accountId, r.deviceId, r.registryEpoch, encode(r.publicKeyDigest), r.grants]));
    if (after.statement.receivingKey.epoch !== before.statement.receivingKey.epoch ||
        after.statement.recipientSetVersion !== before.statement.recipientSetVersion +
          (membership(after) === membership(before) ? 0 : 1)) return invalid();
    const now = Date.now();
    if (auth.expiresAt <= now) return changed();
    const { owner_id: ownerId } = current;
    const marker = sql`EXISTS (SELECT 1 FROM file_write_witnesses w WHERE w.file_node_id = ${fileId}
      AND w.proof_id = ${auth.proofId})`;
    const recipientGuard = exactRecipientGuard(ownerId, fileId, expected);
    const statements = [
      // Unique guarded marker survives the multirow insert/delete sequence, unlike changes()=1.
      sql`INSERT INTO file_write_witnesses (file_node_id, proof_id)
        SELECT f.node_id, ${auth.proofId} FROM files f JOIN file_heads h ON h.file_node_id = f.node_id
        JOIN directory_entries e ON e.child_node_id = f.node_id AND e.owner_id = f.owner_id
        WHERE f.node_id = ${fileId} AND f.owner_id = ${ownerId} AND e.encoding = 'receiving-file'
          AND h.digest = ${input.expectedHeadDigest} AND h.revision = ${input.expectedRevision}
          AND h.recipient_set_version = ${input.expectedRecipientSetVersion}
          AND h.receiving_public_key = ${bytes(current.receiving_public_key)}
          AND h.receiving_key_id = ${current.receiving_key_id} AND h.receiving_epoch = ${current.receiving_epoch}
          AND f.current_revision = ${input.expectedRevision} AND f.current_representation_id = ${current.representation_id}
          AND ${fileAccessGuard(auth, ownerId, fileId, "file_edit")} AND ${recipientGuard}
          AND ${unblocked(ownerId, fileId)} AND ${privateReadGuard(auth)}
          AND NOT EXISTS (SELECT 1 FROM device_proof_uses WHERE account_id = ${auth.accountId} AND proof_id = ${auth.proofId})`,
      sql`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id, key_epoch,
        ciphertext, ciphertext_size, created_at) SELECT ${input.representation.id}, ${fileId}, ${ownerId},
        ${input.representation.revision}, ${input.representation.contentKeyId}, ${input.representation.keyEpoch},
        ${input.representation.ciphertext}, ${input.representation.ciphertext.byteLength}, ${now} WHERE ${marker}`,
      sql`UPDATE file_heads SET bytes = ${input.signedHead.bytes}, digest = ${input.signedHead.digest},
        signature = ${input.signedHead.signature}, signer_device_id = ${auth.deviceId},
        revision = ${input.representation.revision}, representation_id = ${input.representation.id},
        content_key_id = ${input.representation.contentKeyId}, content_epoch = ${input.representation.keyEpoch},
        recipient_set_version = ${after.statement.recipientSetVersion}, parent_envelope = ${input.parentEnvelope}
        WHERE file_node_id = ${fileId} AND owner_id = ${ownerId} AND ${marker}`,
      sql`UPDATE files SET current_revision = ${input.representation.revision},
        current_representation_id = ${input.representation.id} WHERE node_id = ${fileId}
        AND owner_id = ${ownerId} AND ${marker}`,
      sql`DELETE FROM file_device_envelopes WHERE file_node_id = ${fileId} AND ${marker}`,
      ...expected.map((r) => {
        const ciphertext = input.direct.find((e) => e.deviceId === r.deviceId)!.ciphertext;
        return sql`INSERT INTO file_device_envelopes (file_node_id, owner_id, recipient_id, device_id,
            revision, content_key_id, content_epoch, registry_epoch, ciphertext, digest)
          SELECT ${fileId}, ${ownerId}, ${r.accountId}, ${r.deviceId}, ${input.representation.revision},
            ${input.representation.contentKeyId}, ${input.representation.keyEpoch}, ${r.registryEpoch},
            ${ciphertext}, ${after.statement.recipients.find((e) => e.deviceId === r.deviceId)!.envelopeDigest}
          WHERE ${marker}`;
      }),
      sql`DELETE FROM file_representations WHERE id = ${current.representation_id} AND file_node_id = ${fileId}
        AND owner_id = ${ownerId} AND ${marker}`,
      sql`INSERT INTO device_proof_uses (account_id, proof_id, session_id, expires_at)
        SELECT ${auth.accountId}, ${auth.proofId}, ${auth.sessionId}, ${auth.expiresAt} WHERE ${marker}`,
      sql`UPDATE encryption_devices SET last_proof_at = ${coarseProofTime(now)} WHERE id = ${auth.deviceId}
        AND account_id = ${auth.accountId} AND ${marker}
        AND (last_proof_at IS NULL OR last_proof_at < ${coarseProofTime(now)})`,
      sql`DELETE FROM file_write_witnesses WHERE file_node_id = ${fileId} AND proof_id = ${auth.proofId}`,
    ];
    const result = await atomicSqlBatch(env.DB, statements);
    return result[0]?.meta.changes === 1 ? Response.json({ revision: input.representation.revision,
      headDigest: encode(input.signedHead.digest) }, { headers }) : changed();
  } catch { return invalid(); }
}

/** New Files begin with independent receiving keys, even in a v1 parent: the
 * signed structural listing advances to v2 in the same conditional creation.
 */
export async function createV2Child(env: Env, auth: AuthorizedDevice, parentId: string, value: unknown): Promise<Response> {
  const v = record(value), representation = record(v?.representation);
  if (!v || !exact(v, ["nodeId", "kind", "encoding", "expectedRevision", "nameCiphertext",
      "orderCiphertext", "keyEnvelope", "representation", "receivingKeyId", "receivingEpoch",
      "wrapRevision", "receivingPublicKey", "parentEnvelope", "recipientEnvelopes", "signedHead", "listingHead"]) ||
      !isV7(v.nodeId) || v.kind !== "file" || v.encoding !== "receiving-file" ||
      !Number.isSafeInteger(v.expectedRevision) || (v.expectedRevision as number) < 1 ||
      !isV7(v.receivingKeyId) || v.receivingEpoch !== 1 ||
      v.wrapRevision !== (v.expectedRevision as number) + 1 ||
      !Array.isArray(v.recipientEnvelopes) || v.recipientEnvelopes.length !== 0 ||
      !representation || !exact(representation, ["id", "contentKeyId", "keyEpoch", "revision", "ciphertext"]) ||
      !isV7(representation.id) || !isV7(representation.contentKeyId) ||
      representation.keyEpoch !== 1 || representation.revision !== 1) return invalid();
  const contentOwner = (await createDb(env.DB).get<{ owner_id: string }>(sql`SELECT owner_id
    FROM vault_nodes WHERE id = ${parentId} AND kind = 'directory'`))?.owner_id;
  if (!contentOwner) return absent();
  const parent = await createDb(env.DB).get<{ owner_id: string; listing_version: ListingVersion }>(sql`
    SELECT d.owner_id, d.listing_version FROM directories d
    WHERE d.node_id = ${parentId} AND d.owner_id = ${contentOwner}
      AND ${directoryAccessGuard(auth, contentOwner, parentId, "child_create")}`);
  if (!parent) return absent();
  try {
    const ownerId = parent.owner_id, fileId = v.nodeId, contentKeyId = representation.contentKeyId;
    const name = treeEnvelope(v.nameCiphertext, 4096, { purpose: "directory-metadata",
      vaultId: ownerId, objectId: fileId, keyId: parentId, keyEpoch: 1, revision: 1 });
    const order = treeEnvelope(v.orderCiphertext, 4096, { purpose: "directory-metadata",
      vaultId: ownerId, objectId: fileId, keyId: parentId, keyEpoch: 1, revision: 1 });
    const wrapper = treeEnvelope(v.keyEnvelope, 16_384, { purpose: "file-receiving-key",
      vaultId: ownerId, objectId: fileId, keyId: v.receivingKeyId, keyEpoch: 1,
      revision: v.wrapRevision as number });
    const representationCiphertext = treeEnvelope(representation.ciphertext, MAX_REPRESENTATION_BYTES,
      { purpose: "file-content", vaultId: ownerId, objectId: fileId, keyId: contentKeyId,
        keyEpoch: 1, revision: 1 });
    const receivingPublicKey = decodeTreeBytes(v.receivingPublicKey, 65);
    const parentEnvelope = decodeTreeBytes(v.parentEnvelope, 16_384);
    const signed = parseHead(v.signedHead);
    const head = await verifyFileHead(signed, { ownerId, vaultId: ownerId, fileId,
      signerDeviceId: auth.deviceId, publicKey: auth.assertionPublicKey, revision: 1 });
    if (head.statement.publication.status !== "none" || head.statement.representation.id !== representation.id ||
        head.statement.contentKey.id !== contentKeyId || head.statement.contentKey.epoch !== 1 ||
        head.statement.receivingKey.id !== v.receivingKeyId || head.statement.receivingKey.epoch !== 1 ||
        head.statement.recipientSetVersion !== 1 || head.statement.recipients.length !== 0) return invalid();
    await verifyFileReceivingTarget(head, receivingPublicKey);
    await verifyFileParentEnvelope(head, parentEnvelope);
    await verifyFileRepresentation(head, representation.id as string, representationCiphertext);
    const listing = await signedListing(v.listingHead, auth, parentId, v.expectedRevision as number,
      ownerId, 2);
    const now = Date.now();
    const committed = await commitDirectoryMutation(env, auth, parentId, v.expectedRevision as number,
      listing, sql`EXISTS (SELECT 1 FROM directories WHERE node_id = ${parentId}
        AND owner_id = ${ownerId}) AND ${directoryAccessGuard(auth, ownerId, parentId, "child_create")}
        AND ${unblocked(ownerId, parentId)}`,
      (previous) => [
        sql`INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at)
          SELECT ${fileId}, 'file', ${ownerId}, ${parentId}, ${now}, ${now} WHERE ${previous}`,
        sql`INSERT INTO files (node_id, owner_id, current_representation_id, current_revision)
          SELECT ${fileId}, ${ownerId}, ${representation.id}, 1 WHERE ${previous}`,
        sql`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id,
          key_epoch, ciphertext, ciphertext_size, created_at)
          SELECT ${representation.id}, ${fileId}, ${ownerId}, 1, ${contentKeyId}, 1,
            ${representationCiphertext}, ${representationCiphertext.byteLength}, ${now} WHERE ${previous}`,
        sql`INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id,
          name_ciphertext, order_ciphertext, key_envelope, encoding, receiving_key_id,
          receiving_epoch, wrap_revision)
          SELECT ${fileId}, ${ownerId}, ${parentId}, ${name}, ${order}, ${wrapper},
          'receiving-file', ${v.receivingKeyId}, 1, ${v.wrapRevision} WHERE ${previous}`,
        sql`INSERT INTO file_heads (file_node_id, owner_id, bytes, digest, signature, signer_device_id,
          receiving_public_key, receiving_key_id, receiving_epoch, recipient_set_version, revision,
          representation_id, content_key_id, content_epoch, parent_envelope)
          SELECT ${fileId}, ${ownerId}, ${signed.bytes}, ${signed.digest}, ${signed.signature},
          ${auth.deviceId}, ${receivingPublicKey}, ${v.receivingKeyId}, 1, 1, 1,
          ${representation.id}, ${contentKeyId}, 1, ${parentEnvelope} WHERE ${previous}`,
      ], { ownerId, previousVersion: parent.listing_version, nextVersion: 2 });
    return committed ? Response.json({ nodeId: fileId, entriesRevision: (v.expectedRevision as number) + 1 },
      { status: 201, headers }) : changed();
  } catch { return invalid(); }
}

/** Migration preserves the exact current representation/key/revision and advances only structure. */
export async function migrateV1File(env: Env, auth: AuthorizedDevice, fileId: string, value: unknown): Promise<Response> {
  const v = record(value), entry = record(v?.expectedEntry), repr = record(v?.representation);
  if (!v || !exact(v, ["expectedEntriesRevision", "expectedRevision", "expectedEntry", "representation",
    "receivingKeyId", "receivingEpoch", "wrapRevision", "receivingPublicKey", "receivingWrapper",
    "parentEnvelope", "recipientEnvelopes", "signedHead", "listingHead", "listingVersion"]) ||
    !entry || !exact(entry, ["nameCiphertext", "orderCiphertext", "keyEnvelope"]) ||
    !repr || !exact(repr, ["id", "contentKeyId", "keyEpoch", "ciphertext"]) ||
    !isV7(v.receivingKeyId) || v.receivingEpoch !== 1 ||
    !Number.isSafeInteger(v.wrapRevision) || v.wrapRevision !== (v.expectedEntriesRevision as number) + 1 ||
    !Number.isSafeInteger(v.expectedEntriesRevision) || (v.expectedEntriesRevision as number) < 2 ||
    !Number.isSafeInteger(v.expectedRevision) || (v.expectedRevision as number) < 1 ||
    ![1, 2].includes(v.listingVersion as number)) return invalid();
  const ownerId = await fileOwner(env, fileId);
  if (!ownerId) return absent();
  const parentId = (await createDb(env.DB).get<{ parent_node_id: string }>(sql`SELECT parent_node_id
    FROM vault_nodes WHERE id = ${fileId} AND owner_id = ${ownerId}`))?.parent_node_id;
  if (!parentId) return absent();
  const row = await createDb(env.DB).get<{ owner_id: string; parent_node_id: string; current_revision: number;
    entries_revision: number; listing_version: ListingVersion; current_representation_id: string; content_key_id: string;
    key_epoch: number; ciphertext: ArrayBuffer; key_envelope: ArrayBuffer; name_ciphertext: ArrayBuffer;
    order_ciphertext: ArrayBuffer }>(sql`SELECT n.owner_id, n.parent_node_id, f.current_revision,
      d.entries_revision, d.listing_version, f.current_representation_id, r.content_key_id, r.key_epoch,
      r.ciphertext, e.key_envelope, e.name_ciphertext, e.order_ciphertext
    FROM vault_nodes n JOIN files f ON f.node_id = n.id AND f.owner_id = n.owner_id
    JOIN file_representations r ON r.id = f.current_representation_id AND r.file_node_id = n.id
      AND r.revision = f.current_revision AND r.owner_id = n.owner_id
    JOIN directory_entries e ON e.child_node_id = n.id AND e.encoding = 'legacy-file'
    JOIN directories d ON d.node_id = n.parent_node_id
    WHERE n.id = ${fileId} AND n.owner_id = ${ownerId} AND n.parent_node_id = ${parentId}
      AND ${directoryAccessGuard(auth, ownerId, parentId, "child_create")}`);
  if (!row) return absent();
  if (row.current_revision !== v.expectedRevision || row.entries_revision !== v.expectedEntriesRevision ||
      row.listing_version !== v.listingVersion || row.current_representation_id !== repr.id ||
      row.content_key_id !== repr.contentKeyId || row.key_epoch !== repr.keyEpoch ||
      !equal(bytes(row.ciphertext), decodeTreeBytes(repr.ciphertext, MAX_REPRESENTATION_BYTES)) ||
      !equal(bytes(row.key_envelope), decodeTreeBytes(entry.keyEnvelope, 16_384)) ||
      !equal(bytes(row.name_ciphertext), decodeTreeBytes(entry.nameCiphertext, 4096)) ||
      !equal(bytes(row.order_ciphertext), decodeTreeBytes(entry.orderCiphertext, 4096))) return changed();
  try {
    const publicKey = decodeTreeBytes(v.receivingPublicKey, 65);
    const wrapper = decodeTreeBytes(v.receivingWrapper, 16_384);
    const parentEnvelope = decodeTreeBytes(v.parentEnvelope, 16_384);
    const signed = parseHead(v.signedHead);
    const next = await verifyFileHead(signed, { ownerId: row.owner_id, vaultId: row.owner_id,
      fileId, signerDeviceId: auth.deviceId, publicKey: auth.assertionPublicKey, revision: row.current_revision });
    const s = next.statement;
    if (s.publication.status !== "none" || s.representation.id !== repr.id ||
        s.contentKey.id !== repr.contentKeyId || s.contentKey.epoch !== repr.keyEpoch ||
        s.receivingKey.id !== v.receivingKeyId || s.receivingKey.epoch !== v.receivingEpoch ||
        s.recipientSetVersion !== 1) return invalid();
    await verifyFileReceivingTarget(next, publicKey);
    await verifyFileRepresentation(next, repr.id as string, bytes(row.ciphertext));
    await verifyFileParentEnvelope(next, parentEnvelope);
    // The stable receiving wrapper is a symmetric parent envelope, not a direct-recipient capability.
    const inspected = inspectEnvelope(wrapper);
    if (inspected.suite !== "AES-256-GCM/HKDF-SHA-256" || inspected.context.purpose !== "file-receiving-key" ||
        inspected.context.vaultId !== row.owner_id || inspected.context.objectId !== fileId ||
        inspected.context.keyId !== v.receivingKeyId || inspected.context.keyEpoch !== 1 ||
        inspected.context.revision !== v.wrapRevision || Object.hasOwn(inspected.context, "recipientId")) return invalid();
    const current = await recipients(env, row.owner_id, fileId);
    const direct = Array.isArray(v.recipientEnvelopes) ? v.recipientEnvelopes : [];
    if (direct.length !== current.length) return invalid();
    const wrapped = direct.map((r: unknown) => {
      const item = record(r);
      if (!item || !exact(item, ["deviceId", "ciphertext"]) || !isV7(item.deviceId)) throw new Error("invalid recipient");
      return { deviceId: item.deviceId, ciphertext: decodeTreeBytes(item.ciphertext, 16_384) };
    });
    assertExactFileRecipientDescriptors(next, await Promise.all(current.map(async (r) => ({
      accountId: r.accountId, deviceId: r.deviceId, registryEpoch: r.registryEpoch,
      publicKeyDigest: await digest(decodeTreeBytes(r.publicKey, 65)), grants: r.grants }))));
    for (const r of current) {
      const envelope = wrapped.find((item) => item.deviceId === r.deviceId);
      if (!envelope) return invalid();
      await verifyDirectFileRecipientEnvelope(next, r.accountId, r.deviceId,
        decodeTreeBytes(r.publicKey, 65), envelope.ciphertext);
    }
    const listing = await signedListing(v.listingHead, auth, row.parent_node_id,
      row.entries_revision, row.owner_id, 2);
    if (auth.expiresAt <= Date.now()) return changed();
    const witness = sql`EXISTS (SELECT 1 FROM file_write_witnesses WHERE file_node_id = ${fileId}
      AND proof_id = ${auth.proofId})`;
    const now = Date.now();
    const result = await atomicSqlBatch(env.DB, [
      sql`INSERT INTO file_write_witnesses (file_node_id, proof_id)
        SELECT f.node_id, ${auth.proofId} FROM files f JOIN vault_nodes n ON n.id = f.node_id
        JOIN directories d ON d.node_id = n.parent_node_id
        JOIN directory_entries e ON e.child_node_id = f.node_id
        JOIN file_representations r ON r.id = f.current_representation_id
        WHERE f.node_id = ${fileId} AND f.owner_id = ${row.owner_id}
          AND f.current_revision = ${v.expectedRevision} AND f.current_representation_id = ${repr.id}
          AND r.content_key_id = ${repr.contentKeyId} AND r.key_epoch = ${repr.keyEpoch}
          AND r.ciphertext = ${bytes(row.ciphertext)} AND d.entries_revision = ${v.expectedEntriesRevision}
          AND d.listing_version = ${v.listingVersion} AND e.encoding = 'legacy-file'
          AND e.key_envelope = ${bytes(row.key_envelope)} AND e.name_ciphertext = ${bytes(row.name_ciphertext)}
          AND e.order_ciphertext = ${bytes(row.order_ciphertext)}
          AND ${directoryAccessGuard(auth, row.owner_id, row.parent_node_id, "child_create")}
          AND ${exactRecipientGuard(row.owner_id, fileId, current)} AND ${unblocked(row.owner_id, fileId)}
          AND NOT EXISTS (SELECT 1 FROM device_proof_uses WHERE account_id = ${auth.accountId} AND proof_id = ${auth.proofId})`,
      sql`UPDATE directories SET entries_revision = entries_revision + 1, listing_version = 2,
        capability_key_id = ${row.parent_node_id},
        listing_ciphertext = ${listing.ciphertext}, listing_digest = ${listing.digest},
        listing_signature = ${listing.signature}, listing_device_id = ${auth.deviceId}
        WHERE node_id = ${row.parent_node_id} AND owner_id = ${row.owner_id} AND ${witness}`,
      sql`UPDATE directory_entries SET encoding = 'receiving-file', key_envelope = ${wrapper},
        receiving_key_id = ${v.receivingKeyId}, receiving_epoch = 1, wrap_revision = ${v.wrapRevision}
        WHERE child_node_id = ${fileId} AND owner_id = ${row.owner_id} AND ${witness}`,
      sql`INSERT INTO file_heads (file_node_id, owner_id, bytes, digest, signature, signer_device_id,
        receiving_public_key, receiving_key_id, receiving_epoch, recipient_set_version, revision,
        representation_id, content_key_id, content_epoch, parent_envelope)
        SELECT ${fileId}, ${row.owner_id}, ${signed.bytes}, ${signed.digest}, ${signed.signature},
          ${auth.deviceId}, ${publicKey}, ${v.receivingKeyId}, 1, 1, ${row.current_revision},
          ${repr.id}, ${repr.contentKeyId}, ${repr.keyEpoch}, ${parentEnvelope} WHERE ${witness}`,
      ...current.map((r) => {
        const ciphertext = wrapped.find((item) => item.deviceId === r.deviceId)!.ciphertext;
        return sql`INSERT INTO file_device_envelopes (file_node_id, owner_id, recipient_id, device_id,
          revision, content_key_id, content_epoch, registry_epoch, ciphertext, digest)
          SELECT ${fileId}, ${row.owner_id}, ${r.accountId}, ${r.deviceId}, ${row.current_revision},
          ${repr.contentKeyId}, ${repr.keyEpoch}, ${r.registryEpoch}, ${ciphertext},
          ${next.statement.recipients.find((item) => item.deviceId === r.deviceId)!.envelopeDigest}
          WHERE ${witness}`;
      }),
      sql`INSERT INTO device_proof_uses (account_id, proof_id, session_id, expires_at)
        SELECT ${auth.accountId}, ${auth.proofId}, ${auth.sessionId}, ${auth.expiresAt} WHERE ${witness}`,
      sql`UPDATE encryption_devices SET last_proof_at = ${coarseProofTime(now)} WHERE id = ${auth.deviceId}
        AND account_id = ${auth.accountId} AND ${witness}
        AND (last_proof_at IS NULL OR last_proof_at < ${coarseProofTime(now)})`,
      sql`DELETE FROM file_write_witnesses WHERE file_node_id = ${fileId} AND proof_id = ${auth.proofId}`,
    ]);
    return result[0]?.meta.changes === 1 ? Response.json({ revision: row.current_revision,
      entriesRevision: row.entries_revision + 1, headDigest: encode(signed.digest) }, { headers }) : changed();
  } catch { return invalid(); }
}
