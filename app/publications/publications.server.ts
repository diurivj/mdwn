import type { SQL } from "drizzle-orm";
import { hasEmptyBody, readAuthJsonText, record } from "~/auth/request.server";
import { inspectEnvelope, type EnvelopeContext } from "~/shared/crypto/enc-v1";
import { HPKE_SUITE } from "~/shared/crypto/enc-v1/format";
import { createDb, sql } from "~/shared/db/client.server";
import {
  authorizePrivateRequest,
  commitPrivateBatch,
  commitPrivateMutation,
  type AuthorizedDevice,
} from "~/device/proof.server";
import { newOpaqueId } from "~/shared/opaque-id";
import {
  AbuseControlUnavailableError,
  abuseControlUnavailableResponse,
  enforceRateLimit,
  rateLimitResponse,
} from "~/shared/security/abuse-control.server";
import {
  activePublicParticipationSuspension,
  publicParticipationSuspendedResponse,
} from "~/shared/security/public-participation.server";
import { epochInput, epochStatements, readPublicCommentPage, type EpochInput } from "~/comments/public.server";
import { deletedCommentBatch, deletedCommentDependents } from "~/comments/dependents.server";
import { isCommentEpochLink } from "~/shared/comments/public-content";
import { pseudonymUpdatePending } from "~/account/pseudonym-guard.server";
import { deletedPseudonymItems } from "~/account/pseudonym-items.server";
import { shareHandleLookupToken } from "~/sharing/address";
import {
  accessPredicate,
  accountAccessQuery,
  effectiveAccess,
  permits,
  sharingWriteBlocked,
} from "~/sharing/access.server";
import { decodeTreeBytes, encodeTreeBytes, isV7 } from "~/shared/tree/wire";
import { decodePublicationPublicKey, isPublicationIdentifier } from "../shared/publications/capability";
import {
  authorDeclarationContext,
  MAX_AUTHOR_DECLARATION_BYTES,
  MAX_PUBLIC_REPRESENTATION_BYTES,
  MAX_PUBLICATION_AUTHORS,
  publicRepresentationContext,
} from "../shared/publications/content";

/**
 * Publications (ticket 22): Owner-only creation and configuration, Collaborator
 * requests, pseudonymous author declarations, the paired File-save seam and the
 * anonymous Public route. The service handles only opaque identifiers, the
 * link's public key and HPKE ciphertext. No request, row or response carries
 * the URL fragment, and no anonymous response carries private material.
 */

const headers = { "Cache-Control": "no-store" };
const failure = (error: string, status: number) => Response.json({ error }, { status, headers });
const notFound = () => failure("not_found", 404);
const invalid = () => failure("invalid_publication_request", 400);
const denied = () => failure("device_proof_required", 403);
/** A spent or expired proof after a failed or uncertain commit: an earlier use
 * of this proof, or this very request, may have committed. Distinct from a
 * verification-time denial so the browser never retries it (ticket 57). */
const spent = () => failure("device_proof_spent", 403);
const publicationChanged = () => failure("publication_changed", 409);
const rotationRequired = () => failure("key_rotation_required", 409);

/** Public Comments of one Publication's single Public thread. */
function publicCommentCount(publicationId: SQL): SQL {
  return sql`(SELECT count(*) FROM comments c JOIN comment_threads ct ON ct.id = c.thread_id
    WHERE ct.publication_id = ${publicationId} AND ct.purpose = 'public')`;
}

const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && Number.isSafeInteger(value + 1);

/** Bounds for link rotation and teardown batches. A rewrapped epoch link
 * envelope is a few hundred bytes; 4 KiB each keeps a maximal 100-epoch
 * rotation inside the authenticated-JSON body cap alongside the 512 KiB
 * representation. */
const MAX_PUBLIC_AUDIENCE_EPOCHS = 100;
const MAX_ROTATION_WRAPPER_BYTES = 4_096;
const TEARDOWN_COMMENT_BATCH = 200;

/** The one active-or-deleting Publication of a File. The identical `IN` term
 * lets SQLite use the partial unique index `publications_file_idx`. */
function filePublication(fileId: string | SQL): SQL {
  return sql`p.file_id = ${fileId} AND p.state IN ('active', 'deleting')`;
}

type PublicationState = {
  id: string;
  state: "active" | "deleting";
  created_at: number;
  link_id: string | null;
  public_key: ArrayBuffer | null;
  comment_count: number;
  teardown_total: number | null;
};

/** The File's Publication and active link, re-deriving the actor's File-read access. */
async function publicationState(env: Env, auth: AuthorizedDevice, fileId: string): Promise<PublicationState | null> {
  return (
    (await createDb(env.DB).get<PublicationState>(sql`
    SELECT p.id, p.state, p.created_at, l.id AS link_id, l.public_key,
      ${publicCommentCount(sql`p.id`)} AS comment_count,
      (SELECT td.comment_total FROM publication_teardowns td WHERE td.publication_id = p.id) AS teardown_total
    FROM publications p LEFT JOIN publication_links l ON l.id = p.current_link_id AND l.publication_id = p.id
    WHERE ${filePublication(fileId)} AND ${accessPredicate(auth, fileId, "read")}`)) ?? null
  );
}

/** Header inspection is structural: the Worker binds purpose, suite, link, key and
 * revision, but cannot and does not open public ciphertext. */
function publicEnvelope(value: unknown, max: number, expected: EnvelopeContext): Uint8Array<ArrayBuffer> {
  const bytes = decodeTreeBytes(value, max);
  const header = inspectEnvelope(bytes);
  const fields = [
    "purpose",
    "vaultId",
    "objectId",
    "keyId",
    "keyEpoch",
    "revision",
    "recipientId",
    "publicationId",
  ] as const;
  if (header.suite !== HPKE_SUITE || fields.some((field) => header.context[field] !== expected[field])) {
    throw new Error("invalid public envelope");
  }
  return bytes;
}

async function validPublicKey(value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const publicKey = decodePublicationPublicKey(value);
  // Reject a malformed point now rather than accept a key no editor can encrypt to.
  await crypto.subtle.importKey("raw", publicKey, { name: "ECDH", namedCurve: "P-256" }, true, []);
  return publicKey;
}

async function proofSpent(env: Env, auth: AuthorizedDevice): Promise<boolean> {
  return (
    auth.expiresAt <= Date.now() ||
    !!(await createDb(env.DB).get(sql`SELECT 1 FROM device_proof_uses
    WHERE account_id = ${auth.accountId} AND proof_id = ${auth.proofId}`))
  );
}

/** The Publish panel's view. Authors and requests are opaque metadata: the
 * Owner sees all of them, a Collaborator only its own. */
