import type { SQL } from "drizzle-orm";
import { createDb, sql } from "~/db/client.server";
import type { AuthorizedDevice } from "~/device/proof.server";
import { requiredGrantComments } from "~/sharing/capability-coverage.server";
import { liveGrant } from "~/sharing/grant-lifetime.server";
import { encodeTreeBytes } from "~/tree/wire";

/**
 * The one read path for a Comment capability envelope, shared by Private
 * threads (ticket 21) and Public audience epochs (ticket 23). The caller
 * supplies an authority predicate that re-derives live access in the same
 * statement as the ciphertext; this module never caches or trusts a prior read.
 */

export type CommentEnvelope =
  | { mode: "owned"; keyEpoch: number; ciphertext: ArrayBuffer }
  | {
    mode: "grant"; grantId: string; ownerId: string; recipientId: string; targetId: string; targetKind: string;
    ownerRegistryEpoch: number; recipientRegistryEpoch: number; grantKeyEpoch: number;
    signerDeviceId: string; signerPublicKey: ArrayBuffer; ciphertext: ArrayBuffer; signature: ArrayBuffer;
  };

export async function readCommentEnvelope(
  env: Env, auth: AuthorizedDevice,
  input: {
    ownerId: string; objectId: string; capabilityId: string; capabilityEpoch: number;
    /** Purpose-bound authority SQL; must be evaluated with the ciphertext SELECT. */
    authority: SQL;
  },
): Promise<CommentEnvelope | null> {
  const { ownerId, objectId, capabilityId, capabilityEpoch, authority } = input;
  const db = createDb(env.DB);
  // Each envelope read re-derives live access in the same statement, so a
  // revocation between the thread read and this SELECT cannot serve ciphertext.
  if (ownerId === auth.accountId) {
    const row = await db.get<{ ciphertext: ArrayBuffer }>(sql`SELECT ciphertext FROM key_envelopes
      WHERE account_id = ${ownerId} AND purpose = 'vault-recovery' AND object_id = ${objectId}
        AND recipient_id = 'vault-root' AND key_epoch = ${capabilityEpoch} AND superseded_at IS NULL
        AND ${authority}`);
    return row ? { mode: "owned", keyEpoch: capabilityEpoch, ciphertext: row.ciphertext } : null;
  }
  const row = await db.get<{
    grant_id: string; owner_id: string; recipient_id: string; target_id: string;
    target_kind: string; owner_registry_epoch: number; recipient_registry_epoch: number;
    grant_key_epoch: number; signer_device_id: string; signer_public_key: ArrayBuffer;
    ciphertext: ArrayBuffer; signature: ArrayBuffer;
  }>(sql`
    SELECT s.id AS grant_id, s.owner_id, s.recipient_id, s.target_id, s.target_kind,
      e.owner_registry_epoch, e.recipient_registry_epoch, e.grant_key_epoch,
      e.signer_device_id, signer.assertion_public_key AS signer_public_key, e.ciphertext, e.signature
    FROM grants s JOIN grant_comment_key_envelopes e ON e.relationship_id = s.id
      AND e.object_id = ${objectId} AND e.device_id = ${auth.deviceId}
    JOIN encryption_devices signer ON signer.id = e.signer_device_id
    WHERE s.recipient_id = ${auth.accountId} AND ${liveGrant()}
      AND e.capability_id = ${capabilityId} AND e.capability_epoch = ${capabilityEpoch}
      AND e.grant_key_epoch = s.key_epoch AND e.object_id IN (SELECT object_id FROM (${requiredGrantComments()}))
      AND ${authority} LIMIT 1`);
  return row ? {
    mode: "grant", grantId: row.grant_id, ownerId: row.owner_id, recipientId: row.recipient_id,
    targetId: row.target_id, targetKind: row.target_kind, ownerRegistryEpoch: row.owner_registry_epoch,
    recipientRegistryEpoch: row.recipient_registry_epoch, grantKeyEpoch: row.grant_key_epoch,
    signerDeviceId: row.signer_device_id, signerPublicKey: row.signer_public_key,
    ciphertext: row.ciphertext, signature: row.signature,
  } : null;
}

/** The complete, signed envelope context a browser opens. A partial object would
 * silently break a recipient, so every field is always present. */
