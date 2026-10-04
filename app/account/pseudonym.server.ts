import type { SQL } from "drizzle-orm";
import { nextPseudonymChangeAt, PSEUDONYM_COOLDOWN_MS } from "~/account/pseudonym-guard.server";
import { hasEmptyBody, readAuthJsonText, record } from "~/auth/request.server";
import {
  attributionContext,
  attributionKeyContext,
  MAX_ATTRIBUTION_BYTES,
  MAX_ATTRIBUTION_KEY_ENVELOPE_BYTES,
} from "~/comments/content";
import { commentEnvelopeWire, readCommentEnvelope } from "~/comments/envelopes.server";
import {
  publicAttributionContext,
  publicAttributionKeyContext,
  publicCommentEnvelope,
} from "~/comments/public-content";
import { accountProfileContext } from "~/crypto/account-profile";
import { inspectEnvelope } from "~/crypto/enc-v1";
import { HPKE_SUITE } from "~/crypto/enc-v1/format";
import { createDb, sql } from "~/db/client.server";
import {
  authorizePrivateRequest,
  commitPrivateBatch,
  privateReadGuard,
  type AuthorizedDevice,
} from "~/device/proof.server";
import { isPublicationIdentifier } from "~/publications/capability";
import { authorDeclarationContext, MAX_AUTHOR_DECLARATION_BYTES } from "~/publications/content";
import { accessPredicate } from "~/sharing/access.server";
import { decodeTreeBytes, encodeTreeBytes, isV7, treeEnvelope } from "~/tree/wire";

/**
 * Public pseudonym update (ticket 24).
 *
 * One exclusive, resumable, browser-driven job re-seals every encrypted
 * `attribution` context of an Account — its Private and Public comment-thread
 * attributions and its current-link Publication declarations — with a new
 * pseudonym. Contexts are staged one bounded page at a time; the Account
 * profile and every staged context switch together in the single commit
 * transaction, so readers see all-old or all-new, never a mixed state. While a
 * job is pending, mutations that would mint a new attribution are blocked. The
 * service retains only ciphertext and opaque metadata throughout.
 */

const headers = { "Cache-Control": "no-store" };
const failure = (error: string, status: number, extra: Record<string, unknown> = {}) =>
  Response.json({ error, ...extra }, { status, headers });
const notFound = () => failure("not_found", 404);
const invalid = () => failure("invalid_pseudonym_request", 400);
const changed = () => failure("pseudonym_update_changed", 409);
const denied = () => failure("device_proof_required", 403);
const preparing = () => failure("secure_access_preparing", 409);
const pending = () => failure("pseudonym_update_pending", 409);

const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const positiveEpoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const positiveRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

const PROFILE_CIPHERTEXT_BYTES = 4_096;
/** Contexts per staging page. One envelope read per thread context keeps a full
 * page inside D1 Free's per-invocation query budget. */
const PSEUDONYM_PAGE = 20;

type JobRow = { jobId: string; state: string; progress: number; createdAt: number };
type ProfileRow = { ciphertext: ArrayBuffer; epoch: number; revision: number };
type ThreadContextRow = {
  recordId: string; threadId: string; epochId: string; currentRevision: number; ownerId: string;
  fileId: string; purpose: "private-comment-thread" | "public-comment-audience-epoch";
  publicationId: string | null; capabilityId: string; capabilityEpoch: number;
};
type PublicationContextRow = {
  recordId: string; publicationId: string; fileId: string; currentRevision: number;
  linkId: string; publicKey: ArrayBuffer;
};

const jobWire = (job: JobRow) => ({ jobId: job.jobId, state: job.state, progress: job.progress, createdAt: job.createdAt });
const profileWire = (profile: ProfileRow) => ({ ciphertext: encodeTreeBytes(new Uint8Array(profile.ciphertext)),
  epoch: profile.epoch, revision: profile.revision });

/**
 * Every encrypted attribution context the Account can currently rewrite. Live
 * File-read access is re-derived per row; a context whose access is gone is no
 * longer required (it can no longer be opened by this Account's devices).
 * Private threads use the thread-level capability; a Public attribution uses
 * the capability of the epoch it was authored in.
 */