async function readPublication(env: Env, auth: AuthorizedDevice, fileId: string): Promise<Response> {
  const access = await effectiveAccess(env, auth, fileId);
  if (!access || !permits(access, "read_file")) return notFound();
  const db = createDb(env.DB);
  const publication = await publicationState(env, auth, fileId);
  const owner = access.isOwner;
  const authors = publication
    ? await db.all<{ id: string; author_id: string; ordinal: number; declared: number }>(sql`
    SELECT a.id, a.author_id, a.ordinal, a.ciphertext IS NOT NULL AND a.link_id IS p.current_link_id AS declared
    FROM publication_authors a JOIN publications p ON p.id = a.publication_id
    WHERE a.publication_id = ${publication.id} AND (${owner ? sql`1` : sql`a.author_id = ${auth.accountId}`})
      AND ${accessPredicate(auth, fileId, "read")}
    ORDER BY a.ordinal LIMIT ${MAX_PUBLICATION_AUTHORS}`)
    : [];
  const requests = await db.all<{ id: string; requester_id: string; created_at: number }>(sql`
    SELECT r.id, r.requester_id, r.created_at FROM publication_requests r
    WHERE r.file_id = ${fileId} AND (${owner ? sql`r.owner_id = ${auth.accountId}` : sql`r.requester_id = ${auth.accountId}`})
      AND ${accessPredicate(auth, fileId, "read")}
    ORDER BY r.id LIMIT 100`);
  // Public Comment audience state: the Owner sees it to configure the thread.
  const comments = publication
    ? await db.get<{ threadId: string; epochId: string; audience: string }>(sql`
    SELECT t.id AS threadId, t.current_epoch_id AS epochId, e.audience FROM comment_threads t
    JOIN comment_thread_epochs e ON e.id = t.current_epoch_id AND e.thread_id = t.id
    WHERE t.publication_id = ${publication.id} AND t.purpose = 'public' AND ${accessPredicate(auth, fileId, "read")}`)
    : null;
  return Response.json(
    {
      fileId,
      isOwner: owner,
      canEdit: permits(access, "edit_markdown"),
      publication: publication
        ? {
            publicationId: publication.id,
            state: publication.state,
            ...(owner ? { linkId: publication.link_id } : {}),
            createdAt: publication.created_at,
            authors: authors.map((author) => ({
              declarationId: author.id,
              ordinal: author.ordinal,
              self: author.author_id === auth.accountId,
              declared: Boolean(author.declared),
            })),
          }
        : null,
      comments: comments
        ? { threadId: comments.threadId, epochId: comments.epochId, audience: comments.audience }
        : null,
      // The confirmation copy states the current opaque count; a sealed teardown
      // reports its pinned total and live remaining count for progress. Progress
      // is Owner-only: a Collaborator never learns how many Comments remain.
      commentCount: owner ? (publication?.comment_count ?? 0) : 0,
      teardown:
        owner && publication && publication.state === "deleting"
          ? { commentTotal: publication.teardown_total ?? 0, commentsRemaining: publication.comment_count }
          : null,
      requests: requests.map((request) => ({
        requestId: request.id,
        own: request.requester_id === auth.accountId,
        createdAt: request.created_at,
      })),
    },
    { headers },
  );
}

type Creation = {
  publicationId: string;
  linkId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  expectedRevision: number;
  expectedRepresentationId: string;
  ciphertext: Uint8Array<ArrayBuffer>;
  author: { declarationId: string; ciphertext: Uint8Array<ArrayBuffer> } | null;
  comments: EpochInput;
};

async function creationInput(value: unknown, ownerId: string): Promise<Creation | null> {
  const input = record(value),
    representation = record(input?.representation);
  if (
    !input ||
    !representation ||
    !exact(input, [
      "publicationId",
      "linkId",
      "publicKey",
      "expectedRevision",
      "expectedRepresentationId",
      "representation",
      "author",
      "comments",
    ]) ||
    !exact(representation, ["ciphertext"]) ||
    !isPublicationIdentifier(input.publicationId) ||
    !isPublicationIdentifier(input.linkId) ||
    input.publicationId === input.linkId ||
    !positive(input.expectedRevision) ||
    !isV7(input.expectedRepresentationId)
  )
    return null;
  const author = input.author === null ? null : record(input.author);
  if (
    input.author !== null &&
    (!author ||
      !exact(author, ["declarationId", "ciphertext"]) ||
      !isPublicationIdentifier(author.declarationId) ||
      author.declarationId === input.publicationId ||
      author.declarationId === input.linkId)
  )
    return null;
  // Every new Publication owns a Public Comment thread: the first audience
  // epoch is part of creation, defaulting to public, so no Publication can be
  // observed without it. A pre-ticket-23 Publication gets one through the
  // Owner-only audience endpoint instead.
  const comments = epochInput(input.comments, ownerId, input.publicationId, input.linkId);
  if (!comments) return null;
  try {
    const publicKey = await validPublicKey(input.publicKey);
    const binding = { publicationId: input.publicationId, linkId: input.linkId, publicKey };
    return {
      publicationId: input.publicationId,
      linkId: input.linkId,
      publicKey,
      expectedRevision: input.expectedRevision,
      expectedRepresentationId: input.expectedRepresentationId,
      ciphertext: publicEnvelope(
        representation.ciphertext,
        MAX_PUBLIC_REPRESENTATION_BYTES,
        publicRepresentationContext({ ...binding, revision: 1 }),
      ),
      author: author
        ? {
            declarationId: author.declarationId as string,
            ciphertext: publicEnvelope(
              author.ciphertext,
              MAX_AUTHOR_DECLARATION_BYTES,
              authorDeclarationContext({ ...binding, declarationId: author.declarationId as string, revision: 1 }),
            ),
          }
        : null,
      comments,
    };
  } catch {
    return null;
  }
}

/** Publication create/rotate abuse limits (5 / 24 h per Account) and the
 * Public-participation suspension boundary, both before the CAS. Unpublishing,
 * teardown, author changes and requests never pass through here. */
async function publicationMutationLimits(request: Request, env: Env, auth: AuthorizedDevice): Promise<Response | null> {
  const suspension = await activePublicParticipationSuspension(env.DB, auth.accountId);
  if (suspension) return publicParticipationSuspendedResponse(suspension);
  try {
    const limit = await enforceRateLimit({
      db: env.DB,
      request,
      action: "publication.mutate",
      scopes: { accountId: auth.accountId },
      hmacSecret: env.ABUSE_HMAC_SECRET,
    });
    return limit.allowed ? null : rateLimitResponse(limit);
  } catch (error) {
    if (error instanceof AbuseControlUnavailableError) return abuseControlUnavailableResponse();
    throw error;
  }
}

/**
 * The Owner creates (or, equivalently, approves a request for) the Publication
 * of the exact current File representation it encrypted. One transaction
 * installs the Publication, its link, the first Public representation and the
 * optional Owner author declaration, and removes every pending request.
 */
async function createPublication(
  request: Request,
  env: Env,
  auth: AuthorizedDevice,
  fileId: string,
  value: unknown,
): Promise<Response> {
  const db = createDb(env.DB);
  const file = await db.get<{
    current_revision: number;
    current_representation_id: string;
    converted: number;
    published: number;
  }>(sql`
    SELECT f.current_revision, f.current_representation_id, f.capability_id IS NOT NULL AS converted,
      EXISTS (SELECT 1 FROM publications p WHERE ${filePublication(sql`f.node_id`)}) AS published
    FROM files f JOIN vault_nodes n ON n.id = f.node_id AND n.owner_id = f.owner_id
    WHERE f.node_id = ${fileId} AND n.kind = 'file' AND f.owner_id = ${auth.accountId}
      AND ${accessPredicate(auth, fileId, "owner")}`);
  // A Collaborator sees the same 404 as an inaccessible File.
  if (!file) return notFound();
  const input = await creationInput(value, auth.accountId);
  if (!input) return invalid();
  if (file.published) return failure("publication_exists", 409);
  if (!file.converted) return failure("file_capability_required", 409);
  if (
    file.current_revision !== input.expectedRevision ||
    file.current_representation_id !== input.expectedRepresentationId
  ) {
    return failure("file_changed", 409);
  }
  const quota = await publicationMutationLimits(request, env, auth);
  if (quota) return quota;
  const now = Date.now(),
    representationId = newOpaqueId();
  let committed = false;
  try {
    committed = await commitPrivateBatch(
      env,
      auth,
      (guard) => sql`
      INSERT INTO publications (id, file_id, owner_id, state, current_link_id, current_representation_id, created_at, updated_at)
      SELECT ${input.publicationId}, f.node_id, f.owner_id, 'active', ${input.linkId}, ${representationId}, ${now}, ${now}
      FROM files f WHERE f.node_id = ${fileId} AND f.owner_id = ${auth.accountId} AND f.capability_id IS NOT NULL
        AND f.current_revision = ${input.expectedRevision} AND f.current_representation_id = ${input.expectedRepresentationId}
        AND NOT EXISTS (SELECT 1 FROM publications p WHERE ${filePublication(sql`f.node_id`)})
        AND ${accessPredicate(auth, fileId, "owner")} AND ${guard}`,
      (marker) => [
        sql`INSERT INTO publication_links (id, publication_id, public_key, created_at)
        SELECT ${input.linkId}, ${input.publicationId}, ${input.publicKey}, ${now} WHERE ${marker}`,
        sql`INSERT INTO public_representations (id, publication_id, link_id, revision, file_revision, ciphertext, ciphertext_size, created_at)
        SELECT ${representationId}, ${input.publicationId}, ${input.linkId}, 1, ${input.expectedRevision},
          ${input.ciphertext}, ${input.ciphertext.byteLength}, ${now} WHERE ${marker}`,
        ...(input.author
          ? [
              sql`INSERT INTO publication_authors (id, publication_id, author_id, ordinal, link_id, revision,
          ciphertext, created_at, updated_at)
        SELECT ${input.author.declarationId}, ${input.publicationId}, ${auth.accountId}, 1, ${input.linkId}, 1,
          ${input.author.ciphertext}, ${now}, ${now} WHERE ${marker}`,
            ]
          : []),
        // A new Publication defaults to public Comments: the Public thread and its
        // first audience epoch are installed atomically with the Publication, so a
        // reader can never observe a Publication without its thread.
        sql`INSERT INTO comment_thread_epochs (id, thread_id, audience, key_epoch, ordinal, state, created_at)
        SELECT ${input.comments.epochId}, ${input.comments.threadId}, ${input.comments.audience}, 1, 1, 'active', ${now} WHERE ${marker}`,
        sql`INSERT INTO comment_threads (id, owner_id, file_id, purpose, publication_id, current_epoch_id, next_sequence, created_at)
        SELECT ${input.comments.threadId}, ${auth.accountId}, ${fileId}, 'public', ${input.publicationId},
          ${input.comments.epochId}, 1, ${now} WHERE ${marker}`,
        ...epochStatements(marker, input.comments, input.publicationId, input.linkId, now),
        // Approval is publishing: every pending request for this File is satisfied.
        sql`DELETE FROM publication_requests WHERE file_id = ${fileId} AND owner_id = ${auth.accountId} AND ${marker}`,
      ],
      { deferForeignKeys: true },
    );
  } catch {
    // A colliding random identifier rolls back the whole batch; nothing is public.
    return publicationChanged();
  }
  if (committed)
    return Response.json(
      {
        publicationId: input.publicationId,
        linkId: input.linkId,
        revision: 1,
        comments: {
          threadId: input.comments.threadId,
          epochId: input.comments.epochId,
          audience: input.comments.audience,
        },
      },
      { status: 201, headers },
    );
  if (await proofSpent(env, auth)) return spent();
  const latest = await db.get<{ current_revision: number; current_representation_id: string; published: number }>(sql`
    SELECT f.current_revision, f.current_representation_id,
      EXISTS (SELECT 1 FROM publications p WHERE ${filePublication(sql`f.node_id`)}) AS published
    FROM files f WHERE f.node_id = ${fileId} AND f.owner_id = ${auth.accountId} AND ${accessPredicate(auth, fileId, "owner")}`);
  if (!latest) return notFound();
  if (latest.published) return failure("publication_exists", 409);
  return latest.current_revision !== input.expectedRevision ||
    latest.current_representation_id !== input.expectedRepresentationId
    ? failure("file_changed", 409)
    : denied();
}

