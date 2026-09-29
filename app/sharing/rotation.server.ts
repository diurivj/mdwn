import type { SQL } from "drizzle-orm";
import { record } from "~/auth/request.server";
import { parseThreadRotation, ThreadRotationChangedError, threadRotationGuard, threadRotationStatements,
  type ThreadRotation } from "~/comments/comments.server";
import { atomicSqlBatch, createDb, sql } from "~/db/client.server";
import { privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { assertExactFileRecipientDescriptors, assertFileHeadCommitTransition, verifyDirectFileRecipientEnvelope,
  verifyFileHead } from "~/tree/file-head";
import { exactRecipientGuard, headRow, parseHead, recipients, verified, type Recipient } from "~/tree/file-v2.server";
import { decodeTreeBytes, encodeTreeBytes, isV7 } from "~/tree/wire";
import { digestBytes, hex, inspectOfferEnvelope, parseOffer, verifyOffer } from "./offer";
import { begin, finish, marker, proofTime, spent } from "./sharing.server";

/**
 * Ticket-19 rotation, executed by the Owner's browser one bounded step at a time.
 * Every step is CAS'd on the job's barrier epoch and cursor and is the only write the
 * job's own barrier admits; the last step deletes the job and then the barrier.
 */
const headers = { "Cache-Control": "no-store" };
const json = (value: object, status = 200) => Response.json(value, { status, headers });
const absent = () => json({ error: "not_found" }, 404);
const invalid = () => json({ error: "invalid_rotation_request" }, 400);
const changed = () => json({ error: "rotation_changed" }, 409);
const bytes = (value: ArrayBuffer | Uint8Array) => new Uint8Array(value);
const b64 = (value: ArrayBuffer | Uint8Array) => encodeTreeBytes(bytes(value));
const exact = (value: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
/** One Directory's Grants are re-sealed in one step: bounded Grants and devices per request. */
export const MAX_ROTATION_GRANTS = 32;
const MAX_ROTATION_DEVICES = 256;

export type RotationJob = { owner_id: string; target_node_id: string; kind: "file" | "directory";
  mode: "rekey" | "reprovision"; barrier_epoch: number; cursor: string | null };

async function currentJob(env: Env, auth: AuthorizedDevice, targetId: string): Promise<RotationJob | undefined> {
  return createDb(env.DB).get<RotationJob>(sql`SELECT j.owner_id, j.target_node_id, n.kind, j.mode,
      j.barrier_epoch, j.cursor
    FROM sharing_rotation_jobs j JOIN vault_nodes n ON n.id = j.target_node_id AND n.owner_id = j.owner_id
    WHERE j.owner_id = ${auth.accountId} AND j.target_node_id = ${targetId} AND ${privateReadGuard(auth)}`);
}

/** Same-batch precondition: the job is exactly the one this step was prepared against. */
export function jobGuard(job: RotationJob): SQL {
  return sql`EXISTS (SELECT 1 FROM sharing_rotation_jobs WHERE owner_id = ${job.owner_id}
    AND target_node_id = ${job.target_node_id} AND barrier_epoch = ${job.barrier_epoch}
    AND mode = ${job.mode} AND cursor IS ${job.cursor})`;
}

/** The job, then its barrier: writes beneath the target reopen only once rotation is complete. */
export function finishJob(job: RotationJob, live: SQL): SQL[] {
  return [
    sql`DELETE FROM sharing_rotation_jobs WHERE owner_id = ${job.owner_id}
      AND target_node_id = ${job.target_node_id} AND barrier_epoch = ${job.barrier_epoch} AND ${live}`,
    sql`DELETE FROM rotation_barriers WHERE owner_id = ${job.owner_id}
      AND target_node_id = ${job.target_node_id} AND epoch = ${job.barrier_epoch} AND ${live}
      AND NOT EXISTS (SELECT 1 FROM sharing_rotation_jobs WHERE owner_id = ${job.owner_id}
        AND target_node_id = ${job.target_node_id})`,
  ];
}

/** The Owner's pending jobs; opaque identities and progress only. */
export async function listRotations(env: Env, auth: AuthorizedDevice): Promise<Response> {
  const rows = await createDb(env.DB).all<RotationJob>(sql`SELECT j.owner_id, j.target_node_id, n.kind, j.mode,
      j.barrier_epoch, j.cursor
    FROM sharing_rotation_jobs j JOIN vault_nodes n ON n.id = j.target_node_id AND n.owner_id = j.owner_id
    WHERE j.owner_id = ${auth.accountId} AND ${privateReadGuard(auth)}
    ORDER BY j.target_node_id LIMIT 101`);
  return json({ jobs: rows.slice(0, 100).map((row) => ({ targetId: row.target_node_id, kind: row.kind,
    mode: row.mode, barrierEpoch: row.barrier_epoch })), more: rows.length > 100 });
}

type GrantRow = { id: string; recipient_id: string; generation: number; permission: "read_only" | "read_write";
  offer_bytes: ArrayBuffer; offer_digest: ArrayBuffer; offer_signature: ArrayBuffer };
type GrantDeviceRow = { grant_id: string; device_id: string; registry_epoch: number;
  transport_public_key: ArrayBuffer; label_digest: ArrayBuffer };
export type GrantMaterial = { grants: GrantRow[]; devices: GrantDeviceRow[] };

/**
 * Every current Grant on one Directory with its signed offer, and each recipient device
 * that already holds a current Shared-as label: exactly the devices a re-sealed offer
 * lists. A device without a current label stays a provisioning need (ticket 20).
 */
export async function grantMaterial(env: Env, ownerId: string, directoryId: string): Promise<GrantMaterial> {
  const grants = await createDb(env.DB).all<GrantRow>(sql`SELECT g.id, g.recipient_id, g.generation, g.permission,
      l.offer_bytes, l.offer_digest, l.offer_signature
    FROM grants g JOIN grant_labels l ON l.grant_id = g.id
    WHERE g.owner_id = ${ownerId} AND g.target_node_id = ${directoryId} AND g.target_kind = 'directory'
    ORDER BY g.id LIMIT ${MAX_ROTATION_GRANTS + 1}`);
  const devices = await createDb(env.DB).all<GrantDeviceRow>(sql`SELECT g.id AS grant_id, d.id AS device_id,
      r.registry_epoch, d.transport_public_key, l.digest AS label_digest
    FROM grants g JOIN encryption_devices d ON d.account_id = g.recipient_id AND d.state = 'active'
    JOIN account_encryption_identities r ON r.account_id = g.recipient_id
    JOIN grant_label_deliveries l ON l.grant_id = g.id AND l.device_id = d.id AND l.registry_epoch = r.registry_epoch
    WHERE g.owner_id = ${ownerId} AND g.target_node_id = ${directoryId} AND g.target_kind = 'directory'
    ORDER BY g.id, d.id LIMIT ${MAX_ROTATION_DEVICES + 1}`);
  if (grants.length > MAX_ROTATION_GRANTS || devices.length > MAX_ROTATION_DEVICES) {
    throw new Error("rotation capacity exceeded");
  }
  return { grants, devices };
}

export function grantMaterialWire(material: GrantMaterial) {
  return material.grants.map((grant) => ({ grantId: grant.id, recipientId: grant.recipient_id,
    generation: grant.generation, permission: grant.permission,
    offer: { bytes: b64(grant.offer_bytes), digest: b64(grant.offer_digest), signature: b64(grant.offer_signature) },
    devices: material.devices.filter((device) => device.grant_id === grant.id).map((device) => ({
      deviceId: device.device_id, registryEpoch: device.registry_epoch,
      publicKey: b64(device.transport_public_key), labelDigest: hex(bytes(device.label_digest)) })) }));
}

type GrantSeal = { grantId: string; generation: number; offer: { bytes: Uint8Array; digest: Uint8Array;
  signature: Uint8Array }; envelopes: { deviceId: string; registryEpoch: number; ciphertext: Uint8Array;
  digest: Uint8Array }[]; previousDigest: Uint8Array };

/**
 * Validates one re-sealed capability per current Grant: an Owner-signed offer at the next
 * material revision for this exact Grant, target epoch and permission, listing exactly the
 * label-ready devices with digests of the submitted envelopes. The unchanged fields (share,
 * label, owner copy, original content coordinates) must match the stored offer.
 */
export async function parseGrantSeals(auth: AuthorizedDevice, ownerId: string, directoryId: string,
  epoch: number, material: GrantMaterial, value: unknown): Promise<GrantSeal[]> {
  if (!Array.isArray(value) || value.length !== material.grants.length) throw new Error("invalid Grant seals");
  const seals: GrantSeal[] = [];
  for (const grant of material.grants) {
    const item = value.map(record).find((candidate) => candidate?.grantId === grant.id);
    if (!item || !exact(item, ["grantId", "offer", "envelopes"])) throw new Error("invalid Grant seal");
    const signed = record(item.offer);
    if (!signed || !exact(signed, ["bytes", "digest", "signature"]) || !Array.isArray(item.envelopes)) {
      throw new Error("invalid Grant seal");
    }
    const offerBytes = decodeTreeBytes(signed.bytes, 131_072);
    const offerDigest = decodeTreeBytes(signed.digest, 32);
    const signature = decodeTreeBytes(signed.signature, 64);
    const submitted: unknown[] = item.envelopes;
    const next = await verifyOffer(offerBytes, offerDigest, signature, auth.assertionPublicKey);
    const stored = parseOffer(bytes(grant.offer_bytes));
    const ready = material.devices.filter((device) => device.grant_id === grant.id);
    if (next.shareId !== stored.shareId || next.grantId !== grant.id || next.ownerId !== ownerId ||
        stored.ownerId !== ownerId || next.recipientId !== grant.recipient_id || next.targetId !== directoryId ||
        next.kind !== "directory" || next.labelId !== stored.labelId ||
        next.ownerCopyDigest !== stored.ownerCopyDigest || next.contentRevision !== stored.contentRevision ||
        next.headDigest !== stored.headDigest || next.candidateDigest !== null ||
        next.permission !== grant.permission || next.materialRevision !== stored.materialRevision + 1 ||
        next.targetKeyId !== directoryId || next.targetEpoch !== epoch || next.signerDeviceId !== auth.deviceId ||
        next.devices.length !== ready.length || submitted.length !== ready.length) {
      throw new Error("invalid Grant offer");
    }
    const envelopes = await Promise.all(ready.map(async (device) => {
      const descriptor = next.devices.find((entry) => entry.deviceId === device.device_id);
      const raw = submitted.map(record).find((entry) => entry?.deviceId === device.device_id);
      if (!descriptor || !raw || !exact(raw, ["deviceId", "ciphertext"]) ||
          next.registryEpoch !== device.registry_epoch || descriptor.registryEpoch !== device.registry_epoch ||
          descriptor.publicKeyDigest !== hex(await digestBytes(bytes(device.transport_public_key))) ||
          descriptor.labelDigest !== hex(bytes(device.label_digest))) throw new Error("invalid Grant device");
      const ciphertext = decodeTreeBytes(raw.ciphertext, 16_384);
      const digest = await digestBytes(ciphertext);
      if (descriptor.contentDigest !== hex(digest)) throw new Error("invalid Grant envelope");
      inspectOfferEnvelope(ciphertext, { purpose: "grant", vaultId: ownerId, objectId: directoryId,
        keyId: directoryId, keyEpoch: epoch, revision: 1, recipientId: device.device_id });
      return { deviceId: device.device_id, registryEpoch: device.registry_epoch, ciphertext, digest };
    }));
    seals.push({ grantId: grant.id, generation: grant.generation, previousDigest: bytes(grant.offer_digest),
      offer: { bytes: offerBytes, digest: offerDigest, signature }, envelopes });
  }
  return seals;
}

/**
 * Same-batch guard and writes for re-sealed Directory Grants. The Grant set, generations and
 * stored offers are CAS'd; the capability epoch must already be current when the envelope
 * insert trigger runs, so a rekey advances it earlier in the same batch.
 */
export function grantSealGuard(ownerId: string, directoryId: string, seals: readonly GrantSeal[]): SQL {
  const expected = JSON.stringify(seals.map((seal) => ({ id: seal.grantId, generation: seal.generation,
    digest: hex(seal.previousDigest) })));
  return sql`(SELECT COUNT(*) FROM grants g WHERE g.owner_id = ${ownerId} AND g.target_node_id = ${directoryId}
      AND g.target_kind = 'directory') = ${seals.length}
    AND NOT EXISTS (SELECT 1 FROM json_each(${expected}) e WHERE NOT EXISTS (SELECT 1 FROM grants g
      JOIN grant_labels l ON l.grant_id = g.id
      WHERE g.id = json_extract(e.value, '$.id') AND g.owner_id = ${ownerId}
        AND g.target_node_id = ${directoryId} AND g.generation = json_extract(e.value, '$.generation')
        AND hex(l.offer_digest) = upper(json_extract(e.value, '$.digest'))))`;
}

export function grantSealStatements(auth: AuthorizedDevice, directoryId: string, epoch: number,
  seals: readonly GrantSeal[], live: SQL): SQL[] {
  if (!seals.length) return [];
  const ids = JSON.stringify(seals.map((seal) => seal.grantId));
  const envelopes = JSON.stringify(seals.flatMap((seal) => seal.envelopes.map((envelope) => ({
    grantId: seal.grantId, generation: seal.generation, deviceId: envelope.deviceId,
    registryEpoch: envelope.registryEpoch, ciphertext: hex(envelope.ciphertext), digest: hex(envelope.digest) }))));
  const offers = JSON.stringify(seals.map((seal) => ({ grantId: seal.grantId, bytes: hex(seal.offer.bytes),
    digest: hex(seal.offer.digest), signature: hex(seal.offer.signature) })));
  const offer = (field: string) => sql`unhex((SELECT json_extract(o.value, ${`$.${field}`})
    FROM json_each(${offers}) o WHERE json_extract(o.value, '$.grantId') = grant_labels.grant_id))`;
  return [
    sql`DELETE FROM grant_device_envelopes WHERE grant_id IN (SELECT value FROM json_each(${ids})) AND ${live}`,
    sql`INSERT INTO grant_device_envelopes (grant_id, device_id, generation, registry_epoch, target_key_id,
        target_epoch, ciphertext, digest)
      SELECT json_extract(value, '$.grantId'), json_extract(value, '$.deviceId'), json_extract(value, '$.generation'),
        json_extract(value, '$.registryEpoch'), ${directoryId}, ${epoch}, unhex(json_extract(value, '$.ciphertext')),
        unhex(json_extract(value, '$.digest')) FROM json_each(${envelopes}) WHERE ${live}`,
    sql`UPDATE grant_labels SET offer_bytes = ${offer("bytes")}, offer_digest = ${offer("digest")},
        offer_signature = ${offer("signature")}, signer_device_id = ${auth.deviceId}
      WHERE grant_id IN (SELECT value FROM json_each(${ids})) AND ${live}`,
    sql`DELETE FROM provisioning_needs WHERE ${live} AND EXISTS (SELECT 1 FROM json_each(${envelopes}) e
      WHERE json_extract(e.value, '$.grantId') = provisioning_needs.grant_id
        AND json_extract(e.value, '$.deviceId') = provisioning_needs.device_id)`,
  ];
}

/** What the Owner's browser must do next for one job. */
export async function nextRotationStep(env: Env, auth: AuthorizedDevice, targetId: string): Promise<Response> {
  const job = await currentJob(env, auth, targetId);
  if (!job) return absent();
  const common = { targetId, mode: job.mode, barrierEpoch: job.barrier_epoch, cursor: job.cursor };
  try {
    if (job.kind === "file") {
      return json({ ...common, step: "file", fileId: targetId,
        recipients: await recipients(env, job.owner_id, targetId) });
    }
    if (job.mode === "reprovision") {
      const epoch = await directoryEpoch(env, job.owner_id, targetId);
      return json({ ...common, step: "grants", directoryId: targetId, epoch,
        grants: grantMaterialWire(await grantMaterial(env, job.owner_id, targetId)) });
    }
    return json({ ...common, step: "unsupported" }, 501);
  } catch { return invalid(); }
}

async function directoryEpoch(env: Env, ownerId: string, directoryId: string): Promise<number> {
  const row = await createDb(env.DB).get<{ capability_epoch: number }>(sql`SELECT capability_epoch FROM directories
    WHERE node_id = ${directoryId} AND owner_id = ${ownerId}`);
  if (!row) throw new Error("missing Directory");
  return row.capability_epoch;
}

/** A Directory permission change: current capability re-sealed at the new Grant generation. */
export async function resealDirectoryGrants(env: Env, auth: AuthorizedDevice, targetId: string,
  value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["barrierEpoch", "epoch", "grants"]) || !Number.isSafeInteger(input.barrierEpoch) ||
      !Number.isSafeInteger(input.epoch)) return invalid();
  const job = await currentJob(env, auth, targetId);
  if (!job || job.kind !== "directory" || job.mode !== "reprovision") return absent();
  if (job.barrier_epoch !== input.barrierEpoch) return changed();
  let seals: GrantSeal[];
  try {
    const epoch = await directoryEpoch(env, job.owner_id, targetId);
    if (epoch !== input.epoch) return changed();
    seals = await parseGrantSeals(auth, job.owner_id, targetId, epoch,
      await grantMaterial(env, job.owner_id, targetId), input.grants);
  } catch { return invalid(); }
  const epoch = input.epoch as number;
  const invocationId = crypto.randomUUID(), live = marker(auth, invocationId);
  try {
    const [witness] = await atomicSqlBatch(env.DB, [
      begin(auth, invocationId, sql`${jobGuard(job)} AND ${grantSealGuard(job.owner_id, targetId, seals)}
        AND EXISTS (SELECT 1 FROM directories WHERE node_id = ${targetId} AND owner_id = ${job.owner_id}
          AND capability_epoch = ${epoch})`),
      ...grantSealStatements(auth, targetId, epoch, seals, live),
      ...finishJob(job, live),
      spent(auth, invocationId), proofTime(auth, invocationId), finish(auth, invocationId),
    ]);
    return witness?.meta.changes === 1 ? json({ status: "complete" }) : changed();
  } catch { return invalid(); }
}

