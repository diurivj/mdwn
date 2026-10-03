import {
  attributionKeyContext,
  attributionContext,
  commentKeyContext,
  commentBodyContext,
  MAX_ATTRIBUTION_BYTES,
  MAX_ATTRIBUTION_KEY_ENVELOPE_BYTES,
  MAX_COMMENT_BODY_BYTES,
  MAX_COMMENT_KEY_ENVELOPE_BYTES,
  sealAttribution,
  sealCommentBody,
} from "~/comments/content";
import { openAccountProfile } from "~/crypto/account-profile";
import { openSymmetric } from "~/crypto/enc-v1";
import { openVaultRecoveryEnvelope, sealVaultRecoveryEnvelope } from "~/crypto/vault";
import { privateRequest } from "~/device/private-client";
import { getDevice } from "~/device/store";
import { newOpaqueId } from "~/opaque-id";
import { openCommentKeyEnvelope, type CommentKeyContext } from "~/sharing/comment-keys";
import type { RootAccess } from "~/tree/client";
import { decodeTreeBytes, encodeTreeBytes } from "~/tree/wire";

const PROFILE_CIPHERTEXT_BYTES = 4_096;

export class CommentsChangedError extends Error {
  constructor() { super("comment_changed"); }
}
export class CommentsNotFoundError extends Error {
  constructor() { super("not_found"); }
}
export class CommentsSealedError extends Error {
  constructor() { super("key_rotation_required"); }
}

export type CommentView = {
  id: string; authorId: string; sequence: number; revision: number;
  text: string | null; createdAt: number; updatedAt: number;
  canEdit: boolean; canDelete: boolean;
};

export type PrivateComments = {
  fileId: string; threadId: string; ownerId: string; epochId: string;
  capabilityId: string; capabilityEpoch: number; capability: Uint8Array<ArrayBuffer>;
  actorAccountId: string; canDeleteAny: boolean; canComment: boolean;
  hasAttribution: boolean; pseudonyms: Map<string, string>;
  comments: CommentView[]; nextCursor: number | null;
};

export type CommentsState =
  | { status: "absent"; canCreate: boolean }
  | { status: "preparing" }
  | { status: "ready"; thread: PrivateComments };

type ThreadResponse = {
  thread: null | {
    threadId: string; fileId: string; ownerId: string; epochId: string; capabilityId: string;
    capabilityEpoch: number; canComment: boolean; canDeleteAny: boolean; actorAccountId: string;
    envelope: { mode: "owned"; keyEpoch: number; ciphertext: string } |
      ({ mode: "grant" } & CommentKeyContext & { deviceId: string; signerDeviceId: string;
        signerPublicKey: string; ciphertext: string; signature: string });
  };
  canCreateThread?: boolean;
  comments?: { id: string; authorId: string; sequence: number; revision: number; bodyCiphertext: string;
    contentKeyEnvelope: string; contentKeyEpoch: number; createdAt: number; updatedAt: number }[];
  attributions?: { id: string; authorId: string; revision: number; ciphertext: string;
    contentKeyEnvelope: string; contentKeyEpoch: number }[];
  nextCursor?: number | null;
};

async function openThreadCapability(access: RootAccess, thread: NonNullable<ThreadResponse["thread"]>) {
  if (thread.envelope.mode === "owned") {
    return openVaultRecoveryEnvelope(decodeTreeBytes(thread.envelope.ciphertext, MAX_COMMENT_KEY_ENVELOPE_BYTES),
      access.actorVaultRootKey, { purpose: "vault-recovery", vaultId: thread.ownerId, objectId: thread.threadId,
        keyId: thread.capabilityId, keyEpoch: thread.capabilityEpoch, revision: 1 });
  }
  const device = await getDevice(access.actorAccountId);
  if (!device) throw new Error("private tree unavailable");
  const envelope = thread.envelope;
  return openCommentKeyEnvelope({ ...envelope, recipient: device.transportKeyPair });
}

async function readPseudonym(access: RootAccess, signal?: AbortSignal): Promise<string> {
  const response = await privateRequest("/api/private/profile", { method: "POST", signal });
  if (!response.ok) throw new Error("Account profile unavailable");
  const profile = await response.json() as { ciphertext: string; epoch: number; revision: number };
  const opened = await openAccountProfile(decodeTreeBytes(profile.ciphertext, PROFILE_CIPHERTEXT_BYTES),
    access.actorVaultRootKey, { accountId: access.actorAccountId, epoch: profile.epoch, revision: profile.revision });
  return opened.publicPseudonym;
}

