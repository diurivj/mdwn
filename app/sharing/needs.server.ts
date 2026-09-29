import type { SQL } from "drizzle-orm";
import { record } from "~/auth/request.server";
import { atomicSqlBatch, createDb, sql } from "~/db/client.server";
import { privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { assertExactFileRecipientDescriptors, assertFileHeadCommitTransition,
  verifyDirectFileRecipientEnvelope, verifyFileHead } from "~/tree/file-head";
import { exactRecipientGuard, headRow, parseHead, recipients, unblocked, verified,
  type Recipient } from "~/tree/file-v2.server";
import { decodeTreeBytes, encodeTreeBytes, isV7 } from "~/tree/wire";
import { directoryAccessGuard } from "./access.server";
import { digestBytes, hex, inspectOfferEnvelope, parseOffer, verifyOffer } from "./offer";
import { begin, finish, marker, proofTime, spent } from "./sharing.server";

/**
 * Ticket 20 fulfillment, executed by the Owner's browser one bounded step at a time.
 * A `provisioning_needs` row is an opaque (grant, device) work item: no name, plaintext,
 * digest or capability. The Owner's browser re-seals the current-epoch Shared-as label,
 * capability/File envelope and re-signed offer for every active device of every affected
 * Grant, then the fulfilled rows are deleted. The needs rows themselves are the cursor:
 * an interrupted run resumes by asking for the target again.
 */
const headers = { "Cache-Control": "no-store" };
const json = (value: object, status = 200) => Response.json(value, { status, headers });
const absent = () => json({ error: "not_found" }, 404);
const invalid = () => json({ error: "invalid_provisioning_request" }, 400);
const changed = () => json({ error: "provisioning_changed" }, 409);
const bytes = (value: ArrayBuffer | Uint8Array) => new Uint8Array(value);
const b64 = (value: ArrayBuffer | Uint8Array) => encodeTreeBytes(bytes(value));
const exact = (value: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));

export const MAX_NEED_ROWS = 256;
export const MAX_FULFILL_GRANTS = 32;
export const MAX_FULFILL_DEVICES = 256;

/** A need is satisfied only when the current-epoch Shared-as label AND current capability /
 * File envelope both exist; a File Grant is not ready without its label. */
const satisfied = sql`(CASE WHEN g.target_kind = 'directory' THEN (
    EXISTS (SELECT 1 FROM grant_label_deliveries l WHERE l.grant_id = g.id AND l.device_id = d.id
      AND l.registry_epoch = r.registry_epoch)
    AND EXISTS (SELECT 1 FROM grant_device_envelopes c JOIN directories dir ON dir.node_id = g.target_node_id
        AND dir.owner_id = g.owner_id
      WHERE c.grant_id = g.id AND c.device_id = d.id AND c.generation = g.generation
        AND c.registry_epoch = r.registry_epoch AND c.target_key_id = dir.node_id
        AND c.target_epoch = dir.capability_epoch))
  ELSE (
    EXISTS (SELECT 1 FROM grant_label_deliveries l WHERE l.grant_id = g.id AND l.device_id = d.id
      AND l.registry_epoch = r.registry_epoch)
    AND EXISTS (SELECT 1 FROM file_device_envelopes c
      JOIN file_heads h ON h.file_node_id = c.file_node_id AND h.owner_id = c.owner_id
      JOIN files f ON f.node_id = c.file_node_id AND f.owner_id = c.owner_id
      WHERE c.file_node_id = g.target_node_id AND c.owner_id = g.owner_id
        AND c.recipient_id = g.recipient_id AND c.device_id = d.id AND c.registry_epoch = r.registry_epoch
        AND c.revision = h.revision AND c.content_key_id = h.content_key_id AND c.content_epoch = h.content_epoch
        AND f.current_revision = h.revision))
  END)`;

