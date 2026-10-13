import { readPseudonym } from "~/shared/account/profile-client";
import { loadFilePublicEpochs } from "~/comments/public-client";
import { sealCommentEpochLink } from "~/shared/comments/public-content";
import { openVaultRecoveryEnvelope, sealVaultRecoveryEnvelope } from "~/shared/crypto/vault";
import { FILE_SOURCE_LIMIT } from "~/shared/crypto/file-source";
import { privateRequest, isPublicParticipationSuspended } from "~/shared/device/private-client";
import { newOpaqueId } from "~/shared/opaque-id";
import {
  PublicationError,
  type CommentAudience,
  type PreparedPublicLink,
  type PublicationState,
  type TeardownProgress,
} from "~/shared/publications/lifecycle";
import { loadDirectory, loadFile, type FilePublication, type RootAccess } from "~/shared/tree/client";
import { convertFileCapability } from "~/shared/tree/file-capability-client";
import { decodeTreeBytes, encodeTreeBytes } from "~/shared/tree/wire";
import {
  createPublicationKeyPair,
  MAX_OWNER_LINK_BYTES,
  newPublicationIdentifier,
  ownerLinkContext,
  parsePublicationFragment,
  publicLinkUrl,
} from "../shared/publications/capability";
import { publicPresentation, sealAuthorDeclaration, sealPublicRepresentation } from "../shared/publications/content";

/**
 * The Owner link copy (ticket 68): the new link's private scalar sealed under
 * the Owner's own Vault root key. Only a browser holding that key — one of the
 * Owner's devices, or one restored with the Vault recovery phrase — can open it.
 */
async function sealOwnerLink(
  access: RootAccess,
  link: { publicationId: string; linkId: string },
  privateKey: Uint8Array,
): Promise<string> {
  return encodeTreeBytes(
    await sealVaultRecoveryEnvelope(
      access.actorVaultRootKey,
      { scope: "owned", objectId: link.linkId, keyId: link.publicationId, key: privateKey },
      ownerLinkContext(access.actorAccountId, link.publicationId, link.linkId),
    ),
  );
}

/** The complete link from an Owner link copy, or null when it does not open
 * here for exactly this Publication and path. The service chose neither key
 * nor binding, so a substituted or replayed copy simply fails to open. */
async function openOwnerLink(
  access: RootAccess,
  link: { publicationId: string; linkId: string },
  envelope: string,
): Promise<string | null> {
  try {
    const privateKey = await openVaultRecoveryEnvelope(
      decodeTreeBytes(envelope, MAX_OWNER_LINK_BYTES),
      access.actorVaultRootKey,
      ownerLinkContext(access.actorAccountId, link.publicationId, link.linkId),
    );
    return publicLinkUrl(location.origin, link.linkId, privateKey);
  } catch {
    return null;
  }
}

/** One fresh audience epoch: an Owner recovery envelope and, for a public
 * epoch, the symmetric wrapper to the Publication capability (fragment only). */
async function commentEpoch(
  access: RootAccess,
  input: {
    publicationId: string;
    linkId: string;
    publicKey: Uint8Array;
    audience: CommentAudience;
    privateKey: Uint8Array<ArrayBuffer> | null;
    threadId: string;
  },
) {
  const epochId = newOpaqueId(),
    capabilityId = newOpaqueId();
  const capability = crypto.getRandomValues(new Uint8Array(32));
  const recoveryEnvelope = await sealVaultRecoveryEnvelope(
    access.actorVaultRootKey,
    { scope: "owned", objectId: epochId, keyId: capabilityId, key: capability },
    {
      purpose: "vault-recovery",
      vaultId: access.actorAccountId,
      objectId: epochId,
      keyId: capabilityId,
      keyEpoch: 1,
      revision: 1,
    },
  );
  const linkWrapper =
    input.audience === "public"
      ? encodeTreeBytes(
          await sealCommentEpochLink(input.privateKey!, input.publicKey, {
            publicationId: input.publicationId,
            linkId: input.linkId,
            epochId,
            capabilityId,
            keyEpoch: 1,
            capability,
          }),
        )
      : null;
  return {
    threadId: input.threadId,
    epochId,
    capabilityId,
    audience: input.audience,
    recoveryEnvelope: encodeTreeBytes(recoveryEnvelope),
    linkWrapper,
  };
}

