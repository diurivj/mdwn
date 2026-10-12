import { applyD1Migrations, createScheduledController, env, SELF, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../../workers/app";
import { sealAttribution, sealCommentBody } from "../../app/shared/comments/content";
import { generateVaultRootKey, sealVaultRecoveryEnvelope } from "../../app/shared/crypto/vault";
import { encodeTreeBytes } from "../../app/shared/tree/wire";
import { commentPayload, publish, sealedAttribution, sealedComment, type Publication } from "./publication-fixtures";
import {
  deletePayload,
  grant,
  opaqueId,
  sharingAccount,
  sharingRequest,
  treeChild,
  type SharingAccount,
} from "./sharing-fixtures";

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

/**
 * Ticket 61: scheduled maintenance finishes an Owner-sealed Unpublishing with
 * no browser. Every case seals a real Publication through the signed API, then
 * runs the real Worker `scheduled` entry point against migrated D1 and inspects
 * physical rows directly.
 */

// Earlier cases may leave sealed teardowns behind; each case starts with an
// empty queue so "oldest first" selects the Publication it created.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM rate_limit_counters").run();
  for (let run = 0; run < 50 && (await count("publication_teardowns")) > 0; run++) await scheduled();
  expect(await count("publication_teardowns")).toBe(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function scheduled(): Promise<void> {
  return worker.scheduled(createScheduledController({ scheduledTime: Date.now() }), env);
}

async function count(table: string, where = "1", ...values: unknown[]) {
  return (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)
    .bind(...values)
    .first<{ n: number }>())!.n;
}

const unpublish = (owner: SharingAccount, fileId: string) =>
  sharingRequest(owner, `/api/private/publications/files/${fileId}/unpublish`, "POST");
const browserTeardown = (owner: SharingAccount, fileId: string) =>
  sharingRequest(owner, `/api/private/publications/files/${fileId}/teardown`, "POST");
const readPublic = (linkId: string) => SELF.fetch(`https://mdwn.test/api/public/publications/${linkId}`);

async function publicComment(owner: SharingAccount, fileId: string, publication: Publication, text: string) {
  const comment = await sealedComment(publication, text);
  const attribution = await sealedAttribution(publication, "Scheduled Teardown Author");
  const response = await sharingRequest(
    owner,
    `/api/private/comments/files/${fileId}/public/entries`,
    "POST",
    commentPayload(publication, comment, attribution),
  );
  if (response.status !== 201) throw new Error(`public comment failed: ${response.status} ${await response.text()}`);
  return { commentId: comment.commentId, attributionId: attribution.attributionId };
}

/** Opaque Public Comment rows, as the existing bounded-batch tests seed them. */
async function seedPublicComments(owner: SharingAccount, publication: Publication, total: number) {
  const rows = [];
  for (let sequence = 1000; sequence < 1000 + total; sequence++)
    rows.push(
      env.DB.prepare(`INSERT INTO comments
      (id, thread_id, epoch_id, author_id, sequence, revision, body_ciphertext, body_size, content_key_envelope,
        content_key_epoch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, X'01', 1, X'01', 1, 1, 1)`).bind(
        opaqueId(),
        publication.epoch.threadId,
        publication.epoch.epochId,
        owner.accountId,
        sequence,
      ),
    );
  await env.DB.batch(rows);
}

type PrivateThread = { threadId: string; epochId: string; commentId: string; attributionId: string };

/** The File's real Private thread with one attributed Comment, through the authorized routes. */
async function privateThreadWithComment(owner: SharingAccount, fileId: string): Promise<PrivateThread> {
  const threadId = opaqueId(),
    epochId = opaqueId(),
    capabilityId = opaqueId();
  const capability = crypto.getRandomValues(new Uint8Array(32));
  const recoveryEnvelope = await sealVaultRecoveryEnvelope(
    generateVaultRootKey(),
    { scope: "owned", objectId: threadId, keyId: capabilityId, key: capability },
    {
      purpose: "vault-recovery",
      vaultId: owner.accountId,
      objectId: threadId,
      keyId: capabilityId,
      keyEpoch: 1,
      revision: 1,
    },
  );
  const created = await sharingRequest(owner, `/api/private/comments/files/${fileId}`, "PUT", {
    threadId,
    epochId,
    capabilityId,
    recoveryEnvelope: encodeTreeBytes(recoveryEnvelope),
  });
  if (created.status !== 201) throw new Error(`thread create failed: ${created.status}`);
  const commentId = opaqueId(),
    attributionId = opaqueId();
  const body = await sealCommentBody(capability, {
    vaultId: owner.accountId,
    commentId,
    capabilityId,
    keyEpoch: 1,
    revision: 1,
    text: "Private stays",
  });
  const attribution = await sealAttribution(capability, {
    vaultId: owner.accountId,
    attributionId,
    pseudonym: "Private Author",
    capabilityId,
    keyEpoch: 1,
    revision: 1,
  });
  const posted = await sharingRequest(owner, `/api/private/comments/files/${fileId}/entries`, "POST", {
    commentId,
    threadId,
    capabilityId,
    capabilityEpoch: 1,
    epochId,
    bodyCiphertext: body.bodyCiphertext,
    contentKeyEnvelope: body.contentKeyEnvelope,
    attribution,
  });
  if (posted.status !== 201) throw new Error(`private comment failed: ${posted.status}`);
  return { threadId, epochId, commentId, attributionId };
}

/** Every Public row a completed teardown must have removed. */
async function publicRows(publication: Publication) {
  const { publicationId } = publication;
  const { threadId, epochId } = publication.epoch;
  return {
    publications: await count("publications", "id = ?", publicationId),
    links: await count("publication_links", "publication_id = ?", publicationId),
    representations: await count("public_representations", "publication_id = ?", publicationId),
    wrappers: await count("public_comment_epoch_links", "publication_id = ?", publicationId),
    teardowns: await count("publication_teardowns", "publication_id = ?", publicationId),
    authors: await count("publication_authors", "publication_id = ?", publicationId),
    threads: await count("comment_threads", "publication_id = ?", publicationId),
    epochs: await count("comment_thread_epochs", "thread_id = ?", threadId),
    comments: await count("comments", "thread_id = ?", threadId),
    attributions: await count("thread_attributions", "thread_id = ?", threadId),
    capabilities: await count("sharing_comment_capabilities", "thread_id = ?", threadId),
    envelopes: await count("key_envelopes", "object_id IN (?, ?)", threadId, epochId),
  };
}

const gone = {
  publications: 0,
  links: 0,
  representations: 0,
  wrappers: 0,
  teardowns: 0,
  authors: 0,
  threads: 0,
  epochs: 0,
  comments: 0,
  attributions: 0,
  capabilities: 0,
  envelopes: 0,
};

async function sealedState(publicationId: string) {
  return env.DB.prepare(
    "SELECT p.state, t.comment_total FROM publications p JOIN publication_teardowns t ON t.publication_id = p.id WHERE p.id = ?",
  )
    .bind(publicationId)
    .first<{ state: string; comment_total: number }>();
}

describe("scheduled Unpublishing teardown", () => {
  it("reaches final deletion across several scheduled runs with no browser call, preserving everything else", async () => {
    const owner = await sharingAccount(),
      other = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const siblingId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const otherFileId = await treeChild(other, other.rootId, "file", other.accountId, true);
    const privateThread = await privateThreadWithComment(owner, fileId);
    const publication = await publish(owner, fileId);
    const posted = await publicComment(owner, fileId, publication, "Public goes");
    await seedPublicComments(owner, publication, 450);
    const sibling = await publish(owner, siblingId);
    const siblingComment = await publicComment(owner, siblingId, sibling, "Sibling stays");
    const foreign = await publish(other, otherFileId);
    const foreignComment = await publicComment(other, otherFileId, foreign, "Other Owner stays");
    const fileRow = await env.DB.prepare("SELECT * FROM files WHERE node_id = ?").bind(fileId).first();

    expect((await unpublish(owner, fileId)).status).toBe(200);
    expect(await sealedState(publication.publicationId)).toEqual({ state: "deleting", comment_total: 451 });

    // 451 Comments: each run deletes one bounded batch and leaves the
    // Publication sealed; access stays ended and nothing is claimed complete.
    for (const remaining of [251, 51, 0]) {
      await scheduled();
      expect(await count("comments", "thread_id = ?", publication.epoch.threadId)).toBe(remaining);
      expect(await sealedState(publication.publicationId)).toEqual({ state: "deleting", comment_total: 451 });
      expect((await readPublic(publication.linkId)).status).toBe(404);
    }
    // Zero Comments is not completion: the thread waits for the final transaction.
    expect(await count("comment_threads", "publication_id = ?", publication.publicationId)).toBe(1);
    await scheduled();
    expect(await publicRows(publication)).toEqual(gone);
    expect(await count("thread_attributions", "id = ?", posted.attributionId)).toBe(0);

    // The File, its Private thread, Comments, attribution and envelopes survive.
    expect(await env.DB.prepare("SELECT * FROM files WHERE node_id = ?").bind(fileId).first()).toEqual(fileRow);
    expect(await count("comment_threads", "id = ? AND purpose = 'private'", privateThread.threadId)).toBe(1);
    expect(await count("comment_thread_epochs", "thread_id = ?", privateThread.threadId)).toBe(1);
    expect(await count("comments", "id = ?", privateThread.commentId)).toBe(1);
    expect(await count("thread_attributions", "id = ?", privateThread.attributionId)).toBe(1);
    expect(await count("sharing_comment_capabilities", "thread_id = ?", privateThread.threadId)).toBe(1);
    expect(await count("key_envelopes", "object_id = ?", privateThread.threadId)).toBe(1);
    const privateRead = await sharingRequest(owner, `/api/private/comments/files/${fileId}`);
    expect(await privateRead.json()).toMatchObject({ thread: { threadId: privateThread.threadId } });
    // An unrelated Publication of the same Owner and another Owner's both stay live.
    for (const [kept, keptComment] of [
      [sibling, siblingComment],
      [foreign, foreignComment],
    ] as const) {
      expect(await count("publications", "id = ? AND state = 'active'", kept.publicationId)).toBe(1);
      expect(await count("comments", "id = ?", keptComment.commentId)).toBe(1);
      expect(await count("thread_attributions", "id = ?", keptComment.attributionId)).toBe(1);
      expect((await readPublic(kept.linkId)).status).toBe(200);
    }

    // The Owner's browser now sees idempotent completion and an unpublished File.
    expect(await (await browserTeardown(owner, fileId)).json()).toEqual({
      done: true,
      commentTotal: 0,
      commentsRemaining: 0,
    });
    const panel = await sharingRequest(owner, `/api/private/publications/files/${fileId}`);
    expect(await panel.json()).toMatchObject({ publication: null, teardown: null });
  });

  it("finishes consistently when browser batches interleave with scheduled runs", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const privateThread = await privateThreadWithComment(owner, fileId);
    const publication = await publish(owner, fileId);
    await publicComment(owner, fileId, publication, "Public goes");
    await seedPublicComments(owner, publication, 449);
    expect((await unpublish(owner, fileId)).status).toBe(200);

    expect(await (await browserTeardown(owner, fileId)).json()).toEqual({
      done: false,
      commentTotal: 450,
      commentsRemaining: 250,
    });
    await scheduled();
    expect(await count("comments", "thread_id = ?", publication.epoch.threadId)).toBe(50);
    expect(await (await browserTeardown(owner, fileId)).json()).toEqual({
      done: false,
      commentTotal: 450,
      commentsRemaining: 0,
    });
    // Zero Comments is not completion: the scheduled run performs the final transaction.
    expect(await count("comment_threads", "publication_id = ?", publication.publicationId)).toBe(1);
    await scheduled();
    expect(await publicRows(publication)).toEqual(gone);
    expect(await (await browserTeardown(owner, fileId)).json()).toEqual({
      done: true,
      commentTotal: 0,
      commentsRemaining: 0,
    });
    await scheduled();
    expect(await count("comments", "id = ?", privateThread.commentId)).toBe(1);
    expect(await count("key_envelopes", "object_id = ?", privateThread.threadId)).toBe(1);
  });

  it("is a no-op without errors after the File was hard-deleted", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const siblingId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    await publicComment(owner, fileId, publication, "Gone with the File");
    const sibling = await publish(owner, siblingId);
    const siblingComment = await publicComment(owner, siblingId, sibling, "Sibling stays");
    expect((await unpublish(owner, fileId)).status).toBe(200);
    const deleted = await sharingRequest(
      owner,
      `/api/private/tree/nodes/${fileId}`,
      "DELETE",
      await deletePayload(owner, owner.accountId, fileId, owner.rootId),
    );
    expect(deleted.status).toBe(200);

    await expect(scheduled()).resolves.toBeUndefined();
    await expect(scheduled()).resolves.toBeUndefined();
    expect(await publicRows(publication)).toEqual(gone);
    expect(await count("publications", "id = ? AND state = 'active'", sibling.publicationId)).toBe(1);
    expect(await count("comments", "id = ?", siblingComment.commentId)).toBe(1);
  });

  it("never touches a later Publication of the same File", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const first = await publish(owner, fileId);
    await publicComment(owner, fileId, first, "Old");
    expect((await unpublish(owner, fileId)).status).toBe(200);
    await scheduled();
    await scheduled();
    expect(await publicRows(first)).toEqual(gone);

    const later = await publish(owner, fileId);
    const kept = await publicComment(owner, fileId, later, "New");
    await scheduled();
    await scheduled();
    expect(await count("publications", "id = ? AND state = 'active'", later.publicationId)).toBe(1);
    expect(await count("comments", "id = ?", kept.commentId)).toBe(1);
    expect(await count("thread_attributions", "id = ?", kept.attributionId)).toBe(1);
    expect(await count("public_representations", "publication_id = ?", later.publicationId)).toBe(1);
    expect((await readPublic(later.linkId)).status).toBe(200);
  });
});

