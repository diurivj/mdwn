import { openAccountProfile } from "~/crypto/account-profile";
import { openDeviceEnrollmentEnvelope, openVaultRecoveryEnvelope } from "~/crypto/vault";
import { privateRequest } from "~/device/private-client";
import { getDevice } from "~/device/store";
import { newOpaqueId } from "~/opaque-id";
import { decodeTreeBytes, encodeTreeBytes } from "~/tree/wire";
import { generateThreadKey, openAttribution, openComment, openPreviousThreadKey, openThreadKeyFromDevice,
  openThreadKeyFromReceiving, sealAttribution, sealComment, sealThreadKeyToDevice, sealThreadKeyToReceiving,
  type ThreadKeyIdentity } from "./crypto";

/**
 * Who is reading: a parent-capability reader holds the File receiving key pair
 * (verified against the signed File head); a direct File reader holds only its
 * own device keys. Both come from an already verified File load.
 */
export type ThreadSubject = { ownerId: string; fileId: string; actorAccountId: string;
  receivingKeyId: string; receivingEpoch: number; receivingPublicKey: Uint8Array;
  receiving?: CryptoKeyPair };

export class CommentsUnavailableError extends Error {
  constructor(readonly code: "not_found" | "thread_changed" | "file_changed" | "rotation_pending" | "unavailable") {
    super(code);
  }
}

type WireDevice = { accountId: string; deviceId: string; registryEpoch: number; publicKey: string;
  grants: { id: string; generation: number }[]; provisioned: boolean };
type WireThread = { ownerId: string; fileId: string; legacy: boolean; canDeleteAny?: boolean;
  receivingKeyId?: string; receivingEpoch?: number; nextCursor: string | null;
  thread: null | { threadId: string; epoch: number; deviceEnvelope: string | null;
    epochs: { epoch: number; keyId: string; receivingKeyId: string; receivingEpoch: number;
      receivingWrapper?: string; previousWrapper: string | null }[] };
  comments: { commentId: string; authorId: string; epoch: number; revision: number; ciphertext: string;
    createdAt: number; updatedAt: number }[];
  attributions: { accountId: string; epoch: number; revision: number; ciphertext: string }[];
  directDevices: WireDevice[] };

export type LoadedComment = { commentId: string; authorId: string; text: string; pseudonym: string | null;
  revision: number; createdAt: number; updatedAt: number; own: boolean };
export type LoadedThread =
  | { status: "legacy" | "provisioning"; comments: [] }
  | { status: "empty"; canDeleteAny: boolean; directDevices: WireDevice[]; comments: [] }
  | { status: "ready"; threadId: string; epoch: number; keyId: string; key: Uint8Array;
      canDeleteAny: boolean; attribution: { epoch: number; revision: number } | null;
      directDevices: WireDevice[]; comments: LoadedComment[]; nextCursor: string | null };

async function request<T>(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body?: object): Promise<T> {
  const response = await privateRequest(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.status === 404) throw new CommentsUnavailableError("not_found");
  if (response.status === 409) {
    const error = await response.json().catch(() => null) as { error?: string } | null;
    throw new CommentsUnavailableError(error?.error === "rotation_pending" ? "rotation_pending" :
      error?.error === "file_changed" ? "file_changed" : "thread_changed");
  }
  if (!response.ok) throw new CommentsUnavailableError("unavailable");
  return response.json() as Promise<T>;
}

async function deviceKeys(accountId: string) {
  const device = await getDevice(accountId);
  if (!device) throw new CommentsUnavailableError("unavailable");
  return device;
}

async function importDeviceKey(publicKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", decodeTreeBytes(publicKey, 65), { name: "ECDH", namedCurve: "P-256" }, false, []);
}

