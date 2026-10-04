import type { SQL } from "drizzle-orm";
import { hasEmptyBody, readAuthJsonText, record } from "~/auth/request.server";
import { inspectEnvelope, type EnvelopeContext } from "~/crypto/enc-v1";
import { HPKE_SUITE } from "~/crypto/enc-v1/format";
import { createDb, sql } from "~/db/client.server";
import { authorizePrivateRequest, commitPrivateBatch, commitPrivateMutation, type AuthorizedDevice } from "~/device/proof.server";
import { newOpaqueId } from "~/opaque-id";
import { AbuseControlUnavailableError, abuseControlUnavailableResponse, enforceRateLimit, rateLimitResponse } from "~/security/abuse-control.server";
import { epochInput, epochStatements, readPublicCommentPage, type EpochInput } from "~/comments/public.server";
import { shareHandleLookupToken } from "~/sharing/address";
import { accessPredicate, accountAccessQuery, effectiveAccess, permits } from "~/sharing/access.server";
import { decodeTreeBytes, encodeTreeBytes, isV7 } from "~/tree/wire";
import { decodePublicationPublicKey, isPublicationIdentifier } from "./capability";
import {
  authorDeclarationContext, MAX_AUTHOR_DECLARATION_BYTES, MAX_PUBLIC_REPRESENTATION_BYTES, MAX_PUBLICATION_AUTHORS,
  publicRepresentationContext,
} from "./content";

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
const publicationChanged = () => failure("publication_changed", 409);

const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && Number.isSafeInteger(value + 1);

/** The one active-or-deleting Publication of a File. The identical `IN` term
 * lets SQLite use the partial unique index `publications_file_idx`. */
function filePublication(fileId: string | SQL): SQL {
  return sql`p.file_id = ${fileId} AND p.state IN ('active', 'deleting')`;
}

type PublicationState = {
  id: string; state: "active" | "deleting"; created_at: number; link_id: string | null; public_key: ArrayBuffer | null;
};

/** The File's Publication and active link, re-deriving the actor's File-read access. */
async function publicationState(env: Env, auth: AuthorizedDevice, fileId: string): Promise<PublicationState | null> {
  return (await createDb(env.DB).get<PublicationState>(sql`
    SELECT p.id, p.state, p.created_at, l.id AS link_id, l.public_key
    FROM publications p LEFT JOIN publication_links l ON l.id = p.current_link_id AND l.publication_id = p.id
    WHERE ${filePublication(fileId)} AND ${accessPredicate(auth, fileId, "read")}`)) ?? null;
}

/** Header inspection is structural: the Worker binds purpose, suite, link, key and
 * revision, but cannot and does not open public ciphertext. */
function publicEnvelope(value: unknown, max: number, expected: EnvelopeContext): Uint8Array<ArrayBuffer> {
  const bytes = decodeTreeBytes(value, max);
  const header = inspectEnvelope(bytes);
  const fields = ["purpose", "vaultId", "objectId", "keyId", "keyEpoch", "revision", "recipientId", "publicationId"] as const;
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
  return auth.expiresAt <= Date.now() || !!await createDb(env.DB).get(sql`SELECT 1 FROM device_proof_uses
    WHERE account_id = ${auth.accountId} AND proof_id = ${auth.proofId}`);
}

/** The Publish panel's view. Authors and requests are opaque metadata: the
 * Owner sees all of them, a Collaborator only its own. */
