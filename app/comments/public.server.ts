import type { SQL } from "drizzle-orm";
import { pseudonymUpdatePending } from "~/account/pseudonym-guard.server";
import { record } from "~/auth/request.server";
import { MAX_ATTRIBUTION_BYTES, MAX_ATTRIBUTION_KEY_ENVELOPE_BYTES, MAX_COMMENT_BODY_BYTES,
  MAX_COMMENT_KEY_ENVELOPE_BYTES, MAX_COMMENTS_PAGE } from "~/comments/content";
import { commentEnvelopeWire, readCommentEnvelopes } from "~/comments/envelopes.server";
import { isCommentEpochLink, MAX_PUBLIC_EPOCH_LINK_BYTES, publicAttributionContext, publicAttributionKeyContext,
  publicCommentBodyContext, publicCommentEnvelope, publicCommentKeyContext } from "~/comments/public-content";
import { createDb, sql } from "~/db/client.server";
import { commitPrivateBatch, commitPrivateMutation, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { isPublicationIdentifier } from "~/publications/capability";
import { AbuseControlUnavailableError, abuseControlUnavailableResponse, enforceRateLimit, rateLimitResponse } from "~/security/abuse-control.server";
import { isReportCategory, REPORT_RETENTION_MS } from "~/security/public-participation";
import { activePublicParticipationSuspension, publicParticipationSuspendedResponse } from "~/security/public-participation.server";
import { accessPredicate, sharingWriteBlocked } from "~/sharing/access.server";
import { decodeTreeBytes, encodeTreeBytes, isV7, treeEnvelope } from "~/tree/wire";

/**
 * Public Comment threads and Comment audience epochs (ticket 23).
 *
 * A Publication has one logical Public thread built from ordered audience
 * epochs. Every epoch has an independently random capability; a `public` epoch
 * is wrapped to the Publication capability (the URL fragment) and every epoch
 * is directly enveloped to eligible Owner/Collaborator devices through the
 * ticket 18/20 provisioning machinery and the Owner's `vault-recovery`
 * envelope. Anonymous readers receive only public epochs; authenticated
 * eligible Accounts read retained history through their device envelopes on
 * the File route without ever receiving a fragment.
 */

const headers = { "Cache-Control": "no-store" };
const failure = (error: string, status: number) => Response.json({ error }, { status, headers });
const notFound = () => failure("not_found", 404);
const invalid = () => failure("invalid_comment_request", 400);
const changed = () => failure("comment_changed", 409);
const sealed = () => failure("key_rotation_required", 409);
const denied = () => failure("device_proof_required", 403);

const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const positiveEpoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const positiveRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

export type PublicThread = {
  threadId: string; ownerId: string; fileId: string; publicationId: string;
  currentEpochId: string; audience: "public" | "collaborators_only";
  capabilityId: string; capabilityEpoch: number;
};

/** The active Publication's Public thread and current audience epoch. */
function publicThreadSelect(where: SQL): SQL {
  return sql`SELECT t.id AS threadId, t.owner_id AS ownerId, t.file_id AS fileId, t.publication_id AS publicationId,
      t.current_epoch_id AS currentEpochId, e.audience AS audience, e.key_epoch AS capabilityEpoch,
      c.capability_id AS capabilityId
    FROM comment_threads t
    JOIN publications p ON p.id = t.publication_id AND p.state = 'active' AND p.owner_id = t.owner_id
    JOIN comment_thread_epochs e ON e.id = t.current_epoch_id AND e.thread_id = t.id
    JOIN sharing_comment_capabilities c ON c.object_id = e.id AND c.thread_id = t.id
      AND c.purpose = 'public-comment-audience-epoch' AND c.capability_epoch = e.key_epoch
    WHERE t.purpose = 'public' AND ${where}`;
}

/** File route: active Publication, thread, current epoch and live File-read access. */
function currentThreadForFile(auth: AuthorizedDevice, fileId: string | SQL): SQL {
  return publicThreadSelect(sql`t.file_id = ${fileId} AND ${accessPredicate(auth, fileId, "read")}`);
}

/** The active link resolves the logical Publication. */
function currentThreadForLink(linkId: string | SQL): SQL {
  return publicThreadSelect(sql`p.current_link_id = ${linkId}`);
}

/** The current epoch capability, pinned to live File-read access and an active
 * Publication: a sealed Publication's Public thread denies every endpoint. */
function fileEpochAuthority(auth: AuthorizedDevice, input: {
  fileId: string; threadId: string; epochId: string; capabilityId: string; capabilityEpoch: number; currentOnly: boolean;
}): SQL {
  return sql`EXISTS (SELECT 1 FROM comment_threads t
    JOIN comment_thread_epochs e ON e.id = ${input.epochId} AND e.thread_id = t.id
    JOIN sharing_comment_capabilities c ON c.object_id = e.id AND c.thread_id = t.id
      AND c.purpose = 'public-comment-audience-epoch' AND c.capability_id = ${input.capabilityId}
      AND c.capability_epoch = ${input.capabilityEpoch}
    WHERE t.id = ${input.threadId} AND t.file_id = ${input.fileId} AND t.purpose = 'public'
      AND EXISTS (SELECT 1 FROM publications p WHERE p.id = t.publication_id AND p.state = 'active')
      ${input.currentOnly ? sql`AND t.current_epoch_id = e.id` : sql``}
      AND ${accessPredicate(auth, input.fileId, "read")})`;
}

/** The link route's epoch authority. The supplied epoch is always public.
 * `create` requires it to be the thread's current epoch; `authorMutation`
 * allows a retained public epoch only while the thread's current audience is
 * still public, so a Collaborators-only mode can never be mutated via a link. */
function linkEpochAuthority(input: {
  linkId: string; threadId: string; epochId: string; capabilityId: string; capabilityEpoch: number;
  mode: "create" | "authorMutation";
}): SQL {
  return sql`EXISTS (SELECT 1 FROM comment_threads t
    JOIN publications p ON p.id = t.publication_id AND p.state = 'active' AND p.current_link_id = ${input.linkId}
    JOIN comment_thread_epochs e ON e.id = ${input.epochId} AND e.thread_id = t.id AND e.audience = 'public'
    JOIN sharing_comment_capabilities c ON c.object_id = e.id AND c.thread_id = t.id
      AND c.purpose = 'public-comment-audience-epoch' AND c.capability_id = ${input.capabilityId}
      AND c.capability_epoch = ${input.capabilityEpoch}
    WHERE t.id = ${input.threadId} AND t.purpose = 'public'
      ${input.mode === "create" ? sql`AND t.current_epoch_id = e.id` : sql`AND EXISTS (SELECT 1 FROM comment_thread_epochs current
        WHERE current.id = t.current_epoch_id AND current.thread_id = t.id AND current.audience = 'public')`})`;
}

type EpochRow = { epochId: string; ordinal: number; audience: "public" | "collaborators_only";
  state: "active" | "retained"; capabilityId: string; capabilityEpoch: number; wrapper: ArrayBuffer | null };

/** All public epochs with the link wrapper for this exact link. */
function publicEpochs(linkId: string, threadId: string): SQL {
  return sql`SELECT e.id AS epochId, e.ordinal, e.audience, e.state, e.key_epoch AS capabilityEpoch,
      c.capability_id AS capabilityId, w.ciphertext AS wrapper
    FROM comment_thread_epochs e
    JOIN sharing_comment_capabilities c ON c.object_id = e.id AND c.thread_id = e.thread_id
      AND c.purpose = 'public-comment-audience-epoch' AND c.capability_epoch = e.key_epoch
    JOIN public_comment_epoch_links w ON w.epoch_id = e.id AND w.link_id = ${linkId} AND w.key_epoch = e.key_epoch
    WHERE e.thread_id = ${threadId} AND e.audience = 'public' ORDER BY e.ordinal LIMIT 100`;
}

/** Comment page across a thread's epochs, ordered by the one flat sequence. */
function commentPage(threadId: string, cursor: number, epochFilter: SQL): SQL {
  return sql`SELECT c.id, c.epoch_id, c.author_id, c.sequence, c.revision, c.body_ciphertext, c.body_size,
      c.content_key_envelope, c.content_key_epoch, c.created_at, c.updated_at
    FROM comments c WHERE c.thread_id = ${threadId} AND c.sequence > ${cursor} AND ${epochFilter}
    ORDER BY c.sequence LIMIT ${MAX_COMMENTS_PAGE + 1}`;
}

function attributionPage(threadId: string, authors: string[], epochFilter: SQL): SQL {
  return sql`SELECT a.id, a.author_id, a.epoch_id, a.revision, a.ciphertext, a.content_key_envelope,
      a.content_key_epoch FROM thread_attributions a
    WHERE a.thread_id = ${threadId} AND a.author_id IN (${sql.join(authors.map((author) => sql`${author}`), sql`, `)})
      AND ${epochFilter} ORDER BY a.id LIMIT ${MAX_COMMENTS_PAGE + 1}`;
}

type CommentWireRow = { id: string; epoch_id: string; author_id: string; sequence: number; revision: number;
  body_ciphertext: ArrayBuffer; body_size: number; content_key_envelope: ArrayBuffer; content_key_epoch: number;
  created_at: number; updated_at: number };
type AttributionWireRow = { id: string; author_id: string; epoch_id: string; revision: number;
  ciphertext: ArrayBuffer; content_key_envelope: ArrayBuffer; content_key_epoch: number };

const encodeBytes = (value: ArrayBuffer) => encodeTreeBytes(new Uint8Array(value));
const commentWire = (row: CommentWireRow) => ({ id: row.id, epochId: row.epoch_id, authorId: row.author_id,
  sequence: row.sequence, revision: row.revision, bodyCiphertext: encodeBytes(row.body_ciphertext),
  contentKeyEnvelope: encodeBytes(row.content_key_envelope), contentKeyEpoch: row.content_key_epoch,
  createdAt: row.created_at, updatedAt: row.updated_at });
const attributionWire = (row: AttributionWireRow) => ({ id: row.id, authorId: row.author_id, epochId: row.epoch_id,
  revision: row.revision, ciphertext: encodeBytes(row.ciphertext),
  contentKeyEnvelope: encodeBytes(row.content_key_envelope), contentKeyEpoch: row.content_key_epoch });

// ---------------------------------------------------------------------------
// Anonymous link reads
// ---------------------------------------------------------------------------

export type PublicCommentsView = {
  audience: "public" | "collaborators_only"; threadId: string | null;
  epochs: { epochId: string; ordinal: number; state: string; capabilityId: string; capabilityEpoch: number; wrapper: string }[];
  comments: ReturnType<typeof commentWire>[]; attributions: ReturnType<typeof attributionWire>[];
  nextCursor: number | null;
};

/** An empty, ciphertext-free view when no Public thread or audience is active. */
function emptyComments(thread: PublicThread | null): PublicCommentsView {
  return { audience: "collaborators_only", threadId: thread?.threadId ?? null, epochs: [], comments: [],
    attributions: [], nextCursor: null };
}

/**
 * The anonymous Public Comment page: only epochs explicitly marked public get
 * their ciphertext, wrappers, Comments or attributions. A Collaborators-only
 * current audience publishes nothing, so retained history is not served either.
 */
export async function readPublicCommentPage(env: Env, linkId: string, cursor: number): Promise<PublicCommentsView> {
  const db = createDb(env.DB);
  const thread = await db.get<PublicThread>(currentThreadForLink(linkId));
  if (!thread) return emptyComments(null);
  if (thread.audience !== "public") return emptyComments(thread);
  const epochs = await db.all<EpochRow>(publicEpochs(linkId, thread.threadId));
  if (!epochs.length) return emptyComments(thread);
  const epochIds = epochs.map((epoch) => epoch.epochId);
  const inEpochs = sql`${sql.join(epochIds.map((epochId) => sql`${epochId}`), sql`, `)}`;
  const comments = await db.all<CommentWireRow>(commentPage(thread.threadId, cursor, sql`c.epoch_id IN (${inEpochs})`));
  const page = comments.slice(0, MAX_COMMENTS_PAGE);
  const authors = [...new Set(page.map((comment) => comment.author_id))];
  const attributions = authors.length
    ? await db.all<AttributionWireRow>(attributionPage(thread.threadId, authors, sql`a.epoch_id IN (${inEpochs})`))
    : [];
  return {
    audience: "public", threadId: thread.threadId,
    epochs: epochs.map((epoch) => ({ epochId: epoch.epochId, ordinal: epoch.ordinal, audience: epoch.audience,
      state: epoch.state, capabilityId: epoch.capabilityId, capabilityEpoch: epoch.capabilityEpoch,
      wrapper: encodeBytes(epoch.wrapper!) })),
    comments: page.map(commentWire), attributions: attributions.map(attributionWire),
    nextCursor: comments.length > MAX_COMMENTS_PAGE ? page[MAX_COMMENTS_PAGE - 1]!.sequence : null,
  };
}

// ---------------------------------------------------------------------------
// Authenticated File route reads
// ---------------------------------------------------------------------------

/** The File's Public thread with every epoch envelope for this device. */
export async function readFilePublicComments(env: Env, auth: AuthorizedDevice, fileId: string, cursor: number): Promise<Response> {
  const db = createDb(env.DB);
  const thread = await db.get<PublicThread>(currentThreadForFile(auth, fileId));
  if (!thread) {
    const access = await db.get<{ is_owner: number }>(sql`SELECT n.owner_id = ${auth.accountId} AS is_owner
      FROM vault_nodes n WHERE n.id = ${fileId} AND n.kind = 'file' AND ${privateReadGuard(auth)}
        AND (n.owner_id = ${auth.accountId} OR ${accessPredicate(auth, fileId, "read")})`);
    if (!access) return notFound();
    const publication = await db.get<{ id: string }>(sql`SELECT p.id FROM publications p
      WHERE p.file_id = ${fileId} AND p.state = 'active' AND ${accessPredicate(auth, fileId, "read")}`);
    return Response.json({ thread: null, canCreateThread: Boolean(access.is_owner && publication),
      publication: publication ? { publicationId: publication.id } : null }, { headers });
  }
  const epochs = await db.all<EpochRow>(sql`
    SELECT e.id AS epochId, e.ordinal, e.audience, e.state, e.key_epoch AS capabilityEpoch,
      c.capability_id AS capabilityId, w.ciphertext AS wrapper
    FROM comment_thread_epochs e
    JOIN sharing_comment_capabilities c ON c.object_id = e.id AND c.thread_id = e.thread_id
      AND c.purpose = 'public-comment-audience-epoch' AND c.capability_epoch = e.key_epoch
    LEFT JOIN public_comment_epoch_links w ON w.epoch_id = e.id AND w.link_id = (
      SELECT p.current_link_id FROM publications p WHERE p.id = ${thread.publicationId})
    WHERE e.thread_id = ${thread.threadId} AND ${accessPredicate(auth, fileId, "read")}
    ORDER BY e.ordinal LIMIT 100`);
  if (!epochs.length) return changed();
  // One batched envelope read keeps the whole authorized history inside D1's
  // per-invocation query budget no matter how many audience changes there were.
  const envelopes = await readCommentEnvelopes(env, auth, { ownerId: thread.ownerId, threadId: thread.threadId,
    publicationId: thread.publicationId, epochs,
    authority: sql`EXISTS (SELECT 1 FROM comment_threads t WHERE t.id = ${thread.threadId}
      AND t.file_id = ${fileId} AND t.purpose = 'public' AND ${accessPredicate(auth, fileId, "read")})` });
  for (const epoch of epochs) {
    if (!envelopes.has(epoch.epochId)) {
      return failure(thread.ownerId === auth.accountId ? "owned_comment_key_missing" : "secure_access_preparing", 409);
    }
  }
  const epochIds = epochs.map((epoch) => epoch.epochId);
  const inEpochs = sql`${sql.join(epochIds.map((epochId) => sql`${epochId}`), sql`, `)}`;
  const comments = await db.all<CommentWireRow>(commentPage(thread.threadId, cursor, sql`c.epoch_id IN (${inEpochs})`));
  const page = comments.slice(0, MAX_COMMENTS_PAGE);
  const authors = [...new Set([auth.accountId, ...page.map((comment) => comment.author_id)])];
  const attributions = await db.all<AttributionWireRow>(attributionPage(thread.threadId, authors, sql`a.epoch_id IN (${inEpochs})`));
  return Response.json({
    thread: { threadId: thread.threadId, ownerId: thread.ownerId, fileId: thread.fileId,
      publicationId: thread.publicationId, currentEpochId: thread.currentEpochId, audience: thread.audience,
      actorAccountId: auth.accountId, canComment: true, canDeleteAny: thread.ownerId === auth.accountId,
      epochs: epochs.map((epoch) => ({ epochId: epoch.epochId, ordinal: epoch.ordinal,
        audience: epoch.audience, state: epoch.state, capabilityId: epoch.capabilityId,
        capabilityEpoch: epoch.capabilityEpoch,
        envelope: commentEnvelopeWire(envelopes.get(epoch.epochId)!, { purpose: "public-comment-audience-epoch", fileId: thread.fileId,
          threadId: thread.threadId, objectId: epoch.epochId, publicationId: thread.publicationId,
          capabilityId: epoch.capabilityId, capabilityEpoch: epoch.capabilityEpoch, deviceId: auth.deviceId }) })) },
    comments: page.map(commentWire), attributions: attributions.map(attributionWire),
    nextCursor: comments.length > MAX_COMMENTS_PAGE ? page[MAX_COMMENTS_PAGE - 1]!.sequence : null,
  }, { headers });
}

// ---------------------------------------------------------------------------
// Audience epoch lifecycle
// ---------------------------------------------------------------------------

export type EpochInput = { threadId: string; epochId: string; capabilityId: string;
  audience: "public" | "collaborators_only"; recoveryEnvelope: Uint8Array<ArrayBuffer>;
  linkWrapper: Uint8Array<ArrayBuffer> | null };

/** Validate a submitted audience epoch: Owner recovery envelope, and for a
 * public epoch the symmetric wrapper to the current link capability. */
export function epochInput(value: unknown, ownerId: string, publicationId: string, linkId: string): EpochInput | null {
  const input = record(value);
  if (!input || !exact(input, ["threadId", "epochId", "capabilityId", "audience", "recoveryEnvelope", "linkWrapper"]) ||
      !isV7(input.threadId) || !isV7(input.epochId) || !isV7(input.capabilityId) ||
      (input.audience !== "public" && input.audience !== "collaborators_only")) return null;
  try {
    const threadId = input.threadId, epochId = input.epochId, capabilityId = input.capabilityId;
    const recoveryEnvelope = treeEnvelope(input.recoveryEnvelope, MAX_COMMENT_KEY_ENVELOPE_BYTES, {
      purpose: "vault-recovery", vaultId: ownerId, objectId: epochId, keyId: capabilityId, keyEpoch: 1, revision: 1 });
    if (input.audience === "collaborators_only") {
      if (input.linkWrapper !== null) return null;
      return { threadId, epochId, capabilityId, audience: "collaborators_only", recoveryEnvelope, linkWrapper: null };
    }
    if (typeof input.linkWrapper !== "string") return null;
    const wrapper = decodeTreeBytes(input.linkWrapper, MAX_PUBLIC_EPOCH_LINK_BYTES);
    if (!isCommentEpochLink(wrapper, { publicationId, linkId, epochId, capabilityId, keyEpoch: 1 })) return null;
    return { threadId, epochId, capabilityId, audience: "public", recoveryEnvelope, linkWrapper: wrapper };
  } catch { return null; }
}

/**
 * Owner-only audience change (or legacy thread creation). One transaction
 * starts a fresh epoch, retains the prior one, and for `public` installs the
 * link wrapper and the device-envelope requirement. New Publications default
 * to public because creation supplies the same epoch material.
 */
export async function changePublicAudience(env: Env, auth: AuthorizedDevice, fileId: string, value: unknown): Promise<Response> {
  const input = record(value), epoch = record(input?.epoch);
  if (!input || !exact(input, ["publicationId", "expectedEpochId", "epoch"]) ||
      !isPublicationIdentifier(input.publicationId) ||
      (input.expectedEpochId !== null && !isV7(input.expectedEpochId)) || !epoch) return invalid();
  const db = createDb(env.DB);
  const publication = await db.get<{ id: string; link_id: string }>(sql`
    SELECT p.id, p.current_link_id AS link_id FROM publications p
    WHERE p.id = ${input.publicationId} AND p.file_id = ${fileId} AND p.state = 'active'
      AND p.owner_id = ${auth.accountId} AND p.current_link_id IS NOT NULL
      AND ${accessPredicate(auth, fileId, "owner")}`);
  if (!publication) return notFound();
  const parsed = epochInput(epoch, auth.accountId, publication.id, publication.link_id);
  if (!parsed) return invalid();
  if (await db.get(sql`SELECT 1 WHERE ${sharingWriteBlocked(fileId)}`)) return sealed();
  const expected = input.expectedEpochId as string | null;
  const creating = expected === null;
  const now = Date.now();
  const committed = await commitPrivateBatch(env, auth, (guard) => sql`
    UPDATE publications SET updated_at = updated_at
    WHERE id = ${publication.id} AND state = 'active' AND current_link_id = ${publication.link_id}
      AND owner_id = ${auth.accountId} AND ${accessPredicate(auth, fileId, "owner")}
      AND NOT EXISTS (SELECT 1 FROM comment_thread_epochs e WHERE e.id = ${parsed.epochId})
      AND ${creating
        ? sql`NOT EXISTS (SELECT 1 FROM comment_threads t WHERE t.publication_id = ${publication.id} AND t.purpose = 'public')
            AND NOT EXISTS (SELECT 1 FROM comment_threads t WHERE t.id = ${parsed.threadId})`
        : sql`EXISTS (SELECT 1 FROM comment_threads t WHERE t.id = ${parsed.threadId}
            AND t.publication_id = ${publication.id} AND t.purpose = 'public' AND t.current_epoch_id = ${expected})`}
      AND ${guard}`,
  (marker) => creating ? [
    sql`INSERT INTO comment_thread_epochs (id, thread_id, audience, key_epoch, ordinal, state, created_at)
      SELECT ${parsed.epochId}, ${parsed.threadId}, ${parsed.audience}, 1, 1, 'active', ${now} WHERE ${marker}`,
    sql`INSERT INTO comment_threads (id, owner_id, file_id, purpose, publication_id, current_epoch_id, next_sequence, created_at)
      SELECT ${parsed.threadId}, ${auth.accountId}, ${fileId}, 'public', ${publication.id}, ${parsed.epochId}, 1, ${now} WHERE ${marker}`,
    ...epochStatements(marker, parsed, publication.id, publication.link_id, now),
  ] : [
    sql`UPDATE comment_thread_epochs SET state = 'retained'
      WHERE thread_id = ${parsed.threadId} AND state = 'active' AND ${marker}`,
    sql`INSERT INTO comment_thread_epochs (id, thread_id, audience, key_epoch, ordinal, state, created_at)
      SELECT ${parsed.epochId}, ${parsed.threadId}, ${parsed.audience}, 1,
        (SELECT max(ordinal) + 1 FROM comment_thread_epochs WHERE thread_id = ${parsed.threadId}), 'active', ${now}
      WHERE ${marker}`,
    sql`UPDATE comment_threads SET current_epoch_id = ${parsed.epochId}
      WHERE id = ${parsed.threadId} AND current_epoch_id = ${expected} AND ${marker}`,
    ...epochStatements(marker, parsed, publication.id, publication.link_id, now),
  ], { deferForeignKeys: true });
  if (committed) return Response.json({ threadId: parsed.threadId, epochId: parsed.epochId,
    audience: parsed.audience, created: creating }, { status: creating ? 201 : 200, headers });
  const current = await db.get<{ epoch_id: string; capability_id: string }>(sql`SELECT t.current_epoch_id AS epoch_id,
      c.capability_id FROM comment_threads t JOIN sharing_comment_capabilities c
      ON c.object_id = t.current_epoch_id AND c.thread_id = t.id AND c.purpose = 'public-comment-audience-epoch'
    WHERE t.id = ${parsed.threadId} AND t.file_id = ${fileId} AND ${accessPredicate(auth, fileId, "owner")}`);
  // A lost-response retry of the exact same epoch is idempotent.
  if (current && current.epoch_id === parsed.epochId && current.capability_id === parsed.capabilityId) {
    return Response.json({ threadId: parsed.threadId, epochId: parsed.epochId, audience: parsed.audience, created: false }, { headers });
  }
  return current ? changed() : notFound();
}

export function epochStatements(marker: SQL, parsed: EpochInput, publicationId: string, linkId: string, now: number): SQL[] {
  return [
    sql`INSERT INTO sharing_comment_capabilities (object_id, owner_id, file_id, thread_id, purpose, publication_id, capability_id, capability_epoch)
      SELECT ${parsed.epochId}, t.owner_id, t.file_id, t.id, 'public-comment-audience-epoch', ${publicationId},
        ${parsed.capabilityId}, 1 FROM comment_threads t WHERE t.id = ${parsed.threadId} AND ${marker}`,
    sql`INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch)
      SELECT t.owner_id, 'vault-recovery', ${parsed.epochId}, 'vault-root', ${parsed.recoveryEnvelope}, 1
      FROM comment_threads t WHERE t.id = ${parsed.threadId} AND ${marker}`,
    ...(parsed.linkWrapper ? [sql`INSERT INTO public_comment_epoch_links (epoch_id, publication_id, link_id, key_epoch, ciphertext, created_at)
      SELECT ${parsed.epochId}, ${publicationId}, ${linkId}, 1, ${parsed.linkWrapper}, ${now} WHERE ${marker}`] : []),
  ];
}

// ---------------------------------------------------------------------------
// Comment mutations
// ---------------------------------------------------------------------------

type AttributionInput = { attributionId: string; ciphertext: Uint8Array<ArrayBuffer>;
  contentKeyEnvelope: Uint8Array<ArrayBuffer> };

function attributionInput(value: unknown, publicationId: string, capabilityId: string,
  capabilityEpoch: number): AttributionInput | null {
  const input = record(value);
  if (!input || !exact(input, ["attributionId", "ciphertext", "contentKeyEnvelope"]) || !isV7(input.attributionId)) return null;
  try {
    const attributionId = input.attributionId;
    return { attributionId,
      ciphertext: publicCommentEnvelope(input.ciphertext, MAX_ATTRIBUTION_BYTES,
        publicAttributionContext(publicationId, attributionId, 1)),
      contentKeyEnvelope: publicCommentEnvelope(input.contentKeyEnvelope, MAX_ATTRIBUTION_KEY_ENVELOPE_BYTES,
        publicAttributionKeyContext(publicationId, attributionId, capabilityId, capabilityEpoch, 1)) };
  } catch { return null; }
}

type CommentTarget = { kind: "file"; fileId: string } | { kind: "link"; linkId: string };

/** Shared create: the File route requires live File-read access, while the link
 * route requires an active public link and a private-capable Session. */
export async function createPublicComment(request: Request, env: Env, auth: AuthorizedDevice,
  target: CommentTarget, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["commentId", "threadId", "epochId", "capabilityId", "capabilityEpoch",
      "bodyCiphertext", "contentKeyEnvelope", "attribution"]) ||
      !isV7(input.commentId) || !isV7(input.threadId) || !isV7(input.epochId) || !isV7(input.capabilityId) ||
      !positiveEpoch(input.capabilityEpoch)) return invalid();
  const db = createDb(env.DB);
  const thread = target.kind === "file" ? await db.get<PublicThread>(currentThreadForFile(auth, target.fileId))
    : await db.get<PublicThread>(currentThreadForLink(target.linkId));
  if (!thread || (target.kind === "link" && thread.audience !== "public")) return notFound();
  if (input.threadId !== thread.threadId || input.epochId !== thread.currentEpochId ||
      input.capabilityId !== thread.capabilityId || input.capabilityEpoch !== thread.capabilityEpoch) return changed();
  if (await db.get(sql`SELECT 1 WHERE ${sharingWriteBlocked(thread.fileId)}`)) return sealed();
  // A pending Pseudonym update owns every new attribution context; a create
  // waits (and consumes no participation counter) until the job settles.
  if (await db.get(sql`SELECT 1 WHERE ${pseudonymUpdatePending(auth.accountId)}`))
    return failure("pseudonym_update_pending", 409);
  const quota = await publicCommentLimits(request, env, auth, thread.publicationId);
  if (quota) return quota;
  const commentId = input.commentId, threadId = input.threadId, epochId = input.epochId;
  const capabilityId = input.capabilityId, capabilityEpoch = input.capabilityEpoch;
  let bodyCiphertext: Uint8Array<ArrayBuffer>, contentKeyEnvelope: Uint8Array<ArrayBuffer>;
  let attribution: AttributionInput | null = null;
  try {
    bodyCiphertext = publicCommentEnvelope(input.bodyCiphertext, MAX_COMMENT_BODY_BYTES,
      publicCommentBodyContext(thread.publicationId, commentId, 1));
    contentKeyEnvelope = publicCommentEnvelope(input.contentKeyEnvelope, MAX_COMMENT_KEY_ENVELOPE_BYTES,
      publicCommentKeyContext(thread.publicationId, commentId, capabilityId, capabilityEpoch, 1));
    if (input.attribution !== null) {
      attribution = attributionInput(input.attribution, thread.publicationId, capabilityId, capabilityEpoch);
      if (!attribution) return invalid();
    }
  } catch { return invalid(); }
  const authority = target.kind === "file"
    ? fileEpochAuthority(auth, { fileId: target.fileId, threadId, epochId, capabilityId, capabilityEpoch, currentOnly: true })
    : linkEpochAuthority({ linkId: target.linkId, threadId, epochId, capabilityId, capabilityEpoch,
      mode: "create" });
  const now = Date.now();
  let committed: boolean;
  try {
    committed = await commitPrivateBatch(env, auth, (guard) => sql`
      UPDATE comment_threads SET next_sequence = next_sequence + 1
      WHERE id = ${threadId} AND file_id = ${thread.fileId} AND purpose = 'public' AND current_epoch_id = ${epochId}
        AND NOT ${sharingWriteBlocked(thread.fileId)} AND ${authority} AND ${guard}`,
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
    const existing = await db.get(sql`SELECT 1 FROM comments
      WHERE id = ${commentId} AND thread_id = ${threadId} AND author_id = ${auth.accountId}`);
    return existing ? Response.json({ commentId, created: false }, { headers }) : invalid();
  }
  return committed ? Response.json({ commentId, created: true }, { status: 201, headers }) : changed();
}

