import { createSymmetricWriter, inspectEnvelope, openSymmetric } from "~/shared/crypto/enc-v1";
import { fileSourceBytes } from "~/shared/crypto/file-source";
import {
  createChildDirectoryCapability,
  createFileRepresentation,
  decodeFileRepresentation,
  openDeviceEnrollmentEnvelope,
  openVaultRecoveryEnvelope,
} from "~/shared/crypto/vault";
import { privateExchange, privateRequest } from "~/shared/device/private-client";
import { getDevice } from "~/shared/device/store";
import { canonicalizeSegment, sameComparisonKey } from "~/shared/namespace-v1";
import { newOpaqueId } from "~/shared/opaque-id";
import { isSignupRecoveryConfirmationPending, RecoveryConfirmationPendingError } from "~/shared/signup/recovery-gate";
import {
  createListingHead,
  openDirectoryListing,
  rememberListing,
  type ListingHead,
  type SealedEntry,
  type StoredListingHead,
} from "./listing";
export { rememberListing } from "./listing";
import { invalidateTreeListings } from "./tab-tree-cache";
import { decodeTreeBytes, encodeTreeBytes } from "./wire";
import { fileCapabilityContext, rememberFile, type FileCapability } from "./file-capability-client";
import { createFileHead, verifyFileHead, type FileHead } from "./file-head";
import { decodePublicationPublicKey, isPublicationIdentifier } from "~/shared/publications/capability";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Browser-only error; name review never sends the requested name to the Worker. */
export class NameConflictError extends Error {
  constructor() {
    super("name_conflict");
  }
}
export class TreeNotFoundError extends Error {
  constructor() {
    super("not_found");
  }
}
export class TreeCommitUncertainError extends Error {
  constructor() {
    super("tree_commit_uncertain");
  }
}
export class DirectoryTooLargeError extends Error {
  constructor() {
    super("directory_too_large");
  }
}

export type TreeKind = "directory" | "file";
export type TreeEntry = SealedEntry & { name: string; order: string };
export type DirectoryListing = {
  directoryId: string;
  keyEpoch?: number;
  entriesRevision: number;
  entries: TreeEntry[];
  canCreate?: boolean;
};
export type RootAccess = {
  vaultId: string;
  rootId: string;
  rootKey: Uint8Array<ArrayBuffer>;
  actorAccountId: string;
  rootKind?: TreeKind;
  capability?: FileCapability;
  /** The actor's own Vault root key, kept for Account-owned auxiliary capabilities. */
  actorVaultRootKey: Uint8Array<ArrayBuffer>;
};

function nameAgainstNamespace(name: string, existingNames: readonly string[]): string {
  const canonical = canonicalizeSegment(name);
  if (existingNames.some((sibling) => sameComparisonKey(sibling, canonical))) throw new NameConflictError();
  return canonical.display;
}

function metadataContext(vaultId: string, parentId: string, childId: string, parentEpoch = 1) {
  if (!Number.isSafeInteger(parentEpoch) || parentEpoch < 1) throw new Error("invalid directory epoch");
  return {
    purpose: "directory-metadata" as const,
    vaultId,
    objectId: childId,
    keyId: parentId,
    keyEpoch: parentEpoch,
    revision: 1,
  };
}

async function encryptedEntry(
  parentKey: Uint8Array,
  vaultId: string,
  parentId: string,
  nodeId: string,
  name: string,
  order: string,
  parentEpoch = 1,
) {
  const writer = await createSymmetricWriter(parentKey);
  const context = metadataContext(vaultId, parentId, nodeId, parentEpoch);
  return {
    nameCiphertext: encodeTreeBytes(await writer.seal(encoder.encode(name), context)),
    orderCiphertext: encodeTreeBytes(await writer.seal(encoder.encode(order), context)),
  };
}

