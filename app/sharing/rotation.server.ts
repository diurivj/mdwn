import type { SQL } from "drizzle-orm";
import { record } from "~/auth/request.server";
import { parseThreadRotation, ThreadRotationChangedError, threadRotationGuard, threadRotationStatements,
  type ThreadRotation } from "~/comments/comments.server";
import { atomicSqlBatch, createDb, sql } from "~/db/client.server";
import { privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { assertExactFileRecipientDescriptors, assertFileHeadCommitTransition, verifyDirectFileRecipientEnvelope,
  verifyFileHead } from "~/tree/file-head";
import { exactRecipientGuard, headRow, parseHead, recipients, verified, type Recipient } from "~/tree/file-v2.server";
import type { ListingVersion } from "~/tree/listing";
import { signedListing } from "~/tree/listing.server";
import { parseReceivingRotation, RECEIVING_ROTATION_FIELDS, ReceivingRotationError, receivingRotationGuard,
  receivingRotationStatements, verifyReceivingRotation } from "~/tree/receiving-rotation.server";
import { listingUpdate } from "~/tree/structure.server";
import { decodeTreeBytes, encodeTreeBytes, isV7, treeEnvelope } from "~/tree/wire";
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
    const node = await nextRekeyNode(env, job);
    if (!node) return json({ ...common, step: "finish" });
    const progress = { done: node.total - node.remaining, total: node.total };
    if (node.kind === "directory") {
      return json({ ...common, step: "directory", directoryId: node.id, parentId: node.parent_node_id,
        stepKey: node.step_key, epoch: await directoryEpoch(env, job.owner_id, node.id), progress,
        grants: grantMaterialWire(await grantMaterial(env, job.owner_id, node.id)) });
    }
    return json({ ...common, step: "receiving", fileId: node.id, parentId: node.parent_node_id,
      stepKey: node.step_key, progress });
  } catch { return invalid(); }
}

type RekeyNode = { id: string; kind: "directory" | "file"; parent_node_id: string; step_key: string;
  total: number; remaining: number };

/**
 * The frozen subtree's rekey order: every Directory, then (a level deeper) every receiving
 * File, as `depth:id`. A parent always precedes its children, so a new key is only ever
 * wrapped under an already rotated one. The cursor is the last completed step.
 */
async function nextRekeyNode(env: Env, job: RotationJob): Promise<RekeyNode | undefined> {
  return createDb(env.DB).get<RekeyNode>(sql`WITH RECURSIVE subtree(id, kind, parent_node_id, depth) AS (
      SELECT id, kind, parent_node_id, 0 FROM vault_nodes WHERE id = ${job.target_node_id} AND owner_id = ${job.owner_id}
      UNION ALL
      SELECT n.id, n.kind, n.parent_node_id, s.depth + 1 FROM subtree s JOIN vault_nodes n ON n.parent_node_id = s.id
        WHERE n.owner_id = ${job.owner_id} AND s.kind = 'directory' AND s.depth < 100
    ), steps AS (
      SELECT s.id, s.kind, s.parent_node_id, printf('%03d:%s', s.depth, s.id) AS step_key FROM subtree s
      LEFT JOIN directory_entries e ON e.child_node_id = s.id AND e.owner_id = ${job.owner_id}
      WHERE s.kind = 'directory' OR e.encoding = 'receiving-file'
    )
    SELECT id, kind, parent_node_id, step_key, (SELECT count(*) FROM steps) AS total,
      (SELECT count(*) FROM steps WHERE step_key > ${job.cursor ?? ""}) AS remaining
    FROM steps WHERE step_key > ${job.cursor ?? ""} ORDER BY step_key LIMIT 1`);
}

function advanceCursor(job: RotationJob, stepKey: string, now: number, live: SQL): SQL {
  return sql`UPDATE sharing_rotation_jobs SET cursor = ${stepKey}, updated_at = ${now}
    WHERE owner_id = ${job.owner_id} AND target_node_id = ${job.target_node_id}
      AND barrier_epoch = ${job.barrier_epoch} AND cursor IS ${job.cursor} AND ${live}`;
}

type DirectoryRow = { entries_revision: number; listing_version: ListingVersion; capability_epoch: number };
async function directoryRow(env: Env, ownerId: string, directoryId: string): Promise<DirectoryRow | undefined> {
  return createDb(env.DB).get<DirectoryRow>(sql`SELECT entries_revision, listing_version, capability_epoch
    FROM directories WHERE node_id = ${directoryId} AND owner_id = ${ownerId}`);
}

