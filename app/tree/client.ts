import { createSymmetricWriter, openSymmetric } from "~/crypto/enc-v1";
import { createFileReceivingKey, createFileSave, openFileContentKeyFromDevice,
  openFileContentKeyFromReceiving, openFileReceivingKey } from "~/crypto/file-receiving";
import {
  createChildDirectoryCapability, createFileRepresentation, decodeFileRepresentation,
  openDeviceEnrollmentEnvelope, openVaultRecoveryEnvelope,
} from "~/crypto/vault";
import { privateRequest } from "~/device/private-client";
import { getDevice } from "~/device/store";
import { canonicalizeSegment, sameComparisonKey } from "~/namespace-v1";
import { newOpaqueId } from "~/opaque-id";
import { isSignupRecoveryConfirmationPending, RecoveryConfirmationPendingError } from "~/signup/recovery-gate";
import { createListingHead, openListingHead, type ListingHead, type ListingVersion, type SealedEntry, type StoredListingHead } from "./listing";
import { assertFileHeadCheckpointAdvance, signFileHead, verifyDirectFileRecipientEnvelope,
  verifyFileHead, verifyFileParentEnvelope, verifyFileReceivingTarget, verifyFileRepresentation,
  type VerifiedFileHead } from "./file-head";
import { decodeTreeBytes, encodeTreeBytes } from "./wire";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Browser-only error; name review never sends the requested name to the Worker. */
export class NameConflictError extends Error {
  constructor() { super("name_conflict"); }
}
export class TreeNotFoundError extends Error {
  constructor() { super("not_found"); }
}
export class TreeCommitUncertainError extends Error {
  constructor() { super("tree_commit_uncertain"); }
}
export class SharedProvisioningError extends Error {
  constructor() { super("shared_content_provisioning_required"); }
}

export type TreeKind = "directory" | "file";
export type TreeEntry = SealedEntry & { name: string; order: string };
export type DirectoryListing = { directoryId: string; entriesRevision: number; entries: TreeEntry[];
  listingVersion?: ListingVersion }; // Omitted only by older in-tab v1 clients.
export type RootAccess = { scope?: "owned" | "directory-grant"; vaultId: string; actorAccountId?: string;
  rootId: string; rootKey: Uint8Array<ArrayBuffer>; vaultRoot?: Uint8Array<ArrayBuffer>;
  grantId?: string; rootLabel?: string };
export type LoadedFile = { parentId: string; revision: number; representationId: string;
  contentKeyId: string; keyEpoch: number; markdown: string; metadata: Uint8Array;
  v2?: { head: VerifiedFileHead; receivingPublicKey: string; signedHead: FileHeadWire } };
export type FileHeadWire = { bytes: string; digest: string; signature: string;
  signerDeviceId: string; signerAccountId?: string; signerPublicKey: string };
export async function authenticateFileHead(wire: FileHeadWire, ownerId: string, fileId: string,
  revision: number): Promise<VerifiedFileHead> {
  return verifyFileHead({ bytes: decodeTreeBytes(wire.bytes, 131_072), digest: decodeTreeBytes(wire.digest, 32),
    signature: decodeTreeBytes(wire.signature, 64) }, { ownerId, vaultId: ownerId, fileId,
    signerDeviceId: wire.signerDeviceId, publicKey: decodeTreeBytes(wire.signerPublicKey, 65), revision });
}