/**
 * A direct File Grant change: a same-revision recipient-set update for the live direct
 * recipients (new generations, removed devices dropped) with fresh envelopes of the current
 * File key, plus a new Private thread epoch when a recipient was removed (`rekey`).
 */
export async function rotateFileTarget(env: Env, auth: AuthorizedDevice, fileId: string,
  value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["barrierEpoch", "expectedHeadDigest", "signedHead", "recipientEnvelopes", "thread"]) ||
      !Number.isSafeInteger(input.barrierEpoch) || !Array.isArray(input.recipientEnvelopes) ||
      input.recipientEnvelopes.length > 256) return invalid();
  const job = await currentJob(env, auth, fileId);
  if (!job || job.kind !== "file") return absent();
  if (job.barrier_epoch !== input.barrierEpoch) return changed();
  const ownerId = job.owner_id;
  const current = await headRow(env, auth, ownerId, fileId);
  if (!current) return absent();
  let expectedDigest: Uint8Array, expected: Recipient[], thread: ThreadRotation | "unchanged";
  let signed: ReturnType<typeof parseHead>, recipientSetVersion: number;
  let delivery: { accountId: string; deviceId: string; registryEpoch: number; ciphertext: string; digest: string }[];
  try {
    expectedDigest = decodeTreeBytes(input.expectedHeadDigest, 32);
    if (hex(expectedDigest) !== hex(bytes(current.digest))) return changed();
    signed = parseHead(input.signedHead);
    const before = await verified(current);
    const next = await verifyFileHead(signed, { ownerId, vaultId: ownerId, fileId, revision: current.revision,
      signerDeviceId: auth.deviceId, publicKey: auth.assertionPublicKey });
    assertFileHeadCommitTransition(before, next, { expectedSameRevisionTransition: "recipient-set-update" });
    recipientSetVersion = next.statement.recipientSetVersion;
    if (recipientSetVersion !== current.recipient_set_version + 1) return invalid();
    expected = await recipients(env, ownerId, fileId);
    assertExactFileRecipientDescriptors(next, await Promise.all(expected.map(async (item) => ({
      accountId: item.accountId, deviceId: item.deviceId, registryEpoch: item.registryEpoch, grants: item.grants,
      publicKeyDigest: await digestBytes(decodeTreeBytes(item.publicKey, 65)) }))));
    const submitted = input.recipientEnvelopes.map((item: unknown) => {
      const entry = record(item);
      if (!entry || !exact(entry, ["deviceId", "ciphertext"]) || !isV7(entry.deviceId)) throw new Error("invalid envelope");
      return { deviceId: entry.deviceId, ciphertext: decodeTreeBytes(entry.ciphertext, 16_384) };
    });
    if (submitted.length !== expected.length ||
        new Set(submitted.map((item) => item.deviceId)).size !== submitted.length) return invalid();
    delivery = await Promise.all(expected.map(async (item) => {
      const sealed = submitted.find((entry) => entry.deviceId === item.deviceId);
      if (!sealed) throw new Error("missing envelope");
      await verifyDirectFileRecipientEnvelope(next, item.accountId, item.deviceId,
        decodeTreeBytes(item.publicKey, 65), sealed.ciphertext);
      return { accountId: item.accountId, deviceId: item.deviceId, registryEpoch: item.registryEpoch,
        ciphertext: hex(sealed.ciphertext), digest: hex(await digestBytes(sealed.ciphertext)) };
    }));
    if (job.mode === "rekey") {
      // Same receiving pair (a direct reader never held it); only the thread key is replaced.
      thread = await parseThreadRotation(env, ownerId, fileId, input.thread,
        { keyId: current.receiving_key_id, epoch: current.receiving_epoch });
    } else {
      if (input.thread !== null) return invalid();
      thread = "unchanged";
    }
  } catch (error) { return error instanceof ThreadRotationChangedError ? changed() : invalid(); }
  const payload = JSON.stringify(delivery);
  const invocationId = crypto.randomUUID(), live = marker(auth, invocationId), now = Date.now();
  try {
    const [witness] = await atomicSqlBatch(env.DB, [
      begin(auth, invocationId, sql`${jobGuard(job)} AND ${exactRecipientGuard(ownerId, fileId, expected)}
        AND EXISTS (SELECT 1 FROM file_heads WHERE file_node_id = ${fileId} AND owner_id = ${ownerId}
          AND digest = ${expectedDigest})
        AND ${thread === "unchanged" ? sql`1 = 1` : threadRotationGuard(ownerId, fileId, thread)}`),
      sql`UPDATE file_heads SET bytes = ${signed.bytes}, digest = ${signed.digest}, signature = ${signed.signature},
          signer_device_id = ${auth.deviceId}, recipient_set_version = ${recipientSetVersion}
        WHERE file_node_id = ${fileId} AND owner_id = ${ownerId} AND digest = ${expectedDigest} AND ${live}`,
      sql`DELETE FROM file_device_envelopes WHERE file_node_id = ${fileId} AND owner_id = ${ownerId} AND ${live}`,
      sql`INSERT INTO file_device_envelopes (file_node_id, owner_id, recipient_id, device_id, revision,
          content_key_id, content_epoch, registry_epoch, ciphertext, digest)
        SELECT ${fileId}, ${ownerId}, json_extract(value, '$.accountId'), json_extract(value, '$.deviceId'),
          ${current.revision}, ${current.content_key_id}, ${current.content_epoch},
          json_extract(value, '$.registryEpoch'), unhex(json_extract(value, '$.ciphertext')),
          unhex(json_extract(value, '$.digest')) FROM json_each(${payload}) WHERE ${live}`,
      ...(thread === "unchanged" ? [] : await threadRotationStatements(thread, now, live)),
      ...finishJob(job, live),
      spent(auth, invocationId), proofTime(auth, invocationId), finish(auth, invocationId),
    ]);
    return witness?.meta.changes === 1 ? json({ status: "complete" }) : changed();
  } catch { return invalid(); }
}