function threadContexts(auth: AuthorizedDevice): SQL {
  return sql`SELECT a.id AS recordId, a.thread_id AS threadId, a.epoch_id AS epochId,
      a.revision AS currentRevision, t.owner_id AS ownerId, t.file_id AS fileId,
      CASE WHEN t.purpose = 'private' THEN 'private-comment-thread' ELSE 'public-comment-audience-epoch' END AS purpose,
      t.publication_id AS publicationId, c.capability_id AS capabilityId, c.capability_epoch AS capabilityEpoch
    FROM thread_attributions a
    JOIN comment_threads t ON t.id = a.thread_id
    JOIN comment_thread_epochs e ON e.id = a.epoch_id AND e.thread_id = t.id
    JOIN sharing_comment_capabilities c ON c.thread_id = t.id
      AND ((t.purpose = 'private' AND c.object_id = t.id AND c.purpose = 'private-comment-thread')
        OR (t.purpose = 'public' AND c.object_id = a.epoch_id AND c.purpose = 'public-comment-audience-epoch'
          AND c.capability_epoch = e.key_epoch))
    WHERE a.author_id = ${auth.accountId}
      AND (t.owner_id = ${auth.accountId} OR ${accessPredicate(auth, sql`t.file_id`, "read")})`;
}

/** Only declarations served for the Publication's current link are displayed,
 * so only those are required contexts. A rotated link re-declares through the
 * ordinary path once no job is pending. */
function publicationContexts(auth: AuthorizedDevice): SQL {
  return sql`SELECT a.id AS recordId, a.publication_id AS publicationId, p.file_id AS fileId,
      a.revision AS currentRevision, l.id AS linkId, l.public_key AS publicKey
    FROM publication_authors a
    JOIN publications p ON p.id = a.publication_id AND p.state = 'active'
    JOIN publication_links l ON l.id = p.current_link_id AND l.id = a.link_id
    WHERE a.author_id = ${auth.accountId} AND a.ciphertext IS NOT NULL
      AND ${accessPredicate(auth, sql`p.file_id`, "read")}`;
}

/** A staged item is current only at the next revision and, for a thread, the
 * still-installed capability epoch. A rotation invalidates the wrapper and the
 * item is staged again. */
function threadStaged(jobId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM pseudonym_update_items i WHERE i.job_id = ${jobId} AND i.kind = 'thread'
    AND i.record_id = ctx.recordId AND i.revision = ctx.currentRevision + 1
    AND i.content_key_epoch = ctx.capabilityEpoch)`;
}
function publicationStaged(jobId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM pseudonym_update_items i WHERE i.job_id = ${jobId} AND i.kind = 'publication'
    AND i.record_id = ctx.recordId AND i.revision = ctx.currentRevision + 1)`;
}
function missingThreads(auth: AuthorizedDevice, jobId: string, limit?: number): SQL {
  return sql`SELECT ctx.* FROM (${threadContexts(auth)}) ctx WHERE NOT ${threadStaged(jobId)}
    ORDER BY ctx.recordId${limit ? sql` LIMIT ${limit}` : sql``}`;
}
function missingPublications(auth: AuthorizedDevice, jobId: string, limit?: number): SQL {
  return sql`SELECT ctx.* FROM (${publicationContexts(auth)}) ctx WHERE NOT ${publicationStaged(jobId)}
    ORDER BY ctx.recordId${limit ? sql` LIMIT ${limit}` : sql``}`;
}
function noMissingThreads(auth: AuthorizedDevice, jobId: string): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM (${threadContexts(auth)}) ctx WHERE NOT ${threadStaged(jobId)})`;
}
function noMissingPublications(auth: AuthorizedDevice, jobId: string): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM (${publicationContexts(auth)}) ctx WHERE NOT ${publicationStaged(jobId)})`;
}

