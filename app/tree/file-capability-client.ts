import { createSymmetricWriter, openSymmetric } from "~/crypto/enc-v1";
import { privateRequest } from "~/device/private-client";
import { getDevice } from "~/device/store";
import { newOpaqueId } from "~/opaque-id";
import { isSignupRecoveryConfirmationPending, RecoveryConfirmationPendingError } from "~/signup/recovery-gate";
import { signListingChange, rememberListing, NamespaceChangedError, TreeCommitUncertainError, type RootAccess, type DirectoryListing } from "./client";
import type { FileDocument } from "./file-client";
import { createFileHead } from "./file-head";
import { decodeTreeBytes, encodeTreeBytes } from "./wire";

export type FileCapability = { id: string; epoch: number };
export function fileCapabilityContext(vaultId: string, fileId: string, capability: FileCapability) {
  return { purpose: "file-capability" as const, vaultId, objectId: fileId,
    keyId: capability.id, keyEpoch: capability.epoch, revision: 1 };
}

/** Returns transport-safe ciphertext only; the random scope key never leaves this function. */
export async function prepareFileCapabilityConversion(access: RootAccess, fileId: string,
  document: FileDocument, parentKey: Uint8Array, listing: DirectoryListing) {
  if (!document.canEdit || document.capability || !document.parentId || listing.directoryId !== document.parentId || listing.canCreate === false ||
      !listing.entries.some((entry) => entry.nodeId === fileId && entry.kind === "file")) throw new Error("File conversion unavailable");
  const capability = { id: newOpaqueId(), epoch: 1 };
  const scopeKey = crypto.getRandomValues(new Uint8Array(32));
  const context = { purpose: "file-content-key" as const, vaultId: access.vaultId, objectId: fileId,
    keyId: document.contentKeyId, keyEpoch: document.keyEpoch, revision: document.revision };
  const contentKey = await openSymmetric(decodeTreeBytes(document.keyEnvelope!), parentKey, { context });
  const keyEnvelope = encodeTreeBytes(await (await createSymmetricWriter(parentKey)).seal(scopeKey,
    fileCapabilityContext(access.vaultId, fileId, capability)));
  const representationKeyEnvelope = encodeTreeBytes(await (await createSymmetricWriter(scopeKey)).seal(contentKey, context));
  const device = await getDevice(access.actorAccountId);
  if (!device) throw new Error("private tree unavailable");
  const fileHead = await createFileHead(device.assertionKeyPair.privateKey, {
    vaultId: access.vaultId, fileId, capabilityId: capability.id, capabilityEpoch: capability.epoch,
    representationId: document.representationId, contentKeyId: document.contentKeyId, keyEpoch: document.keyEpoch,
    revision: document.revision, deviceId: device.deviceId, ciphertext: document.ciphertext, keyEnvelope: representationKeyEnvelope,
  });
  const listingHead = await signListingChange(access, listing, parentKey,
    listing.entries.map((entry) => entry.nodeId === fileId ? { ...entry, keyEnvelope } : entry));
  return { expectedRevision: document.revision, expectedRepresentationId: document.representationId,
    expectedParentRevision: listing.entriesRevision, capability, keyEnvelope, representationKeyEnvelope, fileHead, listingHead };
}

/** Conditional conversion is one atomic request, never a post-create follow-up. */
export async function convertFileCapability(access: RootAccess, fileId: string, document: FileDocument,
  parentKey: Uint8Array, listing: DirectoryListing, signal?: AbortSignal) {
  if (isSignupRecoveryConfirmationPending()) throw new RecoveryConfirmationPendingError();
  const payload = await prepareFileCapabilityConversion(access, fileId, document, parentKey, listing);
  const response = await privateRequest(`/api/private/tree/files/${fileId}/capability`, {
    method: "PUT", body: JSON.stringify(payload), signal,
  });
  if (response.status === 409) {
    const body = await response.json() as { error?: string };
    if (body.error === "namespace_changed") throw new NamespaceChangedError();
    throw new Error("File conversion changed");
  }
  if (!response.ok) throw new Error("File conversion unavailable");
  const result = await response.json() as { entriesRevision: number };
  try { rememberListing(access.vaultId, listing.directoryId, result.entriesRevision, payload.listingHead.digest); }
  catch { throw new TreeCommitUncertainError(); }
  return result;
}

export function rememberFile(vaultId: string, fileId: string, epoch: number, revision: number, digest: string) {
  if (typeof window === "undefined") return;
  const key = `mdwn:file-head:${vaultId}:${fileId}`;
  const previous = localStorage.getItem(key);
  if (previous) {
    const parsed: unknown = JSON.parse(previous);
    if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== "number" ||
        typeof parsed[1] !== "number" || typeof parsed[2] !== "string" || epoch < parsed[0] || revision < parsed[1] ||
        (epoch === parsed[0] && revision === parsed[1] && digest !== parsed[2])) throw new Error("replayed-file-head");
  }
  localStorage.setItem(key, JSON.stringify([epoch, revision, digest]));
}
