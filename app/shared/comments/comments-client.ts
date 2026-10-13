import {
  MAX_COMMENT_KEY_ENVELOPE_BYTES,
  openAttribution,
  openCommentRecord,
  sealAttribution,
  sealCommentBody,
  threadCapabilityContext,
} from "~/shared/comments/content";
import { openSymmetric } from "~/shared/crypto/enc-v1";
import { readPseudonym } from "~/shared/account/profile-client";
import { openVaultRecoveryEnvelope, sealVaultRecoveryEnvelope } from "~/shared/crypto/vault";
import { privateRequest } from "~/shared/device/private-client";
import { getDevice } from "~/shared/device/store";
import { newOpaqueId } from "~/shared/opaque-id";
import { openCommentKeyEnvelope, type CommentKeyContext } from "~/shared/sharing/comment-keys";
import type { RootAccess } from "~/shared/tree/client";
import { decodeTreeBytes, encodeTreeBytes } from "~/shared/tree/wire";

const COMMENT_PAGE_BATCH = 10;

export class CommentsChangedError extends Error {
  constructor() {
    super("comment_changed");
  }
}
export class CommentsNotFoundError extends Error {
  constructor() {
    super("not_found");
  }
}
export class CommentsSealedError extends Error {
  constructor() {
    super("key_rotation_required");
  }
}
export class PseudonymUpdatePendingError extends Error {
  constructor() {
    super("pseudonym_update_pending");
  }
}

export type CommentView = {
  id: string;
  authorId: string;
  sequence: number;
  revision: number;
  text: string | null;
  createdAt: number;
  updatedAt: number;
  canEdit: boolean;
  canDelete: boolean;
};

export type PrivateComments = {
  fileId: string;
  threadId: string;
  ownerId: string;
  epochId: string;
  capabilityId: string;
  capabilityEpoch: number;
  capability: Uint8Array<ArrayBuffer>;
  actorAccountId: string;
  canDeleteAny: boolean;
  canComment: boolean;
  hasAttribution: boolean;
  pseudonyms: Map<string, string>;
  comments: CommentView[];
  nextCursor: number | null;
};

export type CommentsState =
  | { status: "absent"; canCreate: boolean }
  | { status: "preparing" }
  | { status: "ready"; thread: PrivateComments };

type ThreadMeta = {
  fileId: string;
  threadId: string;
  ownerId: string;
  epochId: string;
  capabilityId: string;
  capabilityEpoch: number;
  canComment: boolean;
  canDeleteAny: boolean;
  actorAccountId: string;
  envelope:
    | { mode: "owned"; keyEpoch: number; ciphertext: string }
    | { mode: "import"; keyEpoch: number; ciphertext: string }
    | ({ mode: "grant" } & CommentKeyContext & {
          deviceId: string;
          signerDeviceId: string;
          signerPublicKey: string;
          ciphertext: string;
          signature: string;
        });
};
type ThreadResponse = {
  thread: ThreadMeta | null;
  canCreateThread?: boolean;
  comments?: {
    id: string;
    authorId: string;
    sequence: number;
    revision: number;
    bodyCiphertext: string;
    contentKeyEnvelope: string;
    metaCiphertext?: string | null;
    contentKeyEpoch: number;
    createdAt: number;
    updatedAt: number;
  }[];
  attributions?: {
    id: string;
    authorId: string;
    revision: number;
    ciphertext: string;
    contentKeyEnvelope: string;
    contentKeyEpoch: number;
  }[];
  nextCursor?: number | null;
};

/**
 * An imported Historical thread's capability is wrapped under its File's
 * capability key. The Comments view and share preparation both open it here.
 */
export function openImportedThreadCapability(
  ciphertext: string,
  fileCapabilityKey: Uint8Array,
  thread: { ownerId: string; threadId: string; capabilityId: string; capabilityEpoch: number },
) {
  return openSymmetric(decodeTreeBytes(ciphertext, MAX_COMMENT_KEY_ENVELOPE_BYTES), fileCapabilityKey, {
    context: threadCapabilityContext(thread.ownerId, thread.threadId, thread.capabilityId, thread.capabilityEpoch),
  });
}

async function openThreadCapability(access: RootAccess, thread: ThreadMeta, fileCapabilityKey?: Uint8Array | null) {
  if (thread.envelope.mode === "owned") {
    return openVaultRecoveryEnvelope(
      decodeTreeBytes(thread.envelope.ciphertext, MAX_COMMENT_KEY_ENVELOPE_BYTES),
      access.actorVaultRootKey,
      {
        purpose: "vault-recovery",
        vaultId: thread.ownerId,
        objectId: thread.threadId,
        keyId: thread.capabilityId,
        keyEpoch: thread.capabilityEpoch,
        revision: 1,
      },
    );
  }
  if (thread.envelope.mode === "import") {
    if (!fileCapabilityKey) throw new Error("private content key unavailable");
    return openImportedThreadCapability(thread.envelope.ciphertext, fileCapabilityKey, thread);
  }
  const device = await getDevice(access.actorAccountId);
  if (!device) throw new Error("private tree unavailable");
  return openCommentKeyEnvelope({ ...thread.envelope, recipient: device.transportKeyPair });
}