/** A Collaborator with File access asks the Owner to publish. It creates no
 * Publication, link, representation or public access of any kind. */
async function createRequest(env: Env, auth: AuthorizedDevice, fileId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, [])) return invalid();
  const access = await effectiveAccess(env, auth, fileId);
  if (!access || !permits(access, "request_publication")) return notFound();
  const db = createDb(env.DB);
  const existing = () =>
    db.get<{ id: string }>(sql`SELECT id FROM publication_requests
    WHERE file_id = ${fileId} AND requester_id = ${auth.accountId}
      AND ${accessPredicate(auth, fileId, "read")}`);
  const requestId = newOpaqueId();
  const committed = await commitPrivateMutation(
    env,
    auth,
    (guard) => sql`
    INSERT INTO publication_requests (id, file_id, owner_id, requester_id, created_at)
    SELECT ${requestId}, f.node_id, f.owner_id, ${auth.accountId}, ${Date.now()} FROM files f
    WHERE f.node_id = ${fileId} AND f.owner_id != ${auth.accountId} AND ${accessPredicate(auth, fileId, "read")}
      AND NOT EXISTS (SELECT 1 FROM publications p WHERE ${filePublication(sql`f.node_id`)})
      AND NOT EXISTS (SELECT 1 FROM publication_requests r WHERE r.file_id = f.node_id AND r.requester_id = ${auth.accountId})
      AND ${guard}`,
  );
  if (committed) return Response.json({ requestId, created: true }, { status: 201, headers });
  if (await proofSpent(env, auth)) return spent();
  const pending = await existing();
  if (pending) return Response.json({ requestId: pending.id, created: false }, { headers });
  if (
    await db.get(sql`SELECT 1 FROM publications p WHERE ${filePublication(fileId)}
    AND ${accessPredicate(auth, fileId, "read")}`)
  )
    return failure("publication_exists", 409);
  return notFound();
}

/** The requester cancels or the File Owner denies; either hard-deletes it. */
async function deleteRequest(
  env: Env,
  auth: AuthorizedDevice,
  fileId: string,
  requestId: string,
  value: unknown,
): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, [])) return invalid();
  const access = await effectiveAccess(env, auth, fileId);
  if (!access || !permits(access, "read_file")) return notFound();
  const committed = await commitPrivateMutation(
    env,
    auth,
    (guard) => sql`
    DELETE FROM publication_requests WHERE id = ${requestId} AND file_id = ${fileId}
      AND ((requester_id = ${auth.accountId} AND ${accessPredicate(auth, fileId, "read")})
        OR (owner_id = ${auth.accountId} AND ${accessPredicate(auth, fileId, "owner")}))
      AND ${guard}`,
  );
  if (committed) return Response.json({ deleted: true }, { headers });
  // An absent request is idempotent only while File authority is still live.
  // Another requester's entry is indistinguishable from an inaccessible File.
  const row = await createDb(env.DB).get<{ id: string | null }>(sql`
    SELECT r.id FROM files f LEFT JOIN publication_requests r ON r.id = ${requestId} AND r.file_id = f.node_id
    WHERE f.node_id = ${fileId} AND ${accessPredicate(auth, fileId, "read")}
      AND (r.id IS NULL OR r.requester_id = ${auth.accountId}
        OR (f.owner_id = ${auth.accountId} AND ${accessPredicate(auth, fileId, "owner")}))`);
  if (!row) return notFound();
  if (row.id) return (await proofSpent(env, auth)) ? spent() : notFound();
  return Response.json({ deleted: true, alreadyDeleted: true }, { headers });
}

type AuthorAddress = { self: true } | { shareId: string } | { handle: string };

function authorAddress(value: unknown): AuthorAddress | null {
  const input = record(value);
  if (!input) return null;
  if (exact(input, ["self"]) && input.self === true) return { self: true };
  if (
    exact(input, ["shareId"]) &&
    typeof input.shareId === "string" &&
    input.shareId.length > 0 &&
    input.shareId.length <= 128
  )
    return { shareId: input.shareId };
  if (exact(input, ["handle"]) && typeof input.handle === "string") return { handle: input.handle };
  return null;
}

/**
 * The Owner opts an Account into attribution. Only the Owner or an Account with
 * current File-read access can be selected, nothing is inferred from edits, and
 * only the author's own device ever writes its pseudonym declaration.
 */
