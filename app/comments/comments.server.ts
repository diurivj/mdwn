import type { SQL } from "drizzle-orm";
import { hasEmptyBody, readAuthJsonText, record } from "~/auth/request.server";
import {
  attributionContext,
  attributionKeyContext,
  commentBodyContext,
  commentKeyContext,
  MAX_ATTRIBUTION_BYTES,
  MAX_ATTRIBUTION_KEY_ENVELOPE_BYTES,
  MAX_COMMENT_BODY_BYTES,
  MAX_COMMENT_KEY_ENVELOPE_BYTES,
  MAX_COMMENTS_PAGE,
} from "~/comments/content";
import { commentEnvelopeWire, readCommentEnvelope, type CommentEnvelope } from "~/comments/envelopes.server";
import { changePublicAudience, createPublicComment, deletePublicComment, editPublicComment, readFilePublicComments, reportPublicComment } from "~/comments/public.server";
import { pseudonymUpdatePending } from "~/account/pseudonym-guard.server";
import { isPublicationIdentifier } from "~/publications/capability";
import { createDb, sql } from "~/db/client.server";
import { authorizePrivateRequest, commitPrivateBatch, commitPrivateMutation, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { accessPredicate, committedNodeVisible, sharingWriteBlocked } from "~/sharing/access.server";
import { decodeTreeBytes, encodeTreeBytes, isV7, treeEnvelope } from "~/tree/wire";

const headers = { "Cache-Control": "no-store" };
const failure = (error: string, status: number) => Response.json({ error }, { status, headers });
const notFound = () => failure("not_found", 404);
const invalid = () => failure("invalid_comment_request", 400);
const changed = () => failure("comment_changed", 409);
const denied = () => failure("device_proof_required", 403);

const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const positiveEpoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const positiveRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const cursorValue = (value: unknown): value is number =>
  value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

type ThreadRow = {
  threadId: string; ownerId: string; fileId: string; epochId: string;
  keyEpoch: number; capabilityId: string; capabilityEpoch: number;
};

/** Current Private thread with its active epoch and registered capability. */
function currentThread(fileId: string | SQL, threadId?: string | SQL) {
  return sql`SELECT t.id AS threadId, t.owner_id AS ownerId, t.file_id AS fileId, t.current_epoch_id AS epochId,
      e.key_epoch AS keyEpoch, c.capability_id AS capabilityId, c.capability_epoch AS capabilityEpoch
    FROM comment_threads t
    JOIN comment_thread_epochs e ON e.id = t.current_epoch_id AND e.thread_id = t.id
    JOIN sharing_comment_capabilities c ON c.object_id = t.id AND c.purpose = 'private-comment-thread'
      AND c.owner_id = t.owner_id AND c.file_id = t.file_id
    WHERE t.file_id = ${fileId} AND t.purpose = 'private'${threadId ? sql` AND t.id = ${threadId}` : sql``}`;
}

/** Stored thread, capability and epoch are pinned; live File-read access is
 * re-derived in the same statement and never cached from a prior read. */
function threadAuthority(auth: AuthorizedDevice, fileId: string, threadId: string,
  capabilityId: string, capabilityEpoch: number, epochId: string) {
  return sql`EXISTS (SELECT 1 FROM (${currentThread(fileId, threadId)}) t
    WHERE t.epochId = ${epochId} AND t.keyEpoch = ${capabilityEpoch}
      AND t.capabilityId = ${capabilityId} AND t.capabilityEpoch = ${capabilityEpoch}
      AND ${accessPredicate(auth, fileId, "read")})`;
}

async function fileAccess(env: Env, auth: AuthorizedDevice, fileId: string) {
  return createDb(env.DB).get<{ is_owner: number }>(sql`SELECT n.owner_id = ${auth.accountId} AS is_owner
    FROM vault_nodes n WHERE n.id = ${fileId} AND n.kind = 'file' AND ${privateReadGuard(auth)}
      AND ${committedNodeVisible(sql`n`)}
      AND (n.owner_id = ${auth.accountId} OR ${accessPredicate(auth, fileId, "read")})`);
}

/** Shared mutation preflight: the stored thread, its current epoch/capability and
 * live File-read access are all re-derived in one statement. */
async function threadPreflight(env: Env, auth: AuthorizedDevice, fileId: string, threadId: string,
  epochId: string, capabilityId: string, capabilityEpoch: number): Promise<{ thread: ThreadRow } | { response: Response }> {
  const thread = await createDb(env.DB).get<ThreadRow>(sql`SELECT * FROM (${currentThread(fileId, threadId)}) t
    WHERE ${privateReadGuard(auth)} AND ${accessPredicate(auth, fileId, "read")}`);
  if (!thread) return { response: notFound() };
  if (thread.epochId !== epochId || thread.keyEpoch !== capabilityEpoch ||
      thread.capabilityId !== capabilityId || thread.capabilityEpoch !== capabilityEpoch) return { response: changed() };
  return { thread };
}

/** The Owner opens its owned recovery envelope; an eligible device receives its
 * current signed Grant envelope. Missing material is a ciphertext-free 409. */
async function threadEnvelope(env: Env, auth: AuthorizedDevice, thread: ThreadRow): Promise<CommentEnvelope | null> {
  return readCommentEnvelope(env, auth, { ownerId: thread.ownerId, objectId: thread.threadId,
    capabilityId: thread.capabilityId, capabilityEpoch: thread.capabilityEpoch,
    authority: threadAuthority(auth, thread.fileId, thread.threadId,
      thread.capabilityId, thread.capabilityEpoch, thread.epochId) });
}

type CommentRow = { id: string; author_id: string; sequence: number; revision: number; body_ciphertext: ArrayBuffer;
  body_size: number; content_key_envelope: ArrayBuffer; content_key_epoch: number; created_at: number; updated_at: number;
  meta_ciphertext: ArrayBuffer | null };
type AttributionRow = { id: string; author_id: string; revision: number; ciphertext: ArrayBuffer;
  content_key_envelope: ArrayBuffer; content_key_epoch: number };

async function readComments(env: Env, auth: AuthorizedDevice, fileId: string, cursor: number, probe = false): Promise<Response> {
  const db = createDb(env.DB);
  const thread = await db.get<ThreadRow>(sql`SELECT * FROM (${currentThread(fileId)}) t
    WHERE ${accessPredicate(auth, fileId, "read")}`);
  if (!thread) {
    const access = await fileAccess(env, auth, fileId);
    if (!access) return notFound();
    return Response.json({ thread: null, canCreateThread: Boolean(access.is_owner) }, { headers });
  }
  // A presence probe lets an Owner device ensure the thread on File open
  // without fetching or opening any thread ciphertext.
  if (probe) return Response.json({ thread: { threadId: thread.threadId } }, { headers });
  const envelope = await threadEnvelope(env, auth, thread);
  if (!envelope) return failure(thread.ownerId === auth.accountId ? "owned_comment_key_missing" : "secure_access_preparing", 409);
  const authority = threadAuthority(auth, thread.fileId, thread.threadId,
    thread.capabilityId, thread.capabilityEpoch, thread.epochId);
  const comments = await db.all<CommentRow>(sql`SELECT c.id, c.author_id, c.sequence, c.revision, c.body_ciphertext,
      c.body_size, c.content_key_envelope, c.content_key_epoch, c.created_at, c.updated_at,
      m.ciphertext AS meta_ciphertext FROM comments c
    LEFT JOIN import_comment_meta m ON m.comment_id = c.id
    WHERE c.thread_id = ${thread.threadId} AND c.sequence > ${cursor} AND ${authority}
    ORDER BY c.sequence LIMIT ${MAX_COMMENTS_PAGE + 1}`);
  const authors = [...new Set([auth.accountId, ...comments.map((comment) => comment.author_id)])];
  // Every displayed Comment author plus the actor is bounded by the page size,
  // so the pseudonym query returns exactly that set and never truncates one.
  const attributions = await db.all<AttributionRow>(sql`SELECT id, author_id, revision, ciphertext,
      content_key_envelope, content_key_epoch FROM thread_attributions
    WHERE thread_id = ${thread.threadId} AND author_id IN (${sql.join(authors.map((author) => sql`${author}`), sql`, `)})
      AND ${authority}
    ORDER BY id LIMIT ${MAX_COMMENTS_PAGE + 1}`);
  return Response.json({
    thread: { threadId: thread.threadId, fileId: thread.fileId, ownerId: thread.ownerId, epochId: thread.epochId,
      capabilityId: thread.capabilityId, capabilityEpoch: thread.capabilityEpoch,
      canComment: true, canDeleteAny: thread.ownerId === auth.accountId, actorAccountId: auth.accountId,
      envelope: commentEnvelopeWire(envelope, { purpose: "private-comment-thread", fileId: thread.fileId,
        threadId: thread.threadId, objectId: thread.threadId, publicationId: null,
        capabilityId: thread.capabilityId, capabilityEpoch: thread.capabilityEpoch, deviceId: auth.deviceId }) },
    comments: comments.slice(0, MAX_COMMENTS_PAGE).map((comment) => ({ id: comment.id, authorId: comment.author_id,
      sequence: comment.sequence, revision: comment.revision,
      bodyCiphertext: encodeTreeBytes(new Uint8Array(comment.body_ciphertext)), bodySize: comment.body_size,
      contentKeyEnvelope: encodeTreeBytes(new Uint8Array(comment.content_key_envelope)),
      metaCiphertext: comment.meta_ciphertext ? encodeTreeBytes(new Uint8Array(comment.meta_ciphertext)) : null,
      contentKeyEpoch: comment.content_key_epoch, createdAt: comment.created_at, updatedAt: comment.updated_at })),
    nextCursor: comments.length > MAX_COMMENTS_PAGE ? comments[MAX_COMMENTS_PAGE - 1]!.sequence : null,
    attributions: attributions.map((attribution) => ({ id: attribution.id,
      authorId: attribution.author_id, revision: attribution.revision,
      ciphertext: encodeTreeBytes(new Uint8Array(attribution.ciphertext)),
      contentKeyEnvelope: encodeTreeBytes(new Uint8Array(attribution.content_key_envelope)),
      contentKeyEpoch: attribution.content_key_epoch })),
  }, { headers });
}

async function existingThread(env: Env, auth: AuthorizedDevice, fileId: string) {
  return createDb(env.DB).get<{ thread_id: string }>(sql`SELECT t.id AS thread_id FROM comment_threads t
    JOIN vault_nodes n ON n.id = t.file_id AND n.owner_id = t.owner_id AND ${committedNodeVisible(sql`n`)}
    WHERE t.file_id = ${fileId} AND t.purpose = 'private' AND n.owner_id = ${auth.accountId}
      AND ${privateReadGuard(auth)}`);
}

/** Owner-only, create-once Private thread. A retry after a lost response is
 * harmless; an already-existing thread wins and the caller re-reads it.
 */
async function createThread(env: Env, auth: AuthorizedDevice, fileId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["threadId", "epochId", "capabilityId", "recoveryEnvelope"]) ||
      !isV7(input.threadId) || !isV7(input.epochId) || !isV7(input.capabilityId)) return invalid();
  // A non-Owner sees the same 404 for an absent, existing or malformed thread.
  if (!await createDb(env.DB).get(sql`SELECT 1 FROM vault_nodes n WHERE n.id = ${fileId} AND n.kind = 'file'
    AND n.owner_id = ${auth.accountId} AND ${privateReadGuard(auth)}`)) return notFound();
  const existing = await existingThread(env, auth, fileId);
  if (existing) return Response.json({ threadId: existing.thread_id, created: false }, { headers });
  // A new encrypted thread beneath a rotation seal must wait for safe completion.
  if (await createDb(env.DB).get(sql`SELECT 1 WHERE ${sharingWriteBlocked(fileId)}`)) return failure("key_rotation_required", 409);
  let recoveryEnvelope: Uint8Array;
  try {
    recoveryEnvelope = treeEnvelope(input.recoveryEnvelope, MAX_COMMENT_KEY_ENVELOPE_BYTES, {
      purpose: "vault-recovery", vaultId: auth.accountId, objectId: input.threadId,
      keyId: input.capabilityId, keyEpoch: 1, revision: 1,
    });
  } catch { return invalid(); }
  const now = Date.now();
  const committed = await commitPrivateBatch(env, auth, (guard) => sql`
    UPDATE vault_nodes SET updated_at = updated_at
    WHERE id = ${fileId} AND owner_id = ${auth.accountId} AND kind = 'file'
      AND NOT EXISTS (SELECT 1 FROM comment_threads WHERE file_id = ${fileId} AND purpose = 'private')
      AND NOT ${sharingWriteBlocked(fileId)} AND ${guard}`,
  (marker) => [
    sql`INSERT INTO comment_thread_epochs (id, thread_id, audience, key_epoch, ordinal, state, created_at)
      SELECT ${input.epochId}, ${input.threadId}, NULL, 1, 1, 'active', ${now} WHERE ${marker}`,
    sql`INSERT INTO comment_threads (id, owner_id, file_id, purpose, publication_id, current_epoch_id, next_sequence, created_at)
      SELECT ${input.threadId}, ${auth.accountId}, ${fileId}, 'private', NULL, ${input.epochId}, 1, ${now} WHERE ${marker}`,
    sql`INSERT INTO sharing_comment_capabilities (object_id, owner_id, file_id, thread_id, purpose, publication_id, capability_id, capability_epoch)
      SELECT ${input.threadId}, ${auth.accountId}, ${fileId}, ${input.threadId}, 'private-comment-thread', NULL,
        ${input.capabilityId}, 1 WHERE ${marker}`,
    sql`INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch)
      SELECT ${auth.accountId}, 'vault-recovery', ${input.threadId}, 'vault-root', ${recoveryEnvelope}, 1 WHERE ${marker}`,
  ], { deferForeignKeys: true });
  if (committed) return Response.json({ threadId: input.threadId, created: true }, { status: 201, headers });
  const raced = await existingThread(env, auth, fileId);
  return raced ? Response.json({ threadId: raced.thread_id, created: false }, { headers }) : notFound();
}

