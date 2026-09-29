import type { SQL } from "drizzle-orm";
import { hasEmptyBody, readAuthJsonText, record } from "~/auth/request.server";
import { inspectEnvelope } from "~/crypto/enc-v1";
import { HPKE_SUITE, SYMMETRIC_SUITE } from "~/crypto/enc-v1/format";
import { atomicSqlBatch, createDb, sql } from "~/db/client.server";
import { authorizePrivateRequest, coarseProofTime, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { directoryAccessGuard, fileAccessGuard, getEffectiveFileAccess, getEffectiveDirectoryAccess } from "./access.server";
import { assertFileHeadCommitTransition, assertExactFileRecipientDescriptors, verifyDirectFileRecipientEnvelope,
  verifyFileHead, type VerifiedFileHead } from "~/tree/file-head";
import { unblocked } from "~/tree/file-v2.server";
import { decodeTreeBytes, encodeTreeBytes, isV7 } from "~/tree/wire";
import { digestBytes, hex, inspectOfferEnvelope, sameBytes, verifyOffer, type Offer } from "./offer";

const headers = { "Cache-Control": "no-store" };
const absent = () => Response.json({ error: "not_found" }, { status: 404, headers });
const invalid = () => Response.json({ error: "invalid_sharing_request" }, { status: 400, headers });
const changed = () => Response.json({ error: "share_changed" }, { status: 409, headers });
const denied = () => Response.json({ error: "device_proof_required" }, { status: 403, headers });
const json = (value: object, status = 200) => Response.json(value, { status, headers });
const bytes = (value: ArrayBuffer | Uint8Array) => new Uint8Array(value);
const b64 = (value: ArrayBuffer | Uint8Array) => encodeTreeBytes(bytes(value));

/** A fresh invocation witness, never an old durable proof-use row, gates every
 * dependent statement. D1 batch is atomic; its final DELETE leaves no witness.
 * Each invocation gets its own random ID even when the caller replays a proof. */
export function proof(auth: AuthorizedDevice): SQL {
  const now = Date.now();
  return sql`${privateReadGuard(auth)} AND ${auth.expiresAt} > ${now} AND
    NOT EXISTS (SELECT 1 FROM device_proof_uses WHERE account_id = ${auth.accountId} AND proof_id = ${auth.proofId})`;
}
export function begin(auth: AuthorizedDevice, invocationId: string, eligibility: SQL): SQL {
  return sql`INSERT INTO sharing_write_witnesses (invocation_id, account_id, proof_id)
    SELECT ${invocationId}, ${auth.accountId}, ${auth.proofId} WHERE ${proof(auth)} AND ${eligibility}`;
}
export function marker(auth: AuthorizedDevice, invocationId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM sharing_write_witnesses WHERE invocation_id = ${invocationId}
    AND account_id = ${auth.accountId} AND proof_id = ${auth.proofId})`;
}
export function spent(auth: AuthorizedDevice, invocationId: string): SQL {
  return sql`INSERT INTO device_proof_uses (account_id, proof_id, session_id, expires_at)
    SELECT ${auth.accountId}, ${auth.proofId}, ${auth.sessionId}, ${auth.expiresAt}
    WHERE ${marker(auth, invocationId)}`;
}
export function proofTime(auth: AuthorizedDevice, invocationId: string): SQL {
  const day = coarseProofTime(Date.now());
  return sql`UPDATE encryption_devices SET last_proof_at = ${day}
    WHERE id = ${auth.deviceId} AND account_id = ${auth.accountId} AND ${marker(auth, invocationId)}
      AND (last_proof_at IS NULL OR last_proof_at < ${day})`;
}
export function finish(auth: AuthorizedDevice, invocationId: string): SQL {
  return sql`DELETE FROM sharing_write_witnesses WHERE invocation_id = ${invocationId}
    AND account_id = ${auth.accountId} AND proof_id = ${auth.proofId}`;
}
export function devicesMatch(accountId: string, devices: readonly { deviceId: string; registryEpoch: number;
  publicKeyHex: string }[]): SQL {
  const expected = JSON.stringify(devices);
  return sql`NOT EXISTS (SELECT 1 FROM encryption_devices d
      JOIN account_encryption_identities registry ON registry.account_id = d.account_id
      WHERE d.account_id = ${accountId} AND d.state = 'active'
      AND NOT EXISTS (SELECT 1 FROM json_each(${expected}) item
        WHERE json_extract(item.value, '$.deviceId') = d.id AND
          json_extract(item.value, '$.publicKeyHex') = hex(d.transport_public_key) AND
          json_extract(item.value, '$.registryEpoch') = registry.registry_epoch))
    AND NOT EXISTS (SELECT 1 FROM json_each(${expected}) item WHERE NOT EXISTS
      (SELECT 1 FROM encryption_devices d JOIN account_encryption_identities registry
        ON registry.account_id = d.account_id WHERE d.account_id = ${accountId}
        AND d.id = json_extract(item.value, '$.deviceId') AND d.state = 'active'
        AND hex(d.transport_public_key) = json_extract(item.value, '$.publicKeyHex')
        AND registry.registry_epoch = json_extract(item.value, '$.registryEpoch')))`;
}

export type Device = { device_id: string; registry_epoch: number; transport_public_key: ArrayBuffer };
export async function devices(env: Env, accountId: string): Promise<Device[]> {
  const rows = await createDb(env.DB).all<Device>(sql`SELECT d.id AS device_id, r.registry_epoch,
    d.transport_public_key FROM encryption_devices d JOIN account_encryption_identities r
      ON r.account_id = d.account_id WHERE d.account_id = ${accountId} AND d.state = 'active'
    ORDER BY d.id LIMIT 257`);
  if (rows.length > 256) throw new Error("device capacity exceeded");
  return rows;
}

export type Target = { owner_id: string; id: string; kind: "file" | "directory";
  target_key_id: string; target_epoch: number; revision: number; head_digest: ArrayBuffer;
  bytes: ArrayBuffer | null; signature: ArrayBuffer | null; signer_device_id: string | null;
  assertion_public_key: ArrayBuffer | null; receiving_public_key: ArrayBuffer | null;
  parent_envelope: ArrayBuffer | null; representation_id: string | null; content_key_id: string | null;
  content_epoch: number | null; recipient_set_version: number | null };
export async function target(env: Env, auth: AuthorizedDevice, targetId: string, kind: "file" | "directory"): Promise<Target | null> {
  if (kind === "directory") {
    return await createDb(env.DB).get<Target>(sql`SELECT n.owner_id, n.id, n.kind,
      n.id AS target_key_id, d.capability_epoch AS target_epoch,
      d.entries_revision AS revision, COALESCE(d.listing_digest, zeroblob(32)) AS head_digest,
      NULL AS bytes, NULL AS signature, NULL AS signer_device_id, NULL AS assertion_public_key,
      NULL AS receiving_public_key, NULL AS parent_envelope, NULL AS representation_id,
      NULL AS content_key_id, NULL AS content_epoch, NULL AS recipient_set_version
      FROM vault_nodes n JOIN directories d ON d.node_id = n.id AND d.owner_id = n.owner_id
      WHERE n.id = ${targetId} AND n.kind = 'directory' AND n.import_id IS NULL
        AND n.parent_node_id IS NOT NULL -- The hidden root is never shared.
        AND ${directoryAccessGuard(auth, auth.accountId, targetId, "share_manage")}`) ?? null;
  }
  return await createDb(env.DB).get<Target>(sql`SELECT n.owner_id, n.id, n.kind,
    h.content_key_id AS target_key_id, h.content_epoch AS target_epoch, h.revision,
    h.digest AS head_digest, h.bytes, h.signature, h.signer_device_id,
    signer.assertion_public_key, h.receiving_public_key, h.parent_envelope,
    h.representation_id, h.content_key_id, h.content_epoch, h.recipient_set_version
    FROM vault_nodes n JOIN file_heads h ON h.file_node_id = n.id AND h.owner_id = n.owner_id
    JOIN encryption_devices signer ON signer.id = h.signer_device_id
    WHERE n.id = ${targetId} AND n.kind = 'file' AND n.import_id IS NULL
      AND ${fileAccessGuard(auth, auth.accountId, targetId, "share_manage")}`) ?? null;
}
export async function verifiedTarget(t: Target): Promise<VerifiedFileHead> {
  if (!t.bytes || !t.signature || !t.assertion_public_key || !t.signer_device_id ||
      !t.parent_envelope || !t.receiving_public_key) throw new Error("not a v2 File");
  const head = await verifyFileHead({ bytes: bytes(t.bytes), digest: bytes(t.head_digest), signature: bytes(t.signature) },
    { ownerId: t.owner_id, vaultId: t.owner_id, fileId: t.id, revision: t.revision,
      signerDeviceId: t.signer_device_id, publicKey: bytes(t.assertion_public_key) });
  if (head.statement.contentKey.id !== t.content_key_id || head.statement.contentKey.epoch !== t.content_epoch ||
      head.statement.representation.id !== t.representation_id ||
      head.statement.recipientSetVersion !== t.recipient_set_version) throw new Error("inconsistent current head");
  return head;
}

export async function resolve(env: Env, auth: AuthorizedDevice, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || Object.keys(input).length !== 2 || typeof input.value !== "string" ||
      input.value.length > 256 || input.value.length < 1 ||
      (input.kind !== "handle" && input.kind !== "share-id")) return invalid();
  const row = await createDb(env.DB).get<{ id: string; registry_epoch: number }>(sql`
    SELECT a.id, r.registry_epoch FROM accounts a JOIN account_encryption_identities r ON r.account_id = a.id
    WHERE ${input.kind === "handle" ? sql`a.share_handle_lookup_token` : sql`a.share_id`} = ${input.value}
      AND a.id != ${auth.accountId} AND ${privateReadGuard(auth)}`);
  if (!row) return absent();
  try {
    const current = await devices(env, row.id);
    return json({ accountId: row.id, registryEpoch: row.registry_epoch,
      devices: current.map((d) => ({ deviceId: d.device_id, publicKey: b64(d.transport_public_key),
        registryEpoch: d.registry_epoch })) });
  } catch { return invalid(); }
}

export async function targetContext(env: Env, auth: AuthorizedDevice, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !isV7(input.targetId) || (input.kind !== "file" && input.kind !== "directory") ||
      !isV7(input.recipientId)) return invalid();
  const t = await target(env, auth, input.targetId, input.kind);
  if (!t || t.owner_id !== auth.accountId) return absent();
  try {
    if (t.kind === "directory") return json({ targetKeyId: t.target_key_id, targetEpoch: t.target_epoch,
      headDigest: b64(t.head_digest), revision: t.revision });
    const h = await verifiedTarget(t);
    const other = await createDb(env.DB).all<{ recipient_id: string; device_id: string; registry_epoch: number;
      transport_public_key: ArrayBuffer; grant_id: string; generation: number }>(sql`SELECT g.recipient_id,
      d.id AS device_id, r.registry_epoch, d.transport_public_key, g.id AS grant_id, g.generation
      FROM grants g JOIN encryption_devices d ON d.account_id = g.recipient_id AND d.state = 'active'
      JOIN account_encryption_identities r ON r.account_id = d.account_id WHERE g.owner_id = ${auth.accountId}
      AND g.target_node_id = ${t.id} AND g.target_kind = 'file' ORDER BY d.id, g.id LIMIT 4097`);
    if (other.length > 4096) return invalid();
    const map = new Map<string, { accountId: string; deviceId: string; registryEpoch: number;
      publicKey: string; grants: { id: string; generation: number }[] }>();
    for (const d of other) {
      const entry = map.get(d.device_id) ?? { accountId: d.recipient_id, deviceId: d.device_id,
        registryEpoch: d.registry_epoch, publicKey: b64(d.transport_public_key), grants: [] };
      entry.grants.push({ id: d.grant_id, generation: d.generation }); map.set(d.device_id, entry);
    }
    const recipients = [...map.values()].sort((a, b) => a.accountId.localeCompare(b.accountId) ||
      a.deviceId.localeCompare(b.deviceId));
    if (recipients.length > 256 || recipients.some((r) => r.grants.length > 16)) return invalid();
    assertExactFileRecipientDescriptors(h, await Promise.all(recipients.map(async (r) => ({
      accountId: r.accountId, deviceId: r.deviceId, registryEpoch: r.registryEpoch, grants: r.grants,
      publicKeyDigest: await digestBytes(decodeTreeBytes(r.publicKey, 65)) }))));
    return json({ targetKeyId: t.target_key_id, targetEpoch: t.target_epoch,
      headDigest: b64(t.head_digest), revision: t.revision, recipients,
      head: { bytes: b64(t.bytes!), digest: b64(t.head_digest), signature: b64(t.signature!),
        signerDeviceId: t.signer_device_id, signerPublicKey: b64(t.assertion_public_key!) } });
  } catch { return invalid(); }
}

// Scope root is a browser-only proof read. Pending Shares disclose no label or target ciphertext.
export async function scope(env: Env, auth: AuthorizedDevice, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !isV7(input.nodeId) || (input.kind !== "file" && input.kind !== "directory")) return invalid();
  const result = await createDb(env.DB).get<{ owner_id: string; parent_id: string | null;
    grant_id: string | null; target_kind: string | null; path: string | null; own: number;
    label_ciphertext: ArrayBuffer | null; label_digest: ArrayBuffer | null;
    capability_ciphertext: ArrayBuffer | null; capability_digest: ArrayBuffer | null;
    offer_bytes: ArrayBuffer | null; offer_digest: ArrayBuffer | null;
    offer_signature: ArrayBuffer | null; signer_public_key: ArrayBuffer | null;
    transport_public_key: ArrayBuffer | null; target_epoch: number | null }>(sql`
    WITH RECURSIVE lineage(id, kind, parent_node_id, owner_id, depth) AS (
      SELECT n.id, n.kind, n.parent_node_id, n.owner_id, 0 FROM vault_nodes n
        WHERE n.id = ${input.nodeId} AND n.kind = ${input.kind} AND n.import_id IS NULL
      UNION ALL
      SELECT p.id, p.kind, p.parent_node_id, p.owner_id, child.depth + 1
        FROM vault_nodes p JOIN lineage child ON p.id = child.parent_node_id
        WHERE child.depth < 100 AND p.kind = 'directory' AND p.import_id IS NULL
          AND p.owner_id = child.owner_id
    )
    SELECT n.owner_id, n.parent_node_id AS parent_id, g.id AS grant_id, g.target_kind,
      CASE WHEN g.target_kind = 'file' THEN NULL ELSE (
        SELECT json_group_array(sorted.id) FROM (SELECT id, depth FROM lineage ORDER BY depth DESC) sorted
          WHERE sorted.depth <= l.depth) END AS path,
      CASE WHEN n.owner_id = ${auth.accountId} THEN 1 ELSE 0 END AS own,
      label_delivery.ciphertext AS label_ciphertext, label_delivery.digest AS label_digest,
      cap.ciphertext AS capability_ciphertext, cap.digest AS capability_digest,
      offer.offer_bytes, offer.offer_digest,
      offer.offer_signature, signer.assertion_public_key AS signer_public_key,
      actor_device.transport_public_key, cap.target_epoch
    FROM lineage n JOIN account_encryption_identities identity ON identity.account_id = n.owner_id
      AND identity.root_directory_id IN (SELECT id FROM lineage WHERE parent_node_id IS NULL)
    JOIN lineage l ON l.owner_id = n.owner_id AND l.depth >= 0
    LEFT JOIN grants g ON g.owner_id = n.owner_id AND g.recipient_id = ${auth.accountId}
      AND g.target_node_id = l.id AND g.target_kind = l.kind
    LEFT JOIN grant_labels offer ON offer.grant_id = g.id
    LEFT JOIN encryption_devices signer ON signer.id = offer.signer_device_id
    LEFT JOIN encryption_devices actor_device ON actor_device.id = ${auth.deviceId}
      AND actor_device.account_id = ${auth.accountId} AND actor_device.state = 'active'
    LEFT JOIN grant_label_deliveries label_delivery ON label_delivery.grant_id = g.id
      AND label_delivery.device_id = ${auth.deviceId} AND label_delivery.registry_epoch = ${auth.registryEpoch}
    LEFT JOIN grant_device_envelopes cap ON cap.grant_id = g.id AND cap.device_id = ${auth.deviceId}
      AND cap.registry_epoch = ${auth.registryEpoch} AND cap.generation = g.generation
    LEFT JOIN directories directory ON directory.node_id = g.target_node_id AND directory.owner_id = n.owner_id
    WHERE n.depth = 0 AND ${privateReadGuard(auth)}
      AND (n.owner_id = ${auth.accountId} OR g.id IS NOT NULL)
      AND (g.target_kind IS NULL OR (g.target_kind = 'directory' AND cap.target_key_id = g.target_node_id
        AND cap.target_epoch = directory.capability_epoch AND label_delivery.ciphertext IS NOT NULL)
        OR (g.target_kind = 'file' AND l.depth = 0))
    ORDER BY CASE WHEN g.target_kind = 'directory' THEN 2 ELSE 1 END DESC, l.depth DESC LIMIT 1`);
  if (!result) {
    // A Grant whose material an epoch advance invalidated must still resolve to a minimal
    // opaque scope, so navigation reaches `roots` and shows the provisioning state rather
    // than a misleading "not found". Only opaque IDs and the path are returned; readiness
    // is decided by `roots`. No name, ciphertext or capability is disclosed.
    const fallback = await createDb(env.DB).get<{ owner_id: string; grant_id: string;
      target_kind: string; path: string | null }>(sql`
      WITH RECURSIVE lineage(id, kind, parent_node_id, owner_id, depth) AS (
        SELECT n.id, n.kind, n.parent_node_id, n.owner_id, 0 FROM vault_nodes n
          WHERE n.id = ${input.nodeId} AND n.kind = ${input.kind} AND n.import_id IS NULL
        UNION ALL
        SELECT p.id, p.kind, p.parent_node_id, p.owner_id, child.depth + 1
          FROM vault_nodes p JOIN lineage child ON p.id = child.parent_node_id
          WHERE child.depth < 100 AND p.kind = 'directory' AND p.import_id IS NULL
            AND p.owner_id = child.owner_id
      )
      SELECT n.owner_id, g.id AS grant_id, g.target_kind,
        (SELECT json_group_array(sorted.id) FROM (SELECT id, depth FROM lineage ORDER BY depth DESC) sorted
          WHERE sorted.depth <= l.depth) AS path
      FROM lineage n JOIN account_encryption_identities identity ON identity.account_id = n.owner_id
        AND identity.root_directory_id IN (SELECT id FROM lineage WHERE parent_node_id IS NULL)
      JOIN lineage l ON l.owner_id = n.owner_id AND l.depth >= 0
      JOIN grants g ON g.owner_id = n.owner_id AND g.recipient_id = ${auth.accountId}
        AND g.target_node_id = l.id AND g.target_kind = l.kind
      WHERE n.depth = 0 AND ${privateReadGuard(auth)} AND g.id IS NOT NULL
      ORDER BY CASE WHEN g.target_kind = 'directory' THEN 2 ELSE 1 END DESC, l.depth DESC LIMIT 1`);
    if (!fallback || fallback.target_kind !== "directory") return absent();
    const directory = await getEffectiveDirectoryAccess(env.DB, auth, fallback.owner_id, input.nodeId);
    const path: unknown = JSON.parse(fallback.path ?? "null");
    if (!directory || !Array.isArray(path) || path.length > 101 || path.at(-1) !== input.nodeId ||
        path.some((id) => !isV7(id))) return absent();
    return Response.json({ scope: "directory-grant", grantId: fallback.grant_id, path }, { headers });
  }
  if (result.own === 1) return Response.json({ scope: "owned" }, { headers });
  if (!result.grant_id || !isV7(result.grant_id)) return absent();
  const effective = input.kind === "file" ?
    await getEffectiveFileAccess(env.DB, auth, result.owner_id, input.nodeId) :
    await getEffectiveDirectoryAccess(env.DB, auth, result.owner_id, input.nodeId);
  if (!effective) return absent();
  const canEditMarkdown = "canEditMarkdown" in effective && effective.canEditMarkdown;
  const canCreateChild = ("canCreateChild" in effective && effective.canCreateChild) ||
    (input.kind === "file" && result.target_kind !== "file" && result.parent_id &&
      (await getEffectiveDirectoryAccess(env.DB, auth, result.owner_id, result.parent_id))?.canCreateChild === true);
  if (result.target_kind === "file") return Response.json({ scope: "direct-file",
    grantId: result.grant_id, canEditMarkdown }, { headers });
  try {
    if (!result.label_ciphertext || !result.label_digest || !result.capability_ciphertext ||
        !result.capability_digest || !result.offer_bytes || !result.offer_digest ||
        !result.offer_signature || !result.signer_public_key || !result.transport_public_key) return absent();
    const offer = await verifyOffer(bytes(result.offer_bytes), bytes(result.offer_digest),
      bytes(result.offer_signature), bytes(result.signer_public_key));
    const device = offer.devices.find((item) => item.accountId === auth.accountId && item.deviceId === auth.deviceId);
    if (!device || offer.grantId !== result.grant_id || offer.ownerId !== result.owner_id ||
        device.publicKeyDigest !== hex(await digestBytes(bytes(result.transport_public_key))) ||
        device.labelDigest !== hex(await digestBytes(bytes(result.label_ciphertext))) ||
        device.contentDigest !== hex(await digestBytes(bytes(result.capability_ciphertext))) ||
        !sameBytes(await digestBytes(bytes(result.label_ciphertext)), bytes(result.label_digest)) ||
        !sameBytes(await digestBytes(bytes(result.capability_ciphertext)), bytes(result.capability_digest))) return absent();
    inspectOfferEnvelope(bytes(result.capability_ciphertext), { purpose: "grant",
      vaultId: result.owner_id, objectId: result.grant_id ? offer.targetId : "",
      keyId: offer.targetKeyId, keyEpoch: result.target_epoch!, revision: 1,
      recipientId: auth.deviceId });
    const path: unknown = JSON.parse(result.path ?? "null");
    if (!Array.isArray(path) || path.length > 101 || path.at(-1) !== input.nodeId ||
        path.some((id) => !isV7(id))) return absent();
    return Response.json({ scope: "directory-grant", grantId: result.grant_id,
      path, canEditMarkdown, canCreateChild }, { headers });
  } catch { return absent(); }
}

export async function invitations(env: Env, auth: AuthorizedDevice, value?: unknown): Promise<Response> {
  const input = value === undefined ? {} : record(value);
  if (!input || Object.keys(input).some((key) => !["incomingCursor", "outgoingCursor", "grantsCursor"].includes(key)) ||
      [input.incomingCursor, input.outgoingCursor, input.grantsCursor]
        .some((cursor) => cursor !== undefined && !isV7(cursor))) return invalid();
  const inCursor = (input.incomingCursor as string | undefined) ?? "";
  const outCursor = (input.outgoingCursor as string | undefined) ?? "";
  const grantCursor = (input.grantsCursor as string | undefined) ?? "";
  const incoming =  await createDb(env.DB).all<{ id: string; target_kind: string; permission: string; created_at: number }>(sql`
    SELECT s.id, s.target_kind, s.permission, s.created_at FROM shares s JOIN share_offers o ON o.share_id = s.id
    WHERE s.recipient_id = ${auth.accountId} AND s.id > ${inCursor}
      AND ${privateReadGuard(auth)} ORDER BY s.id LIMIT 101`);
  const outgoing = await createDb(env.DB).all<{ id: string; target_node_id: string; target_kind: string;
    permission: string; created_at: number }>(sql`SELECT s.id, s.target_node_id, s.target_kind, s.permission, s.created_at
    FROM shares s JOIN share_offers o ON o.share_id = s.id WHERE s.owner_id = ${auth.accountId}
      AND s.id > ${outCursor} AND ${privateReadGuard(auth)} ORDER BY s.id LIMIT 101`);
  const grants = await createDb(env.DB).all<{ id: string; target_node_id: string; permission: string }>(sql`
    SELECT id, target_node_id, permission FROM grants WHERE owner_id = ${auth.accountId}
      AND id > ${grantCursor} AND ${privateReadGuard(auth)} ORDER BY id LIMIT 101`);
  const mapped = (r: { id: string; target_kind: string; permission: string; created_at: number }) =>
    ({ id: r.id, kind: r.target_kind, permission: r.permission, createdAt: r.created_at });
  return json({ incoming: incoming.slice(0, 100).map(mapped),
    outgoing: outgoing.slice(0, 100).map((r) => ({ ...mapped(r), targetId: r.target_node_id })),
    grants: grants.slice(0, 100).map((g) => ({ grantId: g.id, targetId: g.target_node_id, permission: g.permission })),
    next: { incomingCursor: incoming.length > 100 ? incoming[99]!.id : null,
      outgoingCursor: outgoing.length > 100 ? outgoing[99]!.id : null,
      grantsCursor: grants.length > 100 ? grants[99]!.id : null } });
}