async function readPublication(env: Env, auth: AuthorizedDevice, fileId: string): Promise<Response> {
  const access = await effectiveAccess(env, auth, fileId);
  if (!access || !permits(access, "read_file")) return notFound();
  const db = createDb(env.DB);
  const publication = await publicationState(env, auth, fileId);
  const owner = access.isOwner;
  const authors = publication ? await db.all<{ id: string; author_id: string; ordinal: number; declared: number }>(sql`
    SELECT a.id, a.author_id, a.ordinal, a.ciphertext IS NOT NULL AND a.link_id IS p.current_link_id AS declared
    FROM publication_authors a JOIN publications p ON p.id = a.publication_id
    WHERE a.publication_id = ${publication.id} AND (${owner ? sql`1` : sql`a.author_id = ${auth.accountId}`})
      AND ${accessPredicate(auth, fileId, "read")}
    ORDER BY a.ordinal LIMIT ${MAX_PUBLICATION_AUTHORS}`) : [];
  const requests = await db.all<{ id: string; requester_id: string; created_at: number }>(sql`
    SELECT r.id, r.requester_id, r.created_at FROM publication_requests r
    WHERE r.file_id = ${fileId} AND (${owner ? sql`r.owner_id = ${auth.accountId}` : sql`r.requester_id = ${auth.accountId}`})
      AND ${accessPredicate(auth, fileId, "read")}
    ORDER BY r.id LIMIT 100`);
  // Public Comment audience state: the Owner sees it to configure the thread.
  const comments = publication ? await db.get<{ threadId: string; epochId: string; audience: string }>(sql`
    SELECT t.id AS threadId, t.current_epoch_id AS epochId, e.audience FROM comment_threads t
    JOIN comment_thread_epochs e ON e.id = t.current_epoch_id AND e.thread_id = t.id
    WHERE t.publication_id = ${publication.id} AND t.purpose = 'public' AND ${accessPredicate(auth, fileId, "read")}`) : null;
  return Response.json({
    fileId, isOwner: owner, canEdit: permits(access, "edit_markdown"),
    publication: publication ? { publicationId: publication.id, state: publication.state, createdAt: publication.created_at,
      authors: authors.map((author) => ({ declarationId: author.id, ordinal: author.ordinal,
        self: author.author_id === auth.accountId, declared: Boolean(author.declared) })) } : null,
    comments: comments ? { threadId: comments.threadId, epochId: comments.epochId, audience: comments.audience } : null,
    requests: requests.map((request) => ({ requestId: request.id, own: request.requester_id === auth.accountId,
      createdAt: request.created_at })),
  }, { headers });
}

type Creation = {
  publicationId: string; linkId: string; publicKey: Uint8Array<ArrayBuffer>;
  expectedRevision: number; expectedRepresentationId: string; ciphertext: Uint8Array<ArrayBuffer>;
  author: { declarationId: string; ciphertext: Uint8Array<ArrayBuffer> } | null;
  comments: EpochInput | null;
};

async function creationInput(value: unknown, ownerId: string): Promise<Creation | null> {
  const input = record(value), representation = record(input?.representation);
  if (!input || !representation || !exact(input, ["publicationId", "linkId", "publicKey", "expectedRevision",
      "expectedRepresentationId", "representation", "author", "comments"]) || !exact(representation, ["ciphertext"]) ||
      !isPublicationIdentifier(input.publicationId) || !isPublicationIdentifier(input.linkId) ||
      input.publicationId === input.linkId || !positive(input.expectedRevision) || !isV7(input.expectedRepresentationId)) return null;
  const author = input.author === null ? null : record(input.author);
  if (input.author !== null && (!author || !exact(author, ["declarationId", "ciphertext"]) ||
      !isPublicationIdentifier(author.declarationId) ||
      author.declarationId === input.publicationId || author.declarationId === input.linkId)) return null;
  // A new Publication defaults to public Comments; a legacy caller may omit the
  // thread entirely and configure it later from the Publish panel.
  const comments = input.comments === null ? null
    : epochInput(input.comments, ownerId, input.publicationId, input.linkId);
  if (input.comments !== null && !comments) return null;
  try {
    const publicKey = await validPublicKey(input.publicKey);
    const binding = { publicationId: input.publicationId, linkId: input.linkId, publicKey };
    return { publicationId: input.publicationId, linkId: input.linkId, publicKey,
      expectedRevision: input.expectedRevision, expectedRepresentationId: input.expectedRepresentationId,
      ciphertext: publicEnvelope(representation.ciphertext, MAX_PUBLIC_REPRESENTATION_BYTES,
        publicRepresentationContext({ ...binding, revision: 1 })),
      author: author ? { declarationId: author.declarationId as string, ciphertext: publicEnvelope(author.ciphertext,
        MAX_AUTHOR_DECLARATION_BYTES, authorDeclarationContext({ ...binding,
          declarationId: author.declarationId as string, revision: 1 })) } : null,
      comments };
  } catch { return null; }
}

