import {
  applyD1Migrations,
  createScheduledController,
  env,
  type D1Migration,
} from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { sealPublicCommentBody } from "../../app/comments/public-content";
import {
  activePublicParticipationSuspension,
  applyPublicParticipationSuspension,
  clearPublicParticipationSuspension,
} from "../../app/security/public-participation.server";
import { FIRST_SUSPENSION_MS, REPORT_RETENTION_MS, REPEAT_SUSPENSION_MS } from "../../app/security/public-participation";
import worker from "../../workers/app";
import { mutation } from "./auth-fixtures";
import {
  commentPayload,
  publicationCreation,
  publish,
  rotationPayload,
  sealedComment,
  type Publication,
} from "./publication-fixtures";
import { opaqueId, sharingAccount, sharingRequest, treeChild, type SharingAccount } from "./sharing-fixtures";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rate_limit_counters"),
    env.DB.prepare("DELETE FROM public_comment_reports"),
    env.DB.prepare("DELETE FROM public_participation_suspensions"),
  ]);
});

const DAY_MS = 86_400_000;

async function count(table: string, where = "1", ...values: unknown[]) {
  return (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).bind(...values).first<{ n: number }>())!.n;
}

/** Post a real Public Comment through the authenticated File route. */
async function postComment(account: SharingAccount, fileId: string, publication: Publication, text: string) {
  const comment = await sealedComment(publication, text);
  return sharingRequest(account, `/api/private/comments/files/${fileId}/public/entries`, "POST",
    commentPayload(publication, comment));
}

function report(account: SharingAccount, commentId: string, category: string) {
  return sharingRequest(account, "/api/private/comments/reports", "POST", { commentId, category });
}

describe("Public Comment reports", () => {
  it("records one category-only report for a signed-in Account that never held the Comment capability", async () => {
    const owner = await sharingAccount(), reporter = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    const posted = await postComment(owner, fileId, publication, "Report me");
    expect(posted.status).toBe(201);
    const { commentId } = await posted.json() as { commentId: string };

    // The reporter never opened the thread, holds no epoch capability and
    // receives no content: the report is opaque-ID plus fixed category only.
    const response = await report(reporter, commentId, "spam");
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ reported: true });

    const columns = await env.DB.prepare("PRAGMA table_info(public_comment_reports)")
      .all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual(
      ["id", "reporter_id", "comment_id", "category", "created_at", "expires_at"]);
    const stored = await env.DB.prepare(`SELECT reporter_id, comment_id, category, created_at, expires_at
      FROM public_comment_reports`).first<{ reporter_id: string; comment_id: string; category: string;
        created_at: number; expires_at: number }>();
    expect(stored).toMatchObject({ reporter_id: reporter.accountId, comment_id: commentId, category: "spam" });
    expect(stored!.expires_at - stored!.created_at).toBe(REPORT_RETENTION_MS);

    // One report per reporter and Comment; a lost-response retry adds nothing.
    const duplicate = await report(reporter, commentId, "abuse");
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ reported: true, alreadyReported: true });
    expect(await count("public_comment_reports")).toBe(1);
  });

  it("rejects free text, unknown categories, and Comment IDs that do not exist", async () => {
    const owner = await sharingAccount(), reporter = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    const posted = await postComment(owner, fileId, publication, "Report shape");
    const { commentId } = await posted.json() as { commentId: string };

    expect((await report(reporter, commentId, "harassment")).status).toBe(400);
    expect((await sharingRequest(reporter, "/api/private/comments/reports", "POST",
      { commentId, category: "spam", text: "the comment says…" })).status).toBe(400);
    expect((await report(reporter, opaqueId(), "spam")).status).toBe(404);
    expect((await report(reporter, "not-a-comment-id", "spam")).status).toBe(400);
    expect(await count("public_comment_reports")).toBe(0);
  });

  it("allows three reports per Account in 24 hours and answers the fourth generically", async () => {
    const owner = await sharingAccount(), reporter = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    const posted = await postComment(owner, fileId, publication, "Limited reports");
    const { commentId } = await posted.json() as { commentId: string };

    // Every accepted request consumes the 3/24-hour Account window, including
    // an idempotent repeat of the same report.
    expect((await report(reporter, commentId, "other")).status).toBe(201);
    expect((await report(reporter, commentId, "other")).status).toBe(200);
    expect((await report(reporter, commentId, "other")).status).toBe(200);
    const denied = await report(reporter, commentId, "other");
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Cache-Control")).toBe("no-store");
    expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await denied.json()).toEqual({ error: "rate_limited" });

    expect(await count("public_comment_reports")).toBe(1);
    // The report policy is Account-scoped only; the denial created no Network bucket.
    expect(await count("rate_limit_counters",
      "purpose = 'public_comment.report' AND scope_type = 'network'")).toBe(0);
  });
});