describe("scheduled D1 budget", () => {
  it("stays within the Workers Free per-invocation query limit even if every batched statement counts", async () => {
    const owner = await sharingAccount(),
      recipient = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    await publicComment(owner, fileId, publication, "Counted");
    expect((await unpublish(owner, fileId)).status).toBe(200);
    await scheduled();
    // Worst case: the pending teardown batch is the final transaction, and an
    // expired Grant with envelope dependents makes the Grant drain run too.
    const directoryId = await treeChild(owner, owner.rootId, "directory");
    const { grantId } = await grant(owner, recipient, directoryId);
    await env.DB.prepare("UPDATE grants SET expires_at = 1 WHERE id = ?").bind(grantId).run();
    expect(await count("grant_key_envelopes", "relationship_id = ?", grantId)).toBeGreaterThan(0);
    let statements = 0;
    const counted = new Proxy(env.DB, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "prepare")
          return (query: string) => {
            statements += 1;
            return target.prepare(query);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now() }), { ...env, DB: counted });
    expect(await publicRows(publication)).toEqual(gone);
    expect(await count("grant_key_envelopes", "relationship_id = ?", grantId)).toBe(0);
    // The table beside the duty list in app/retention/scheduled-maintenance.server.ts.
    expect(statements).toBe(41);
    expect(statements).toBeLessThanOrEqual(50);
  });
});

