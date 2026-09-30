import { FILE_SOURCE_LIMIT, fileSourceBytes } from "~/crypto/file-source";
import { createFileRepresentation } from "~/crypto/vault";
import { privateRequest } from "~/device/private-client";
import { newOpaqueId } from "~/opaque-id";
import type { ListingHead } from "./listing";
import { signListingChange, type DirectoryListing, type loadFile, type RootAccess } from "./client";
import { encodeTreeBytes } from "./wire";

export type FileDocument = Awaited<ReturnType<typeof loadFile>>;
export type FileSavePayload = {
  expectedRevision: number; expectedParentRevision: number; keyEnvelope: string;
  representation: { id: string; contentKeyId: string; keyEpoch: number; revision: number; ciphertext: string };
  listingHead: ListingHead;
};
export type FileSaveResult = { operationId: string } & (
  { state: "saved"; revision: number; entriesRevision: number } |
  { state: "conflict" | "folder-changed" | "failed" }
);

/** Runs only as a browser clientAction: neither plaintext nor keys are submitted to a route. */
export async function fileSaveAction(fileId: string, request: Request): Promise<FileSaveResult> {
  const { operationId, payload } = await request.json() as { operationId: string; payload: FileSavePayload };
  try {
    const response = await privateRequest(`/api/private/tree/files/${fileId}`, {
      method: "PATCH", body: JSON.stringify(payload), signal: request.signal,
    });
    if (response.status === 409) {
      const body = await response.json() as { error: string };
      return { operationId, state: body.error === "namespace_changed" ? "folder-changed" : "conflict" };
    }
    if (!response.ok) return { operationId, state: "failed" };
    const saved = await response.json() as { revision: number; entriesRevision: number };
    if (saved.revision !== payload.expectedRevision + 1 || saved.entriesRevision !== payload.expectedParentRevision + 1) {
      return { operationId, state: "failed" };
    }
    return { operationId, state: "saved", ...saved };
  } catch { return { operationId, state: "failed" }; }
}

/** Rebuild the parent commitment without changing the draft's expected File revision. */
export async function withFileListing(access: RootAccess, fileId: string, parentKey: Uint8Array,
  payload: Omit<FileSavePayload, "listingHead" | "expectedParentRevision">, listing: DirectoryListing) {
  if (!listing.entries.some((entry) => entry.nodeId === fileId && entry.kind === "file")) {
    throw new Error("File unavailable");
  }
  const updated: DirectoryListing = { ...listing, entriesRevision: listing.entriesRevision + 1,
    entries: listing.entries.map((entry) => entry.nodeId === fileId ? { ...entry, keyEnvelope: payload.keyEnvelope } : entry) };
  const head = await signListingChange(access, listing, parentKey, updated.entries);
  return { payload: { ...payload, expectedParentRevision: listing.entriesRevision, listingHead: head }, listing: updated };
}

export async function prepareFileSave(access: RootAccess, fileId: string, parentKey: Uint8Array,
  document: FileDocument, markdown: string, listing: DirectoryListing) {
  const sourceBytes = fileSourceBytes(markdown);
  if (sourceBytes > FILE_SOURCE_LIMIT) throw new Error("File limit reached");
  const revision = document.revision + 1, keyEpoch = document.keyEpoch + 1;
  const contentKeyId = newOpaqueId(), representationId = newOpaqueId();
  const encrypted = await createFileRepresentation(parentKey, { markdown, metadata: document.metadata }, {
    vaultId: access.vaultId, fileId, keyId: contentKeyId, keyEpoch, revision,
  });
  return { ...await withFileListing(access, fileId, parentKey, {
    expectedRevision: document.revision, keyEnvelope: encodeTreeBytes(encrypted.fileContentKeyEnvelope),
    representation: { id: representationId, contentKeyId, keyEpoch, revision, ciphertext: encodeTreeBytes(encrypted.contentEnvelope) },
  }, listing), document: { ...document, markdown, sourceBytes, revision, keyEpoch, contentKeyId, representationId } };
}
