import { record } from "~/auth/request.server";
import { createDb, sql } from "~/db/client.server";
import { commitPrivateBatch, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { decodeTreeBytes, encodeTreeBytes, isV7 } from "~/tree/wire";
import { sharingWriteBlocked } from "./access.server";
import { verifyGrantKeySignature, type GrantKeyContext } from "./grant-keys";

const headers = { "Cache-Control": "no-store" };
const failure = (error: string, status: number) => Response.json({ error }, { status, headers });
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const table = (kind: "shares" | "grants") => kind === "shares" ? sql`shares` : sql`grants`;
const envelopes = (kind: "shares" | "grants") => kind === "shares" ? sql`share_key_envelopes` : sql`grant_key_envelopes`;

/** Correlated against relationship alias s; directories remain epoch 1 until rotation. */
export function grantRootMatches(capabilityId: string, capabilityEpoch: number) {
  return sql`((s.target_kind = 'directory' AND s.target_id = ${capabilityId} AND ${capabilityEpoch} = 1)
    OR (s.target_kind = 'file' AND EXISTS (SELECT 1 FROM files f WHERE f.node_id = s.target_id
      AND f.owner_id = s.owner_id AND f.capability_id = ${capabilityId} AND f.capability_epoch = ${capabilityEpoch})))`;
}

/** Every current recipient device needs a current pending snapshot and active Owner signer. */
export function pendingGrantCoverage(auth: AuthorizedDevice) {
  return sql`EXISTS (SELECT 1 FROM encryption_devices d WHERE d.account_id = s.recipient_id AND d.state = 'active')
    AND NOT EXISTS (SELECT 1 FROM encryption_devices d WHERE d.account_id = s.recipient_id AND d.state = 'active'
      AND NOT EXISTS (SELECT 1 FROM share_key_envelopes e JOIN encryption_devices signer ON signer.id = e.signer_device_id
        JOIN account_encryption_identities owner_registry ON owner_registry.account_id = s.owner_id
        WHERE e.relationship_id = s.id AND e.device_id = d.id AND e.grant_key_epoch = 1
          AND e.recipient_registry_epoch = ${auth.registryEpoch}
          AND e.owner_registry_epoch = owner_registry.registry_epoch
          AND signer.account_id = s.owner_id AND signer.state = 'active'
          AND ${grantRootMatchesForEnvelope()}))`;
}
function grantRootMatchesForEnvelope() {
  return sql`((s.target_kind = 'directory' AND e.capability_id = s.target_id AND e.capability_epoch = 1)
    OR (s.target_kind = 'file' AND EXISTS (SELECT 1 FROM files f WHERE f.node_id = s.target_id
      AND f.owner_id = s.owner_id AND f.capability_id = e.capability_id AND f.capability_epoch = e.capability_epoch)))`;
}

type ContextRow = GrantKeyContext & { capabilityId: string | null; capabilityEpoch: number | null };
async function contextFor(env: Env, auth: AuthorizedDevice, kind: "shares" | "grants", id: string) {
  return createDb(env.DB).get<ContextRow>(sql`SELECT s.id AS relationshipId, s.owner_id AS ownerId,
    s.recipient_id AS recipientId, s.target_id AS targetId, s.target_kind AS targetKind,
    CASE WHEN s.target_kind = 'directory' THEN s.target_id ELSE f.capability_id END AS capabilityId,
    CASE WHEN s.target_kind = 'directory' THEN 1 ELSE f.capability_epoch END AS capabilityEpoch,
    ${kind === "shares" ? sql`1` : sql`s.key_epoch`} AS grantKeyEpoch,
    owner_registry.registry_epoch AS ownerRegistryEpoch, recipient_registry.registry_epoch AS recipientRegistryEpoch
    FROM ${table(kind)} s LEFT JOIN files f ON f.node_id = s.target_id AND f.owner_id = s.owner_id
    JOIN account_encryption_identities owner_registry ON owner_registry.account_id = s.owner_id
    JOIN account_encryption_identities recipient_registry ON recipient_registry.account_id = s.recipient_id
    WHERE s.id = ${id} AND (s.owner_id = ${auth.accountId} OR
      ${kind === "grants" ? 1 : 0} AND s.recipient_id = ${auth.accountId}) AND ${privateReadGuard(auth)}`);
}

export async function readGrantKeys(env: Env, auth: AuthorizedDevice, kind: "shares" | "grants", id: string, cursor: string | null) {
  const context = await contextFor(env, auth, kind, id);
  if (!context) return failure("not_found", 404);
  if (!context.capabilityId || !context.capabilityEpoch) return failure("shared_content_provisioning_required", 409);
  if (context.ownerId === auth.accountId) {
    const devices = await createDb(env.DB).all<{ deviceId: string; transport_public_key: ArrayBuffer }>(sql`
      SELECT d.id AS deviceId, d.transport_public_key FROM encryption_devices d
      JOIN account_encryption_identities r ON r.account_id = d.account_id
      WHERE d.account_id = ${context.recipientId} AND d.state = 'active' AND d.id > ${cursor ?? ""}
        AND r.registry_epoch = ${context.recipientRegistryEpoch} AND ${privateReadGuard(auth)}
        AND EXISTS (SELECT 1 FROM ${table(kind)} s WHERE s.id = ${id} AND s.owner_id = ${auth.accountId}
          AND s.recipient_id = d.account_id AND ${grantRootMatches(context.capabilityId, context.capabilityEpoch)}
          AND ${kind === "shares" ? sql`1 = 1` : sql`s.key_epoch = ${context.grantKeyEpoch}`})
      ORDER BY d.id LIMIT 21`);
    return Response.json({ ...context, devices: devices.slice(0, 20).map((device) => ({ deviceId: device.deviceId,
      transportPublicKey: encodeTreeBytes(new Uint8Array(device.transport_public_key)) })),
      nextCursor: devices.length > 20 ? devices[19]!.deviceId : null }, { headers });
  }
  if (cursor !== null) return failure("invalid_sharing_request", 400);
  const envelope = await createDb(env.DB).get<{ capability_id: string; capability_epoch: number; grant_key_epoch: number;
    owner_registry_epoch: number; recipient_registry_epoch: number; ciphertext: ArrayBuffer; signature: ArrayBuffer;
    signer_device_id: string; assertion_public_key: ArrayBuffer }>(sql`
    SELECT e.*, signer.assertion_public_key FROM grant_key_envelopes e
    JOIN grants s ON s.id = e.relationship_id JOIN encryption_devices signer ON signer.id = e.signer_device_id
    JOIN encryption_devices recipient ON recipient.id = e.device_id
    WHERE s.id = ${id} AND s.recipient_id = ${auth.accountId} AND e.device_id = ${auth.deviceId}
      AND recipient.account_id = s.recipient_id AND recipient.state = 'active'
      AND signer.account_id = s.owner_id AND e.grant_key_epoch = s.key_epoch
      AND ${grantRootMatchesForEnvelope()} AND ${privateReadGuard(auth)}`);
  if (!envelope) return failure("shared_content_provisioning_required", 409);
  return Response.json({ ...context, capabilityId: envelope.capability_id, capabilityEpoch: envelope.capability_epoch,
    grantKeyEpoch: envelope.grant_key_epoch, ownerRegistryEpoch: envelope.owner_registry_epoch,
    recipientRegistryEpoch: envelope.recipient_registry_epoch, deviceId: auth.deviceId,
    signerDeviceId: envelope.signer_device_id, signerPublicKey: encodeTreeBytes(new Uint8Array(envelope.assertion_public_key)),
    ciphertext: encodeTreeBytes(new Uint8Array(envelope.ciphertext)), signature: encodeTreeBytes(new Uint8Array(envelope.signature)) }, { headers });
}

export async function uploadGrantKeys(env: Env, auth: AuthorizedDevice, kind: "shares" | "grants", id: string, value: unknown) {
  const input = record(value);
  if (!input || !exact(input, ["capabilityId", "capabilityEpoch", "ownerRegistryEpoch", "recipientRegistryEpoch", "envelopes"]) ||
      !isV7(input.capabilityId) || ![input.capabilityEpoch, input.ownerRegistryEpoch, input.recipientRegistryEpoch]
        .every((epoch) => typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch > 0) ||
      !Array.isArray(input.envelopes) || input.envelopes.length < 1 || input.envelopes.length > 20) return failure("invalid_sharing_request", 400);
  const context = await contextFor(env, auth, kind, id);
  if (!context || context.ownerId !== auth.accountId) return failure("not_found", 404);
  if (!context.capabilityId || !context.capabilityEpoch) return failure("shared_content_provisioning_required", 409);
  if (input.capabilityId !== context.capabilityId || input.capabilityEpoch !== context.capabilityEpoch ||
      input.ownerRegistryEpoch !== auth.registryEpoch || input.recipientRegistryEpoch !== context.recipientRegistryEpoch)
    return failure("sharing_changed", 409);
  const batch: { deviceId: string; ciphertext: Uint8Array<ArrayBuffer>; signature: Uint8Array<ArrayBuffer> }[] = [];
  try {
    for (const item of input.envelopes) {
      const envelope = record(item);
      if (!envelope || !exact(envelope, ["deviceId", "ciphertext", "signature"]) || !isV7(envelope.deviceId) ||
          typeof envelope.ciphertext !== "string" || typeof envelope.signature !== "string" ||
          batch.some((entry) => entry.deviceId === envelope.deviceId) ||
          !await verifyGrantKeySignature({ ...context, deviceId: envelope.deviceId, signerDeviceId: auth.deviceId,
            ciphertext: envelope.ciphertext, signature: envelope.signature }, encodeTreeBytes(auth.assertionPublicKey)))
        return failure("invalid_sharing_request", 400);
      batch.push({ deviceId: envelope.deviceId, ciphertext: decodeTreeBytes(envelope.ciphertext, 16_384),
        signature: decodeTreeBytes(envelope.signature, 64) });
    }
  } catch { return failure("invalid_sharing_request", 400); }
  const membership = sql.join(batch.map((entry) => sql`EXISTS (SELECT 1 FROM encryption_devices d
    WHERE d.id = ${entry.deviceId} AND d.account_id = s.recipient_id AND d.state = 'active')`), sql` AND `);
  const committed = await commitPrivateBatch(env, auth, (guard) => sql`
    UPDATE ${table(kind)} AS s SET ${kind === "shares" ? sql`created_at = created_at` : sql`updated_at = updated_at`}
    WHERE s.id = ${id} AND s.owner_id = ${auth.accountId} AND ${grantRootMatches(context.capabilityId, context.capabilityEpoch)}
      AND ${kind === "shares" ? sql`1 = 1` : sql`s.key_epoch = ${context.grantKeyEpoch}`}
      AND EXISTS (SELECT 1 FROM account_encryption_identities r WHERE r.account_id = s.recipient_id
        AND r.registry_epoch = ${context.recipientRegistryEpoch}) AND ${membership}
      AND NOT ${sharingWriteBlocked(context.targetId)} AND ${guard}`, (marker) => [
    sql`DELETE FROM ${envelopes(kind)} WHERE relationship_id = ${id} AND ${marker}
      AND (capability_id != ${context.capabilityId} OR capability_epoch != ${context.capabilityEpoch}
        OR grant_key_epoch != ${context.grantKeyEpoch}
        OR (${kind === "shares" ? 1 : 0} = 1 AND (owner_registry_epoch != ${context.ownerRegistryEpoch}
          OR recipient_registry_epoch != ${context.recipientRegistryEpoch})))`,
    ...batch.map((entry) => sql`INSERT INTO ${envelopes(kind)} (relationship_id, device_id, capability_id, capability_epoch,
      grant_key_epoch, owner_registry_epoch, recipient_registry_epoch, ciphertext, signature, signer_device_id)
      SELECT ${id}, ${entry.deviceId}, ${context.capabilityId}, ${context.capabilityEpoch}, ${context.grantKeyEpoch},
        ${context.ownerRegistryEpoch}, ${context.recipientRegistryEpoch}, ${entry.ciphertext}, ${entry.signature}, ${auth.deviceId}
      WHERE ${marker} ON CONFLICT (relationship_id, device_id) DO UPDATE SET capability_id = excluded.capability_id,
        capability_epoch = excluded.capability_epoch, grant_key_epoch = excluded.grant_key_epoch,
        owner_registry_epoch = excluded.owner_registry_epoch, recipient_registry_epoch = excluded.recipient_registry_epoch,
        ciphertext = excluded.ciphertext, signature = excluded.signature, signer_device_id = excluded.signer_device_id`),
  ]);
  return committed ? Response.json({ uploaded: batch.length }, { headers }) : failure("sharing_changed", 409);
}
