import { FILE_SOURCE_LIMIT, fileSourceBytes } from "~/crypto/file-source";
import { createFileRepresentation } from "~/crypto/vault";
import { privateRequest } from "~/device/private-client";
import { getDevice } from "~/device/store";
import { newOpaqueId } from "~/opaque-id";
import { publicPresentation, sealPublicRepresentation } from "~/publications/content";
import type { ListingHead } from "./listing";
import { signListingChange, type DirectoryListing, type loadFile, type RootAccess } from "./client";
import { createFileHead, type FileHead } from "./file-head";
import type { FileCapability } from "./file-capability-client";
import { encodeTreeBytes } from "./wire";

export type FileDocument = Awaited<ReturnType<typeof loadFile>>;
type Representation = { id: string; contentKeyId: string; keyEpoch: number; revision: number; ciphertext: string };
export type LegacyFileSavePayload = {
  expectedRevision: number; expectedParentRevision: number; keyEnvelope: string;
  representation: Representation; listingHead: ListingHead;
};
/** The Public representation of the same draft, encrypted to the stored link key. */
export type PublicationSavePayload = { publicationId: string; linkId: string; revision: number; ciphertext: string };
export type CapabilityFileSavePayload = {
  expectedRevision: number; expectedRepresentationId: string; capability: FileCapability;
  representation: Representation & { keyEnvelope: string; fileHead: FileHead };
  publication?: PublicationSavePayload;
};
export type FileSavePayload = LegacyFileSavePayload | CapabilityFileSavePayload;
export type FileSaveResult = { operationId: string } & (
  { state: "saved"; revision: number; entriesRevision?: number; representationId?: string; capability?: FileCapability;
    publicRevision?: number } |
  // "refresh": the File's capability or Publication changed under an unchanged revision.
  { state: "conflict" | "folder-changed" | "refresh" | "failed" }
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
      return { operationId, state: body.error === "namespace_changed" && !("capability" in payload) ? "folder-changed"
        : body.error === "file_changed" ? "conflict"
          : body.error === "publication_changed" || body.error === "file_converted" ? "refresh" : "failed" };
    }
    if (!response.ok) return { operationId, state: "failed" };
    const saved = await response.json() as { revision: number; entriesRevision?: number; representationId?: string;
      capability?: FileCapability; publicRevision?: number };
    if (saved.revision !== payload.expectedRevision + 1 || ("capability" in payload
      ? saved.representationId !== payload.representation.id || saved.capability?.id !== payload.capability.id ||
        saved.capability?.epoch !== payload.capability.epoch || saved.publicRevision !== payload.publication?.revision
      : saved.entriesRevision !== payload.expectedParentRevision + 1)) return { operationId, state: "failed" };
    return { operationId, state: "saved", ...saved };
  } catch { return { operationId, state: "failed" }; }
}

/** Rebuild the legacy parent commitment without changing the draft's expected File revision. */
export async function withFileListing(access: RootAccess, fileId: string, parentKey: Uint8Array,
  payload: Omit<LegacyFileSavePayload, "listingHead" | "expectedParentRevision">, listing: DirectoryListing) {
  if (!listing.entries.some((entry) => entry.nodeId === fileId && entry.kind === "file")) throw new Error("File unavailable");
  const updated: DirectoryListing = { ...listing, entriesRevision: listing.entriesRevision + 1,
    entries: listing.entries.map((entry) => entry.nodeId === fileId ? { ...entry, keyEnvelope: payload.keyEnvelope } : entry) };
  const head = await signListingChange(access, listing, parentKey, updated.entries);
  return { payload: { ...payload, expectedParentRevision: listing.entriesRevision, listingHead: head }, listing: updated };
}

export async function prepareFileSave(access: RootAccess, fileId: string, parentKey: Uint8Array,
  document: FileDocument, markdown: string, listing: DirectoryListing | null): Promise<{
    payload: FileSavePayload; listing: DirectoryListing | null; document: FileDocument;
  }> {
  if (!document.canEdit) throw new Error("File is read-only");
  const sourceBytes = fileSourceBytes(markdown);
  if (sourceBytes > FILE_SOURCE_LIMIT) throw new Error("File limit reached");
  const revision = document.revision + 1, keyEpoch = document.keyEpoch + 1;
  const contentKeyId = newOpaqueId(), representationId = newOpaqueId();
  const encrypted = await createFileRepresentation(document.capabilityKey ?? parentKey, { markdown, metadata: document.metadata }, {
    vaultId: access.vaultId, fileId, keyId: contentKeyId, keyEpoch, revision,
  });
  const wrapper = encodeTreeBytes(encrypted.fileContentKeyEnvelope);
  const representation = { id: representationId, contentKeyId, keyEpoch, revision, ciphertext: encodeTreeBytes(encrypted.contentEnvelope) };
  // An editor pairs the same draft's Public representation using only the stored public key.
  const published = document.publication && document.publication.revision !== null ? document.publication : null;
  if (published && !document.capability) throw new Error("Published File must use a File capability");
  const publication: PublicationSavePayload | undefined = published ? { publicationId: published.publicationId,
    linkId: published.linkId, revision: published.revision! + 1,
    ciphertext: encodeTreeBytes(await sealPublicRepresentation({ publicationId: published.publicationId, linkId: published.linkId,
      publicKey: published.publicKey, revision: published.revision! + 1 }, publicPresentation(markdown))) } : undefined;
  const savedDocument: FileDocument = { ...document, markdown, sourceBytes, revision, keyEpoch, contentKeyId, representationId,
    ciphertext: representation.ciphertext, ...(document.capability ? { representationKeyEnvelope: wrapper } : { keyEnvelope: wrapper }),
    publication: published && publication ? { ...published, revision: publication.revision } : document.publication };
  if (document.capability) {
    if (!document.capabilityKey) throw new Error("missing File capability");
    const device = await getDevice(access.actorAccountId);
    if (!device) throw new Error("private tree unavailable");
    const fileHead = await createFileHead(device.assertionKeyPair.privateKey, {
      vaultId: access.vaultId, fileId, capabilityId: document.capability.id, capabilityEpoch: document.capability.epoch,
      representationId, contentKeyId, keyEpoch, revision, deviceId: device.deviceId,
      ciphertext: representation.ciphertext, keyEnvelope: wrapper,
    });
    return { payload: { expectedRevision: document.revision, expectedRepresentationId: document.representationId,
      capability: document.capability, representation: { ...representation, keyEnvelope: wrapper, fileHead },
      ...(publication ? { publication } : {}) }, listing, document: savedDocument };
  }
  if (!listing || !document.parentId) throw new Error("File parent unavailable");
  return { ...await withFileListing(access, fileId, parentKey, {
    expectedRevision: document.revision, keyEnvelope: wrapper, representation,
  }, listing), document: savedDocument };
}