/** The Worker validates the exact link-bound HPKE framing but never opens it. */
function declarationEnvelope(value: unknown, expected: ReturnType<typeof authorDeclarationContext>): Uint8Array<ArrayBuffer> {
  const bytes = decodeTreeBytes(value, MAX_AUTHOR_DECLARATION_BYTES);
  const header = inspectEnvelope(bytes);
  const fields = ["purpose", "vaultId", "objectId", "keyId", "keyEpoch", "revision", "recipientId", "publicationId"] as const;
  if (header.suite !== HPKE_SUITE || Object.keys(header.context).length !== fields.length ||
      fields.some((field) => header.context[field] !== expected[field])) throw new Error("invalid declaration envelope");
  return bytes;
}

const pseudonymRecordId = (value: unknown): value is string =>
  isV7(value) || isPublicationIdentifier(value);

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

/** The Account's pending job, if any, plus the cooldown the UI must state. */
async function listJob(env: Env, auth: AuthorizedDevice): Promise<Response> {
  const db = createDb(env.DB);
  const job = await db.get<JobRow>(sql`SELECT id AS jobId, state, progress, created_at AS createdAt
    FROM crypto_jobs WHERE account_id = ${auth.accountId} AND kind = 'pseudonym_update' AND state = 'pending'
      AND ${privateReadGuard(auth)}`);
  const profile = await db.get<{ pseudonym_changed_at: number | null }>(sql`SELECT pseudonym_changed_at
    FROM account_profiles WHERE account_id = ${auth.accountId} AND ${privateReadGuard(auth)}`);
  if (!profile) return notFound();
  return Response.json({ job: job ? jobWire(job) : null,
    nextChangeAt: nextPseudonymChangeAt(profile.pseudonym_changed_at) }, { headers });
}

/** Start the one exclusive job for this Account, pinned to the current profile
 * revision. A lost-response retry with the same job ID is idempotent. */
async function startJob(env: Env, auth: AuthorizedDevice, value: unknown): Promise<Response> {
  const input = record(value), profile = record(input?.profile);
  if (!input || !exact(input, ["jobId", "profile"]) || !isV7(input.jobId) || !profile ||
      !exact(profile, ["ciphertext", "epoch", "revision"]) || !positiveEpoch(profile.epoch) ||
      !positiveRevision(profile.revision)) return invalid();
  const db = createDb(env.DB);
  const current = await db.get<{ revision: number; epoch: number; pseudonym_changed_at: number | null }>(sql`
    SELECT revision, epoch, pseudonym_changed_at FROM account_profiles
    WHERE account_id = ${auth.accountId} AND ${privateReadGuard(auth)}`);
  if (!current) return notFound();
  const existing = await db.get<{ id: string }>(sql`SELECT id FROM crypto_jobs WHERE account_id = ${auth.accountId}
    AND kind = 'pseudonym_update' AND state = 'pending'`);
  if (existing) return existing.id === input.jobId
    ? Response.json({ jobId: input.jobId, created: false }, { headers }) : pending();
  const now = Date.now(), nextChangeAt = nextPseudonymChangeAt(current.pseudonym_changed_at);
  if (nextChangeAt !== null && nextChangeAt > now) return failure("pseudonym_cooldown", 409, { nextChangeAt });
  const revision = current.revision + 1;
  if (profile.epoch !== current.epoch || profile.revision !== revision) return changed();
  let ciphertext: Uint8Array<ArrayBuffer>;
  try {
    ciphertext = treeEnvelope(profile.ciphertext, PROFILE_CIPHERTEXT_BYTES, accountProfileContext({
      accountId: auth.accountId, epoch: current.epoch, revision }));
  } catch { return invalid(); }
  const committed = await commitPrivateBatch(env, auth, (guard) => sql`
    UPDATE account_profiles SET updated_at = updated_at
    WHERE account_id = ${auth.accountId} AND revision = ${current.revision} AND epoch = ${current.epoch}
      AND (pseudonym_changed_at IS NULL OR pseudonym_changed_at <= ${now - PSEUDONYM_COOLDOWN_MS})
      AND NOT EXISTS (SELECT 1 FROM crypto_jobs WHERE account_id = ${auth.accountId}
        AND kind = 'pseudonym_update' AND state = 'pending')
      AND ${guard}`,
  (marker) => [
    sql`INSERT INTO crypto_jobs (id, account_id, device_id, kind, state, cursor, initiating_account_id,
      target_id, key_epoch, progress, created_at, updated_at)
      SELECT ${input.jobId}, ${auth.accountId}, ${auth.deviceId}, 'pseudonym_update', 'pending', NULL,
        ${auth.accountId}, NULL, NULL, 0, ${now}, ${now} WHERE ${marker}`,
    sql`INSERT INTO pseudonym_update_profiles (job_id, ciphertext, epoch, revision, created_at)
      SELECT ${input.jobId}, ${ciphertext}, ${current.epoch}, ${revision}, ${now} WHERE ${marker}`,
  ]);
  if (committed) return Response.json({ jobId: input.jobId, created: true }, { status: 201, headers });
  const raced = await db.get<{ id: string }>(sql`SELECT id FROM crypto_jobs WHERE account_id = ${auth.accountId}
    AND kind = 'pseudonym_update' AND state = 'pending'`);
  if (raced?.id === input.jobId) return Response.json({ jobId: input.jobId, created: false }, { headers });
  if (raced) return pending();
  const latest = await db.get<{ pseudonym_changed_at: number | null }>(sql`SELECT pseudonym_changed_at
    FROM account_profiles WHERE account_id = ${auth.accountId} AND ${privateReadGuard(auth)}`);
  const next = nextPseudonymChangeAt(latest?.pseudonym_changed_at ?? null);
  return next !== null && next > Date.now() ? failure("pseudonym_cooldown", 409, { nextChangeAt: next }) : changed();
}

