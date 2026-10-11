import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
  deletedCommentBatch,
  deletedCommentDependents,
  type CommentDependentFileScope,
  type CommentDependentPublicationScope,
} from "../../app/comments/dependents.server";
import { atomicSqlBatch, sql } from "../../app/shared/db/client.server";
import { count, stageCommentRotation, stageImportCommentMeta, stagePseudonymItems } from "./deletion-fixtures";
import { commentPayload, publish, sealedAttribution, sealedComment } from "./publication-fixtures";
import {
  grant,
  invite,
  opaqueId,
  sharingAccount,
  sharingRequest,
  treeChild,
  type SharingAccount,
} from "./sharing-fixtures";

/**
 * Tickets 49 and 50: the shared Comment-dependent module's real-D1
 * integration invariants. The authorized Worker routes remain the highest
 * deletion seam (`hard-deletion-completeness.test.ts`,
 * `publication-lifecycle.test.ts`); this suite executes the module's own
 * ordered statements for both scopes against migrated D1 to pin scope
 * containment, the transaction-marker guard and rollback when a later
 * dependent removal fails.
 */

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

type CommentGraph = {
  fileId: string;
  publicationId: string;
  privateThreadId: string;
  privateEpochId: string;
  privateCommentId: string;
  privateAttributionId: string;
  retainedEpochId: string;
  collaboratorsEpochId: string;
  publicThreadId: string;
  publicEpochId: string;
  publicCommentId: string;
  publicAttributionId: string;
  rotationJobId: string;
  pseudonymJobId: string;
  shareId: string;
  grantId: string;
};

/** A private thread with Comment, attribution and recovery envelopes. */
async function privateThread(owner: SharingAccount, fileId: string) {
  const threadId = opaqueId(),
    epochId = opaqueId(),
    commentId = opaqueId(),
    attributionId = opaqueId(),
    now = Date.now();
  await env.DB.batch([
    env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
    env.DB.prepare(`INSERT INTO comment_thread_epochs (id, thread_id, audience, key_epoch, ordinal, state, created_at)
      VALUES (?, ?, NULL, 1, 1, 'active', ?)`).bind(epochId, threadId, now),
    env.DB.prepare(`INSERT INTO comment_threads (id, owner_id, file_id, purpose, publication_id, current_epoch_id,
      next_sequence, created_at) VALUES (?, ?, ?, 'private', NULL, ?, 1, ?)`).bind(
      threadId,
      owner.accountId,
      fileId,
      epochId,
      now,
    ),
    env.DB.prepare(`INSERT INTO sharing_comment_capabilities
      (object_id, owner_id, file_id, thread_id, purpose, publication_id, capability_id, capability_epoch)
      VALUES (?, ?, ?, ?, 'private-comment-thread', NULL, ?, 1)`).bind(
      threadId,
      owner.accountId,
      fileId,
      threadId,
      opaqueId(),
    ),
    env.DB.prepare(`INSERT INTO comments (id, thread_id, epoch_id, author_id, sequence, revision, body_ciphertext,
      body_size, content_key_envelope, content_key_epoch, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 1, X'01', 1, X'01', 1, ?, ?)`).bind(
      commentId,
      threadId,
      epochId,
      owner.accountId,
      now,
      now,
    ),
    env.DB.prepare(`INSERT INTO thread_attributions (id, thread_id, author_id, epoch_id, revision, ciphertext,
      content_key_envelope, content_key_epoch, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, X'01', X'01', 1, ?, ?)`).bind(attributionId, threadId, owner.accountId, epochId, now, now),
    env.DB.prepare(`INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch)
      VALUES (?, 'vault-recovery', ?, 'vault-root', X'01', 1)`).bind(owner.accountId, threadId),
    env.DB.prepare(`INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch)
      VALUES (?, 'vault-recovery', ?, 'vault-root', X'01', 1)`).bind(owner.accountId, epochId),
  ]);
  return { threadId, epochId, commentId, attributionId };
}

/** One File's complete Comment-dependent graph: both thread purposes, retained
 * Public and Collaborators-only audience epochs with their Key envelopes (the
 * Public one also with its link wrapper), a Public Comment report, staged
 * pseudonym-update material, Comment-related Key-rotation staging, imported
 * Historical Comment metadata and both Comment-sharing Key-envelope families. */