/** Runs namespace-v1 before creating either a capability or a request. */
export async function prepareTreeCreate(options: {
  vaultId: string;
  parentId: string;
  parentKey: Uint8Array;
  parentEpoch?: number;
  entriesRevision: number;
  existingNames: readonly string[];
  requestedName: string;
  kind: TreeKind;
  markdown?: string;
}) {
  const name = nameAgainstNamespace(options.requestedName, options.existingNames);
  const nodeId = newOpaqueId();
  const order = newOpaqueId(); // Opaque in the Worker and encrypted before transport.
  const metadata = await encryptedEntry(
    options.parentKey,
    options.vaultId,
    options.parentId,
    nodeId,
    name,
    order,
    options.parentEpoch,
  );
  if (options.kind === "directory") {
    const child = await createChildDirectoryCapability(options.parentKey, {
      vaultId: options.vaultId,
      parentDirectoryId: options.parentId,
      childDirectoryId: nodeId,
    });
    return {
      nodeId,
      kind: options.kind,
      expectedRevision: options.entriesRevision,
      ...metadata,
      keyEnvelope: encodeTreeBytes(child.envelope),
    };
  }
  const capability = { id: newOpaqueId(), epoch: 1 };
  const scopeKey = crypto.getRandomValues(new Uint8Array(32));
  const keyEnvelope = encodeTreeBytes(
    await (await createSymmetricWriter(options.parentKey)).seal(
      scopeKey,
      fileCapabilityContext(options.vaultId, nodeId, capability),
    ),
  );
  const contentKeyId = newOpaqueId();
  const file = await createFileRepresentation(
    scopeKey,
    { markdown: options.markdown ?? "", metadata: new Uint8Array() },
    { vaultId: options.vaultId, fileId: nodeId, keyId: contentKeyId },
  );
  return {
    nodeId,
    kind: options.kind,
    expectedRevision: options.entriesRevision,
    ...metadata,
    capability,
    keyEnvelope,
    representation: {
      id: newOpaqueId(),
      contentKeyId,
      keyEpoch: 1,
      revision: 1 as const,
      ciphertext: encodeTreeBytes(file.contentEnvelope),
      keyEnvelope: encodeTreeBytes(file.fileContentKeyEnvelope),
    },
  };
}

/** Rename preserves the existing encrypted order; only the local browser sees names. */
export async function prepareTreeRename(options: {
  vaultId: string;
  parentId: string;
  parentKey: Uint8Array;
  parentEpoch?: number;
  nodeId: string;
  entriesRevision: number;
  existingNames: readonly string[];
  requestedName: string;
  order: string;
}) {
  const name = nameAgainstNamespace(options.requestedName, options.existingNames);
  return {
    parentId: options.parentId,
    expectedRevision: options.entriesRevision,
    ...(await encryptedEntry(
      options.parentKey,
      options.vaultId,
      options.parentId,
      options.nodeId,
      name,
      options.order,
      options.parentEpoch,
    )),
  };
}