/**
 * Record an opaque need for every active recipient device of every affected Grant whose
 * current-epoch label/capability material is missing. Inserted only when `gate` holds, so a
 * rejected enrollment/removal batch records nothing. One call is capped at 256 rows; the
 * Owner's list route re-runs it, so a large Account converges over several visits.
 */
export function reconcileNeedStatements(scope: { ownerId: string } | { recipientId: string },
  now: number, gate: SQL): SQL {
  const filter = "ownerId" in scope ? sql`g.owner_id = ${scope.ownerId}` : sql`g.recipient_id = ${scope.recipientId}`;
  return sql`INSERT INTO provisioning_needs (grant_id, owner_id, recipient_id, device_id, generation,
      registry_epoch, created_at, updated_at)
    SELECT g.id, g.owner_id, g.recipient_id, d.id, g.generation, r.registry_epoch, ${now}, ${now}
    FROM grants g JOIN encryption_devices d ON d.account_id = g.recipient_id AND d.state = 'active'
    JOIN account_encryption_identities r ON r.account_id = g.recipient_id
    WHERE ${filter} AND ${gate} AND NOT ${satisfied}
    ORDER BY g.id, d.id LIMIT ${MAX_NEED_ROWS}
    ON CONFLICT(grant_id, device_id) DO UPDATE SET generation = excluded.generation,
      registry_epoch = excluded.registry_epoch, updated_at = excluded.updated_at`;
}

/** The Owner's outstanding work, one stable page of opaque targets. Rotation-owned targets
 * are skipped: their barrier drains first, then any still-unsatisfied label becomes a need. */
export async function listProvisioning(env: Env, auth: AuthorizedDevice, value?: unknown): Promise<Response> {
  const input = value === undefined ? {} : record(value);
  if (!input || Object.keys(input).some((key) => key !== "cursor") ||
      (input.cursor !== undefined && !isV7(input.cursor))) return invalid();
  const cursor = (input.cursor as string | undefined) ?? "";
  try {
    await atomicSqlBatch(env.DB, [reconcileNeedStatements({ ownerId: auth.accountId }, Date.now(), sql`1 = 1`)]);
    const rows = await createDb(env.DB).all<{ target_id: string; kind: "file" | "directory";
      needs: number; devices: number }>(sql`SELECT g.target_node_id AS target_id, n.kind,
        COUNT(*) AS needs, COUNT(DISTINCT p.device_id) AS devices
      FROM provisioning_needs p JOIN grants g ON g.id = p.grant_id
      JOIN vault_nodes n ON n.id = g.target_node_id AND n.owner_id = p.owner_id
      WHERE p.owner_id = ${auth.accountId} AND g.target_node_id > ${cursor}
        AND NOT EXISTS (SELECT 1 FROM rotation_barriers b WHERE b.owner_id = p.owner_id
          AND b.target_node_id = g.target_node_id)
      GROUP BY g.target_node_id, n.kind ORDER BY g.target_node_id LIMIT 101`);
    const page = rows.slice(0, 100);
    return json({ targets: page.map((row) => ({ targetId: row.target_id, kind: row.kind,
      needs: row.needs, devices: row.devices })), nextCursor: rows.length > 100 ? page.at(-1)!.target_id : null });
  } catch { return invalid(); }
}

type GrantRow = { id: string; recipient_id: string; generation: number; permission: "read_only" | "read_write";
  label_id: string; owner_copy: ArrayBuffer; offer_bytes: ArrayBuffer; offer_digest: ArrayBuffer;
  offer_signature: ArrayBuffer };
type DeviceRow = { grant_id: string; device_id: string; registry_epoch: number;
  transport_public_key: ArrayBuffer; label_digest: ArrayBuffer | null };
export type GrantFulfillMaterial = { grants: GrantRow[]; devices: DeviceRow[] };

/** The current Grants on one target with outstanding needs, and each recipient's active
 * devices with their current-epoch label digest (null when it must be re-sealed).
 * >256 active devices on one Grant is not fulfilled in one step: that Grant is skipped so it
 * never starves the other Grants on the target, and its needs stay for a later pass. */