async function seedCommentGraph(owner: SharingAccount, pending: SharingAccount, grantee: SharingAccount) {
  const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
  // The Grant exists before any Comment capability, so acceptance never waits
  // on Comment key delivery.
  const { grantId } = await grant(owner, grantee, fileId);
  const publication = await publish(owner, fileId);
  const { shareId } = await invite(owner, pending, fileId);
  const privateSide = await privateThread(owner, fileId);
  const publicComment = await sealedComment(publication, "Reported public note");
  const publicAttribution = await sealedAttribution(publication, "Public author");
  const posted = await sharingRequest(
    owner,
    `/api/private/comments/files/${fileId}/public/entries`,
    "POST",
    commentPayload(publication, publicComment, publicAttribution),
  );
  if (posted.status !== 201) throw new Error(`public comment failed: ${posted.status} ${await posted.text()}`);
  const retainedEpochId = opaqueId(),
    collaboratorsEpochId = opaqueId(),
    now = Date.now();
  await env.DB.batch([
    env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
    // A retained Public audience epoch keeps a capability, a recovery envelope
    // and its Publication-link wrapper after the active epoch advanced.
    env.DB.prepare(`INSERT INTO comment_thread_epochs (id, thread_id, audience, key_epoch, ordinal, state, created_at)
      VALUES (?, ?, 'public', 1, 2, 'retained', ?)`).bind(retainedEpochId, publication.epoch.threadId, now),
    env.DB.prepare(`INSERT INTO sharing_comment_capabilities
      (object_id, owner_id, file_id, thread_id, purpose, publication_id, capability_id, capability_epoch)
      VALUES (?, ?, ?, ?, 'public-comment-audience-epoch', ?, ?, 1)`).bind(
      retainedEpochId,
      owner.accountId,
      fileId,
      publication.epoch.threadId,
      publication.publicationId,
      opaqueId(),
    ),
    env.DB.prepare(`INSERT INTO public_comment_epoch_links (epoch_id, publication_id, link_id, key_epoch,
      ciphertext, created_at) VALUES (?, ?, ?, 1, X'01', ?)`).bind(
      retainedEpochId,
      publication.publicationId,
      publication.linkId,
      now,
    ),
    env.DB.prepare(`INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch)
      VALUES (?, 'vault-recovery', ?, 'vault-root', X'01', 1)`).bind(owner.accountId, retainedEpochId),
    // A retained Collaborators-only epoch has no link wrapper but still keeps
    // its capability and recovery envelope.
    env.DB.prepare(`INSERT INTO comment_thread_epochs (id, thread_id, audience, key_epoch, ordinal, state, created_at)
      VALUES (?, ?, 'collaborators_only', 1, 3, 'retained', ?)`).bind(
      collaboratorsEpochId,
      publication.epoch.threadId,
      now,
    ),
    env.DB.prepare(`INSERT INTO sharing_comment_capabilities
      (object_id, owner_id, file_id, thread_id, purpose, publication_id, capability_id, capability_epoch)
      VALUES (?, ?, ?, ?, 'public-comment-audience-epoch', ?, ?, 1)`).bind(
      collaboratorsEpochId,
      owner.accountId,
      fileId,
      publication.epoch.threadId,
      publication.publicationId,
      opaqueId(),
    ),
    env.DB.prepare(`INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch)
      VALUES (?, 'vault-recovery', ?, 'vault-root', X'01', 1)`).bind(owner.accountId, collaboratorsEpochId),
    env.DB.prepare(`INSERT INTO public_comment_reports (id, reporter_id, comment_id, category, created_at, expires_at)
      VALUES (?, ?, ?, 'spam', ?, ?)`).bind(
      opaqueId(),
      owner.accountId,
      publicComment.commentId,
      now,
      now + 86_400_000,
    ),
    // Comment-sharing Key envelopes for the pending Share and the accepted Grant.
    env.DB.prepare(`INSERT INTO share_comment_key_envelopes (relationship_id, device_id, capability_id,
      capability_epoch, grant_key_epoch, owner_registry_epoch, recipient_registry_epoch, ciphertext, signature,
      signer_device_id, object_id)
      VALUES (?, ?, ?, 1, 1, 1, 1, X'01', zeroblob(64), ?, ?)`).bind(
      shareId,
      owner.deviceId,
      opaqueId(),
      owner.deviceId,
      privateSide.threadId,
    ),
    env.DB.prepare(`INSERT INTO grant_comment_key_envelopes (relationship_id, device_id, capability_id,
      capability_epoch, grant_key_epoch, owner_registry_epoch, recipient_registry_epoch, ciphertext, signature,
      signer_device_id, object_id)
      VALUES (?, ?, ?, 1, 1, 1, 1, X'01', zeroblob(64), ?, ?)`).bind(
      grantId,
      owner.deviceId,
      opaqueId(),
      owner.deviceId,
      publication.epoch.epochId,
    ),
  ]);
  const rotationJobId = await stageCommentRotation(owner, fileId, {
    private: { threadId: privateSide.threadId, commentId: privateSide.commentId },
    publicHistory: { epochId: publication.epoch.epochId, commentId: publicComment.commentId },
  });
  const pseudonymJobId = await stagePseudonymItems(owner, [
    { kind: "thread", recordId: privateSide.attributionId },
    { kind: "thread", recordId: publicAttribution.attributionId },
  ]);
  await stageImportCommentMeta(owner, privateSide.threadId, privateSide.commentId);
  return {
    fileId,
    publicationId: publication.publicationId,
    privateThreadId: privateSide.threadId,
    privateEpochId: privateSide.epochId,
    privateCommentId: privateSide.commentId,
    privateAttributionId: privateSide.attributionId,
    retainedEpochId,
    collaboratorsEpochId,
    publicThreadId: publication.epoch.threadId,
    publicEpochId: publication.epoch.epochId,
    publicCommentId: publicComment.commentId,
    publicAttributionId: publicAttribution.attributionId,
    rotationJobId,
    pseudonymJobId,
    shareId,
    grantId,
  } satisfies CommentGraph;
}