type AttributionInput = { attributionId: string; ciphertext: Uint8Array; contentKeyEnvelope: Uint8Array };

/** Validate a submitted attribution envelope pair against the thread capability. */
function attributionInput(value: unknown, ownerId: string, capabilityId: string, capabilityEpoch: number): AttributionInput | null {
  const input = record(value);
  if (!input || !exact(input, ["attributionId", "ciphertext", "contentKeyEnvelope"]) || !isV7(input.attributionId)) return null;
  try {
    return { attributionId: input.attributionId,
      ciphertext: treeEnvelope(input.ciphertext, MAX_ATTRIBUTION_BYTES,
        attributionContext(ownerId, input.attributionId, 1)),
      contentKeyEnvelope: treeEnvelope(input.contentKeyEnvelope, MAX_ATTRIBUTION_KEY_ENVELOPE_BYTES,
        attributionKeyContext(ownerId, input.attributionId, capabilityId, capabilityEpoch, 1)) };
  } catch { return null; }
}

async function createComment(env: Env, auth: AuthorizedDevice, fileId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["commentId", "threadId", "capabilityId", "capabilityEpoch", "epochId",
      "bodyCiphertext", "contentKeyEnvelope", "attribution"]) ||
      !isV7(input.commentId) || !isV7(input.threadId) || !isV7(input.capabilityId) || !isV7(input.epochId) ||
      !positiveEpoch(input.capabilityEpoch)) return invalid();
  const commentId = input.commentId, threadId = input.threadId, capabilityId = input.capabilityId;
  const capabilityEpoch = input.capabilityEpoch, epochId = input.epochId;
  const preflight = await threadPreflight(env, auth, fileId, threadId, epochId, capabilityId, capabilityEpoch);
  if ("response" in preflight) return preflight.response;
  const { thread } = preflight;
  // A pending Pseudonym update owns every new attribution context; normal work
  // that would mint one waits for the job to commit or be cancelled.
  if (await createDb(env.DB).get(sql`SELECT 1 WHERE ${pseudonymUpdatePending(auth.accountId)}`))
    return failure("pseudonym_update_pending", 409);
  // The same seal is rechecked in the committing CAS; this only reports it clearly.
  if (await createDb(env.DB).get(sql`SELECT 1 WHERE ${sharingWriteBlocked(fileId)}`)) return failure("key_rotation_required", 409);
  let bodyCiphertext: Uint8Array, contentKeyEnvelope: Uint8Array;
  let attribution: AttributionInput | null = null;
  try {
    bodyCiphertext = treeEnvelope(input.bodyCiphertext, MAX_COMMENT_BODY_BYTES,
      commentBodyContext(thread.ownerId, commentId, 1));
    contentKeyEnvelope = treeEnvelope(input.contentKeyEnvelope, MAX_COMMENT_KEY_ENVELOPE_BYTES,
      commentKeyContext(thread.ownerId, commentId, capabilityId, capabilityEpoch, 1));
    if (input.attribution !== null) {
      attribution = attributionInput(input.attribution, thread.ownerId, capabilityId, capabilityEpoch);
      if (!attribution) return invalid();
    }
  } catch { return invalid(); }
  const now = Date.now();
  let committed: boolean;
  try {
    committed = await commitPrivateBatch(env, auth, (guard) => sql`
      UPDATE comment_threads SET next_sequence = next_sequence + 1
      WHERE id = ${threadId} AND file_id = ${fileId} AND owner_id = ${thread.ownerId} AND purpose = 'private'
        AND current_epoch_id = ${epochId}
        AND ${threadAuthority(auth, fileId, threadId, capabilityId, capabilityEpoch, epochId)}
        AND NOT ${sharingWriteBlocked(fileId)} AND ${guard}`,
    (marker) => [
      sql`INSERT INTO comments (id, thread_id, epoch_id, author_id, sequence, revision, body_ciphertext, body_size,
        content_key_envelope, content_key_epoch, created_at, updated_at)
        SELECT ${commentId}, ${threadId}, ${epochId}, ${auth.accountId}, next_sequence - 1, 1,
          ${bodyCiphertext}, ${bodyCiphertext.byteLength}, ${contentKeyEnvelope}, ${capabilityEpoch}, ${now}, ${now}
        FROM comment_threads WHERE id = ${threadId} AND ${marker}`,
      ...(attribution ? [sql`INSERT INTO thread_attributions (id, thread_id, author_id, epoch_id, revision, ciphertext,
          content_key_envelope, content_key_epoch, created_at, updated_at)
        SELECT ${attribution.attributionId}, ${threadId}, ${auth.accountId}, ${epochId}, 1,
          ${attribution.ciphertext}, ${attribution.contentKeyEnvelope}, ${capabilityEpoch}, ${now}, ${now}
        WHERE ${marker} AND NOT EXISTS (SELECT 1 FROM thread_attributions
          WHERE thread_id = ${threadId} AND author_id = ${auth.accountId})`] : []),
    ]);
  } catch {
    // A lost-response retry reuses the same client-chosen Comment ID. The unique
    // insert loses and rolls back; the identical record is already present.
    const existing = await createDb(env.DB).get(sql`SELECT 1 FROM comments
      WHERE id = ${commentId} AND thread_id = ${threadId} AND author_id = ${auth.accountId}`);
    return existing ? Response.json({ commentId, created: false }, { headers }) : invalid();
  }
  return committed ? Response.json({ commentId, created: true }, { status: 201, headers }) : changed();
}