/** The next bounded work packet: contexts to stage, or commit when every
 * required context carries a current staged item. */
async function nextJob(env: Env, auth: AuthorizedDevice, jobId: string): Promise<Response> {
  const db = createDb(env.DB);
  const job = await db.get<JobRow>(sql`SELECT id AS jobId, state, progress, created_at AS createdAt
    FROM crypto_jobs WHERE id = ${jobId} AND account_id = ${auth.accountId} AND kind = 'pseudonym_update'
      AND ${privateReadGuard(auth)}`);
  if (!job) return notFound();
  if (job.state === "complete") return Response.json({ job: jobWire(job), operation: "complete" }, { headers });
  if (job.state !== "pending") return Response.json({ job: jobWire(job), operation: "cancelled" }, { headers });
  const profile = await db.get<ProfileRow>(sql`SELECT ciphertext, epoch, revision
    FROM pseudonym_update_profiles WHERE job_id = ${jobId}`);
  if (!profile) return changed();
  const counts = await db.get<{ total: number; missing: number }>(sql`
    SELECT (SELECT count(*) FROM (${threadContexts(auth)}) ctx)
        + (SELECT count(*) FROM (${publicationContexts(auth)}) ctx) AS total,
      (SELECT count(*) FROM (${threadContexts(auth)}) ctx WHERE NOT ${threadStaged(jobId)})
        + (SELECT count(*) FROM (${publicationContexts(auth)}) ctx WHERE NOT ${publicationStaged(jobId)}) AS missing`);
  const total = counts?.total ?? 0, missing = counts?.missing ?? 0;
  if (!missing) return Response.json({ job: jobWire(job), profile: profileWire(profile), operation: "commit",
    contexts: [], staged: total, total }, { headers });
  const threads = await db.all<ThreadContextRow>(sql`${missingThreads(auth, jobId, PSEUDONYM_PAGE)}`);
  const publications = await db.all<PublicationContextRow>(sql`${missingPublications(auth, jobId, PSEUDONYM_PAGE)}`);
  const contexts: unknown[] = [];
  for (const row of [...threads, ...publications].slice(0, PSEUDONYM_PAGE)) {
    if ("purpose" in row) {
      const objectId = row.purpose === "private-comment-thread" ? row.threadId : row.epochId;
      // Every envelope read re-derives live access with the ciphertext itself.
      const authority = row.ownerId === auth.accountId
        ? sql`EXISTS (SELECT 1 FROM comment_threads t WHERE t.id = ${row.threadId})`
        : sql`EXISTS (SELECT 1 FROM comment_threads t WHERE t.id = ${row.threadId}
            AND ${accessPredicate(auth, row.fileId, "read")})`;
      const envelope = await readCommentEnvelope(env, auth, { ownerId: row.ownerId, objectId,
        capabilityId: row.capabilityId, capabilityEpoch: row.capabilityEpoch, authority });
      if (!envelope) return preparing();
      contexts.push({ kind: "thread", recordId: row.recordId, threadId: row.threadId, epochId: row.epochId,
        objectId, fileId: row.fileId, ownerId: row.ownerId, purpose: row.purpose,
        publicationId: row.publicationId, currentRevision: row.currentRevision, revision: row.currentRevision + 1,
        capabilityId: row.capabilityId, capabilityEpoch: row.capabilityEpoch,
        envelope: commentEnvelopeWire(envelope, { purpose: row.purpose, fileId: row.fileId,
          threadId: row.threadId, objectId, publicationId: row.publicationId,
          capabilityId: row.capabilityId, capabilityEpoch: row.capabilityEpoch, deviceId: auth.deviceId }) });
    } else {
      contexts.push({ kind: "publication", recordId: row.recordId, publicationId: row.publicationId,
        fileId: row.fileId, linkId: row.linkId, publicKey: encodeTreeBytes(new Uint8Array(row.publicKey)),
        currentRevision: row.currentRevision, revision: row.currentRevision + 1 });
    }
  }
  return Response.json({ job: jobWire(job), profile: profileWire(profile), operation: "stage",
    contexts, staged: Math.max(0, total - missing), total }, { headers });
}