describe("scheduled teardown fairness and races", () => {
  /** Runs one scheduled invocation whose D1 binding runs `gap` right after the
   * teardown target SELECT resolves and before its batch is sent. */
  async function scheduledWithGap(gap: () => Promise<void>) {
    let fired = false;
    const once = async <T>(result: Promise<T>) => {
      const value = await result;
      if (!fired) {
        fired = true;
        await gap();
      }
      return value;
    };
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
          if (property === "raw" || property === "all" || property === "first" || property === "run")
            return (...args: unknown[]) => once((value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const gapped = new Proxy(env.DB, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "prepare")
          return (query: string) => {
            const statement = target.prepare(query);
            return query.includes("FROM publication_teardowns t JOIN publications p") ? wrap(statement) : statement;
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now() }), { ...env, DB: gapped });
    expect(fired).toBe(true);
  }

  it("keeps draining other sealed teardowns while one batch fails every time", async () => {
    const owner = await sharingAccount();
    const poisonedFile = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const healthyFile = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const poisoned = await publish(owner, poisonedFile);
    await publicComment(owner, poisonedFile, poisoned, "Stuck");
    const healthy = await publish(owner, healthyFile);
    await publicComment(owner, healthyFile, healthy, "Goes");
    // The poisoned Publication is sealed first, so it is the oldest teardown.
    expect((await unpublish(owner, poisonedFile)).status).toBe(200);
    expect((await unpublish(owner, healthyFile)).status).toBe(200);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await env.DB.prepare(`CREATE TRIGGER test_poisoned_teardown BEFORE DELETE ON public_representations
      WHEN OLD.publication_id = '${poisoned.publicationId}'
      BEGIN SELECT RAISE(ABORT, 'simulated poisoned teardown'); END`).run();
    try {
      for (let run = 0; run < 6; run++) await scheduled().catch(() => {});
      expect(await publicRows(healthy)).toEqual(gone);
      // The poisoned one stays sealed, Public access stays ended, and nothing claims completion.
      expect(await sealedState(poisoned.publicationId)).toEqual({ state: "deleting", comment_total: 1 });
      expect(await count("public_representations", "publication_id = ?", poisoned.publicationId)).toBe(1);
      expect((await readPublic(poisoned.linkId)).status).toBe(404);
    } finally {
      await env.DB.prepare("DROP TRIGGER test_poisoned_teardown").run();
    }
    // Once the fault is gone, a later run finishes it.
    await scheduled();
    expect(await publicRows(poisoned)).toEqual(gone);
  });

  it("deletes nothing extra when the browser completes and the File is republished between selection and batch", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const first = await publish(owner, fileId);
    expect((await unpublish(owner, fileId)).status).toBe(200);
    let later: Publication | null = null;
    let kept: { commentId: string; attributionId: string } | null = null;
    // The scheduler selects the final transaction; the browser wins first.
    await scheduledWithGap(async () => {
      expect(await (await browserTeardown(owner, fileId)).json()).toMatchObject({ done: true });
      later = await publish(owner, fileId);
      kept = await publicComment(owner, fileId, later, "Fresh");
    });
    expect(await publicRows(first)).toEqual(gone);
    expect(await count("publications", "id = ? AND state = 'active'", later!.publicationId)).toBe(1);
    expect(await count("comments", "id = ?", kept!.commentId)).toBe(1);
    expect(await count("thread_attributions", "id = ?", kept!.attributionId)).toBe(1);
    expect(await count("public_representations", "publication_id = ?", later!.publicationId)).toBe(1);
    expect(await count("comment_threads", "publication_id = ?", later!.publicationId)).toBe(1);
    expect((await readPublic(later!.linkId)).status).toBe(200);
  });

  it("deletes nothing extra when the File is hard-deleted between selection and batch", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const siblingId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    await publicComment(owner, fileId, publication, "Gone with the File");
    const sibling = await publish(owner, siblingId);
    const siblingComment = await publicComment(owner, siblingId, sibling, "Sibling stays");
    expect((await unpublish(owner, fileId)).status).toBe(200);
    await scheduledWithGap(async () => {
      const deleted = await sharingRequest(
        owner,
        `/api/private/tree/nodes/${fileId}`,
        "DELETE",
        await deletePayload(owner, owner.accountId, fileId, owner.rootId),
      );
      expect(deleted.status).toBe(200);
    });
    expect(await publicRows(publication)).toEqual(gone);
    expect(await count("publications", "id = ? AND state = 'active'", sibling.publicationId)).toBe(1);
    expect(await count("comments", "id = ?", siblingComment.commentId)).toBe(1);
    expect((await readPublic(sibling.linkId)).status).toBe(200);
  });
});

