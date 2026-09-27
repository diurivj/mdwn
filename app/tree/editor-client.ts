import { createFileRepresentation } from "~/crypto/vault";
import { privateRequest } from "~/device/private-client";
import { getDevice } from "~/device/store";
import { newOpaqueId } from "~/opaque-id";
import { loadDirectory, type DirectoryListing, type LoadedFile, type RootAccess } from "./client";
import { createListingHead } from "./listing";
import { encodeTreeBytes } from "./wire";

export const FILE_SOURCE_LIMIT = 262_144;
export const FILE_LIMIT_FEEDBACK = 235_930;
const encoder = new TextEncoder();

export const sourceBytes = (source: string): number => encoder.encode(source).byteLength;
export const withinFileLimit = (source: string): boolean => sourceBytes(source) <= FILE_SOURCE_LIMIT;

export class FileChangedError extends Error {
  constructor() { super("file_changed"); }
}
export class FileSaveUncertainError extends Error {
  constructor() { super("file_save_uncertain"); }
}

/** Only the browser sees source and metadata. The signed head also commits to the new parent envelope. */
export async function commitFileSave(options: {
  access: RootAccess; fileId: string; file: LoadedFile; source: string;
  listing: DirectoryListing; parentKey: Uint8Array;
}): Promise<{ file: LoadedFile; listing: DirectoryListing }> {
  const { access, fileId, file, source, listing, parentKey } = options;
  if (!withinFileLimit(source) || listing.directoryId !== file.parentId ||
      !listing.entries.some((entry) => entry.nodeId === fileId && entry.kind === "file")) {
    throw new Error("invalid File save");
  }
  const device = await getDevice(access.vaultId);
  if (!device) throw new Error("private File unavailable");
  const contentKeyId = newOpaqueId(), representationId = newOpaqueId(), revision = file.revision + 1;
  const fresh = await createFileRepresentation(parentKey, { markdown: source, metadata: file.metadata },
    { vaultId: access.vaultId, fileId, keyId: contentKeyId, keyEpoch: 1, revision });
  const keyEnvelope = encodeTreeBytes(fresh.fileContentKeyEnvelope);
  const head = await createListingHead(parentKey, device.assertionKeyPair.privateKey, {
    vaultId: access.vaultId, directoryId: file.parentId, deviceId: device.deviceId,
    revision: listing.entriesRevision + 1,
    entries: listing.entries.map((entry) => entry.nodeId === fileId ? { ...entry, keyEnvelope } : entry),
  });
  const response = await privateRequest(`/api/private/tree/files/${fileId}`, { method: "PATCH", body: JSON.stringify({
    expectedRevision: file.revision, expectedEntriesRevision: listing.entriesRevision, keyEnvelope,
    listingHead: head, representation: { id: representationId, contentKeyId, keyEpoch: 1,
      revision, ciphertext: encodeTreeBytes(fresh.contentEnvelope) },
  }) });
  if (response.status === 409) throw new FileChangedError();
  if (!response.ok) throw new Error("File save failed");
  const committed = await response.json() as { revision: number; entriesRevision: number };
  if (committed.revision !== revision || committed.entriesRevision !== listing.entriesRevision + 1) {
    throw new FileSaveUncertainError();
  }
  // Do not display an unsigned or stale parent entry after rotating its File key.
  let current: DirectoryListing;
  try { current = await loadDirectory(access, file.parentId, parentKey); }
  catch { throw new FileSaveUncertainError(); }
  if (current.entriesRevision !== committed.entriesRevision ||
      current.entries.find((entry) => entry.nodeId === fileId)?.keyEnvelope !== keyEnvelope) {
    throw new FileSaveUncertainError();
  }
  return { file: { ...file, revision, representationId, contentKeyId, keyEpoch: 1, markdown: source },
    listing: current };
}