/** Loads and decrypts one page of the Private thread, opening older epoch keys through the chain. */
export async function loadPrivateThread(subject: ThreadSubject, signal?: AbortSignal): Promise<LoadedThread> {
  const response = await privateRequest(`/api/private/comments/files/${subject.fileId}`, { method: "POST", signal });
  if (response.status === 404) throw new CommentsUnavailableError("not_found");
  if (!response.ok) throw new CommentsUnavailableError("unavailable");
  const wire = await response.json() as WireThread;
  if (wire.fileId !== subject.fileId || wire.ownerId !== subject.ownerId) throw new CommentsUnavailableError("unavailable");
  if (wire.legacy) return { status: "legacy", comments: [] };
  if (wire.receivingKeyId !== subject.receivingKeyId || wire.receivingEpoch !== subject.receivingEpoch) {
    throw new CommentsUnavailableError("file_changed");
  }
  if (!wire.thread) return { status: "empty", canDeleteAny: wire.canDeleteAny === true,
    directDevices: wire.directDevices, comments: [] };
  const thread = wire.thread;
  const epochs = new Map(thread.epochs.map((item) => [item.epoch, item]));
  const current = epochs.get(thread.epoch);
  if (!current || thread.epochs.length !== thread.epoch) throw new CommentsUnavailableError("unavailable");
  const identity = (epoch: number): ThreadKeyIdentity => ({ ownerId: subject.ownerId, threadId: thread.threadId,
    keyId: epochs.get(epoch)!.keyId, epoch });
  let currentKey: Uint8Array;
  if (subject.receiving) {
    if (!current.receivingWrapper || current.receivingKeyId !== subject.receivingKeyId) {
      throw new CommentsUnavailableError("file_changed");
    }
    currentKey = await openThreadKeyFromReceiving(decodeTreeBytes(current.receivingWrapper, 4096), subject.receiving,
      { ...identity(thread.epoch), receivingKeyId: subject.receivingKeyId });
  } else {
    if (!thread.deviceEnvelope) return { status: "provisioning", comments: [] };
    const device = await deviceKeys(subject.actorAccountId);
    currentKey = await openThreadKeyFromDevice(decodeTreeBytes(thread.deviceEnvelope, 4096), device.transportKeyPair,
      { ...identity(thread.epoch), deviceId: device.deviceId });
  }
  const keys = new Map<number, Uint8Array>([[thread.epoch, currentKey]]);
  for (let epoch = thread.epoch; epoch > 1; epoch--) {
    const previous = epochs.get(epoch)?.previousWrapper;
    if (!previous || !epochs.get(epoch - 1)) throw new CommentsUnavailableError("unavailable");
    keys.set(epoch - 1, await openPreviousThreadKey(decodeTreeBytes(previous, 4096), keys.get(epoch)!, identity(epoch - 1)));
  }
  const pseudonyms = new Map<string, string>();
  let attribution: { epoch: number; revision: number } | null = null;
  for (const item of wire.attributions) {
    const itemKey = keys.get(item.epoch);
    if (!itemKey) continue;
    try {
      pseudonyms.set(item.accountId, await openAttribution(decodeTreeBytes(item.ciphertext, 2048), itemKey, {
        ownerId: subject.ownerId, accountId: item.accountId, keyId: identity(item.epoch).keyId,
        epoch: item.epoch, revision: item.revision }));
      if (item.accountId === subject.actorAccountId) attribution = { epoch: item.epoch, revision: item.revision };
    } catch { /* An unreadable declaration shows no pseudonym rather than a wrong one. */ }
  }
  const comments = await Promise.all(wire.comments.map(async (item): Promise<LoadedComment> => {
    const itemKey = keys.get(item.epoch);
    if (!itemKey) throw new CommentsUnavailableError("unavailable");
    const text = await openComment(decodeTreeBytes(item.ciphertext, 9216), itemKey, { ownerId: subject.ownerId,
      commentId: item.commentId, keyId: identity(item.epoch).keyId, epoch: item.epoch, revision: item.revision,
      authorId: item.authorId });
    return { commentId: item.commentId, authorId: item.authorId, text, pseudonym: pseudonyms.get(item.authorId) ?? null,
      revision: item.revision, createdAt: item.createdAt, updatedAt: item.updatedAt,
      own: item.authorId === subject.actorAccountId };
  }));
  return { status: "ready", threadId: thread.threadId, epoch: thread.epoch, keyId: current.keyId, key: currentKey,
    canDeleteAny: wire.canDeleteAny === true, attribution, directDevices: wire.directDevices, comments,
    nextCursor: wire.nextCursor };
}

/** Creates the one Private thread: hierarchy wrapper plus every current direct-reader device. */
export async function createPrivateThread(subject: ThreadSubject, directDevices: readonly WireDevice[]): Promise<void> {
  const threadId = newOpaqueId(), keyId = newOpaqueId(), threadKey = generateThreadKey();
  try {
    const identity = { ownerId: subject.ownerId, threadId, keyId, epoch: 1 };
    const target = await crypto.subtle.importKey("raw", new Uint8Array(subject.receivingPublicKey),
      { name: "ECDH", namedCurve: "P-256" }, false, []);
    const receivingWrapper = await sealThreadKeyToReceiving(threadKey, target,
      { ...identity, receivingKeyId: subject.receivingKeyId });
    const deviceEnvelopes = await Promise.all(directDevices.map(async (device) => ({ deviceId: device.deviceId,
      ciphertext: encodeTreeBytes(await sealThreadKeyToDevice(threadKey, await importDeviceKey(device.publicKey),
        { ...identity, deviceId: device.deviceId })) })));
    await request(`/api/private/comments/files/${subject.fileId}/thread`, "PUT", { threadId, keyId,
      receivingKeyId: subject.receivingKeyId, receivingEpoch: subject.receivingEpoch,
      receivingWrapper: encodeTreeBytes(receivingWrapper), deviceEnvelopes });
  } finally { threadKey.fill(0); }
}

