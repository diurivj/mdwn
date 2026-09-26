import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

import {
  createSymmetricWriter,
  digestEnvelope,
  EnvelopeError,
  inspectEnvelope,
  openForRecipient,
  openSymmetric,
  openSymmetricWithLabel,
  sealToRecipient,
  type EnvelopeContext,
  type EnvelopeExpectation,
} from "./enc-v1";

export { EnvelopeError } from "./enc-v1";
export type { EnvelopeContext, EnvelopeExpectation } from "./enc-v1";

export const RECOVERY_CAPSULE_HKDF_LABEL = "mdwn/vault-recovery-capsule/v1";
export const RECOVERY_CAPSULE_PURPOSE = "recovery-capsule" as const;
export const RECOVERY_CAPSULE_OBJECT_ID = "vault-recovery-capsule";
export const RECOVERY_CAPSULE_KEY_ID = "vault-recovery-capsule";
export const KEY_BYTES = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const CAPSULE_MAGIC = encoder.encode(`${RECOVERY_CAPSULE_HKDF_LABEL}\0`);
const FILE_REPRESENTATION_MAGIC = encoder.encode("mdwn/file-representation/v1\0");

export type Bytes = Uint8Array<ArrayBuffer>;

export type RecoveryErrorCode =
  | "malformed"
  | "invalid-phrase"
  | "wrong-account"
  | "wrong-generation"
  | "superseded-generation"
  | "wrong-salt"
  | "authentication-failed"
  | "grant-capability"
  | "missing-key";

/** Bounded recovery errors never contain phrases, keys, IDs, or crypto details. */
export class RecoveryError extends Error {
  constructor(readonly code: RecoveryErrorCode) {
    super(`mdwn/vault: ${code}`);
    this.name = "RecoveryError";
  }
}

export interface VaultRecoveryCapability {
  key: Uint8Array;
  objectId: string;
  keyId: string;
  /** Only Account-owned capabilities may enter the Vault-recovery envelope. */
  scope: "owned" | "grant";
  /** Defensive runtime marker for callers carrying provenance separately. */
  grantDerived?: boolean;
}

export interface ChildDirectoryCapability {
  directoryId: string;
  capabilityKey: Bytes;
  envelope: Bytes;
  context: EnvelopeContext;
}

export interface FileRepresentation {
  fileContentKey: Bytes;
  fileContentKeyEnvelope: Bytes;
  contentEnvelope: Bytes;
  keyContext: EnvelopeContext;
  contentContext: EnvelopeContext;
}

export interface FileRepresentationPayload {
  markdown: string;
  /** The caller supplies canonical encoded private File metadata bytes. */
  metadata: Uint8Array;
}

export interface VaultKeyHierarchy {
  accountId: string;
  rootDirectoryId: string;
  vaultRootKey: Bytes;
  rootDirectoryCapabilityKey: Bytes;
  rootDirectoryRecoveryEnvelope: Bytes;
  rootDirectoryRecoveryContext: EnvelopeContext;
}

export interface RecoveryCapsuleRecord {
  accountId: string;
  generation: number;
  /** Public salt copied from the canonical envelope header. */
  recoverySalt: Bytes;
  /** Opaque canonical mdwn/enc-v1 bytes. */
  capsule: Bytes;
  /** Raw SEC1 P-256 verification public key. */
  recoveryVerificationPublicKey: Bytes;
}

export interface RecoveryCapsuleExpectation {
  /** Current values come from authenticated Account state, never the capsule itself. */
  accountId: string;
  generation: number;
  /** Optional trusted copy of the current public recovery salt. */
  recoverySalt?: Uint8Array;
}

export interface OpenedRecoveryCapsule {
  accountId: string;
  generation: number;
  vaultRootKey: Bytes;
  recoveryEnrollmentKeyPair: CryptoKeyPair;
  recoveryVerificationPublicKey: CryptoKey;
  /** Raw private PKCS#8 is deliberately not returned after import. */
  recoveryVerificationPublicKeyBytes: Bytes;
}

export interface RecoveryMaterial {
  accountId: string;
  generation: number;
  vaultRootKey: Bytes;
  recoverySecret: Bytes;
  phrase: string;
  recoverySalt: Bytes;
  recoveryEnrollmentKeyPair: CryptoKeyPair;
  recoveryVerificationPublicKey: CryptoKey;
  recoveryVerificationPublicKeyBytes: Bytes;
  record: RecoveryCapsuleRecord;
}