function scope(owner: SharingAccount, graph: CommentGraph): CommentDependentFileScope {
  return { kind: "file", ownerId: owner.accountId, selectedNodeIds: [graph.fileId] };
}

function publicationScope(owner: SharingAccount, graph: CommentGraph): CommentDependentPublicationScope {
  return { kind: "publication", ownerId: owner.accountId, publicationId: graph.publicationId };
}

/** Every table/selector the module owns for one Comment graph. */
async function graphCounts(graph: CommentGraph) {
  const threadIds = [graph.privateThreadId, graph.publicThreadId];
  const epochIds = [graph.privateEpochId, graph.publicEpochId, graph.retainedEpochId, graph.collaboratorsEpochId];
  const threadPlaceholders = threadIds.map(() => "?").join(", ");
  const epochPlaceholders = epochIds.map(() => "?").join(", ");
  return {
    keyRotationCommentItems: await count(
      "key_rotation_comment_items",
      "job_id = ? AND thread_id = ?",
      graph.rotationJobId,
      graph.privateThreadId,
    ),
    publicHistoryCommentItems: await count(
      "key_rotation_comment_items",
      "job_id = ? AND thread_id = ?",
      graph.rotationJobId,
      graph.publicEpochId,
    ),
    publicHistoryItems: await count(
      "key_rotation_items",
      "job_id = ? AND kind = 'public_history'",
      graph.rotationJobId,
    ),
    shareCommentKeyEnvelopes: await count("share_comment_key_envelopes", "relationship_id = ?", graph.shareId),
    grantCommentKeyEnvelopes: await count("grant_comment_key_envelopes", "relationship_id = ?", graph.grantId),
    sharingCommentCapabilities: await count("sharing_comment_capabilities", "file_id = ?", graph.fileId),
    reports: await count(
      "public_comment_reports",
      "comment_id IN (?, ?)",
      graph.privateCommentId,
      graph.publicCommentId,
    ),
    pseudonymItems: await count(
      "pseudonym_update_items",
      "record_id IN (?, ?)",
      graph.privateAttributionId,
      graph.publicAttributionId,
    ),
    importCommentMeta: await count("import_comment_meta", "comment_id = ?", graph.privateCommentId),
    comments: await count("comments", `thread_id IN (${threadPlaceholders})`, ...threadIds),
    attributions: await count("thread_attributions", `thread_id IN (${threadPlaceholders})`, ...threadIds),
    threadKeyEnvelopes: await count("key_envelopes", `object_id IN (${threadPlaceholders})`, ...threadIds),
    epochKeyEnvelopes: await count("key_envelopes", `object_id IN (${epochPlaceholders})`, ...epochIds),
    epochLinks: await count("public_comment_epoch_links", `epoch_id IN (${epochPlaceholders})`, ...epochIds),
    epochs: await count("comment_thread_epochs", `thread_id IN (${threadPlaceholders})`, ...threadIds),
    threads: await count("comment_threads", "file_id = ?", graph.fileId),
  };
}

