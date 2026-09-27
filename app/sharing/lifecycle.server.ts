import { record } from "~/auth/request.server";
import { atomicSqlBatch, createDb, sql } from "~/db/client.server";
import { privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { fileAccessGuard, directoryAccessGuard } from "./access.server";
import { exactRecipientGuard, recipients, unblocked } from "~/tree/file-v2.server";
import { assertExactFileRecipientDescriptors, assertFileHeadCommitTransition, verifyDirectFileRecipientEnvelope,
  verifyFileHead, type VerifiedFileHead } from "~/tree/file-head";
import { decodeTreeBytes, encodeTreeBytes, isV7 } from "~/tree/wire";
import { digestBytes, hex, inspectOfferEnvelope, sameBytes, verifyOffer, type Offer } from "./offer";
import { devices, devicesMatch, marker, proof, proofTime, spent, target, verifiedTarget, type Target } from "./sharing.server";

const headers = { "Cache-Control": "no-store" };
const absent = () => Response.json({ error: "not_found" }, { status: 404, headers });
const invalid = () => Response.json({ error: "invalid_sharing_request" }, { status: 400, headers });
const changed = () => Response.json({ error: "share_changed" }, { status: 409, headers });
const json = (value: object, status = 200) => Response.json(value, { status, headers });
const bytes = (value: ArrayBuffer | Uint8Array) => new Uint8Array(value);
const b64 = (value: ArrayBuffer | Uint8Array) => encodeTreeBytes(bytes(value));
const fingerprint = async (value: Uint8Array) => hex(await digestBytes(value));
const fromHex = (value: string) => Uint8Array.from(value.match(/../g)!, (pair) => parseInt(pair, 16));

type Delivery = { deviceId: string; registryEpoch: number; publicKey: Uint8Array;
  ciphertext: Uint8Array; digest: Uint8Array; label: Uint8Array; labelDigest: Uint8Array };
type Submitted = { offer: Offer; signed: { bytes: Uint8Array; digest: Uint8Array; signature: Uint8Array };
  copy: Uint8Array; candidate: { bytes: Uint8Array; digest: Uint8Array; signature: Uint8Array } | null;
  deliveries: Delivery[] };
const wire = (item: unknown, limit: number) => decodeTreeBytes(item, limit);
function parseSubmission(value: unknown): Submitted {
  const input = record(value);
  if (!input || !Array.isArray(input.deliveries) || input.deliveries.length > 256 ||
      (input.kind !== "file" && input.kind !== "directory") ||
      !isV7(input.shareId) || !isV7(input.grantId) || !isV7(input.labelId) ||
      !isV7(input.ownerId) || !isV7(input.recipientId) || !isV7(input.targetId) ||
      !isV7(input.signerDeviceId)) throw new Error("invalid share");
  const signed = { bytes: wire(input.offerBytes, 131072), digest: wire(input.offerDigest, 32),
    signature: wire(input.offerSignature, 64) };
  const copy = wire(input.ownerCopy, 4096);
  const candidateData = record(input.candidate);
  const candidate = candidateData ? { bytes: wire(candidateData.bytes, 131072),
    digest: wire(candidateData.digest, 32), signature: wire(candidateData.signature, 64) } : null;
  const deliveries = input.deliveries.map((item: unknown): Delivery => {
    const r = record(item);
    if (!r || !isV7(r.deviceId) || !Number.isSafeInteger(r.registryEpoch)) throw new Error("invalid delivery");
    return { deviceId: r.deviceId, registryEpoch: r.registryEpoch as number,
      publicKey: wire(r.publicKey, 65), ciphertext: wire(r.ciphertext, 16384),
      digest: new Uint8Array(), label: wire(r.labelCiphertext, 4096), labelDigest: new Uint8Array() };
  });
  if (new Set(deliveries.map((d) => d.deviceId)).size !== deliveries.length ||
      JSON.stringify(deliveries.map((d) => d.deviceId).sort()) !==
        JSON.stringify((input.devices as { deviceId: string }[]).map((d) => d.deviceId).sort())) {
    throw new Error("invalid delivery set");
  }
  const offer: Offer = { shareId: input.shareId, grantId: input.grantId, ownerId: input.ownerId,
    recipientId: input.recipientId, targetId: input.targetId, kind: input.kind,
    permission: input.permission as Offer["permission"], materialRevision: input.materialRevision as number,
    targetKeyId: input.targetKeyId as string, targetEpoch: input.targetEpoch as number,
    contentRevision: input.contentRevision as number, headDigest: input.headDigest as string,
    labelId: input.labelId, ownerCopyDigest: input.ownerCopyDigest as string,
    registryEpoch: input.registryEpoch as number, devices: input.devices as Offer["devices"],
    candidateDigest: input.candidateDigest as string | null, signerDeviceId: input.signerDeviceId };
  return { offer, signed, copy, candidate, deliveries };
}

/** Validate an Owner-signed presealed offer before its first persistence. A candidate is
 * an exact same-revision recipient-set transition, NEVER a File-content write.
 */
async function verifySubmission(auth: AuthorizedDevice, input: Submitted, t: Target,
  currentDevices: Awaited<ReturnType<typeof devices>>, existing: Awaited<ReturnType<typeof recipients>>) {
  const { offer, signed, copy, candidate, deliveries } = input;
  const parsed = await verifyOffer(signed.bytes, signed.digest, signed.signature, auth.assertionPublicKey);
  if (JSON.stringify(parsed) !== JSON.stringify(offer) || auth.accountId !== offer.ownerId ||
      auth.deviceId !== offer.signerDeviceId || t.owner_id !== auth.accountId || t.id !== offer.targetId ||
      offer.kind !== t.kind || offer.materialRevision !== 1 || offer.targetKeyId !== t.target_key_id ||
      offer.targetEpoch !== t.target_epoch || offer.recipientId === offer.ownerId ||
      currentDevices.length !== offer.devices.length || currentDevices.length !== deliveries.length ||
      !sameBytes(signed.digest, await digestBytes(signed.bytes)) ||
      offer.ownerCopyDigest !== await fingerprint(copy)) throw new Error("invalid offer");
  inspectOfferEnvelope(copy, { purpose: "share-root-label", vaultId: offer.ownerId,
    objectId: offer.targetId, keyId: offer.labelId, keyEpoch: 1, revision: 1 }, "AES-256-GCM/HKDF-SHA-256");
  for (const d of currentDevices) {
    const item = deliveries.find((i) => i.deviceId === d.device_id);
    const descriptor = offer.devices.find((i) => i.deviceId === d.device_id);
    if (!item || !descriptor || item.registryEpoch !== d.registry_epoch ||
        descriptor.registryEpoch !== d.registry_epoch || descriptor.accountId !== offer.recipientId ||
        !sameBytes(item.publicKey, bytes(d.transport_public_key)) ||
        descriptor.publicKeyDigest !== await fingerprint(item.publicKey) ||
        descriptor.contentDigest !== await fingerprint(item.ciphertext) ||
        descriptor.labelDigest !== await fingerprint(item.label)) throw new Error("invalid delivery");
    item.digest = await digestBytes(item.ciphertext);
    item.labelDigest = await digestBytes(item.label);
    inspectOfferEnvelope(item.ciphertext, { purpose: "grant", vaultId: offer.ownerId,
      objectId: offer.targetId, keyId: offer.targetKeyId, keyEpoch: offer.targetEpoch,
      revision: offer.kind === "file" ? offer.contentRevision : 1, recipientId: item.deviceId });
    inspectOfferEnvelope(item.label, { purpose: "share-root-label", vaultId: offer.ownerId,
      objectId: offer.targetId, keyId: offer.labelId, keyEpoch: 1, revision: 1,
      recipientId: item.deviceId });
  }
  if (t.kind === "directory") {
    // Children/listing revisions can change without changing the capability being offered.
    if (candidate || offer.candidateDigest || offer.targetKeyId !== t.target_key_id) throw new Error("invalid Directory offer");
    return;
  }
  if (!candidate || !offer.candidateDigest || !t.bytes ||
      offer.headDigest !== hex(bytes(t.head_digest)) || offer.contentRevision !== t.revision ||
      offer.candidateDigest !== await fingerprint(candidate.bytes) ||
      !sameBytes(candidate.digest, await digestBytes(candidate.bytes))) throw new Error("invalid File offer");
  const before = await verifiedTarget(t);
  const after = await verifyFileHead(candidate, { ownerId: offer.ownerId, vaultId: offer.ownerId,
    fileId: offer.targetId, revision: t.revision,
    signerDeviceId: auth.deviceId, publicKey: auth.assertionPublicKey });
  assertFileHeadCommitTransition(before, after, { expectedSameRevisionTransition: "recipient-set-update" });
  if (after.statement.recipientSetVersion !== before.statement.recipientSetVersion + 1 ||
      existing.length + deliveries.length > 256) throw new Error("invalid recipient capacity");
  const expected = [...existing.map((r) => ({ ...r })), ...deliveries.map((d) => ({
    accountId: offer.recipientId, deviceId: d.deviceId, registryEpoch: d.registryEpoch,
    publicKey: b64(d.publicKey), grants: [{ id: offer.grantId, generation: 1 }] }))];
  assertExactFileRecipientDescriptors(after, await Promise.all(expected.map(async (r) => ({
    accountId: r.accountId, deviceId: r.deviceId, registryEpoch: r.registryEpoch, grants: r.grants,
    publicKeyDigest: await digestBytes(wire(r.publicKey, 65)) }))));
  for (const d of deliveries) await verifyDirectFileRecipientEnvelope(after, offer.recipientId,
    d.deviceId, d.publicKey, d.ciphertext);
}

/** Request budget: <= 6 reads, 10-13 statements per atomic batch; JSON relations
 * carry at most 256 devices and 768KiB total encrypted payload, no per-device query.
 */
export async function createShare(env: Env, auth: AuthorizedDevice, value: unknown): Promise<Response> {
  let input: Submitted;
  try { input = parseSubmission(value); } catch { return invalid(); }
  const { offer, signed, copy, candidate, deliveries } = input;
  const t = await target(env, auth, offer.targetId, offer.kind);
  if (!t || t.owner_id !== offer.ownerId) return absent();
  try {
    const current = await devices(env, offer.recipientId);
    const existing = offer.kind === "file" ? await recipients(env, offer.ownerId, offer.targetId) : [];
    await verifySubmission(auth, input, t, current, existing);
    const payload = JSON.stringify(await Promise.all(deliveries.map(async (d) => ({ deviceId: d.deviceId,
      registryEpoch: d.registryEpoch, publicKeyDigest: hex(await digestBytes(d.publicKey)),
      ciphertext: hex(d.ciphertext), digest: hex(d.digest),
      label: hex(d.label), labelDigest: hex(d.labelDigest) }))));
    if (payload.length > 768 * 1024 || signed.bytes.length + (candidate?.bytes.length ?? 0) + payload.length > 1024 * 1024) return invalid();
    const membership = devicesMatch(offer.recipientId, deliveries.map((d) => ({ deviceId: d.deviceId,
      registryEpoch: d.registryEpoch, publicKeyHex: hex(d.publicKey).toUpperCase() })));
    const authority = offer.kind === "file" ? fileAccessGuard(auth, offer.ownerId, offer.targetId, "share_manage") :
      directoryAccessGuard(auth, offer.ownerId, offer.targetId, "share_manage");
    const currentTarget = offer.kind === "directory" ? sql`EXISTS (SELECT 1 FROM directories d
      WHERE d.node_id = ${offer.targetId} AND d.owner_id = ${offer.ownerId}
        AND d.node_id = ${offer.targetKeyId} AND d.capability_epoch = ${offer.targetEpoch})` :
      sql`EXISTS (SELECT 1 FROM file_heads h WHERE h.file_node_id = ${offer.targetId}
        AND h.owner_id = ${offer.ownerId} AND h.digest = ${fromHex(offer.headDigest)}
        AND h.content_key_id = ${offer.targetKeyId} AND h.content_epoch = ${offer.targetEpoch}
        AND h.revision = ${offer.contentRevision}) AND ${exactRecipientGuard(offer.ownerId, offer.targetId, existing)}`;
    const now = Date.now(), active = marker(auth);
    const statements = [
      sql`INSERT INTO shares (id, owner_id, recipient_id, target_node_id, target_kind, permission, created_at)
        SELECT ${offer.shareId}, ${offer.ownerId}, ${offer.recipientId}, ${offer.targetId}, ${offer.kind},
          ${offer.permission}, ${now} WHERE ${proof(auth)} AND ${authority} AND ${unblocked(offer.ownerId, offer.targetId)}
          AND ${membership} AND ${currentTarget}
          AND NOT EXISTS (SELECT 1 FROM grants WHERE owner_id = ${offer.ownerId}
            AND recipient_id = ${offer.recipientId} AND target_node_id = ${offer.targetId})`,
      spent(auth),
      sql`INSERT INTO share_material (share_id, material_revision, anticipated_grant_id, target_key_id,
        target_epoch, head_digest, registry_epoch, candidate_head, candidate_digest, candidate_signature,
        candidate_signer_device_id) SELECT ${offer.shareId}, 1, ${offer.grantId}, ${offer.targetKeyId},
        ${offer.targetEpoch}, ${fromHex(offer.headDigest)}, ${offer.registryEpoch}, ${candidate?.bytes ?? null},
        ${candidate?.digest ?? null}, ${candidate?.signature ?? null}, ${candidate ? auth.deviceId : null}
        WHERE ${active}`,
      sql`INSERT INTO share_offers (share_id, label_id, owner_copy, bytes, digest, signature, signer_device_id)
        SELECT ${offer.shareId}, ${offer.labelId}, ${copy}, ${signed.bytes}, ${signed.digest},
          ${signed.signature}, ${auth.deviceId} WHERE ${active}`,
      sql`INSERT INTO share_device_material (share_id, material_revision, device_id, registry_epoch,
        public_key_digest, ciphertext, digest)
        SELECT ${offer.shareId}, 1, json_extract(value, '$.deviceId'), json_extract(value, '$.registryEpoch'),
          unhex(json_extract(value, '$.publicKeyDigest')), unhex(json_extract(value, '$.ciphertext')),
          unhex(json_extract(value, '$.digest')) FROM json_each(${payload}) WHERE ${active}`,
      sql`INSERT INTO share_offer_labels (share_id, device_id, ciphertext, digest)
        SELECT ${offer.shareId}, json_extract(value, '$.deviceId'), unhex(json_extract(value, '$.label')),
          unhex(json_extract(value, '$.labelDigest')) FROM json_each(${payload}) WHERE ${active}`,
      proofTime(auth),
    ];
    const result = await atomicSqlBatch(env.DB, statements);
    return result[0]?.meta.changes === 1 ? json({ shareId: offer.shareId }, 201) : changed();
  } catch { return invalid(); }
}

/** A pending invitation exposes kind/permission only; acceptance consumes it atomically.
 * Membership changes retain only still-current independent material. A File head
 * can be committed only when its presigned exact set is current; otherwise the
 * Grant is pending provisioning, not falsely marked ready.
 */
async function targetForAcceptance(env: Env, ownerId: string, targetId: string,
  kind: "file" | "directory"): Promise<Target | null> {
  return (kind === "directory" ? await createDb(env.DB).get<Target>(sql`
    SELECT n.id, n.owner_id, n.kind, n.id AS target_key_id,
      d.capability_epoch AS target_epoch, d.entries_revision AS revision,
      COALESCE(d.listing_digest, zeroblob(32)) AS head_digest, NULL AS bytes,
      NULL AS signature, NULL AS signer_device_id, NULL AS assertion_public_key,
      NULL AS receiving_public_key, NULL AS parent_envelope, NULL AS representation_id,
      NULL AS content_key_id, NULL AS content_epoch, NULL AS recipient_set_version
    FROM vault_nodes n JOIN directories d ON d.node_id = n.id AND d.owner_id = n.owner_id
    WHERE n.id = ${targetId} AND n.owner_id = ${ownerId} AND n.kind = 'directory' AND n.import_id IS NULL`)
    : await createDb(env.DB).get<Target>(sql`
      SELECT n.id, n.owner_id, n.kind, h.content_key_id AS target_key_id,
        h.content_epoch AS target_epoch, h.revision, h.digest AS head_digest,
        h.bytes, h.signature, h.signer_device_id, signer.assertion_public_key,
        h.receiving_public_key, h.parent_envelope, h.representation_id,
        h.content_key_id, h.content_epoch, h.recipient_set_version
      FROM vault_nodes n JOIN file_heads h ON h.file_node_id = n.id AND h.owner_id = n.owner_id
      JOIN encryption_devices signer ON signer.id = h.signer_device_id
      WHERE n.id = ${targetId} AND n.owner_id = ${ownerId} AND n.kind = 'file' AND n.import_id IS NULL`)) ?? null;
}
async function hasBarrier(env: Env, ownerId: string, targetId: string): Promise<boolean> {
  return !await createDb(env.DB).get(sql`SELECT 1 WHERE ${unblocked(ownerId, targetId)}`);
}

export async function acceptShare(env: Env, auth: AuthorizedDevice, shareId: string,
  value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || input.materialRevision !== 1 || Object.keys(input).length !== 1) return invalid();
  const row = await createDb(env.DB).get<{ owner_id: string; recipient_id: string; target_node_id: string;
    target_kind: "file" | "directory"; permission: "read_only" | "read_write"; anticipated_grant_id: string;
    material_revision: number; target_key_id: string; target_epoch: number; head_digest: ArrayBuffer;
    registry_epoch: number; candidate_head: ArrayBuffer | null; candidate_digest: ArrayBuffer | null;
    candidate_signature: ArrayBuffer | null; candidate_signer_device_id: string | null;
    label_id: string; owner_copy: ArrayBuffer; offer_bytes: ArrayBuffer; offer_digest: ArrayBuffer;
    offer_signature: ArrayBuffer; signer_device_id: string; assertion_public_key: ArrayBuffer; signer_state: string }>(sql`
    SELECT s.owner_id, s.recipient_id, s.target_node_id, s.target_kind, s.permission,
      m.anticipated_grant_id, m.material_revision, m.target_key_id, m.target_epoch,
      m.head_digest, m.registry_epoch, m.candidate_head, m.candidate_digest,
      m.candidate_signature, m.candidate_signer_device_id,
      o.label_id, o.owner_copy, o.bytes AS offer_bytes, o.digest AS offer_digest,
      o.signature AS offer_signature, o.signer_device_id, signer.assertion_public_key,
      signer.state AS signer_state FROM shares s JOIN share_material m ON m.share_id = s.id
      JOIN share_offers o ON o.share_id = s.id
      JOIN encryption_devices signer ON signer.id = o.signer_device_id AND signer.account_id = s.owner_id
      WHERE s.id = ${shareId} AND s.recipient_id = ${auth.accountId} AND ${proof(auth)}`);
  if (!row) return absent();
  try {
    const offer = await verifyOffer(bytes(row.offer_bytes), bytes(row.offer_digest),
      bytes(row.offer_signature), bytes(row.assertion_public_key));
    if (offer.shareId !== shareId || offer.grantId !== row.anticipated_grant_id ||
        offer.recipientId !== row.recipient_id || offer.ownerId !== row.owner_id ||
        offer.targetId !== row.target_node_id || offer.kind !== row.target_kind ||
        offer.permission !== row.permission || offer.materialRevision !== row.material_revision ||
        offer.targetKeyId !== row.target_key_id || offer.targetEpoch !== row.target_epoch ||
        offer.registryEpoch !== row.registry_epoch || offer.signerDeviceId !== row.signer_device_id ||
        offer.labelId !== row.label_id || offer.headDigest !== hex(bytes(row.head_digest)) ||
        offer.ownerCopyDigest !== await fingerprint(bytes(row.owner_copy))) return invalid();
    const material = await createDb(env.DB).all<{ device_id: string; registry_epoch: number;
      public_key_digest: ArrayBuffer; ciphertext: ArrayBuffer; digest: ArrayBuffer;
      label: ArrayBuffer; label_digest: ArrayBuffer; transport_public_key: ArrayBuffer; state: string }>(sql`
      SELECT m.device_id, m.registry_epoch, m.public_key_digest, m.ciphertext, m.digest,
        l.ciphertext AS label, l.digest AS label_digest, d.transport_public_key, d.state
      FROM share_device_material m JOIN share_offer_labels l ON l.share_id = m.share_id AND l.device_id = m.device_id
      JOIN encryption_devices d ON d.id = m.device_id AND d.account_id = ${auth.accountId}
      WHERE m.share_id = ${shareId} AND m.material_revision = ${row.material_revision} ORDER BY m.device_id LIMIT 257`);
    if (material.length !== offer.devices.length || material.length > 256) return invalid();
    for (const m of material) {
      const d = offer.devices.find((item) => item.deviceId === m.device_id);
      if (!d || d.accountId !== row.recipient_id || d.registryEpoch !== m.registry_epoch ||
          d.publicKeyDigest !== hex(bytes(m.public_key_digest)) ||
          d.contentDigest !== hex(bytes(m.digest)) || d.labelDigest !== hex(bytes(m.label_digest)) ||
          !sameBytes(await digestBytes(bytes(m.ciphertext)), bytes(m.digest)) ||
          !sameBytes(await digestBytes(bytes(m.label)), bytes(m.label_digest))) return invalid();
    }
    const currentDevices = await devices(env, auth.accountId);
    const eligible = material.filter((m) => currentDevices.some((d) => d.device_id === m.device_id &&
      sameBytes(bytes(d.transport_public_key), bytes(m.transport_public_key))));
    // Public-key digest is also checked against the current actual key, never only the historical offer.
    for (const m of eligible) if (!sameBytes(await digestBytes(bytes(m.transport_public_key)),
      bytes(m.public_key_digest))) return invalid();
    const t = await targetForAcceptance(env, row.owner_id, row.target_node_id, row.target_kind);
    if (!t) return absent();
    const currentKey = t.target_key_id === row.target_key_id && t.target_epoch === row.target_epoch;
    const now = Date.now();
    const live = marker(auth);
    const eligibleJSON = JSON.stringify(eligible.map((m) => ({ deviceId: m.device_id,
      keyHex: hex(bytes(m.transport_public_key)).toUpperCase() })));
    const stillEligible = sql`d.state = 'active' AND EXISTS (SELECT 1 FROM json_each(${eligibleJSON}) eligible
      WHERE json_extract(eligible.value, '$.deviceId') = d.id
      AND json_extract(eligible.value, '$.keyHex') = hex(d.transport_public_key))`;
    const possible = currentKey && row.signer_state === "active" && !await hasBarrier(env, row.owner_id, row.target_node_id);
    let head: VerifiedFileHead | null = null;
    let expected: Awaited<ReturnType<typeof recipients>> = [];
    if (row.target_kind === "file" && possible && row.candidate_head && row.candidate_digest &&
        row.candidate_signature && row.candidate_signer_device_id === row.signer_device_id &&
        sameBytes(bytes(t.head_digest), bytes(row.head_digest)) && eligible.length === currentDevices.length &&
        eligible.length === material.length) {
      const before = await verifiedTarget(t);
      head = await verifyFileHead({ bytes: bytes(row.candidate_head), digest: bytes(row.candidate_digest),
        signature: bytes(row.candidate_signature) }, { ownerId: row.owner_id, vaultId: row.owner_id,
        fileId: row.target_node_id, signerDeviceId: row.signer_device_id,
        publicKey: bytes(row.assertion_public_key), revision: t.revision });
      assertFileHeadCommitTransition(before, head, { expectedSameRevisionTransition: "recipient-set-update" });
      expected = await recipients(env, row.owner_id, row.target_node_id);
      const next = [...expected, ...material.map((m) => ({ accountId: row.recipient_id, deviceId: m.device_id,
        registryEpoch: m.registry_epoch, publicKey: b64(m.transport_public_key),
        grants: [{ id: row.anticipated_grant_id, generation: 1 }] }))];
      assertExactFileRecipientDescriptors(head, await Promise.all(next.map(async (r) => ({
        accountId: r.accountId, deviceId: r.deviceId, registryEpoch: r.registryEpoch, grants: r.grants,
        publicKeyDigest: await digestBytes(decodeTreeBytes(r.publicKey, 65)) }))));
      for (const m of material) await verifyDirectFileRecipientEnvelope(head, row.recipient_id,
        m.device_id, bytes(m.transport_public_key), bytes(m.ciphertext));
    }
    // File material remains separately durable even when the presigned head is stale.
    const enabled = row.target_kind === "directory" ? possible : Boolean(head);
    const targetGuard = row.target_kind === "directory" ? sql`EXISTS (SELECT 1 FROM directories
      WHERE node_id = ${row.target_node_id} AND owner_id = ${row.owner_id}
        AND node_id = ${row.target_key_id} AND capability_epoch = ${row.target_epoch})` :
      sql`EXISTS (SELECT 1 FROM file_heads WHERE file_node_id = ${row.target_node_id}
        AND owner_id = ${row.owner_id})`;
    const statement = [
      sql`INSERT INTO grants (id, owner_id, recipient_id, target_node_id, target_kind,
        permission, generation, created_at, updated_at)
        SELECT ${row.anticipated_grant_id}, s.owner_id, s.recipient_id, s.target_node_id,
          s.target_kind, s.permission, 1, ${now}, ${now} FROM shares s
        JOIN share_material m ON m.share_id = s.id AND m.material_revision = ${row.material_revision}
        JOIN share_offers o ON o.share_id = s.id AND o.digest = ${bytes(row.offer_digest)}
        WHERE s.id = ${shareId} AND s.recipient_id = ${auth.accountId} AND ${proof(auth)}
          AND ${targetGuard} AND NOT EXISTS (SELECT 1 FROM grants g WHERE g.owner_id = s.owner_id
            AND g.recipient_id = s.recipient_id AND g.target_node_id = s.target_node_id)`,
      spent(auth),
      sql`INSERT INTO grant_labels (grant_id, label_id, owner_copy, offer_bytes, offer_digest,
        offer_signature, signer_device_id) SELECT ${row.anticipated_grant_id}, label_id, owner_copy,
          bytes, digest, signature, signer_device_id FROM share_offers WHERE share_id = ${shareId} AND ${live}`,
      sql`INSERT INTO grant_label_deliveries (grant_id, device_id, registry_epoch, ciphertext, digest)
        SELECT ${row.anticipated_grant_id}, d.id, registry.registry_epoch, l.ciphertext, l.digest
        FROM share_offer_labels l JOIN share_device_material m ON m.share_id = l.share_id AND m.device_id = l.device_id
        JOIN encryption_devices d ON d.id = l.device_id AND d.account_id = ${row.recipient_id}
        JOIN account_encryption_identities registry ON registry.account_id = d.account_id
        WHERE l.share_id = ${shareId} AND ${live} AND ${stillEligible}
          AND m.public_key_digest = unhex(lower(hex(m.public_key_digest)))`,
      ...(row.target_kind === "directory" ? [sql`INSERT INTO grant_device_envelopes (grant_id, device_id,
        generation, registry_epoch, target_key_id, target_epoch, ciphertext, digest)
        SELECT ${row.anticipated_grant_id}, d.id, 1, registry.registry_epoch, ${row.target_key_id},
          ${row.target_epoch}, m.ciphertext, m.digest
        FROM share_device_material m JOIN encryption_devices d ON d.id = m.device_id
          AND d.account_id = ${row.recipient_id}
        JOIN account_encryption_identities registry ON registry.account_id = d.account_id
        JOIN directories directory ON directory.node_id = ${row.target_node_id} AND directory.owner_id = ${row.owner_id}
        WHERE m.share_id = ${shareId} AND ${live} AND ${stillEligible}
          AND directory.node_id = ${row.target_key_id} AND directory.capability_epoch = ${row.target_epoch}
          AND ${unblocked(row.owner_id, row.target_node_id)} AND ${enabled}`] : [
        sql`INSERT INTO grant_retained_material (grant_id, device_id, registry_epoch,
          content_key_id, content_epoch, revision, ciphertext, digest)
          SELECT ${row.anticipated_grant_id}, d.id, registry.registry_epoch,
            ${row.target_key_id}, ${row.target_epoch}, ${t.revision}, m.ciphertext, m.digest
          FROM share_device_material m JOIN encryption_devices d ON d.id = m.device_id
            AND d.account_id = ${row.recipient_id}
          JOIN account_encryption_identities registry ON registry.account_id = d.account_id
          JOIN file_heads h ON h.file_node_id = ${row.target_node_id} AND h.owner_id = ${row.owner_id}
          WHERE m.share_id = ${shareId} AND ${live} AND ${stillEligible} AND
            h.content_key_id = ${row.target_key_id} AND h.content_epoch = ${row.target_epoch}
            AND h.revision = ${t.revision}`,
        ...(head ? [sql`UPDATE file_heads SET bytes = ${bytes(row.candidate_head!)},
          digest = ${bytes(row.candidate_digest!)}, signature = ${bytes(row.candidate_signature!)},
          signer_device_id = ${row.signer_device_id}, recipient_set_version = ${head.statement.recipientSetVersion}
          WHERE file_node_id = ${row.target_node_id} AND owner_id = ${row.owner_id} AND ${live}
            AND digest = ${bytes(row.head_digest)} AND revision = ${t.revision}
            AND content_key_id = ${row.target_key_id} AND content_epoch = ${row.target_epoch}
            AND ${unblocked(row.owner_id, row.target_node_id)}
            AND ${exactRecipientGuard(row.owner_id, row.target_node_id,
              [...expected, ...material.map((m) => ({ accountId: row.recipient_id,
                deviceId: m.device_id, registryEpoch: m.registry_epoch, publicKey: b64(m.transport_public_key),
                grants: [{ id: row.anticipated_grant_id, generation: 1 }] }))])}
            AND EXISTS (SELECT 1 FROM encryption_devices signer
              WHERE signer.id = ${row.signer_device_id} AND signer.account_id = ${row.owner_id}
                AND signer.state = 'active')`,
          sql`INSERT INTO file_device_envelopes (file_node_id, owner_id, recipient_id, device_id,
            revision, content_key_id, content_epoch, registry_epoch, ciphertext, digest)
            SELECT ${row.target_node_id}, ${row.owner_id}, ${row.recipient_id}, d.id, ${t.revision},
              ${row.target_key_id}, ${row.target_epoch}, registry.registry_epoch, m.ciphertext, m.digest
            FROM share_device_material m JOIN encryption_devices d ON d.id = m.device_id AND d.account_id = ${row.recipient_id}
            JOIN account_encryption_identities registry ON registry.account_id = d.account_id
            JOIN file_heads h ON h.file_node_id = ${row.target_node_id} AND h.owner_id = ${row.owner_id}
            WHERE m.share_id = ${shareId} AND ${live} AND ${stillEligible}
              AND h.digest = ${bytes(row.candidate_digest!)} AND h.recipient_set_version = ${head.statement.recipientSetVersion}`] : []),
      ]),
      sql`INSERT INTO provisioning_needs (grant_id, owner_id, recipient_id, device_id,
        generation, registry_epoch, created_at, updated_at)
        SELECT ${row.anticipated_grant_id}, ${row.owner_id}, ${row.recipient_id}, d.id,
          1, registry.registry_epoch, ${now}, ${now}
        FROM encryption_devices d JOIN account_encryption_identities registry ON registry.account_id = d.account_id
        WHERE d.account_id = ${row.recipient_id} AND d.state = 'active' AND ${live}
        AND (NOT EXISTS (SELECT 1 FROM grant_label_deliveries label
          WHERE label.grant_id = ${row.anticipated_grant_id} AND label.device_id = d.id)
          OR NOT EXISTS (SELECT 1 FROM ${row.target_kind === "directory" ? sql`grant_device_envelopes` : sql`file_device_envelopes`} cap
          WHERE ${row.target_kind === "directory" ? sql`cap.grant_id` : sql`cap.file_node_id`} = ${row.target_kind === "directory" ? row.anticipated_grant_id : row.target_node_id}
            AND cap.device_id = d.id))`,
      sql`DELETE FROM share_offer_labels WHERE share_id = ${shareId} AND ${live}`,
      sql`DELETE FROM share_device_material WHERE share_id = ${shareId} AND ${live}`,
      sql`DELETE FROM share_offers WHERE share_id = ${shareId} AND ${live}`,
      sql`DELETE FROM share_material WHERE share_id = ${shareId} AND ${live}`,
      sql`DELETE FROM shares WHERE id = ${shareId} AND recipient_id = ${auth.accountId} AND ${live}`,
      proofTime(auth),
    ];
    if (statement.length > 50) return invalid();
    const result = await atomicSqlBatch(env.DB, statement);
    return result[0]?.meta.changes === 1 ? json({ grantId: row.anticipated_grant_id,
      status: enabled && (row.target_kind === "directory" ? result[4]?.meta.changes === eligible.length :
        result[6]?.meta.changes === eligible.length) ? "ready" : "provisioning" }) : changed();
  } catch { return invalid(); }
}