function copy(value: Uint8Array): Bytes {
  return new Uint8Array(value);
}

function concat(...parts: Uint8Array[]): Bytes {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function u16(value: number): Bytes {
  const output = new Uint8Array(2);
  new DataView(output.buffer).setUint16(0, value);
  return output;
}

function u32(value: number): Bytes {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value);
  return output;
}

function u64(value: number): Bytes {
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, BigInt(value));
  return output;
}

function randomKey(): Bytes {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

function idBytes(value: string): Bytes {
  if (typeof value !== "string") throw new RecoveryError("malformed");
  const bytes = encoder.encode(value);
  try {
    if (!bytes.length || bytes.length > 256 || decoder.decode(bytes) !== value) throw new RecoveryError("malformed");
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    throw new RecoveryError("malformed");
  }
  return bytes;
}

function checkKey(value: Uint8Array, code: RecoveryErrorCode = "malformed"): Bytes {
  if (!(value instanceof Uint8Array) || value.length !== KEY_BYTES) throw new RecoveryError(code);
  return copy(value);
}

function checkGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RecoveryError("malformed");
  return value;
}

function checkCapsuleExpectation(expected: RecoveryCapsuleExpectation): void {
  idBytes(expected.accountId);
  checkGeneration(expected.generation);
  const salt = expected.recoverySalt;
  if (salt !== undefined && salt.length !== 32) throw new RecoveryError("wrong-salt");
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

function contextForRecoveryCapsule(accountId: string, generation: number): EnvelopeContext {
  return {
    purpose: RECOVERY_CAPSULE_PURPOSE,
    vaultId: accountId,
    objectId: RECOVERY_CAPSULE_OBJECT_ID,
    keyId: RECOVERY_CAPSULE_KEY_ID,
    keyEpoch: generation,
    revision: 1,
  };
}

/** Canonical HKDF info: fixed domain label + length-prefixed Account ID + generation. */
export function recoveryCapsuleInfo(accountId: string, generation: number): Bytes {
  const account = idBytes(accountId);
  checkGeneration(generation);
  return concat(encoder.encode(RECOVERY_CAPSULE_HKDF_LABEL), u16(account.length), account, u64(generation));
}

/** Create a checksum-protected 24-word English phrase from exactly 256 secret bits. */
export function generateRecoveryPhrase(secret: Uint8Array = randomKey()): string {
  return entropyToMnemonic(checkKey(secret), wordlist);
}

/** Decode and validate a phrase without deriving a password or a seed. */
export function recoveryPhraseToSecret(phrase: string): Bytes {
  if (typeof phrase !== "string" || phrase.trim().split(/\s+/u).length !== 24 || !validateMnemonic(phrase, wordlist)) {
    throw new RecoveryError("invalid-phrase");
  }
  try {
    const secret = mnemonicToEntropy(phrase, wordlist);
    return checkKey(secret, "invalid-phrase");
  } catch {
    throw new RecoveryError("invalid-phrase");
  }
}

export function validateRecoveryPhrase(phrase: string): boolean {
  try {
    return typeof phrase === "string" && phrase.trim().split(/\s+/u).length === 24 && validateMnemonic(phrase, wordlist);
  } catch {
    return false;
  }
}

async function generateRecoverySigningKeys(): Promise<{
  keyPair: CryptoKeyPair;
  privateKeyBytes: Bytes;
  publicKeyBytes: Bytes;
}> {
  const generated = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
  ) as CryptoKeyPair;
  const privateKeyBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", generated.privateKey));
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", generated.publicKey));
  const privateKey = await crypto.subtle.importKey(
    "pkcs8", privateKeyBytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  const publicKey = await crypto.subtle.importKey(
    "raw", publicKeyBytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
  );
  return { keyPair: { privateKey, publicKey }, privateKeyBytes, publicKeyBytes };
}

function encodeCapsulePlaintext(vaultRootKey: Uint8Array, recoveryPrivateKey: Uint8Array): Bytes {
  return concat(CAPSULE_MAGIC, checkKey(vaultRootKey), u32(recoveryPrivateKey.length), recoveryPrivateKey);
}

function decodeCapsulePlaintext(input: Uint8Array): { vaultRootKey: Bytes; recoveryPrivateKey: Bytes } {
  const bytes = copy(input);
  const minimum = CAPSULE_MAGIC.length + KEY_BYTES + 4;
  if (bytes.length < minimum || !equal(bytes.slice(0, CAPSULE_MAGIC.length), CAPSULE_MAGIC)) {
    throw new RecoveryError("malformed");
  }
  let offset = CAPSULE_MAGIC.length;
  const vaultRootKey = bytes.slice(offset, offset + KEY_BYTES);
  offset += KEY_BYTES;
  const privateKeyLength = new DataView(bytes.buffer).getUint32(offset);
  offset += 4;
  if (!privateKeyLength || privateKeyLength > 4096 || offset + privateKeyLength !== bytes.length) {
    throw new RecoveryError("malformed");
  }
  return { vaultRootKey: checkKey(vaultRootKey), recoveryPrivateKey: bytes.slice(offset) };
}

/** Canonically joins Markdown and its encrypted File metadata in one payload. */
export function encodeFileRepresentation(payload: FileRepresentationPayload): Bytes {
  if (!payload || typeof payload.markdown !== "string" || !(payload.metadata instanceof Uint8Array)) {
    throw new RecoveryError("malformed");
  }
  const markdown = encoder.encode(payload.markdown);
  if (markdown.length > 262_144 || payload.metadata.length > 262_144) throw new RecoveryError("malformed");
  return concat(
    FILE_REPRESENTATION_MAGIC,
    u32(markdown.length), markdown,
    u32(payload.metadata.length), copy(payload.metadata),
  );
}

export function decodeFileRepresentation(input: Uint8Array): FileRepresentationPayload {
  const bytes = copy(input);
  if (bytes.length < FILE_REPRESENTATION_MAGIC.length + 8 ||
      !equal(bytes.slice(0, FILE_REPRESENTATION_MAGIC.length), FILE_REPRESENTATION_MAGIC)) {
    throw new RecoveryError("malformed");
  }
  let offset = FILE_REPRESENTATION_MAGIC.length;
  const markdownLength = new DataView(bytes.buffer).getUint32(offset);
  offset += 4;
  if (offset + markdownLength + 4 > bytes.length) throw new RecoveryError("malformed");
  const markdownBytes = bytes.slice(offset, offset + markdownLength);
  offset += markdownLength;
  const metadataLength = new DataView(bytes.buffer).getUint32(offset);
  offset += 4;
  if (offset + metadataLength !== bytes.length) throw new RecoveryError("malformed");
  try {
    return { markdown: decoder.decode(markdownBytes), metadata: bytes.slice(offset) };
  } catch {
    throw new RecoveryError("malformed");
  }
}

function recordSalt(record: RecoveryCapsuleRecord): Bytes {
  if (!record || typeof record !== "object") throw new RecoveryError("wrong-salt");
  const salt = record.recoverySalt;
  if (!(salt instanceof Uint8Array) || salt.length !== 32) throw new RecoveryError("wrong-salt");
  return copy(salt);
}

function makeRecord(
  accountId: string,
  generation: number,
  envelope: Uint8Array,
  publicKeyBytes: Uint8Array,
): RecoveryCapsuleRecord {
  const header = inspectEnvelope(envelope);
  if (!header.salt) throw new RecoveryError("malformed");
  const salt = copy(header.salt);
  const bytes = copy(envelope);
  const publicKey = copy(publicKeyBytes);
  return {
    accountId,
    generation,
    recoverySalt: copy(salt),
    capsule: copy(bytes),
    recoveryVerificationPublicKey: publicKey,
  };
}

async function sealRecoveryCapsule(
  accountId: string,
  generation: number,
  recoverySecret: Uint8Array,
  vaultRootKey: Uint8Array,
  recoveryPrivateKey: Uint8Array,
): Promise<Bytes> {
  idBytes(accountId);
  checkGeneration(generation);
  checkKey(recoverySecret);
  const writer = await createSymmetricWriter(recoverySecret, {
    infoLabel: recoveryCapsuleInfo(accountId, generation),
  });
  return writer.seal(
    encodeCapsulePlaintext(vaultRootKey, recoveryPrivateKey),
    contextForRecoveryCapsule(accountId, generation),
  );
}

export async function createRecoveryMaterial(
  accountId: string,
  options: { generation?: number; vaultRootKey?: Uint8Array } = {},
): Promise<RecoveryMaterial> {
  idBytes(accountId);
  const generation = checkGeneration(options.generation ?? 1);
  const vaultRootKey = options.vaultRootKey === undefined ? randomKey() : checkKey(options.vaultRootKey);
  const recoverySecret = randomKey();
  const phrase = generateRecoveryPhrase(recoverySecret);
  const signing = await generateRecoverySigningKeys();
  const envelope = await sealRecoveryCapsule(
    accountId, generation, recoverySecret, vaultRootKey, signing.privateKeyBytes,
  );
  const record = makeRecord(accountId, generation, envelope, signing.publicKeyBytes);
  return {
    accountId,
    generation,
    vaultRootKey: copy(vaultRootKey),
    recoverySecret: copy(recoverySecret),
    phrase,
    recoverySalt: copy(record.recoverySalt),
    recoveryEnrollmentKeyPair: signing.keyPair,
    recoveryVerificationPublicKey: signing.keyPair.publicKey,
    recoveryVerificationPublicKeyBytes: copy(signing.publicKeyBytes),
    record,
  };
}

export async function openRecoveryCapsule(
  record: RecoveryCapsuleRecord,
  phrase: string,
  expected: RecoveryCapsuleExpectation,
): Promise<OpenedRecoveryCapsule> {
  checkCapsuleExpectation(expected);
  if (!record || typeof record !== "object" || !(record.capsule instanceof Uint8Array)) {
    throw new RecoveryError("malformed");
  }
  const expectedAccountId = expected.accountId;
  const expectedGeneration = expected.generation;
  const expectedSalt = expected.recoverySalt === undefined ? undefined : copy(expected.recoverySalt);
  const envelope = copy(record.capsule);
  const salt = recordSalt(record);
  if (expectedAccountId !== record.accountId) throw new RecoveryError("wrong-account");
  if (expectedSalt !== undefined && !equal(expectedSalt, salt)) {
    throw new RecoveryError("wrong-salt");
  }
  let header: ReturnType<typeof inspectEnvelope>;
  try {
    header = inspectEnvelope(envelope);
  } catch {
    throw new RecoveryError("malformed");
  }
  if (header.suite !== "AES-256-GCM/HKDF-SHA-256" || !header.salt || !equal(header.salt, salt)) {
    throw new RecoveryError("wrong-salt");
  }
  if (header.context.purpose !== RECOVERY_CAPSULE_PURPOSE || header.context.vaultId !== record.accountId ||
      header.context.keyEpoch !== record.generation) {
    throw new RecoveryError("malformed");
  }
  if (expectedAccountId !== header.context.vaultId) throw new RecoveryError("wrong-account");
  if (expectedGeneration > header.context.keyEpoch) throw new RecoveryError("superseded-generation");
  if (expectedGeneration < header.context.keyEpoch) throw new RecoveryError("wrong-generation");

  const recoverySecret = recoveryPhraseToSecret(phrase);
  let publicKeyAttempted = false;
  try {
    const plaintext = await openSymmetricWithLabel(
      envelope,
      recoverySecret,
      { context: contextForRecoveryCapsule(expectedAccountId, expectedGeneration) },
      recoveryCapsuleInfo(expectedAccountId, expectedGeneration),
    );
    const decoded = decodeCapsulePlaintext(plaintext);
    const privateKey = await crypto.subtle.importKey(
      "pkcs8", decoded.recoveryPrivateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
    );
    const publicKeyBytes = record.recoveryVerificationPublicKey;
    if (!(publicKeyBytes instanceof Uint8Array) || publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 4) {
      throw new RecoveryError("missing-key");
    }
    publicKeyAttempted = true;
    const publicKey = await crypto.subtle.importKey(
      "raw", publicKeyBytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    const keyCheck = encoder.encode("mdwn/recovery-capsule-key-check/v1");
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, keyCheck);
    const matches = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, publicKey, signature, keyCheck,
    );
    if (!matches) throw new RecoveryError("missing-key");
    return {
      accountId: expectedAccountId,
      generation: expectedGeneration,
      vaultRootKey: decoded.vaultRootKey,
      recoveryEnrollmentKeyPair: { privateKey, publicKey },
      recoveryVerificationPublicKey: publicKey,
      recoveryVerificationPublicKeyBytes: copy(publicKeyBytes),
    };
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    if (error instanceof EnvelopeError && error.code === "authentication-failed") {
      throw new RecoveryError("authentication-failed");
    }
    if (error instanceof EnvelopeError && error.code === "stale-epoch") {
      throw new RecoveryError("superseded-generation");
    }
    if (publicKeyAttempted) throw new RecoveryError("missing-key");
    throw new RecoveryError("authentication-failed");
  }
}