describe("Comment-dependent Hard deletion module", () => {
  it("removes every Comment-dependent row of the selected File and leaves an unrelated File intact", async () => {
    const owner = await sharingAccount(),
      pending = await sharingAccount(),
      grantee = await sharingAccount();
    const graph = await seedCommentGraph(owner, pending, grantee);
    const unrelatedOwner = await sharingAccount();
    const unrelated = await seedCommentGraph(unrelatedOwner, await sharingAccount(), await sharingAccount());
    const unrelatedBefore = await graphCounts(unrelated);
    expect(unrelatedBefore.comments).toBe(2);

    await atomicSqlBatch(env.DB, [
      sql`PRAGMA defer_foreign_keys = ON`,
      ...deletedCommentDependents(scope(owner, graph), sql`1`),
    ]);

    expect(await graphCounts(graph)).toEqual({
      keyRotationCommentItems: 0,
      publicHistoryCommentItems: 0,
      // The File scope leaves `key_rotation_items` rows to the tree caller,
      // which removes them with their jobs in the same batch.
      publicHistoryItems: 1,
      shareCommentKeyEnvelopes: 0,
      grantCommentKeyEnvelopes: 0,
      sharingCommentCapabilities: 0,
      reports: 0,
      pseudonymItems: 0,
      importCommentMeta: 0,
      comments: 0,
      attributions: 0,
      threadKeyEnvelopes: 0,
      epochKeyEnvelopes: 0,
      epochLinks: 0,
      epochs: 0,
      threads: 0,
    });
    expect(await graphCounts(unrelated)).toEqual(unrelatedBefore);
    // The module owns only the Comment-dependent graph: the File, its
    // Publication and the caller's Key-rotation item rows remain for their
    // owners, so both staged item rows survive the File scope.
    expect(await count("files", "node_id = ?", graph.fileId)).toBe(1);
    expect(await count("publications", "file_id = ?", graph.fileId)).toBe(1);
    expect(await count("key_rotation_items", "job_id = ?", graph.rotationJobId)).toBe(2);
  });

  it("removes nothing when the caller's transaction marker is not satisfied", async () => {
    const owner = await sharingAccount(),
      pending = await sharingAccount(),
      grantee = await sharingAccount();
    const graph = await seedCommentGraph(owner, pending, grantee);
    const before = await graphCounts(graph);
    expect(before.comments).toBe(2);

    await atomicSqlBatch(env.DB, [
      sql`PRAGMA defer_foreign_keys = ON`,
      ...deletedCommentDependents(scope(owner, graph), sql`0`),
    ]);

    expect(await graphCounts(graph)).toEqual(before);
  });

  it("rolls back every removal when a later dependent statement fails", async () => {
    const owner = await sharingAccount(),
      pending = await sharingAccount(),
      grantee = await sharingAccount();
    const graph = await seedCommentGraph(owner, pending, grantee);
    const before = await graphCounts(graph);
    expect(before.comments).toBe(2);
    // Fail the Comments removal, which follows the report, pseudonym and
    // Historical metadata removals inside the module's order.
    await env.DB.prepare(`CREATE TRIGGER test_comment_delete_abort BEFORE DELETE ON comments
      WHEN OLD.thread_id = '${graph.privateThreadId}' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`).run();
    try {
      await expect(
        atomicSqlBatch(env.DB, [
          sql`PRAGMA defer_foreign_keys = ON`,
          ...deletedCommentDependents(scope(owner, graph), sql`1`),
        ]),
      ).rejects.toThrow();
      expect(await graphCounts(graph)).toEqual(before);
    } finally {
      await env.DB.exec("DROP TRIGGER test_comment_delete_abort");
    }
  });
});