/** Read the Private thread and decrypt it locally. Plaintext never leaves the browser. */
export async function loadPrivateComments(access: RootAccess, fileId: string, signal?: AbortSignal): Promise<CommentsState> {
  const response = await privateRequest(`/api/private/comments/files/${fileId}`, { method: "POST", signal });
  if (response.status === 404) throw new CommentsNotFoundError();
  if (response.status === 409) {
    const body = await response.json() as { error?: string };
    if (body.error === "secure_access_preparing" || body.error === "owned_comment_key_missing") return { status: "preparing" };
    throw new CommentsChangedError();
  }
  if (!response.ok) throw new Error("Comments unavailable");
  const data = await response.json() as ThreadResponse;
  if (!data.thread) return { status: "absent", canCreate: Boolean(data.canCreateThread) };
  const capability = await openThreadCapability(access, data.thread);
  const pseudonyms = new Map<string, string>();
  for (const attribution of data.attributions ?? []) {
    try {
      pseudonyms.set(attribution.authorId, await openAttributionForDisplay(capability, data.thread, attribution));
    } catch { /* An unreadable pseudonym must not block the rest of the thread. */ }
  }
  const comments: CommentView[] = [];
  for (const comment of data.comments ?? []) {
    let text: string | null = null;
    try {
      const contentKey = await openSymmetric(decodeTreeBytes(comment.contentKeyEnvelope, MAX_COMMENT_KEY_ENVELOPE_BYTES),
        capability, { context: commentKeyContext(data.thread.ownerId, comment.id, data.thread.capabilityId,
          data.thread.capabilityEpoch, comment.revision) });
      const plaintext = await openSymmetric(decodeTreeBytes(comment.bodyCiphertext, MAX_COMMENT_BODY_BYTES), contentKey,
        { context: commentBodyContext(data.thread.ownerId, comment.id, comment.revision) });
      text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } catch { /* Keep the record visible with an explicit display failure. */ }
    comments.push({ id: comment.id, authorId: comment.authorId, sequence: comment.sequence,
      revision: comment.revision, text, createdAt: comment.createdAt, updatedAt: comment.updatedAt,
      canEdit: comment.authorId === access.actorAccountId,
      canDelete: comment.authorId === access.actorAccountId || data.thread.canDeleteAny });
  }
  return { status: "ready", thread: {
    fileId, threadId: data.thread.threadId, ownerId: data.thread.ownerId, epochId: data.thread.epochId,
    capabilityId: data.thread.capabilityId, capabilityEpoch: data.thread.capabilityEpoch, capability,
    actorAccountId: access.actorAccountId, canDeleteAny: data.thread.canDeleteAny,
    canComment: data.thread.canComment, hasAttribution: pseudonyms.has(access.actorAccountId),
    pseudonyms, comments, nextCursor: data.nextCursor ?? null,
  } };
}

async function openAttributionForDisplay(threadKey: Uint8Array, thread: NonNullable<ThreadResponse["thread"]>,
  attribution: NonNullable<ThreadResponse["attributions"]>[number]) {
  const contentKey = await openSymmetric(decodeTreeBytes(attribution.contentKeyEnvelope, MAX_ATTRIBUTION_KEY_ENVELOPE_BYTES),
    threadKey, { context: attributionKeyContext(thread.ownerId, attribution.id, thread.capabilityId,
      thread.capabilityEpoch, attribution.revision) });
  const plaintext = await openSymmetric(decodeTreeBytes(attribution.ciphertext, MAX_ATTRIBUTION_BYTES), contentKey,
    { context: attributionContext(thread.ownerId, attribution.id, attribution.revision) });
  return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
}