/** Resolve a Comment and its thread, re-deriving live access in the same statement.
 * The File route additionally requires the Publication to be active, so a sealed
 * Publication's thread denies edit and delete before teardown removes the rows. */
async function commentContext(env: Env, auth: AuthorizedDevice, target: CommentTarget, threadId: string, commentId: string) {
  return createDb(env.DB).get<{ author_id: string; epoch_id: string; revision: number; owner_id: string;
    file_id: string; publication_id: string }>(sql`
    SELECT c.author_id, c.epoch_id, c.revision, t.owner_id, t.file_id, t.publication_id
    FROM comments c JOIN comment_threads t ON t.id = c.thread_id AND t.purpose = 'public'
    WHERE c.id = ${commentId} AND c.thread_id = ${threadId}
      ${target.kind === "file"
        ? sql`AND t.file_id = ${target.fileId} AND ${accessPredicate(auth, target.fileId, "read")}
            AND EXISTS (SELECT 1 FROM publications p WHERE p.id = t.publication_id AND p.state = 'active')`
        : sql`AND EXISTS (SELECT 1 FROM publications p JOIN comment_thread_epochs e ON e.thread_id = t.id AND e.id = c.epoch_id
            WHERE p.id = t.publication_id AND p.state = 'active' AND p.current_link_id = ${target.linkId}
              AND e.audience = 'public')`}`);
}