async function addAuthor(env: Env, auth: AuthorizedDevice, fileId: string, value: unknown): Promise<Response> {
  const input = record(value);
  const address = authorAddress(input?.account);
  if (
    !input ||
    !address ||
    !exact(input, ["publicationId", "declarationId", "account", "declaration"]) ||
    !isPublicationIdentifier(input.publicationId) ||
    !isPublicationIdentifier(input.declarationId)
  )
    return invalid();
  const access = await effectiveAccess(env, auth, fileId);
  if (!access || !permits(access, "manage_publication")) return notFound();
  const publication = await publicationState(env, auth, fileId);
  if (
    !publication ||
    publication.state !== "active" ||
    publication.id !== input.publicationId ||
    !publication.link_id ||
    !publication.public_key
  )
    return publicationChanged();
  const db = createDb(env.DB);
  let candidate: string | undefined;
  let declaration: Uint8Array<ArrayBuffer> | null = null;
  if ("self" in address) {
    const supplied = record(input.declaration);
    if (!supplied || !exact(supplied, ["linkId", "ciphertext"]) || supplied.linkId !== publication.link_id)
      return publicationChanged();
    try {
      declaration = publicEnvelope(
        supplied.ciphertext,
        MAX_AUTHOR_DECLARATION_BYTES,
        authorDeclarationContext({
          publicationId: publication.id,
          linkId: publication.link_id,
          publicKey: new Uint8Array(publication.public_key),
          declarationId: input.declarationId,
          revision: 1,
        }),
      );
    } catch {
      return invalid();
    }
    candidate = auth.accountId;
  } else {
    if (input.declaration !== null) return invalid();
    let lookup: SQL;
    if ("shareId" in address) lookup = sql`share_id = ${address.shareId}`;
    else {
      try {
        lookup = sql`share_handle_lookup_token = ${await shareHandleLookupToken(address.handle)}`;
      } catch {
        return invalid();
      }
    }
    // Only an Account holding current access to this File can be credited;
    // an unknown address and an Account without access are indistinguishable.
    const account = await db.get<{ id: string }>(sql`SELECT id FROM accounts
      WHERE ${lookup} AND id != ${auth.accountId} AND ${accessPredicate(auth, fileId, "owner")}`);
    if (
      !account ||
      !(await db.get(sql`SELECT 1 FROM (${accountAccessQuery(account.id, fileId)}) a
      WHERE a.kind = 'file' AND ${accessPredicate(auth, fileId, "owner")}`))
    )
      return notFound();
    candidate = account.id;
  }
  const self = candidate === auth.accountId,
    now = Date.now();
  // Self-attribution writes a declaration immediately; a pending Pseudonym
  // update blocks it so no context is minted with the old pseudonym.
  if (self && (await db.get(sql`SELECT 1 WHERE ${pseudonymUpdatePending(auth.accountId)}`)))
    return failure("pseudonym_update_pending", 409);
  let committed = false;
  try {
    committed = await commitPrivateMutation(
      env,
      auth,
      (guard) => sql`
      INSERT INTO publication_authors (id, publication_id, author_id, ordinal, link_id, revision, ciphertext, created_at, updated_at)
      SELECT ${input.declarationId}, p.id, ${candidate},
        COALESCE((SELECT max(ordinal) FROM publication_authors WHERE publication_id = p.id), 0) + 1,
        ${self ? publication.link_id : null}, ${self ? 1 : 0}, ${declaration}, ${now}, ${now}
      FROM publications p WHERE p.id = ${publication.id} AND ${filePublication(fileId)} AND p.state = 'active'
        AND p.owner_id = ${auth.accountId} AND p.current_link_id = ${publication.link_id}
        AND (SELECT count(*) FROM publication_authors WHERE publication_id = p.id) < ${MAX_PUBLICATION_AUTHORS}
        AND NOT EXISTS (SELECT 1 FROM publication_authors WHERE publication_id = p.id AND author_id = ${candidate})
        AND (${self ? sql`1` : sql`EXISTS (SELECT 1 FROM (${accountAccessQuery(candidate, fileId)}) a WHERE a.kind = 'file')`})
        AND ${accessPredicate(auth, fileId, "owner")} AND ${guard}`,
    );
  } catch {
    return publicationChanged();
  }
  if (committed) return Response.json({ declarationId: input.declarationId }, { status: 201, headers });
  if (await proofSpent(env, auth)) return spent();
  const authors = await db.get<{ total: number; present: number }>(sql`
    SELECT (SELECT count(*) FROM publication_authors WHERE publication_id = p.id) AS total,
      EXISTS (SELECT 1 FROM publication_authors WHERE publication_id = p.id AND author_id = ${candidate}) AS present
    FROM publications p WHERE p.id = ${publication.id} AND ${filePublication(fileId)}
      AND p.owner_id = ${auth.accountId} AND ${accessPredicate(auth, fileId, "owner")}`);
  if (!authors) return notFound();
  if (authors.present) return failure("author_exists", 409);
  if (authors.total >= MAX_PUBLICATION_AUTHORS) return failure("author_limit", 409);
  return publicationChanged();
}

async function removeAuthor(
  env: Env,
  auth: AuthorizedDevice,
  fileId: string,
  declarationId: string,
  value: unknown,
): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, [])) return invalid();
  const access = await effectiveAccess(env, auth, fileId);
  if (!access || !permits(access, "manage_publication")) return notFound();
  const committed = await commitPrivateMutation(
    env,
    auth,
    (guard) => sql`
    DELETE FROM publication_authors WHERE id = ${declarationId}
      AND publication_id IN (SELECT p.id FROM publications p WHERE ${filePublication(fileId)}
        AND p.state = 'active' AND p.owner_id = ${auth.accountId})
      AND ${accessPredicate(auth, fileId, "owner")} AND ${guard}`,
  );
  if (committed) return Response.json({ deleted: true }, { headers });
  return (await proofSpent(env, auth)) ? spent() : Response.json({ deleted: true, alreadyDeleted: true }, { headers });
}

/** A selected author's own device (re)declares its pseudonym to the current link. */
async function declareAuthor(
  env: Env,
  auth: AuthorizedDevice,
  fileId: string,
  declarationId: string,
  value: unknown,
): Promise<Response> {
  const input = record(value);
  if (
    !input ||
    !exact(input, ["publicationId", "linkId", "revision", "ciphertext"]) ||
    !isPublicationIdentifier(input.publicationId) ||
    !isPublicationIdentifier(input.linkId) ||
    !positive(input.revision)
  )
    return invalid();
  const publication = await publicationState(env, auth, fileId);
  const author = publication
    ? await createDb(env.DB).get<{ revision: number }>(sql`SELECT revision FROM publication_authors
    WHERE id = ${declarationId} AND publication_id = ${publication.id} AND author_id = ${auth.accountId}
      AND ${accessPredicate(auth, fileId, "read")}`)
    : null;
  if (!publication || !author) return notFound();
  // A declaration is a fresh attribution context; wait for a pending update.
  if (await createDb(env.DB).get(sql`SELECT 1 WHERE ${pseudonymUpdatePending(auth.accountId)}`))
    return failure("pseudonym_update_pending", 409);
  if (
    publication.state !== "active" ||
    publication.id !== input.publicationId ||
    publication.link_id !== input.linkId ||
    !publication.public_key ||
    author.revision + 1 !== input.revision
  )
    return publicationChanged();
  let ciphertext: Uint8Array<ArrayBuffer>;
  try {
    ciphertext = publicEnvelope(
      input.ciphertext,
      MAX_AUTHOR_DECLARATION_BYTES,
      authorDeclarationContext({
        publicationId: publication.id,
        linkId: input.linkId,
        publicKey: new Uint8Array(publication.public_key),
        declarationId,
        revision: input.revision,
      }),
    );
  } catch {
    return invalid();
  }
  const committed = await commitPrivateMutation(
    env,
    auth,
    (guard) => sql`
    UPDATE publication_authors SET link_id = ${input.linkId}, revision = ${input.revision}, ciphertext = ${ciphertext},
      updated_at = ${Date.now()}
    WHERE id = ${declarationId} AND author_id = ${auth.accountId} AND revision = ${author.revision}
      AND publication_id = ${publication.id}
      AND EXISTS (SELECT 1 FROM publications p WHERE p.id = ${publication.id} AND ${filePublication(fileId)}
        AND p.state = 'active' AND p.current_link_id = ${input.linkId})
      AND ${accessPredicate(auth, fileId, "read")} AND ${guard}`,
  );
  if (committed) return Response.json({ revision: input.revision }, { headers });
  return (await proofSpent(env, auth)) ? spent() : publicationChanged();
}

/**
 * Link rotation (ticket 25): the Owner's browser generates a fresh path
 * identifier and capability, re-encrypts the current Public representation to
 * the new public key, rewraps every public Comment epoch to the new
 * Publication capability, and one transaction replaces the active link in
 * place. The logical Publication, Public Comments and history survive; the
 * retired identifier immediately stops routing and is never reused.
 */
type RotationEpoch = { epochId: string; capabilityId: string; keyEpoch: number; wrapper: Uint8Array<ArrayBuffer> };
type Rotation = {
  publicationId: string;
  linkId: string;
  expectedLinkId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  expectedPresentationRevision: number;
  expectedRevision: number;
  expectedRepresentationId: string;
  ciphertext: Uint8Array<ArrayBuffer>;
  epochs: RotationEpoch[];
};