async function jsonResource<T>(
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: object,
  signal?: AbortSignal,
): Promise<T> {
  const response = await privateRequest(path, { method, signal, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.status === 404) throw new TreeNotFoundError();
  if (response.status === 409) {
    const body = (await response.json()) as { error?: string };
    if (body.error === "namespace_changed") throw new NamespaceChangedError();
    if (body.error === "key_rotation_required")
      throw new Error("Secure access must finish updating before this folder can change.");
    throw new Error("Shared content is being securely provisioned.");
  }
  if (response.status === 413 && ((await response.json()) as { error?: string }).error === "directory_too_large") {
    throw new DirectoryTooLargeError();
  }
  if (!response.ok) throw new Error("private tree unavailable");
  return response.json() as Promise<T>;
}

export class NamespaceChangedError extends Error {
  constructor() {
    super("namespace_changed");
  }
}

/**
 * Browser possession + proof-guarded bootstrap; keys never enter loaders or document HTML.
 * The envelopes are opened for exactly the Account and device the request's proof named.
 */
export async function openRoot(signal?: AbortSignal): Promise<RootAccess> {
  const { response, accountId, device } = await privateExchange("/api/private/bootstrap", { method: "POST", signal });
  if (!response.ok) throw new Error("private tree unavailable");
  const deviceId = device.deviceId;
  const bootstrap = (await response.json()) as {
    rootDirectoryId: string;
    rootKeyEpoch?: number;
    rootRecoveryEnvelope: string;
    enrollmentEnvelope: string;
  };
  const rootKeyEpoch = bootstrap.rootKeyEpoch ?? 1;
  if (!Number.isSafeInteger(rootKeyEpoch) || rootKeyEpoch < 1) throw new Error("invalid directory epoch");
  const vaultRoot = await openDeviceEnrollmentEnvelope(
    decodeTreeBytes(bootstrap.enrollmentEnvelope),
    device.transportKeyPair,
    {
      purpose: "device-enrollment",
      vaultId: accountId,
      objectId: deviceId,
      keyId: deviceId,
      keyEpoch: 1,
      revision: 1,
      recipientId: deviceId,
    },
  );
  const rootKey = await openVaultRecoveryEnvelope(decodeTreeBytes(bootstrap.rootRecoveryEnvelope), vaultRoot, {
    purpose: "vault-recovery",
    vaultId: accountId,
    objectId: bootstrap.rootDirectoryId,
    keyId: bootstrap.rootDirectoryId,
    keyEpoch: rootKeyEpoch,
    revision: 1,
  });
  return {
    vaultId: accountId,
    actorAccountId: accountId,
    rootKind: "directory",
    rootId: bootstrap.rootDirectoryId,
    rootKey,
    actorVaultRootKey: vaultRoot,
    capability: { id: bootstrap.rootDirectoryId, epoch: rootKeyEpoch },
  };
}

/** A Directory listing as the Worker returns it: ciphertext, not yet verified or opened. */
export type FetchedDirectory = {
  directoryId: string;
  keyEpoch?: number;
  entriesRevision: number;
  entries: SealedEntry[];
  canCreate?: boolean;
  listingHead: (Omit<StoredListingHead, "signerPublicKey"> & { signerPublicKey: string }) | null;
};

/** The network half of `loadDirectory`, which needs no key: callers may fetch a whole path at once. */
export function fetchDirectory(directoryId: string, signal?: AbortSignal): Promise<FetchedDirectory> {
  return jsonResource<FetchedDirectory>(`/api/private/tree/directories/${directoryId}`, "POST", undefined, signal);
}

export async function loadDirectory(
  access: RootAccess,
  directoryId: string,
  key: Uint8Array,
  signal?: AbortSignal,
): Promise<DirectoryListing> {
  return openDirectory(access, directoryId, key, await fetchDirectory(directoryId, signal));
}

/** The decrypting half of `loadDirectory`: verify a fetched listing against its head and open it. */
export async function openDirectory(
  access: RootAccess,
  directoryId: string,
  key: Uint8Array,
  listing: FetchedDirectory,
): Promise<DirectoryListing> {
  const keyEpoch = listing.keyEpoch ?? 1;
  if (
    listing.directoryId !== directoryId ||
    !Number.isSafeInteger(keyEpoch) ||
    keyEpoch < 1 ||
    !Number.isSafeInteger(listing.entriesRevision) ||
    listing.entriesRevision < 1
  ) {
    throw new Error("invalid directory listing");
  }
  await openDirectoryListing(key, {
    vaultId: access.vaultId,
    directoryId,
    keyEpoch,
    revision: listing.entriesRevision,
    entries: listing.entries,
    head: listing.listingHead
      ? { ...listing.listingHead, signerPublicKey: decodeTreeBytes(listing.listingHead.signerPublicKey, 65) }
      : null,
  });
  const opened = await Promise.all(
    listing.entries.map(async (entry): Promise<{ entry: TreeEntry; comparison: string }> => {
      const context = metadataContext(access.vaultId, directoryId, entry.nodeId, keyEpoch);
      const name = decoder.decode(await openSymmetric(decodeTreeBytes(entry.nameCiphertext), key, { context }));
      const order = decoder.decode(await openSymmetric(decodeTreeBytes(entry.orderCiphertext), key, { context }));
      const segment = canonicalizeSegment(name);
      if (segment.display !== name || order.length > 256 || !order) {
        throw new Error("invalid directory listing");
      }
      return { entry: { ...entry, name, order }, comparison: encodeTreeBytes(segment.comparisonKey) };
    }),
  );
  // No two siblings may share a comparison key. Each name is canonicalized once:
  // comparing every pair canonicalized both names again, quadratic in the listing.
  if (new Set(opened.map(({ comparison }) => comparison)).size !== opened.length) {
    throw new Error("invalid directory listing");
  }
  const entries = opened.map(({ entry }) => entry);
  entries.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.nodeId.localeCompare(b.nodeId)));
  return {
    directoryId,
    ...(listing.keyEpoch === undefined ? {} : { keyEpoch }),
    entriesRevision: listing.entriesRevision,
    entries,
    canCreate: listing.canCreate ?? true,
  };
}

