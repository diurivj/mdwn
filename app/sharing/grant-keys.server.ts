import { createDb, sql } from "~/shared/db/client.server";
import { commitPrivateBatch, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { encodeTreeBytes } from "~/shared/tree/wire";
import { sharingWriteBlocked } from "./access.server";
import { activeRootCoverage, grantRootMatches, grantRootMatchesForEnvelope } from "./capability-coverage.server";
import { retireFulfilledNeeds } from "./provisioning-needs.server";
import { verifyGrantKeySignature, type GrantKeyContext } from "../shared/sharing/grant-keys";
import { readDeviceEnvelopePacket } from "./envelope-packet.server";
import { rotationDeliveryPermit } from "./rotation-data.server";
import { rootDeliveryAuthority } from "./delivery-authority.server";
import { liveGrant } from "./grant-lifetime.server";

const headers = { "Cache-Control": "no-store" };
const failure = (error: string, status: number) => Response.json({ error }, { status, headers });
const table = (kind: "shares" | "grants") => (kind === "shares" ? sql`shares` : sql`grants`);
const envelopes = (kind: "shares" | "grants") =>
  kind === "shares" ? sql`share_key_envelopes` : sql`grant_key_envelopes`;

/**
 * A pending Share beneath a write seal cannot be prepared until rotation
 * replaces the capability: say so explicitly instead of a generic conflict.
 * Each committing statement keeps its own in-CAS seal guard.
 */
export async function shareSealed(env: Env, kind: "shares" | "grants", nodeId: string) {
  if (kind !== "shares" || !(await createDb(env.DB).get(sql`SELECT 1 WHERE ${sharingWriteBlocked(nodeId)}`)))
    return null;
  return failure("key_rotation_required", 409);
}

type ContextRow = GrantKeyContext & { capabilityId: string | null; capabilityEpoch: number | null };
export async function contextFor(env: Env, auth: AuthorizedDevice, kind: "shares" | "grants", id: string) {
  return createDb(env.DB).get<ContextRow>(sql`SELECT s.id AS relationshipId, s.owner_id AS ownerId,
    s.recipient_id AS recipientId, s.target_id AS targetId, s.target_kind AS targetKind,
    CASE WHEN s.target_kind = 'directory' THEN s.target_id ELSE f.capability_id END AS capabilityId,
    max(CASE WHEN s.target_kind = 'directory' THEN d.key_epoch ELSE f.capability_epoch END, coalesce(b.key_epoch, 0)) AS capabilityEpoch,
    ${kind === "shares" ? sql`1` : sql`s.key_epoch`} AS grantKeyEpoch,
    owner_registry.registry_epoch AS ownerRegistryEpoch, recipient_registry.registry_epoch AS recipientRegistryEpoch
    FROM ${table(kind)} s LEFT JOIN files f ON f.node_id = s.target_id AND f.owner_id = s.owner_id
    LEFT JOIN directories d ON d.node_id = s.target_id AND d.owner_id = s.owner_id
    LEFT JOIN sharing_write_blocks b ON b.target_id = s.target_id
    JOIN account_encryption_identities owner_registry ON owner_registry.account_id = s.owner_id
    JOIN account_encryption_identities recipient_registry ON recipient_registry.account_id = s.recipient_id
    WHERE s.id = ${id} AND ${kind === "shares" ? sql`1` : liveGrant()} AND (s.owner_id = ${auth.accountId} OR
      ${kind === "grants" ? 1 : 0} AND s.recipient_id = ${auth.accountId}) AND ${privateReadGuard(auth)}`);
}

export async function readGrantKeys(
  env: Env,
  auth: AuthorizedDevice,
  kind: "shares" | "grants",
  id: string,
  cursor: string | null,
  missingOnly = false,
) {
  const context = await contextFor(env, auth, kind, id);
  if (!context) return failure("not_found", 404);
  const sealed = await shareSealed(env, kind, context.targetId);
  if (sealed) return sealed;
  if (!context.capabilityId || !context.capabilityEpoch) return failure("shared_content_provisioning_required", 409);
  if (context.ownerId === auth.accountId) {
    const devices = await createDb(env.DB).all<{ deviceId: string; transport_public_key: ArrayBuffer }>(sql`
      SELECT d.id AS deviceId, d.transport_public_key FROM encryption_devices d
      JOIN account_encryption_identities r ON r.account_id = d.account_id
      WHERE d.account_id = ${context.recipientId} AND d.state = 'active' AND d.id > ${cursor ?? ""}
        AND r.registry_epoch = ${context.recipientRegistryEpoch} AND ${privateReadGuard(auth)}
        AND EXISTS (SELECT 1 FROM ${table(kind)} s WHERE s.id = ${id} AND s.owner_id = ${auth.accountId}
          AND ${kind === "shares" ? sql`1` : liveGrant()}
          AND s.recipient_id = d.account_id AND ${grantRootMatches(context.capabilityId, context.capabilityEpoch)}
          AND ${kind === "shares" ? sql`1 = 1` : sql`s.key_epoch = ${context.grantKeyEpoch}`}
          AND ${missingOnly ? sql`NOT (${activeRootCoverage(sql`d.id`)})` : sql`1`})
      ORDER BY d.id LIMIT 21`);
    return Response.json(
      {
        ...context,
        devices: devices.slice(0, 20).map((device) => ({
          deviceId: device.deviceId,
          transportPublicKey: encodeTreeBytes(new Uint8Array(device.transport_public_key)),
        })),
        nextCursor: devices.length > 20 ? devices[19]!.deviceId : null,
      },
      { headers },
    );
  }
  if (cursor !== null) return failure("invalid_sharing_request", 400);
  const envelope = await createDb(env.DB).get<{
    capability_id: string;
    capability_epoch: number;
    grant_key_epoch: number;
    owner_registry_epoch: number;
    recipient_registry_epoch: number;
    ciphertext: ArrayBuffer;
    signature: ArrayBuffer;
    signer_device_id: string;
    assertion_public_key: ArrayBuffer;
  }>(sql`
    SELECT e.*, signer.assertion_public_key FROM grant_key_envelopes e
    JOIN grants s ON s.id = e.relationship_id JOIN encryption_devices signer ON signer.id = e.signer_device_id
    JOIN encryption_devices recipient ON recipient.id = e.device_id
    WHERE s.id = ${id} AND ${liveGrant()} AND s.recipient_id = ${auth.accountId} AND e.device_id = ${auth.deviceId}
      AND recipient.account_id = s.recipient_id AND recipient.state = 'active'
      AND signer.account_id IN (s.owner_id, s.recipient_id) AND e.grant_key_epoch = s.key_epoch
      AND ${grantRootMatchesForEnvelope()} AND ${privateReadGuard(auth)}`);
  if (!envelope) return failure("shared_content_provisioning_required", 409);
  return Response.json(
    {
      ...context,
      capabilityId: envelope.capability_id,
      capabilityEpoch: envelope.capability_epoch,
      grantKeyEpoch: envelope.grant_key_epoch,
      ownerRegistryEpoch: envelope.owner_registry_epoch,
      recipientRegistryEpoch: envelope.recipient_registry_epoch,
      deviceId: auth.deviceId,
      signerDeviceId: envelope.signer_device_id,
      signerPublicKey: encodeTreeBytes(new Uint8Array(envelope.assertion_public_key)),
      ciphertext: encodeTreeBytes(new Uint8Array(envelope.ciphertext)),
      signature: encodeTreeBytes(new Uint8Array(envelope.signature)),
    },
    { headers },
  );
}

export async function uploadGrantKeys(
  env: Env,
  auth: AuthorizedDevice,
  kind: "shares" | "grants",
  id: string,
  value: unknown,
  rotationJobId?: string,
) {
  const input = readDeviceEnvelopePacket(value);
  if (!input) return failure("invalid_sharing_request", 400);
  const context = await contextFor(env, auth, kind, id);
  if (
    !context ||
    !(await createDb(env.DB).get(sql`SELECT 1 FROM ${table(kind)} s
    WHERE s.id = ${id} AND ${kind === "shares" ? sql`1` : liveGrant()}
      AND ${rootDeliveryAuthority(auth, kind)} AND ${privateReadGuard(auth)}`))
  )
    return failure("not_found", 404);
  const sealed = await shareSealed(env, kind, context.targetId);
  if (sealed) return sealed;
  if (!context.capabilityId || !context.capabilityEpoch) return failure("shared_content_provisioning_required", 409);
  if (
    input.capabilityId !== context.capabilityId ||
    input.capabilityEpoch !== context.capabilityEpoch ||
    input.ownerRegistryEpoch !== context.ownerRegistryEpoch ||
    input.recipientRegistryEpoch !== context.recipientRegistryEpoch
  )
    return failure("sharing_changed", 409);
  const batch = input.envelopes;
  try {
    for (const envelope of batch) {
      if (
        !(await verifyGrantKeySignature(
          {
            ...context,
            deviceId: envelope.deviceId,
            signerDeviceId: auth.deviceId,
            ciphertext: envelope.ciphertext,
            signature: envelope.signature,
          },
          encodeTreeBytes(auth.assertionPublicKey),
        ))
      )
        return failure("invalid_sharing_request", 400);
    }
  } catch {
    return failure("invalid_sharing_request", 400);
  }
  const membership = sql.join(
    batch.map(
      (entry) => sql`EXISTS (SELECT 1 FROM encryption_devices d
    WHERE d.id = ${entry.deviceId} AND d.account_id = s.recipient_id AND d.state = 'active')`,
    ),
    sql` AND `,
  );
  const committed = await commitPrivateBatch(
    env,
    auth,
    (guard) => sql`
    UPDATE ${table(kind)} AS s SET ${kind === "shares" ? sql`created_at = created_at` : sql`updated_at = updated_at`}
    WHERE s.id = ${id} AND ${kind === "shares" ? sql`1` : liveGrant()}
      AND ${rootDeliveryAuthority(auth, kind)} AND ${grantRootMatches(context.capabilityId, context.capabilityEpoch)}
      AND ${kind === "shares" ? sql`1 = 1` : sql`s.key_epoch = ${context.grantKeyEpoch}`}
      AND EXISTS (SELECT 1 FROM account_encryption_identities r WHERE r.account_id = s.recipient_id
        AND r.registry_epoch = ${context.recipientRegistryEpoch})
      AND EXISTS (SELECT 1 FROM account_encryption_identities r WHERE r.account_id = s.owner_id
        AND r.registry_epoch = ${context.ownerRegistryEpoch}) AND ${membership}
      AND (NOT ${sharingWriteBlocked(context.targetId)} OR ${
        rotationJobId ? rotationDeliveryPermit(auth, rotationJobId, id) : sql`0`
      }) AND ${guard}`,
    (marker) => [
      sql`DELETE FROM ${envelopes(kind)} WHERE relationship_id = ${id} AND ${marker}
      AND (capability_id != ${context.capabilityId} OR capability_epoch != ${context.capabilityEpoch}
        OR grant_key_epoch != ${context.grantKeyEpoch}
        OR (${kind === "shares" ? 1 : 0} = 1 AND (owner_registry_epoch != ${context.ownerRegistryEpoch}
          OR recipient_registry_epoch != ${context.recipientRegistryEpoch})))`,
      ...batch.map(
        (entry) => sql`INSERT INTO ${envelopes(kind)} (relationship_id, device_id, capability_id, capability_epoch,
      grant_key_epoch, owner_registry_epoch, recipient_registry_epoch, ciphertext, signature, signer_device_id)
      SELECT ${id}, ${entry.deviceId}, ${context.capabilityId}, ${context.capabilityEpoch}, ${context.grantKeyEpoch},
        ${context.ownerRegistryEpoch}, ${context.recipientRegistryEpoch}, ${entry.bytes.ciphertext}, ${entry.bytes.signature}, ${auth.deviceId}
      WHERE ${marker} ON CONFLICT (relationship_id, device_id) DO UPDATE SET capability_id = excluded.capability_id,
        capability_epoch = excluded.capability_epoch, grant_key_epoch = excluded.grant_key_epoch,
        owner_registry_epoch = excluded.owner_registry_epoch, recipient_registry_epoch = excluded.recipient_registry_epoch,
        ciphertext = excluded.ciphertext, signature = excluded.signature, signer_device_id = excluded.signer_device_id
        WHERE ${kind === "shares" ? 1 : 0} = 1`,
      ),
      ...(kind === "grants" ? [retireFulfilledNeeds(id, marker)] : []),
    ],
  );
  return committed ? Response.json({ uploaded: batch.length }, { headers }) : failure("sharing_changed", 409);
}