async function rotationInput(value: unknown): Promise<Rotation | null> {
  const input = record(value),
    representation = record(input?.representation);
  if (
    !input ||
    !representation ||
    !exact(input, [
      "publicationId",
      "linkId",
      "publicKey",
      "expectedLinkId",
      "expectedPresentationRevision",
      "expectedRevision",
      "expectedRepresentationId",
      "representation",
      "epochs",
    ]) ||
    !exact(representation, ["ciphertext"]) ||
    !isPublicationIdentifier(input.publicationId) ||
    !isPublicationIdentifier(input.linkId) ||
    !isPublicationIdentifier(input.expectedLinkId) ||
    input.publicationId === input.linkId ||
    input.linkId === input.expectedLinkId ||
    !positive(input.expectedPresentationRevision) ||
    !positive(input.expectedRevision) ||
    !isV7(input.expectedRepresentationId) ||
    !Array.isArray(input.epochs) ||
    input.epochs.length > MAX_PUBLIC_AUDIENCE_EPOCHS
  )
    return null;
  const epochs: RotationEpoch[] = [];
  const seen = new Set<string>();
  for (const entry of input.epochs) {
    const epoch = record(entry);
    if (
      !epoch ||
      !exact(epoch, ["epochId", "capabilityId", "keyEpoch", "wrapper"]) ||
      !isV7(epoch.epochId) ||
      !isV7(epoch.capabilityId) ||
      !positive(epoch.keyEpoch) ||
      seen.has(epoch.epochId)
    )
      return null;
    seen.add(epoch.epochId);
    try {
      const wrapper = decodeTreeBytes(epoch.wrapper, MAX_ROTATION_WRAPPER_BYTES);
      if (
        !isCommentEpochLink(wrapper, {
          publicationId: input.publicationId,
          linkId: input.linkId,
          epochId: epoch.epochId,
          capabilityId: epoch.capabilityId,
          keyEpoch: epoch.keyEpoch,
        })
      )
        return null;
      epochs.push({ epochId: epoch.epochId, capabilityId: epoch.capabilityId, keyEpoch: epoch.keyEpoch, wrapper });
    } catch {
      return null;
    }
  }
  try {
    const publicKey = await validPublicKey(input.publicKey);
    const binding = { publicationId: input.publicationId, linkId: input.linkId, publicKey };
    return {
      publicationId: input.publicationId,
      linkId: input.linkId,
      expectedLinkId: input.expectedLinkId,
      publicKey,
      expectedPresentationRevision: input.expectedPresentationRevision,
      expectedRevision: input.expectedRevision,
      expectedRepresentationId: input.expectedRepresentationId,
      ciphertext: publicEnvelope(
        representation.ciphertext,
        MAX_PUBLIC_REPRESENTATION_BYTES,
        publicRepresentationContext({ ...binding, revision: input.expectedPresentationRevision }),
      ),
      epochs,
    };
  } catch {
    return null;
  }
}

type RotationState = {
  id: string;
  owner_id: string;
  link_id: string;
  representation_id: string;
  revision: number;
  file_revision: number;
};

/** A failed rotation reports precisely whether the File or the Publication moved. */
async function rotationFailure(env: Env, auth: AuthorizedDevice, fileId: string, input: Rotation): Promise<Response> {
  if (await proofSpent(env, auth)) return spent();
  const current = await createDb(env.DB).get<{
    id: string;
    state: string;
    link_id: string | null;
    current_revision: number;
    current_representation_id: string;
  }>(sql`
    SELECT p.id, p.state, p.current_link_id AS link_id, f.current_revision, f.current_representation_id
    FROM publications p JOIN files f ON f.node_id = p.file_id AND f.owner_id = p.owner_id
    WHERE ${filePublication(fileId)} AND ${accessPredicate(auth, fileId, "owner")}`);
  if (!current) return notFound();
  if (current.state !== "active" || current.id !== input.publicationId || current.link_id !== input.expectedLinkId) {
    return publicationChanged();
  }
  if (
    current.current_revision !== input.expectedRevision ||
    current.current_representation_id !== input.expectedRepresentationId
  )
    return failure("file_changed", 409);
  return publicationChanged();
}

async function rotatePublication(
  request: Request,
  env: Env,
  auth: AuthorizedDevice,
  fileId: string,
  value: unknown,
): Promise<Response> {
  const input = await rotationInput(value);
  if (!input) return invalid();
  const db = createDb(env.DB);
  const state = await db.get<RotationState>(sql`
    SELECT p.id, p.owner_id, p.current_link_id AS link_id, p.current_representation_id AS representation_id,
      r.revision, r.file_revision
    FROM publications p
    JOIN publication_links l ON l.id = p.current_link_id AND l.publication_id = p.id
    JOIN public_representations r ON r.id = p.current_representation_id AND r.publication_id = p.id AND r.link_id = l.id
    WHERE p.file_id = ${fileId} AND p.state = 'active' AND p.owner_id = ${auth.accountId}
      AND ${accessPredicate(auth, fileId, "owner")}`);
  if (!state) return notFound();
  if (
    state.id !== input.publicationId ||
    state.link_id !== input.expectedLinkId ||
    state.revision !== input.expectedPresentationRevision
  )
    return publicationChanged();
  const file = await db.get<{ current_revision: number; current_representation_id: string }>(sql`
    SELECT f.current_revision, f.current_representation_id FROM files f JOIN vault_nodes n ON n.id = f.node_id
    WHERE f.node_id = ${fileId} AND f.owner_id = ${state.owner_id} AND ${accessPredicate(auth, fileId, "owner")}`);
  if (!file) return notFound();
  if (
    file.current_revision !== input.expectedRevision ||
    file.current_representation_id !== input.expectedRepresentationId
  )
    return failure("file_changed", 409);
  // The submitted wrappers must be exactly the thread's public epochs, each
  // bound to its own capability identity; anything else rotates nothing.
  const expected = await db.all<{
    epoch_id: string;
    capability_id: string;
    key_epoch: number;
    wrapper_link: string | null;
  }>(sql`
    SELECT e.id AS epoch_id, c.capability_id, e.key_epoch, w.link_id AS wrapper_link
    FROM comment_thread_epochs e
    JOIN comment_threads t ON t.id = e.thread_id AND t.purpose = 'public' AND t.publication_id = ${state.id}
    JOIN sharing_comment_capabilities c ON c.object_id = e.id AND c.thread_id = t.id
      AND c.purpose = 'public-comment-audience-epoch' AND c.capability_epoch = e.key_epoch
    LEFT JOIN public_comment_epoch_links w ON w.epoch_id = e.id AND w.publication_id = t.publication_id
    WHERE e.audience = 'public' ORDER BY e.ordinal`);
  if (expected.length > MAX_PUBLIC_AUDIENCE_EPOCHS) return publicationChanged();
  const submitted = new Map(input.epochs.map((epoch) => [epoch.epochId, epoch]));
  for (const epoch of expected) {
    const wrapper = submitted.get(epoch.epoch_id);
    if (
      !wrapper ||
      wrapper.capabilityId !== epoch.capability_id ||
      wrapper.keyEpoch !== epoch.key_epoch ||
      epoch.wrapper_link !== input.expectedLinkId
    )
      return publicationChanged();
  }
  if (submitted.size !== expected.length) return publicationChanged();
  if (await db.get(sql`SELECT 1 WHERE ${sharingWriteBlocked(fileId)}`)) return rotationRequired();
  const quota = await publicationMutationLimits(request, env, auth);
  if (quota) return quota;
  const now = Date.now(),
    representationId = newOpaqueId();
  let committed = false;
  try {
    committed = await commitPrivateBatch(
      env,
      auth,
      (guard) => sql`
      UPDATE publications SET current_link_id = ${input.linkId}, current_representation_id = ${representationId},
        updated_at = ${now}
      WHERE id = ${state.id} AND file_id = ${fileId} AND state = 'active' AND owner_id = ${auth.accountId}
        AND current_link_id = ${input.expectedLinkId} AND current_representation_id = ${state.representation_id}
        AND EXISTS (SELECT 1 FROM public_representations r WHERE r.id = ${state.representation_id}
          AND r.publication_id = ${state.id} AND r.link_id = ${input.expectedLinkId}
          AND r.revision = ${state.revision} AND r.file_revision = ${input.expectedRevision})
        AND EXISTS (SELECT 1 FROM files f WHERE f.node_id = ${fileId} AND f.owner_id = ${state.owner_id}
          AND f.current_revision = ${input.expectedRevision}
          AND f.current_representation_id = ${input.expectedRepresentationId})
        AND (SELECT count(*) FROM public_comment_epoch_links w JOIN comment_thread_epochs e ON e.id = w.epoch_id
          JOIN comment_threads t ON t.id = e.thread_id AND t.purpose = 'public' AND t.publication_id = ${state.id}
          WHERE e.audience = 'public' AND w.link_id = ${input.expectedLinkId}) = ${expected.length}
        AND ${accessPredicate(auth, fileId, "owner")} AND ${guard}`,
      (marker) => [
        // Replace the active link identity in place: the retired path is gone and
        // the same logical Publication keeps its thread, Comments and history.
        sql`UPDATE publication_links SET id = ${input.linkId}, public_key = ${input.publicKey}, created_at = ${now}
        WHERE id = ${input.expectedLinkId} AND publication_id = ${state.id} AND ${marker}`,
        ...input.epochs.map(
          (epoch) => sql`UPDATE public_comment_epoch_links SET link_id = ${input.linkId},
        ciphertext = ${epoch.wrapper}, key_epoch = ${epoch.keyEpoch}, created_at = ${now}
        WHERE epoch_id = ${epoch.epochId} AND publication_id = ${state.id}
          AND link_id = ${input.expectedLinkId} AND ${marker}`,
        ),
        sql`DELETE FROM public_representations WHERE id = ${state.representation_id}
        AND publication_id = ${state.id} AND ${marker}`,
        sql`INSERT INTO public_representations (id, publication_id, link_id, revision, file_revision, ciphertext,
          ciphertext_size, created_at)
        SELECT ${representationId}, ${state.id}, ${input.linkId}, ${state.revision}, ${state.file_revision},
          ${input.ciphertext}, ${input.ciphertext.byteLength}, ${now} WHERE ${marker}`,
      ],
      { deferForeignKeys: true },
    );
  } catch {
    committed = false;
  }
  if (committed)
    return Response.json(
      { publicationId: state.id, linkId: input.linkId, representation: { revision: state.revision } },
      { headers },
    );
  return rotationFailure(env, auth, fileId, input);
}

