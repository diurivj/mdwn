import { createFileRepresentation } from "~/crypto/vault";
import { createFileReceivingKey, createFileSave } from "~/crypto/file-receiving";
import { openSymmetric, sealToRecipient } from "~/crypto/enc-v1";
import { privateRequest } from "~/device/private-client";
import { getDevice } from "~/device/store";
import { newOpaqueId } from "~/opaque-id";
import { authenticateFileHead, loadDirectFile, loadDirectory, loadFile,
  type DirectoryListing, type FileHeadWire, type LoadedDirectFile, type LoadedFile, type RootAccess } from "./client";
import { createListingHead } from "./listing";
import { parseFileHeadBytes, signFileHead, type DirectRecipientDescriptor, type FileHeadStatement } from "./file-head";
import { decodeTreeBytes, encodeTreeBytes } from "./wire";

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

type WriteContext = { ownerId: string; fileId: string; currentHead: FileHeadWire;
  receivingPublicKey: string; recipientSetVersion: number;
  recipients: { accountId: string; deviceId: string; registryEpoch: number;
    publicKey: string; grants: { id: string; generation: number }[] }[] };

async function digest(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}
function wireHead(head: { bytes: Uint8Array; digest: Uint8Array; signature: Uint8Array }) {
  return { bytes: encodeTreeBytes(head.bytes), digest: encodeTreeBytes(head.digest),
    signature: encodeTreeBytes(head.signature) };
}
async function recipientDescriptors(context: WriteContext, envelopes: readonly { deviceId: string; envelope: Uint8Array }[]
): Promise<DirectRecipientDescriptor[]> {
  if (!Array.isArray(context.recipients) || context.recipients.length > 256 ||
      context.recipients.length !== envelopes.length) throw new Error("incomplete File recipients");
  return Promise.all(context.recipients.map(async (recipient) => {
    const envelope = envelopes.find((item) => item.deviceId === recipient.deviceId);
    if (!envelope || recipient.grants.length < 1 || recipient.grants.length > 16) {
      throw new Error("incomplete File recipients");
    }
    return { accountId: recipient.accountId, deviceId: recipient.deviceId,
      registryEpoch: recipient.registryEpoch, grants: recipient.grants,
      publicKeyDigest: await digest(decodeTreeBytes(recipient.publicKey, 65)),
      envelopeDigest: await digest(envelope.envelope) };
  }));
}
async function recipientKeys(recipients: WriteContext["recipients"]) {
  return Promise.all(recipients.map(async (r) => ({ deviceId: r.deviceId,
    publicKey: await crypto.subtle.importKey("raw", decodeTreeBytes(r.publicKey, 65),
      { name: "ECDH", namedCurve: "P-256" }, false, []) })));
}