/** Explicit ordered RESTRICT cleanup; no audit tombstone and no cascades. */
export async function cancelShare(env: Env, auth: AuthorizedDevice, shareId: string,
  decline: boolean): Promise<Response> {
  try {
    const role = decline ? sql`recipient_id` : sql`owner_id`;
    const guard = sql`EXISTS (SELECT 1 FROM shares WHERE id = ${shareId}
      AND ${role} = ${auth.accountId})`;
    const live = marker(auth);
    const result = await atomicSqlBatch(env.DB, [
      sql`INSERT INTO device_proof_uses (account_id, proof_id, session_id, expires_at)
        SELECT ${auth.accountId}, ${auth.proofId}, ${auth.sessionId}, ${auth.expiresAt}
        WHERE ${proof(auth)} AND ${guard}`,
      sql`DELETE FROM share_offer_labels WHERE share_id = ${shareId} AND ${live}`,
      sql`DELETE FROM share_device_material WHERE share_id = ${shareId} AND ${live}`,
      sql`DELETE FROM share_offers WHERE share_id = ${shareId} AND ${live}`,
      sql`DELETE FROM share_material WHERE share_id = ${shareId} AND ${live}`,
      sql`DELETE FROM shares WHERE id = ${shareId} AND ${role} = ${auth.accountId} AND ${live}`,
      proofTime(auth),
    ]);
    return result[0]?.meta.changes === 1 ? json({ status: decline ? "declined" : "cancelled" }) : absent();
  } catch { return invalid(); }
}

