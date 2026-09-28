import { CommentsUnavailableError, loadThreadKeySource, prepareThreadRotation,
  type ThreadKeySource } from "~/comments/client";
import { createSymmetricWriter, inspectEnvelope, openSymmetric, sealToRecipient } from "~/crypto/enc-v1";
import { createFileReceivingKey, openFileContentKeyFromReceiving, openFileReceivingKey } from "~/crypto/file-receiving";
import { privateRequest } from "~/device/private-client";
import { getDevice } from "~/device/store";
import { newOpaqueId } from "~/opaque-id";
import { isSignupRecoveryConfirmationPending, RecoveryConfirmationPendingError } from "~/signup/recovery-gate";
import {
  authenticateFileHead, encryptedEntry, nameAgainstNamespace, rememberListing, TreeCommitUncertainError,
  TreeNotFoundError, NamespaceChangedError,
  type DirectoryListing, type FileHeadWire, type RootAccess, type TreeEntry,
} from "./client";
import { signFileHead, verifyFileParentEnvelope, verifyFileReceivingTarget } from "./file-head";
import { createListingHead, type ListingHead, type ListingVersion, type SealedEntry } from "./listing";
import { decodeTreeBytes, encodeTreeBytes } from "./wire";

/** A decrypted, verified Directory listing and the capability that opened it. */
export type DirectoryState = { listing: DirectoryListing; key: Uint8Array };
/** The browser's own active device; its non-extractable key signs listings and File heads. */
export type StructureSigner = { deviceId: string; assertionKey: CryptoKey };
/** Current v2 File material a parent-capability holder reads before a move rotation. */
export type FileRotationSource = { fileHead: FileHeadWire; parentEnvelope: string; receivingPublicKey: string;
  revision: number; contentKeyId: string; keyEpoch: number };

/** Nameless structural refusals; the browser explains them without echoing a name. */
export type StructureRefusal = "subtree_limit_exceeded" | "move_leaves_shared_scope" | "rotation_pending" | "file_changed";
export class TreeStructureError extends Error {
  constructor(readonly code: StructureRefusal) { super(code); }
}

const LOWEST = 0x20, HIGHEST = 0x7f;
/**
 * A printable-ASCII key strictly between two sibling order keys (either may be open).
 * Keys compare as JavaScript strings, exactly as `loadDirectory` sorts them; existing
 * opaque UUIDv7 orders stay valid and never need rewriting.
 */
export function orderBetween(lower = "", upper?: string): string {
  if (upper !== undefined && !(lower < upper)) throw new Error("invalid order bounds");
  let prefix = "";
  let bound = upper;
  for (let index = 0; index < 256; index++) {
    const low = index < lower.length ? lower.charCodeAt(index) : LOWEST;
    const high = bound !== undefined && index < bound.length ? bound.charCodeAt(index) : HIGHEST;
    if (low > HIGHEST || high > HIGHEST + 1) throw new Error("invalid order bounds");
    if (low === high) { prefix += String.fromCharCode(low); continue; }
    if (high - low > 1) return prefix + String.fromCharCode(Math.floor((low + high) / 2));
    // Adjacent code units: keep the lower one; only the lower bound constrains the rest.
    prefix += String.fromCharCode(low);
    bound = undefined;
  }
  throw new Error("order space exhausted");
}

function sealedEntries(entries: readonly SealedEntry[], version: ListingVersion): SealedEntry[] {
  return entries.map((entry) => ({ nodeId: entry.nodeId, kind: entry.kind,
    nameCiphertext: entry.nameCiphertext, orderCiphertext: entry.orderCiphertext, keyEnvelope: entry.keyEnvelope,
    ...(version === 2 ? { encoding: entry.encoding ?? (entry.kind === "directory" ? "directory" : "legacy-file"),
      ...(entry.encoding === "receiving-file" ? { receivingKeyId: entry.receivingKeyId,
        receivingEpoch: entry.receivingEpoch, wrapRevision: entry.wrapRevision } : {}) } : {}) }));
}

function signListing(vaultId: string, signer: StructureSigner, state: DirectoryState,
  entries: readonly SealedEntry[], version: ListingVersion = state.listing.listingVersion ?? 1): Promise<ListingHead> {
  return createListingHead(state.key, signer.assertionKey, { vaultId, directoryId: state.listing.directoryId,
    deviceId: signer.deviceId, revision: state.listing.entriesRevision + 1,
    entries: sealedEntries(entries, version), version });
}

function sorted(listing: DirectoryListing): TreeEntry[] {
  return listing.entries.slice().sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 :
    a.nodeId.localeCompare(b.nodeId));
}