export async function grantFulfillMaterial(env: Env, ownerId: string, targetId: string,
  targetKind: "file" | "directory"): Promise<GrantFulfillMaterial> {
  const db = createDb(env.DB);
  // Grants (with their active-device count) whose needs still exist and that one bounded step
  // can cover, skipping oversized or device-less Grants instead of stopping the scan.
  const grants = await db.all<GrantRow>(sql`
    WITH candidates AS (
      SELECT g.id, g.recipient_id, g.generation, g.permission, l.label_id, l.owner_copy,
        l.offer_bytes, l.offer_digest, l.offer_signature,
        (SELECT COUNT(*) FROM encryption_devices d
          JOIN account_encryption_identities r ON r.account_id = d.account_id
          WHERE d.account_id = g.recipient_id AND d.state = 'active') AS device_count
      FROM grants g JOIN grant_labels l ON l.grant_id = g.id
      WHERE g.owner_id = ${ownerId} AND g.target_node_id = ${targetId} AND g.target_kind = ${targetKind}
        AND EXISTS (SELECT 1 FROM provisioning_needs n WHERE n.grant_id = g.id)
    ), eligible AS (
      SELECT * FROM candidates WHERE device_count BETWEEN 1 AND ${MAX_FULFILL_DEVICES}
    ), sized AS (
      SELECT *, SUM(device_count) OVER (ORDER BY id) AS running FROM eligible
    )
    SELECT id, recipient_id, generation, permission, label_id, owner_copy, offer_bytes, offer_digest,
      offer_signature FROM sized WHERE running <= ${MAX_FULFILL_DEVICES} ORDER BY id LIMIT ${MAX_FULFILL_GRANTS}`);
  if (!grants.length) return { grants: [], devices: [] };
  const ids = JSON.stringify(grants.map((grant) => grant.id));
  const devices = await db.all<DeviceRow>(sql`SELECT g.id AS grant_id, d.id AS device_id, r.registry_epoch,
      d.transport_public_key, del.digest AS label_digest
    FROM grants g JOIN encryption_devices d ON d.account_id = g.recipient_id AND d.state = 'active'
    JOIN account_encryption_identities r ON r.account_id = g.recipient_id
    LEFT JOIN grant_label_deliveries del ON del.grant_id = g.id AND del.device_id = d.id
      AND del.registry_epoch = r.registry_epoch
    WHERE g.id IN (SELECT value FROM json_each(${ids}))
    ORDER BY g.id, d.id`);
  return { grants, devices };
}

/** `ownerCopy` is the Owner's own Shared-as label copy under their Vault root, never a
 * recipient ciphertext, and is returned only for a Grant whose recipient has no current-epoch
 * delivery; it is required to re-seal that label. Everything else is opaque IDs, the signed
 * offer and public keys. */
export function grantFulfillWire(material: GrantFulfillMaterial) {
  return material.grants.map((grant) => {
    const own = material.devices.filter((device) => device.grant_id === grant.id);
    return { grantId: grant.id, recipientId: grant.recipient_id, generation: grant.generation,
      permission: grant.permission,
      offer: { bytes: b64(grant.offer_bytes), digest: b64(grant.offer_digest),
        signature: b64(grant.offer_signature) },
      labelId: grant.label_id,
      ...(own.some((device) => device.label_digest === null) ? { ownerCopy: b64(grant.owner_copy) } : {}),
      devices: own.map((device) => ({ deviceId: device.device_id, registryEpoch: device.registry_epoch,
        publicKey: b64(device.transport_public_key),
        labelDigest: device.label_digest ? hex(bytes(device.label_digest)) : null })) };
  });
}

async function directoryEpoch(env: Env, ownerId: string, directoryId: string): Promise<number> {
  const row = await createDb(env.DB).get<{ capability_epoch: number }>(sql`SELECT capability_epoch FROM directories
    WHERE node_id = ${directoryId} AND owner_id = ${ownerId}`);
  if (!row) throw new Error("missing Directory");
  return row.capability_epoch;
}

