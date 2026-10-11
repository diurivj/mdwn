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

export type CommentRotationStaging = {
  private?: { threadId: string; commentId: string };
  publicHistory?: { epochId: string; commentId: string };
};

/** A pending Key-rotation job targeting the File, staging one Private-thread
 * Comment item and/or one Public audience-epoch (`public_history`) item exactly
 * as the rotation step writes them: the Private item names its thread in
 * `object_id`, the Public item names its epoch. */
export async function stageCommentRotation(owner: SharingAccount, fileId: string, staging: CommentRotationStaging) {
  const jobId = opaqueId(),
    now = Date.now();
  const items: D1PreparedStatement[] = [];
  if (staging.private)
    items.push(
      env.DB.prepare(`INSERT INTO key_rotation_items (job_id, object_id, kind, file_id, depth, state)
      VALUES (?, ?, 'private_comment', ?, 1, 'ready')`).bind(jobId, staging.private.threadId, fileId),
      env.DB.prepare(`INSERT INTO key_rotation_comment_items (job_id, thread_id, kind, record_id, revision,
      content_key_envelope) VALUES (?, ?, 'comment', ?, 1, X'01')`).bind(
        jobId,
        staging.private.threadId,
        staging.private.commentId,
      ),
    );
  if (staging.publicHistory)
    items.push(
      env.DB.prepare(`INSERT INTO key_rotation_items (job_id, object_id, kind, file_id, depth, state)
      VALUES (?, ?, 'public_history', ?, 1, 'ready')`).bind(jobId, staging.publicHistory.epochId, fileId),
      env.DB.prepare(`INSERT INTO key_rotation_comment_items (job_id, thread_id, kind, record_id, revision,
      content_key_envelope) VALUES (?, ?, 'comment', ?, 1, X'01')`).bind(
        jobId,
        staging.publicHistory.epochId,
        staging.publicHistory.commentId,
      ),
    );
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
    ...items,
  ]);
  return jobId;
}

/** Imported Historical Comment metadata for one Private-thread Comment. */
export async function stageImportCommentMeta(owner: SharingAccount, threadId: string, commentId: string) {
  await env.DB.prepare(`INSERT INTO import_comment_meta (comment_id, thread_id, owner_id, ciphertext)
    VALUES (?, ?, ?, X'01')`)
    .bind(commentId, threadId, owner.accountId)
    .run();
}

/** A pending Pseudonym-update job staging the given attribution contexts. */
export async function stagePseudonymItems(
  account: SharingAccount,
  items: { kind: "thread" | "publication"; recordId: string }[],
) {
  const now = Date.now(),
    jobId = opaqueId();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO crypto_jobs (id, account_id, device_id, kind, state, progress, created_at, updated_at)
      VALUES (?, ?, ?, 'pseudonym_update', 'pending', 0, ?, ?)`).bind(
      jobId,
      account.accountId,
      account.deviceId,
      now,
      now,
    ),
    ...items.map((item) =>
      item.kind === "thread"
        ? env.DB.prepare(`INSERT INTO pseudonym_update_items
        (job_id, kind, record_id, revision, ciphertext, content_key_envelope, content_key_epoch, created_at)
        VALUES (?, 'thread', ?, 1, X'01', X'01', 1, ?)`).bind(jobId, item.recordId, now)
        : env.DB.prepare(`INSERT INTO pseudonym_update_items
        (job_id, kind, record_id, revision, ciphertext, content_key_envelope, content_key_epoch, created_at)
        VALUES (?, 'publication', ?, 1, X'01', NULL, NULL, ?)`).bind(jobId, item.recordId, now),
    ),
  ]);
  return jobId;
}