/** Publication-create/rotate abuse limit (5 / 24 h per Account) before the CAS. */
async function creationQuota(request: Request, env: Env, auth: AuthorizedDevice): Promise<Response | null> {
  try {
    const limit = await enforceRateLimit({ db: env.DB, request, action: "publication.mutate",
      scopes: { accountId: auth.accountId }, hmacSecret: env.ABUSE_HMAC_SECRET });
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
async function createPublication(request: Request, env: Env, auth: AuthorizedDevice, fileId: string, value: unknown): Promise<Response> {
  const db = createDb(env.DB);
  const file = await db.get<{ current_revision: number; current_representation_id: string; converted: number; published: number }>(sql`
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
  if (file.current_revision !== input.expectedRevision || file.current_representation_id !== input.expectedRepresentationId) {
    return failure("file_changed", 409);
  }
  const quota = await creationQuota(request, env, auth);
  if (quota) return quota;
  const now = Date.now(), representationId = newOpaqueId();
  let committed = false;
  try {
    committed = await commitPrivateBatch(env, auth, (guard) => sql`
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
      ...(input.author ? [sql`INSERT INTO publication_authors (id, publication_id, author_id, ordinal, link_id, revision,
          ciphertext, created_at, updated_at)
        SELECT ${input.author.declarationId}, ${input.publicationId}, ${auth.accountId}, 1, ${input.linkId}, 1,
          ${input.author.ciphertext}, ${now}, ${now} WHERE ${marker}`] : []),
      // A new Publication defaults to public Comments: the Public thread and its
      // first audience epoch are installed atomically with the Publication, so a
      // reader can never observe a Publication without its thread.
      ...(input.comments ? [
        sql`INSERT INTO comment_thread_epochs (id, thread_id, audience, key_epoch, ordinal, state, created_at)
          SELECT ${input.comments.epochId}, ${input.comments.threadId}, ${input.comments.audience}, 1, 1, 'active', ${now} WHERE ${marker}`,
        sql`INSERT INTO comment_threads (id, owner_id, file_id, purpose, publication_id, current_epoch_id, next_sequence, created_at)
          SELECT ${input.comments.threadId}, ${auth.accountId}, ${fileId}, 'public', ${input.publicationId},
            ${input.comments.epochId}, 1, ${now} WHERE ${marker}`,
        ...epochStatements(marker, input.comments, input.publicationId, input.linkId, now),
      ] : []),
      // Approval is publishing: every pending request for this File is satisfied.
      sql`DELETE FROM publication_requests WHERE file_id = ${fileId} AND owner_id = ${auth.accountId} AND ${marker}`,
    ], { deferForeignKeys: true });
  } catch {
    // A colliding random identifier rolls back the whole batch; nothing is public.
    return publicationChanged();
  }
  if (committed) return Response.json({ publicationId: input.publicationId, linkId: input.linkId, revision: 1,
    comments: input.comments ? { threadId: input.comments.threadId, epochId: input.comments.epochId,
      audience: input.comments.audience } : null }, { status: 201, headers });
  if (await proofSpent(env, auth)) return denied();
  const latest = await db.get<{ current_revision: number; current_representation_id: string; published: number }>(sql`
    SELECT f.current_revision, f.current_representation_id,
      EXISTS (SELECT 1 FROM publications p WHERE ${filePublication(sql`f.node_id`)}) AS published
    FROM files f WHERE f.node_id = ${fileId} AND f.owner_id = ${auth.accountId} AND ${accessPredicate(auth, fileId, "owner")}`);
  if (!latest) return notFound();
  if (latest.published) return failure("publication_exists", 409);
  return latest.current_revision !== input.expectedRevision || latest.current_representation_id !== input.expectedRepresentationId
    ? failure("file_changed", 409) : denied();
}

