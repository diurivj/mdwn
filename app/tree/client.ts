import { createSymmetricWriter, openSymmetric } from "~/crypto/enc-v1";
import { fileSourceBytes } from "~/crypto/file-source";
import {
  createChildDirectoryCapability, createFileRepresentation, decodeFileRepresentation,
  openDeviceEnrollmentEnvelope, openVaultRecoveryEnvelope,
} from "~/crypto/vault";
import { privateRequest } from "~/device/private-client";
import { getDevice } from "~/device/store";
import { canonicalizeSegment, sameComparisonKey } from "~/namespace-v1";
import { newOpaqueId } from "~/opaque-id";
import { isSignupRecoveryConfirmationPending, RecoveryConfirmationPendingError } from "~/signup/recovery-gate";
import { createListingHead, openListingHead, type ListingHead, type SealedEntry, type StoredListingHead } from "./listing";
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

export type TreeKind = "directory" | "file";
export type TreeEntry = SealedEntry & { name: string; order: string };
export type DirectoryListing = { directoryId: string; entriesRevision: number; entries: TreeEntry[] };
export type RootAccess = { vaultId: string; rootId: string; rootKey: Uint8Array<ArrayBuffer> };

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
  vaultId: string; parentId: string; parentKey: Uint8Array;
  entriesRevision: number; existingNames: readonly string[];
  requestedName: string; kind: TreeKind; markdown?: string;
}) {
  const name = nameAgainstNamespace(options.requestedName, options.existingNames);
  const nodeId = newOpaqueId();
  const order = newOpaqueId(); // Opaque in the Worker and encrypted before transport.
  const metadata = await encryptedEntry(options.parentKey, options.vaultId, options.parentId, nodeId, name, order);
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
  return { vaultId: accountId, rootId: bootstrap.rootDirectoryId, rootKey };
}

export async function loadDirectory(access: RootAccess, directoryId: string, key: Uint8Array,
  signal?: AbortSignal): Promise<DirectoryListing> {
  const listing = await jsonResource<{ directoryId: string; entriesRevision: number;
    entries: SealedEntry[]; listingHead: Omit<StoredListingHead, "signerPublicKey"> & { signerPublicKey: string } | null;
  }>(`/api/private/tree/directories/${directoryId}`, "POST", undefined, signal);
  if (listing.directoryId !== directoryId || !Number.isSafeInteger(listing.entriesRevision) || listing.entriesRevision < 1) {
    throw new Error("invalid directory listing");
  }
  if (listing.entriesRevision === 1) {
    if (listing.listingHead || listing.entries.length) throw new Error("replayed-manifest");
  } else {
    if (!listing.listingHead) throw new Error("replayed-manifest");
    await openListingHead(key, { vaultId: access.vaultId, directoryId,
      revision: listing.entriesRevision, entries: listing.entries,
      head: { ...listing.listingHead, signerPublicKey: decodeTreeBytes(listing.listingHead.signerPublicKey, 65) },
    });
  }
  rememberListing(access.vaultId, directoryId, listing.entriesRevision, listing.listingHead?.digest ?? "");
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
  return { directoryId, entriesRevision: listing.entriesRevision, entries };
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

export async function loadFile(access: RootAccess, fileId: string, parentKey: Uint8Array,
  signal?: AbortSignal) {
  const file = await jsonResource<{ fileId: string; parentId: string; revision: number; representationId: string;
    contentKeyId: string; keyEpoch: number; ciphertext: string; keyEnvelope: string;
  }>(`/api/private/tree/files/${fileId}`, "POST", undefined, signal);
  const context = { vaultId: access.vaultId, objectId: fileId,
    keyId: file.contentKeyId, keyEpoch: file.keyEpoch, revision: file.revision };
  const key = await openSymmetric(decodeTreeBytes(file.keyEnvelope), parentKey,
    { context: { ...context, purpose: "file-content-key" } });
  const content = await openSymmetric(decodeTreeBytes(file.ciphertext, 524_288), key,
    { context: { ...context, purpose: "file-content" } });
  const decoded = decodeFileRepresentation(content);
  return { parentId: file.parentId, revision: file.revision, keyEpoch: file.keyEpoch,
    contentKeyId: file.contentKeyId, representationId: file.representationId,
    ...decoded, sourceBytes: fileSourceBytes(decoded.markdown) };
}

function listingCheckpointKey(vaultId: string, directoryId: string): string {
  return `mdwn:files-listing:${vaultId}:${directoryId}`;
}

/** Browser-local high-water mark detects rolled-back/same-revision heads across navigations. */
export function rememberListing(vaultId: string, directoryId: string, revision: number, digest: string): void {
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

export async function signListingChange(access: RootAccess, listing: DirectoryListing, parentKey: Uint8Array,
  updated: SealedEntry[]): Promise<ListingHead> {
  if (!listing.directoryId) throw new Error("invalid directory listing");
  const device = await getDevice(access.vaultId);
  if (!device) throw new Error("private tree unavailable");
  return createListingHead(parentKey, device.assertionKeyPair.privateKey, {
    vaultId: access.vaultId, directoryId: listing.directoryId, deviceId: device.deviceId,
    revision: listing.entriesRevision + 1, entries: updated,
  });
}

export async function createTreeChild(access: RootAccess, parentId: string,
  input: { nodeId: string; kind: TreeKind; expectedRevision: number;
    nameCiphertext: string; orderCiphertext: string; keyEnvelope: string },
  listing: DirectoryListing, parentKey: Uint8Array) {
  if (isSignupRecoveryConfirmationPending()) throw new RecoveryConfirmationPendingError();
  if (listing.directoryId !== parentId || input.expectedRevision !== listing.entriesRevision) throw new Error("invalid directory listing");
  const head = await signListingChange(access, listing, parentKey, [...listing.entries, input]);
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