async function fetchPage(fileId: string, cursor: number | null, signal?: AbortSignal): Promise<Response> {
  return privateRequest(`/api/private/comments/files/${fileId}${cursor === null ? "" : `?cursor=${cursor}`}`, {
    method: "POST",
    signal,
  });
}

/** Decrypt one page locally. An unreadable record stays visible without text. */
async function decryptPage(thread: ThreadMeta, capability: Uint8Array, data: ThreadResponse) {
  const pseudonyms = new Map<string, string>();
  for (const attribution of data.attributions ?? []) {
    try {
      pseudonyms.set(
        attribution.authorId,
        await openAttribution(capability, {
          vaultId: thread.ownerId,
          attributionId: attribution.id,
          revision: attribution.revision,
          capabilityId: thread.capabilityId,
          keyEpoch: thread.capabilityEpoch,
          ciphertext: attribution.ciphertext,
          contentKeyEnvelope: attribution.contentKeyEnvelope,
        }),
      );
    } catch {
      /* An unreadable pseudonym must not block the rest of the thread. */
    }
  }
  const comments: CommentView[] = [];
  for (const comment of data.comments ?? []) {
    let text: string | null = null;
    let meta: { createdAt: number; updatedAt: number } | null = null;
    try {
      const opened = await openCommentRecord(capability, {
        vaultId: thread.ownerId,
        commentId: comment.id,
        revision: comment.revision,
        capabilityId: thread.capabilityId,
        keyEpoch: thread.capabilityEpoch,
        bodyCiphertext: comment.bodyCiphertext,
        contentKeyEnvelope: comment.contentKeyEnvelope,
        metaCiphertext: comment.metaCiphertext,
      });
      text = opened.text;
      meta = opened.meta;
    } catch {
      /* Keep the record visible with an explicit display failure. */
    }
    comments.push({
      id: comment.id,
      authorId: comment.authorId,
      sequence: comment.sequence,
      revision: comment.revision,
      text,
      createdAt: meta?.createdAt ?? comment.createdAt,
      updatedAt: meta?.updatedAt ?? comment.updatedAt,
      canEdit: comment.authorId === thread.actorAccountId,
      canDelete: comment.authorId === thread.actorAccountId || thread.canDeleteAny,
    });
  }
  return { comments, pseudonyms };
}

/** Read the Private thread and decrypt it locally. Plaintext never leaves the
 * browser. Up to ten bounded pages load per pass; the rest continue on demand. */
export async function loadPrivateComments(
  access: RootAccess,
  fileId: string,
  signal?: AbortSignal,
  fileCapabilityKey?: Uint8Array | null,
): Promise<CommentsState> {
  const response = await fetchPage(fileId, null, signal);
  if (response.status === 404) throw new CommentsNotFoundError();
  if (response.status === 409) {
    const body = (await response.json()) as { error?: string };
    if (body.error === "secure_access_preparing" || body.error === "owned_comment_key_missing")
      return { status: "preparing" };
    throw new CommentsChangedError();
  }
  if (!response.ok) throw new Error("Comments unavailable");
  const data = (await response.json()) as ThreadResponse;
  if (!data.thread) return { status: "absent", canCreate: Boolean(data.canCreateThread) };
  const capability = await openThreadCapability(access, data.thread, fileCapabilityKey);
  const comments: CommentView[] = [];
  const pseudonyms = new Map<string, string>();
  let page = data,
    cursor = data.nextCursor ?? null;
  for (let index = 0; index < COMMENT_PAGE_BATCH; index++) {
    const decrypted = await decryptPage(data.thread, capability, page);
    comments.push(...decrypted.comments);
    for (const [authorId, pseudonym] of decrypted.pseudonyms) pseudonyms.set(authorId, pseudonym);
    // Stop before fetching a page this pass will not consume, so the returned
    // cursor always names the last displayed Comment.
    if (cursor === null || index === COMMENT_PAGE_BATCH - 1) break;
    const next = await fetchPage(fileId, cursor, signal);
    if (!next.ok) break;
    page = (await next.json()) as ThreadResponse;
    cursor = page.nextCursor ?? null;
  }
  return {
    status: "ready",
    thread: {
      fileId,
      threadId: data.thread.threadId,
      ownerId: data.thread.ownerId,
      epochId: data.thread.epochId,
      capabilityId: data.thread.capabilityId,
      capabilityEpoch: data.thread.capabilityEpoch,
      capability,
      actorAccountId: access.actorAccountId,
      canDeleteAny: data.thread.canDeleteAny,
      canComment: data.thread.canComment,
      hasAttribution: pseudonyms.has(access.actorAccountId),
      pseudonyms,
      comments,
      nextCursor: cursor,
    },
  };
}

