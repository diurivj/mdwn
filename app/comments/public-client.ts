import { readPseudonym } from "~/account/profile-client";
import { openVaultRecoveryEnvelope } from "~/crypto/vault";
import { privateRequest, PrivateAccessError } from "~/device/private-client";
import { getDevice } from "~/device/store";
import { newOpaqueId } from "~/opaque-id";
import { openCommentKeyEnvelope, type CommentKeyContext } from "~/sharing/comment-keys";
import { openRoot, type RootAccess } from "~/tree/client";
import { decodeTreeBytes } from "~/tree/wire";
import { MAX_COMMENT_KEY_ENVELOPE_BYTES } from "./content";
import {
  openCommentEpochLink, openPublicAttribution, openPublicCommentBody,
  sealPublicAttribution, sealPublicCommentBody,
} from "./public-content";

/**
 * Browser-only Public Comment access (ticket 23).
 *
 * The anonymous Public page opens a `public` epoch capability from its
 * Publication-link wrapper, which exists only while the fragment scalar is in
 * this browser. An eligible Owner/Collaborator device opens the same epoch
 * capability from its device envelope on the authenticated File route and never
 * needs the fragment. Plaintext never leaves the browser.
 */

export const PUBLIC_COMMENTS_PAGE = 50;

export class PublicCommentsChangedError extends Error {
  constructor() { super("comment_changed"); }
}
export class PublicCommentsNotFoundError extends Error {
  constructor() { super("not_found"); }
}
export class PublicCommentsSealedError extends Error {
  constructor() { super("key_rotation_required"); }
}
export class PublicCommentsPseudonymPendingError extends Error {
  constructor() { super("pseudonym_update_pending"); }
}
export class PublicCommentsLimitedError extends Error {
  constructor() { super("rate_limited"); }
}
export class PublicCommentsPreparingError extends Error {
  constructor() { super("secure_access_preparing"); }
}
export class PublicCommentsSignInError extends Error {
  constructor(readonly state: "signed-out" | "unprovisioned") { super("sign-in-required"); }
}

export type PublicEpoch = { epochId: string; ordinal: number; audience: "public" | "collaborators_only";
  state: string; capabilityId: string; capabilityEpoch: number; capability: Uint8Array<ArrayBuffer> };

export type PublicComment = { id: string; epochId: string; authorId: string; sequence: number; revision: number;
  text: string | null; createdAt: number; updatedAt: number; canEdit: boolean; canDelete: boolean };

export type PublicThreadView = {
  threadId: string; publicationId: string; ownerId: string | null; fileId: string | null; linkId: string | null; currentEpochId: string;
  audience: "public" | "collaborators_only";
  viewerAccountId: string | null; postingState: "signed-out" | "unprovisioned" | "ready"; canDeleteAny: boolean;
  epochs: PublicEpoch[]; comments: PublicComment[]; pseudonyms: Map<string, string>; nextCursor: number | null;
};

export type PublicLinkComments =
  | { status: "unavailable"; threadId: string | null }
  | { status: "ready"; thread: PublicThreadView };

type EnvelopeWire = { mode: "owned"; keyEpoch: number; ciphertext: string } |
  ({ mode: "grant" } & CommentKeyContext & { deviceId: string; signerDeviceId: string; signerPublicKey: string;
    ciphertext: string; signature: string });

export type PublicEpochWire = { epochId: string; ordinal: number; state: string;
  audience: "public" | "collaborators_only";
  capabilityId: string; capabilityEpoch: number; wrapper?: string; envelope?: EnvelopeWire };

export type PublicCommentsWire = {
  audience: "public" | "collaborators_only"; threadId: string | null;
  epochs: PublicEpochWire[];
  comments: { id: string; epochId: string; authorId: string; sequence: number; revision: number;
    bodyCiphertext: string; contentKeyEnvelope: string; contentKeyEpoch: number; createdAt: number; updatedAt: number }[];
  attributions: { id: string; authorId: string; epochId: string; revision: number; ciphertext: string;
    contentKeyEnvelope: string; contentKeyEpoch: number }[];
  nextCursor: number | null;
};