async function rememberFileHead(ownerId: string, fileId: string, wire: FileHeadWire,
  head: VerifiedFileHead, signal?: AbortSignal): Promise<void> {
  // The lock name is the same opaque owner/File identity as the persisted checkpoint.
  // Web Locks serialize read/verify/compare/write across tabs, not merely this JS context.
  if (typeof window === "undefined" || !navigator.locks?.request) throw new Error("File checkpoint unavailable");
  const key = `mdwn:file-head:${ownerId}:${fileId}`;
  signal?.throwIfAborted();
  await navigator.locks.request(key, { mode: "exclusive", ...(signal ? { signal } : {}) }, async () => {
    signal?.throwIfAborted();
    const saved = localStorage.getItem(key);
    if (saved) {
      const old = JSON.parse(saved) as { wire: FileHeadWire; revision: number };
      if (!old.wire || !Number.isSafeInteger(old.revision)) throw new Error("invalid File checkpoint");
      const previous = await authenticateFileHead(old.wire, ownerId, fileId, old.revision);
      signal?.throwIfAborted();
      assertFileHeadCheckpointAdvance(previous, head);
    }
    // Aborted clientLoaders must not change browser integrity state after async verification.
    signal?.throwIfAborted();
    localStorage.setItem(key, JSON.stringify({ wire, revision: head.statement.revision }));
  });
}

function nameAgainstNamespace(name: string, existingNames: readonly string[]): string {
  const canonical = canonicalizeSegment(name);
  if (existingNames.some((sibling) => sameComparisonKey(sibling, canonical))) throw new NameConflictError();
  return canonical.display;
}

function metadataContext(vaultId: string, parentId: string, childId: string) {
  return { purpose: "directory-metadata" as const, vaultId, objectId: childId,
    keyId: parentId, keyEpoch: 1, revision: 1 };
}

async function encryptedEntry(parentKey: Uint8Array, vaultId: string, parentId: string,
  nodeId: string, name: string, order: string) {
  const writer = await createSymmetricWriter(parentKey);
  const context = metadataContext(vaultId, parentId, nodeId);
  return { nameCiphertext: encodeTreeBytes(await writer.seal(encoder.encode(name), context)),
    orderCiphertext: encodeTreeBytes(await writer.seal(encoder.encode(order), context)) };
}

/** Runs namespace-v1 before creating either a capability or a request. */
export async function prepareTreeCreate(options: {
  vaultId: string; actorAccountId?: string; parentId: string; parentKey: Uint8Array;
  entriesRevision: number; existingNames: readonly string[];
  requestedName: string; kind: TreeKind; markdown?: string;
}) {
  const name = nameAgainstNamespace(options.requestedName, options.existingNames);
  const nodeId = newOpaqueId();
  const order = newOpaqueId(); // Opaque in the Worker and encrypted before transport.
  const metadata = await encryptedEntry(options.parentKey, options.vaultId, options.parentId, nodeId, name, order);
  if (options.kind === "file" && typeof window !== "undefined") {
    const device = await getDevice(options.actorAccountId ?? options.vaultId);
    if (!device) throw new Error("private File unavailable");
    const receivingKeyId = newOpaqueId(), contentKeyId = newOpaqueId(), representationId = newOpaqueId();
    const receiving = await createFileReceivingKey(options.parentKey, { vaultId: options.vaultId, fileId: nodeId,
      receivingKeyId, receivingEpoch: 1, wrapRevision: options.entriesRevision + 1 });
    const fresh = await createFileSave({ markdown: options.markdown ?? "", metadata: new Uint8Array() },
      receiving.publicKey, { vaultId: options.vaultId, fileId: nodeId, receivingKeyId,
        receivingEpoch: 1, publicKeyDigest: receiving.publicKeyDigest },
      { vaultId: options.vaultId, fileId: nodeId, contentKeyId, contentEpoch: 1, revision: 1 }, []);
    const digest = async (value: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(value)));
    const head = await signFileHead({ ownerId: options.vaultId, vaultId: options.vaultId, fileId: nodeId,
      revision: 1, contentKey: { id: contentKeyId, epoch: 1 },
      receivingKey: { id: receivingKeyId, epoch: 1, publicKeyDigest: receiving.publicKeyDigest },
      representation: { id: representationId, digest: await digest(fresh.contentEnvelope) },
      parentEnvelopeDigest: await digest(fresh.parentEnvelope), recipientSetVersion: 1, recipients: [],
      publication: { status: "none" }, signerDeviceId: device.deviceId }, device.assertionKeyPair.privateKey);
    return { nodeId, kind: "file" as const, expectedRevision: options.entriesRevision, ...metadata,
      encoding: "receiving-file" as const, keyEnvelope: encodeTreeBytes(receiving.privateKeyEnvelope),
      receivingKeyId, receivingEpoch: 1, wrapRevision: options.entriesRevision + 1,
      receivingPublicKey: encodeTreeBytes(receiving.publicKey), parentEnvelope: encodeTreeBytes(fresh.parentEnvelope),
      recipientEnvelopes: [], signedHead: { bytes: encodeTreeBytes(head.bytes),
        digest: encodeTreeBytes(head.digest), signature: encodeTreeBytes(head.signature) },
      representation: { id: representationId, contentKeyId, keyEpoch: 1, revision: 1,
        ciphertext: encodeTreeBytes(fresh.contentEnvelope) } };
  }
  if (options.kind === "directory") {
    const child = await createChildDirectoryCapability(options.parentKey, {
      vaultId: options.vaultId, parentDirectoryId: options.parentId, childDirectoryId: nodeId,
    });
    return { nodeId, kind: options.kind, expectedRevision: options.entriesRevision, ...metadata,
      keyEnvelope: encodeTreeBytes(child.envelope) };
  }
  const file = await createFileRepresentation(options.parentKey,
    { markdown: options.markdown ?? "", metadata: new Uint8Array() },
    { vaultId: options.vaultId, fileId: nodeId });
  return { nodeId, kind: options.kind, expectedRevision: options.entriesRevision, ...metadata,
    keyEnvelope: encodeTreeBytes(file.fileContentKeyEnvelope), representation: {
      id: newOpaqueId(), contentKeyId: nodeId, keyEpoch: 1, revision: 1 as const,
      ciphertext: encodeTreeBytes(file.contentEnvelope),
    } };
}