export async function reissueRecoveryMaterial(
  record: RecoveryCapsuleRecord,
  phrase: string,
  expected: RecoveryCapsuleExpectation,
): Promise<RecoveryMaterial> {
  checkCapsuleExpectation(expected);
  const accountId = expected.accountId;
  const currentGeneration = expected.generation;
  const expectedSalt = expected.recoverySalt === undefined ? undefined : copy(expected.recoverySalt);
  if (accountId !== record.accountId || currentGeneration !== record.generation) {
    throw new RecoveryError(currentGeneration > record.generation ? "superseded-generation" : "wrong-generation");
  }
  const opened = await openRecoveryCapsule(record, phrase, {
    accountId,
    generation: currentGeneration,
    recoverySalt: expectedSalt ?? recordSalt(record),
  });
  return createRecoveryMaterial(accountId, {
    generation: currentGeneration + 1,
    vaultRootKey: opened.vaultRootKey,
  });
}

export async function sealVaultRecoveryEnvelope(
  vaultRootKey: Uint8Array,
  capability: VaultRecoveryCapability,
  context: EnvelopeContext,
): Promise<Bytes> {
  checkKey(vaultRootKey);
  if (!capability || capability.scope !== "owned" || capability.grantDerived === true) {
    throw new RecoveryError("grant-capability");
  }
  const capabilityKey = checkKey(capability.key);
  idBytes(capability.objectId);
  idBytes(capability.keyId);
  if (context.purpose !== "vault-recovery") throw new RecoveryError("malformed");
  if (context.objectId !== capability.objectId || context.keyId !== capability.keyId) throw new RecoveryError("malformed");
  const writer = await createSymmetricWriter(vaultRootKey);
  return writer.seal(capabilityKey, context);
}