/** Explicit one-time transition: current v1 bytes and the verified complete listing are CAS guards. */
export async function migrateOwnedFile(options: { access: RootAccess; fileId: string; file: LoadedFile;
  listing: DirectoryListing; parentKey: Uint8Array }): Promise<{ file: LoadedFile; listing: DirectoryListing }> {
  const { access, fileId, file, listing, parentKey } = options;
  if (file.v2 || listing.directoryId !== file.parentId || listing.entriesRevision < 2) {
    throw new Error("invalid File migration");
  }
  const entry = listing.entries.find((item) => item.nodeId === fileId && item.kind === "file");
  if (!entry || entry.encoding === "receiving-file") throw new Error("invalid File migration");
  const device = await getDevice(access.actorAccountId ?? access.vaultId);
  if (!device) throw new Error("private File unavailable");
  // The read is already authenticated by v1's complete-entry listing and AES-GCM.
  const raw = await privateRequest(`/api/private/tree/files/${fileId}`, { method: "POST" });
  if (!raw.ok) throw new Error("private File unavailable");
  const prior = await raw.json() as { revision: number; representationId: string; contentKeyId: string;
    keyEpoch: number; ciphertext: string; keyEnvelope: string };
  if (prior.revision !== file.revision || prior.representationId !== file.representationId ||
      prior.contentKeyId !== file.contentKeyId || prior.keyEpoch !== file.keyEpoch ||
      prior.keyEnvelope !== entry.keyEnvelope) throw new FileChangedError();
  const currentKey = await openSymmetric(decodeTreeBytes(entry.keyEnvelope, 16_384), parentKey, {
    context: { purpose: "file-content-key", vaultId: access.vaultId, objectId: fileId,
      keyId: file.contentKeyId, keyEpoch: file.keyEpoch, revision: file.revision },
  });
  const receivingKeyId = newOpaqueId();
  const receiver = await createFileReceivingKey(parentKey, { vaultId: access.vaultId, fileId,
    receivingKeyId, receivingEpoch: 1, wrapRevision: listing.entriesRevision + 1 });
  const parentEnvelope = await sealToRecipient(currentKey, receiver.keyPair.publicKey, {
    purpose: "file-content-key", vaultId: access.vaultId, objectId: fileId,
    keyId: file.contentKeyId, keyEpoch: file.keyEpoch, revision: file.revision, recipientId: receivingKeyId,
  });
  const target = encodeTreeBytes(receiver.publicKey);
  // Before any Share exists the set is empty; if there are eligible direct devices,
  // use their live descriptors rather than omitting even one of them.
  const current = await privateRequest(`/api/private/tree/files/${fileId}/migration-recipients`, { method: "POST" });
  if (!current.ok) throw new Error("File recipients unavailable");
  const recipients = await current.json() as { recipients: WriteContext["recipients"] };
  const context: WriteContext = { ownerId: access.vaultId, fileId,
    currentHead: { bytes: "", digest: "", signature: "", signerDeviceId: "", signerPublicKey: "" },
    receivingPublicKey: target, recipientSetVersion: 1, recipients: recipients.recipients };
  const wrapped = await Promise.all((await recipientKeys(context.recipients)).map(async (recipient) => ({
    deviceId: recipient.deviceId, envelope: await sealToRecipient(currentKey, recipient.publicKey, {
      purpose: "grant", vaultId: access.vaultId, objectId: fileId, keyId: file.contentKeyId,
      keyEpoch: file.keyEpoch, revision: file.revision, recipientId: recipient.deviceId,
    }),
  })));
  const statement: FileHeadStatement = { ownerId: access.vaultId, vaultId: access.vaultId, fileId,
    revision: file.revision, contentKey: { id: file.contentKeyId, epoch: file.keyEpoch },
    receivingKey: { id: receivingKeyId, epoch: 1, publicKeyDigest: receiver.publicKeyDigest },
    representation: { id: file.representationId, digest: await digest(decodeTreeBytes(prior.ciphertext, 524_288)) },
    parentEnvelopeDigest: await digest(parentEnvelope), recipientSetVersion: 1,
    recipients: await recipientDescriptors(context, wrapped), publication: { status: "none" },
    signerDeviceId: device.deviceId };
  const signed = await signFileHead(statement, device.assertionKeyPair.privateKey);
  const nextEntry = { ...entry, encoding: "receiving-file" as const, keyEnvelope: encodeTreeBytes(receiver.privateKeyEnvelope),
    receivingKeyId, receivingEpoch: 1, wrapRevision: listing.entriesRevision + 1 };
  const listingHead = await createListingHead(parentKey, device.assertionKeyPair.privateKey, {
    vaultId: access.vaultId, directoryId: file.parentId, deviceId: device.deviceId,
    epoch: listing.capabilityEpoch, revision: listing.entriesRevision + 1, version: 2,
    entries: listing.entries.map((item) => item.nodeId === fileId ? nextEntry : {
      ...item, encoding: item.encoding ?? (item.kind === "directory" ? "directory" : "legacy-file"),
    }),
  });
  const response = await privateRequest(`/api/private/tree/files/${fileId}/migrate`, { method: "PATCH",
    body: JSON.stringify({ expectedRevision: file.revision, expectedEntriesRevision: listing.entriesRevision,
      listingVersion: listing.listingVersion ?? 1,
      expectedEntry: { nameCiphertext: entry.nameCiphertext, orderCiphertext: entry.orderCiphertext,
        keyEnvelope: entry.keyEnvelope },
      representation: { id: file.representationId, contentKeyId: file.contentKeyId,
        keyEpoch: file.keyEpoch, ciphertext: prior.ciphertext }, receivingKeyId, receivingEpoch: 1,
      wrapRevision: listing.entriesRevision + 1, receivingPublicKey: target,
      receivingWrapper: encodeTreeBytes(receiver.privateKeyEnvelope), parentEnvelope: encodeTreeBytes(parentEnvelope),
      recipientEnvelopes: wrapped.map((r) => ({ deviceId: r.deviceId, ciphertext: encodeTreeBytes(r.envelope) })),
      signedHead: wireHead(signed), listingHead }) });
  if (response.status === 409) throw new FileChangedError();
  if (!response.ok) throw new Error("File migration failed");
  const nextListing = await loadDirectory(access, file.parentId, parentKey);
  if (nextListing.entriesRevision !== listing.entriesRevision + 1 || nextListing.listingVersion !== 2) {
    throw new FileSaveUncertainError();
  }
  const freshEntry = nextListing.entries.find((item) => item.nodeId === fileId);
  if (!freshEntry || freshEntry.keyEnvelope !== nextEntry.keyEnvelope) throw new FileSaveUncertainError();
  const nextFile = await loadFile(access, fileId, file.parentId, parentKey, freshEntry);
  if (nextFile.revision !== file.revision || nextFile.representationId !== file.representationId) {
    throw new FileSaveUncertainError();
  }
  return { file: nextFile, listing: nextListing };
}