/** What the Owner's browser must seal next for one target: opaque IDs, the stored offer, the
 * recipient's active devices and (only when a label is missing) the Owner's own copy. */
export async function nextProvisioningStep(env: Env, auth: AuthorizedDevice, targetId: string): Promise<Response> {
  const node = await createDb(env.DB).get<{ kind: "file" | "directory" }>(sql`SELECT kind FROM vault_nodes
    WHERE id = ${targetId} AND owner_id = ${auth.accountId} AND ${privateReadGuard(auth)}`);
  if (!node) return absent();
  if (!await createDb(env.DB).get(sql`SELECT 1 WHERE ${unblocked(auth.accountId, targetId)}`)) return absent();
  try {
    if (node.kind === "directory") {
      const epoch = await directoryEpoch(env, auth.accountId, targetId);
      const material = await grantFulfillMaterial(env, auth.accountId, targetId, "directory");
      if (!material.grants.length) return absent();
      return json({ step: "grants", targetId, directoryId: targetId, epoch, grants: grantFulfillWire(material) });
    }
    const material = await grantFulfillMaterial(env, auth.accountId, targetId, "file");
    if (!material.grants.length) return absent();
    return json({ step: "file", targetId, fileId: targetId,
      recipients: await recipients(env, auth.accountId, targetId), grants: grantFulfillWire(material) });
  } catch { return invalid(); }
}

type ParsedDevice = { deviceId: string; registryEpoch: number; content: Uint8Array; contentDigest: Uint8Array;
  labelDigest: Uint8Array; newLabel: { ciphertext: Uint8Array; digest: Uint8Array } | null };
type ParsedSeal = { grantId: string; generation: number; recipientId: string; previousDigest: Uint8Array;
  offer: { bytes: Uint8Array; digest: Uint8Array; signature: Uint8Array }; devices: ParsedDevice[] };

/**
 * Validates one re-sealed offer per current Grant: an Owner-signed offer at the next material
 * revision for this exact Grant/label/Owner copy/content revision, listing exactly the
 * recipient's active devices with digests of the submitted envelope and label. A device with
 * no current label delivery must include its freshly sealed label; otherwise the stored digest
 * is reused. Nothing here is a capability or a plaintext name.
 */
