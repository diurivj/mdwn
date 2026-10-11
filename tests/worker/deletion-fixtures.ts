import { env } from "cloudflare:test";

import { opaqueId, type SharingAccount } from "./sharing-fixtures";

/**
 * Shared Hard-deletion fixtures: the real-D1 row count the deletion suites
 * assert with, and the explicit Comment-dependent staging rows those suites
 * populate at the storage seam.
 */

export async function count(table: string, where = "1", ...values: unknown[]) {
  return (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)
    .bind(...values)
    .first<{ n: number }>())!.n;
}

/** A pending Key-rotation job targeting the File, with one staged Comment item. */
export async function stageCommentRotation(owner: SharingAccount, fileId: string, threadId: string, commentId: string) {
  const jobId = opaqueId(),
    now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO crypto_jobs (id, account_id, device_id, kind, state, initiating_account_id,
      target_id, key_epoch, progress, created_at, updated_at)
      VALUES (?, ?, ?, 'key_rotation', 'pending', ?, ?, 2, 0, ?, ?)`).bind(
      jobId,
      owner.accountId,
      owner.deviceId,
      owner.accountId,
      fileId,
      now,
      now,
    ),
    env.DB.prepare(`INSERT INTO key_rotation_items (job_id, object_id, kind, file_id, depth, state)
      VALUES (?, ?, 'private_comment', ?, 1, 'ready')`).bind(jobId, threadId, fileId),
    env.DB.prepare(`INSERT INTO key_rotation_comment_items (job_id, thread_id, kind, record_id, revision,
      content_key_envelope) VALUES (?, ?, 'comment', ?, 1, X'01')`).bind(jobId, threadId, commentId),
  ]);
  return jobId;
}

/** Imported Historical Comment metadata for one Private-thread Comment. */
export async function stageImportCommentMeta(owner: SharingAccount, threadId: string, commentId: string) {
  await env.DB.prepare(`INSERT INTO import_comment_meta (comment_id, thread_id, owner_id, ciphertext)
    VALUES (?, ?, ?, X'01')`).bind(commentId, threadId, owner.accountId);
}