/** A Collaborator with File access asks the Owner to publish. It creates no
 * Publication, link, representation or public access of any kind. */
async function createRequest(env: Env, auth: AuthorizedDevice, fileId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, [])) return invalid();
  const access = await effectiveAccess(env, auth, fileId);
  if (!access || !permits(access, "request_publication")) return notFound();
  const db = createDb(env.DB);
  const existing = () => db.get<{ id: string }>(sql`SELECT id FROM publication_requests
    WHERE file_id = ${fileId} AND requester_id = ${auth.accountId}
      AND ${accessPredicate(auth, fileId, "read")}`);
  const requestId = newOpaqueId();
  const committed = await commitPrivateMutation(env, auth, (guard) => sql`
    INSERT INTO publication_requests (id, file_id, owner_id, requester_id, created_at)
    SELECT ${requestId}, f.node_id, f.owner_id, ${auth.accountId}, ${Date.now()} FROM files f
    WHERE f.node_id = ${fileId} AND f.owner_id != ${auth.accountId} AND ${accessPredicate(auth, fileId, "read")}
      AND NOT EXISTS (SELECT 1 FROM publications p WHERE ${filePublication(sql`f.node_id`)})
      AND NOT EXISTS (SELECT 1 FROM publication_requests r WHERE r.file_id = f.node_id AND r.requester_id = ${auth.accountId})
      AND ${guard}`);
  if (committed) return Response.json({ requestId, created: true }, { status: 201, headers });
  if (await proofSpent(env, auth)) return denied();
  const pending = await existing();
  if (pending) return Response.json({ requestId: pending.id, created: false }, { headers });
  if (await db.get(sql`SELECT 1 FROM publications p WHERE ${filePublication(fileId)}
    AND ${accessPredicate(auth, fileId, "read")}`)) return failure("publication_exists", 409);
  return notFound();
}

/** The requester cancels or the File Owner denies; either hard-deletes it. */
async function deleteRequest(env: Env, auth: AuthorizedDevice, fileId: string, requestId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, [])) return invalid();
  const access = await effectiveAccess(env, auth, fileId);
  if (!access || !permits(access, "read_file")) return notFound();
  const committed = await commitPrivateMutation(env, auth, (guard) => sql`
    DELETE FROM publication_requests WHERE id = ${requestId} AND file_id = ${fileId}
      AND ((requester_id = ${auth.accountId} AND ${accessPredicate(auth, fileId, "read")})
        OR (owner_id = ${auth.accountId} AND ${accessPredicate(auth, fileId, "owner")}))
      AND ${guard}`);
  if (committed) return Response.json({ deleted: true }, { headers });
  // An absent request is idempotent only while File authority is still live.
  // Another requester's entry is indistinguishable from an inaccessible File.
  const row = await createDb(env.DB).get<{ id: string | null }>(sql`
    SELECT r.id FROM files f LEFT JOIN publication_requests r ON r.id = ${requestId} AND r.file_id = f.node_id
    WHERE f.node_id = ${fileId} AND ${accessPredicate(auth, fileId, "read")}
      AND (r.id IS NULL OR r.requester_id = ${auth.accountId}
        OR (f.owner_id = ${auth.accountId} AND ${accessPredicate(auth, fileId, "owner")}))`);
  if (!row) return notFound();
  if (row.id) return await proofSpent(env, auth) ? denied() : notFound();
  return Response.json({ deleted: true, alreadyDeleted: true }, { headers });
}