/** Stage one re-encrypted context. The submitted envelopes must bind the exact
 * current scope, capability and next revision; a stale context is 409. */
async function stageItem(env: Env, auth: AuthorizedDevice, jobId: string, recordId: string,
  value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["kind", "revision", "ciphertext", "contentKeyEnvelope"]) ||
      (input.kind !== "thread" && input.kind !== "publication") || !positiveRevision(input.revision)) return invalid();
  if (!await createDb(env.DB).get(sql`SELECT 1 FROM crypto_jobs WHERE id = ${jobId}
    AND account_id = ${auth.accountId} AND kind = 'pseudonym_update' AND state = 'pending'
    AND ${privateReadGuard(auth)}`)) return changed();
  const db = createDb(env.DB), now = Date.now();
  if (input.kind === "thread") {
    const context = await db.get<ThreadContextRow>(sql`SELECT * FROM (${threadContexts(auth)}) ctx
      WHERE ctx.recordId = ${recordId}`);
    if (!context) return notFound();
    const revision = context.currentRevision + 1;
    if (input.revision !== revision) return changed();
    let ciphertext: Uint8Array<ArrayBuffer>, contentKeyEnvelope: Uint8Array<ArrayBuffer>;
    try {
      if (context.purpose === "private-comment-thread") {
        ciphertext = treeEnvelope(input.ciphertext, MAX_ATTRIBUTION_BYTES,
          attributionContext(context.ownerId, recordId, revision));
        contentKeyEnvelope = treeEnvelope(input.contentKeyEnvelope, MAX_ATTRIBUTION_KEY_ENVELOPE_BYTES,
          attributionKeyContext(context.ownerId, recordId, context.capabilityId, context.capabilityEpoch, revision));
      } else {
        if (!context.publicationId) return changed();
        ciphertext = publicCommentEnvelope(input.ciphertext, MAX_ATTRIBUTION_BYTES,
          publicAttributionContext(context.publicationId, recordId, revision));
        contentKeyEnvelope = publicCommentEnvelope(input.contentKeyEnvelope, MAX_ATTRIBUTION_KEY_ENVELOPE_BYTES,
          publicAttributionKeyContext(context.publicationId, recordId, context.capabilityId,
            context.capabilityEpoch, revision));
      }
    } catch { return invalid(); }
    const committed = await commitPrivateBatch(env, auth, (guard) => sql`
      UPDATE thread_attributions SET updated_at = updated_at
      WHERE id = ${recordId} AND author_id = ${auth.accountId} AND revision = ${context.currentRevision}
        AND EXISTS (SELECT 1 FROM (${threadContexts(auth)}) ctx WHERE ctx.recordId = ${recordId}
          AND ctx.currentRevision = ${context.currentRevision} AND ctx.capabilityEpoch = ${context.capabilityEpoch})
        AND ${guard}`,
    (marker) => [
      sql`INSERT INTO pseudonym_update_items (job_id, kind, record_id, revision, ciphertext,
        content_key_envelope, content_key_epoch, created_at)
        SELECT ${jobId}, 'thread', ${recordId}, ${revision}, ${ciphertext}, ${contentKeyEnvelope},
          ${context.capabilityEpoch}, ${now} WHERE ${marker}
        ON CONFLICT (job_id, kind, record_id) DO UPDATE SET revision = excluded.revision,
          ciphertext = excluded.ciphertext, content_key_envelope = excluded.content_key_envelope,
          content_key_epoch = excluded.content_key_epoch, created_at = excluded.created_at`,
      sql`UPDATE crypto_jobs SET progress = (SELECT count(*) FROM pseudonym_update_items WHERE job_id = ${jobId}),
        updated_at = ${now} WHERE id = ${jobId} AND ${marker}`,
    ]);
    return committed ? Response.json({ staged: true, revision }, { headers }) : changed();
  }
  if (input.contentKeyEnvelope !== null) return invalid();
  const context = await db.get<PublicationContextRow>(sql`SELECT * FROM (${publicationContexts(auth)}) ctx
    WHERE ctx.recordId = ${recordId}`);
  if (!context) return notFound();
  const revision = context.currentRevision + 1;
  if (input.revision !== revision) return changed();
  let ciphertext: Uint8Array<ArrayBuffer>;
  try {
    ciphertext = declarationEnvelope(input.ciphertext, authorDeclarationContext({ publicationId: context.publicationId,
      linkId: context.linkId, publicKey: new Uint8Array(context.publicKey), declarationId: recordId, revision }));
  } catch { return invalid(); }
  const committed = await commitPrivateBatch(env, auth, (guard) => sql`
    UPDATE publication_authors SET updated_at = updated_at
    WHERE id = ${recordId} AND author_id = ${auth.accountId} AND revision = ${context.currentRevision}
      AND link_id = ${context.linkId}
      AND EXISTS (SELECT 1 FROM (${publicationContexts(auth)}) ctx WHERE ctx.recordId = ${recordId}
        AND ctx.currentRevision = ${context.currentRevision} AND ctx.linkId = ${context.linkId})
      AND ${guard}`,
  (marker) => [
    sql`INSERT INTO pseudonym_update_items (job_id, kind, record_id, revision, ciphertext,
      content_key_envelope, content_key_epoch, created_at)
      SELECT ${jobId}, 'publication', ${recordId}, ${revision}, ${ciphertext}, NULL, NULL, ${now}
      WHERE ${marker}
      ON CONFLICT (job_id, kind, record_id) DO UPDATE SET revision = excluded.revision,
        ciphertext = excluded.ciphertext, content_key_envelope = NULL, content_key_epoch = NULL,
        created_at = excluded.created_at`,
    sql`UPDATE crypto_jobs SET progress = (SELECT count(*) FROM pseudonym_update_items WHERE job_id = ${jobId}),
      updated_at = ${now} WHERE id = ${jobId} AND ${marker}`,
  ]);
  return committed ? Response.json({ staged: true, revision }, { headers }) : changed();
}