/** The rows the Publication scope owns; the File's Private thread is never part of it. */
async function publicationCounts(graph: CommentGraph) {
  const epochIds = [graph.publicEpochId, graph.retainedEpochId, graph.collaboratorsEpochId];
  const epochPlaceholders = epochIds.map(() => "?").join(", ");
  return {
    threads: await count("comment_threads", "publication_id = ? AND purpose = 'public'", graph.publicationId),
    epochs: await count("comment_thread_epochs", "thread_id = ?", graph.publicThreadId),
    capabilities: await count("sharing_comment_capabilities", "thread_id = ?", graph.publicThreadId),
    comments: await count("comments", "thread_id = ?", graph.publicThreadId),
    attributions: await count("thread_attributions", "thread_id = ?", graph.publicThreadId),
    reports: await count("public_comment_reports", "comment_id = ?", graph.publicCommentId),
    pseudonymItems: await count("pseudonym_update_items", "record_id = ?", graph.publicAttributionId),
    epochKeyEnvelopes: await count("key_envelopes", `object_id IN (${epochPlaceholders})`, ...epochIds),
    epochLinks: await count("public_comment_epoch_links", "publication_id = ?", graph.publicationId),
    publicHistoryCommentItems: await count(
      "key_rotation_comment_items",
      "job_id = ? AND thread_id = ?",
      graph.rotationJobId,
      graph.publicEpochId,
    ),
    publicHistoryItems: await count(
      "key_rotation_items",
      "job_id = ? AND kind = 'public_history'",
      graph.rotationJobId,
    ),
  };
}

/** The File's Private-thread rows the Publication scope must leave untouched. */
async function privateCounts(graph: CommentGraph) {
  return {
    threads: await count("comment_threads", "id = ?", graph.privateThreadId),
    epochs: await count("comment_thread_epochs", "thread_id = ?", graph.privateThreadId),
    capabilities: await count("sharing_comment_capabilities", "thread_id = ?", graph.privateThreadId),
    comments: await count("comments", "thread_id = ?", graph.privateThreadId),
    attributions: await count("thread_attributions", "thread_id = ?", graph.privateThreadId),
    threadKeyEnvelopes: await count("key_envelopes", "object_id = ?", graph.privateThreadId),
    epochKeyEnvelopes: await count("key_envelopes", "object_id = ?", graph.privateEpochId),
    pseudonymItems: await count("pseudonym_update_items", "record_id = ?", graph.privateAttributionId),
    rotationCommentItems: await count(
      "key_rotation_comment_items",
      "job_id = ? AND thread_id = ?",
      graph.rotationJobId,
      graph.privateThreadId,
    ),
    importCommentMeta: await count("import_comment_meta", "comment_id = ?", graph.privateCommentId),
  };
}