type AuthorAddress = { self: true } | { shareId: string } | { handle: string };

function authorAddress(value: unknown): AuthorAddress | null {
  const input = record(value);
  if (!input) return null;
  if (exact(input, ["self"]) && input.self === true) return { self: true };
  if (exact(input, ["shareId"]) && typeof input.shareId === "string" && input.shareId.length > 0 &&
      input.shareId.length <= 128) return { shareId: input.shareId };
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
  if (!input || !address || !exact(input, ["publicationId", "declarationId", "account", "declaration"]) ||
      !isPublicationIdentifier(input.publicationId) || !isPublicationIdentifier(input.declarationId)) return invalid();
  const access = await effectiveAccess(env, auth, fileId);
  if (!access || !permits(access, "manage_publication")) return notFound();
  const publication = await publicationState(env, auth, fileId);
  if (!publication || publication.state !== "active" || publication.id !== input.publicationId ||
      !publication.link_id || !publication.public_key) return publicationChanged();
  const db = createDb(env.DB);
  let candidate: string | undefined;
  let declaration: Uint8Array<ArrayBuffer> | null = null;
  if ("self" in address) {
    const supplied = record(input.declaration);
    if (!supplied || !exact(supplied, ["linkId", "ciphertext"]) || supplied.linkId !== publication.link_id) return publicationChanged();
    try {
      declaration = publicEnvelope(supplied.ciphertext, MAX_AUTHOR_DECLARATION_BYTES, authorDeclarationContext({
        publicationId: publication.id, linkId: publication.link_id, publicKey: new Uint8Array(publication.public_key),
        declarationId: input.declarationId, revision: 1 }));
    } catch { return invalid(); }
    candidate = auth.accountId;
  } else {
    if (input.declaration !== null) return invalid();
    let lookup: SQL;
    if ("shareId" in address) lookup = sql`share_id = ${address.shareId}`;
    else {
      try { lookup = sql`share_handle_lookup_token = ${await shareHandleLookupToken(address.handle)}`; }
      catch { return invalid(); }
    }
    // Only an Account holding current access to this File can be credited;
    // an unknown address and an Account without access are indistinguishable.
    const account = await db.get<{ id: string }>(sql`SELECT id FROM accounts
      WHERE ${lookup} AND id != ${auth.accountId} AND ${accessPredicate(auth, fileId, "owner")}`);
    if (!account || !await db.get(sql`SELECT 1 FROM (${accountAccessQuery(account.id, fileId)}) a
      WHERE a.kind = 'file' AND ${accessPredicate(auth, fileId, "owner")}`)) return notFound();
    candidate = account.id;
  }
  const self = candidate === auth.accountId, now = Date.now();
  let committed = false;
  try {
    committed = await commitPrivateMutation(env, auth, (guard) => sql`
      INSERT INTO publication_authors (id, publication_id, author_id, ordinal, link_id, revision, ciphertext, created_at, updated_at)
      SELECT ${input.declarationId}, p.id, ${candidate},
        COALESCE((SELECT max(ordinal) FROM publication_authors WHERE publication_id = p.id), 0) + 1,
        ${self ? publication.link_id : null}, ${self ? 1 : 0}, ${declaration}, ${now}, ${now}
      FROM publications p WHERE p.id = ${publication.id} AND ${filePublication(fileId)} AND p.state = 'active'
        AND p.owner_id = ${auth.accountId} AND p.current_link_id = ${publication.link_id}
        AND (SELECT count(*) FROM publication_authors WHERE publication_id = p.id) < ${MAX_PUBLICATION_AUTHORS}
        AND NOT EXISTS (SELECT 1 FROM publication_authors WHERE publication_id = p.id AND author_id = ${candidate})
        AND (${self ? sql`1` : sql`EXISTS (SELECT 1 FROM (${accountAccessQuery(candidate, fileId)}) a WHERE a.kind = 'file')`})
        AND ${accessPredicate(auth, fileId, "owner")} AND ${guard}`);
  } catch { return publicationChanged(); }
  if (committed) return Response.json({ declarationId: input.declarationId }, { status: 201, headers });
  if (await proofSpent(env, auth)) return denied();
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

async function removeAuthor(env: Env, auth: AuthorizedDevice, fileId: string, declarationId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, [])) return invalid();
  const access = await effectiveAccess(env, auth, fileId);
  if (!access || !permits(access, "manage_publication")) return notFound();
  const committed = await commitPrivateMutation(env, auth, (guard) => sql`
    DELETE FROM publication_authors WHERE id = ${declarationId}
      AND publication_id IN (SELECT p.id FROM publications p WHERE ${filePublication(fileId)}
        AND p.state = 'active' AND p.owner_id = ${auth.accountId})
      AND ${accessPredicate(auth, fileId, "owner")} AND ${guard}`);
  if (committed) return Response.json({ deleted: true }, { headers });
  return await proofSpent(env, auth) ? denied() : Response.json({ deleted: true, alreadyDeleted: true }, { headers });
}