function mutationAuthority(auth: AuthorizedDevice, target: CommentTarget, threadId: string, epochId: string,
  capabilityId: string, capabilityEpoch: number): SQL {
  return target.kind === "file"
    ? fileEpochAuthority(auth, { fileId: target.fileId, threadId, epochId, capabilityId, capabilityEpoch, currentOnly: false })
    : linkEpochAuthority({ linkId: target.linkId, threadId, epochId, capabilityId, capabilityEpoch,
      mode: "authorMutation" });
}

export async function editPublicComment(request: Request, env: Env, auth: AuthorizedDevice, target: CommentTarget,
  commentId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["threadId", "capabilityId", "capabilityEpoch", "epochId",
      "expectedRevision", "bodyCiphertext", "contentKeyEnvelope"]) ||
      !isV7(input.threadId) || !isV7(input.capabilityId) || !isV7(input.epochId) ||
      !positiveEpoch(input.capabilityEpoch) || !positiveRevision(input.expectedRevision)) return invalid();
  const threadId = input.threadId, capabilityId = input.capabilityId;
  const capabilityEpoch = input.capabilityEpoch, epochId = input.epochId, expectedRevision = input.expectedRevision;
  const comment = await commentContext(env, auth, target, threadId, commentId);
  if (!comment) return notFound();
  if (comment.epoch_id !== epochId) return changed();
  if (await createDb(env.DB).get(sql`SELECT 1 WHERE ${sharingWriteBlocked(comment.file_id)}`)) return sealed();
  const quota = await publicCommentLimits(request, env, auth, comment.publication_id);
  if (quota) return quota;
  const revision = expectedRevision + 1;
  let bodyCiphertext: Uint8Array<ArrayBuffer>, contentKeyEnvelope: Uint8Array<ArrayBuffer>;
  try {
    bodyCiphertext = publicCommentEnvelope(input.bodyCiphertext, MAX_COMMENT_BODY_BYTES,
      publicCommentBodyContext(comment.publication_id, commentId, revision));
    contentKeyEnvelope = publicCommentEnvelope(input.contentKeyEnvelope, MAX_COMMENT_KEY_ENVELOPE_BYTES,
      publicCommentKeyContext(comment.publication_id, commentId, capabilityId, capabilityEpoch, revision));
  } catch { return invalid(); }
  const committed = await commitPrivateMutation(env, auth, (guard) => sql`
    UPDATE comments SET body_ciphertext = ${bodyCiphertext}, body_size = ${bodyCiphertext.byteLength},
      content_key_envelope = ${contentKeyEnvelope}, content_key_epoch = ${capabilityEpoch},
      revision = revision + 1, updated_at = ${Date.now()}
    WHERE id = ${commentId} AND thread_id = ${threadId} AND author_id = ${auth.accountId}
      AND revision = ${expectedRevision}
      AND ${mutationAuthority(auth, target, threadId, epochId, capabilityId, capabilityEpoch)}
      AND NOT ${sharingWriteBlocked(comment.file_id)} AND ${guard}`);
  if (committed) return Response.json({ revision }, { headers });
  const row = await commentContext(env, auth, target, threadId, commentId);
  return row && row.author_id !== auth.accountId ? failure("not_comment_author", 403) : changed();
}

