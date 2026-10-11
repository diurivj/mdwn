import type { SQL } from "drizzle-orm";
import { deletedPseudonymItems } from "~/account/pseudonym-items.server";
import { sql } from "~/shared/db/client.server";

/**
 * Comment-dependent Hard deletion (ticket 49). One module owns the dependent
 * selection and foreign-key-safe removal ordering of an authorized deletion
 * scope, so its callers name the scope they selected, never the Comment tables
 * or their order.
 *
 * Every statement is guarded by the caller's existing transaction marker: a
 * deletion that loses its authorization/namespace guard (or fails a later
 * statement of the same batch) removes nothing. The caller's batch must defer
 * foreign keys (as `commitTreeMutation` does): the epoch/thread cycle resolves
 * only at commit. Authorization, the selected-graph CAS, the atomic batch and
 * its scheduling stay with the callers, and broader File, Publication, Share,
 * Grant and Key-rotation lifecycle work remains theirs because it is not
 * Comment-dependent.
 */

/** The selected Files of one atomic File/Directory Hard deletion: every node ID
 * of the caller's authorized deletion snapshot. Comment dependents are keyed on
 * its Files, while a targeted Key-rotation job may name any selected node. */
export type CommentDependentFileScope = {
  ownerId: string;
  selectedNodeIds: readonly string[];
};

/**
 * Ordered, marker-guarded removals of every Comment-dependent row of the
 * selected Files: Key-rotation Comment staging, Comment sharing capabilities
 * and their Key envelopes, reports, staged pseudonym-update items, imported
 * Historical Comment metadata, Comments, thread attributions, thread and
 * audience-epoch Key envelopes, Public epoch link wrappers, retained epochs
 * and the threads themselves.
 *
 * `import_comment_meta` is File-scope-only: imported Historical Comments live
 * in a Private thread, which a Publication's Public-thread scope never selects.
 */
export function deletedCommentDependents(scope: CommentDependentFileScope, committed: SQL): readonly SQL[] {
  const { ownerId, selectedNodeIds } = scope;
  // One JSON snapshot (not one bound ID per node) keeps every statement within
  // D1's 100-parameter bound for up to the 500-node Directory cap.
  const nodes = sql`SELECT value FROM json_each(${JSON.stringify(selectedNodeIds)})`;
  const threads = sql`SELECT id FROM comment_threads WHERE file_id IN (${nodes}) AND owner_id = ${ownerId}`;
  const epochs = sql`SELECT e.id FROM comment_thread_epochs e JOIN comment_threads t ON t.id = e.thread_id
    WHERE t.file_id IN (${nodes}) AND t.owner_id = ${ownerId}`;
  return [
    // Comment items staged under the subtree's own Key-rotation jobs go first,
    // so the job rows their owner removes later cannot be referenced.
    sql`DELETE FROM key_rotation_comment_items WHERE (thread_id IN (${threads})
      OR job_id IN (SELECT id FROM crypto_jobs WHERE target_id IN (${nodes}))) AND ${committed}`,
    // Comment-sharing staging: Key-envelope wrappers reference their capability rows.
    sql`DELETE FROM share_comment_key_envelopes WHERE object_id IN
      (SELECT object_id FROM sharing_comment_capabilities WHERE file_id IN (${nodes}) AND owner_id = ${ownerId})
      AND ${committed}`,
    sql`DELETE FROM grant_comment_key_envelopes WHERE object_id IN
      (SELECT object_id FROM sharing_comment_capabilities WHERE file_id IN (${nodes}) AND owner_id = ${ownerId})
      AND ${committed}`,
    sql`DELETE FROM sharing_comment_capabilities WHERE file_id IN (${nodes}) AND owner_id = ${ownerId} AND ${committed}`,
    // Reports and staged Pseudonym-update items are explicit dependents;
    // `deletedCommentReports` and `deletedPseudonymItems` own those shapes.
    deletedCommentReports(sql`SELECT id FROM comments WHERE thread_id IN (${threads})`, committed),
    deletedPseudonymItems("thread", sql`SELECT id FROM thread_attributions WHERE thread_id IN (${threads})`, committed),
    // Historical Comment metadata belongs to an imported Private thread, so it
    // never applies to a Publication's Public-thread scope.
    sql`DELETE FROM import_comment_meta WHERE comment_id IN
      (SELECT id FROM comments WHERE thread_id IN (${threads})) AND ${committed}`,
    sql`DELETE FROM comments WHERE thread_id IN (${threads}) AND ${committed}`,
    sql`DELETE FROM thread_attributions WHERE thread_id IN (${threads}) AND ${committed}`,
    // Thread and audience-epoch Key envelopes, then the retained epochs' Public
    // link wrappers, then the epochs and the threads themselves.
    sql`DELETE FROM key_envelopes WHERE object_id IN (${threads}) AND account_id = ${ownerId} AND ${committed}`,
    sql`DELETE FROM key_envelopes WHERE object_id IN (${epochs}) AND account_id = ${ownerId} AND ${committed}`,
    sql`DELETE FROM public_comment_epoch_links WHERE epoch_id IN (${epochs}) AND ${committed}`,
    sql`DELETE FROM comment_thread_epochs WHERE thread_id IN (${threads}) AND ${committed}`,
    sql`DELETE FROM comment_threads WHERE file_id IN (${nodes}) AND owner_id = ${ownerId} AND ${committed}`,
  ];
}

/** The category-only reports of any set of Comments. The Comment foreign key
 * is RESTRICT, so every Comment-removal path deletes reports explicitly in the
 * same transaction; this helper is the one place that delete shape lives. */
export function deletedCommentReports(comments: SQL, marker: SQL): SQL {
  return sql`DELETE FROM public_comment_reports WHERE comment_id IN (${comments}) AND ${marker}`;
}