export function commentEnvelopeWire(envelope: CommentEnvelope, context: {
  purpose: "private-comment-thread" | "public-comment-audience-epoch";
  fileId: string; threadId: string; objectId: string; publicationId: string | null;
  capabilityId: string; capabilityEpoch: number; deviceId: string;
}) {
  if (envelope.mode === "owned") {
    return { mode: "owned" as const, keyEpoch: envelope.keyEpoch,
      ciphertext: encodeTreeBytes(new Uint8Array(envelope.ciphertext)) };
  }
  return { mode: "grant" as const, purpose: context.purpose, fileId: context.fileId,
    threadId: context.threadId, objectId: context.objectId, publicationId: context.publicationId,
    relationshipId: envelope.grantId, ownerId: envelope.ownerId, recipientId: envelope.recipientId,
    targetId: envelope.targetId, targetKind: envelope.targetKind,
    capabilityId: context.capabilityId, capabilityEpoch: context.capabilityEpoch,
    ownerRegistryEpoch: envelope.ownerRegistryEpoch, recipientRegistryEpoch: envelope.recipientRegistryEpoch,
    grantKeyEpoch: envelope.grantKeyEpoch, deviceId: context.deviceId, signerDeviceId: envelope.signerDeviceId,
    signerPublicKey: encodeTreeBytes(new Uint8Array(envelope.signerPublicKey)),
    ciphertext: encodeTreeBytes(new Uint8Array(envelope.ciphertext)),
    signature: encodeTreeBytes(new Uint8Array(envelope.signature)) };
}

/** The same envelope rules, batched over a Public thread's epochs so one read
 * stays well inside D1's per-invocation query budget regardless of how many
 * audience changes the thread has. Every row's capability identity is tied to
 * the epoch it claims, and the caller's authority is re-derived in the SELECT. */
export async function readCommentEnvelopes(
  env: Env, auth: AuthorizedDevice,
  input: {
    ownerId: string; threadId: string; publicationId: string;
    epochs: readonly { epochId: string }[];
    /** File-level live File-read authority; must be evaluated with the SELECT. */
    authority: SQL;
  },
): Promise<Map<string, CommentEnvelope>> {
  const { ownerId, threadId, publicationId, epochs, authority } = input;
  const envelopes = new Map<string, CommentEnvelope>();
  if (!epochs.length) return envelopes;
  const objectIds = sql`${sql.join(epochs.map((epoch) => sql`${epoch.epochId}`), sql`, `)}`;
  const db = createDb(env.DB);
  if (ownerId === auth.accountId) {
    const rows = await db.all<{ object_id: string; ciphertext: ArrayBuffer; key_epoch: number }>(sql`
      SELECT k.object_id AS object_id, k.ciphertext, k.key_epoch FROM key_envelopes k
      JOIN sharing_comment_capabilities c ON c.object_id = k.object_id AND c.thread_id = ${threadId}
        AND c.purpose = 'public-comment-audience-epoch' AND c.capability_epoch = k.key_epoch
        AND c.publication_id = ${publicationId}
      WHERE k.account_id = ${ownerId} AND k.purpose = 'vault-recovery' AND k.recipient_id = 'vault-root'
        AND k.superseded_at IS NULL AND k.object_id IN (${objectIds}) AND ${authority}`);
    for (const row of rows) envelopes.set(row.object_id,
      { mode: "owned", keyEpoch: row.key_epoch, ciphertext: row.ciphertext });
    return envelopes;
  }
  const rows = await db.all<{
    object_id: string; grant_id: string; owner_id: string; recipient_id: string; target_id: string;
    target_kind: string; owner_registry_epoch: number; recipient_registry_epoch: number;
    grant_key_epoch: number; signer_device_id: string; signer_public_key: ArrayBuffer;
    ciphertext: ArrayBuffer; signature: ArrayBuffer;
  }>(sql`
    SELECT e.object_id AS object_id, s.id AS grant_id, s.owner_id, s.recipient_id, s.target_id, s.target_kind,
      e.owner_registry_epoch, e.recipient_registry_epoch, e.grant_key_epoch,
      e.signer_device_id, signer.assertion_public_key AS signer_public_key, e.ciphertext, e.signature
    FROM grants s JOIN grant_comment_key_envelopes e ON e.relationship_id = s.id
      AND e.device_id = ${auth.deviceId} AND e.object_id IN (${objectIds})
    JOIN encryption_devices signer ON signer.id = e.signer_device_id
    JOIN sharing_comment_capabilities c ON c.object_id = e.object_id AND c.thread_id = ${threadId}
      AND c.purpose = 'public-comment-audience-epoch' AND c.capability_id = e.capability_id
      AND c.capability_epoch = e.capability_epoch AND c.publication_id = ${publicationId}
    WHERE s.recipient_id = ${auth.accountId} AND ${liveGrant()} AND e.grant_key_epoch = s.key_epoch
      AND e.object_id IN (SELECT object_id FROM (${requiredGrantComments()})) AND ${authority}`);
  for (const row of rows) envelopes.set(row.object_id, {
    mode: "grant", grantId: row.grant_id, ownerId: row.owner_id, recipientId: row.recipient_id,
    targetId: row.target_id, targetKind: row.target_kind, ownerRegistryEpoch: row.owner_registry_epoch,
    recipientRegistryEpoch: row.recipient_registry_epoch, grantKeyEpoch: row.grant_key_epoch,
    signerDeviceId: row.signer_device_id, signerPublicKey: row.signer_public_key,
    ciphertext: row.ciphertext, signature: row.signature });
  return envelopes;
}
