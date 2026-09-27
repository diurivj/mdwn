import { createSymmetricWriter, openSymmetric } from "~/crypto/enc-v1";
import {
  createChildDirectoryCapability, createFileRepresentation, decodeFileRepresentation,
  openDeviceEnrollmentEnvelope, openVaultRecoveryEnvelope,
} from "~/crypto/vault";
import { privateRequest } from "~/device/private-client";
import { getDevice } from "~/device/store";
import { canonicalizeSegment, sameComparisonKey } from "~/namespace-v1";
import { newOpaqueId } from "~/opaque-id";
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

export type TreeKind = "directory" | "file";
export type TreeEntry = { nodeId: string; kind: TreeKind; name: string; order: string; keyEnvelope: string };
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

async function jsonResource<T>(path: string, method: "POST" | "PUT" | "PATCH", body?: object): Promise<T> {
  const response = await privateRequest(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.status === 404) throw new TreeNotFoundError();
  if (response.status === 409) throw new NamespaceChangedError();
  if (!response.ok) throw new Error("private tree unavailable");
  return response.json() as Promise<T>;
}

export class NamespaceChangedError extends Error {
  constructor() { super("namespace_changed"); }
}

/** Browser possession + proof-guarded bootstrap; keys never enter loaders or document HTML. */
export async function openRoot(): Promise<RootAccess> {
  const state = await fetch("/api/device/state", { cache: "no-store" });
  if (!state.ok) throw new Error("private tree unavailable");
  const { accountId, deviceId } = await state.json() as { accountId: string; deviceId: string | null };
  if (!deviceId) throw new Error("private tree unavailable");
  const device = await getDevice(accountId);
  if (!device || device.deviceId !== deviceId) throw new Error("private tree unavailable");
  const response = await privateRequest("/api/private/bootstrap", { method: "POST" });
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

export async function loadDirectory(access: RootAccess, directoryId: string, key: Uint8Array): Promise<DirectoryListing> {
  const listing = await jsonResource<{ directoryId: string; entriesRevision: number; entries: Array<{
    nodeId: string; kind: TreeKind; nameCiphertext: string; orderCiphertext: string; keyEnvelope: string;
  }> }>(`/api/private/tree/directories/${directoryId}`, "POST");
  if (listing.directoryId !== directoryId || !Number.isSafeInteger(listing.entriesRevision) || listing.entriesRevision < 1) {
    throw new Error("invalid directory listing");
  }
  const entries = await Promise.all(listing.entries.map(async (entry): Promise<TreeEntry> => {
    const context = metadataContext(access.vaultId, directoryId, entry.nodeId);
    const name = decoder.decode(await openSymmetric(decodeTreeBytes(entry.nameCiphertext), key, { context }));
    const order = decoder.decode(await openSymmetric(decodeTreeBytes(entry.orderCiphertext), key, { context }));
    if (canonicalizeSegment(name).display !== name || order.length > 256 || !order) {
      throw new Error("invalid directory listing");
    }
    return { nodeId: entry.nodeId, kind: entry.kind, name, order, keyEnvelope: entry.keyEnvelope };
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

export async function loadAncestors(nodeId: string): Promise<string[]> {
  const result = await jsonResource<{ ancestors: string[] }>(`/api/private/tree/nodes/${nodeId}/ancestors`, "POST");
  if (!Array.isArray(result.ancestors) || result.ancestors.at(-1) !== nodeId ||
      result.ancestors.length > 101) throw new Error("invalid tree path");
  return result.ancestors;
}

export async function loadFile(access: RootAccess, fileId: string, parentKey: Uint8Array) {
  const file = await jsonResource<{ fileId: string; parentId: string; revision: number; representationId: string;
    contentKeyId: string; keyEpoch: number; ciphertext: string; keyEnvelope: string;
  }>(`/api/private/tree/files/${fileId}`, "POST");
  const context = { vaultId: access.vaultId, objectId: fileId,
    keyId: file.contentKeyId, keyEpoch: file.keyEpoch, revision: file.revision };
  const key = await openSymmetric(decodeTreeBytes(file.keyEnvelope), parentKey,
    { context: { ...context, purpose: "file-content-key" } });
  const content = await openSymmetric(decodeTreeBytes(file.ciphertext, 524_288), key,
    { context: { ...context, purpose: "file-content" } });
  return { parentId: file.parentId, revision: file.revision, markdown: decodeFileRepresentation(content).markdown };
}

export async function createTreeChild(access: RootAccess, parentId: string, input: object) {
  return jsonResource<{ nodeId: string; entriesRevision: number }>(
    `/api/private/tree/directories/${parentId}/children`, "PUT", input);
}
export async function renameTreeChild(nodeId: string, input: object) {
  return jsonResource<{ entriesRevision: number }>(`/api/private/tree/nodes/${nodeId}/name`, "PATCH", input);
}