/** Rename preserves the existing encrypted order; only the local browser sees names. */
export async function prepareTreeRename(options: {
  vaultId: string; parentId: string; parentKey: Uint8Array; nodeId: string;
  entriesRevision: number; existingNames: readonly string[]; requestedName: string; order: string;
}) {
  const name = nameAgainstNamespace(options.requestedName, options.existingNames);
  return { expectedRevision: options.entriesRevision,
    ...await encryptedEntry(options.parentKey, options.vaultId, options.parentId, options.nodeId, name, options.order) };
}

async function jsonResource<T>(path: string, method: "POST" | "PUT" | "PATCH", body?: object,
  signal?: AbortSignal): Promise<T> {
  const response = await privateRequest(path, { method, signal, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.status === 404) throw new TreeNotFoundError();
  if (response.status === 409) throw new NamespaceChangedError();
  if (!response.ok) throw new Error("private tree unavailable");
  return response.json() as Promise<T>;
}

export class NamespaceChangedError extends Error {
  constructor() { super("namespace_changed"); }
}

/** Browser possession + proof-guarded bootstrap; keys never enter loaders or document HTML. */
export async function openRoot(signal?: AbortSignal): Promise<RootAccess> {
  const state = await fetch("/api/device/state", { cache: "no-store", signal });
  if (!state.ok) throw new Error("private tree unavailable");
  const { accountId, deviceId } = await state.json() as { accountId: string; deviceId: string | null };
  if (!deviceId) throw new Error("private tree unavailable");
  const device = await getDevice(accountId);
  if (!device || device.deviceId !== deviceId) throw new Error("private tree unavailable");
  const response = await privateRequest("/api/private/bootstrap", { method: "POST", signal });
  if (!response.ok) throw new Error("private tree unavailable");
  const bootstrap = await response.json() as {
    rootDirectoryId: string; rootRecoveryEnvelope: string; enrollmentEnvelope: string;
  };
  const vaultRoot = await openDeviceEnrollmentEnvelope(decodeTreeBytes(bootstrap.enrollmentEnvelope),
    device.transportKeyPair, { purpose: "device-enrollment", vaultId: accountId,
      objectId: deviceId, keyId: deviceId, keyEpoch: 1, revision: 1, recipientId: deviceId });
  const rootKey = await openVaultRecoveryEnvelope(decodeTreeBytes(bootstrap.rootRecoveryEnvelope), vaultRoot,
    { purpose: "vault-recovery", vaultId: accountId, objectId: bootstrap.rootDirectoryId,
      keyId: bootstrap.rootDirectoryId, keyEpoch: 1, revision: 1 });
  signal?.throwIfAborted();
  return { scope: "owned", vaultId: accountId, actorAccountId: accountId,
    rootId: bootstrap.rootDirectoryId, rootKey, vaultRoot };
}

export async function loadDirectory(access: RootAccess, directoryId: string, key: Uint8Array,
  signal?: AbortSignal): Promise<DirectoryListing> {
  const listing = await jsonResource<{ directoryId: string; entriesRevision: number; listingVersion: ListingVersion;
    capabilityKeyId: string; capabilityEpoch: number;
    entries: SealedEntry[]; listingHead: Omit<StoredListingHead, "signerPublicKey"> & { signerPublicKey: string } | null;
  }>(`/api/private/tree/directories/${directoryId}`, "POST", undefined, signal);
  if (listing.directoryId !== directoryId || ![1, 2].includes(listing.listingVersion) ||
      (listing.listingVersion === 2 && (listing.capabilityKeyId !== directoryId || listing.capabilityEpoch !== 1)) ||
      !Number.isSafeInteger(listing.entriesRevision) || listing.entriesRevision < 1) {
    throw new Error("invalid directory listing");
  }
  if (listing.entriesRevision === 1) {
    if (listing.listingHead || listing.entries.length) throw new Error("replayed-manifest");
  } else {
    if (!listing.listingHead) throw new Error("replayed-manifest");
    await openListingHead(key, { vaultId: access.vaultId, directoryId,
      revision: listing.entriesRevision, entries: listing.entries, version: listing.listingVersion,
      head: { ...listing.listingHead, signerPublicKey: decodeTreeBytes(listing.listingHead.signerPublicKey, 65) },
    });
  }
  signal?.throwIfAborted();
  const entries = await Promise.all(listing.entries.map(async (entry): Promise<TreeEntry> => {
    const context = metadataContext(access.vaultId, directoryId, entry.nodeId);
    const name = decoder.decode(await openSymmetric(decodeTreeBytes(entry.nameCiphertext), key, { context }));
    const order = decoder.decode(await openSymmetric(decodeTreeBytes(entry.orderCiphertext), key, { context }));
    if (canonicalizeSegment(name).display !== name || order.length > 256 || !order) {
      throw new Error("invalid directory listing");
    }
    return { ...entry, name, order };
  }));
  for (let i = 0; i < entries.length; i++) {
    if (entries.slice(i + 1).some((sibling) => sameComparisonKey(entries[i]!.name, sibling.name))) {
      throw new Error("invalid directory listing");
    }
  }
  entries.sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : a.nodeId.localeCompare(b.nodeId));
  signal?.throwIfAborted();
  rememberListing(access.vaultId, directoryId, listing.entriesRevision, listing.listingHead?.digest ?? "");
  return { directoryId, entriesRevision: listing.entriesRevision, listingVersion: listing.listingVersion, entries };
}

