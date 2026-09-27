import { record } from "~/auth/request.server";
import { inspectEnvelope } from "~/crypto/enc-v1";
import { HPKE_SUITE } from "~/crypto/enc-v1/format";
import { atomicSqlBatch, createDb, sql } from "~/db/client.server";
import { privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { assertExactFileRecipientDescriptors, assertFileHeadCommitTransition,
  verifyDirectFileRecipientEnvelope, verifyFileHead, verifyFileParentEnvelope,
  verifyFileReceivingTarget } from "~/tree/file-head";
import { exactRecipientGuard, recipients, unblocked } from "~/tree/file-v2.server";
import { decodeTreeBytes, encodeTreeBytes, isV7 } from "~/tree/wire";
import { fileAccessGuard } from "./access.server";
import { digestBytes, hex, sameBytes, verifyOffer } from "./offer";
import { begin, finish, marker, proofTime, spent } from "./sharing.server";
import type { FileProvisioningBootstrap, FileProvisioningCompletion } from "./provisioning-wire";

const headers = { "Cache-Control": "no-store" };
const absent = () => Response.json({ error: "not_found" }, { status: 404, headers });
const pending = () => Response.json({ error: "provisioning_required" }, { status: 202, headers });
const invalid = () => Response.json({ error: "invalid_sharing_request" }, { status: 400, headers });
const changed = () => Response.json({ error: "share_changed" }, { status: 409, headers });
const bytes = (value: ArrayBuffer | Uint8Array) => new Uint8Array(value);
const wire = (value: ArrayBuffer | Uint8Array) => encodeTreeBytes(bytes(value));
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

type BootstrapRow = { grant_id: string; generation: number; owner_id: string; recipient_id: string;
  file_node_id: string; revision: number; recipient_set_version: number; content_key_id: string;
  content_epoch: number; representation_id: string; receiving_key_id: string; receiving_epoch: number;
  receiving_public_key: ArrayBuffer; parent_envelope: ArrayBuffer;
  bytes: ArrayBuffer; digest: ArrayBuffer; signature: ArrayBuffer; signer_device_id: string;
  assertion_public_key: ArrayBuffer; signer_account_id: string; transport_public_key: ArrayBuffer;
  retained_ciphertext: ArrayBuffer | null; retained_digest: ArrayBuffer | null;
  retained_key_digest: ArrayBuffer | null; retained_revision: number | null;
  retained_key_id: string | null; retained_epoch: number | null };

/** This query may read parent envelope for integrity verification; the response NEVER returns it.
 * A direct File Grant, current active device/registry, and current File must all coexist.
 */
async function currentRow(env: Env, auth: AuthorizedDevice, fileId: string): Promise<BootstrapRow | undefined> {
  const ownerId = (await createDb(env.DB).get<{ owner_id: string }>(sql`
    SELECT owner_id FROM grants WHERE target_node_id = ${fileId} AND target_kind = 'file'
      AND recipient_id = ${auth.accountId} AND ${privateReadGuard(auth)}`))?.owner_id;
  if (!ownerId) return undefined;
  return createDb(env.DB).get<BootstrapRow>(sql`SELECT g.id AS grant_id, g.generation, g.owner_id,
    g.recipient_id, h.file_node_id, h.revision, h.recipient_set_version, h.content_key_id,
    h.content_epoch, h.representation_id, h.receiving_key_id, h.receiving_epoch,
    h.receiving_public_key, h.parent_envelope, h.bytes, h.digest, h.signature, h.signer_device_id,
    signer.assertion_public_key, signer.account_id AS signer_account_id, d.transport_public_key,
    m.ciphertext AS retained_ciphertext, m.digest AS retained_digest,
    m.public_key_digest AS retained_key_digest, m.revision AS retained_revision,
    m.content_key_id AS retained_key_id, m.content_epoch AS retained_epoch
    FROM grants g JOIN vault_nodes n ON n.id = g.target_node_id AND n.owner_id = g.owner_id
    JOIN files f ON f.node_id = n.id AND f.owner_id = n.owner_id
    JOIN file_heads h ON h.file_node_id = f.node_id AND h.owner_id = f.owner_id
      AND h.revision = f.current_revision AND h.representation_id = f.current_representation_id
    JOIN encryption_devices signer ON signer.id = h.signer_device_id
    JOIN encryption_devices d ON d.id = ${auth.deviceId} AND d.account_id = g.recipient_id
      AND d.state = 'active'
    LEFT JOIN grant_retained_material m ON m.grant_id = g.id AND m.device_id = d.id
    WHERE g.target_node_id = ${fileId} AND g.target_kind = 'file' AND n.kind = 'file'
      AND n.import_id IS NULL AND g.recipient_id = ${auth.accountId}
      AND g.owner_id = ${ownerId}
      AND ${fileAccessGuard(auth, ownerId, fileId, "file_read")}
      AND ${unblocked(ownerId, fileId)}`);
}

async function checked(env: Env, auth: AuthorizedDevice, fileId: string) {
  const row = await currentRow(env, auth, fileId);
  if (!row) return null;
  if (!row.retained_ciphertext || !row.retained_digest || !row.retained_key_digest ||
      row.retained_key_id !== row.content_key_id || row.retained_epoch !== row.content_epoch ||
      row.retained_revision !== row.revision) return { row, current: null };
  if (!sameBytes(await digestBytes(bytes(row.transport_public_key)), bytes(row.retained_key_digest)) ||
      !sameBytes(await digestBytes(bytes(row.retained_ciphertext)), bytes(row.retained_digest))) {
    return { row, current: null };
  }
  const head = await verifyFileHead({ bytes: bytes(row.bytes), digest: bytes(row.digest),
    signature: bytes(row.signature) }, { ownerId: row.owner_id, vaultId: row.owner_id, fileId,
    revision: row.revision, signerDeviceId: row.signer_device_id,
    publicKey: bytes(row.assertion_public_key) });
  if (head.statement.contentKey.id !== row.content_key_id ||
      head.statement.contentKey.epoch !== row.content_epoch ||
      head.statement.representation.id !== row.representation_id ||
      head.statement.receivingKey.id !== row.receiving_key_id ||
      head.statement.receivingKey.epoch !== row.receiving_epoch ||
      head.statement.recipientSetVersion !== row.recipient_set_version) throw new Error("invalid head");
  await verifyFileReceivingTarget(head, bytes(row.receiving_public_key));
  await verifyFileParentEnvelope(head, bytes(row.parent_envelope));
  const frame = inspectEnvelope(bytes(row.retained_ciphertext));
  const context = frame.context;
  if (frame.suite !== HPKE_SUITE || context.purpose !== "grant" ||
      context.vaultId !== row.owner_id || context.objectId !== fileId ||
      context.keyId !== row.content_key_id || context.keyEpoch !== row.content_epoch ||
      context.revision !== row.revision || context.recipientId !== auth.deviceId) {
    return { row, current: null };
  }
  return { row, current: head };
}

/** A read-only direct File holder can prepare a fresh recipient-set signature
 * from a retained CURRENT key. No label, name, path, parent, or representation
 * ciphertext is returned. The head contains the necessary opaque commitments.
 */
export async function bootstrapFileProvisioning(env: Env, auth: AuthorizedDevice,
  fileId: string): Promise<Response> {
  try {
    const state = await checked(env, auth, fileId);
    if (!state) return absent();
    if (!state.current) return pending();
    const { row } = state;
    const eligible = await recipients(env, row.owner_id, fileId);
    const response: FileProvisioningBootstrap = { ownerId: row.owner_id, fileId,
      currentHead: { bytes: wire(row.bytes), digest: wire(row.digest), signature: wire(row.signature),
        signerDeviceId: row.signer_device_id, signerPublicKey: wire(row.assertion_public_key) },
      recipients: eligible, retained: { ciphertext: wire(row.retained_ciphertext!),
        digest: wire(row.retained_digest!), contentKeyId: row.content_key_id,
        contentEpoch: row.content_epoch, revision: row.revision } };
    return Response.json(response, { headers });
  } catch { return invalid(); }
}

/** Completes only a same-revision recipient-set update. Even read-only holders
 * may re-envelope a retained key, but cannot change Markdown, receiving target,
 * representation, parent envelope, File epoch, or the Grant authority relation.
 */
export async function completeFileProvisioning(env: Env, auth: AuthorizedDevice,
  fileId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["expectedHeadDigest", "expectedRevision", "expectedRecipientSetVersion",
    "signedHead", "recipientEnvelopes"]) || !Array.isArray(input.recipientEnvelopes) ||
    input.recipientEnvelopes.length > 256 || !Number.isSafeInteger(input.expectedRevision) ||
    !Number.isSafeInteger(input.expectedRecipientSetVersion) ||
    (input.expectedRevision as number) < 1 || (input.expectedRecipientSetVersion as number) < 1) return invalid();
  const signed = record(input.signedHead);
  if (!signed || !exact(signed, ["bytes", "digest", "signature"])) return invalid();
  try {
    const expectedDigest = decodeTreeBytes(input.expectedHeadDigest, 32);
    const nextBytes = decodeTreeBytes(signed.bytes, 131072);
    const nextDigest = decodeTreeBytes(signed.digest, 32);
    const nextSignature = decodeTreeBytes(signed.signature, 64);
    const submitted = input.recipientEnvelopes.map((item: unknown) => {
      const entry = record(item);
      if (!entry || !exact(entry, ["deviceId", "ciphertext"]) || !isV7(entry.deviceId)) throw new Error("invalid delivery");
      return { deviceId: entry.deviceId, ciphertext: decodeTreeBytes(entry.ciphertext, 16384) };
    });
    if (new Set(submitted.map((item) => item.deviceId)).size !== submitted.length) return invalid();
    const state = await checked(env, auth, fileId);
    if (!state) return absent();
    if (!state.current) return pending();
    const { row, current } = state;
    if (!sameBytes(expectedDigest, bytes(row.digest)) || input.expectedRevision !== row.revision ||
        input.expectedRecipientSetVersion !== row.recipient_set_version) return changed();
    const next = await verifyFileHead({ bytes: nextBytes, digest: nextDigest, signature: nextSignature },
      { ownerId: row.owner_id, vaultId: row.owner_id, fileId, revision: row.revision,
        signerDeviceId: auth.deviceId, publicKey: auth.assertionPublicKey });
    assertFileHeadCommitTransition(current, next, { expectedSameRevisionTransition: "recipient-set-update" });
    if (next.statement.recipientSetVersion !== current.statement.recipientSetVersion + 1) return invalid();
    const expected = await recipients(env, row.owner_id, fileId);
    if (expected.length !== submitted.length) return invalid();
    assertExactFileRecipientDescriptors(next, await Promise.all(expected.map(async (item) => ({
      accountId: item.accountId, deviceId: item.deviceId, registryEpoch: item.registryEpoch,
      grants: item.grants, publicKeyDigest: await digestBytes(decodeTreeBytes(item.publicKey, 65)) }))));
    const delivery = await Promise.all(expected.map(async (item) => {
      const sealed = submitted.find((entry) => entry.deviceId === item.deviceId);
      if (!sealed) throw new Error("missing envelope");
      await verifyDirectFileRecipientEnvelope(next, item.accountId, item.deviceId,
        decodeTreeBytes(item.publicKey, 65), sealed.ciphertext);
      return { accountId: item.accountId, deviceId: item.deviceId, registryEpoch: item.registryEpoch,
        ciphertext: Array.from(sealed.ciphertext, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        digest: Array.from(await digestBytes(sealed.ciphertext), (byte) => byte.toString(16).padStart(2, "0")).join("") };
    }));
    // The complete set travels as ONE JSON binding: never a per-device D1 query or
    // a partial series of independent commits.
    const payload = JSON.stringify(delivery);
    if (payload.length > 1024 * 1024 || auth.expiresAt <= Date.now()) return invalid();
    const invocationId = crypto.randomUUID(), live = marker(auth, invocationId);
    const guard = sql`EXISTS (SELECT 1 FROM grants g JOIN grant_retained_material m ON m.grant_id = g.id
      AND m.device_id = ${auth.deviceId} JOIN encryption_devices d ON d.id = m.device_id
      AND d.account_id = g.recipient_id AND d.state = 'active'
      JOIN files f ON f.node_id = g.target_node_id AND f.owner_id = g.owner_id
      JOIN file_heads h ON h.file_node_id = f.node_id AND h.owner_id = f.owner_id
      WHERE g.id = ${row.grant_id} AND g.generation = ${row.generation}
        AND g.target_node_id = ${fileId} AND g.target_kind = 'file'
        AND g.recipient_id = ${auth.accountId} AND g.owner_id = ${row.owner_id}
        AND m.public_key_digest = ${bytes(row.retained_key_digest!)}
        AND d.transport_public_key = ${bytes(row.transport_public_key)}
        AND m.content_key_id = h.content_key_id AND m.content_epoch = h.content_epoch
        AND m.revision = h.revision AND m.ciphertext = ${bytes(row.retained_ciphertext!)}
        AND m.digest = ${bytes(row.retained_digest!)}
        AND f.current_revision = h.revision AND f.current_representation_id = h.representation_id
        AND h.digest = ${expectedDigest} AND h.revision = ${row.revision}
        AND h.recipient_set_version = ${row.recipient_set_version}
        AND h.receiving_public_key = ${bytes(row.receiving_public_key)}
        AND h.receiving_key_id = ${row.receiving_key_id} AND h.receiving_epoch = ${row.receiving_epoch}
        AND h.parent_envelope = ${bytes(row.parent_envelope)}
        AND ${fileAccessGuard(auth, row.owner_id, fileId, "file_read")}
        AND ${unblocked(row.owner_id, fileId)} AND ${exactRecipientGuard(row.owner_id, fileId, expected)})`;
    const now = Date.now();
    const statements = [
      begin(auth, invocationId, guard),
      sql`UPDATE file_heads SET bytes = ${nextBytes}, digest = ${nextDigest}, signature = ${nextSignature},
        signer_device_id = ${auth.deviceId}, recipient_set_version = ${next.statement.recipientSetVersion}
        WHERE file_node_id = ${fileId} AND owner_id = ${row.owner_id} AND digest = ${expectedDigest}
          AND ${live}`,
      sql`DELETE FROM file_device_envelopes WHERE file_node_id = ${fileId} AND owner_id = ${row.owner_id}
        AND ${live}`,
      sql`INSERT INTO file_device_envelopes (file_node_id, owner_id, recipient_id, device_id,
        revision, content_key_id, content_epoch, registry_epoch, ciphertext, digest)
        SELECT ${fileId}, ${row.owner_id}, json_extract(value, '$.accountId'),
          json_extract(value, '$.deviceId'), ${row.revision}, ${row.content_key_id}, ${row.content_epoch},
          json_extract(value, '$.registryEpoch'), unhex(json_extract(value, '$.ciphertext')),
          unhex(json_extract(value, '$.digest')) FROM json_each(${payload}) WHERE ${live}`,
      sql`DELETE FROM provisioning_needs WHERE ${live} AND grant_id IN (
        SELECT g.id FROM grants g WHERE g.owner_id = ${row.owner_id} AND g.target_node_id = ${fileId}
        AND g.target_kind = 'file') AND device_id IN (SELECT value FROM json_each(${JSON.stringify(delivery.map((d) => d.deviceId))}))
        AND EXISTS (SELECT 1 FROM grant_label_deliveries label
          JOIN grants g ON g.id = label.grant_id
          WHERE label.grant_id = provisioning_needs.grant_id AND label.device_id = provisioning_needs.device_id
            AND label.registry_epoch = provisioning_needs.registry_epoch
            AND g.generation = provisioning_needs.generation)`,
      spent(auth, invocationId), proofTime(auth, invocationId), finish(auth, invocationId),
    ];
    const result = await atomicSqlBatch(env.DB, statements);
    if (result[0]?.meta.changes !== 1 || result[1]?.meta.changes !== 1 ||
        result[3]?.meta.changes !== expected.length) return changed();
    // A signed current head alone never suffices for a named ready root.
    // Re-read the caller's actual current label delivery, not a preflight flag.
    const label = await createDb(env.DB).get<{ ciphertext: ArrayBuffer; digest: ArrayBuffer;
      offer_bytes: ArrayBuffer; offer_digest: ArrayBuffer; offer_signature: ArrayBuffer;
      signer_public_key: ArrayBuffer }>(sql`SELECT l.ciphertext, l.digest, label.offer_bytes,
        label.offer_digest, label.offer_signature, signer.assertion_public_key AS signer_public_key
      FROM grants g JOIN grant_labels label ON label.grant_id = g.id
      JOIN encryption_devices signer ON signer.id = label.signer_device_id AND signer.account_id = g.owner_id
      JOIN grant_label_deliveries l ON l.grant_id = g.id AND l.device_id = ${auth.deviceId}
        AND l.registry_epoch = ${auth.registryEpoch}
      WHERE g.id = ${row.grant_id} AND g.generation = ${row.generation}
        AND ${privateReadGuard(auth)}`);
    let named = false;
    if (label) {
      try {
        const offer = await verifyOffer(bytes(label.offer_bytes), bytes(label.offer_digest),
          bytes(label.offer_signature), bytes(label.signer_public_key));
        named = offer.grantId === row.grant_id && offer.ownerId === row.owner_id &&
          offer.targetId === fileId && offer.devices.some((device) => device.accountId === auth.accountId &&
            device.deviceId === auth.deviceId && device.labelDigest === hex(bytes(label.digest))) &&
          sameBytes(await digestBytes(bytes(label.ciphertext)), bytes(label.digest));
      } catch { /* A missing/invalid label is provisioning, never a named ready File. */ }
    }
    return Response.json({ status: named ? "ready" : "provisioning", headDigest: wire(nextDigest) }, { headers });
  } catch { return invalid(); }
}