export async function deletePublicComment(env: Env, auth: AuthorizedDevice, target: CommentTarget, commentId: string,
  value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["threadId", "capabilityId", "capabilityEpoch", "epochId", "expectedRevision"]) ||
      !isV7(input.threadId) || !isV7(input.capabilityId) || !isV7(input.epochId) ||
      !positiveEpoch(input.capabilityEpoch) || !positiveRevision(input.expectedRevision)) return invalid();
  const threadId = input.threadId, capabilityId = input.capabilityId;
  const capabilityEpoch = input.capabilityEpoch, epochId = input.epochId, expectedRevision = input.expectedRevision;
  const comment = await commentContext(env, auth, target, threadId, commentId);
  if (!comment) return notFound();
  if (comment.epoch_id !== epochId) return changed();
  // Hard deletion stays available while a rotation seal blocks new writes.
  const committed = await commitPrivateBatch(env, auth, (guard) => sql`
    DELETE FROM comments WHERE id = ${commentId} AND thread_id = ${threadId} AND revision = ${expectedRevision}
      AND (author_id = ${auth.accountId} OR ${comment.owner_id} = ${auth.accountId})
      AND ${mutationAuthority(auth, target, threadId, epochId, capabilityId, capabilityEpoch)}
      AND ${guard}`,
  (marker) => [sql`DELETE FROM key_rotation_comment_items
    WHERE kind = 'comment' AND record_id = ${commentId} AND ${marker}`]);
  if (committed) return Response.json({ deleted: true }, { headers });
  const row = await commentContext(env, auth, target, threadId, commentId);
  if (!row) return Response.json({ deleted: true, alreadyDeleted: true }, { headers });
  return row.author_id === auth.accountId || row.owner_id === auth.accountId ? changed() : failure("not_comment_author", 403);
}