/** Owner-side upkeep: a File the Owner opens always has its one Private
 * thread, so a Collaborator never waits for the Comments inspector. */
export async function ensurePrivateThread(access: RootAccess, fileId: string, signal?: AbortSignal): Promise<boolean> {
  if (access.actorAccountId !== access.vaultId) return false;
  const response = await privateRequest(`/api/private/comments/files/${fileId}?probe=1`, { method: "POST", signal });
  if (!response.ok) return false;
  const probe = (await response.json()) as { thread: { threadId: string } | null; canCreateThread?: boolean };
  if (probe.thread || !probe.canCreateThread) return false;
  await createPrivateThread(access, fileId, signal);
  return true;
}

/** Continue the same flat ordered list with the already-opened capability. */
export async function loadMorePrivateComments(
  thread: PrivateComments,
  signal?: AbortSignal,
): Promise<{
  comments: CommentView[];
  pseudonyms: Map<string, string>;
  nextCursor: number | null;
}> {
  const comments: CommentView[] = [];
  const pseudonyms = new Map(thread.pseudonyms);
  let cursor = thread.nextCursor;
  const meta: ThreadMeta = {
    fileId: thread.fileId,
    threadId: thread.threadId,
    ownerId: thread.ownerId,
    epochId: thread.epochId,
    capabilityId: thread.capabilityId,
    capabilityEpoch: thread.capabilityEpoch,
    canComment: thread.canComment,
    canDeleteAny: thread.canDeleteAny,
    actorAccountId: thread.actorAccountId,
    envelope: { mode: "owned", keyEpoch: thread.capabilityEpoch, ciphertext: "" },
  };
  for (let index = 0; index < COMMENT_PAGE_BATCH && cursor !== null; index++) {
    const response = await fetchPage(thread.fileId, cursor, signal);
    if (!response.ok) throw new CommentsChangedError();
    const page = (await response.json()) as ThreadResponse;
    const decrypted = await decryptPage(meta, thread.capability, page);
    comments.push(...decrypted.comments);
    for (const [authorId, pseudonym] of decrypted.pseudonyms) pseudonyms.set(authorId, pseudonym);
    cursor = page.nextCursor ?? null;
  }
  return { comments, pseudonyms, nextCursor: cursor };
}

/**
 * Load every page of a File's Private thread after the first read. Returns
 * `complete: false` when the thread is still provisioning, so a caller such
 * as export can report that Comment history was not fully readable instead of
 * silently dropping it.
 */
export async function loadAllPrivateComments(
  access: RootAccess,
  fileId: string,
  signal?: AbortSignal,
  fileCapabilityKey?: Uint8Array | null,
): Promise<{
  comments: CommentView[];
  pseudonyms: Map<string, string>;
  complete: boolean;
}> {
  const state = await loadPrivateComments(access, fileId, signal, fileCapabilityKey);
  if (state.status === "absent") return { comments: [], pseudonyms: new Map(), complete: true };
  if (state.status === "preparing") return { comments: [], pseudonyms: new Map(), complete: false };
  const thread = state.thread;
  let comments = thread.comments.slice();
  let pseudonyms = new Map(thread.pseudonyms);
  let cursor = thread.nextCursor;
  const seen = new Set<number>();
  while (cursor !== null) {
    if (seen.has(cursor)) throw new CommentsChangedError();
    seen.add(cursor);
    const page = await loadMorePrivateComments({ ...thread, comments, pseudonyms, nextCursor: cursor }, signal);
    comments = comments.concat(page.comments);
    pseudonyms = page.pseudonyms;
    cursor = page.nextCursor;
  }
  return { comments, pseudonyms, complete: true };
}