export async function openChildDirectory(access: RootAccess,
  parentKey: Uint8Array, entry: TreeEntry): Promise<Uint8Array<ArrayBuffer>> {
  if (entry.kind !== "directory") throw new Error("invalid directory");
  return openSymmetric(decodeTreeBytes(entry.keyEnvelope), parentKey, { context: {
    purpose: "directory-capability", vaultId: access.vaultId,
    objectId: entry.nodeId, keyId: entry.nodeId, keyEpoch: 1, revision: 1,
  } });
}

export async function loadAncestors(nodeId: string, signal?: AbortSignal): Promise<string[]> {
  const result = await jsonResource<{ ancestors: string[] }>(`/api/private/tree/nodes/${nodeId}/ancestors`, "POST", undefined, signal);
  if (!Array.isArray(result.ancestors) || result.ancestors.at(-1) !== nodeId ||
      result.ancestors.length > 101) throw new Error("invalid tree path");
  return result.ancestors;
}

export async function loadFile(access: RootAccess, fileId: string, parentId: string, parentKey: Uint8Array,
  expectedEntry: TreeEntry, signal?: AbortSignal): Promise<LoadedFile> {
  const file = await jsonResource<{ fileId: string; parentId: string; revision: number; representationId: string;
    contentKeyId: string; keyEpoch: number; ciphertext: string; keyEnvelope: string;
    ownerId?: string; fileHead?: FileHeadWire; receivingPublicKey?: string;
    receivingKeyId?: string; receivingEpoch?: number; wrapRevision?: number; parentEnvelope?: string;
  }>(`/api/private/tree/files/${fileId}`, "POST", undefined, signal);
  if (file.parentId !== parentId || expectedEntry.nodeId !== fileId ||
      expectedEntry.keyEnvelope !== file.keyEnvelope ||
      !Number.isSafeInteger(file.revision) || file.revision < 1 ||
      !Number.isSafeInteger(file.keyEpoch) || file.keyEpoch < 1) throw new Error("invalid File listing");
  const context = { vaultId: access.vaultId, objectId: fileId,
    keyId: file.contentKeyId, keyEpoch: file.keyEpoch, revision: file.revision };
  if (expectedEntry.encoding === "receiving-file") {
    if (!file.fileHead || !file.receivingPublicKey || !file.parentEnvelope ||
        file.ownerId !== access.vaultId || expectedEntry.receivingKeyId !== file.receivingKeyId ||
        expectedEntry.receivingEpoch !== file.receivingEpoch || expectedEntry.wrapRevision !== file.wrapRevision ||
        !Number.isSafeInteger(file.receivingEpoch) || !Number.isSafeInteger(file.wrapRevision)) {
      throw new Error("invalid File head");
    }
    const head = await authenticateFileHead(file.fileHead, access.vaultId, fileId, file.revision);
    if (head.statement.contentKey.id !== file.contentKeyId || head.statement.contentKey.epoch !== file.keyEpoch ||
        head.statement.representation.id !== file.representationId ||
        head.statement.receivingKey.id !== file.receivingKeyId ||
        head.statement.receivingKey.epoch !== file.receivingEpoch || head.statement.publication.status !== "none") {
      throw new Error("invalid File head");
    }
    const publicKey = decodeTreeBytes(file.receivingPublicKey, 65);
    await verifyFileReceivingTarget(head, publicKey);
    await verifyFileRepresentation(head, file.representationId, decodeTreeBytes(file.ciphertext, 524_288));
    await verifyFileParentEnvelope(head, decodeTreeBytes(file.parentEnvelope, 16_384));
    const pair = await openFileReceivingKey(decodeTreeBytes(file.keyEnvelope, 16_384), parentKey,
      { vaultId: access.vaultId, fileId, receivingKeyId: file.receivingKeyId!,
        receivingEpoch: file.receivingEpoch!, wrapRevision: file.wrapRevision!, publicKey });
    const key = await openFileContentKeyFromReceiving(decodeTreeBytes(file.parentEnvelope, 16_384), pair,
      { vaultId: access.vaultId, fileId, revision: file.revision,
        contentKeyId: file.contentKeyId, contentEpoch: file.keyEpoch,
        receivingKeyId: file.receivingKeyId! });
    const content = await openSymmetric(decodeTreeBytes(file.ciphertext, 524_288), key,
      { context: { ...context, purpose: "file-content" } });
    const plaintext = decodeFileRepresentation(content);
    await rememberFileHead(access.vaultId, fileId, file.fileHead, head, signal);
    return { parentId, revision: file.revision, representationId: file.representationId,
      contentKeyId: file.contentKeyId, keyEpoch: file.keyEpoch, ...plaintext,
      v2: { head, receivingPublicKey: file.receivingPublicKey, signedHead: file.fileHead } };
  }
  if (expectedEntry.encoding && expectedEntry.encoding !== "legacy-file" || file.fileHead) {
    throw new Error("invalid File encoding");
  }
  const key = await openSymmetric(decodeTreeBytes(file.keyEnvelope), parentKey,
    { context: { ...context, purpose: "file-content-key" } });
  const content = await openSymmetric(decodeTreeBytes(file.ciphertext, 524_288), key,
    { context: { ...context, purpose: "file-content" } });
  return { parentId: file.parentId, revision: file.revision, representationId: file.representationId,
    contentKeyId: file.contentKeyId, keyEpoch: file.keyEpoch, ...decodeFileRepresentation(content) };
}