async function editComment(env: Env, auth: AuthorizedDevice, fileId: string, commentId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["threadId", "capabilityId", "capabilityEpoch", "epochId",
      "expectedRevision", "bodyCiphertext", "contentKeyEnvelope"]) ||
      !isV7(input.threadId) || !isV7(input.capabilityId) || !isV7(input.epochId) ||
      !positiveEpoch(input.capabilityEpoch) || !positiveRevision(input.expectedRevision)) return invalid();
  const threadId = input.threadId, capabilityId = input.capabilityId;
  const capabilityEpoch = input.capabilityEpoch, epochId = input.epochId, expectedRevision = input.expectedRevision;
  const preflight = await threadPreflight(env, auth, fileId, threadId, epochId, capabilityId, capabilityEpoch);
  if ("response" in preflight) return preflight.response;
  const { thread } = preflight;
  if (await createDb(env.DB).get(sql`SELECT 1 WHERE ${sharingWriteBlocked(fileId)}`)) return failure("key_rotation_required", 409);
  const revision = expectedRevision + 1;
  let bodyCiphertext: Uint8Array, contentKeyEnvelope: Uint8Array;
  try {
    bodyCiphertext = treeEnvelope(input.bodyCiphertext, MAX_COMMENT_BODY_BYTES,
      commentBodyContext(thread.ownerId, commentId, revision));
    contentKeyEnvelope = treeEnvelope(input.contentKeyEnvelope, MAX_COMMENT_KEY_ENVELOPE_BYTES,
      commentKeyContext(thread.ownerId, commentId, capabilityId, capabilityEpoch, revision));
  } catch { return invalid(); }
  const committed = await commitPrivateMutation(env, auth, (guard) => sql`
    UPDATE comments SET body_ciphertext = ${bodyCiphertext}, body_size = ${bodyCiphertext.byteLength},
      content_key_envelope = ${contentKeyEnvelope}, content_key_epoch = ${capabilityEpoch},
      revision = revision + 1, updated_at = ${Date.now()}
    WHERE id = ${commentId} AND thread_id = ${threadId} AND author_id = ${auth.accountId}
      AND revision = ${expectedRevision}
      AND ${threadAuthority(auth, fileId, threadId, capabilityId, capabilityEpoch, epochId)}
      AND NOT ${sharingWriteBlocked(fileId)} AND ${guard}`);
  if (committed) return Response.json({ revision }, { headers });
  const row = await createDb(env.DB).get<{ author_id: string }>(sql`SELECT c.author_id FROM comments c
    WHERE c.id = ${commentId} AND c.thread_id = ${threadId}
      AND ${threadAuthority(auth, fileId, threadId, capabilityId, capabilityEpoch, epochId)}`);
  return row && row.author_id !== auth.accountId ? failure("not_comment_author", 403) : changed();
}