/** Parent-free save request usable by an authenticated direct File editor. */
export async function saveWithFileContext(options: { actorAccountId: string; fileId: string;
  source: string; metadata: Uint8Array; trustedHead: FileHeadWire; receivingPublicKey: string;
  expectedOwnerId?: string;
}): Promise<{ revision: number; headDigest: string }> {
  const { actorAccountId, fileId, source, metadata, trustedHead, receivingPublicKey } = options;
  if (!withinFileLimit(source)) throw new Error("File limit reached");
  const device = await getDevice(actorAccountId);
  if (!device) throw new Error("private File unavailable");
  const response = await privateRequest(`/api/private/tree/files/${fileId}/context`, { method: "POST" });
  if (!response.ok) throw new Error("File write context unavailable");
  const context = await response.json() as WriteContext;
  if (context.fileId !== fileId ||
      (options.expectedOwnerId && context.ownerId !== options.expectedOwnerId) ||
      context.currentHead.digest !== trustedHead.digest ||
      context.receivingPublicKey !== receivingPublicKey) throw new FileChangedError();
  const revisionFromTrustedBytes = parseFileHeadBytes(decodeTreeBytes(trustedHead.bytes, 131_072)).revision;
  await authenticateFileHead(trustedHead, context.ownerId, fileId, revisionFromTrustedBytes);
  const before = await authenticateFileHead(context.currentHead, context.ownerId, fileId, revisionFromTrustedBytes);
  const s = before.statement;
  if (s.publication.status !== "none" || context.recipientSetVersion !== s.recipientSetVersion) {
    throw new Error("File write blocked");
  }
  const revision = s.revision + 1, contentKeyId = newOpaqueId(), representationId = newOpaqueId();
  const nextRecipients = context.recipients;
  const fresh = await createFileSave({ markdown: source, metadata }, decodeTreeBytes(receivingPublicKey, 65), {
    vaultId: context.ownerId, fileId, receivingKeyId: s.receivingKey.id,
    receivingEpoch: s.receivingKey.epoch, publicKeyDigest: s.receivingKey.publicKeyDigest,
  }, { vaultId: context.ownerId, fileId, contentKeyId, contentEpoch: s.contentKey.epoch + 1,
    revision }, await recipientKeys(nextRecipients));
  const descriptors = await recipientDescriptors(context, fresh.recipientEnvelopes);
  const oldMembership = JSON.stringify(s.recipients.map((r) => [r.accountId, r.deviceId, r.registryEpoch,
    encodeTreeBytes(r.publicKeyDigest), r.grants]));
  const newMembership = JSON.stringify(descriptors.map((r) => [r.accountId, r.deviceId, r.registryEpoch,
    encodeTreeBytes(r.publicKeyDigest), r.grants]));
  const statement: FileHeadStatement = { ownerId: context.ownerId, vaultId: context.ownerId, fileId,
    revision, contentKey: { id: contentKeyId, epoch: s.contentKey.epoch + 1 },
    receivingKey: s.receivingKey, representation: { id: representationId,
      digest: await digest(fresh.contentEnvelope) },
    parentEnvelopeDigest: await digest(fresh.parentEnvelope),
    recipientSetVersion: s.recipientSetVersion + (oldMembership === newMembership ? 0 : 1),
    recipients: descriptors, publication: { status: "none" }, signerDeviceId: device.deviceId };
  const signed = await signFileHead(statement, device.assertionKeyPair.privateKey);
  const saved = await privateRequest(`/api/private/tree/files/${fileId}`, { method: "PATCH",
    body: JSON.stringify({ expectedHeadDigest: trustedHead.digest, expectedRevision: s.revision,
      expectedRecipientSetVersion: s.recipientSetVersion, parentEnvelope: encodeTreeBytes(fresh.parentEnvelope),
      recipientEnvelopes: fresh.recipientEnvelopes.map((r) => ({ deviceId: r.deviceId,
        ciphertext: encodeTreeBytes(r.envelope) })),
      representation: { id: representationId, contentKeyId, keyEpoch: s.contentKey.epoch + 1,
        revision, ciphertext: encodeTreeBytes(fresh.contentEnvelope) }, signedHead: wireHead(signed) }) });
  if (saved.status === 409) throw new FileChangedError();
  if (!saved.ok) throw new Error("File save failed");
  const result = await saved.json() as { revision: number; headDigest: string };
  if (result.revision !== revision || result.headDigest !== encodeTreeBytes(signed.digest)) {
    throw new FileSaveUncertainError();
  }
  return result;
}