export async function openVaultRecoveryEnvelope(
  envelope: Uint8Array,
  vaultRootKey: Uint8Array,
  context: EnvelopeContext,
): Promise<Bytes> {
  checkKey(vaultRootKey);
  if (context.purpose !== "vault-recovery") throw new RecoveryError("malformed");
  try {
    return await openSymmetric(envelope, vaultRootKey, { context });
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    if (error instanceof EnvelopeError && error.code === "authentication-failed") {
      throw new RecoveryError("authentication-failed");
    }
    throw error;
  }
}

/** A recovered device can provision only Account-owned recovery-envelope capabilities. */
export async function sealOwnedDeviceEnvelope(
  capability: VaultRecoveryCapability,
  recipientPublicKey: CryptoKey,
  context: EnvelopeContext,
): Promise<Bytes> {
  if (!capability || capability.scope !== "owned" || capability.grantDerived === true ||
      context.purpose !== "owned-device" || context.objectId !== capability.objectId ||
      context.keyId !== capability.keyId || !context.recipientId) {
    throw new RecoveryError("grant-capability");
  }
  return sealToRecipient(checkKey(capability.key), recipientPublicKey, context);
}

export async function openOwnedDeviceEnvelope(
  envelope: Uint8Array,
  recipient: CryptoKeyPair,
  context: EnvelopeContext,
): Promise<Bytes> {
  if (context.purpose !== "owned-device" || !context.recipientId) throw new RecoveryError("malformed");
  return openForRecipient(envelope, recipient, { context });
}