async function deleteComment(env: Env, auth: AuthorizedDevice, fileId: string, commentId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["threadId", "capabilityId", "capabilityEpoch", "epochId", "expectedRevision"]) ||
      !isV7(input.threadId) || !isV7(input.capabilityId) || !isV7(input.epochId) ||
      !positiveEpoch(input.capabilityEpoch) || !positiveRevision(input.expectedRevision)) return invalid();
  const threadId = input.threadId, capabilityId = input.capabilityId;
  const capabilityEpoch = input.capabilityEpoch, epochId = input.epochId, expectedRevision = input.expectedRevision;
  const preflight = await threadPreflight(env, auth, fileId, threadId, epochId, capabilityId, capabilityEpoch);
  if ("response" in preflight) return preflight.response;
  // Hard deletion stays available while a rotation seal blocks new writes; the
  // same transaction drops any wrapper staged for this Comment.
  const committed = await commitPrivateBatch(env, auth, (guard) => sql`
    DELETE FROM comments WHERE id = ${commentId} AND thread_id = ${threadId} AND revision = ${expectedRevision}
      AND (author_id = ${auth.accountId} OR EXISTS (SELECT 1 FROM vault_nodes n
        WHERE n.id = ${fileId} AND n.owner_id = ${auth.accountId}))
      AND ${threadAuthority(auth, fileId, threadId, capabilityId, capabilityEpoch, epochId)}
      AND ${guard}`,
  (marker) => [sql`DELETE FROM key_rotation_comment_items
    WHERE kind = 'comment' AND record_id = ${commentId} AND ${marker}`]);
  if (committed) return Response.json({ deleted: true }, { headers });
  const row = await createDb(env.DB).get<{ author_id: string; owner_id: string }>(sql`SELECT c.author_id, t.owner_id
    FROM comments c JOIN comment_threads t ON t.id = c.thread_id
    WHERE c.id = ${commentId} AND c.thread_id = ${threadId}`);
  if (!row) return Response.json({ deleted: true, alreadyDeleted: true }, { headers });
  return row.author_id === auth.accountId || row.owner_id === auth.accountId ? changed() : failure("not_comment_author", 403);
}