async function parseSeals(options: { auth: AuthorizedDevice; ownerId: string; targetId: string;
  targetKind: "file" | "directory"; material: GrantFulfillMaterial; value: unknown; withContent: boolean;
  contentByDevice?: Map<string, Uint8Array>; contentKeyId: string; contentEpoch: number;
  contentRevision: number }): Promise<ParsedSeal[]> {
  const { auth, ownerId, targetId, targetKind, material, value, withContent, contentByDevice } = options;
  const submittedGrants: unknown[] = Array.isArray(value) ? value : [];
  if (submittedGrants.length !== material.grants.length) throw new Error("invalid Grant seals");
  const fields = withContent ? ["deviceId", "ciphertext", "labelCiphertext"] : ["deviceId", "labelCiphertext"];
  const seals: ParsedSeal[] = [];
  for (const grant of material.grants) {
    const item = submittedGrants.map(record).find((candidate) => candidate?.grantId === grant.id);
    if (!item || !exact(item, ["grantId", "offer", "devices"]) || !Array.isArray(item.devices)) {
      throw new Error("invalid Grant seal");
    }
    const signed = record(item.offer);
    if (!signed || !exact(signed, ["bytes", "digest", "signature"])) throw new Error("invalid Grant seal");
    const offerBytes = decodeTreeBytes(signed.bytes, 131_072);
    const offerDigest = decodeTreeBytes(signed.digest, 32);
    const signature = decodeTreeBytes(signed.signature, 64);
    const next = await verifyOffer(offerBytes, offerDigest, signature, auth.assertionPublicKey);
    const stored = parseOffer(bytes(grant.offer_bytes));
    if (next.shareId !== stored.shareId || next.grantId !== grant.id || next.ownerId !== ownerId ||
        stored.ownerId !== ownerId || next.recipientId !== grant.recipient_id || next.targetId !== targetId ||
        next.kind !== targetKind || next.labelId !== stored.labelId ||
        next.ownerCopyDigest !== stored.ownerCopyDigest || next.contentRevision !== stored.contentRevision ||
        next.headDigest !== stored.headDigest || next.candidateDigest !== stored.candidateDigest ||
        next.permission !== grant.permission || next.materialRevision !== stored.materialRevision + 1 ||
        next.signerDeviceId !== auth.deviceId) throw new Error("invalid Grant offer");
    if (targetKind === "directory" && (next.targetKeyId !== targetId || next.targetEpoch !== options.contentEpoch)) {
      throw new Error("invalid Grant offer");
    }
    if (targetKind === "file" && (next.targetKeyId !== stored.targetKeyId ||
        next.targetEpoch !== stored.targetEpoch)) throw new Error("invalid Grant offer");
    const ready = material.devices.filter((device) => device.grant_id === grant.id);
    const rawDevices = item.devices.map(record);
    if (!ready.length || next.devices.length !== ready.length || rawDevices.length !== ready.length) {
      throw new Error("invalid Grant devices");
    }
    const devices = await Promise.all(ready.map(async (device) => {
      const descriptor = next.devices.find((entry) => entry.deviceId === device.device_id);
      const raw = rawDevices.find((entry) => entry?.deviceId === device.device_id);
      if (!descriptor || !raw || !exact(raw, fields) || next.registryEpoch !== device.registry_epoch ||
          descriptor.registryEpoch !== device.registry_epoch ||
          descriptor.publicKeyDigest !== hex(await digestBytes(bytes(device.transport_public_key)))) {
        throw new Error("invalid Grant device");
      }
      const content = withContent ? decodeTreeBytes(raw.ciphertext, 16_384) : contentByDevice?.get(device.device_id);
      if (!content) throw new Error("invalid Grant envelope");
      const contentDigest = await digestBytes(content);
      if (descriptor.contentDigest !== hex(contentDigest)) throw new Error("invalid Grant envelope");
      inspectOfferEnvelope(content, { purpose: "grant", vaultId: ownerId, objectId: targetId,
        keyId: options.contentKeyId, keyEpoch: options.contentEpoch, revision: options.contentRevision,
        recipientId: device.device_id });
      let labelDigest: Uint8Array, newLabel: ParsedDevice["newLabel"] = null;
      if (raw.labelCiphertext !== null && raw.labelCiphertext !== undefined) {
        const ciphertext = decodeTreeBytes(raw.labelCiphertext, 4096);
        const digest = await digestBytes(ciphertext);
        if (descriptor.labelDigest !== hex(digest)) throw new Error("invalid Grant label");
        inspectOfferEnvelope(ciphertext, { purpose: "share-root-label", vaultId: ownerId, objectId: targetId,
          keyId: grant.label_id, keyEpoch: 1, revision: 1, recipientId: device.device_id });
        labelDigest = digest;
        newLabel = { ciphertext, digest };
      } else {
        if (!device.label_digest || descriptor.labelDigest !== hex(bytes(device.label_digest))) {
          throw new Error("invalid Grant label");
        }
        labelDigest = bytes(device.label_digest);
      }
      return { deviceId: device.device_id, registryEpoch: device.registry_epoch, content, contentDigest,
        labelDigest, newLabel };
    }));
    seals.push({ grantId: grant.id, generation: grant.generation, recipientId: grant.recipient_id,
      previousDigest: bytes(grant.offer_digest),
      offer: { bytes: offerBytes, digest: offerDigest, signature }, devices });
  }
  return seals;
}