async function publicationRequest(
  path: string,
  method: "POST" | "PUT" | "DELETE",
  body?: object,
  signal?: AbortSignal,
) {
  let response: Response;
  try {
    response = await privateRequest(`/api/private/publications/files/${path}`, {
      method,
      signal,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (isPublicParticipationSuspended(error)) {
      throw new PublicationError("suspended", error.detail.suspendedUntil);
    }
    throw error;
  }
  if (response.ok) return response;
  if (response.status === 404) throw new PublicationError("not-found");
  if (response.status === 429) throw new PublicationError("limited");
  if (response.status === 409) {
    const error = ((await response.json()) as { error?: string }).error;
    throw new PublicationError(
      error === "publication_exists"
        ? "exists"
        : error === "file_changed"
          ? "file-changed"
          : error === "author_exists"
            ? "author-exists"
            : error === "author_limit"
              ? "author-limit"
              : error === "pseudonym_update_pending"
                ? "pseudonym-pending"
                : error === "key_rotation_required"
                  ? "rotation-required"
                  : "changed",
    );
  }
  throw new PublicationError("unavailable");
}

type PublicationStateWire = Omit<PublicationState, "publication"> & {
  publication:
    | null
    | (Omit<NonNullable<PublicationState["publication"]>, "link"> & {
        /** Owner only: the active link's Owner link copy, when it has one. */
        ownerLink?: string | null;
      });
};

/** The panel state, with the Owner's link copy opened into its complete link
 * in this browser. The ciphertext goes no further than this function. */
export async function loadPublicationState(
  access: RootAccess,
  fileId: string,
  signal?: AbortSignal,
): Promise<PublicationState> {
  const state = (await (await publicationRequest(fileId, "POST", undefined, signal)).json()) as PublicationStateWire;
  if (!state.publication) return { ...state, publication: null };
  const { ownerLink, ...publication } = state.publication;
  const link =
    ownerLink && publication.linkId
      ? await openOwnerLink(access, { publicationId: publication.publicationId, linkId: publication.linkId }, ownerLink)
      : null;
  return { ...state, publication: { ...publication, link } };
}

/**
 * The Owner's browser publishes the latest saved representation. It creates the
 * link key pair and identifiers locally, sends only the public key, path,
 * ciphertext and the Owner link copy sealed to its own Vault root key, and
 * retains/returns the complete link only in browser memory. The `#` key never
 * leaves the browser readable.
 */
export async function publishFile(options: {
  access: RootAccess;
  fileId: string;
  parentId: string | null;
  parentKey: Uint8Array;
  includeSelf: boolean;
  audience?: CommentAudience;
  signal?: AbortSignal;
  onPrepared: (link: PreparedPublicLink) => void;
}): Promise<PreparedPublicLink> {
  const { access, fileId, parentKey, signal } = options;
  let document = await loadFile(access, fileId, parentKey, signal);
  if (document.sourceBytes > FILE_SOURCE_LIMIT) throw new PublicationError("too-large");
  if (document.publication) throw new PublicationError("exists");
  if (!document.capability) {
    // A legacy parent-wrapped File first gets its stable File capability, so
    // every later paired save is a parent-free converted save.
    if (!options.parentId) throw new PublicationError("unavailable");
    const listing = await loadDirectory(access, options.parentId, parentKey, signal);
    await convertFileCapability(access, fileId, document, parentKey, listing, signal);
    document = await loadFile(access, fileId, parentKey, signal);
  }
  const keys = await createPublicationKeyPair();
  const publicationId = newPublicationIdentifier(),
    linkId = newPublicationIdentifier();
  const binding = { publicationId, linkId, publicKey: keys.publicKey };
  const ciphertext = await sealPublicRepresentation({ ...binding, revision: 1 }, publicPresentation(document.markdown));
  let author = null;
  if (options.includeSelf) {
    const declarationId = newPublicationIdentifier();
    author = {
      declarationId,
      ciphertext: encodeTreeBytes(
        await sealAuthorDeclaration({ ...binding, declarationId, revision: 1 }, await readPseudonym(access, signal)),
      ),
    };
  }
  // New Publications default to public Comments; the creating browser holds the
  // only fragment, so the first audience epoch is sealed here and sent with the
  // creation, atomically with the Publication.
  const threadId = newOpaqueId();
  const comments = await commentEpoch(access, {
    publicationId,
    linkId,
    publicKey: keys.publicKey,
    audience: options.audience ?? "public",
    privateKey: keys.privateKey,
    threadId,
  });
  const ownerLink = await sealOwnerLink(access, { publicationId, linkId }, keys.privateKey);
  signal?.throwIfAborted();
  const link = { publicationId, linkId, url: publicLinkUrl(location.origin, linkId, keys.privateKey) };
  // Preserve the capability above the dismissible panel BEFORE the Worker can
  // commit. Aborting a fetch or losing its response does not undo that commit.
  options.onPrepared(link);
  await publicationRequest(
    fileId,
    "PUT",
    {
      publicationId,
      linkId,
      publicKey: encodeTreeBytes(keys.publicKey),
      expectedRevision: document.revision,
      expectedRepresentationId: document.representationId,
      representation: { ciphertext: encodeTreeBytes(ciphertext) },
      author,
      comments,
      ownerLink,
    },
    signal,
  );
  return link;
}

/**
 * The Owner changes the Public Comment audience (or sets up a legacy
 * Publication's thread). A public epoch needs the complete link's fragment,
 * which this browser holds as a prepared candidate or opens from the Owner
 * link copy; a Collaborators-only epoch needs no fragment at all.
 */
export async function changeCommentAudience(
  access: RootAccess,
  fileId: string,
  publication: {
    publicationId: string;
    linkId: string;
    publicKey: Uint8Array;
    expectedEpochId: string | null;
    threadId: string | null;
  },
  audience: CommentAudience,
  completeLink: string | null,
  signal?: AbortSignal,
): Promise<void> {
  let privateKey: Uint8Array<ArrayBuffer> | null = null;
  if (audience === "public") {
    try {
      privateKey = completeLink ? parsePublicationFragment(new URL(completeLink).hash) : null;
    } catch {
      privateKey = null;
    }
    if (!privateKey) throw new PublicationError("link-required");
  }
  const epoch = await commentEpoch(access, {
    publicationId: publication.publicationId,
    linkId: publication.linkId,
    publicKey: publication.publicKey,
    audience,
    privateKey,
    threadId: publication.threadId ?? newOpaqueId(),
  });
  const response = await privateRequest(`/api/private/comments/files/${fileId}/public`, {
    method: "PUT",
    signal,
    body: JSON.stringify({
      publicationId: publication.publicationId,
      expectedEpochId: publication.expectedEpochId,
      epoch,
    }),
  });
  if (response.ok) return;
  if (response.status === 404) throw new PublicationError("not-found");
  if (response.status === 429) throw new PublicationError("limited");
  if (response.status === 409) {
    const error = ((await response.json()) as { error?: string }).error;
    throw new PublicationError(error === "key_rotation_required" ? "rotation-required" : "changed");
  }
  throw new PublicationError("unavailable");
}

export async function requestPublication(fileId: string, signal?: AbortSignal) {
  await publicationRequest(`${fileId}/requests`, "POST", {}, signal);
}

/** The requester cancels, or the Owner denies: both hard-delete the request. */
export async function removePublicationRequest(fileId: string, requestId: string, signal?: AbortSignal) {
  await publicationRequest(`${fileId}/requests/${requestId}`, "DELETE", {}, signal);
}

/** The Owner credits itself; its own device writes the declaration immediately. */
export async function addSelfAuthor(
  access: RootAccess,
  fileId: string,
  publication: FilePublication,
  signal?: AbortSignal,
) {
  const declarationId = newPublicationIdentifier();
  const ciphertext = await sealAuthorDeclaration(
    {
      publicationId: publication.publicationId,
      linkId: publication.linkId,
      publicKey: publication.publicKey,
      declarationId,
      revision: 1,
    },
    await readPseudonym(access, signal),
  );
  await publicationRequest(
    `${fileId}/authors`,
    "PUT",
    {
      publicationId: publication.publicationId,
      declarationId,
      account: { self: true },
      declaration: { linkId: publication.linkId, ciphertext: encodeTreeBytes(ciphertext) },
    },
    signal,
  );
}

/** The Owner selects a Collaborator by exact share handle or share identifier. */
export async function addAccountAuthor(fileId: string, publicationId: string, address: string, signal?: AbortSignal) {
  const value = address.trim() === address ? address : "";
  const account = /^[A-Za-z0-9_-]{3,32}$/.test(value) ? { handle: value } : { shareId: value };
  if (!value) throw new PublicationError("not-found");
  try {
    await publicationRequest(
      `${fileId}/authors`,
      "PUT",
      { publicationId, declarationId: newPublicationIdentifier(), account, declaration: null },
      signal,
    );
  } catch (error) {
    // A share identifier can also look like a handle; try the other exact form once.
    if (!(error instanceof PublicationError) || error.code !== "not-found" || !("handle" in account)) throw error;
    await publicationRequest(
      `${fileId}/authors`,
      "PUT",
      { publicationId, declarationId: newPublicationIdentifier(), account: { shareId: value }, declaration: null },
      signal,
    );
  }
}

export async function removeAuthor(fileId: string, declarationId: string, signal?: AbortSignal) {
  await publicationRequest(`${fileId}/authors/${declarationId}`, "DELETE", {}, signal);
}

/** A selected author's own device declares its Public pseudonym to the current link. */
export async function declarePublicationAuthor(
  access: RootAccess,
  fileId: string,
  publication: FilePublication,
  signal?: AbortSignal,
) {
  const declaration = publication.declaration;
  if (!declaration || declaration.current) return;
  const revision = declaration.revision + 1;
  const ciphertext = await sealAuthorDeclaration(
    {
      publicationId: publication.publicationId,
      linkId: publication.linkId,
      publicKey: publication.publicKey,
      declarationId: declaration.declarationId,
      revision,
    },
    await readPseudonym(access, signal),
  );
  await publicationRequest(
    `${fileId}/authors/${declaration.declarationId}/declaration`,
    "PUT",
    {
      publicationId: publication.publicationId,
      linkId: publication.linkId,
      revision,
      ciphertext: encodeTreeBytes(ciphertext),
    },
    signal,
  );
}

// ---------------------------------------------------------------------------
// Link rotation and unpublish teardown (ticket 25)
// ---------------------------------------------------------------------------

/**
 * The Owner's browser replaces the active link: it re-encrypts the current
 * saved representation to a fresh key and rewraps every public Comment epoch,
 * then the Worker swaps the path, and the Owner link copy with it, in one
 * transaction. The retired link stops working; the logical Publication,
 * Comments and history survive. The new complete link is retained above the
 * dismissible panel before the request so a lost response never loses the
 * replacement capability.
 */
export async function rotatePublicationLink(options: {
  access: RootAccess;
  fileId: string;
  parentKey: Uint8Array;
  signal?: AbortSignal;
  onPrepared: (link: PreparedPublicLink) => void;
}): Promise<PreparedPublicLink> {
  const { access, fileId, parentKey, signal } = options;
  const document = await loadFile(access, fileId, parentKey, signal);
  const publication = document.publication;
  if (!publication || publication.revision === null) throw new PublicationError("changed");
  const opened = await loadFilePublicEpochs(access, fileId, signal);
  if (opened.publicationId !== publication.publicationId) throw new PublicationError("changed");
  const keys = await createPublicationKeyPair();
  const linkId = newPublicationIdentifier();
  const revision = publication.revision;
  const binding = { publicationId: publication.publicationId, linkId, publicKey: keys.publicKey };
  const ciphertext = await sealPublicRepresentation({ ...binding, revision }, publicPresentation(document.markdown));
  const epochs = [];
  for (const epoch of opened.epochs) {
    if (epoch.audience !== "public") continue;
    epochs.push({
      epochId: epoch.epochId,
      capabilityId: epoch.capabilityId,
      keyEpoch: epoch.capabilityEpoch,
      wrapper: encodeTreeBytes(
        await sealCommentEpochLink(keys.privateKey, keys.publicKey, {
          ...binding,
          epochId: epoch.epochId,
          capabilityId: epoch.capabilityId,
          keyEpoch: epoch.capabilityEpoch,
          capability: epoch.capability,
        }),
      ),
    });
  }
  const ownerLink = await sealOwnerLink(access, { publicationId: publication.publicationId, linkId }, keys.privateKey);
  signal?.throwIfAborted();
  const link = {
    publicationId: publication.publicationId,
    linkId,
    url: publicLinkUrl(location.origin, linkId, keys.privateKey),
  };
  options.onPrepared(link);
  await publicationRequest(
    `${fileId}/link`,
    "PUT",
    {
      publicationId: publication.publicationId,
      linkId,
      publicKey: encodeTreeBytes(keys.publicKey),
      expectedLinkId: publication.linkId,
      expectedPresentationRevision: revision,
      expectedRevision: document.revision,
      expectedRepresentationId: document.representationId,
      representation: { ciphertext: encodeTreeBytes(ciphertext) },
      epochs,
      ownerLink,
    },
    signal,
  );
  return link;
}

/** Seal the Publication: no Public route serves anything from this moment on. */
export async function unpublishPublication(
  fileId: string,
  signal?: AbortSignal,
): Promise<{ publicationId: string; commentTotal: number }> {
  return (await publicationRequest(`${fileId}/unpublish`, "POST", undefined, signal)).json();
}

/** One idempotent bounded deletion batch; the Owner's browser calls it until `done`. */
export async function continuePublicationTeardown(fileId: string, signal?: AbortSignal): Promise<TeardownProgress> {
  return (await publicationRequest(`${fileId}/teardown`, "POST", undefined, signal)).json();
}
