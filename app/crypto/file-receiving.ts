import {
  createSymmetricWriter, EnvelopeError, openForRecipient, openSymmetric, sealToRecipient,
  type EnvelopeContext,
} from "./enc-v1";
import { encodeContext, equal } from "./enc-v1/format";
import { encodeFileRepresentation, generateFileContentKey, type FileRepresentationPayload } from "./vault";

export interface FileReceivingIdentity {
  vaultId: string;
  fileId: string;
  receivingKeyId: string;
  receivingEpoch: number;
  /** Structural-entry revision at creation/rewrap, NOT the later File-save revision. */
  wrapRevision: number;
}

export interface FileReceivingKey extends FileReceivingIdentity {
  publicKey: Uint8Array<ArrayBuffer>;
  publicKeyDigest: Uint8Array<ArrayBuffer>;
  /** Non-extractable private handle; PKCS#8 is returned only inside the parent envelope. */
  keyPair: CryptoKeyPair;
  privateKeyEnvelope: Uint8Array<ArrayBuffer>;
}

function bytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array)) throw new EnvelopeError("malformed");
  return new Uint8Array(value);
}

function receivingContext(identity: FileReceivingIdentity): EnvelopeContext {
  return {
    purpose: "file-receiving-key", vaultId: identity.vaultId,
    objectId: identity.fileId, keyId: identity.receivingKeyId,
    keyEpoch: identity.receivingEpoch, revision: identity.wrapRevision,
  };
}

function snapshot(identity: FileReceivingIdentity): FileReceivingIdentity {
  if (!identity || !Number.isSafeInteger(identity.receivingEpoch) || identity.receivingEpoch < 1 ||
      !Number.isSafeInteger(identity.wrapRevision) || identity.wrapRevision < 1) throw new EnvelopeError("malformed");
  return { vaultId: identity.vaultId, fileId: identity.fileId, receivingKeyId: identity.receivingKeyId,
    receivingEpoch: identity.receivingEpoch, wrapRevision: identity.wrapRevision };
}

async function importPublic(input: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (input.length !== 65 || input[0] !== 4) throw new EnvelopeError("malformed");
  try {
    return await crypto.subtle.importKey("raw", input, { name: "ECDH", namedCurve: "P-256" }, true, []);
  } catch { throw new EnvelopeError("malformed"); }
}

/** One independent receiving pair per File/capability epoch. The parent key never becomes a write target. */
export async function createFileReceivingKey(
  directoryCapability: Uint8Array, identity: FileReceivingIdentity,
): Promise<FileReceivingKey> {
  const details = snapshot(identity);
  const writer = await createSymmetricWriter(bytes(directoryCapability));
  const generated = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", generated.publicKey));
  const serialized = new Uint8Array(await crypto.subtle.exportKey("pkcs8", generated.privateKey));
  try {
    const privateKeyEnvelope = await writer.seal(serialized, receivingContext(details));
    const privateKey = await crypto.subtle.importKey("pkcs8", serialized, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    return { ...details, publicKey, publicKeyDigest: new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey)),
      keyPair: { publicKey: await importPublic(publicKey), privateKey }, privateKeyEnvelope };
  } finally { serialized.fill(0); }
}

/** `expected.publicKey` must come from a verified File head or the locally generated pair. */
export async function openFileReceivingKey(
  envelope: Uint8Array, directoryCapability: Uint8Array,
  expected: FileReceivingIdentity & { publicKey: Uint8Array },
): Promise<CryptoKeyPair> {
  const details = snapshot(expected);
  const publicBytes = bytes(expected.publicKey);
  const encrypted = bytes(envelope);
  const parentKey = bytes(directoryCapability);
  const publicKey = await importPublic(publicBytes);
  const plaintext = await openSymmetric(encrypted, parentKey, { context: receivingContext(details) });
  let privateKey: CryptoKey;
  try { privateKey = await importReceivingPrivate(plaintext); }
  finally { plaintext.fill(0); }
  const keyPair = { publicKey, privateKey };
  await verifyReceivingPair(keyPair, details);
  return keyPair;
}

async function importReceivingPrivate(serialized: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey("pkcs8", serialized, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  } catch { throw new EnvelopeError("malformed"); }
}