/** Reject a malformed anonymous page before any cryptography runs. */
export function publicCommentsWire(value: unknown): PublicCommentsWire | null {
  const input = value as PublicCommentsWire | null;
  if (!input || (input.audience !== "public" && input.audience !== "collaborators_only") ||
      !Array.isArray(input.epochs) || input.epochs.length > 100 ||
      !Array.isArray(input.comments) || input.comments.length > PUBLIC_COMMENTS_PAGE ||
      !Array.isArray(input.attributions) || input.attributions.length > PUBLIC_COMMENTS_PAGE + 1 ||
      !(input.nextCursor === null || Number.isSafeInteger(input.nextCursor) && input.nextCursor >= 0)) return null;
  return input;
}

function openWireEnvelope(access: RootAccess, ownerId: string, epoch: PublicEpochWire): Promise<Uint8Array<ArrayBuffer>> {
  const envelope = epoch.envelope;
  if (!envelope) return Promise.reject(new Error("missing comment envelope"));
  if (envelope.mode === "owned") {
    return openVaultRecoveryEnvelope(decodeTreeBytes(envelope.ciphertext, MAX_COMMENT_KEY_ENVELOPE_BYTES),
      access.actorVaultRootKey, { purpose: "vault-recovery", vaultId: ownerId, objectId: epoch.epochId,
        keyId: epoch.capabilityId, keyEpoch: epoch.capabilityEpoch, revision: 1 });
  }
  return getDevice(access.actorAccountId).then((device) => {
    if (!device) throw new Error("private tree unavailable");
    return openCommentKeyEnvelope({ ...envelope, recipient: device.transportKeyPair });
  });
}

/** One opened epoch capability and the identity its envelopes were bound to. */
type OpenedEpoch = { capability: Uint8Array<ArrayBuffer>; capabilityId: string; capabilityEpoch: number };

/** Decrypt one wire page with the capabilities this browser can open. */
async function decryptPage(wire: PublicCommentsWire, epochs: Map<string, OpenedEpoch>, publicationId: string) {
  const pseudonyms = new Map<string, string>();
  for (const attribution of wire.attributions) {
    const epoch = epochs.get(attribution.epochId);
    if (!epoch) continue;
    try {
      pseudonyms.set(attribution.authorId, await openPublicAttribution(epoch.capability, {
        publicationId,
        attributionId: attribution.id, revision: attribution.revision,
        capabilityId: epoch.capabilityId,
        keyEpoch: attribution.contentKeyEpoch, ciphertext: attribution.ciphertext,
        contentKeyEnvelope: attribution.contentKeyEnvelope }));
    } catch { /* An unreadable pseudonym never blocks the rest of the thread. */ }
  }
  const comments: PublicComment[] = [];
  for (const comment of wire.comments) {
    const epoch = epochs.get(comment.epochId);
    let text: string | null = null;
    if (epoch) {
      try {
        text = await openPublicCommentBody(epoch.capability, {
          publicationId,
          commentId: comment.id, revision: comment.revision,
          capabilityId: epoch.capabilityId,
          keyEpoch: comment.contentKeyEpoch, bodyCiphertext: comment.bodyCiphertext,
          contentKeyEnvelope: comment.contentKeyEnvelope });
      } catch { /* Keep the record visible with an explicit display failure. */ }
    }
    comments.push({ id: comment.id, epochId: comment.epochId, authorId: comment.authorId,
      sequence: comment.sequence, revision: comment.revision, text,
      createdAt: comment.createdAt, updatedAt: comment.updatedAt, canEdit: false, canDelete: false });
  }
  return { comments, pseudonyms };
}

const openedEpochs = (epochs: readonly PublicEpoch[]): Map<string, OpenedEpoch> =>
  new Map(epochs.map((epoch) => [epoch.epochId, { capability: epoch.capability,
    capabilityId: epoch.capabilityId, capabilityEpoch: epoch.capabilityEpoch }]));

function withViewer(view: PublicThreadView, viewerAccountId: string | null, canDeleteAny: boolean): PublicThreadView {
  return { ...view, viewerAccountId, canDeleteAny,
    comments: view.comments.map((comment) => ({ ...comment,
      canEdit: comment.authorId === viewerAccountId,
      canDelete: comment.authorId === viewerAccountId || canDeleteAny })) };
}

/**
 * The anonymous Public reader's first page: every public epoch wrapper is
 * opened with the fragment capability held only in this browser.
 */