/** A selected author's own device (re)declares its pseudonym to the current link. */
async function declareAuthor(env: Env, auth: AuthorizedDevice, fileId: string, declarationId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["publicationId", "linkId", "revision", "ciphertext"]) ||
      !isPublicationIdentifier(input.publicationId) || !isPublicationIdentifier(input.linkId) || !positive(input.revision)) return invalid();
  const publication = await publicationState(env, auth, fileId);
  const author = publication ? await createDb(env.DB).get<{ revision: number }>(sql`SELECT revision FROM publication_authors
    WHERE id = ${declarationId} AND publication_id = ${publication.id} AND author_id = ${auth.accountId}
      AND ${accessPredicate(auth, fileId, "read")}`) : null;
  if (!publication || !author) return notFound();
  if (publication.state !== "active" || publication.id !== input.publicationId || publication.link_id !== input.linkId ||
      !publication.public_key || author.revision + 1 !== input.revision) return publicationChanged();
  let ciphertext: Uint8Array<ArrayBuffer>;
  try {
    ciphertext = publicEnvelope(input.ciphertext, MAX_AUTHOR_DECLARATION_BYTES, authorDeclarationContext({
      publicationId: publication.id, linkId: input.linkId, publicKey: new Uint8Array(publication.public_key),
      declarationId, revision: input.revision }));
  } catch { return invalid(); }
  const committed = await commitPrivateMutation(env, auth, (guard) => sql`
    UPDATE publication_authors SET link_id = ${input.linkId}, revision = ${input.revision}, ciphertext = ${ciphertext},
      updated_at = ${Date.now()}
    WHERE id = ${declarationId} AND author_id = ${auth.accountId} AND revision = ${author.revision}
      AND publication_id = ${publication.id}
      AND EXISTS (SELECT 1 FROM publications p WHERE p.id = ${publication.id} AND ${filePublication(fileId)}
        AND p.state = 'active' AND p.current_link_id = ${input.linkId})
      AND ${accessPredicate(auth, fileId, "read")} AND ${guard}`);
  if (committed) return Response.json({ revision: input.revision }, { headers });
  return await proofSpent(env, auth) ? denied() : publicationChanged();
}