/** Owner-only create-once thread; a second call adopts the existing thread. */
export async function createPrivateThread(access: RootAccess, fileId: string, signal?: AbortSignal) {
  if (access.actorAccountId !== access.vaultId) throw new Error("Owner device required");
  const threadId = newOpaqueId(), epochId = newOpaqueId(), capabilityId = newOpaqueId();
  const capability = crypto.getRandomValues(new Uint8Array(32));
  const recoveryEnvelope = await sealVaultRecoveryEnvelope(access.actorVaultRootKey,
    { scope: "owned", objectId: threadId, keyId: capabilityId, key: capability },
    { purpose: "vault-recovery", vaultId: access.actorAccountId, objectId: threadId, keyId: capabilityId, keyEpoch: 1, revision: 1 });
  const response = await privateRequest(`/api/private/comments/files/${fileId}`, { method: "PUT",
    body: JSON.stringify({ threadId, epochId, capabilityId, recoveryEnvelope: encodeTreeBytes(recoveryEnvelope) }), signal });
  if (!response.ok) throw new Error("Comments unavailable");
  return response.json() as Promise<{ threadId: string; created: boolean }>;
}

export async function createPrivateComment(access: RootAccess, thread: PrivateComments,
  text: string, signal?: AbortSignal): Promise<{ commentId: string }> {
  const commentId = newOpaqueId();
  const sealed = await sealCommentBody(thread.capability, { vaultId: thread.ownerId, commentId,
    capabilityId: thread.capabilityId, keyEpoch: thread.capabilityEpoch, revision: 1, text });
  let attribution = null;
  if (!thread.hasAttribution) {
    const attributionId = newOpaqueId();
    const sealedAttribution = await sealAttribution(thread.capability, { vaultId: thread.ownerId, attributionId,
      pseudonym: await readPseudonym(access, signal), capabilityId: thread.capabilityId, keyEpoch: thread.capabilityEpoch });
    attribution = { attributionId, ciphertext: sealedAttribution.ciphertext, contentKeyEnvelope: sealedAttribution.contentKeyEnvelope };
  }
  const response = await privateRequest(`/api/private/comments/files/${thread.fileId}/entries`, { method: "POST",
    body: JSON.stringify({ commentId, threadId: thread.threadId, capabilityId: thread.capabilityId,
      capabilityEpoch: thread.capabilityEpoch, epochId: thread.epochId,
      bodyCiphertext: sealed.bodyCiphertext, contentKeyEnvelope: sealed.contentKeyEnvelope, attribution }), signal });
  if (response.status === 409) {
    const body = await response.json() as { error?: string };
    if (body.error === "key_rotation_required") throw new CommentsSealedError();
    throw new CommentsChangedError();
  }
  if (response.status === 404) throw new CommentsNotFoundError();
  if (!response.ok) throw new Error("Comment could not be saved");
  return { commentId };
}

export async function editPrivateComment(thread: PrivateComments, comment: CommentView,
  text: string, signal?: AbortSignal): Promise<number> {
  const revision = comment.revision + 1;
  const sealed = await sealCommentBody(thread.capability, { vaultId: thread.ownerId, commentId: comment.id,
    capabilityId: thread.capabilityId, keyEpoch: thread.capabilityEpoch, revision, text });
  const response = await privateRequest(`/api/private/comments/files/${thread.fileId}/entries/${comment.id}`,
    { method: "PATCH", body: JSON.stringify({ threadId: thread.threadId, capabilityId: thread.capabilityId,
      capabilityEpoch: thread.capabilityEpoch, epochId: thread.epochId, expectedRevision: comment.revision,
      bodyCiphertext: sealed.bodyCiphertext, contentKeyEnvelope: sealed.contentKeyEnvelope }), signal });
  if (response.status === 409) {
    const body = await response.json() as { error?: string };
    if (body.error === "key_rotation_required") throw new CommentsSealedError();
    throw new CommentsChangedError();
  }
  if (response.status === 404) throw new CommentsNotFoundError();
  if (!response.ok) throw new Error("Comment could not be saved");
  return revision;
}

export async function deletePrivateComment(thread: PrivateComments, comment: CommentView, signal?: AbortSignal): Promise<void> {
  const response = await privateRequest(`/api/private/comments/files/${thread.fileId}/entries/${comment.id}`,
    { method: "DELETE", body: JSON.stringify({ threadId: thread.threadId, capabilityId: thread.capabilityId,
      capabilityEpoch: thread.capabilityEpoch, epochId: thread.epochId, expectedRevision: comment.revision }), signal });
  if (response.status === 409) throw new CommentsChangedError();
  if (response.status === 404) throw new CommentsNotFoundError();
  if (!response.ok) throw new Error("Comment could not be deleted");
}