/** Every sealed Grant still carries the exact generation and stored offer this step was
 * prepared against. A concurrent revoke, permission change or rotation fails closed. */
function sealGuard(ownerId: string, targetId: string, targetKind: "file" | "directory",
  seals: readonly ParsedSeal[]): SQL {
  const expected = JSON.stringify(seals.map((seal) => ({ id: seal.grantId, generation: seal.generation,
    digest: hex(seal.previousDigest) })));
  return sql`NOT EXISTS (SELECT 1 FROM json_each(${expected}) e WHERE NOT EXISTS (SELECT 1 FROM grants g
    JOIN grant_labels l ON l.grant_id = g.id
    WHERE g.id = json_extract(e.value, '$.id') AND g.owner_id = ${ownerId} AND g.target_node_id = ${targetId}
      AND g.target_kind = ${targetKind} AND g.generation = json_extract(e.value, '$.generation')
      AND hex(l.offer_digest) = upper(json_extract(e.value, '$.digest'))))`;
}

/** Re-signed offers, refreshed Shared-as labels for devices that lacked one, and removal of
 * exactly the fulfilled needs. Only an active Owner device may sign; the label ID and Owner
 * copy are unchanged (the grants trigger enforces both). */
function offerStatements(auth: AuthorizedDevice, seals: readonly ParsedSeal[], live: SQL): SQL[] {
  const ids = JSON.stringify(seals.map((seal) => seal.grantId));
  const offers = JSON.stringify(seals.map((seal) => ({ grantId: seal.grantId, bytes: hex(seal.offer.bytes),
    digest: hex(seal.offer.digest), signature: hex(seal.offer.signature) })));
  const offer = (field: string) => sql`unhex((SELECT json_extract(o.value, ${`$.${field}`}) FROM json_each(${offers}) o
    WHERE json_extract(o.value, '$.grantId') = grant_labels.grant_id))`;
  const labels = JSON.stringify(seals.flatMap((seal) => seal.devices.filter((device) => device.newLabel)
    .map((device) => ({ grantId: seal.grantId, deviceId: device.deviceId, registryEpoch: device.registryEpoch,
      ciphertext: hex(device.newLabel!.ciphertext), digest: hex(device.newLabel!.digest) }))));
  const statements = [
    sql`UPDATE grant_labels SET offer_bytes = ${offer("bytes")}, offer_digest = ${offer("digest")},
        offer_signature = ${offer("signature")}, signer_device_id = ${auth.deviceId}
      WHERE grant_id IN (SELECT value FROM json_each(${ids})) AND ${live}`,
  ];
  if (labels !== "[]") {
    statements.push(sql`INSERT INTO grant_label_deliveries (grant_id, device_id, registry_epoch, ciphertext, digest)
      SELECT json_extract(value, '$.grantId'), json_extract(value, '$.deviceId'),
        json_extract(value, '$.registryEpoch'), unhex(json_extract(value, '$.ciphertext')),
        unhex(json_extract(value, '$.digest')) FROM json_each(${labels}) WHERE ${live}
      ON CONFLICT(grant_id, device_id) DO UPDATE SET registry_epoch = excluded.registry_epoch,
        ciphertext = excluded.ciphertext, digest = excluded.digest`);
  }
  statements.push(sql`DELETE FROM provisioning_needs WHERE grant_id IN (SELECT value FROM json_each(${ids}))
    AND ${live}`);
  return statements;
}