async function verifyReceivingPair(keyPair: CryptoKeyPair, details: FileReceivingIdentity): Promise<void> {
  // HPKE base-mode challenge checks that the decrypted private handle matches the
  // externally trusted public target without implementing an ECDH transport protocol.
  const context: EnvelopeContext = { purpose: "file-content-key", vaultId: details.vaultId,
    objectId: details.fileId, keyId: details.receivingKeyId, keyEpoch: details.receivingEpoch,
    revision: details.wrapRevision, recipientId: details.receivingKeyId };
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  try {
    const probe = await sealToRecipient(challenge, keyPair.publicKey, context);
    const opened = await openForRecipient(probe, keyPair, { context });
    if (opened.length !== challenge.length || !opened.every((value, index) => value === challenge[index])) {
      throw new EnvelopeError("authentication-failed");
    }
  } catch { throw new EnvelopeError("authentication-failed"); }
  finally { challenge.fill(0); }
}

/**
 * Rewraps the same File receiving pair under another Directory capability at a
 * strictly newer structural wrapping revision (not a File-content revision).
 * `expected` must come from a verified current structural entry and File public
 * target. This helper does not authorize the move, detect loss of readership,
 * rotate the pair, or revoke anyone holding the old wrapper and old Directory key.
 * The caller must reject/defer moves that lose shared scope until required
 * receiving-pair rotation is complete (ticket 19).
 */
export async function rewrapFileReceivingKey(
  envelope: Uint8Array, sourceDirectoryCapability: Uint8Array, destinationDirectoryCapability: Uint8Array,
  expected: FileReceivingIdentity & { publicKey: Uint8Array }, newWrapRevision: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const details = snapshot(expected);
  const publicBytes = bytes(expected.publicKey);
  const encrypted = bytes(envelope);
  const sourceKey = bytes(sourceDirectoryCapability);
  const destinationKey = bytes(destinationDirectoryCapability);
  if (!Number.isSafeInteger(newWrapRevision) || newWrapRevision < 1) throw new EnvelopeError("malformed");
  if (newWrapRevision <= details.wrapRevision) throw new EnvelopeError("context-mismatch");
  const newContext = receivingContext({ ...details, wrapRevision: newWrapRevision });
  encodeContext(newContext);
  const publicKey = await importPublic(publicBytes);
  const serialized = await openSymmetric(encrypted, sourceKey, { context: receivingContext(details) });
  try {
    const privateKey = await importReceivingPrivate(serialized);
    await verifyReceivingPair({ publicKey, privateKey }, details);
    const writer = await createSymmetricWriter(destinationKey);
    return await writer.seal(serialized, newContext);
  } finally { serialized.fill(0); }
}

/** Exact public target commitment from a verified File head (or locally generated first pair). */
export interface FileReceivingTargetCommitment {
  vaultId: string;
  fileId: string;
  receivingKeyId: string;
  receivingEpoch: number;
  publicKeyDigest: Uint8Array;
}

export interface FileSaveIdentity {
  vaultId: string;
  fileId: string;
  contentKeyId: string;
  contentEpoch: number;
  revision: number;
}

export interface FileSave {
  fileContentKey: Uint8Array<ArrayBuffer>;
  contentEnvelope: Uint8Array<ArrayBuffer>;
  parentEnvelope: Uint8Array<ArrayBuffer>;
  recipientEnvelopes: { deviceId: string; envelope: Uint8Array<ArrayBuffer> }[];
  contentContext: EnvelopeContext;
}

function contentContext(identity: FileSaveIdentity, purpose: "file-content" | "file-content-key" | "grant", recipientId?: string): EnvelopeContext {
  return { purpose, vaultId: identity.vaultId, objectId: identity.fileId, keyId: identity.contentKeyId,
    keyEpoch: identity.contentEpoch, revision: identity.revision, ...(recipientId === undefined ? {} : { recipientId }) };
}

function saveIdentity(input: FileSaveIdentity): FileSaveIdentity {
  if (!input || !Number.isSafeInteger(input.revision) || input.revision < 1 ||
      !Number.isSafeInteger(input.contentEpoch) || input.contentEpoch < 1) throw new EnvelopeError("malformed");
  const identity = { vaultId: input.vaultId, fileId: input.fileId, contentKeyId: input.contentKeyId,
    contentEpoch: input.contentEpoch, revision: input.revision };
  encodeContext(contentContext(identity, "file-content"));
  return identity;
}

