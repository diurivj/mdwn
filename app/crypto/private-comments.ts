import {
  createSymmetricWriter, EnvelopeError, openForRecipient, openSymmetric, sealToRecipient, type EnvelopeContext,
} from "./enc-v1";
import { encodeContext, equal } from "./enc-v1/format";
import { assertFileReceivingTarget, type FileReceivingTargetCommitment } from "./file-receiving";
import type { AccountProfile } from "./account-profile";

/** These identities come from trusted current File/thread state, never an envelope header. */
export interface PrivateThreadIdentity {
  ownerVaultId: string;
  threadId: string;
  threadKeyId: string;
  threadEpoch: number;
  wrapRevision: number;
}

export interface PrivateThreadDevice extends PrivateThreadIdentity {
  deviceId: string;
}

/** The caller must verify the File head and that this thread belongs to this File. */
export interface PrivateThreadFileReceiving extends PrivateThreadIdentity {
  fileId: string;
  receivingTarget: FileReceivingTargetCommitment;
  receivingPublicKey: Uint8Array;
}

/** Only an explicitly identified unmigrated v1 File uses parent-Directory delivery. */
export interface LegacyDirectoryThreadEnvelope {
  kind: "legacy-directory";
  ciphertext: Uint8Array<ArrayBuffer>;
}

export interface PrivateCommentIdentity {
  ownerVaultId: string;
  commentId: string;
  threadKeyId: string;
  threadEpoch: number;
  revision: number;
}

export interface PrivateAttributionIdentity {
  ownerVaultId: string;
  attributionId: string;
  threadKeyId: string;
  threadEpoch: number;
  revision: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function malformed(): never { throw new EnvelopeError("malformed"); }

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) malformed();
  return value;
}

function copy(value: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array)) malformed();
  return new Uint8Array(value);
}

function threadKey(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const key = copy(value);
  if (key.length !== 32) malformed();
  return key;
}

function threadContext(identity: PrivateThreadIdentity, recipientId?: string): EnvelopeContext {
  if (!identity) malformed();
  const context: EnvelopeContext = {
    purpose: "private-comment-thread", vaultId: identity.ownerVaultId,
    objectId: identity.threadId, keyId: identity.threadKeyId,
    keyEpoch: positive(identity.threadEpoch), revision: positive(identity.wrapRevision),
    ...(recipientId === undefined ? {} : { recipientId }),
  };
  encodeContext(context);
  return context;
}

/** A Private thread epoch is independently random, not derived from a File content key. */
export function createPrivateThreadKey(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** HPKE to one approved device transport public key; approval is a caller obligation. */
export async function sealPrivateThreadForDevice(
  key: Uint8Array, recipientPublicKey: CryptoKey, identity: PrivateThreadDevice,
): Promise<Uint8Array<ArrayBuffer>> {
  const context = threadContext(identity, identity.deviceId);
  const value = threadKey(key);
  const envelope = await sealToRecipient(value, recipientPublicKey, context);
  if (envelope.length > 16_384) malformed();
  return envelope;
}

/** A successful open conveys possession, never server or Grant authorization. */
export async function openPrivateThreadForDevice(
  envelope: Uint8Array, recipient: CryptoKeyPair, expected: PrivateThreadDevice,
): Promise<Uint8Array<ArrayBuffer>> {
  const context = threadContext(expected, expected.deviceId);
  const input = copy(envelope);
  if (input.length > 16_384) malformed();
  return threadKey(await openForRecipient(input, recipient, { context }));
}

function fileRecipient(identity: PrivateThreadFileReceiving) {
  if (!identity || !identity.receivingTarget) malformed();
  const target: FileReceivingTargetCommitment = {
    vaultId: identity.receivingTarget.vaultId, fileId: identity.receivingTarget.fileId,
    receivingKeyId: identity.receivingTarget.receivingKeyId,
    receivingEpoch: positive(identity.receivingTarget.receivingEpoch),
    publicKeyDigest: copy(identity.receivingTarget.publicKeyDigest),
  };
  const publicKey = copy(identity.receivingPublicKey);
  if (target.vaultId !== identity.ownerVaultId || target.fileId !== identity.fileId) {
    throw new EnvelopeError("context-mismatch");
  }
  return { target, publicKey, context: threadContext(identity, target.receivingKeyId) };
}

/** An authenticated File-head target lets a Collaborator supply Owner recovery without the Owner's Vault root.
 * The caller verifies the current File-head epoch/target and thread-to-File mapping: enc-v1's
 * purpose-10 header has a thread epoch and recipient key ID, not a second receiving-key epoch.
 */
export async function sealPrivateThreadForFileReceiving(
  key: Uint8Array, identity: PrivateThreadFileReceiving,
): Promise<Uint8Array<ArrayBuffer>> {
  const { target, publicKey, context } = fileRecipient(identity);
  const value = threadKey(key);
  const recipient = await assertFileReceivingTarget(publicKey, target);
  const envelope = await sealToRecipient(value, recipient, context);
  if (envelope.length > 16_384) malformed();
  return envelope;
}

/** The pair normally comes from openFileReceivingKey's verified non-extractable private handle. */
export async function openPrivateThreadFromFileReceiving(
  envelope: Uint8Array, receivingKeyPair: CryptoKeyPair, expected: PrivateThreadFileReceiving,
): Promise<Uint8Array<ArrayBuffer>> {
  const { target, publicKey, context } = fileRecipient(expected);
  const input = copy(envelope);
  if (!receivingKeyPair) malformed();
  const pair = { publicKey: receivingKeyPair.publicKey, privateKey: receivingKeyPair.privateKey };
  if (input.length > 16_384) malformed();
  await assertFileReceivingTarget(publicKey, target);
  let pairPublic: Uint8Array;
  try { pairPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)); }
  catch { malformed(); }
  if (!equal(pairPublic, publicKey)) throw new EnvelopeError("context-mismatch");
  return threadKey(await openForRecipient(input, pair, { context }));
}