type EntryRow = { child_node_id: string; encoding: "directory" | "legacy-file" | "receiving-file";
  receiving_key_id: string | null; receiving_epoch: number | null; wrap_revision: number | null;
  child_epoch: number | null; content_key_id: string | null; key_epoch: number | null; current_revision: number | null };

/**
 * One Directory of a subtree rekey, in one batch: a fresh capability at epoch + 1 wrapped in its
 * parent's entry (parent listing re-signed), every entry re-sealed under it (names and orders at
 * the new epoch; child, legacy-File and receiving wrappers re-wrapped with unchanged contexts),
 * its own listing re-signed at the new epoch, and every Grant on it re-sealed under a re-signed offer.
 */
export async function rekeyDirectory(env: Env, auth: AuthorizedDevice, targetId: string,
  value: unknown): Promise<Response> {
  const input = record(value), parent = record(input?.parent), directory = record(input?.directory);
  if (!input || !exact(input, ["barrierEpoch", "stepKey", "directoryId", "epoch", "parent", "directory", "grants"]) ||
      !parent || !exact(parent, ["expectedRevision", "keyEnvelope", "listingHead"]) ||
      !directory || !exact(directory, ["expectedRevision", "entries", "listingHead"]) ||
      !Number.isSafeInteger(input.barrierEpoch) || typeof input.stepKey !== "string" || !isV7(input.directoryId) ||
      !Number.isSafeInteger(input.epoch) || !Number.isSafeInteger(parent.expectedRevision) ||
      !Number.isSafeInteger(directory.expectedRevision) || !Array.isArray(directory.entries)) return invalid();
  const job = await currentJob(env, auth, targetId);
  if (!job || job.kind !== "directory" || job.mode !== "rekey") return absent();
  if (job.barrier_epoch !== input.barrierEpoch) return changed();
  const node = await nextRekeyNode(env, job);
  if (!node || node.kind !== "directory" || node.id !== input.directoryId || node.step_key !== input.stepKey) {
    return changed();
  }
  const ownerId = job.owner_id, directoryId = node.id, parentId = node.parent_node_id, epoch = input.epoch as number;
  const [own, above] = await Promise.all([directoryRow(env, ownerId, directoryId), directoryRow(env, ownerId, parentId)]);
  if (!own || !above) return absent();
  if (own.capability_epoch + 1 !== epoch || own.entries_revision !== directory.expectedRevision ||
      above.entries_revision !== parent.expectedRevision) return changed();
  const rows = await createDb(env.DB).all<EntryRow>(sql`SELECT e.child_node_id, e.encoding, e.receiving_key_id,
      e.receiving_epoch, e.wrap_revision, child.capability_epoch AS child_epoch, r.content_key_id, r.key_epoch,
      f.current_revision
    FROM directory_entries e LEFT JOIN directories child ON child.node_id = e.child_node_id AND child.owner_id = e.owner_id
    LEFT JOIN files f ON f.node_id = e.child_node_id AND f.owner_id = e.owner_id
    LEFT JOIN file_representations r ON r.id = f.current_representation_id AND r.file_node_id = f.node_id
      AND r.owner_id = f.owner_id AND r.revision = f.current_revision
    WHERE e.parent_node_id = ${directoryId} AND e.owner_id = ${ownerId} ORDER BY e.child_node_id`);
  let wrapper: Uint8Array, parentHead: Awaited<ReturnType<typeof signedListing>>;
  let ownHead: Awaited<ReturnType<typeof signedListing>>, seals: GrantSeal[], payload: string;
  try {
    wrapper = treeEnvelope(parent.keyEnvelope, 1024, { purpose: "directory-capability", vaultId: ownerId,
      objectId: directoryId, keyId: directoryId, keyEpoch: epoch, revision: 1 });
    parentHead = await signedListing(parent.listingHead, auth, { directoryId: parentId,
      expectedRevision: above.entries_revision, ownerId, version: above.listing_version, epoch: above.capability_epoch });
    const submitted: unknown[] = directory.entries;
    if (submitted.length !== rows.length) return invalid();
    const entries = rows.map((row) => {
      const item = submitted.map(record).find((candidate) => candidate?.nodeId === row.child_node_id);
      if (!item || !exact(item, ["nodeId", "nameCiphertext", "orderCiphertext", "keyEnvelope"])) {
        throw new Error("invalid entry");
      }
      const metadata = { purpose: "directory-metadata" as const, vaultId: ownerId, objectId: row.child_node_id,
        keyId: directoryId, keyEpoch: epoch, revision: 1 };
      const keyEnvelope = row.encoding === "directory"
        ? treeEnvelope(item.keyEnvelope, 1024, { purpose: "directory-capability", vaultId: ownerId,
          objectId: row.child_node_id, keyId: row.child_node_id, keyEpoch: row.child_epoch!, revision: 1 })
        : row.encoding === "legacy-file"
          ? treeEnvelope(item.keyEnvelope, 16_384, { purpose: "file-content-key", vaultId: ownerId,
            objectId: row.child_node_id, keyId: row.content_key_id!, keyEpoch: row.key_epoch!,
            revision: row.current_revision! })
          : treeEnvelope(item.keyEnvelope, 16_384, { purpose: "file-receiving-key", vaultId: ownerId,
            objectId: row.child_node_id, keyId: row.receiving_key_id!, keyEpoch: row.receiving_epoch!,
            revision: row.wrap_revision! });
      return { nodeId: row.child_node_id, name: hex(treeEnvelope(item.nameCiphertext, 4096, metadata)),
        order: hex(treeEnvelope(item.orderCiphertext, 4096, metadata)), keyEnvelope: hex(keyEnvelope) };
    });
    payload = JSON.stringify(entries);
    ownHead = await signedListing(directory.listingHead, auth, { directoryId, expectedRevision: own.entries_revision,
      ownerId, version: own.listing_version, epoch });
    seals = await parseGrantSeals(auth, ownerId, directoryId, epoch, await grantMaterial(env, ownerId, directoryId),
      input.grants);
  } catch { return invalid(); }
  const field = (name: string) => sql`unhex((SELECT json_extract(e.value, ${`$.${name}`}) FROM json_each(${payload}) e
    WHERE json_extract(e.value, '$.nodeId') = directory_entries.child_node_id))`;
  const now = Date.now(), invocationId = crypto.randomUUID(), live = marker(auth, invocationId);
  try {
    const [witness] = await atomicSqlBatch(env.DB, [
      begin(auth, invocationId, sql`${jobGuard(job)} AND ${grantSealGuard(ownerId, directoryId, seals)}
        AND EXISTS (SELECT 1 FROM directories WHERE node_id = ${directoryId} AND owner_id = ${ownerId}
          AND capability_epoch = ${epoch - 1} AND entries_revision = ${own.entries_revision})
        AND EXISTS (SELECT 1 FROM directories WHERE node_id = ${parentId} AND owner_id = ${ownerId}
          AND entries_revision = ${above.entries_revision} AND capability_epoch = ${above.capability_epoch})`),
      listingUpdate(auth, ownerId, parentId, above.entries_revision, parentHead, above.listing_version,
        above.listing_version, live),
      sql`UPDATE directory_entries SET key_envelope = ${wrapper} WHERE child_node_id = ${directoryId}
        AND parent_node_id = ${parentId} AND owner_id = ${ownerId} AND ${live}`,
      sql`UPDATE directories SET capability_epoch = ${epoch} WHERE node_id = ${directoryId} AND owner_id = ${ownerId}
        AND capability_epoch = ${epoch - 1} AND ${live}`,
      sql`UPDATE directory_entries SET name_ciphertext = ${field("name")}, order_ciphertext = ${field("order")},
          key_envelope = ${field("keyEnvelope")}
        WHERE parent_node_id = ${directoryId} AND owner_id = ${ownerId} AND ${live}`,
      listingUpdate(auth, ownerId, directoryId, own.entries_revision, ownHead, own.listing_version,
        own.listing_version, live),
      ...grantSealStatements(auth, directoryId, epoch, seals, live),
      advanceCursor(job, node.step_key, now, live),
      spent(auth, invocationId), proofTime(auth, invocationId), finish(auth, invocationId),
    ]);
    return witness?.meta.changes === 1 ? json({ status: "advanced" }) : changed();
  } catch { return invalid(); }
}