export async function loadLinkPublicComments(input: {
  publicationId: string; linkId: string; privateKey: Uint8Array<ArrayBuffer>; publicKey: Uint8Array;
  comments: PublicCommentsWire;
}): Promise<PublicLinkComments> {
  const { comments } = input;
  if (!comments.threadId || comments.audience !== "public") return { status: "unavailable", threadId: comments.threadId };
  const epochs: PublicEpoch[] = [];
  for (const epoch of comments.epochs) {
    if (!epoch.wrapper) continue;
    try {
      const capability = await openCommentEpochLink(input.privateKey, input.publicKey, {
        publicationId: input.publicationId, linkId: input.linkId, epochId: epoch.epochId,
        capabilityId: epoch.capabilityId, keyEpoch: epoch.capabilityEpoch, ciphertext: epoch.wrapper });
      epochs.push({ epochId: epoch.epochId, ordinal: epoch.ordinal, audience: "public", state: epoch.state,
        capabilityId: epoch.capabilityId, capabilityEpoch: epoch.capabilityEpoch, capability });
    } catch { /* An unreadable wrapper hides only its own epoch. */ }
  }
  const decrypted = await decryptPage(comments, openedEpochs(epochs), input.publicationId);
  const viewer = await postingViewer();
  return { status: "ready", thread: withViewer({
    threadId: comments.threadId, publicationId: input.publicationId, ownerId: null, fileId: null,
    linkId: input.linkId,
    currentEpochId: epochs.find((epoch) => epoch.state === "active")?.epochId ?? epochs.at(-1)?.epochId ?? "",
    audience: "public", viewerAccountId: viewer.accountId, postingState: viewer.state, canDeleteAny: false,
    epochs, comments: decrypted.comments, pseudonyms: decrypted.pseudonyms, nextCursor: comments.nextCursor,
  }, viewer.accountId, false) };
}

/** The signed-in visitor's posting state, without sending the fragment anywhere. */
async function postingViewer(): Promise<{ accountId: string | null; state: "signed-out" | "unprovisioned" | "ready" }> {
  try {
    const response = await fetch("/api/device/state", { cache: "no-store" });
    if (!response.ok) return { accountId: null, state: "signed-out" };
    const state = await response.json() as { accountId?: unknown; deviceId?: unknown };
    if (typeof state.accountId !== "string" || !state.accountId) return { accountId: null, state: "signed-out" };
    return typeof state.deviceId === "string"
      ? { accountId: state.accountId, state: "ready" }
      : { accountId: state.accountId, state: "unprovisioned" };
  } catch { return { accountId: null, state: "signed-out" }; }
}