/** Immediate authorization cutoff is independent of any previously downloaded key.
 * The barrier seals new writes until ticket 19 installs *new* keys/receiving pairs.
 */
export async function updateGrant(env: Env, auth: AuthorizedDevice, grantId: string,
  leave: boolean, method: string, value: unknown): Promise<Response> {
  const changedPermission = method === "PATCH";
  const input = record(value);
  if (changedPermission && (!input || Object.keys(input).length !== 1 ||
      (input.permission !== "read_only" && input.permission !== "read_write"))) return invalid();
  const grant = await createDb(env.DB).get<{ owner_id: string; recipient_id: string; target_node_id: string;
    target_kind: string; permission: string; generation: number }>(sql`SELECT g.owner_id, g.recipient_id,
    g.target_node_id, g.target_kind, g.permission, g.generation FROM grants g WHERE g.id = ${grantId}
      AND ${leave ? sql`g.recipient_id` : sql`g.owner_id`} = ${auth.accountId} AND ${proof(auth)}`);
  if (!grant) return absent();
  if (changedPermission && grant.permission === input!.permission) return json({ status: "unchanged" });
  try {
    const live = marker(auth), now = Date.now();
    const barrierEpoch = grant.generation + 1;
    const result = await atomicSqlBatch(env.DB, [
      ...(changedPermission ? [sql`UPDATE grants SET permission = ${input!.permission},
        generation = generation + 1, updated_at = ${now}
        WHERE id = ${grantId} AND owner_id = ${auth.accountId} AND generation = ${grant.generation}
        AND ${proof(auth)}`] : [sql`INSERT INTO device_proof_uses (account_id, proof_id, session_id, expires_at)
        SELECT ${auth.accountId}, ${auth.proofId}, ${auth.sessionId}, ${auth.expiresAt}
        WHERE ${proof(auth)} AND EXISTS (SELECT 1 FROM grants WHERE id = ${grantId}
          AND recipient_id = ${grant.recipient_id} AND owner_id = ${grant.owner_id}
          AND generation = ${grant.generation})`]),
      ...(changedPermission ? [spent(auth)] : []),
      sql`INSERT INTO rotation_barriers (owner_id, target_node_id, epoch)
        SELECT ${grant.owner_id}, ${grant.target_node_id}, ${barrierEpoch} WHERE ${live}
        ON CONFLICT(owner_id, target_node_id) DO UPDATE SET epoch = max(epoch + 1, excluded.epoch)`,
      sql`DELETE FROM grant_device_envelopes WHERE grant_id = ${grantId} AND ${live}`,
      sql`DELETE FROM grant_retained_material WHERE grant_id = ${grantId} AND ${live}`,
      sql`DELETE FROM provisioning_needs WHERE grant_id = ${grantId} AND ${live}`,
      ...(!changedPermission ? [
        sql`DELETE FROM grant_label_deliveries WHERE grant_id = ${grantId} AND ${live}`,
        sql`DELETE FROM grant_labels WHERE grant_id = ${grantId} AND ${live}`,
        sql`DELETE FROM grants WHERE id = ${grantId} AND generation = ${grant.generation} AND ${live}`,
        sql`DELETE FROM file_device_envelopes WHERE file_node_id = ${grant.target_node_id}
          AND recipient_id = ${grant.recipient_id} AND ${grant.target_kind === "file"} AND ${live}
          AND NOT EXISTS (SELECT 1 FROM grants g WHERE g.owner_id = ${grant.owner_id}
            AND g.target_node_id = ${grant.target_node_id} AND g.recipient_id = ${grant.recipient_id}
            AND g.target_kind = 'file')`,
      ] : []),
      proofTime(auth),
    ]);
    return result[0]?.meta.changes === 1 ? json({ status: "rotation_pending" }) : changed();
  } catch { return invalid(); }
}