/** A direct File editor never loads a Directory, parent ID or owned Vault root. */
export async function commitDirectFileSave(actorAccountId: string, fileId: string,
  file: LoadedDirectFile, source: string): Promise<LoadedDirectFile> {
  const saved = await saveWithFileContext({ actorAccountId, fileId, source, metadata: file.metadata,
    expectedOwnerId: file.ownerId, trustedHead: file.signedHead, receivingPublicKey: file.receivingPublicKey });
  const fresh = await loadDirectFile(actorAccountId, fileId);
  if (fresh.revision !== saved.revision || encodeTreeBytes(fresh.head.digest) !== saved.headDigest ||
      fresh.markdown !== source || fresh.ownerId !== file.ownerId) throw new FileSaveUncertainError();
  return fresh;
}

/** Only the browser sees source and metadata. The signed head also commits to the new parent envelope. */
export async function commitFileSave(options: {
  access: RootAccess; fileId: string; file: LoadedFile; source: string;
  listing: DirectoryListing; parentKey: Uint8Array;
}): Promise<{ file: LoadedFile; listing: DirectoryListing }> {
  const { access, fileId, file, source, listing, parentKey } = options;
  if (file.v2) {
    const committed = await saveWithFileContext({ actorAccountId: access.actorAccountId ?? access.vaultId,
      fileId, source, metadata: file.metadata,
      trustedHead: file.v2.signedHead, receivingPublicKey: file.v2.receivingPublicKey });
    const current = await loadDirectory(access, file.parentId, parentKey);
    const entry = current.entries.find((item) => item.nodeId === fileId && item.kind === "file");
    if (!entry) throw new FileSaveUncertainError();
    const fresh = await loadFile(access, fileId, file.parentId, parentKey, entry);
    if (!fresh.v2 || fresh.revision !== committed.revision ||
        encodeTreeBytes(fresh.v2.head.digest) !== committed.headDigest || fresh.markdown !== source) {
      throw new FileSaveUncertainError();
    }
    return { file: fresh, listing: current };
  }
  if (!withinFileLimit(source) || listing.directoryId !== file.parentId ||
      !listing.entries.some((entry) => entry.nodeId === fileId && entry.kind === "file")) {
    throw new Error("invalid File save");
  }
  // Legacy saves remain supported on the Worker, but the owned browser explicitly
  // upgrades a fully verified v1 listing before taking the File-only save path.
  const migrated = await migrateOwnedFile({ access, fileId, file, listing, parentKey });
  return commitFileSave({ ...options, file: migrated.file, listing: migrated.listing });
}

/** Original v1 producer retained for older in-tab clients and regression vectors. */
export async function commitLegacyFileSave(options: {
  access: RootAccess; fileId: string; file: LoadedFile; source: string;
  listing: DirectoryListing; parentKey: Uint8Array;
}): Promise<{ file: LoadedFile; listing: DirectoryListing }> {
  const { access, fileId, file, source, listing, parentKey } = options;
  if (file.v2 || listing.directoryId !== file.parentId || !withinFileLimit(source)) throw new Error("invalid File save");
  const device = await getDevice(access.actorAccountId ?? access.vaultId);
  if (!device) throw new Error("private File unavailable");
  const contentKeyId = newOpaqueId(), representationId = newOpaqueId(), revision = file.revision + 1;
  const fresh = await createFileRepresentation(parentKey, { markdown: source, metadata: file.metadata },
    { vaultId: access.vaultId, fileId, keyId: contentKeyId, keyEpoch: 1, revision });
  const keyEnvelope = encodeTreeBytes(fresh.fileContentKeyEnvelope);
  const head = await createListingHead(parentKey, device.assertionKeyPair.privateKey, {
    vaultId: access.vaultId, directoryId: file.parentId, deviceId: device.deviceId,
    epoch: listing.capabilityEpoch, revision: listing.entriesRevision + 1, version: listing.listingVersion ?? 1,
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