/** Continue an anonymous Public thread page by page. */
export async function loadMoreLinkPublicComments(thread: PublicThreadView, signal?: AbortSignal): Promise<{
  comments: PublicComment[]; pseudonyms: Map<string, string>; nextCursor: number | null }> {
  if (!thread.linkId) throw new PublicCommentsChangedError();
  const response = await fetch(`/api/public/publications/${thread.linkId}/comments${thread.nextCursor === null ? "" : `?cursor=${thread.nextCursor}`}`,
    { credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", redirect: "error", signal });
  if (!response.ok) throw new PublicCommentsChangedError();
  const body = await response.json() as { comments: unknown };
  const wire = publicCommentsWire(body.comments);
  if (!wire) throw new PublicCommentsChangedError();
  const decrypted = await decryptPage(wire, openedEpochs(thread.epochs), thread.publicationId);
  const pseudonyms = new Map(thread.pseudonyms);
  for (const [authorId, pseudonym] of decrypted.pseudonyms) pseudonyms.set(authorId, pseudonym);
  return { comments: decrypted.comments, pseudonyms, nextCursor: wire.nextCursor };
}

/** Seal a Public Comment and its optional first attribution with the epoch key. */
async function seal(input: { capability: Uint8Array; publicationId: string; capabilityId: string; keyEpoch: number;
  text: string; pseudonym: string | null }) {
  const commentId = newOpaqueId();
  const body = await sealPublicCommentBody(input.capability, { publicationId: input.publicationId, commentId,
    capabilityId: input.capabilityId, keyEpoch: input.keyEpoch, revision: 1, text: input.text });
  let attribution = null;
  if (input.pseudonym !== null) {
    const attributionId = newOpaqueId();
    const sealed = await sealPublicAttribution(input.capability, { publicationId: input.publicationId, attributionId,
      pseudonym: input.pseudonym, capabilityId: input.capabilityId, keyEpoch: input.keyEpoch });
    attribution = { attributionId, ciphertext: sealed.ciphertext, contentKeyEnvelope: sealed.contentKeyEnvelope };
  }
  return { commentId, bodyCiphertext: body.bodyCiphertext, contentKeyEnvelope: body.contentKeyEnvelope, attribution };
}

function mutationError(status: number, error?: string): never {
  if (status === 404) throw new PublicCommentsNotFoundError();
  if (status === 409) {
    if (error === "key_rotation_required") throw new PublicCommentsSealedError();
    if (error === "pseudonym_update_pending") throw new PublicCommentsPseudonymPendingError();
    throw new PublicCommentsChangedError();
  }
  if (status === 429) throw new PublicCommentsLimitedError();
  throw new Error("Comment could not be saved");
}

async function privateMutation(path: string, method: "POST" | "PATCH" | "DELETE", body: object,
  signal?: AbortSignal): Promise<Response> {
  try {
    const response = await privateRequest(path, { method, body: JSON.stringify(body), signal });
    if (response.ok) return response;
    if (response.status === 403) throw new PublicCommentsSignInError("signed-out");
    mutationError(response.status, (await response.json() as { error?: string }).error);
  } catch (error) {
    if (error instanceof PrivateAccessError) {
      throw new PublicCommentsSignInError(error.state === "unprovisioned" ? "unprovisioned" : "signed-out");
    }
    throw error;
  }
}

async function pseudonymFor(access: RootAccess, needed: boolean): Promise<string | null> {
  return needed ? readPseudonym(access) : null;
}

/** A signed-in link visitor posts through its device-bound Session and the
 * locally held fragment capability; an unprovisioned Session cannot post. */
export async function postLinkPublicComment(thread: PublicThreadView, linkId: string, text: string,
  signal?: AbortSignal): Promise<{ commentId: string }> {
  const epoch = currentEpochOf(thread);
  let pseudonym: string | null = null;
  if (!thread.pseudonyms.has(thread.viewerAccountId ?? "")) {
    try { pseudonym = await readPseudonym(await openRoot()); }
    catch { throw new PublicCommentsSignInError("signed-out"); }
  }
  const sealed = await seal({ capability: epoch.capability, publicationId: thread.publicationId,
    capabilityId: epoch.capabilityId, keyEpoch: epoch.capabilityEpoch, text, pseudonym });
  await privateMutation(`/api/private/comments/links/${linkId}/entries`, "POST", { commentId: sealed.commentId,
    threadId: thread.threadId, epochId: epoch.epochId, capabilityId: epoch.capabilityId,
    capabilityEpoch: epoch.capabilityEpoch, bodyCiphertext: sealed.bodyCiphertext,
    contentKeyEnvelope: sealed.contentKeyEnvelope, attribution: sealed.attribution }, signal);
  return { commentId: sealed.commentId };
}

export async function editLinkPublicComment(thread: PublicThreadView, linkId: string, comment: PublicComment,
  text: string, signal?: AbortSignal): Promise<number> {
  const epoch = epochOf(thread, comment.epochId);
  const revision = comment.revision + 1;
  const sealed = await sealPublicCommentBody(epoch.capability, { publicationId: thread.publicationId,
    commentId: comment.id, capabilityId: epoch.capabilityId, keyEpoch: epoch.capabilityEpoch, revision, text });
  await privateMutation(`/api/private/comments/links/${linkId}/entries/${comment.id}`, "PATCH", {
    threadId: thread.threadId, capabilityId: epoch.capabilityId, capabilityEpoch: epoch.capabilityEpoch,
    epochId: comment.epochId, expectedRevision: comment.revision, bodyCiphertext: sealed.bodyCiphertext,
    contentKeyEnvelope: sealed.contentKeyEnvelope }, signal);
  return revision;
}

export async function deleteLinkPublicComment(thread: PublicThreadView, linkId: string, comment: PublicComment,
  signal?: AbortSignal): Promise<void> {
  const epoch = epochOf(thread, comment.epochId);
  await privateMutation(`/api/private/comments/links/${linkId}/entries/${comment.id}`, "DELETE", {
    threadId: thread.threadId, capabilityId: epoch.capabilityId, capabilityEpoch: epoch.capabilityEpoch,
    epochId: comment.epochId, expectedRevision: comment.revision }, signal);
}

// ---------------------------------------------------------------------------
// Authenticated File route
// ---------------------------------------------------------------------------

type FileThreadWire = { thread: null | { threadId: string; ownerId: string; publicationId: string; fileId: string;
  currentEpochId: string; audience: "public" | "collaborators_only"; actorAccountId: string; canComment: boolean;
  canDeleteAny: boolean; epochs: PublicEpochWire[] };
  canCreateThread?: boolean;
  publication?: { publicationId: string } | null;
  comments?: PublicCommentsWire["comments"]; attributions?: PublicCommentsWire["attributions"]; nextCursor?: number | null };

export type FilePublicComments = { status: "absent"; canCreate: boolean; publicationId: string | null } |
  { status: "ready"; thread: PublicThreadView };

/** Fetch the authenticated Public thread wire; one mapping for every caller. */
async function readFileThread(access: RootAccess, fileId: string, signal?: AbortSignal): Promise<FileThreadWire> {
  const response = await privateRequest(`/api/private/comments/files/${fileId}/public`, { method: "POST", signal });
  if (response.status === 404) throw new PublicCommentsNotFoundError();
  if (response.status === 409) {
    const error = (await response.json() as { error?: string }).error;
    if (error === "secure_access_preparing" || error === "owned_comment_key_missing") throw new PublicCommentsPreparingError();
    throw new PublicCommentsChangedError();
  }
  if (!response.ok) throw new Error("Comments unavailable");
  return await response.json() as FileThreadWire;
}

/** Open every epoch envelope this device can read, without any Comment page. */
async function openFileEpochs(access: RootAccess,
  thread: NonNullable<FileThreadWire["thread"]>): Promise<PublicEpoch[]> {
  const epochs: PublicEpoch[] = [];
  for (const epoch of thread.epochs) {
    const capability = await openWireEnvelope(access, thread.ownerId, epoch);
    epochs.push({ epochId: epoch.epochId, ordinal: epoch.ordinal, audience: epoch.audience, state: epoch.state,
      capabilityId: epoch.capabilityId, capabilityEpoch: epoch.capabilityEpoch, capability });
  }
  return epochs;
}

/** The File route: this device's envelopes for every authorized epoch. */
export async function loadFilePublicComments(access: RootAccess, fileId: string, signal?: AbortSignal): Promise<FilePublicComments> {
  const data = await readFileThread(access, fileId, signal);
  if (!data.thread) return { status: "absent", canCreate: Boolean(data.canCreateThread), publicationId: data.publication?.publicationId ?? null };
  const epochs = await openFileEpochs(access, data.thread);
  const comments = data.comments ?? [], attributions = data.attributions ?? [];
  const decrypted = await decryptPage({ audience: data.thread.audience, threadId: data.thread.threadId,
    epochs: data.thread.epochs, comments, attributions, nextCursor: data.nextCursor ?? null },
    openedEpochs(epochs), data.thread.publicationId);
  return { status: "ready", thread: withViewer({
    threadId: data.thread.threadId, publicationId: data.thread.publicationId, ownerId: data.thread.ownerId,
    fileId, linkId: null, currentEpochId: data.thread.currentEpochId, audience: data.thread.audience,
    viewerAccountId: data.thread.actorAccountId, postingState: "ready", canDeleteAny: data.thread.canDeleteAny,
    epochs, comments: decrypted.comments, pseudonyms: decrypted.pseudonyms, nextCursor: data.nextCursor ?? null },
    data.thread.actorAccountId, data.thread.canDeleteAny) };
}

/** Epoch capabilities for link rotation: only the envelope open, so a rotation
 * can rewrap every public epoch without decrypting any Comment page. */
export async function loadFilePublicEpochs(access: RootAccess, fileId: string, signal?: AbortSignal): Promise<{
  publicationId: string; ownerId: string; epochs: PublicEpoch[];
}> {
  const data = await readFileThread(access, fileId, signal);
  if (!data.thread) throw new PublicCommentsNotFoundError();
  return { publicationId: data.thread.publicationId, ownerId: data.thread.ownerId,
    epochs: await openFileEpochs(access, data.thread) };
}

/** Page more authenticated history with the already-opened epoch capabilities. */
export async function loadMoreFilePublicComments(thread: PublicThreadView, signal?: AbortSignal): Promise<{
  comments: PublicComment[]; pseudonyms: Map<string, string>; nextCursor: number | null }> {
  const response = await privateRequest(`/api/private/comments/files/${thread.fileId}/public?cursor=${thread.nextCursor}`,
    { method: "POST", signal });
  if (!response.ok) throw new PublicCommentsChangedError();
  const data = await response.json() as FileThreadWire;
  const wire: PublicCommentsWire = { audience: thread.audience, threadId: thread.threadId, epochs: [],
    comments: data.comments ?? [], attributions: data.attributions ?? [], nextCursor: data.nextCursor ?? null };
  const decrypted = await decryptPage(wire, openedEpochs(thread.epochs), thread.publicationId);
  const pseudonyms = new Map(thread.pseudonyms);
  for (const [authorId, pseudonym] of decrypted.pseudonyms) pseudonyms.set(authorId, pseudonym);
  return { comments: decrypted.comments, pseudonyms, nextCursor: wire.nextCursor };
}

function epochOf(thread: PublicThreadView, epochId: string): PublicEpoch {
  const epoch = thread.epochs.find((candidate) => candidate.epochId === epochId);
  if (!epoch) throw new PublicCommentsChangedError();
  return epoch;
}

function currentEpochOf(thread: PublicThreadView): PublicEpoch {
  return epochOf(thread, thread.currentEpochId);
}

function fileEntryPath(thread: PublicThreadView, suffix = ""): string {
  return `/api/private/comments/files/${thread.fileId}/public/entries${suffix}`;
}

export async function createFilePublicComment(access: RootAccess, thread: PublicThreadView, text: string,
  signal?: AbortSignal): Promise<{ commentId: string }> {
  const epoch = currentEpochOf(thread);
  const pseudonym = await pseudonymFor(access, !thread.pseudonyms.has(thread.viewerAccountId ?? ""));
  const sealed = await seal({ capability: epoch.capability, publicationId: thread.publicationId,
    capabilityId: epoch.capabilityId, keyEpoch: epoch.capabilityEpoch, text, pseudonym });
  const response = await privateRequest(fileEntryPath(thread), { method: "POST", signal, body: JSON.stringify({
    commentId: sealed.commentId, threadId: thread.threadId, epochId: epoch.epochId, capabilityId: epoch.capabilityId,
    capabilityEpoch: epoch.capabilityEpoch, bodyCiphertext: sealed.bodyCiphertext,
    contentKeyEnvelope: sealed.contentKeyEnvelope, attribution: sealed.attribution }) });
  if (!response.ok) mutationError(response.status, (await response.json() as { error?: string }).error);
  return { commentId: sealed.commentId };
}

export async function editFilePublicComment(thread: PublicThreadView, comment: PublicComment, text: string,
  signal?: AbortSignal): Promise<number> {
  const epoch = epochOf(thread, comment.epochId);
  const revision = comment.revision + 1;
  const sealed = await sealPublicCommentBody(epoch.capability, { publicationId: thread.publicationId,
    commentId: comment.id, capabilityId: epoch.capabilityId, keyEpoch: epoch.capabilityEpoch, revision, text });
  const response = await privateRequest(fileEntryPath(thread, `/${comment.id}`), { method: "PATCH", signal,
    body: JSON.stringify({ threadId: thread.threadId, capabilityId: epoch.capabilityId,
      capabilityEpoch: epoch.capabilityEpoch, epochId: comment.epochId, expectedRevision: comment.revision,
      bodyCiphertext: sealed.bodyCiphertext, contentKeyEnvelope: sealed.contentKeyEnvelope }) });
  if (!response.ok) mutationError(response.status, (await response.json() as { error?: string }).error);
  return revision;
}

export async function deleteFilePublicComment(thread: PublicThreadView, comment: PublicComment, signal?: AbortSignal): Promise<void> {
  const epoch = epochOf(thread, comment.epochId);
  const response = await privateRequest(fileEntryPath(thread, `/${comment.id}`), { method: "DELETE", signal,
    body: JSON.stringify({ threadId: thread.threadId, capabilityId: epoch.capabilityId,
      capabilityEpoch: epoch.capabilityEpoch, epochId: comment.epochId, expectedRevision: comment.revision }) });
  if (!response.ok) mutationError(response.status, (await response.json() as { error?: string }).error);
}