describe("Comment-dependent Publication scope", () => {
  it("removes one Publication's Public thread and never the File's Private thread", async () => {
    const owner = await sharingAccount(),
      pending = await sharingAccount(),
      grantee = await sharingAccount();
    const graph = await seedCommentGraph(owner, pending, grantee);
    const unrelated = await seedCommentGraph(await sharingAccount(), await sharingAccount(), await sharingAccount());
    const privateBefore = await privateCounts(graph);
    const unrelatedBefore = await graphCounts(unrelated);
    expect(privateBefore.comments).toBe(1);
    expect(privateBefore.importCommentMeta).toBe(1);
    expect((await publicationCounts(graph)).comments).toBe(1);

    await atomicSqlBatch(env.DB, [
      sql`PRAGMA defer_foreign_keys = ON`,
      ...deletedCommentDependents(publicationScope(owner, graph), sql`1`),
    ]);

    expect(await publicationCounts(graph)).toEqual({
      threads: 0,
      epochs: 0,
      capabilities: 0,
      comments: 0,
      attributions: 0,
      reports: 0,
      pseudonymItems: 0,
      epochKeyEnvelopes: 0,
      epochLinks: 0,
      publicHistoryCommentItems: 0,
      publicHistoryItems: 0,
    });
    // The Public epoch's Grant envelope goes with its capability; the Private
    // thread's pending-Share envelope and imported metadata stay.
    expect(await count("grant_comment_key_envelopes", "relationship_id = ?", graph.grantId)).toBe(0);
    expect(await count("share_comment_key_envelopes", "relationship_id = ?", graph.shareId)).toBe(1);
    expect(await privateCounts(graph)).toEqual(privateBefore);
    expect(await graphCounts(unrelated)).toEqual(unrelatedBefore);
    // The module owns only the Comment-dependent graph: the File, the
    // Publication and its link remain for their callers.
    expect(await count("files", "node_id = ?", graph.fileId)).toBe(1);
    expect(await count("publications", "id = ?", graph.publicationId)).toBe(1);
    expect(await count("publication_links", "publication_id = ?", graph.publicationId)).toBe(1);
    expect(await count("comment_threads", "file_id = ?", graph.fileId)).toBe(1);
  });

  it("removes nothing when the caller's transaction marker is not satisfied", async () => {
    const owner = await sharingAccount(),
      pending = await sharingAccount(),
      grantee = await sharingAccount();
    const graph = await seedCommentGraph(owner, pending, grantee);
    const before = await publicationCounts(graph);
    const privateBefore = await privateCounts(graph);
    expect(before.comments).toBe(1);

    await atomicSqlBatch(env.DB, [
      sql`PRAGMA defer_foreign_keys = ON`,
      ...deletedCommentDependents(publicationScope(owner, graph), sql`0`),
    ]);

    expect(await publicationCounts(graph)).toEqual(before);
    expect(await privateCounts(graph)).toEqual(privateBefore);
  });

  it("rolls back every removal when a later dependent statement fails", async () => {
    const owner = await sharingAccount(),
      pending = await sharingAccount(),
      grantee = await sharingAccount();
    const graph = await seedCommentGraph(owner, pending, grantee);
    const before = await publicationCounts(graph);
    const privateBefore = await privateCounts(graph);
    // Fail the Comments removal, which follows the Key-rotation, envelope,
    // capability, report and pseudonym removals inside the module's order.
    await env.DB.prepare(`CREATE TRIGGER test_public_comment_delete_abort BEFORE DELETE ON comments
      WHEN OLD.thread_id = '${graph.publicThreadId}' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`).run();
    try {
      await expect(
        atomicSqlBatch(env.DB, [
          sql`PRAGMA defer_foreign_keys = ON`,
          ...deletedCommentDependents(publicationScope(owner, graph), sql`1`),
        ]),
      ).rejects.toThrow();
      expect(await publicationCounts(graph)).toEqual(before);
      expect(await privateCounts(graph)).toEqual(privateBefore);
    } finally {
      await env.DB.exec("DROP TRIGGER test_public_comment_delete_abort");
    }
  });

  it("bounds each Comment batch and still requires the final completion statements", async () => {
    const owner = await sharingAccount(),
      pending = await sharingAccount(),
      grantee = await sharingAccount();
    const graph = await seedCommentGraph(owner, pending, grantee);
    const now = Date.now();
    await env.DB.batch(
      [2, 3].map((sequence) =>
        env.DB.prepare(`INSERT INTO comments
      (id, thread_id, epoch_id, author_id, sequence, revision, body_ciphertext, body_size, content_key_envelope,
        content_key_epoch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, X'01', 1, X'01', 1, ?, ?)`).bind(
          opaqueId(),
          graph.publicThreadId,
          graph.publicEpochId,
          owner.accountId,
          sequence,
          now,
          now,
        ),
      ),
    );
    const beforeBatch = await publicationCounts(graph);
    expect(beforeBatch.comments).toBe(3);

    await atomicSqlBatch(env.DB, [
      sql`PRAGMA defer_foreign_keys = ON`,
      ...deletedCommentBatch(publicationScope(owner, graph), 2, sql`1`),
    ]);

    // The batch removed its two Comments with the report; a third Comment, the
    // thread, its epochs, capabilities and links remain. Zero Comments or a
    // short batch is progress, not completion.
    const afterBatch = await publicationCounts(graph);
    expect(afterBatch.comments).toBe(1);
    expect(afterBatch.reports).toBe(0);
    expect(afterBatch.threads).toBe(1);
    expect(afterBatch.epochs).toBe(3);
    expect(afterBatch.capabilities).toBe(3);
    expect(afterBatch.epochLinks).toBe(2);
    expect((await privateCounts(graph)).comments).toBe(1);

    // The final completion statements remove every remaining public row; the
    // Private thread and the caller's non-Comment rows survive.
    await atomicSqlBatch(env.DB, [
      sql`PRAGMA defer_foreign_keys = ON`,
      ...deletedCommentDependents(publicationScope(owner, graph), sql`1`),
    ]);
    expect(await publicationCounts(graph)).toEqual({
      threads: 0,
      epochs: 0,
      capabilities: 0,
      comments: 0,
      attributions: 0,
      reports: 0,
      pseudonymItems: 0,
      epochKeyEnvelopes: 0,
      epochLinks: 0,
      publicHistoryCommentItems: 0,
      publicHistoryItems: 0,
    });
    expect((await privateCounts(graph)).comments).toBe(1);
    expect(await count("publications", "id = ?", graph.publicationId)).toBe(1);
  });
});