function directoryEnvelopeStatements(directoryId: string, epoch: number,
  seals: readonly ParsedSeal[], live: SQL): SQL[] {
  const ids = JSON.stringify(seals.map((seal) => seal.grantId));
  const envelopes = JSON.stringify(seals.flatMap((seal) => seal.devices.map((device) => ({
    grantId: seal.grantId, deviceId: device.deviceId, generation: seal.generation,
    registryEpoch: device.registryEpoch, ciphertext: hex(device.content), digest: hex(device.contentDigest) }))));
  return [
    sql`DELETE FROM grant_device_envelopes WHERE grant_id IN (SELECT value FROM json_each(${ids})) AND ${live}`,
    sql`INSERT INTO grant_device_envelopes (grant_id, device_id, generation, registry_epoch, target_key_id,
        target_epoch, ciphertext, digest)
      SELECT json_extract(value, '$.grantId'), json_extract(value, '$.deviceId'),
        json_extract(value, '$.generation'), json_extract(value, '$.registryEpoch'), ${directoryId}, ${epoch},
        unhex(json_extract(value, '$.ciphertext')), unhex(json_extract(value, '$.digest'))
      FROM json_each(${envelopes}) WHERE ${live}`,
  ];
}

/** One Directory fulfillment: the unchanged current capability re-sealed to every active
 * device of every affected Grant, refreshed labels, re-signed offers, needs deleted. */
export async function fulfillDirectoryStep(env: Env, auth: AuthorizedDevice, directoryId: string,
  value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["epoch", "grants"]) || !Array.isArray(input.grants) ||
      !Number.isSafeInteger(input.epoch)) return invalid();
  const ownerId = auth.accountId, epoch = input.epoch as number;
  const authority = directoryAccessGuard(auth, ownerId, directoryId, "share_manage");
  const row = await createDb(env.DB).get<{ capability_epoch: number }>(sql`SELECT capability_epoch FROM directories
    WHERE node_id = ${directoryId} AND owner_id = ${ownerId} AND ${authority}`);
  if (!row) return absent();
  if (row.capability_epoch !== epoch) return changed();
  if (!await createDb(env.DB).get(sql`SELECT 1 WHERE ${unblocked(ownerId, directoryId)}`)) return changed();
  let seals: ParsedSeal[];
  try {
    seals = await parseSeals({ auth, ownerId, targetId: directoryId, targetKind: "directory",
      material: await grantFulfillMaterial(env, ownerId, directoryId, "directory"), value: input.grants,
      withContent: true, contentKeyId: directoryId, contentEpoch: epoch, contentRevision: 1 });
  } catch { return invalid(); }
  if (!seals.length) return changed();
  const invocationId = crypto.randomUUID(), live = marker(auth, invocationId);
  try {
    const [witness] = await atomicSqlBatch(env.DB, [
      begin(auth, invocationId, sql`${authority} AND ${unblocked(ownerId, directoryId)}
        AND ${sealGuard(ownerId, directoryId, "directory", seals)}
        AND EXISTS (SELECT 1 FROM directories WHERE node_id = ${directoryId} AND owner_id = ${ownerId}
          AND capability_epoch = ${epoch})`),
      ...directoryEnvelopeStatements(directoryId, epoch, seals, live),
      ...offerStatements(auth, seals, live),
      spent(auth, invocationId), proofTime(auth, invocationId), finish(auth, invocationId),
    ]);
    return witness?.meta.changes === 1 ? json({ status: "complete" }) : changed();
  } catch { return invalid(); }
}

/** One File fulfillment: a same-revision recipient-set update re-sealing the current File key
 * to every live direct device, refreshed labels, re-signed offers, needs deleted. */