/**
 * One receiving File of a subtree rekey: its parent was already rotated, so the File gets a
 * fresh receiving pair wrapped under the new parent capability, a same-revision
 * `receiving-rotation` head and a new thread epoch, exactly as a move rotates it.
 */
export async function rekeyReceivingFile(env: Env, auth: AuthorizedDevice, targetId: string,
  value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, [...RECEIVING_ROTATION_FIELDS, "barrierEpoch", "stepKey", "fileId",
    "expectedRevision", "keyEnvelope", "listingHead"]) || !Number.isSafeInteger(input.barrierEpoch) ||
      typeof input.stepKey !== "string" || !isV7(input.fileId) || !Number.isSafeInteger(input.expectedRevision)) {
    return invalid();
  }
  const job = await currentJob(env, auth, targetId);
  if (!job || job.kind !== "directory" || job.mode !== "rekey") return absent();
  if (job.barrier_epoch !== input.barrierEpoch) return changed();
  const node = await nextRekeyNode(env, job);
  if (!node || node.kind !== "file" || node.id !== input.fileId || node.step_key !== input.stepKey) return changed();
  const ownerId = job.owner_id, fileId = node.id, parentId = node.parent_node_id;
  const parent = await directoryRow(env, ownerId, parentId);
  const entry = await createDb(env.DB).get<{ receiving_key_id: string; receiving_epoch: number; wrap_revision: number }>(sql`
    SELECT receiving_key_id, receiving_epoch, wrap_revision FROM directory_entries
    WHERE child_node_id = ${fileId} AND parent_node_id = ${parentId} AND owner_id = ${ownerId}
      AND encoding = 'receiving-file'`);
  if (!parent || !entry) return absent();
  if (parent.entries_revision !== input.expectedRevision || parent.listing_version !== 2) return changed();
  let rotation: ReturnType<typeof parseReceivingRotation>, head: Awaited<ReturnType<typeof signedListing>>;
  try {
    rotation = parseReceivingRotation(input, ownerId, fileId, entry);
    head = await signedListing(input.listingHead, auth, { directoryId: parentId,
      expectedRevision: parent.entries_revision, ownerId, version: 2, epoch: parent.capability_epoch });
    rotation = await verifyReceivingRotation(env, auth, ownerId, fileId, entry, rotation);
  } catch (error) {
    return error instanceof ReceivingRotationError && error.code === "changed" ? changed() : invalid();
  }
  const now = Date.now(), invocationId = crypto.randomUUID(), live = marker(auth, invocationId);
  try {
    const [witness] = await atomicSqlBatch(env.DB, [
      begin(auth, invocationId, sql`${jobGuard(job)} AND ${receivingRotationGuard(ownerId, fileId, entry, rotation)}
        AND EXISTS (SELECT 1 FROM directories WHERE node_id = ${parentId} AND owner_id = ${ownerId}
          AND entries_revision = ${parent.entries_revision} AND capability_epoch = ${parent.capability_epoch})`),
      listingUpdate(auth, ownerId, parentId, parent.entries_revision, head, 2, 2, live),
      sql`UPDATE directory_entries SET key_envelope = ${rotation.keyEnvelope},
          receiving_key_id = ${rotation.receivingKeyId}, receiving_epoch = ${rotation.receivingEpoch},
          wrap_revision = ${rotation.wrapRevision}
        WHERE child_node_id = ${fileId} AND parent_node_id = ${parentId} AND owner_id = ${ownerId}
          AND receiving_key_id = ${entry.receiving_key_id} AND ${live}`,
      ...await receivingRotationStatements(auth, ownerId, fileId, rotation, now, live),
      advanceCursor(job, node.step_key, now, live),
      spent(auth, invocationId), proofTime(auth, invocationId), finish(auth, invocationId),
    ]);
    return witness?.meta.changes === 1 ? json({ status: "advanced" }) : changed();
  } catch { return invalid(); }
}

/** The last step: nothing is left after the cursor, so the job and then its barrier go. */
export async function finishRekey(env: Env, auth: AuthorizedDevice, targetId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["barrierEpoch"]) || !Number.isSafeInteger(input.barrierEpoch)) return invalid();
  const job = await currentJob(env, auth, targetId);
  if (!job || job.kind !== "directory" || job.mode !== "rekey") return absent();
  if (job.barrier_epoch !== input.barrierEpoch || await nextRekeyNode(env, job)) return changed();
  const invocationId = crypto.randomUUID(), live = marker(auth, invocationId);
  try {
    const [witness] = await atomicSqlBatch(env.DB, [
      begin(auth, invocationId, jobGuard(job)),
      ...finishJob(job, live),
      spent(auth, invocationId), proofTime(auth, invocationId), finish(auth, invocationId),
    ]);
    return witness?.meta.changes === 1 ? json({ status: "complete" }) : changed();
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
