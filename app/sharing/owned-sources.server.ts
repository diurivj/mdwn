import type { SQL } from "drizzle-orm";
import { createDb, sql } from "~/shared/db/client.server";
import { privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { encodeTreeBytes } from "~/shared/tree/wire";

/**
 * Owner-side sources for delivering a Comment capability to recipient
 * devices. Both are returned only to the Owner's own authorized device; the
 * browser opens them locally and signs the delivery itself.
 */

/** Correlated `key_envelopes k`: the Owner's own current vault-recovery row for an object at an exact epoch. */
export function currentRecoveryEnvelope(ownerId: string | SQL, objectId: string | SQL, keyEpoch: number | SQL): SQL {
  return sql`k.account_id = ${ownerId} AND k.object_id = ${objectId} AND k.purpose = 'vault-recovery'
    AND k.recipient_id = 'vault-root' AND k.key_epoch = ${keyEpoch} AND k.superseded_at IS NULL`;
}

/** Correlated `import_comment_envelopes i`: an imported Historical thread's capability envelope at an exact capability and epoch. */
export function importedThreadEnvelope(
  threadId: string | SQL,
  capabilityId: string | SQL,
  capabilityEpoch: number | SQL,
): SQL {
  return sql`i.thread_id = ${threadId} AND i.capability_id = ${capabilityId} AND i.capability_epoch = ${capabilityEpoch}`;
}

/** Correlated `import_comment_envelopes i`: the row belongs to the named File and its thread to the same Owner. */
export function ownedImportedThreadEnvelope(ownerId: string | SQL, fileId: string | SQL): SQL {
  return sql`i.file_id = ${fileId} AND EXISTS (SELECT 1 FROM comment_threads t
    WHERE t.id = i.thread_id AND t.owner_id = ${ownerId})`;
}

export function recoverySource(ciphertext: ArrayBuffer) {
  return { kind: "recovery" as const, envelope: encodeTreeBytes(new Uint8Array(ciphertext)) };
}

/** The Owner-only wire source for an imported Historical thread: its envelope under the File capability key. */
export function importedThreadSource(ciphertext: ArrayBuffer) {
  return { kind: "import" as const, envelope: encodeTreeBytes(new Uint8Array(ciphertext)) };
}

/**
 * The Owner's source for one Comment capability: its vault-recovery envelope,
 * or else an imported Historical thread's envelope under the File capability
 * (the same row the Comments read serves in `import` mode). Null for anyone
 * but the Owner, or when neither exists.
 */
export async function ownedCommentSource(
  env: Env,
  auth: AuthorizedDevice,
  comment: { ownerId: string; objectId: string; purpose: string; capabilityId: string; capabilityEpoch: number },
) {
  if (comment.ownerId !== auth.accountId) return null;
  const db = createDb(env.DB);
  const recovery = await db.get<{ ciphertext: ArrayBuffer }>(sql`SELECT k.ciphertext FROM key_envelopes k
    WHERE ${currentRecoveryEnvelope(auth.accountId, comment.objectId, comment.capabilityEpoch)}
      AND ${privateReadGuard(auth)}`);
  if (recovery) return recoverySource(recovery.ciphertext);
  if (comment.purpose !== "private-comment-thread") return null;
  const imported = await db.get<{ ciphertext: ArrayBuffer }>(sql`SELECT i.ciphertext FROM import_comment_envelopes i
    JOIN comment_threads t ON t.id = i.thread_id AND t.owner_id = ${auth.accountId}
    WHERE ${importedThreadEnvelope(comment.objectId, comment.capabilityId, comment.capabilityEpoch)}
      AND ${privateReadGuard(auth)}`);
  return imported ? importedThreadSource(imported.ciphertext) : null;
}