/**
 * Report one Public Comment by opaque ID with a fixed category (ticket 26).
 * The report carries no plaintext and grants no content access: it records the
 * reporter Account, the Comment ID, the category and bounded timestamps only.
 * A signed-in Account may report the same Comment once; every accepted
 * request — including an idempotent repeat — consumes the 3/24-hour window.
 */
export async function reportPublicComment(request: Request, env: Env, auth: AuthorizedDevice,
  value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["commentId", "category"]) || !isV7(input.commentId) ||
      !isReportCategory(input.category)) return invalid();
  const commentId = input.commentId, category = input.category;
  const db = createDb(env.DB);
  // A report never requires the reporter to hold a capability, but it must
  // name a Comment that exists in a Public thread.
  const comment = await db.get(sql`SELECT 1 FROM comments c
    JOIN comment_threads t ON t.id = c.thread_id AND t.purpose = 'public' WHERE c.id = ${commentId}`);
  if (!comment) return notFound();
  let limit;
  try {
    limit = await enforceRateLimit({ db: env.DB, request, action: "public_comment.report",
      scopes: { accountId: auth.accountId }, hmacSecret: env.ABUSE_HMAC_SECRET });
  } catch (error) {
    if (error instanceof AbuseControlUnavailableError) return abuseControlUnavailableResponse();
    throw error;
  }
  if (!limit.allowed) return rateLimitResponse(limit);
  const now = Date.now();
  const committed = await commitPrivateMutation(env, auth, (guard) => sql`
    INSERT INTO public_comment_reports (id, reporter_id, comment_id, category, created_at, expires_at)
    SELECT ${crypto.randomUUID()}, ${auth.accountId}, ${commentId}, ${category}, ${now}, ${now + REPORT_RETENTION_MS}
    WHERE EXISTS (SELECT 1 FROM comments c JOIN comment_threads t ON t.id = c.thread_id AND t.purpose = 'public'
        WHERE c.id = ${commentId})
      AND ${guard}
    ON CONFLICT (reporter_id, comment_id) DO NOTHING`);
  if (committed) return Response.json({ reported: true }, { status: 201, headers });
  const duplicate = await db.get(sql`SELECT 1 FROM public_comment_reports
    WHERE reporter_id = ${auth.accountId} AND comment_id = ${commentId}`);
  return duplicate ? Response.json({ reported: true, alreadyReported: true }, { headers }) : denied();
}

/** Public participation limits and the suspension boundary, consumed before an
 * accepted create or edit. A suspension is not a rate limit: it never consumes
 * a counter and never applies to delete. */
async function publicCommentLimits(request: Request, env: Env, auth: AuthorizedDevice,
  publicationId: string): Promise<Response | null> {
  const suspension = await activePublicParticipationSuspension(env.DB, auth.accountId);
  if (suspension) return publicParticipationSuspendedResponse(suspension);
  try {
    const limit = await enforceRateLimit({ db: env.DB, request,
      action: "public_comment.mutate", scopes: { accountId: auth.accountId, publicationId },
      hmacSecret: env.ABUSE_HMAC_SECRET });
    return limit.allowed ? null : rateLimitResponse(limit);
  } catch (error) {
    if (error instanceof AbuseControlUnavailableError) return abuseControlUnavailableResponse();
    throw error;
  }
}