export async function openChildDirectory(
  access: RootAccess,
  parentKey: Uint8Array,
  entry: TreeEntry,
): Promise<Uint8Array<ArrayBuffer>> {
  const keyEpoch = entry.keyEpoch ?? 1;
  if (entry.kind !== "directory" || !Number.isSafeInteger(keyEpoch) || keyEpoch < 1)
    throw new Error("invalid directory");
  return openSymmetric(decodeTreeBytes(entry.keyEnvelope), parentKey, {
    context: {
      purpose: "directory-capability",
      vaultId: access.vaultId,
      objectId: entry.nodeId,
      keyId: entry.nodeId,
      keyEpoch,
      revision: 1,
    },
  });
}

export async function loadAncestors(nodeId: string, signal?: AbortSignal): Promise<string[]> {
  const result = await jsonResource<{ ancestors: string[] }>(
    `/api/private/tree/nodes/${nodeId}/ancestors`,
    "POST",
    undefined,
    signal,
  );
  if (!Array.isArray(result.ancestors) || result.ancestors.at(-1) !== nodeId || result.ancestors.length > 101)
    throw new Error("invalid tree path");
  return result.ancestors;
}

/** The active Publication as the File response describes it to this actor:
 * an editor's paired-save target or a credited author's declaration slot.
 * It is opaque public-link metadata only; the read capability is never here. */
export type FilePublication = {
  publicationId: string;
  linkId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  revision: number | null;
  declaration: { declarationId: string; revision: number; current: boolean } | null;
};
type FilePublicationWire = {
  publicationId: string;
  linkId: string;
  publicKey: string;
  revision?: number;
  declaration: { declarationId: string; revision: number; current: boolean } | null;
};

function filePublication(value: FilePublicationWire | undefined, canEdit: boolean): FilePublication | null {
  if (value === undefined) return null;
  const count = (item: unknown, minimum: number): item is number =>
    typeof item === "number" && Number.isSafeInteger(item) && item >= minimum;
  const declaration = value.declaration;
  if (
    !isPublicationIdentifier(value.publicationId) ||
    !isPublicationIdentifier(value.linkId) ||
    (canEdit ? !count(value.revision, 1) : value.revision !== undefined) ||
    (declaration !== null &&
      (!isPublicationIdentifier(declaration?.declarationId) ||
        !count(declaration.revision, 0) ||
        typeof declaration.current !== "boolean"))
  )
    throw new Error("invalid File publication");
  return {
    publicationId: value.publicationId,
    linkId: value.linkId,
    publicKey: decodePublicationPublicKey(value.publicKey),
    revision: canEdit ? value.revision! : null,
    declaration,
  };
}