/** Moves one entry a single place up or down among its siblings by re-encrypting only its order. */
export async function prepareTreeReorder(options: { vaultId: string; signer: StructureSigner;
  parent: DirectoryState; nodeId: string; direction: "up" | "down" }) {
  const siblings = sorted(options.parent.listing);
  const index = siblings.findIndex((entry) => entry.nodeId === options.nodeId);
  if (index < 0) throw new TreeNotFoundError();
  const target = options.direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= siblings.length) throw new Error("already at the edge");
  const [lower, upper] = options.direction === "up"
    ? [siblings[target - 1]?.order, siblings[target]!.order]
    : [siblings[target]!.order, siblings[target + 1]?.order];
  const entry = siblings[index]!;
  const order = orderBetween(lower ?? "", upper);
  const { orderCiphertext } = await encryptedEntry(options.parent.key, options.vaultId,
    options.parent.listing.directoryId, entry.nodeId, entry.name, order);
  const listingHead = await signListing(options.vaultId, options.signer, options.parent,
    options.parent.listing.entries.map((item) => item.nodeId === entry.nodeId ? { ...item, orderCiphertext } : item));
  return { expectedRevision: options.parent.listing.entriesRevision, orderCiphertext, listingHead };
}

/** Deletion signs the parent listing without the entry; the Worker removes the whole subtree. */
export async function prepareTreeDelete(options: { vaultId: string; signer: StructureSigner;
  parent: DirectoryState; nodeId: string }) {
  if (!options.parent.listing.entries.some((entry) => entry.nodeId === options.nodeId)) throw new TreeNotFoundError();
  const listingHead = await signListing(options.vaultId, options.signer, options.parent,
    options.parent.listing.entries.filter((entry) => entry.nodeId !== options.nodeId));
  return { expectedRevision: options.parent.listing.entriesRevision, listingHead };
}

async function sha256(value: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(value)));
}

/**
 * Opens the current File key through the SOURCE capability and re-targets it to a fresh
 * receiving pair; the File's Private thread (if any) moves to a new epoch for that pair.
 */
async function rotateReceivingPair(vaultId: string, signer: StructureSigner, entry: TreeEntry,
  source: DirectoryState, destination: DirectoryState, file: FileRotationSource, threadSource: ThreadKeySource) {
  if (entry.encoding !== "receiving-file" || !entry.receivingKeyId || !entry.receivingEpoch || !entry.wrapRevision) {
    throw new Error("invalid File entry");
  }
  const head = await authenticateFileHead(file.fileHead, vaultId, entry.nodeId, file.revision);
  const statement = head.statement;
  const oldPublic = decodeTreeBytes(file.receivingPublicKey, 65);
  const parentEnvelope = decodeTreeBytes(file.parentEnvelope, 16_384);
  if (statement.receivingKey.id !== entry.receivingKeyId || statement.receivingKey.epoch !== entry.receivingEpoch ||
      statement.contentKey.id !== file.contentKeyId || statement.contentKey.epoch !== file.keyEpoch ||
      statement.publication.status !== "none") throw new Error("invalid File head");
  await verifyFileReceivingTarget(head, oldPublic);
  await verifyFileParentEnvelope(head, parentEnvelope);
  const pair = await openFileReceivingKey(decodeTreeBytes(entry.keyEnvelope, 16_384), source.key, { vaultId,
    fileId: entry.nodeId, receivingKeyId: entry.receivingKeyId, receivingEpoch: entry.receivingEpoch,
    wrapRevision: entry.wrapRevision, publicKey: oldPublic });
  const contentKey = await openFileContentKeyFromReceiving(parentEnvelope, pair, { vaultId, fileId: entry.nodeId,
    revision: file.revision, contentKeyId: file.contentKeyId, contentEpoch: file.keyEpoch,
    receivingKeyId: entry.receivingKeyId });
  try {
    const receivingKeyId = newOpaqueId(), receivingEpoch = entry.receivingEpoch + 1;
    const wrapRevision = entry.wrapRevision + 1;
    const next = await createFileReceivingKey(destination.key, { vaultId, fileId: entry.nodeId,
      receivingKeyId, receivingEpoch, wrapRevision });
    const rotatedEnvelope = await sealToRecipient(contentKey, next.keyPair.publicKey, {
      purpose: "file-content-key", vaultId, objectId: entry.nodeId, keyId: file.contentKeyId,
      keyEpoch: file.keyEpoch, revision: file.revision, recipientId: receivingKeyId });
    const signed = await signFileHead({ ...statement,
      receivingKey: { id: receivingKeyId, epoch: receivingEpoch, publicKeyDigest: next.publicKeyDigest },
      parentEnvelopeDigest: await sha256(rotatedEnvelope), signerDeviceId: signer.deviceId }, signer.assertionKey);
    const thread = await prepareThreadRotation(threadSource, { receivingKeyId: entry.receivingKeyId,
      receivingEpoch: entry.receivingEpoch, pair }, { receivingKeyId, publicKey: next.keyPair.publicKey });
    return { keyEnvelope: encodeTreeBytes(next.privateKeyEnvelope), rotation: {
      expectedHeadDigest: file.fileHead.digest, receivingKeyId, receivingEpoch, wrapRevision,
      receivingPublicKey: encodeTreeBytes(next.publicKey), parentEnvelope: encodeTreeBytes(rotatedEnvelope),
      signedHead: { bytes: encodeTreeBytes(signed.bytes), digest: encodeTreeBytes(signed.digest),
        signature: encodeTreeBytes(signed.signature) }, thread } };
  } finally { contentKey.fill(0); }
}