/**
 * Unpublish (ticket 25): seal first, delete later. One transaction removes the
 * active link, flips the Publication irreversibly to `deleting`, and pins the
 * opaque Public Comment count. Every Public route denies access immediately;
 * only the Owner's browser then drives bounded deletion batches.
 */
async function unpublishPublication(
  env: Env,
  auth: AuthorizedDevice,
  fileId: string,
  value: unknown,
): Promise<Response> {
  const input = record(value ?? {});
  if (!input || !exact(input, [])) return invalid();
  const db = createDb(env.DB);
  const now = Date.now();
  let committed = false;
  try {
    committed = await commitPrivateBatch(
      env,
      auth,
      (guard) => sql`
      UPDATE publications SET state = 'deleting', current_link_id = NULL, current_representation_id = NULL,
        updated_at = ${now}
      WHERE file_id = ${fileId} AND state = 'active' AND owner_id = ${auth.accountId}
        AND ${accessPredicate(auth, fileId, "owner")} AND ${guard}`,
      (marker) => [
        sql`INSERT INTO publication_teardowns (publication_id, owner_id, comment_total, created_at)
        SELECT p.id, p.owner_id, ${publicCommentCount(sql`p.id`)}, ${now}
        FROM publications p WHERE p.file_id = ${fileId} AND p.state = 'deleting'
          AND p.owner_id = ${auth.accountId} AND ${marker}`,
        // Wrappers are bound to the retired link and can never be served again.
        sql`DELETE FROM public_comment_epoch_links WHERE publication_id IN
        (SELECT p.id FROM publications p WHERE p.file_id = ${fileId} AND p.state = 'deleting'
          AND p.owner_id = ${auth.accountId}) AND ${marker}`,
        sql`DELETE FROM publication_links WHERE publication_id IN
        (SELECT p.id FROM publications p WHERE p.file_id = ${fileId} AND p.state = 'deleting'
          AND p.owner_id = ${auth.accountId}) AND ${marker}`,
      ],
      { deferForeignKeys: true },
    );
  } catch {
    committed = false;
  }
  const existing = await db.get<{ id: string; comment_total: number }>(sql`
    SELECT p.id, t.comment_total FROM publications p JOIN publication_teardowns t ON t.publication_id = p.id
    WHERE p.file_id = ${fileId} AND p.state = 'deleting' AND p.owner_id = ${auth.accountId}
      AND ${accessPredicate(auth, fileId, "owner")}`);
  if (existing) return Response.json({ publicationId: existing.id, commentTotal: existing.comment_total }, { headers });
  if (!committed && (await proofSpent(env, auth))) return spent();
  return notFound();
}

type TeardownState = { id: string; comment_total: number; comments_remaining: number };

/** Every non-Comment row teardown removes, including the Publication itself.
 * The shared Comment-dependent module removes the Publication's Public-thread
 * graph (see `teardownPublication`); this function owns what is not
 * Comment-dependent. */
function teardownStatements(publicationId: string, fileId: string, ownerId: string, marker: SQL): SQL[] {
  return [
    ...deletedCommentDependents({ kind: "publication", ownerId, publicationId }, marker),
    sql`DELETE FROM public_representations WHERE publication_id = ${publicationId} AND ${marker}`,
    deletedPseudonymItems(
      "publication",
      sql`SELECT id FROM publication_authors WHERE publication_id = ${publicationId}`,
      marker,
    ),
    sql`DELETE FROM publication_authors WHERE publication_id = ${publicationId} AND ${marker}`,
    sql`DELETE FROM publication_requests WHERE file_id = ${fileId} AND owner_id = ${ownerId} AND ${marker}`,
    sql`DELETE FROM publication_teardowns WHERE publication_id = ${publicationId} AND ${marker}`,
    sql`DELETE FROM publications WHERE id = ${publicationId} AND file_id = ${fileId}
      AND owner_id = ${ownerId} AND state = 'deleting' AND ${marker}`,
  ];
}

/**
 * One idempotent bounded teardown batch. While Public Comments remain it
 * hard-deletes at most `TEARDOWN_COMMENT_BATCH` of them; once none remain it
 * removes the thread and epochs, envelopes, attribution, representation,
 * authors, requests, teardown state and the Publication row atomically. Only
 * the Owner may resume, and no participation limit can block deletion.
 */