export async function sealDeviceEnrollmentEnvelope(
  vaultRootKey: Uint8Array,
  recipientPublicKey: CryptoKey,
  context: EnvelopeContext,
): Promise<Bytes> {
  checkKey(vaultRootKey);
  if (context.purpose !== "device-enrollment" || !context.recipientId) throw new RecoveryError("malformed");
  try {
    return await sealToRecipient(vaultRootKey, recipientPublicKey, context);
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    throw new RecoveryError("malformed");
  }
}

export async function openDeviceEnrollmentEnvelope(
  envelope: Uint8Array,
  recipient: CryptoKeyPair,
  context: EnvelopeContext,
): Promise<Bytes> {
  if (context.purpose !== "device-enrollment" || !context.recipientId) throw new RecoveryError("malformed");
  try {
    return await openForRecipient(envelope, recipient, { context });
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    if (error instanceof EnvelopeError && error.code === "authentication-failed") {
      throw new RecoveryError("authentication-failed");
    }
    throw error;
  }
}

export function generateVaultRootKey(): Bytes {
  return randomKey();
}

export function generateDirectoryCapabilityKey(): Bytes {
  return randomKey();
}

export function generateFileContentKey(): Bytes {
  return randomKey();
}

export async function createVaultKeyHierarchy(options: {
  accountId: string;
  rootDirectoryId: string;
  vaultRootKey?: Uint8Array;
}): Promise<VaultKeyHierarchy> {
  idBytes(options.accountId);
  idBytes(options.rootDirectoryId);
  const vaultRootKey = options.vaultRootKey === undefined ? generateVaultRootKey() : checkKey(options.vaultRootKey);
  const rootDirectoryCapabilityKey = generateDirectoryCapabilityKey();
  const rootDirectoryRecoveryContext: EnvelopeContext = {
    purpose: "vault-recovery",
    vaultId: options.accountId,
    objectId: options.rootDirectoryId,
    keyId: options.rootDirectoryId,
    keyEpoch: 1,
    revision: 1,
  };
  const rootDirectoryRecoveryEnvelope = await sealVaultRecoveryEnvelope(
    vaultRootKey,
    { key: rootDirectoryCapabilityKey, objectId: options.rootDirectoryId, keyId: options.rootDirectoryId, scope: "owned" },
    rootDirectoryRecoveryContext,
  );
  return {
    accountId: options.accountId,
    rootDirectoryId: options.rootDirectoryId,
    vaultRootKey,
    rootDirectoryCapabilityKey,
    rootDirectoryRecoveryEnvelope,
    rootDirectoryRecoveryContext,
  };
}