/** Commit swaps the staged profile and every staged context in one transaction;
 * cancel discards staging without changing any displayed pseudonym. */
async function stepJob(env: Env, auth: AuthorizedDevice, jobId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["operation"]) ||
      (input.operation !== "commit" && input.operation !== "cancel")) return invalid();
  const db = createDb(env.DB), now = Date.now();
  const job = await db.get<{ state: string }>(sql`SELECT state FROM crypto_jobs WHERE id = ${jobId}
    AND account_id = ${auth.accountId} AND kind = 'pseudonym_update' AND ${privateReadGuard(auth)}`);
  if (!job) return notFound();
  if (input.operation === "cancel") {
    if (job.state !== "pending") return Response.json({ cancelled: true, alreadyCancelled: true }, { headers });
    const committed = await commitPrivateBatch(env, auth, (guard) => sql`
      UPDATE crypto_jobs SET state = 'cancelled', updated_at = ${now}
      WHERE id = ${jobId} AND account_id = ${auth.accountId} AND kind = 'pseudonym_update' AND state = 'pending'
        AND ${guard}`,
    (marker) => [
      sql`DELETE FROM pseudonym_update_items WHERE job_id = ${jobId} AND ${marker}`,
      sql`DELETE FROM pseudonym_update_profiles WHERE job_id = ${jobId} AND ${marker}`,
    ]);
    if (committed) return Response.json({ cancelled: true }, { headers });
    const state = await db.get<{ state: string }>(sql`SELECT state FROM crypto_jobs WHERE id = ${jobId}
      AND account_id = ${auth.accountId} AND kind = 'pseudonym_update' AND ${privateReadGuard(auth)}`);
    return state?.state === "cancelled" ? Response.json({ cancelled: true, alreadyCancelled: true }, { headers }) : changed();
  }
  if (job.state === "complete") return Response.json({ committed: true, alreadyCommitted: true }, { headers });
  if (job.state !== "pending") return changed();
  const staged = await db.get<{ count: number }>(sql`SELECT count(*) AS count FROM pseudonym_update_items
    WHERE job_id = ${jobId}`);
  // The anchor changes the current profile only when every required context is
  // staged at its current revision, so no dependent row can switch alone.
  const committed = await commitPrivateBatch(env, auth, (guard) => sql`
    UPDATE account_profiles SET
      ciphertext = (SELECT p.ciphertext FROM pseudonym_update_profiles p WHERE p.job_id = ${jobId}),
      revision = (SELECT p.revision FROM pseudonym_update_profiles p WHERE p.job_id = ${jobId}),
      pseudonym_changed_at = ${now}, updated_at = ${now}
    WHERE account_id = ${auth.accountId}
      AND EXISTS (SELECT 1 FROM crypto_jobs j WHERE j.id = ${jobId} AND j.account_id = ${auth.accountId}
        AND j.kind = 'pseudonym_update' AND j.state = 'pending')
      AND (pseudonym_changed_at IS NULL OR pseudonym_changed_at <= ${now - PSEUDONYM_COOLDOWN_MS})
      AND (SELECT p.epoch FROM pseudonym_update_profiles p WHERE p.job_id = ${jobId}) = epoch
      AND ${noMissingThreads(auth, jobId)} AND ${noMissingPublications(auth, jobId)}
      AND ${guard}`,
  (marker) => [
    sql`UPDATE thread_attributions SET
      ciphertext = (SELECT i.ciphertext FROM pseudonym_update_items i WHERE i.job_id = ${jobId}
        AND i.kind = 'thread' AND i.record_id = thread_attributions.id),
      content_key_envelope = (SELECT i.content_key_envelope FROM pseudonym_update_items i WHERE i.job_id = ${jobId}
        AND i.kind = 'thread' AND i.record_id = thread_attributions.id),
      content_key_epoch = (SELECT i.content_key_epoch FROM pseudonym_update_items i WHERE i.job_id = ${jobId}
        AND i.kind = 'thread' AND i.record_id = thread_attributions.id),
      revision = (SELECT i.revision FROM pseudonym_update_items i WHERE i.job_id = ${jobId}
        AND i.kind = 'thread' AND i.record_id = thread_attributions.id),
      updated_at = ${now}
    WHERE author_id = ${auth.accountId} AND EXISTS (SELECT 1 FROM pseudonym_update_items i
      WHERE i.job_id = ${jobId} AND i.kind = 'thread' AND i.record_id = thread_attributions.id) AND ${marker}`,
    sql`UPDATE publication_authors SET
      ciphertext = (SELECT i.ciphertext FROM pseudonym_update_items i WHERE i.job_id = ${jobId}
        AND i.kind = 'publication' AND i.record_id = publication_authors.id),
      revision = (SELECT i.revision FROM pseudonym_update_items i WHERE i.job_id = ${jobId}
        AND i.kind = 'publication' AND i.record_id = publication_authors.id),
      updated_at = ${now}
    WHERE author_id = ${auth.accountId} AND EXISTS (SELECT 1 FROM pseudonym_update_items i
      WHERE i.job_id = ${jobId} AND i.kind = 'publication' AND i.record_id = publication_authors.id) AND ${marker}`,
    sql`UPDATE crypto_jobs SET state = 'complete', progress = ${staged?.count ?? 0}, updated_at = ${now}
      WHERE id = ${jobId} AND ${marker}`,
    sql`DELETE FROM pseudonym_update_items WHERE job_id = ${jobId} AND ${marker}`,
    sql`DELETE FROM pseudonym_update_profiles WHERE job_id = ${jobId} AND ${marker}`,
  ]);
  if (committed) return Response.json({ committed: true }, { headers });
  const state = await db.get<{ state: string }>(sql`SELECT state FROM crypto_jobs WHERE id = ${jobId}
    AND account_id = ${auth.accountId} AND kind = 'pseudonym_update' AND ${privateReadGuard(auth)}`);
  if (state?.state === "complete") return Response.json({ committed: true, alreadyCommitted: true }, { headers });
  const latest = await db.get<{ pseudonym_changed_at: number | null }>(sql`SELECT pseudonym_changed_at
    FROM account_profiles WHERE account_id = ${auth.accountId} AND ${privateReadGuard(auth)}`);
  const next = nextPseudonymChangeAt(latest?.pseudonym_changed_at ?? null);
  return next !== null && next > Date.now() ? failure("pseudonym_cooldown", 409, { nextChangeAt: next }) : changed();
}