/**
 * One move request: namespace-v1 collision check in the destination, name/order
 * re-encrypted under the destination capability, key material rewrapped (a v2 File
 * gets a fresh receiving pair), and both parent listings signed at their next revisions.
 */
export async function prepareTreeMove(options: { vaultId: string; signer: StructureSigner;
  source: DirectoryState; destination: DirectoryState; nodeId: string; file?: FileRotationSource;
  thread?: ThreadKeySource }) {
  const { vaultId, signer, source, destination, nodeId } = options;
  const entry = source.listing.entries.find((item) => item.nodeId === nodeId);
  if (!entry) throw new TreeNotFoundError();
  const name = nameAgainstNamespace(entry.name, destination.listing.entries.map((item) => item.name));
  const last = sorted(destination.listing).at(-1)?.order;
  const metadata = await encryptedEntry(destination.key, vaultId, destination.listing.directoryId, nodeId,
    name, orderBetween(last ?? ""));
  let moved: SealedEntry, rotation: Awaited<ReturnType<typeof rotateReceivingPair>>["rotation"] | undefined;
  if (entry.kind === "directory") {
    const context = { purpose: "directory-capability" as const, vaultId, objectId: nodeId, keyId: nodeId,
      keyEpoch: 1, revision: 1 };
    const capability = await openSymmetric(decodeTreeBytes(entry.keyEnvelope), source.key, { context });
    try {
      const writer = await createSymmetricWriter(destination.key);
      moved = { nodeId, kind: "directory", encoding: "directory", ...metadata,
        keyEnvelope: encodeTreeBytes(await writer.seal(capability, context)) };
    } finally { capability.fill(0); }
  } else if (entry.encoding === "receiving-file") {
    if (!options.file || !options.thread) throw new Error("File rotation material required");
    const rotated = await rotateReceivingPair(vaultId, signer, entry, source, destination, options.file,
      options.thread);
    rotation = rotated.rotation;
    moved = { nodeId, kind: "file", encoding: "receiving-file", ...metadata, keyEnvelope: rotated.keyEnvelope,
      receivingKeyId: rotation.receivingKeyId, receivingEpoch: rotation.receivingEpoch,
      wrapRevision: rotation.wrapRevision };
  } else {
    // Legacy: the committed envelope header names the current key; opening it proves that context.
    const context = inspectEnvelope(decodeTreeBytes(entry.keyEnvelope, 16_384)).context;
    if (context.purpose !== "file-content-key" || context.objectId !== nodeId || context.vaultId !== vaultId) {
      throw new Error("invalid File entry");
    }
    const key = await openSymmetric(decodeTreeBytes(entry.keyEnvelope, 16_384), source.key, { context });
    try {
      const writer = await createSymmetricWriter(destination.key);
      moved = { nodeId, kind: "file", encoding: "legacy-file", ...metadata,
        keyEnvelope: encodeTreeBytes(await writer.seal(key, context)) };
    } finally { key.fill(0); }
  }
  const destinationVersion: ListingVersion = rotation ? 2 : destination.listing.listingVersion ?? 1;
  const sourceListingHead = await signListing(vaultId, signer, source,
    source.listing.entries.filter((item) => item.nodeId !== nodeId));
  const destinationListingHead = await signListing(vaultId, signer, destination,
    [...destination.listing.entries, moved], destinationVersion);
  return { sourceId: source.listing.directoryId, destinationId: destination.listing.directoryId,
    expectedSourceRevision: source.listing.entriesRevision,
    expectedDestinationRevision: destination.listing.entriesRevision,
    nameCiphertext: moved.nameCiphertext, orderCiphertext: moved.orderCiphertext, keyEnvelope: moved.keyEnvelope,
    sourceListingHead, destinationListingHead, ...(rotation ?? {}) };
}