/** A File as the Worker returns it: ciphertext and envelopes, not yet verified or opened. */
export type FetchedFile = {
  fileId: string;
  ownerId: string;
  parentId?: string;
  revision: number;
  representationId: string;
  contentKeyId: string;
  keyEpoch: number;
  ciphertext: string;
  keyEnvelope?: string;
  canEdit: boolean;
  capability?: FileCapability | null;
  representationKeyEnvelope?: string;
  fileHead?: FileHead & { signerDeviceId: string; signerPublicKey: string };
  publication?: FilePublicationWire;
};

/** The network half of `loadFile`, which needs no key. */
export function fetchFile(fileId: string, signal?: AbortSignal): Promise<FetchedFile> {
  return jsonResource<FetchedFile>(`/api/private/tree/files/${fileId}`, "POST", undefined, signal);
}

export async function loadFile(access: RootAccess, fileId: string, parentKey: Uint8Array, signal?: AbortSignal) {
  return openFile(access, fileId, parentKey, await fetchFile(fileId, signal));
}

/** The decrypting half of `loadFile`: verify a fetched File's head and open its content. */
export async function openFile(access: RootAccess, fileId: string, parentKey: Uint8Array, file: FetchedFile) {
  if (file.fileId !== fileId || file.ownerId !== access.vaultId) throw new Error("invalid File identity");
  const context = {
    vaultId: access.vaultId,
    objectId: fileId,
    keyId: file.contentKeyId,
    keyEpoch: file.keyEpoch,
    revision: file.revision,
  };
  let capabilityKey: Uint8Array<ArrayBuffer> | null = null;
  let wrapper = file.keyEnvelope;
  if (file.capability) {
    if (!file.fileHead || !file.representationKeyEnvelope) throw new Error("missing File head");
    if (
      !(await verifyFileHead(
        decodeTreeBytes(file.fileHead.signerPublicKey, 65),
        {
          vaultId: access.vaultId,
          fileId,
          capabilityId: file.capability.id,
          capabilityEpoch: file.capability.epoch,
          representationId: file.representationId,
          contentKeyId: file.contentKeyId,
          keyEpoch: file.keyEpoch,
          revision: file.revision,
          deviceId: file.fileHead.signerDeviceId,
          ciphertext: file.ciphertext,
          keyEnvelope: file.representationKeyEnvelope,
        },
        file.fileHead,
      ))
    )
      throw new Error("invalid File head");
    rememberFile(access.vaultId, fileId, file.capability.epoch, file.revision, file.fileHead.digest);
    if (access.rootKind === "file" && access.rootId === fileId) {
      if (
        !access.capability ||
        access.capability.id !== file.capability.id ||
        access.capability.epoch !== file.capability.epoch
      ) {
        throw new Error("invalid File capability");
      }
      capabilityKey = new Uint8Array(parentKey);
    } else {
      if (!file.keyEnvelope) throw new Error("missing File capability");
      capabilityKey = await openSymmetric(decodeTreeBytes(file.keyEnvelope), parentKey, {
        context: fileCapabilityContext(access.vaultId, fileId, file.capability),
      });
    }
    wrapper = file.representationKeyEnvelope;
  } else if (access.rootKind === "file") throw new Error("missing File capability");
  if (!wrapper) throw new Error("missing File content key");
  const key = await openSymmetric(decodeTreeBytes(wrapper), capabilityKey ?? parentKey, {
    context: { ...context, purpose: "file-content-key" },
  });
  const content = await openSymmetric(decodeTreeBytes(file.ciphertext, 524_288), key, {
    context: { ...context, purpose: "file-content" },
  });
  const decoded = decodeFileRepresentation(content);
  return {
    parentId: access.rootKind === "file" ? null : (file.parentId ?? null),
    revision: file.revision,
    keyEpoch: file.keyEpoch,
    canEdit: file.canEdit,
    capability: file.capability ?? null,
    capabilityKey,
    publication: filePublication(file.publication, file.canEdit),
    ciphertext: file.ciphertext,
    keyEnvelope: file.keyEnvelope,
    representationKeyEnvelope: file.representationKeyEnvelope,
    contentKeyId: file.contentKeyId,
    representationId: file.representationId,
    ...decoded,
    sourceBytes: fileSourceBytes(decoded.markdown),
  };
}

