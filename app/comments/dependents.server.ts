import type { SQL } from "drizzle-orm";
import { deletedPseudonymItems } from "~/account/pseudonym-items.server";
import { sql } from "~/shared/db/client.server";

/**
 * Comment-dependent Hard deletion (tickets 49 and 50). One module owns the
 * dependent selection and foreign-key-safe removal ordering of an authorized
 * deletion scope, so its File/Directory and Publication callers name the scope
 * they selected, never the Comment tables or their order.
 *
 * Every statement is guarded by the caller's existing transaction marker: a
 * deletion that loses its authorization/namespace guard (or fails a later
 * statement of the same batch) removes nothing. The caller's batch must defer
 * foreign keys (as `commitTreeMutation` and `commitPrivateBatch` do): the
 * epoch/thread cycle resolves only at commit. Authorization, the selected-graph
 * CAS, the atomic batch and its scheduling stay with the callers, and broader
 * File, Publication, Share, Grant and Key-rotation lifecycle work remains
 * theirs because it is not Comment-dependent.
 */

/** The selected Files of one atomic File/Directory Hard deletion: every node ID
 * of the caller's authorized deletion snapshot. Comment dependents are keyed on
 * its Files, while a targeted Key-rotation job may name any selected node. */
export type CommentDependentFileScope = {
  kind: "file";
  ownerId: string;
  selectedNodeIds: readonly string[];
};

/** One Publication's Public thread: the only Comment scope Unpublishing tears
 * down. Selecting by `publication_id` and `purpose = 'public'` can never name
 * the File's Private thread. */
export type CommentDependentPublicationScope = {
  kind: "publication";
  ownerId: string;
  publicationId: string;
};

/** The domain scope of one authorized deletion: selected Files or one
 * Publication's Public thread. */
export type CommentDependentScope = CommentDependentFileScope | CommentDependentPublicationScope;

/**
 * Ordered, marker-guarded removals of every Comment-dependent row in the
 * caller's scope, in the foreign-key-safe order that scope requires. The
 * callers keep authorization, the transaction, its scheduling and every
 * non-Comment statement.
 */
export function deletedCommentDependents(scope: CommentDependentScope, committed: SQL): readonly SQL[] {
  return scope.kind === "publication"
    ? deletedPublicationCommentDependents(scope, committed)
    : deletedFileCommentDependents(scope, committed);
}

/**
 * One bounded Unpublishing batch: at most `limit` Comments of the Publication's
 * Public thread, each with its reports, in Comment sequence order. The caller
 * keeps the limit, the repetition until none remain and the final completion
 * step; only this module knows which Comments and dependents a batch names.
 */
export function deletedCommentBatch(
  scope: CommentDependentPublicationScope,
  limit: number,
  committed: SQL,
): readonly SQL[] {
  const { ownerId, publicationId } = scope;
  const comments = sql`SELECT c.id FROM comments c JOIN comment_threads t ON t.id = c.thread_id
    WHERE t.publication_id = ${publicationId} AND t.purpose = 'public' AND t.owner_id = ${ownerId}
    ORDER BY c.sequence LIMIT ${limit}`;
  return [
    // Reports go in the same batch as their Comments; the FK stays RESTRICT.
    deletedCommentReports(comments, committed),
    sql`DELETE FROM comments WHERE id IN (${comments}) AND ${committed}`,
  ];
}

/** The selected Public-thread rows of one Publication. The caller's authorized
 * read pins the Publication owner, so the thread is the same Account's; no
 * selector here can ever name the File's Private thread. */
function publicationThreads(publicationId: string, ownerId: string): SQL {
  return sql`SELECT id FROM comment_threads
    WHERE publication_id = ${publicationId} AND purpose = 'public' AND owner_id = ${ownerId}`;
}

function publicationEpochs(publicationId: string, ownerId: string): SQL {
  return sql`SELECT e.id FROM comment_thread_epochs e JOIN comment_threads t ON t.id = e.thread_id
    WHERE t.publication_id = ${publicationId} AND t.purpose = 'public' AND t.owner_id = ${ownerId}`;
}

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
function deletedFileCommentDependents(scope: CommentDependentFileScope, committed: SQL): readonly SQL[] {
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

/**
 * Ordered, marker-guarded removals of every Comment-dependent row of one
 * Publication's Public thread: Key-rotation Comment and public-history
 * staging, Comment sharing Key envelopes and capabilities, Public epoch link
 * wrappers, reports, staged pseudonym-update items, Comments, attributions,
 * audience-epoch Key envelopes, epochs and the thread itself. The File's
 * Private thread is never selected, and `import_comment_meta` never applies
 * because imported Historical Comments always live in a Private thread.
 */
function deletedPublicationCommentDependents(scope: CommentDependentPublicationScope, committed: SQL): readonly SQL[] {
  const { ownerId, publicationId } = scope;
  const threads = publicationThreads(publicationId, ownerId);
  const epochs = publicationEpochs(publicationId, ownerId);
  return [
    // A public_history staging row names its epoch in `thread_id`; a private
    // staging row names the thread, and both hold comment content-key bytes.
    sql`DELETE FROM key_rotation_comment_items WHERE (thread_id IN (${threads})
      OR thread_id IN (${epochs})) AND ${committed}`,
    sql`DELETE FROM key_rotation_items WHERE kind = 'public_history' AND object_id IN (${epochs}) AND ${committed}`,
    sql`DELETE FROM grant_comment_key_envelopes WHERE object_id IN (${epochs}) AND ${committed}`,
    sql`DELETE FROM share_comment_key_envelopes WHERE object_id IN (${epochs}) AND ${committed}`,
    sql`DELETE FROM key_envelopes WHERE object_id IN (${epochs}) AND ${committed}`,
    sql`DELETE FROM sharing_comment_capabilities WHERE thread_id IN (${threads}) AND ${committed}`,
    sql`DELETE FROM public_comment_epoch_links WHERE publication_id = ${publicationId} AND ${committed}`,
    // Reports, staged Pseudonym-update items, Comments and attributions are
    // explicit dependents, child before parent, never a database cascade.
    deletedCommentReports(sql`SELECT id FROM comments WHERE thread_id IN (${threads})`, committed),
    deletedPseudonymItems("thread", sql`SELECT id FROM thread_attributions WHERE thread_id IN (${threads})`, committed),
    sql`DELETE FROM comments WHERE thread_id IN (${threads}) AND ${committed}`,
    sql`DELETE FROM thread_attributions WHERE thread_id IN (${threads}) AND ${committed}`,
    sql`DELETE FROM comment_thread_epochs WHERE thread_id IN (${threads}) AND ${committed}`,
    sql`DELETE FROM comment_threads WHERE id IN (${threads}) AND ${committed}`,
  ];
}

/** The category-only reports of any set of Comments. The Comment foreign key
 * is RESTRICT, so every Comment-removal path deletes reports explicitly in the
 * same transaction; this helper is the one place that delete shape lives. */
export function deletedCommentReports(comments: SQL, marker: SQL): SQL {
  return sql`DELETE FROM public_comment_reports WHERE comment_id IN (${comments}) AND ${marker}`;
}