async function teardownPublication(
  env: Env,
  auth: AuthorizedDevice,
  fileId: string,
  value: unknown,
): Promise<Response> {
  const input = record(value ?? {});
  if (!input || !exact(input, [])) return invalid();
  const db = createDb(env.DB);
  const publication = await db.get<TeardownState>(sql`
    SELECT p.id, t.comment_total, ${publicCommentCount(sql`p.id`)} AS comments_remaining
    FROM publications p JOIN publication_teardowns t ON t.publication_id = p.id
    WHERE p.file_id = ${fileId} AND p.state = 'deleting' AND p.owner_id = ${auth.accountId}
      AND ${accessPredicate(auth, fileId, "owner")}`);
  if (!publication) {
    // Only the Owner can observe or resume a teardown; anyone else gets 404.
    const owner = await db.get(sql`SELECT 1 FROM files f JOIN vault_nodes n ON n.id = f.node_id
      WHERE f.node_id = ${fileId} AND n.owner_id = ${auth.accountId}
        AND ${accessPredicate(auth, fileId, "owner")}`);
    if (!owner) return notFound();
    // Idempotent completion; a live Publication means this is not a teardown.
    const live = await db.get(sql`SELECT 1 FROM publications p WHERE p.file_id = ${fileId}
      AND ${accessPredicate(auth, fileId, "owner")}`);
    return live
      ? publicationChanged()
      : Response.json({ done: true, commentTotal: 0, commentsRemaining: 0 }, { headers });
  }
  const now = Date.now();
  let committed = false;
  try {
    committed = await commitPrivateBatch(
      env,
      auth,
      (guard) => sql`
      UPDATE publications SET updated_at = ${now}
      WHERE id = ${publication.id} AND file_id = ${fileId} AND state = 'deleting'
        AND owner_id = ${auth.accountId} AND ${accessPredicate(auth, fileId, "owner")} AND ${guard}`,
      (marker) =>
        publication.comments_remaining > 0
          ? deletedCommentBatch(
              { kind: "publication", ownerId: auth.accountId, publicationId: publication.id },
              TEARDOWN_COMMENT_BATCH,
              marker,
            )
          : teardownStatements(publication.id, fileId, auth.accountId, marker),
      { deferForeignKeys: true },
    );
  } catch {
    committed = false;
  }
  const remaining =
    (
      await db.get<{ n: number }>(sql`SELECT count(*) AS n FROM comments c
    JOIN comment_threads t ON t.id = c.thread_id
    WHERE t.publication_id = ${publication.id} AND t.purpose = 'public'`)
    )?.n ?? 0;
  if (committed)
    return Response.json(
      {
        done: remaining === 0 && publication.comments_remaining === 0,
        commentTotal: publication.comment_total,
        commentsRemaining: remaining,
      },
      { headers },
    );
  if (await proofSpent(env, auth)) return spent();
  const stillSealed = await db.get(sql`SELECT 1 FROM publications p WHERE p.file_id = ${fileId}
    AND p.state = 'deleting' AND ${accessPredicate(auth, fileId, "owner")}`);
  return stillSealed
    ? publicationChanged()
    : Response.json({ done: true, commentTotal: publication.comment_total, commentsRemaining: 0 }, { headers });
}

/** Resource-only, proof-guarded Publication API. Reads are bodyless POSTs. */
export async function publicationsAction(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  const collection = /^\/api\/private\/publications\/files\/([0-9a-f-]+)$/.exec(path);
  const requests = /^\/api\/private\/publications\/files\/([0-9a-f-]+)\/requests$/.exec(path);
  const requestEntry = /^\/api\/private\/publications\/files\/([0-9a-f-]+)\/requests\/([0-9a-f-]+)$/.exec(path);
  const authors = /^\/api\/private\/publications\/files\/([0-9a-f-]+)\/authors$/.exec(path);
  const author = /^\/api\/private\/publications\/files\/([0-9a-f-]+)\/authors\/([A-Za-z0-9_-]+)$/.exec(path);
  const declaration =
    /^\/api\/private\/publications\/files\/([0-9a-f-]+)\/authors\/([A-Za-z0-9_-]+)\/declaration$/.exec(path);
  const link = /^\/api\/private\/publications\/files\/([0-9a-f-]+)\/link$/.exec(path);
  const unpublish = /^\/api\/private\/publications\/files\/([0-9a-f-]+)\/unpublish$/.exec(path);
  const teardown = /^\/api\/private\/publications\/files\/([0-9a-f-]+)\/teardown$/.exec(path);
  const allowed =
    (collection && (request.method === "POST" || request.method === "PUT")) ||
    (requests && request.method === "POST") ||
    (requestEntry && request.method === "DELETE") ||
    (authors && request.method === "PUT") ||
    (author && request.method === "DELETE") ||
    (declaration && request.method === "PUT") ||
    (link && request.method === "PUT") ||
    (unpublish && request.method === "POST") ||
    (teardown && request.method === "POST");
  const match =
    collection ?? requests ?? requestEntry ?? authors ?? author ?? declaration ?? link ?? unpublish ?? teardown;
  if (!allowed || !match || new URL(request.url).search) return notFound();
  const fileId = match[1]!,
    entryId = match[2];
  if (
    !isV7(fileId) ||
    (requestEntry && !isV7(entryId)) ||
    ((author || declaration) && !isPublicationIdentifier(entryId))
  ) {
    return notFound();
  }
  let raw = "",
    value: unknown = null;
  try {
    if ((collection || unpublish || teardown) && request.method === "POST") {
      if (!(await hasEmptyBody(request))) return denied();
    } else {
      const parsed = await readAuthJsonText(request, 1536 * 1024);
      raw = parsed.raw;
      value = parsed.value;
    }
  } catch {
    return invalid();
  }
  let proof: unknown;
  try {
    proof = JSON.parse(request.headers.get("X-Mdwn-Device-Proof") ?? "null");
  } catch {
    return denied();
  }
  const auth = await authorizePrivateRequest(request, env, proof, raw);
  if (!auth) return denied();
  if (collection)
    return request.method === "PUT"
      ? createPublication(request, env, auth, fileId, value)
      : readPublication(env, auth, fileId);
  if (requests) return createRequest(env, auth, fileId, value);
  if (requestEntry) return deleteRequest(env, auth, fileId, entryId!, value);
  if (authors) return addAuthor(env, auth, fileId, value);
  if (author) return removeAuthor(env, auth, fileId, entryId!, value);
  if (link) return rotatePublication(request, env, auth, fileId, value);
  if (unpublish) return unpublishPublication(env, auth, fileId, value);
  if (teardown) return teardownPublication(env, auth, fileId, value);
  return declareAuthor(env, auth, fileId, entryId!, value);
}

/** Byte-identical for an unknown, malformed, rotated or sealed path. */
function publicNotFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404, headers });
}

/** Statement-time check used by the Public page loader. It reveals nothing but
 * the same existence the Public data route reveals, and never ciphertext. */
export async function activePublicLink(env: Env, linkId: string): Promise<boolean> {
  if (!isPublicationIdentifier(linkId)) return false;
  return !!(await createDb(env.DB).get(sql`SELECT 1 FROM publication_links l
    JOIN publications p ON p.id = l.publication_id AND p.current_link_id = l.id AND p.state = 'active'
    WHERE l.id = ${linkId}`));
}

type PublicRow = {
  publication_id: string;
  public_key: ArrayBuffer;
  revision: number;
  ciphertext: ArrayBuffer;
  authors: string;
};

/**
 * The anonymous Public route accepts only the opaque path ID. One statement
 * returns the active link's public key, the current Public representation and
 * current-link author declarations: never a File, Owner, private
 * representation, Key envelope, Comment or Collaborators-only material.
 */
export async function readPublicPublication(env: Env, linkId: string): Promise<Response> {
  if (!isPublicationIdentifier(linkId)) return publicNotFound();
  const row = await createDb(env.DB).get<PublicRow>(sql`
    SELECT p.id AS publication_id, l.public_key, r.revision, r.ciphertext,
      (SELECT json_group_array(json_object('declarationId', a.id, 'revision', a.revision, 'ordinal', a.ordinal,
          'ciphertext', hex(a.ciphertext)))
        FROM publication_authors a WHERE a.publication_id = p.id AND a.link_id = l.id AND a.ciphertext IS NOT NULL) AS authors
    FROM publication_links l
    JOIN publications p ON p.id = l.publication_id AND p.current_link_id = l.id AND p.state = 'active'
    JOIN public_representations r ON r.id = p.current_representation_id AND r.publication_id = p.id AND r.link_id = l.id
    WHERE l.id = ${linkId}`);
  if (!row) return publicNotFound();
  const authors = (
    JSON.parse(row.authors) as { declarationId: string; revision: number; ordinal: number; ciphertext: string }[]
  )
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((author) => ({
      declarationId: author.declarationId,
      revision: author.revision,
      ciphertext: encodeTreeBytes(Uint8Array.from(author.ciphertext.match(/../g) ?? [], (pair) => parseInt(pair, 16))),
    }));
  return Response.json(
    {
      publicationId: row.publication_id,
      linkId,
      publicKey: encodeTreeBytes(new Uint8Array(row.public_key)),
      representation: { revision: row.revision, ciphertext: encodeTreeBytes(new Uint8Array(row.ciphertext)) },
      authors,
      // Public Comment epochs: only explicitly public epochs are ever served, and
      // never a Comment body, wrapper or attribution from a Collaborators-only one.
      comments: await readPublicCommentPage(env, linkId, 0),
    },
    { headers },
  );
}