export async function signListingChange(
  access: RootAccess,
  listing: DirectoryListing,
  parentKey: Uint8Array,
  updated: SealedEntry[],
): Promise<ListingHead> {
  if (!listing.directoryId) throw new Error("invalid directory listing");
  const device = await getDevice(access.actorAccountId);
  if (!device) throw new Error("private tree unavailable");
  return createListingHead(parentKey, device.assertionKeyPair.privateKey, {
    vaultId: access.vaultId,
    directoryId: listing.directoryId,
    deviceId: device.deviceId,
    keyEpoch: listing.keyEpoch,
    revision: listing.entriesRevision + 1,
    entries: updated,
  });
}

/**
 * Send a structural change. Whatever its outcome, the request may have
 * changed these listings (or found them changed elsewhere), so this tab and
 * the others drop what they remember of them (ticket 57).
 */
async function changingListings<T>(access: RootAccess, directoryIds: string[], send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } finally {
    invalidateTreeListings(access.actorAccountId, directoryIds);
  }
}

export async function createTreeChild(
  access: RootAccess,
  parentId: string,
  input: {
    nodeId: string;
    kind: TreeKind;
    expectedRevision: number;
    nameCiphertext: string;
    orderCiphertext: string;
    keyEnvelope: string;
    capability?: FileCapability;
    representation?: {
      id: string;
      contentKeyId: string;
      keyEpoch: number;
      revision: number;
      ciphertext: string;
      keyEnvelope: string;
      fileHead?: FileHead;
    };
  },
  listing: DirectoryListing,
  parentKey: Uint8Array,
  signal?: AbortSignal,
) {
  if (isSignupRecoveryConfirmationPending()) throw new RecoveryConfirmationPendingError();
  if (listing.directoryId !== parentId || input.expectedRevision !== listing.entriesRevision)
    throw new Error("invalid directory listing");
  if (input.capability) {
    const device = await getDevice(access.actorAccountId);
    if (!device || !input.representation) throw new Error("private tree unavailable");
    const representation = input.representation;
    input = {
      ...input,
      representation: {
        ...representation,
        fileHead: await createFileHead(device.assertionKeyPair.privateKey, {
          vaultId: access.vaultId,
          fileId: input.nodeId,
          capabilityId: input.capability.id,
          capabilityEpoch: input.capability.epoch,
          representationId: representation.id,
          contentKeyId: representation.contentKeyId,
          keyEpoch: representation.keyEpoch,
          revision: representation.revision,
          deviceId: device.deviceId,
          ciphertext: representation.ciphertext,
          keyEnvelope: representation.keyEnvelope,
        }),
      },
    };
  }
  const head = await signListingChange(access, listing, parentKey, [...listing.entries, input]);
  return changingListings(access, [parentId], async () => {
    const result = await jsonResource<{ nodeId: string; entriesRevision: number }>(
      `/api/private/tree/directories/${parentId}/children`,
      "PUT",
      { ...input, listingHead: head },
      signal,
    );
    try {
      rememberListing(access.vaultId, parentId, result.entriesRevision, head.digest);
    } catch {
      throw new TreeCommitUncertainError();
    }
    return result;
  });
}