// ---------------------------------------------------------------------------
// Resource-only API
// ---------------------------------------------------------------------------

/** Proof-guarded Pseudonym-update API. Reads are bodyless POSTs; no response
 * carries a plaintext pseudonym. */
export async function pseudonymAction(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (new URL(request.url).search) return notFound();
  const collection = path === "/api/private/pseudonym-updates";
  const next = /^\/api\/private\/pseudonym-updates\/([0-9a-f-]+)\/next$/.exec(path);
  const item = /^\/api\/private\/pseudonym-updates\/([0-9a-f-]+)\/items\/([A-Za-z0-9_-]+)$/.exec(path);
  const step = /^\/api\/private\/pseudonym-updates\/([0-9a-f-]+)\/step$/.exec(path);
  const match = next ?? item ?? step;
  const allowed = (collection && (request.method === "POST" || request.method === "PUT")) ||
    (next && request.method === "POST") || (item && request.method === "PUT") ||
    (step && request.method === "PATCH");
  if (!allowed || !match && !collection) return notFound();
  const jobId = match?.[1] ?? null, recordId = item?.[2] ?? null;
  if (jobId !== null && !isV7(jobId)) return notFound();
  if (recordId !== null && !pseudonymRecordId(recordId)) return notFound();
  const reading = request.method === "POST" && (collection || next !== null);
  let raw = "", value: unknown = null;
  try {
    if (reading) { if (!await hasEmptyBody(request)) return denied(); }
    else { const parsed = await readAuthJsonText(request, 512 * 1024); raw = parsed.raw; value = parsed.value; }
  } catch { return invalid(); }
  let proof: unknown;
  try { proof = JSON.parse(request.headers.get("X-Mdwn-Device-Proof") ?? "null"); }
  catch { return denied(); }
  const auth = await authorizePrivateRequest(request, env, proof, raw);
  if (!auth) return denied();
  if (collection) return request.method === "PUT" ? startJob(env, auth, value) : listJob(env, auth);
  if (next) return nextJob(env, auth, next[1]!);
  if (step) return stepJob(env, auth, step[1]!, value);
  return stageItem(env, auth, item![1]!, recordId!, value);
}