/** One query, bounded to 200 roots; no label/capability bytes for an unready root.
 * File representations remain on the separately guarded File-only resource.
 */
export async function roots(env: Env, auth: AuthorizedDevice): Promise<Response> {
  const rows = await createDb(env.DB).all<{ grant_id: string; owner_id: string; recipient_id: string;
    target_node_id: string; target_kind: "file" | "directory"; permission: "read_only" | "read_write";
    generation: number; label_id: string; label_ciphertext: ArrayBuffer | null; label_digest: ArrayBuffer | null;
    offer_bytes: ArrayBuffer; offer_digest: ArrayBuffer; offer_signature: ArrayBuffer;
    signer_public_key: ArrayBuffer; grant_ciphertext: ArrayBuffer | null; grant_digest: ArrayBuffer | null;
    target_key_id: string | null; target_epoch: number | null; directory_epoch: number | null;
    file_envelope: ArrayBuffer | null; file_digest: ArrayBuffer | null; file_registry_epoch: number | null;
    head_bytes: ArrayBuffer | null; head_digest: ArrayBuffer | null; head_signature: ArrayBuffer | null;
    head_signer_id: string | null; head_signer_public_key: ArrayBuffer | null; file_revision: number | null;
    file_content_key_id: string | null; file_content_epoch: number | null; head_recipient_set_version: number | null;
    blocked: number }>(sql`SELECT g.id AS grant_id, g.owner_id, g.recipient_id, g.target_node_id,
      g.target_kind, g.permission, g.generation, label.label_id,
      delivery.ciphertext AS label_ciphertext, delivery.digest AS label_digest,
      label.offer_bytes, label.offer_digest, label.offer_signature,
      offer_signer.assertion_public_key AS signer_public_key,
      cap.ciphertext AS grant_ciphertext, cap.digest AS grant_digest,
      cap.target_key_id, cap.target_epoch, directory.capability_epoch AS directory_epoch,
      filecap.ciphertext AS file_envelope, filecap.digest AS file_digest,
      filecap.registry_epoch AS file_registry_epoch,
      head.bytes AS head_bytes, head.digest AS head_digest, head.signature AS head_signature,
      head.signer_device_id AS head_signer_id, head_signer.assertion_public_key AS head_signer_public_key,
      head.revision AS file_revision, head.content_key_id AS file_content_key_id,
      head.content_epoch AS file_content_epoch, head.recipient_set_version AS head_recipient_set_version,
      CASE WHEN barrier.target_node_id IS NULL THEN 0 ELSE 1 END AS blocked
    FROM grants g JOIN grant_labels label ON label.grant_id = g.id
    JOIN encryption_devices offer_signer ON offer_signer.id = label.signer_device_id
    LEFT JOIN grant_label_deliveries delivery ON delivery.grant_id = g.id AND delivery.device_id = ${auth.deviceId}
    LEFT JOIN grant_device_envelopes cap ON cap.grant_id = g.id AND cap.device_id = ${auth.deviceId}
      AND cap.generation = g.generation
    LEFT JOIN directories directory ON directory.node_id = g.target_node_id AND directory.owner_id = g.owner_id
    LEFT JOIN file_heads head ON head.file_node_id = g.target_node_id AND head.owner_id = g.owner_id
    LEFT JOIN encryption_devices head_signer ON head_signer.id = head.signer_device_id
    LEFT JOIN file_device_envelopes filecap ON filecap.file_node_id = head.file_node_id
      AND filecap.device_id = ${auth.deviceId} AND filecap.recipient_id = ${auth.accountId}
    LEFT JOIN rotation_barriers barrier ON barrier.target_node_id = g.target_node_id AND barrier.owner_id = g.owner_id
    WHERE g.recipient_id = ${auth.accountId} AND ${privateReadGuard(auth)}
    ORDER BY g.created_at LIMIT 201`);
  if (rows.length > 200) return invalid();
  const result: object[] = [];
  for (const r of rows) {
    let ready = false, capability: { ciphertext: string; targetKeyId: string; targetEpoch: number;
      digest: string } | undefined;
    try {
      const offer = await verifyOffer(bytes(r.offer_bytes), bytes(r.offer_digest), bytes(r.offer_signature),
        bytes(r.signer_public_key));
      const expected = offer.devices.find((d) => d.deviceId === auth.deviceId && d.accountId === auth.accountId);
      if (offer.grantId !== r.grant_id || offer.ownerId !== r.owner_id || offer.targetId !== r.target_node_id ||
          offer.kind !== r.target_kind || offer.labelId !== r.label_id || !expected ||
          !r.label_ciphertext || !r.label_digest || r.blocked ||
          expected.labelDigest !== hex(bytes(r.label_digest)) ||
          !sameBytes(await digestBytes(bytes(r.label_ciphertext)), bytes(r.label_digest))) throw new Error("pending");
      if (r.target_kind === "directory") {
        if (!r.grant_ciphertext || !r.grant_digest || !r.target_key_id ||
            r.target_key_id !== r.target_node_id || r.directory_epoch !== r.target_epoch ||
            expected.contentDigest !== hex(bytes(r.grant_digest)) ||
            !sameBytes(await digestBytes(bytes(r.grant_ciphertext)), bytes(r.grant_digest))) throw new Error("pending");
        capability = { ciphertext: b64(r.grant_ciphertext), digest: b64(r.grant_digest),
          targetKeyId: r.target_key_id, targetEpoch: r.target_epoch! };
        ready = true;
      } else if (r.head_bytes && r.head_digest && r.head_signature && r.head_signer_id &&
          r.head_signer_public_key && r.file_envelope && r.file_digest &&
          r.file_registry_epoch === auth.registryEpoch) {
        const head = await verifyFileHead({ bytes: bytes(r.head_bytes), digest: bytes(r.head_digest),
          signature: bytes(r.head_signature) }, { ownerId: r.owner_id, vaultId: r.owner_id,
          fileId: r.target_node_id, signerDeviceId: r.head_signer_id,
          publicKey: bytes(r.head_signer_public_key), revision: r.file_revision! });
        if (head.statement.contentKey.id !== r.file_content_key_id ||
            head.statement.contentKey.epoch !== r.file_content_epoch ||
            head.statement.recipientSetVersion !== r.head_recipient_set_version ||
            !head.statement.recipients.some((d) => d.deviceId === auth.deviceId &&
              d.accountId === auth.accountId && d.registryEpoch === auth.registryEpoch &&
              sameBytes(d.envelopeDigest, bytes(r.file_digest!))) ||
            !sameBytes(await digestBytes(bytes(r.file_envelope)), bytes(r.file_digest))) throw new Error("pending");
        ready = true;
      }
      result.push({ grantId: r.grant_id, ownerId: r.owner_id, targetId: r.target_node_id,
        kind: r.target_kind, permission: r.permission, generation: r.generation,
        status: ready ? "ready" : "provisioning", labelId: r.label_id,
        labelCiphertext: ready ? b64(r.label_ciphertext!) : "",
        labelDigest: ready ? b64(r.label_digest!) : "",
        offerBytes: ready ? b64(r.offer_bytes) : "",
        offerDigest: ready ? b64(r.offer_digest) : "",
        offerSignature: ready ? b64(r.offer_signature) : "",
        signerPublicKey: ready ? b64(r.signer_public_key) : "",
        ...(ready && capability ? { capability } : {}) });
    } catch {
      result.push({ grantId: r.grant_id, ownerId: r.owner_id, targetId: r.target_node_id,
        kind: r.target_kind, permission: r.permission, generation: r.generation,
        status: "provisioning", labelId: "", labelCiphertext: "" });
    }
  }
  return json({ roots: result });
}