describe("Public-participation suspension enforcement", () => {
  it("blocks posting, editing and Publication create/rotate while leaving the Comment hard-deletable", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    const existing = await postComment(owner, fileId, publication, "Original");
    const { commentId } = await existing.json() as { commentId: string };

    const suspension = await applyPublicParticipationSuspension(env.DB, owner.accountId, "repeated_technical_abuse");
    expect(suspension).toMatchObject({ strikeCount: 1, reason: "repeated_technical_abuse" });
    expect(suspension.expiresAt - suspension.startedAt).toBe(FIRST_SUSPENSION_MS);
    const denial = { error: "public_participation_suspended", suspendedUntil: suspension.expiresAt };

    // Creating a Public Comment is blocked on the authenticated File route…
    const created = await postComment(owner, fileId, publication, "Blocked");
    expect(created.status).toBe(403);
    expect(await created.json()).toEqual(denial);
    // …and on the signed-in link route.
    const linkComment = await sealedComment(publication, "Blocked on the link");
    expect((await sharingRequest(owner, `/api/private/comments/links/${publication.linkId}/entries`, "POST",
      commentPayload(publication, linkComment))).status).toBe(403);
    expect(await count("comments", "thread_id = ?", publication.epoch.threadId)).toBe(1);

    // Editing an existing Comment is blocked, but hard deletion is not.
    const sealedEdit = await sealPublicCommentBody(publication.epoch.capability, {
      publicationId: publication.publicationId, commentId, capabilityId: publication.epoch.capabilityId,
      keyEpoch: 1, revision: 2, text: "Edited" });
    const edited = await sharingRequest(owner,
      `/api/private/comments/files/${fileId}/public/entries/${commentId}`, "PATCH", {
        threadId: publication.epoch.threadId, capabilityId: publication.epoch.capabilityId, capabilityEpoch: 1,
        epochId: publication.epoch.epochId, expectedRevision: 1,
        bodyCiphertext: sealedEdit.bodyCiphertext, contentKeyEnvelope: sealedEdit.contentKeyEnvelope });
    expect(edited.status).toBe(403);
    expect(await edited.json()).toEqual(denial);
    const deleted = await sharingRequest(owner,
      `/api/private/comments/files/${fileId}/public/entries/${commentId}`, "DELETE", {
        threadId: publication.epoch.threadId, capabilityId: publication.epoch.capabilityId, capabilityEpoch: 1,
        epochId: publication.epoch.epochId, expectedRevision: 1 });
    expect(deleted.status).toBe(200);

    // A fully prepared new Publication is refused before its transaction…
    const secondFile = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const creation = await publicationCreation(owner, secondFile);
    const createResponse = await sharingRequest(owner, `/api/private/publications/files/${secondFile}`, "PUT", creation.body);
    expect(createResponse.status).toBe(403);
    expect(await createResponse.json()).toEqual(denial);
    expect(await count("publications", "file_id = ?", secondFile)).toBe(0);

    // …and a fully prepared rotation is refused before its transaction.
    const rotation = await rotationPayload(owner, fileId, publication);
    const rotateResponse = await sharingRequest(owner, `/api/private/publications/files/${fileId}/link`, "PUT", rotation);
    expect(rotateResponse.status).toBe(403);
    expect(await rotateResponse.json()).toEqual(denial);
    const link = await env.DB.prepare("SELECT current_link_id AS linkId FROM publications WHERE file_id = ?")
      .bind(fileId).first<{ linkId: string }>();
    expect(link?.linkId).toBe(publication.linkId);
  });

  it("keeps private reads, unpublish, teardown, and session revocation available while suspended", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    await postComment(owner, fileId, publication, "Counted");
    await applyPublicParticipationSuspension(env.DB, owner.accountId, "report_pattern");

    // Private read (the data behind browser export) is never blocked.
    const read = await sharingRequest(owner, `/api/private/tree/files/${fileId}`);
    expect(read.status).toBe(200);

    // Sealing a Publication is never blocked, and the Owner's bounded
    // teardown batches finish deletion with the suspension in force.
    const sealed = await sharingRequest(owner, `/api/private/publications/files/${fileId}/unpublish`, "POST");
    expect(sealed.status).toBe(200);
    expect(await sealed.json()).toMatchObject({ commentTotal: 1 });
    let progress: { done: boolean; commentsRemaining: number };
    do {
      const batch = await sharingRequest(owner, `/api/private/publications/files/${fileId}/teardown`, "POST");
      expect(batch.status).toBe(200);
      progress = await batch.json() as { done: boolean; commentsRemaining: number };
    } while (!progress.done);
    expect(await count("publications", "file_id = ?", fileId)).toBe(0);
    expect(await count("comments", "thread_id = ?", publication.epoch.threadId)).toBe(0);

    // Session revocation is an authentication action and never participates.
    const signOut = await mutation("/api/auth/sign-out", owner.session.cookie);
    expect(signOut.status).toBe(200);
    const session = await env.DB.prepare("SELECT revoked_at FROM sessions WHERE id = ?")
      .bind(owner.session.id).first<{ revoked_at: number | null }>();
    expect(session?.revoked_at).not.toBeNull();
  });

  it("expires automatically at the recorded end without any cleanup", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);

    const suspension = await applyPublicParticipationSuspension(env.DB, owner.accountId, "report_pattern");
    expect((await postComment(owner, fileId, publication, "While active")).status).toBe(403);
    expect(await activePublicParticipationSuspension(env.DB, owner.accountId, suspension.expiresAt - 1)).not.toBeNull();
    expect(await activePublicParticipationSuspension(env.DB, owner.accountId, suspension.expiresAt)).toBeNull();

    // Moving the recorded window into the past is exactly what the clock does:
    // the very next request sees an expired suspension and proceeds.
    const past = Date.now() - 8 * DAY_MS;
    await env.DB.prepare(`UPDATE public_participation_suspensions SET started_at = ?, expires_at = ?
      WHERE account_id = ?`).bind(past, past + DAY_MS, owner.accountId).run();
    expect((await postComment(owner, fileId, publication, "After expiry")).status).toBe(201);
  });

  it("escalates a repeat to 30 days and lets the operator correct a mistake", async () => {
    const account = await sharingAccount();
    const start = 1_700_000_000_000;
    const first = await applyPublicParticipationSuspension(env.DB, account.accountId, "report_pattern", start);
    expect(first).toMatchObject({ strikeCount: 1, reason: "report_pattern", startedAt: start });
    expect(first.expiresAt - first.startedAt).toBe(FIRST_SUSPENSION_MS);

    const repeatAt = start + 60_000;
    const repeat = await applyPublicParticipationSuspension(env.DB, account.accountId, "repeated_technical_abuse", repeatAt);
    expect(repeat).toMatchObject({ strikeCount: 2, reason: "repeated_technical_abuse", startedAt: repeatAt });
    expect(repeat.expiresAt - repeat.startedAt).toBe(REPEAT_SUSPENSION_MS);
    expect(await activePublicParticipationSuspension(env.DB, account.accountId, repeat.expiresAt - 1)).not.toBeNull();

    // The correction removes the record and its escalation; a later offense is
    // a first offense again, not a 30-day repeat.
    expect(await clearPublicParticipationSuspension(env.DB, account.accountId)).toBe(true);
    expect(await activePublicParticipationSuspension(env.DB, account.accountId, repeatAt)).toBeNull();
    expect(await clearPublicParticipationSuspension(env.DB, account.accountId)).toBe(false);
    const again = await applyPublicParticipationSuspension(env.DB, account.accountId, "report_pattern", repeatAt + 60_000);
    expect(again.strikeCount).toBe(1);
  });
});

describe("Report retention", () => {
  it("purges only expired reports on the scheduled run", async () => {
    const owner = await sharingAccount(), reporter = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    const posted = await postComment(owner, fileId, publication, "Retained");
    const { commentId } = await posted.json() as { commentId: string };

    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO public_comment_reports (id, reporter_id, comment_id, category, created_at, expires_at)
        VALUES (?, ?, ?, 'spam', ?, ?)`).bind(crypto.randomUUID(), owner.accountId, commentId, now - REPORT_RETENTION_MS, now - 1),
      env.DB.prepare(`INSERT INTO public_comment_reports (id, reporter_id, comment_id, category, created_at, expires_at)
        VALUES (?, ?, ?, 'abuse', ?, ?)`).bind(crypto.randomUUID(), reporter.accountId, commentId, now - DAY_MS, now + DAY_MS),
    ]);

    await expect(worker.scheduled(createScheduledController({ scheduledTime: now }), env)).resolves.toBeUndefined();
    const remaining = await env.DB.prepare(`SELECT reporter_id FROM public_comment_reports`)
      .all<{ reporter_id: string }>();
    expect(remaining.results.map((row) => row.reporter_id)).toEqual([reporter.accountId]);
  });
});