describe("scheduled duty isolation", () => {
  async function seedExpiredSecurityMaterial(accountId: string) {
    const now = Date.now();
    const challengeId = opaqueId();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO webauthn_challenges (id, challenge, purpose, origin, rp_id, created_at, expires_at)
        VALUES (?, ?, 'sign_in', 'https://mdwn.test', 'mdwn.test', ?, ?)`).bind(
        challengeId,
        challengeId,
        now - 400_000,
        now - 100_000,
      ),
      env.DB.prepare(`INSERT INTO rate_limit_counters (purpose, scope_type, scope_id, window_ms, time_epoch, count, expires_at)
        VALUES ('publication.mutate', 'account', ?, 86400000, ?, 1, ?)`).bind(
        accountId,
        now - 2 * 86_400_000,
        now - 86_400_000,
      ),
    ]);
    return challengeId;
  }

  async function sealedBacklog() {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    await publicComment(owner, fileId, publication, "Backlog");
    await seedPublicComments(owner, publication, 300);
    expect((await unpublish(owner, fileId)).status).toBe(200);
    return { owner, publication };
  }

  it("purges expired security material in the same run as a teardown backlog", async () => {
    const { owner, publication } = await sealedBacklog();
    const challengeId = await seedExpiredSecurityMaterial(owner.accountId);
    await scheduled();
    expect(await count("webauthn_challenges", "id = ?", challengeId)).toBe(0);
    expect(await count("rate_limit_counters", "scope_id = ? AND expires_at <= ?", owner.accountId, Date.now())).toBe(0);
    expect(await count("comments", "thread_id = ?", publication.epoch.threadId)).toBe(101);
  });

  it("runs every other duty when one fails and reports only the failed duty's name", async () => {
    const { owner, publication } = await sealedBacklog();
    const challengeId = await seedExpiredSecurityMaterial(owner.accountId);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await env.DB.prepare(`CREATE TRIGGER test_abuse_purge_fails BEFORE DELETE ON rate_limit_counters
      BEGIN SELECT RAISE(ABORT, 'simulated duty failure'); END`).run();
    try {
      await expect(scheduled()).rejects.toThrow(/^Scheduled maintenance failed: abuse-records$/);
    } finally {
      await env.DB.prepare("DROP TRIGGER test_abuse_purge_fails").run();
    }
    // The failed duty kept its rows; later duties, teardown included, still ran.
    expect(await count("rate_limit_counters", "scope_id = ? AND expires_at <= ?", owner.accountId, Date.now())).toBe(1);
    expect(await count("webauthn_challenges", "id = ?", challengeId)).toBe(0);
    expect(await count("comments", "thread_id = ?", publication.epoch.threadId)).toBe(101);
    expect(logged.mock.calls).toEqual([["Scheduled maintenance duty failed: abuse-records"]]);
  });

  it("leaves a failed teardown sealed and retryable, then completes it", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    await publicComment(owner, fileId, publication, "Retry me");
    expect((await unpublish(owner, fileId)).status).toBe(200);
    await scheduled();
    expect(await count("comments", "thread_id = ?", publication.epoch.threadId)).toBe(0);
    const challengeId = await seedExpiredSecurityMaterial(owner.accountId);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await env.DB.prepare(`CREATE TRIGGER test_teardown_fails BEFORE DELETE ON public_representations
      BEGIN SELECT RAISE(ABORT, 'simulated teardown failure'); END`).run();
    try {
      // The final transaction fails atomically.
      await expect(scheduled()).rejects.toThrow(/^Scheduled maintenance failed: publication-teardown$/);
    } finally {
      await env.DB.prepare("DROP TRIGGER test_teardown_fails").run();
    }
    expect(await count("webauthn_challenges", "id = ?", challengeId)).toBe(0);
    expect(await sealedState(publication.publicationId)).toEqual({ state: "deleting", comment_total: 1 });
    expect(await count("comment_threads", "publication_id = ?", publication.publicationId)).toBe(1);
    expect(await count("public_representations", "publication_id = ?", publication.publicationId)).toBe(1);
    expect((await readPublic(publication.linkId)).status).toBe(404);
    expect(logged.mock.calls).toEqual([["Scheduled maintenance duty failed: publication-teardown"]]);

    await scheduled();
    expect(await publicRows(publication)).toEqual(gone);
  });
});