/** Resource-only Comment API. Every private read is a proof-guarded, bodyless POST. */
export async function commentsAction(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  const collection = /^\/api\/private\/comments\/files\/([0-9a-f-]+)$/.exec(path);
  const entries = /^\/api\/private\/comments\/files\/([0-9a-f-]+)\/entries$/.exec(path);
  const entry = /^\/api\/private\/comments\/files\/([0-9a-f-]+)\/entries\/([0-9a-f-]+)$/.exec(path);
  const publicThread = /^\/api\/private\/comments\/files\/([0-9a-f-]+)\/public$/.exec(path);
  const publicEntries = /^\/api\/private\/comments\/files\/([0-9a-f-]+)\/public\/entries$/.exec(path);
  const publicEntry = /^\/api\/private\/comments\/files\/([0-9a-f-]+)\/public\/entries\/([0-9a-f-]+)$/.exec(path);
  const linkEntries = /^\/api\/private\/comments\/links\/([A-Za-z0-9_-]{43})\/entries$/.exec(path);
  const linkEntry = /^\/api\/private\/comments\/links\/([A-Za-z0-9_-]{43})\/entries\/([0-9a-f-]+)$/.exec(path);
  const reports = /^\/api\/private\/comments\/reports$/.exec(path);
  const allowed = (collection && (request.method === "POST" || request.method === "PUT")) ||
    (entries && request.method === "POST") ||
    (entry && (request.method === "PATCH" || request.method === "DELETE")) ||
    (publicThread && (request.method === "POST" || request.method === "PUT")) ||
    (publicEntries && request.method === "POST") ||
    (publicEntry && (request.method === "PATCH" || request.method === "DELETE")) ||
    (linkEntries && request.method === "POST") ||
    (linkEntry && (request.method === "PATCH" || request.method === "DELETE")) ||
    (reports && request.method === "POST");
  if (!allowed) return notFound();
  const fileMatch = collection ?? entries ?? entry ?? publicThread ?? publicEntries ?? publicEntry;
  const fileId = fileMatch?.[1] ?? null;
  const commentId = (entry ?? publicEntry ?? linkEntry)?.[2] ?? null;
  if (fileId !== null && !isV7(fileId) || commentId !== null && !isV7(commentId)) return notFound();
  const linkId = (linkEntries ?? linkEntry)?.[1] ?? null;
  if (linkId !== null && !isPublicationIdentifier(linkId)) return notFound();
  const reading = request.method === "POST" && (collection || publicThread);
  const cursorSupported = collection !== null || publicThread !== null;
  let raw = "", value: unknown = null, cursor = 0, probe = false;
  try {
    if (reading) {
      if (!await hasEmptyBody(request)) return denied();
      const params = url.searchParams;
      const parsed = params.get("cursor");
      if (parsed !== null) {
        if (!cursorSupported || !/^\d+$/.test(parsed)) return invalid();
        cursor = Number(parsed);
        if (!cursorValue(cursor)) return invalid();
      }
      const probeParam = params.get("probe");
      if (probeParam !== null && (!collection || probeParam !== "1")) return invalid();
      probe = probeParam === "1";
    } else {
      const parsed = await readAuthJsonText(request, 512 * 1024);
      raw = parsed.raw; value = parsed.value;
    }
  } catch { return invalid(); }
  let proof: unknown;
  try { proof = JSON.parse(request.headers.get("X-Mdwn-Device-Proof") ?? "null"); }
  catch { return denied(); }
  const auth = await authorizePrivateRequest(request, env, proof, raw);
  if (!auth) return denied();
  if (reports) return reportPublicComment(request, env, auth, value);
  if (collection) return request.method === "PUT" ? createThread(env, auth, fileId!, value)
    : readComments(env, auth, fileId!, cursor, probe);
  if (entries) return createComment(env, auth, fileId!, value);
  if (entry) return request.method === "PATCH" ? editComment(env, auth, fileId!, commentId!, value)
    : deleteComment(env, auth, fileId!, commentId!, value);
  if (publicThread) return request.method === "PUT" ? changePublicAudience(env, auth, fileId!, value)
    : readFilePublicComments(env, auth, fileId!, cursor);
  if (publicEntries) return createPublicComment(request, env, auth, { kind: "file", fileId: fileId! }, value);
  if (publicEntry) return request.method === "PATCH"
    ? editPublicComment(request, env, auth, { kind: "file", fileId: fileId! }, commentId!, value)
    : deletePublicComment(env, auth, { kind: "file", fileId: fileId! }, commentId!, value);
  if (linkEntries) return createPublicComment(request, env, auth, { kind: "link", linkId: linkId! }, value);
  return request.method === "PATCH"
    ? editPublicComment(request, env, auth, { kind: "link", linkId: linkId! }, commentId!, value)
    : deletePublicComment(env, auth, { kind: "link", linkId: linkId! }, commentId!, value);
}