/** Swap only adjacent encrypted order values; names, capabilities and source stay unchanged. */
export async function reorderTreeChild(
  access: RootAccess,
  listing: DirectoryListing,
  parentKey: Uint8Array,
  nodeId: string,
  direction: "up" | "down",
  signal?: AbortSignal,
) {
  if (isSignupRecoveryConfirmationPending()) throw new RecoveryConfirmationPendingError();
  const index = listing.entries.findIndex((entry) => entry.nodeId === nodeId);
  const entry = listing.entries[index],
    neighbor = listing.entries[index + (direction === "up" ? -1 : 1)];
  if (!entry) throw new TreeNotFoundError();
  if (!neighbor) return;
  if (entry.order === neighbor.order) throw new Error("ambiguous ordering");
  const writer = await createSymmetricWriter(parentKey);
  const swaps = [
    { child: entry, order: neighbor.order },
    { child: neighbor, order: entry.order },
  ];
  const orders = await Promise.all(
    swaps.map(async ({ child, order }) => ({
      nodeId: child.nodeId,
      orderCiphertext: encodeTreeBytes(
        await writer.seal(
          encoder.encode(order),
          metadataContext(access.vaultId, listing.directoryId, child.nodeId, listing.keyEpoch),
        ),
      ),
    })),
  );
  const updated = listing.entries.map((item) => ({
    ...item,
    orderCiphertext: orders.find((order) => order.nodeId === item.nodeId)?.orderCiphertext ?? item.orderCiphertext,
  }));
  const head = await signListingChange(access, listing, parentKey, updated);
  return changingListings(access, [listing.directoryId], async () => {
    const result = await jsonResource<{ entriesRevision: number }>(
      `/api/private/tree/nodes/${nodeId}/order`,
      "PATCH",
      {
        parentId: listing.directoryId,
        expectedRevision: listing.entriesRevision,
        orders,
        listingHead: head,
      },
      signal,
    );
    try {
      rememberListing(access.vaultId, listing.directoryId, result.entriesRevision, head.digest);
    } catch {
      throw new TreeCommitUncertainError();
    }
    return result;
  });
}

/** Only an authenticated parent listing supplies the child-key context here.
 * The service never receives either parent's capability or a plaintext name.
 */
export async function moveTreeChild(
  access: RootAccess,
  source: DirectoryListing,
  sourceKey: Uint8Array,
  destination: DirectoryListing,
  destinationKey: Uint8Array,
  nodeId: string,
  requestedName: string,
  signal?: AbortSignal,
) {
  if (isSignupRecoveryConfirmationPending()) throw new RecoveryConfirmationPendingError();
  if (source.directoryId === destination.directoryId) throw new Error("invalid destination");
  const entry = source.entries.find((entry) => entry.nodeId === nodeId);
  if (!entry) throw new TreeNotFoundError();
  const name = nameAgainstNamespace(
    requestedName,
    destination.entries.map((entry) => entry.name),
  );
  const context =
    entry.kind === "directory"
      ? {
          purpose: "directory-capability" as const,
          vaultId: access.vaultId,
          objectId: nodeId,
          keyId: nodeId,
          keyEpoch: entry.keyEpoch ?? 1,
          revision: 1,
        }
      : inspectEnvelope(decodeTreeBytes(entry.keyEnvelope)).context;
  if (
    !Number.isSafeInteger(context.keyEpoch) ||
    context.keyEpoch < 1 ||
    context.vaultId !== access.vaultId ||
    context.objectId !== nodeId ||
    (entry.kind === "directory"
      ? context.purpose !== "directory-capability"
      : context.purpose !== "file-content-key" && context.purpose !== "file-capability")
  ) {
    throw new Error("invalid child capability");
  }
  const key = await openSymmetric(decodeTreeBytes(entry.keyEnvelope), sourceKey, { context });
  const writer = await createSymmetricWriter(destinationKey);
  const updated = {
    ...entry,
    ...(await encryptedEntry(
      destinationKey,
      access.vaultId,
      destination.directoryId,
      nodeId,
      name,
      newOpaqueId(),
      destination.keyEpoch,
    )),
    keyEnvelope: encodeTreeBytes(await writer.seal(key, context)),
  };
  const [sourceHead, destinationHead] = await Promise.all([
    signListingChange(
      access,
      source,
      sourceKey,
      source.entries.filter((entry) => entry.nodeId !== nodeId),
    ),
    signListingChange(access, destination, destinationKey, [...destination.entries, updated]),
  ]);
  return changingListings(access, [source.directoryId, destination.directoryId], async () => {
    const result = await jsonResource<{ sourceEntriesRevision: number; destinationEntriesRevision: number }>(
      `/api/private/tree/nodes/${nodeId}/parent`,
      "PATCH",
      {
        sourceId: source.directoryId,
        destinationId: destination.directoryId,
        kind: entry.kind,
        expectedSourceRevision: source.entriesRevision,
        expectedDestinationRevision: destination.entriesRevision,
        nameCiphertext: updated.nameCiphertext,
        orderCiphertext: updated.orderCiphertext,
        keyEnvelope: updated.keyEnvelope,
        sourceListingHead: sourceHead,
        destinationListingHead: destinationHead,
      },
      signal,
    );
    try {
      rememberListing(access.vaultId, source.directoryId, result.sourceEntriesRevision, sourceHead.digest);
      rememberListing(
        access.vaultId,
        destination.directoryId,
        result.destinationEntriesRevision,
        destinationHead.digest,
      );
    } catch {
      throw new TreeCommitUncertainError();
    }
    return result;
  });
}

