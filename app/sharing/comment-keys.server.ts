import { createDb, sql } from "~/db/client.server";
import { commitPrivateBatch, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { encodeTreeBytes } from "~/tree/wire";
import { sharingWriteBlocked } from "./access.server";
import { verifyCommentKeySignature, type CommentKeyContext } from "./comment-keys";
import { contextFor } from "./grant-keys.server";
import { grantRootMatches, requiredGrantComments } from "./capability-coverage.server";
import type { GrantKeyContext } from "./grant-keys";
import { retireFulfilledNeeds } from "./provisioning-needs.server";
import { readDeviceEnvelopePacket } from "./envelope-packet.server";
import { rotationDeliveryPermit } from "./rotation-data.server";

const headers = { "Cache-Control": "no-store" };
const failure = (error: string, status: number) => Response.json({ error }, { status, headers });
type Kind = "shares" | "grants";
const relationships = (kind: Kind) => kind === "shares" ? sql`shares` : sql`grants`;
const envelopes = (kind: Kind) => kind === "shares" ? sql`share_comment_key_envelopes` : sql`grant_comment_key_envelopes`;
type CommentRow = { object_id: string; file_id: string; thread_id: string;
  purpose: "private-comment-thread" | "public-comment-audience-epoch"; publication_id: string | null;
  capability_id: string; capability_epoch: number };
const commentContext = (context: GrantKeyContext, row: CommentRow) => ({ ...context,
  objectId: row.object_id, fileId: row.file_id, threadId: row.thread_id, purpose: row.purpose,
  publicationId: row.publication_id, capabilityId: row.capability_id, capabilityEpoch: row.capability_epoch });

export async function listCommentKeys(env: Env, auth: AuthorizedDevice, kind: Kind, id: string, cursor: string | null) {
  const context = await contextFor(env, auth, kind, id);
  if (!context) return failure("not_found", 404);
  if (!context.capabilityId || !context.capabilityEpoch) return failure("shared_content_provisioning_required", 409);
  const rows = await createDb(env.DB).all<CommentRow>(sql`SELECT c.* FROM ${relationships(kind)} s
    JOIN sharing_comment_capabilities c ON c.object_id IN (SELECT object_id FROM (${requiredGrantComments()}))
    WHERE s.id = ${id} AND (s.owner_id = ${auth.accountId} OR s.recipient_id = ${auth.accountId})
      AND ${grantRootMatches(context.capabilityId, context.capabilityEpoch)}
      AND ${kind === "shares" ? sql`1 = 1` : sql`s.key_epoch = ${context.grantKeyEpoch}`}
      AND c.object_id > ${cursor ?? ""} AND ${privateReadGuard(auth)} ORDER BY c.object_id LIMIT 21`);
  return Response.json({ capabilities: rows.slice(0, 20).map((row) => commentContext(context, row)),
    nextCursor: rows.length > 20 ? rows[19]!.object_id : null }, { headers });
}

async function deliveryContext(env: Env, auth: AuthorizedDevice, kind: Kind, id: string, objectId: string) {
  const root = await contextFor(env, auth, kind, id);
  if (!root?.capabilityId || !root.capabilityEpoch) return null;
  const row = await createDb(env.DB).get<CommentRow>(sql`SELECT c.* FROM ${relationships(kind)} s
    JOIN sharing_comment_capabilities c ON c.object_id = ${objectId}
    WHERE s.id = ${id} AND (s.owner_id = ${auth.accountId} OR s.recipient_id = ${auth.accountId})
      AND ${grantRootMatches(root.capabilityId, root.capabilityEpoch)}
      AND ${kind === "shares" ? sql`1 = 1` : sql`s.key_epoch = ${root.grantKeyEpoch}`}
      AND c.object_id IN (SELECT object_id FROM (${requiredGrantComments()})) AND ${privateReadGuard(auth)}`);
  return row ? { root, comment: commentContext(root, row) } : null;
}

/** Correlated relationship s; bind current metadata AND the still-covered File. */
function commentMatches(context: CommentKeyContext) {
  return sql`EXISTS (SELECT 1 FROM (${requiredGrantComments()}) c
    WHERE c.object_id = ${context.objectId} AND c.file_id = ${context.fileId} AND c.thread_id = ${context.threadId}
      AND c.purpose = ${context.purpose} AND c.publication_id IS ${context.publicationId}
      AND c.capability_id = ${context.capabilityId} AND c.capability_epoch = ${context.capabilityEpoch})`;
}

export async function readCommentKey(env: Env, auth: AuthorizedDevice, kind: Kind, id: string,
  objectId: string, cursor: string | null, missingOnly = false) {
  const delivery = await deliveryContext(env, auth, kind, id, objectId);
  if (!delivery) return failure("not_found", 404);
  const { root, comment } = delivery;
  if (comment.ownerId === auth.accountId) {
    const devices = await createDb(env.DB).all<{ deviceId: string; transport_public_key: ArrayBuffer }>(sql`
      SELECT d.id AS deviceId, d.transport_public_key FROM ${relationships(kind)} s
      JOIN encryption_devices d ON d.account_id = s.recipient_id AND d.state = 'active'
      JOIN account_encryption_identities r ON r.account_id = d.account_id
      WHERE s.id = ${id} AND s.owner_id = ${auth.accountId} AND d.id > ${cursor ?? ""}
        AND r.registry_epoch = ${comment.recipientRegistryEpoch}
        AND ${grantRootMatches(root.capabilityId, root.capabilityEpoch)} AND ${commentMatches(comment)}
        AND ${kind === "shares" ? sql`1 = 1` : sql`s.key_epoch = ${comment.grantKeyEpoch}`}
        AND ${missingOnly ? sql`NOT EXISTS (SELECT 1 FROM grant_comment_key_envelopes e WHERE e.relationship_id = s.id
          AND e.device_id = d.id AND e.object_id = ${objectId} AND e.capability_id = ${comment.capabilityId}
          AND e.capability_epoch = ${comment.capabilityEpoch} AND e.grant_key_epoch = s.key_epoch)` : sql`1`}
        AND ${privateReadGuard(auth)} ORDER BY d.id LIMIT 21`);
    return Response.json({ ...comment, devices: devices.slice(0, 20).map((device) => ({ deviceId: device.deviceId,
      transportPublicKey: encodeTreeBytes(new Uint8Array(device.transport_public_key)) })),
      nextCursor: devices.length > 20 ? devices[19]!.deviceId : null }, { headers });
  }
  if (cursor !== null) return failure("invalid_sharing_request", 400);
  const row = await createDb(env.DB).get<{ owner_registry_epoch: number; recipient_registry_epoch: number;
    signer_device_id: string; assertion_public_key: ArrayBuffer; ciphertext: ArrayBuffer; signature: ArrayBuffer }>(sql`
    SELECT e.*, signer.assertion_public_key FROM grant_comment_key_envelopes e
    JOIN grants s ON s.id = e.relationship_id JOIN encryption_devices signer ON signer.id = e.signer_device_id
    WHERE s.id = ${id} AND s.recipient_id = ${auth.accountId} AND e.object_id = ${objectId} AND e.device_id = ${auth.deviceId}
      AND signer.account_id = s.owner_id AND e.grant_key_epoch = s.key_epoch
      AND e.capability_id = ${comment.capabilityId} AND e.capability_epoch = ${comment.capabilityEpoch}
      AND ${commentMatches(comment)} AND ${privateReadGuard(auth)}`);
  if (!row) return failure("secure_access_preparing", 409);
  return Response.json({ ...comment, ownerRegistryEpoch: row.owner_registry_epoch,
    recipientRegistryEpoch: row.recipient_registry_epoch, deviceId: auth.deviceId,
    signerDeviceId: row.signer_device_id, signerPublicKey: encodeTreeBytes(new Uint8Array(row.assertion_public_key)),
    ciphertext: encodeTreeBytes(new Uint8Array(row.ciphertext)), signature: encodeTreeBytes(new Uint8Array(row.signature)) }, { headers });
}

export async function uploadCommentKeys(env: Env, auth: AuthorizedDevice, kind: Kind, id: string, objectId: string, value: unknown, rotationJobId?: string) {
  const input = readDeviceEnvelopePacket(value);
  if (!input) return failure("invalid_sharing_request", 400);
  const delivery = await deliveryContext(env, auth, kind, id, objectId);
  if (!delivery || delivery.comment.ownerId !== auth.accountId) return failure("not_found", 404);
  const { root, comment } = delivery;
  if (input.capabilityId !== comment.capabilityId || input.capabilityEpoch !== comment.capabilityEpoch ||
      input.ownerRegistryEpoch !== auth.registryEpoch || input.recipientRegistryEpoch !== comment.recipientRegistryEpoch)
    return failure("sharing_changed", 409);
  const batch = input.envelopes;
  try {
    for (const envelope of batch) {
      if (!await verifyCommentKeySignature({ ...comment, deviceId: envelope.deviceId, signerDeviceId: auth.deviceId,
        ciphertext: envelope.ciphertext, signature: envelope.signature }, encodeTreeBytes(auth.assertionPublicKey)))
        return failure("invalid_sharing_request", 400);
    }
  } catch { return failure("invalid_sharing_request", 400); }
  const membership = sql.join(batch.map((entry) => sql`EXISTS (SELECT 1 FROM encryption_devices d
    WHERE d.id = ${entry.deviceId} AND d.account_id = s.recipient_id AND d.state = 'active')`), sql` AND `);
  const committed = await commitPrivateBatch(env, auth, (guard) => sql`
    UPDATE ${relationships(kind)} AS s SET ${kind === "shares" ? sql`created_at = created_at` : sql`updated_at = updated_at`}
    WHERE s.id = ${id} AND s.owner_id = ${auth.accountId} AND ${grantRootMatches(root.capabilityId, root.capabilityEpoch)}
      AND ${kind === "shares" ? sql`1 = 1` : sql`s.key_epoch = ${comment.grantKeyEpoch}`}
      AND ${commentMatches(comment)} AND ${membership}
      AND EXISTS (SELECT 1 FROM account_encryption_identities r WHERE r.account_id = s.recipient_id
        AND r.registry_epoch = ${comment.recipientRegistryEpoch})
      AND (NOT ${sharingWriteBlocked(comment.fileId)} OR ${rotationJobId
        ? rotationDeliveryPermit(auth, rotationJobId, id) : sql`0`}) AND ${guard}`, (marker) => [
    sql`DELETE FROM ${envelopes(kind)} WHERE relationship_id = ${id} AND object_id = ${objectId} AND ${marker}
      AND (capability_id != ${comment.capabilityId} OR capability_epoch != ${comment.capabilityEpoch}
        OR grant_key_epoch != ${comment.grantKeyEpoch}
        OR (${kind === "shares" ? 1 : 0} = 1 AND (owner_registry_epoch != ${comment.ownerRegistryEpoch}
          OR recipient_registry_epoch != ${comment.recipientRegistryEpoch})))`,
    ...batch.map((entry) => sql`INSERT INTO ${envelopes(kind)} (relationship_id, device_id, capability_id, capability_epoch,
      grant_key_epoch, owner_registry_epoch, recipient_registry_epoch, ciphertext, signature, signer_device_id, object_id)
      SELECT ${id}, ${entry.deviceId}, ${comment.capabilityId}, ${comment.capabilityEpoch}, ${comment.grantKeyEpoch},
        ${comment.ownerRegistryEpoch}, ${comment.recipientRegistryEpoch}, ${entry.bytes.ciphertext}, ${entry.bytes.signature}, ${auth.deviceId}, ${objectId}
      WHERE ${marker} ON CONFLICT (relationship_id, object_id, device_id) DO UPDATE SET capability_id = excluded.capability_id,
        capability_epoch = excluded.capability_epoch, grant_key_epoch = excluded.grant_key_epoch,
        owner_registry_epoch = excluded.owner_registry_epoch, recipient_registry_epoch = excluded.recipient_registry_epoch,
        ciphertext = excluded.ciphertext, signature = excluded.signature, signer_device_id = excluded.signer_device_id
        WHERE ${rotationJobId ? 0 : 1} = 1`),
    ...(kind === "grants" ? [retireFulfilledNeeds(id, marker)] : []),
  ]);
  return committed ? Response.json({ uploaded: batch.length }, { headers }) : failure("sharing_changed", 409);
}