export async function fulfillFileStep(env: Env, auth: AuthorizedDevice, fileId: string,
  value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["expectedHeadDigest", "signedHead", "recipientEnvelopes", "grants"]) ||
      !Array.isArray(input.recipientEnvelopes) || input.recipientEnvelopes.length > 256 ||
      !Array.isArray(input.grants)) return invalid();
  const ownerId = auth.accountId;
  const current = await headRow(env, auth, ownerId, fileId);
  if (!current) return absent();
  if (!await createDb(env.DB).get(sql`SELECT 1 WHERE ${unblocked(ownerId, fileId)}`)) return changed();
  let expectedDigest: Uint8Array, signed: ReturnType<typeof parseHead>, recipientSetVersion: number;
  let expected: Recipient[], delivery: { accountId: string; deviceId: string; registryEpoch: number;
    ciphertext: Uint8Array }[];
  try {
    expectedDigest = decodeTreeBytes(input.expectedHeadDigest, 32);
    if (hex(expectedDigest) !== hex(bytes(current.digest))) return changed();
    signed = parseHead(input.signedHead);
    const before = await verified(current);
    const nextHead = await verifyFileHead(signed, { ownerId, vaultId: ownerId, fileId,
      revision: current.revision, signerDeviceId: auth.deviceId, publicKey: auth.assertionPublicKey });
    assertFileHeadCommitTransition(before, nextHead, { expectedSameRevisionTransition: "recipient-set-update" });
    recipientSetVersion = nextHead.statement.recipientSetVersion;
    if (recipientSetVersion !== current.recipient_set_version + 1) return invalid();
    expected = await recipients(env, ownerId, fileId);
    assertExactFileRecipientDescriptors(nextHead, await Promise.all(expected.map(async (item) => ({
      accountId: item.accountId, deviceId: item.deviceId, registryEpoch: item.registryEpoch, grants: item.grants,
      publicKeyDigest: await digestBytes(decodeTreeBytes(item.publicKey, 65)) }))));
    const submitted = input.recipientEnvelopes.map((item: unknown) => {
      const entry = record(item);
      if (!entry || !exact(entry, ["deviceId", "ciphertext"]) || !isV7(entry.deviceId)) {
        throw new Error("invalid envelope");
      }
      return { deviceId: entry.deviceId, ciphertext: decodeTreeBytes(entry.ciphertext, 16_384) };
    });
    if (submitted.length !== expected.length ||
        new Set(submitted.map((item) => item.deviceId)).size !== submitted.length) return invalid();
    delivery = await Promise.all(expected.map(async (item) => {
      const sealed = submitted.find((entry) => entry.deviceId === item.deviceId);
      if (!sealed) throw new Error("missing envelope");
      await verifyDirectFileRecipientEnvelope(nextHead, item.accountId, item.deviceId,
        decodeTreeBytes(item.publicKey, 65), sealed.ciphertext);
      return { accountId: item.accountId, deviceId: item.deviceId, registryEpoch: item.registryEpoch,
        ciphertext: sealed.ciphertext };
    }));
  } catch { return invalid(); }
  const contentByDevice = new Map(delivery.map((item) => [item.deviceId, item.ciphertext]));
  let seals: ParsedSeal[];
  try {
    seals = await parseSeals({ auth, ownerId, targetId: fileId, targetKind: "file",
      material: await grantFulfillMaterial(env, ownerId, fileId, "file"), value: input.grants,
      withContent: false, contentByDevice, contentKeyId: current.content_key_id,
      contentEpoch: current.content_epoch, contentRevision: current.revision });
  } catch { return invalid(); }
  if (!seals.length) return changed();
  const payload = JSON.stringify(await Promise.all(delivery.map(async (item) => ({
    accountId: item.accountId, deviceId: item.deviceId, registryEpoch: item.registryEpoch,
    ciphertext: hex(item.ciphertext), digest: hex(await digestBytes(item.ciphertext)) }))));
  const invocationId = crypto.randomUUID(), live = marker(auth, invocationId);
  try {
    const [witness] = await atomicSqlBatch(env.DB, [
      begin(auth, invocationId, sql`${unblocked(ownerId, fileId)}
        AND ${exactRecipientGuard(ownerId, fileId, expected)}
        AND EXISTS (SELECT 1 FROM file_heads WHERE file_node_id = ${fileId} AND owner_id = ${ownerId}
          AND digest = ${expectedDigest})
        AND ${sealGuard(ownerId, fileId, "file", seals)}`),
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
      ...offerStatements(auth, seals, live),
      spent(auth, invocationId), proofTime(auth, invocationId), finish(auth, invocationId),
    ]);
    return witness?.meta.changes === 1 ? json({ status: "complete" }) : changed();
  } catch { return invalid(); }
}