/** Never use a public key merely because the service returned it; compare with a trusted head. */
export async function assertFileReceivingTarget(publicKey: Uint8Array, expected: FileReceivingTargetCommitment): Promise<CryptoKey> {
  const raw = bytes(publicKey);
  const digest = bytes(expected.publicKeyDigest);
  const context = { purpose: "file-receiving-key" as const, vaultId: expected.vaultId,
    objectId: expected.fileId, keyId: expected.receivingKeyId, keyEpoch: expected.receivingEpoch, revision: 1 };
  if (!Number.isSafeInteger(expected.receivingEpoch) || expected.receivingEpoch < 1 || digest.length !== 32) {
    throw new EnvelopeError("malformed");
  }
  encodeContext(context);
  const imported = await importPublic(raw);
  if (!equal(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)), digest)) {
    throw new EnvelopeError("context-mismatch");
  }
  return imported;
}

/** One save creates a new random key; no parent Directory capability is required. */
export async function createFileSave(
  representation: Uint8Array | FileRepresentationPayload,
  receivingPublicKey: Uint8Array,
  trustedTarget: FileReceivingTargetCommitment,
  options: FileSaveIdentity,
  recipients: readonly { deviceId: string; publicKey: CryptoKey }[],
): Promise<FileSave> {
  const identity = saveIdentity(options);
  const target = { vaultId: trustedTarget.vaultId, fileId: trustedTarget.fileId,
    receivingKeyId: trustedTarget.receivingKeyId, receivingEpoch: trustedTarget.receivingEpoch,
    publicKeyDigest: bytes(trustedTarget.publicKeyDigest) };
  const publicKeyBytes = bytes(receivingPublicKey);
  const message = representation instanceof Uint8Array ? bytes(representation) :
    encodeFileRepresentation({ markdown: representation.markdown, metadata: bytes(representation.metadata) });
  if (!Array.isArray(recipients) || recipients.length > 256) throw new EnvelopeError("malformed");
  const devices = recipients.map(({ deviceId, publicKey }) => ({ deviceId, publicKey }));
  if (target.vaultId !== identity.vaultId || target.fileId !== identity.fileId ||
      new Set(devices.map((device) => device.deviceId)).size !== devices.length) throw new EnvelopeError("context-mismatch");
  for (const device of devices) encodeContext(contentContext(identity, "grant", device.deviceId));
  const receiver = await assertFileReceivingTarget(publicKeyBytes, target);
  const fileContentKey = generateFileContentKey();
  const fileContext = contentContext(identity, "file-content");
  const writer = await createSymmetricWriter(fileContentKey);
  const contentEnvelope = await writer.seal(message, fileContext);
  const parentEnvelope = await sealToRecipient(fileContentKey, receiver,
    contentContext(identity, "file-content-key", target.receivingKeyId));
  const recipientEnvelopes = await Promise.all(devices.map(async ({ deviceId, publicKey }) => ({ deviceId,
    envelope: await sealToRecipient(fileContentKey, publicKey, contentContext(identity, "grant", deviceId)),
  })));
  return { fileContentKey, contentEnvelope, parentEnvelope, recipientEnvelopes, contentContext: fileContext };
}

function openedKey(plaintext: Uint8Array): Uint8Array<ArrayBuffer> {
  if (plaintext.length !== 32) throw new EnvelopeError("malformed");
  return new Uint8Array(plaintext);
}

export async function openFileContentKeyFromReceiving(
  envelope: Uint8Array, receivingKeyPair: CryptoKeyPair,
  expected: FileSaveIdentity & { receivingKeyId: string },
): Promise<Uint8Array<ArrayBuffer>> {
  const identity = saveIdentity(expected);
  return openedKey(await openForRecipient(bytes(envelope), receivingKeyPair,
    { context: contentContext(identity, "file-content-key", expected.receivingKeyId) }));
}

export async function openFileContentKeyFromDevice(
  envelope: Uint8Array, deviceKeyPair: CryptoKeyPair,
  expected: FileSaveIdentity & { deviceId: string },
): Promise<Uint8Array<ArrayBuffer>> {
  const identity = saveIdentity(expected);
  return openedKey(await openForRecipient(bytes(envelope), deviceKeyPair,
    { context: contentContext(identity, "grant", expected.deviceId) }));
}