/** Resource-only, proof-guarded Publication API. Reads are bodyless POSTs. */
export async function publicationsAction(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  const collection = /^\/api\/private\/publications\/files\/([0-9a-f-]+)$/.exec(path);
  const requests = /^\/api\/private\/publications\/files\/([0-9a-f-]+)\/requests$/.exec(path);
  const requestEntry = /^\/api\/private\/publications\/files\/([0-9a-f-]+)\/requests\/([0-9a-f-]+)$/.exec(path);
  const authors = /^\/api\/private\/publications\/files\/([0-9a-f-]+)\/authors$/.exec(path);
  const author = /^\/api\/private\/publications\/files\/([0-9a-f-]+)\/authors\/([A-Za-z0-9_-]+)$/.exec(path);
  const declaration = /^\/api\/private\/publications\/files\/([0-9a-f-]+)\/authors\/([A-Za-z0-9_-]+)\/declaration$/.exec(path);
  const allowed = (collection && (request.method === "POST" || request.method === "PUT")) ||
    (requests && request.method === "POST") || (requestEntry && request.method === "DELETE") ||
    (authors && request.method === "PUT") || (author && request.method === "DELETE") ||
    (declaration && request.method === "PUT");
  const match = collection ?? requests ?? requestEntry ?? authors ?? author ?? declaration;
  if (!allowed || !match || new URL(request.url).search) return notFound();
  const fileId = match[1]!, entryId = match[2];
  if (!isV7(fileId) || (requestEntry && !isV7(entryId)) || ((author || declaration) && !isPublicationIdentifier(entryId))) {
    return notFound();
  }
  let raw = "", value: unknown = null;
  try {
    if (collection && request.method === "POST") {
      if (!await hasEmptyBody(request)) return denied();
    } else {
      const parsed = await readAuthJsonText(request, 1536 * 1024);
      raw = parsed.raw; value = parsed.value;
    }
  } catch { return invalid(); }
  let proof: unknown;
  try { proof = JSON.parse(request.headers.get("X-Mdwn-Device-Proof") ?? "null"); }
  catch { return denied(); }
  const auth = await authorizePrivateRequest(request, env, proof, raw);
  if (!auth) return denied();
  if (collection) return request.method === "PUT" ? createPublication(request, env, auth, fileId, value)
    : readPublication(env, auth, fileId);
  if (requests) return createRequest(env, auth, fileId, value);
  if (requestEntry) return deleteRequest(env, auth, fileId, entryId!, value);
  if (authors) return addAuthor(env, auth, fileId, value);
  if (author) return removeAuthor(env, auth, fileId, entryId!, value);
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
  return !!await createDb(env.DB).get(sql`SELECT 1 FROM publication_links l
    JOIN publications p ON p.id = l.publication_id AND p.current_link_id = l.id AND p.state = 'active'
    WHERE l.id = ${linkId}`);
}

type PublicRow = { publication_id: string; public_key: ArrayBuffer; revision: number; ciphertext: ArrayBuffer; authors: string };

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
  const authors = (JSON.parse(row.authors) as { declarationId: string; revision: number; ordinal: number; ciphertext: string }[])
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((author) => ({ declarationId: author.declarationId, revision: author.revision,
      ciphertext: encodeTreeBytes(Uint8Array.from(author.ciphertext.match(/../g) ?? [], (pair) => parseInt(pair, 16))) }));
  return Response.json({
    publicationId: row.publication_id, linkId,
    publicKey: encodeTreeBytes(new Uint8Array(row.public_key)),
    representation: { revision: row.revision, ciphertext: encodeTreeBytes(new Uint8Array(row.ciphertext)) },
    authors,
    // Public Comment epochs: only explicitly public epochs are ever served, and
    // never a Comment body, wrapper or attribution from a Collaborators-only one.
    comments: await readPublicCommentPage(env, linkId, 0),
  }, { headers });
}

/** Anonymous Public Comment pagination for one active link; the same encrypted
 * epoch capabilities are used locally, so no fragment ever reaches the route. */
export async function readPublicCommentPageForLink(env: Env, linkId: string, cursor: number): Promise<Response> {
  if (!isPublicationIdentifier(linkId)) return publicNotFound();
  const row = await createDb(env.DB).get<{ publication_id: string }>(sql`SELECT p.id AS publication_id FROM publication_links l
    JOIN publications p ON p.id = l.publication_id AND p.current_link_id = l.id AND p.state = 'active'
    WHERE l.id = ${linkId}`);
  if (!row) return publicNotFound();
  return Response.json({ publicationId: row.publication_id, linkId,
    comments: await readPublicCommentPage(env, linkId, cursor) }, { headers });
}