export type LoadedDirectFile = { ownerId: string; fileId: string; revision: number;
  markdown: string; metadata: Uint8Array; head: VerifiedFileHead; signedHead: FileHeadWire;
  receivingPublicKey: string };

/** File-only cryptographic read: no parent ID, Directory key, sibling or path. */
export async function loadDirectFile(actorAccountId: string, fileId: string,
  signal?: AbortSignal): Promise<LoadedDirectFile> {
  const device = await getDevice(actorAccountId);
  if (!device) throw new Error("private File unavailable");
  const response = await privateRequest(`/api/private/sharing/direct-files/${fileId}`, { method: "POST", signal });
  if (response.status === 202) throw new SharedProvisioningError();
  if (response.status === 404) throw new TreeNotFoundError();
  if (!response.ok) throw new Error("private File unavailable");
  const data = await response.json() as { ownerId: string; fileId: string; revision: number;
    representationId: string; contentKeyId: string; keyEpoch: number; ciphertext: string;
    receivingPublicKey: string; fileHead: FileHeadWire; recipientEnvelope: string;
    parentId?: unknown; parentEnvelope?: unknown; keyEnvelope?: unknown };
  if (data.fileId !== fileId || !data.ownerId || !data.fileHead || !data.recipientEnvelope ||
      data.parentId !== undefined || data.parentEnvelope !== undefined || data.keyEnvelope !== undefined) {
    throw new Error("invalid direct File response");
  }
  const head = await authenticateFileHead(data.fileHead, data.ownerId, fileId, data.revision);
  if (head.statement.representation.id !== data.representationId ||
      head.statement.contentKey.id !== data.contentKeyId || head.statement.contentKey.epoch !== data.keyEpoch ||
      head.statement.publication.status !== "none") throw new Error("invalid File head");
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", device.transportKeyPair.publicKey));
  await verifyFileReceivingTarget(head, decodeTreeBytes(data.receivingPublicKey, 65));
  await verifyFileRepresentation(head, data.representationId, decodeTreeBytes(data.ciphertext, 524_288));
  await verifyDirectFileRecipientEnvelope(head, actorAccountId, device.deviceId, publicKey,
    decodeTreeBytes(data.recipientEnvelope, 16_384));
  const identity = { vaultId: data.ownerId, fileId, contentKeyId: data.contentKeyId,
    contentEpoch: data.keyEpoch, revision: data.revision };
  const key = await openFileContentKeyFromDevice(decodeTreeBytes(data.recipientEnvelope, 16_384),
    device.transportKeyPair, { ...identity, deviceId: device.deviceId });
  const content = await openSymmetric(decodeTreeBytes(data.ciphertext, 524_288), key,
    { context: { purpose: "file-content", vaultId: data.ownerId, objectId: fileId,
      keyId: data.contentKeyId, keyEpoch: data.keyEpoch, revision: data.revision } });
  const plaintext = decodeFileRepresentation(content);
  await rememberFileHead(data.ownerId, fileId, data.fileHead, head, signal);
  return { ownerId: data.ownerId, fileId, revision: data.revision, ...plaintext,
    head, signedHead: data.fileHead, receivingPublicKey: data.receivingPublicKey };
}