/** Legacy v1 only: no implicit downgrade when File receiving HPKE fails. */
export async function sealLegacyPrivateThreadForDirectory(
  key: Uint8Array, directoryCapability: Uint8Array, identity: PrivateThreadIdentity,
): Promise<LegacyDirectoryThreadEnvelope> {
  const context = threadContext(identity);
  const value = threadKey(key);
  const writer = await createSymmetricWriter(threadKey(directoryCapability));
  const ciphertext = await writer.seal(value, context);
  if (ciphertext.length > 16_384) malformed();
  return { kind: "legacy-directory", ciphertext };
}

export async function openLegacyPrivateThreadFromDirectory(
  legacy: LegacyDirectoryThreadEnvelope, directoryCapability: Uint8Array, expected: PrivateThreadIdentity,
): Promise<Uint8Array<ArrayBuffer>> {
  const context = threadContext(expected);
  if (!legacy || legacy.kind !== "legacy-directory") malformed();
  const input = copy(legacy.ciphertext);
  if (input.length > 16_384) malformed();
  return threadKey(await openSymmetric(input, threadKey(directoryCapability), { context }));
}

function commentContext(identity: PrivateCommentIdentity): EnvelopeContext {
  if (!identity) malformed();
  const context: EnvelopeContext = {
    purpose: "comment-content", vaultId: identity.ownerVaultId, objectId: identity.commentId,
    keyId: identity.threadKeyId, keyEpoch: positive(identity.threadEpoch), revision: positive(identity.revision),
  };
  encodeContext(context);
  return context;
}

function textBytes(text: string, maxScalars: number): Uint8Array<ArrayBuffer> {
  if (typeof text !== "string") malformed();
  let scalars = 0;
  for (const _scalar of text) if (++scalars > maxScalars) malformed();
  const raw = encoder.encode(text);
  // TextEncoder replaces unpaired UTF-16 surrogates; never silently alter the author's text.
  if (decodeText(raw) !== text) malformed();
  return raw;
}

function decodeText(raw: Uint8Array): string {
  try { return decoder.decode(raw); }
  catch { malformed(); }
}

/** Plain text only: markup and line breaks survive byte-for-byte, never rendered here. */
export async function sealPrivateComment(
  key: Uint8Array, text: string, identity: PrivateCommentIdentity,
): Promise<Uint8Array<ArrayBuffer>> {
  const context = commentContext(identity);
  const message = textBytes(text, 2_000);
  const writer = await createSymmetricWriter(threadKey(key));
  const ciphertext = await writer.seal(message, context);
  if (ciphertext.length > 16_384) malformed();
  return ciphertext;
}

export async function openPrivateComment(
  envelope: Uint8Array, key: Uint8Array, expected: PrivateCommentIdentity,
): Promise<string> {
  const context = commentContext(expected);
  const input = copy(envelope);
  if (input.length > 16_384) malformed();
  const plaintext = await openSymmetric(input, threadKey(key), { context });
  const text = decodeText(plaintext);
  textBytes(text, 2_000); // An authenticated envelope can still contain invalid/oversized text.
  return text;
}

function attributionContext(identity: PrivateAttributionIdentity): EnvelopeContext {
  if (!identity) malformed();
  const context: EnvelopeContext = {
    purpose: "attribution", vaultId: identity.ownerVaultId, objectId: identity.attributionId,
    keyId: identity.threadKeyId, keyEpoch: positive(identity.threadEpoch), revision: positive(identity.revision),
  };
  encodeContext(context);
  return context;
}

/** The caller supplies a locally decrypted Account profile; this helper cannot prove its provenance or author identity. */
export async function sealPrivateAttribution(
  key: Uint8Array, decryptedAccountProfile: Pick<AccountProfile, "publicPseudonym">,
  identity: PrivateAttributionIdentity,
): Promise<Uint8Array<ArrayBuffer>> {
  const context = attributionContext(identity);
  const text = decryptedAccountProfile?.publicPseudonym;
  const message = textBytes(text, 4_096);
  if (!message.length || message.length > 4_096) malformed();
  const writer = await createSymmetricWriter(threadKey(key));
  const ciphertext = await writer.seal(message, context);
  if (ciphertext.length > 4_096) malformed();
  return ciphertext;
}

/** Returns only the encrypted declaration; future Worker/UI code must check the author and profile equality. */
export async function openPrivateAttribution(
  envelope: Uint8Array, key: Uint8Array, expected: PrivateAttributionIdentity,
): Promise<string> {
  const context = attributionContext(expected);
  const input = copy(envelope);
  if (input.length > 4_096) malformed();
  const plaintext = await openSymmetric(input, threadKey(key), { context });
  const text = decodeText(plaintext);
  if (!plaintext.length || plaintext.length > 4_096) malformed();
  textBytes(text, 4_096);
  return text;
}