// ---------------------------------------------------------------------------
// Paired File save seam (consumed by the converted-File save in tree.server.ts)
// ---------------------------------------------------------------------------

/** The active Publication as read with the File in the save preflight. */
export type ActivePublication = { id: string; linkId: string; publicKey: Uint8Array; revision: number };

export type PublicationSave = { publicationId: string; linkId: string; revision: number; ciphertext: Uint8Array<ArrayBuffer> };

/**
 * A converted save names the Publication it encrypted for, or null when it
 * believes none is active. Any mismatch with the current state is a 409 the
 * browser resolves by re-reading the File, never a silent skip.
 */
export function publicationSave(value: unknown, active: ActivePublication | null):
  { save: PublicationSave | null } | { error: "invalid" | "changed" } {
  if (value === undefined || value === null) return active ? { error: "changed" } : { save: null };
  const input = record(value);
  if (!input || !exact(input, ["publicationId", "linkId", "revision", "ciphertext"]) ||
      !isPublicationIdentifier(input.publicationId) || !isPublicationIdentifier(input.linkId) ||
      !positive(input.revision) || input.revision < 2) return { error: "invalid" };
  if (!active || active.id !== input.publicationId || active.linkId !== input.linkId ||
      active.revision + 1 !== input.revision) return { error: "changed" };
  try {
    return { save: { publicationId: input.publicationId, linkId: input.linkId, revision: input.revision,
      ciphertext: publicEnvelope(input.ciphertext, MAX_PUBLIC_REPRESENTATION_BYTES, publicRepresentationContext({
        publicationId: active.id, linkId: active.linkId, publicKey: active.publicKey, revision: input.revision })) } };
  } catch { return { error: "invalid" }; }
}

/** The File save's first CAS: the same Publication state it encrypted for. */
export function publicationSaveCondition(fileId: string, ownerId: string, save: PublicationSave | null): SQL {
  if (!save) return sql`NOT EXISTS (SELECT 1 FROM publications p WHERE ${filePublication(fileId)} AND p.state = 'active')`;
  return sql`EXISTS (SELECT 1 FROM publications p JOIN public_representations r ON r.id = p.current_representation_id
      AND r.publication_id = p.id AND r.link_id = p.current_link_id
    WHERE ${filePublication(fileId)} AND p.state = 'active' AND p.owner_id = ${ownerId} AND p.id = ${save.publicationId}
      AND p.current_link_id = ${save.linkId} AND r.revision = ${save.revision - 1})`;
}

/** Marker-gated dependents: the Public pointer moves in the same transaction as
 * the private pointer, and the superseded Public representation is removed. */
export function publicationSaveStatements(save: PublicationSave | null, fileRevision: number, marker: SQL): SQL[] {
  if (!save) return [];
  const id = newOpaqueId(), now = Date.now();
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
export function filePublicationView(row: {
  publication_id: string | null; publication_link_id: string | null; publication_public_key: ArrayBuffer | null;
  publication_revision: number | null; declaration_id: string | null; declaration_revision: number | null;
  declaration_current: number | null;
}, canEdit: boolean) {
  if (!row.publication_id || !row.publication_link_id || !row.publication_public_key || row.publication_revision === null) return null;
  if (!canEdit && !row.declaration_id) return null;
  return { publicationId: row.publication_id, linkId: row.publication_link_id,
    publicKey: encodeTreeBytes(new Uint8Array(row.publication_public_key)),
    ...(canEdit ? { revision: row.publication_revision } : {}),
    declaration: row.declaration_id ? { declarationId: row.declaration_id, revision: row.declaration_revision ?? 0,
      current: Boolean(row.declaration_current) } : null };
}