function listingCheckpointKey(vaultId: string, directoryId: string): string {
  return `mdwn:files-listing:${vaultId}:${directoryId}`;
}

/** Browser-local high-water mark detects rolled-back/same-revision heads across navigations. */
function rememberListing(vaultId: string, directoryId: string, revision: number, digest: string): void {
  if (typeof window === "undefined") return;
  const key = listingCheckpointKey(vaultId, directoryId);
  const previous = localStorage.getItem(key);
  if (previous) {
    const parsed: unknown = JSON.parse(previous);
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "number" ||
        typeof parsed[1] !== "string" || revision < parsed[0] ||
        (revision === parsed[0] && digest !== parsed[1])) throw new Error("replayed-manifest");
  }
  localStorage.setItem(key, JSON.stringify([revision, digest]));
}

async function signListingChange(access: RootAccess, listing: DirectoryListing, parentKey: Uint8Array,
  updated: SealedEntry[], targetVersion: ListingVersion = listing.listingVersion ?? 1): Promise<ListingHead> {
  if (!listing.directoryId) throw new Error("invalid directory listing");
  const device = await getDevice(access.actorAccountId ?? access.vaultId);
  if (!device) throw new Error("private tree unavailable");
  return createListingHead(parentKey, device.assertionKeyPair.privateKey, {
    vaultId: access.vaultId, directoryId: listing.directoryId, deviceId: device.deviceId,
    revision: listing.entriesRevision + 1, entries: targetVersion === 2 ? updated.map((entry) => ({
      ...entry, encoding: entry.encoding ?? (entry.kind === "directory" ? "directory" : "legacy-file"),
    })) : updated, version: targetVersion,
  });
}