/** An already authorized reader envelopes the current key to direct devices still waiting for it. */
export async function provisionThreadDevices(subject: ThreadSubject,
  thread: Extract<LoadedThread, { status: "ready" }>): Promise<number> {
  const missing = thread.directDevices.filter((device) => !device.provisioned);
  if (!missing.length) return 0;
  const identity = { ownerId: subject.ownerId, threadId: thread.threadId, keyId: thread.keyId, epoch: thread.epoch };
  const deviceEnvelopes = await Promise.all(missing.map(async (device) => ({ deviceId: device.deviceId,
    ciphertext: encodeTreeBytes(await sealThreadKeyToDevice(thread.key, await importDeviceKey(device.publicKey),
      { ...identity, deviceId: device.deviceId })) })));
  const result = await request<{ provisioned: number }>(`/api/private/comments/files/${subject.fileId}/thread/devices`,
    "PATCH", { threadId: thread.threadId, epoch: thread.epoch, deviceEnvelopes });
  return result.provisioned;
}

/** The caller's own Public pseudonym, opened with its Vault root; it never leaves the browser in plaintext. */
export async function loadOwnPseudonym(actorAccountId: string): Promise<string> {
  const device = await deviceKeys(actorAccountId);
  const response = await privateRequest("/api/private/bootstrap", { method: "POST" });
  if (!response.ok) throw new CommentsUnavailableError("unavailable");
  const bootstrap = await response.json() as { rootDirectoryId: string; rootRecoveryEnvelope: string;
    enrollmentEnvelope: string; encryptedProfile: string; profileEpoch: number; profileRevision: number };
  const vaultRoot = await openDeviceEnrollmentEnvelope(decodeTreeBytes(bootstrap.enrollmentEnvelope),
    device.transportKeyPair, { purpose: "device-enrollment", vaultId: actorAccountId, objectId: device.deviceId,
      keyId: device.deviceId, keyEpoch: 1, revision: 1, recipientId: device.deviceId });
  try {
    // The root envelope proves this Vault root is current before it opens the profile.
    await openVaultRecoveryEnvelope(decodeTreeBytes(bootstrap.rootRecoveryEnvelope), vaultRoot,
      { purpose: "vault-recovery", vaultId: actorAccountId, objectId: bootstrap.rootDirectoryId,
        keyId: bootstrap.rootDirectoryId, keyEpoch: 1, revision: 1 });
    const profile = await openAccountProfile(decodeTreeBytes(bootstrap.encryptedProfile, 8192), vaultRoot,
      { accountId: actorAccountId, epoch: bootstrap.profileEpoch, revision: bootstrap.profileRevision });
    return profile.publicPseudonym;
  } finally { vaultRoot.fill(0); }
}

async function attributionFor(subject: ThreadSubject, thread: Extract<LoadedThread, { status: "ready" }>) {
  if (thread.attribution?.epoch === thread.epoch) return null;
  const revision = (thread.attribution?.revision ?? 0) + 1;
  const ciphertext = await sealAttribution(thread.key, { ownerId: subject.ownerId, accountId: subject.actorAccountId,
    keyId: thread.keyId, epoch: thread.epoch, revision, pseudonym: await loadOwnPseudonym(subject.actorAccountId) });
  return { revision, ciphertext: encodeTreeBytes(ciphertext) };
}

export async function postPrivateComment(subject: ThreadSubject, thread: Extract<LoadedThread, { status: "ready" }>,
  text: string): Promise<void> {
  const commentId = newOpaqueId();
  const ciphertext = await sealComment(thread.key, { ownerId: subject.ownerId, commentId, keyId: thread.keyId,
    epoch: thread.epoch, revision: 1, authorId: subject.actorAccountId, text });
  await request(`/api/private/comments/files/${subject.fileId}/comments`, "PUT", { commentId,
    threadId: thread.threadId, epoch: thread.epoch, ciphertext: encodeTreeBytes(ciphertext),
    attribution: await attributionFor(subject, thread) });
}

export async function editPrivateComment(subject: ThreadSubject, thread: Extract<LoadedThread, { status: "ready" }>,
  comment: LoadedComment, text: string): Promise<void> {
  if (!comment.own) throw new CommentsUnavailableError("not_found");
  const ciphertext = await sealComment(thread.key, { ownerId: subject.ownerId, commentId: comment.commentId,
    keyId: thread.keyId, epoch: thread.epoch, revision: comment.revision + 1, authorId: subject.actorAccountId, text });
  await request(`/api/private/comments/comments/${comment.commentId}`, "PATCH", {
    expectedRevision: comment.revision, epoch: thread.epoch, ciphertext: encodeTreeBytes(ciphertext),
    attribution: await attributionFor(subject, thread) });
}

export async function deletePrivateComment(commentId: string): Promise<void> {
  await request(`/api/private/comments/comments/${commentId}`, "DELETE");
}
