import { readPseudonym } from "~/account/profile-client";
import { FILE_SOURCE_LIMIT } from "~/crypto/file-source";
import { privateRequest } from "~/device/private-client";
import { loadDirectory, loadFile, type FilePublication, type RootAccess } from "~/tree/client";
import { convertFileCapability } from "~/tree/file-capability-client";
import { encodeTreeBytes } from "~/tree/wire";
import { createPublicationKeyPair, newPublicationIdentifier, publicLinkUrl } from "./capability";
import { publicPresentation, sealAuthorDeclaration, sealPublicRepresentation } from "./content";

export type PublicationState = {
  fileId: string; isOwner: boolean; canEdit: boolean;
  publication: null | { publicationId: string; state: "active" | "deleting"; createdAt: number;
    authors: { declarationId: string; ordinal: number; self: boolean; declared: boolean }[] };
  requests: { requestId: string; own: boolean; createdAt: number }[];
};

/** A bounded, non-revealing failure the Publish panel can explain. */
export class PublicationError extends Error {
  constructor(readonly code: "changed" | "exists" | "file-changed" | "limited" | "not-found" | "too-large"
    | "author-exists" | "author-limit" | "unavailable") { super(code); }
}

async function publicationRequest(path: string, method: "POST" | "PUT" | "DELETE", body?: object, signal?: AbortSignal) {
  const response = await privateRequest(`/api/private/publications/files/${path}`, {
    method, signal, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.ok) return response;
  if (response.status === 404) throw new PublicationError("not-found");
  if (response.status === 429) throw new PublicationError("limited");
  if (response.status === 409) {
    const error = (await response.json() as { error?: string }).error;
    throw new PublicationError(error === "publication_exists" ? "exists" : error === "file_changed" ? "file-changed"
      : error === "author_exists" ? "author-exists" : error === "author_limit" ? "author-limit" : "changed");
  }
  throw new PublicationError("unavailable");
}

export async function loadPublicationState(fileId: string, signal?: AbortSignal): Promise<PublicationState> {
  return (await publicationRequest(fileId, "POST", undefined, signal)).json() as Promise<PublicationState>;
}

/**
 * The Owner's browser publishes the latest saved representation. It creates the
 * link key pair and identifiers locally, sends only the public key, path and
 * ciphertext, and returns the complete link. The `#` key never leaves here.
 */
export async function publishFile(options: { access: RootAccess; fileId: string; parentId: string | null;
  parentKey: Uint8Array; includeSelf: boolean; signal?: AbortSignal }): Promise<{ url: string }> {
  const { access, fileId, parentKey, signal } = options;
  let document = await loadFile(access, fileId, parentKey, signal);
  if (document.sourceBytes > FILE_SOURCE_LIMIT) throw new PublicationError("too-large");
  if (!document.capability) {
    // A legacy parent-wrapped File first gets its stable File capability, so
    // every later paired save is a parent-free converted save.
    if (!options.parentId) throw new PublicationError("unavailable");
    const listing = await loadDirectory(access, options.parentId, parentKey, signal);
    await convertFileCapability(access, fileId, document, parentKey, listing, signal);
    document = await loadFile(access, fileId, parentKey, signal);
  }
  const keys = await createPublicationKeyPair();
  const publicationId = newPublicationIdentifier(), linkId = newPublicationIdentifier();
  const binding = { publicationId, linkId, publicKey: keys.publicKey };
  const ciphertext = await sealPublicRepresentation({ ...binding, revision: 1 }, publicPresentation(document.markdown));
  let author = null;
  if (options.includeSelf) {
    const declarationId = newPublicationIdentifier();
    author = { declarationId, ciphertext: encodeTreeBytes(await sealAuthorDeclaration(
      { ...binding, declarationId, revision: 1 }, await readPseudonym(access, signal))) };
  }
  await publicationRequest(fileId, "PUT", { publicationId, linkId, publicKey: encodeTreeBytes(keys.publicKey),
    expectedRevision: document.revision, expectedRepresentationId: document.representationId,
    representation: { ciphertext: encodeTreeBytes(ciphertext) }, author }, signal);
  return { url: publicLinkUrl(location.origin, linkId, keys.privateKey) };
}

export async function requestPublication(fileId: string, signal?: AbortSignal) {
  await publicationRequest(`${fileId}/requests`, "POST", {}, signal);
}

/** The requester cancels, or the Owner denies: both hard-delete the request. */
export async function removePublicationRequest(fileId: string, requestId: string, signal?: AbortSignal) {
  await publicationRequest(`${fileId}/requests/${requestId}`, "DELETE", {}, signal);
}

/** The Owner credits itself; its own device writes the declaration immediately. */
export async function addSelfAuthor(access: RootAccess, fileId: string, publication: FilePublication, signal?: AbortSignal) {
  const declarationId = newPublicationIdentifier();
  const ciphertext = await sealAuthorDeclaration({ publicationId: publication.publicationId, linkId: publication.linkId,
    publicKey: publication.publicKey, declarationId, revision: 1 }, await readPseudonym(access, signal));
  await publicationRequest(`${fileId}/authors`, "PUT", { publicationId: publication.publicationId, declarationId,
    account: { self: true }, declaration: { linkId: publication.linkId, ciphertext: encodeTreeBytes(ciphertext) } }, signal);
}

/** The Owner selects a Collaborator by exact share handle or share identifier. */
export async function addAccountAuthor(fileId: string, publicationId: string, address: string, signal?: AbortSignal) {
  const value = address.trim() === address ? address : "";
  const account = /^[A-Za-z0-9_-]{3,32}$/.test(value) ? { handle: value } : { shareId: value };
  if (!value) throw new PublicationError("not-found");
  try {
    await publicationRequest(`${fileId}/authors`, "PUT", { publicationId, declarationId: newPublicationIdentifier(),
      account, declaration: null }, signal);
  } catch (error) {
    // A share identifier can also look like a handle; try the other exact form once.
    if (!(error instanceof PublicationError) || error.code !== "not-found" || !("handle" in account)) throw error;
    await publicationRequest(`${fileId}/authors`, "PUT", { publicationId, declarationId: newPublicationIdentifier(),
      account: { shareId: value }, declaration: null }, signal);
  }
}

export async function removeAuthor(fileId: string, declarationId: string, signal?: AbortSignal) {
  await publicationRequest(`${fileId}/authors/${declarationId}`, "DELETE", {}, signal);
}

/** A selected author's own device declares its Public pseudonym to the current link. */
export async function declarePublicationAuthor(access: RootAccess, fileId: string, publication: FilePublication,
  signal?: AbortSignal) {
  const declaration = publication.declaration;
  if (!declaration || declaration.current) return;
  const revision = declaration.revision + 1;
  const ciphertext = await sealAuthorDeclaration({ publicationId: publication.publicationId, linkId: publication.linkId,
    publicKey: publication.publicKey, declarationId: declaration.declarationId, revision }, await readPseudonym(access, signal));
  await publicationRequest(`${fileId}/authors/${declaration.declarationId}/declaration`, "PUT", {
    publicationId: publication.publicationId, linkId: publication.linkId, revision, ciphertext: encodeTreeBytes(ciphertext) }, signal);
}