export async function deleteTreeChild(
  access: RootAccess,
  listing: DirectoryListing,
  parentKey: Uint8Array,
  nodeId: string,
  expectedDirectoryRevision?: number,
  signal?: AbortSignal,
) {
  if (isSignupRecoveryConfirmationPending()) throw new RecoveryConfirmationPendingError();
  const entry = listing.entries.find((entry) => entry.nodeId === nodeId);
  if (!entry) throw new TreeNotFoundError();
  const head = await signListingChange(
    access,
    listing,
    parentKey,
    listing.entries.filter((entry) => entry.nodeId !== nodeId),
  );
  const changed = entry.kind === "directory" ? [listing.directoryId, nodeId] : [listing.directoryId];
  return changingListings(access, changed, async () => {
    const result = await jsonResource<{ entriesRevision: number }>(
      `/api/private/tree/nodes/${nodeId}`,
      "DELETE",
      {
        parentId: listing.directoryId,
        expectedRevision: listing.entriesRevision,
        kind: entry.kind,
        listingHead: head,
        ...(entry.kind === "directory" ? { expectedDirectoryRevision } : {}),
      },
      signal,
    );
    try {
      rememberListing(access.vaultId, listing.directoryId, result.entriesRevision, head.digest);
    } catch {
      throw new TreeCommitUncertainError();
    }
    return result;
  });
}

export async function renameTreeChild(
  access: RootAccess,
  parentId: string,
  nodeId: string,
  input: { expectedRevision: number; nameCiphertext: string; orderCiphertext: string },
  listing: DirectoryListing,
  parentKey: Uint8Array,
  signal?: AbortSignal,
) {
  if (isSignupRecoveryConfirmationPending()) throw new RecoveryConfirmationPendingError();
  if (listing.directoryId !== parentId || input.expectedRevision !== listing.entriesRevision)
    throw new Error("invalid directory listing");
  const entry = listing.entries.find((item) => item.nodeId === nodeId);
  if (!entry) throw new TreeNotFoundError();
  const head = await signListingChange(
    access,
    listing,
    parentKey,
    listing.entries.map((item) => (item.nodeId === nodeId ? { ...item, ...input } : item)),
  );
  return changingListings(access, [parentId], async () => {
    const result = await jsonResource<{ entriesRevision: number }>(
      `/api/private/tree/nodes/${nodeId}/name`,
      "PATCH",
      { ...input, parentId, listingHead: head },
      signal,
    );
    try {
      rememberListing(access.vaultId, parentId, result.entriesRevision, head.digest);
    } catch {
      throw new TreeCommitUncertainError();
    }
    return result;
  });
}