export async function createTreeChild(access: RootAccess, parentId: string,
  input: { nodeId: string; kind: TreeKind; expectedRevision: number;
    nameCiphertext: string; orderCiphertext: string; keyEnvelope: string;
    encoding?: "directory" | "legacy-file" | "receiving-file"; receivingKeyId?: string;
    receivingEpoch?: number; wrapRevision?: number },
  listing: DirectoryListing, parentKey: Uint8Array) {
  if (isSignupRecoveryConfirmationPending()) throw new RecoveryConfirmationPendingError();
  if (listing.directoryId !== parentId || input.expectedRevision !== listing.entriesRevision) throw new Error("invalid directory listing");
  const targetVersion = input.encoding === "receiving-file" ? 2 : listing.listingVersion ?? 1;
  const head = await signListingChange(access, listing, parentKey, [...listing.entries, input], targetVersion);
  const result = await jsonResource<{ nodeId: string; entriesRevision: number }>(
    `/api/private/tree/directories/${parentId}/children`, "PUT", { ...input, listingHead: head });
  try { rememberListing(access.vaultId, parentId, result.entriesRevision, head.digest); }
  catch { throw new TreeCommitUncertainError(); }
  return result;
}
export async function renameTreeChild(access: RootAccess, parentId: string, nodeId: string,
  input: { expectedRevision: number; nameCiphertext: string; orderCiphertext: string },
  listing: DirectoryListing, parentKey: Uint8Array) {
  if (isSignupRecoveryConfirmationPending()) throw new RecoveryConfirmationPendingError();
  if (listing.directoryId !== parentId || input.expectedRevision !== listing.entriesRevision) throw new Error("invalid directory listing");
  const entry = listing.entries.find((item) => item.nodeId === nodeId);
  if (!entry) throw new TreeNotFoundError();
  const head = await signListingChange(access, listing, parentKey,
    listing.entries.map((item) => item.nodeId === nodeId ? { ...item, ...input } : item));
  const result = await jsonResource<{ entriesRevision: number }>(`/api/private/tree/nodes/${nodeId}/name`, "PATCH",
    { ...input, listingHead: head });
  try { rememberListing(access.vaultId, parentId, result.entriesRevision, head.digest); }
  catch { throw new TreeCommitUncertainError(); }
  return result;
}