/** Owner-only create-once thread; a second call adopts the existing thread. */
export async function createPrivateThread(access: RootAccess, fileId: string, signal?: AbortSignal) {
  if (access.actorAccountId !== access.vaultId) throw new Error("Owner device required");
  const threadId = newOpaqueId(),
    epochId = newOpaqueId(),
    capabilityId = newOpaqueId();
  const capability = crypto.getRandomValues(new Uint8Array(32));
  const recoveryEnvelope = await sealVaultRecoveryEnvelope(
    access.actorVaultRootKey,
    { scope: "owned", objectId: threadId, keyId: capabilityId, key: capability },
    {
      purpose: "vault-recovery",
      vaultId: access.actorAccountId,
      objectId: threadId,
      keyId: capabilityId,
      keyEpoch: 1,
      revision: 1,
    },
  );
  const response = await privateRequest(`/api/private/comments/files/${fileId}`, {
    method: "PUT",
    body: JSON.stringify({ threadId, epochId, capabilityId, recoveryEnvelope: encodeTreeBytes(recoveryEnvelope) }),
    signal,
  });
  if (!response.ok) throw new Error("Comments unavailable");
  return response.json() as Promise<{ threadId: string; created: boolean }>;
}

export async function createPrivateComment(
  access: RootAccess,
  thread: PrivateComments,
  text: string,
  signal?: AbortSignal,
): Promise<{ commentId: string }> {
  const commentId = newOpaqueId();
  const sealed = await sealCommentBody(thread.capability, {
    vaultId: thread.ownerId,
    commentId,
    capabilityId: thread.capabilityId,
    keyEpoch: thread.capabilityEpoch,
    revision: 1,
    text,
  });
  let attribution = null;
  if (!thread.hasAttribution) {
    const attributionId = newOpaqueId();
    const sealedAttribution = await sealAttribution(thread.capability, {
      vaultId: thread.ownerId,
      attributionId,
      pseudonym: await readPseudonym(access, signal),
      capabilityId: thread.capabilityId,
      keyEpoch: thread.capabilityEpoch,
    });
    attribution = {
      attributionId,
      ciphertext: sealedAttribution.ciphertext,
      contentKeyEnvelope: sealedAttribution.contentKeyEnvelope,
    };
  }
  const response = await privateRequest(`/api/private/comments/files/${thread.fileId}/entries`, {
    method: "POST",
    body: JSON.stringify({
      commentId,
      threadId: thread.threadId,
      capabilityId: thread.capabilityId,
      capabilityEpoch: thread.capabilityEpoch,
      epochId: thread.epochId,
      bodyCiphertext: sealed.bodyCiphertext,
      contentKeyEnvelope: sealed.contentKeyEnvelope,
      attribution,
    }),
    signal,
  });
  if (response.status === 409) {
    const body = (await response.json()) as { error?: string };
    if (body.error === "key_rotation_required") throw new CommentsSealedError();
    if (body.error === "pseudonym_update_pending") throw new PseudonymUpdatePendingError();
    throw new CommentsChangedError();
  }
  if (response.status === 404) throw new CommentsNotFoundError();
  if (!response.ok) throw new Error("Comment could not be saved");
  return { commentId };
}

export async function editPrivateComment(
  thread: PrivateComments,
  comment: CommentView,
  text: string,
  signal?: AbortSignal,
): Promise<number> {
  const revision = comment.revision + 1;
  const sealed = await sealCommentBody(thread.capability, {
    vaultId: thread.ownerId,
    commentId: comment.id,
    capabilityId: thread.capabilityId,
    keyEpoch: thread.capabilityEpoch,
    revision,
    text,
  });
  const response = await privateRequest(`/api/private/comments/files/${thread.fileId}/entries/${comment.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      threadId: thread.threadId,
      capabilityId: thread.capabilityId,
      capabilityEpoch: thread.capabilityEpoch,
      epochId: thread.epochId,
      expectedRevision: comment.revision,
      bodyCiphertext: sealed.bodyCiphertext,
      contentKeyEnvelope: sealed.contentKeyEnvelope,
    }),
    signal,
  });
  if (response.status === 409) {
    const body = (await response.json()) as { error?: string };
    if (body.error === "key_rotation_required") throw new CommentsSealedError();
    throw new CommentsChangedError();
  }
  if (response.status === 404) throw new CommentsNotFoundError();
  if (!response.ok) throw new Error("Comment could not be saved");
  return revision;
}

export async function deletePrivateComment(
  thread: PrivateComments,
  comment: CommentView,
  signal?: AbortSignal,
): Promise<void> {
  const response = await privateRequest(`/api/private/comments/files/${thread.fileId}/entries/${comment.id}`, {
    method: "DELETE",
    body: JSON.stringify({
      threadId: thread.threadId,
      capabilityId: thread.capabilityId,
      capabilityEpoch: thread.capabilityEpoch,
      epochId: thread.epochId,
      expectedRevision: comment.revision,
    }),
    signal,
  });
  if (response.status === 409) throw new CommentsChangedError();
  if (response.status === 404) throw new CommentsNotFoundError();
  if (!response.ok) throw new Error("Comment could not be deleted");
}