export async function createChildDirectoryCapability(
  parentDirectoryCapabilityKey: Uint8Array,
  options: {
    vaultId: string;
    parentDirectoryId: string;
    childDirectoryId: string;
    keyId?: string;
    keyEpoch?: number;
    revision?: number;
  },
): Promise<ChildDirectoryCapability> {
  checkKey(parentDirectoryCapabilityKey);
  const childKey = generateDirectoryCapabilityKey();
  const context: EnvelopeContext = {
    purpose: "directory-capability",
    vaultId: options.vaultId,
    objectId: options.childDirectoryId,
    keyId: options.keyId ?? options.childDirectoryId,
    keyEpoch: options.keyEpoch ?? 1,
    revision: options.revision ?? 1,
  };
  idBytes(options.parentDirectoryId);
  idBytes(options.childDirectoryId);
  const writer = await createSymmetricWriter(parentDirectoryCapabilityKey);
  return {
    directoryId: options.childDirectoryId,
    capabilityKey: childKey,
    envelope: await writer.seal(childKey, context),
    context,
  };
}

export async function createFileRepresentation(
  containingDirectoryCapabilityKey: Uint8Array,
  representation: Uint8Array | FileRepresentationPayload,
  options: {
    vaultId: string;
    fileId: string;
    keyId?: string;
    keyEpoch?: number;
    revision?: number;
  },
): Promise<FileRepresentation> {
  checkKey(containingDirectoryCapabilityKey);
  const encodedRepresentation = representation instanceof Uint8Array
    ? copy(representation)
    : encodeFileRepresentation(representation);
  const fileContentKey = generateFileContentKey();
  const baseContext: EnvelopeContext = {
    purpose: "file-content-key",
    vaultId: options.vaultId,
    objectId: options.fileId,
    keyId: options.keyId ?? options.fileId,
    keyEpoch: options.keyEpoch ?? 1,
    revision: options.revision ?? 1,
  };
  idBytes(options.fileId);
  const keyWriter = await createSymmetricWriter(containingDirectoryCapabilityKey);
  const fileContentKeyEnvelope = await keyWriter.seal(fileContentKey, baseContext);
  const contentContext: EnvelopeContext = { ...baseContext, purpose: "file-content" };
  const contentWriter = await createSymmetricWriter(fileContentKey);
  const contentEnvelope = await contentWriter.seal(encodedRepresentation, contentContext);
  return { fileContentKey, fileContentKeyEnvelope, contentEnvelope, keyContext: baseContext, contentContext };
}

export async function digestRecoveryCapsule(record: RecoveryCapsuleRecord): Promise<Bytes> {
  return digestEnvelope(record.capsule);
}