async function structuralRequest<T>(path: string, method: "PATCH" | "DELETE", body: object): Promise<T> {
  const response = await privateRequest(path, { method, body: JSON.stringify(body) });
  if (response.status === 404) throw new TreeNotFoundError();
  if (response.status === 409) {
    const error = await response.json().catch(() => null) as { error?: string } | null;
    if (error?.error === "subtree_limit_exceeded" || error?.error === "move_leaves_shared_scope" ||
        error?.error === "rotation_pending" || error?.error === "file_changed") throw new TreeStructureError(error.error);
    throw new NamespaceChangedError();
  }
  if (!response.ok) throw new Error("private tree unavailable");
  return response.json() as Promise<T>;
}

async function browserSigner(access: RootAccess): Promise<StructureSigner> {
  if (isSignupRecoveryConfirmationPending()) throw new RecoveryConfirmationPendingError();
  const device = await getDevice(access.actorAccountId ?? access.vaultId);
  if (!device) throw new Error("private tree unavailable");
  return { deviceId: device.deviceId, assertionKey: device.assertionKeyPair.privateKey };
}

function remember(access: RootAccess, directoryId: string, revision: number, head: ListingHead): void {
  try { rememberListing(access.vaultId, directoryId, revision, head.digest); }
  catch { throw new TreeCommitUncertainError(); }
}

export async function reorderTreeChild(access: RootAccess, parent: DirectoryState, nodeId: string,
  direction: "up" | "down"): Promise<{ entriesRevision: number }> {
  const signer = await browserSigner(access);
  const body = await prepareTreeReorder({ vaultId: access.vaultId, signer, parent, nodeId, direction });
  const result = await structuralRequest<{ entriesRevision: number }>(`/api/private/tree/nodes/${nodeId}/order`,
    "PATCH", body);
  remember(access, parent.listing.directoryId, result.entriesRevision, body.listingHead);
  return result;
}

export async function deleteTreeNode(access: RootAccess, parent: DirectoryState,
  nodeId: string): Promise<{ entriesRevision: number }> {
  const signer = await browserSigner(access);
  const body = await prepareTreeDelete({ vaultId: access.vaultId, signer, parent, nodeId });
  const result = await structuralRequest<{ entriesRevision: number }>(`/api/private/tree/nodes/${nodeId}`,
    "DELETE", body);
  remember(access, parent.listing.directoryId, result.entriesRevision, body.listingHead);
  return result;
}

/** Parent-capability read of the current v2 File head and wrappers; never a direct-Grant path. */
async function rotationSource(nodeId: string): Promise<FileRotationSource> {
  const response = await privateRequest(`/api/private/tree/files/${nodeId}`, { method: "POST" });
  if (response.status === 404) throw new TreeNotFoundError();
  if (!response.ok) throw new Error("private tree unavailable");
  const file = await response.json() as Partial<FileRotationSource> & { fileId?: string };
  if (file.fileId !== nodeId || !file.fileHead || !file.parentEnvelope || !file.receivingPublicKey ||
      !Number.isSafeInteger(file.revision) || !file.contentKeyId || !Number.isSafeInteger(file.keyEpoch)) {
    throw new Error("invalid File head");
  }
  return file as FileRotationSource;
}

export async function moveTreeChild(access: RootAccess, nodeId: string, source: DirectoryState,
  destination: DirectoryState): Promise<{ sourceRevision: number; destinationRevision: number }> {
  const signer = await browserSigner(access);
  const entry = source.listing.entries.find((item) => item.nodeId === nodeId);
  if (!entry) throw new TreeNotFoundError();
  const receiving = entry.encoding === "receiving-file";
  const file = receiving ? await rotationSource(nodeId) : undefined;
  const thread = receiving ? await loadThreadKeySource(nodeId).catch((error: unknown) => {
    throw error instanceof CommentsUnavailableError && error.code === "not_found" ? new TreeNotFoundError() :
      new Error("private tree unavailable");
  }) : undefined;
  const body = await prepareTreeMove({ vaultId: access.vaultId, signer, source, destination, nodeId, file, thread })
    .catch((error: unknown) => {
      throw error instanceof CommentsUnavailableError && error.code === "file_changed" ?
        new TreeStructureError("file_changed") : error;
    });
  const result = await structuralRequest<{ sourceRevision: number; destinationRevision: number }>(
    `/api/private/tree/nodes/${nodeId}/parent`, "PATCH", body);
  remember(access, source.listing.directoryId, result.sourceRevision, body.sourceListingHead);
  remember(access, destination.listing.directoryId, result.destinationRevision, body.destinationListingHead);
  return result;
}