/** Anonymous Public Comment pagination for one active link; the same encrypted
 * epoch capabilities are used locally, so no fragment ever reaches the route. */
export async function readPublicCommentPageForLink(
  env: Env,
  linkId: string,
  cursorParam: string | null,
): Promise<Response> {
  if (!isPublicationIdentifier(linkId)) return publicNotFound();
  const cursor = cursorParam === null ? 0 : /^\d+$/.test(cursorParam) ? Number(cursorParam) : NaN;
  if (!Number.isSafeInteger(cursor) || cursor < 0) return publicNotFound();
  const row = await createDb(env.DB).get<{
    publication_id: string;
  }>(sql`SELECT p.id AS publication_id FROM publication_links l
    JOIN publications p ON p.id = l.publication_id AND p.current_link_id = l.id AND p.state = 'active'
    WHERE l.id = ${linkId}`);
  if (!row) return publicNotFound();
  return Response.json(
    { publicationId: row.publication_id, linkId, comments: await readPublicCommentPage(env, linkId, cursor) },
    { headers },
  );
}

// ---------------------------------------------------------------------------
// Paired File save seam (consumed by the converted-File save in tree.server.ts)
// ---------------------------------------------------------------------------

/** The active Publication as read with the File in the save preflight. */
export type ActivePublication = { id: string; linkId: string; publicKey: Uint8Array; revision: number };

export type PublicationSave = {
  publicationId: string;
  linkId: string;
  revision: number;
  ciphertext: Uint8Array<ArrayBuffer>;
};

/**
 * A converted save names the Publication it encrypted for, or null when it
 * believes none is active. Any mismatch with the current state is a 409 the
 * browser resolves by re-reading the File, never a silent skip.
 */
export function publicationSave(
  value: unknown,
  active: ActivePublication | null,
): { save: PublicationSave | null } | { error: "invalid" | "changed" } {
  if (value === undefined || value === null) return active ? { error: "changed" } : { save: null };
  const input = record(value);
  if (
    !input ||
    !exact(input, ["publicationId", "linkId", "revision", "ciphertext"]) ||
    !isPublicationIdentifier(input.publicationId) ||
    !isPublicationIdentifier(input.linkId) ||
    !positive(input.revision) ||
    input.revision < 2
  )
    return { error: "invalid" };
  if (
    !active ||
    active.id !== input.publicationId ||
    active.linkId !== input.linkId ||
    active.revision + 1 !== input.revision
  )
    return { error: "changed" };
  try {
    return {
      save: {
        publicationId: input.publicationId,
        linkId: input.linkId,
        revision: input.revision,
        ciphertext: publicEnvelope(
          input.ciphertext,
          MAX_PUBLIC_REPRESENTATION_BYTES,
          publicRepresentationContext({
            publicationId: active.id,
            linkId: active.linkId,
            publicKey: active.publicKey,
            revision: input.revision,
          }),
        ),
      },
    };
  } catch {
    return { error: "invalid" };
  }
}

/** The File save's first CAS: the same Publication state it encrypted for. */
export function publicationSaveCondition(fileId: string, ownerId: string, save: PublicationSave | null): SQL {
  if (!save)
    return sql`NOT EXISTS (SELECT 1 FROM publications p WHERE ${filePublication(fileId)} AND p.state = 'active')`;
  return sql`EXISTS (SELECT 1 FROM publications p JOIN public_representations r ON r.id = p.current_representation_id
      AND r.publication_id = p.id AND r.link_id = p.current_link_id
    WHERE ${filePublication(fileId)} AND p.state = 'active' AND p.owner_id = ${ownerId} AND p.id = ${save.publicationId}
      AND p.current_link_id = ${save.linkId} AND r.revision = ${save.revision - 1})`;
}

/** Marker-gated dependents: the Public pointer moves in the same transaction as
 * the private pointer, and the superseded Public representation is removed. */
export function publicationSaveStatements(save: PublicationSave | null, fileRevision: number, marker: SQL): SQL[] {
  if (!save) return [];
  const id = newOpaqueId(),
    now = Date.now();
  return [
    sql`INSERT INTO public_representations (id, publication_id, link_id, revision, file_revision, ciphertext, ciphertext_size, created_at)
      SELECT ${id}, ${save.publicationId}, ${save.linkId}, ${save.revision}, ${fileRevision},
        ${save.ciphertext}, ${save.ciphertext.byteLength}, ${now} WHERE ${marker}`,
    sql`UPDATE publications SET current_representation_id = ${id}, updated_at = ${now}
      WHERE id = ${save.publicationId} AND state = 'active' AND current_link_id = ${save.linkId} AND ${marker}`,
    sql`DELETE FROM public_representations WHERE publication_id = ${save.publicationId} AND id != ${id} AND ${marker}`,
  ];
}

/** Hard deletion of every Publication record for the deleted Files. Runs inside
 * the tree's deferred-FK batch, after its own authorization and snapshot CAS. */
export function deletedFilePublications(ownerId: string, ids: SQL, committed: SQL): SQL[] {
  const owned = sql`SELECT id FROM publications WHERE file_id IN (${ids}) AND owner_id = ${ownerId}`;
  return [
    sql`DELETE FROM public_comment_epoch_links WHERE publication_id IN (${owned}) AND ${committed}`,
    sql`DELETE FROM publication_teardowns WHERE publication_id IN (${owned}) AND ${committed}`,
    // Staged pseudonym-update items for deleted authors go with their author row.
    deletedPseudonymItems(
      "publication",
      sql`SELECT id FROM publication_authors WHERE publication_id IN (${owned})`,
      committed,
    ),
    sql`DELETE FROM publication_authors WHERE publication_id IN (${owned}) AND ${committed}`,
    sql`DELETE FROM publication_requests WHERE file_id IN (${ids}) AND owner_id = ${ownerId} AND ${committed}`,
    sql`DELETE FROM public_representations WHERE publication_id IN (${owned}) AND ${committed}`,
    sql`DELETE FROM publication_links WHERE publication_id IN (${owned}) AND ${committed}`,
    sql`DELETE FROM publications WHERE file_id IN (${ids}) AND owner_id = ${ownerId} AND ${committed}`,
  ];
}

/** Columns and joins that let the File read/save preflight see its active
 * Publication, link key and the actor's own author row in the same SELECT. */
export const filePublicationColumns = sql`p.id AS publication_id, l.id AS publication_link_id,
  l.public_key AS publication_public_key, pr.revision AS publication_revision,
  pa.id AS declaration_id, pa.revision AS declaration_revision,
  pa.ciphertext IS NOT NULL AND pa.link_id IS l.id AS declaration_current`;
export function filePublicationJoins(auth: AuthorizedDevice, node: SQL): SQL {
  return sql`LEFT JOIN publications p ON ${filePublication(node)} AND p.state = 'active' AND p.owner_id = n.owner_id
    LEFT JOIN publication_links l ON l.id = p.current_link_id AND l.publication_id = p.id
    LEFT JOIN public_representations pr ON pr.id = p.current_representation_id AND pr.publication_id = p.id
      AND pr.link_id = l.id
    LEFT JOIN publication_authors pa ON pa.publication_id = p.id AND pa.author_id = ${auth.accountId}`;
}

/** The File response's Publication view: editors receive what a paired save
 * needs, a selected author what its declaration needs; never the fragment. */
export function filePublicationView(
  row: {
    publication_id: string | null;
    publication_link_id: string | null;
    publication_public_key: ArrayBuffer | null;
    publication_revision: number | null;
    declaration_id: string | null;
    declaration_revision: number | null;
    declaration_current: number | null;
  },
  canEdit: boolean,
) {
  if (
    !row.publication_id ||
    !row.publication_link_id ||
    !row.publication_public_key ||
    row.publication_revision === null
  )
    return null;
  if (!canEdit && !row.declaration_id) return null;
  return {
    publicationId: row.publication_id,
    linkId: row.publication_link_id,
    publicKey: encodeTreeBytes(new Uint8Array(row.publication_public_key)),
    ...(canEdit ? { revision: row.publication_revision } : {}),
    declaration: row.declaration_id
      ? {
          declarationId: row.declaration_id,
          revision: row.declaration_revision ?? 0,
          current: Boolean(row.declaration_current),
        }
      : null,
  };
}
