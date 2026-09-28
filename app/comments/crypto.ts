import { createSymmetricWriter, EnvelopeError, openForRecipient, openSymmetric, sealToRecipient,
  type EnvelopeContext } from "~/crypto/enc-v1";

/** A Comment is plain text with line breaks, at most 2,000 characters (Unicode code points). */
export const COMMENT_CHARACTER_LIMIT = 2000;
const COMMENT_FRAME = "mdwn/private-comment/v1";
const ATTRIBUTION_FRAME = "mdwn/attribution/v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class CommentTextError extends Error {
  constructor(readonly code: "empty" | "too_long" | "invalid") { super(`comment_${code}`); }
}

/** CRLF/CR become LF; other control characters and unpaired surrogates are refused, never repaired. */
export function normalizeCommentText(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B-\u001F\u007F]/.test(normalized) || !isWellFormed(normalized)) {
    throw new CommentTextError("invalid");
  }
  if (!normalized.trim()) throw new CommentTextError("empty");
  if (commentLength(normalized) > COMMENT_CHARACTER_LIMIT) throw new CommentTextError("too_long");
  return normalized;
}

export function commentLength(text: string): number {
  return Array.from(text.replace(/\r\n?/g, "\n")).length;
}

function isWellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

export type ThreadKeyIdentity = { ownerId: string; threadId: string; keyId: string; epoch: number };

export function generateThreadKey(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32));
}

function threadContext(identity: ThreadKeyIdentity, recipientId?: string): EnvelopeContext {
  return { purpose: "private-comment-thread", vaultId: identity.ownerId, objectId: identity.threadId,
    keyId: identity.keyId, keyEpoch: identity.epoch, revision: 1,
    ...(recipientId === undefined ? {} : { recipientId }) };
}

function key(value: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || value.length !== 32) throw new EnvelopeError("malformed");
  return new Uint8Array(value);
}

/** Hierarchy wrapper: whoever can open the File receiving private key can open the thread. */
export function sealThreadKeyToReceiving(threadKey: Uint8Array, receivingPublicKey: CryptoKey,
  identity: ThreadKeyIdentity & { receivingKeyId: string }): Promise<Uint8Array<ArrayBuffer>> {
  return sealToRecipient(key(threadKey), receivingPublicKey, threadContext(identity, identity.receivingKeyId));
}

export async function openThreadKeyFromReceiving(envelope: Uint8Array, receiving: CryptoKeyPair,
  identity: ThreadKeyIdentity & { receivingKeyId: string }): Promise<Uint8Array<ArrayBuffer>> {
  return key(await openForRecipient(envelope, receiving, { context: threadContext(identity, identity.receivingKeyId) }));
}

/** Direct File readers hold no receiving key; each of their devices gets its own envelope. */
export function sealThreadKeyToDevice(threadKey: Uint8Array, devicePublicKey: CryptoKey,
  identity: ThreadKeyIdentity & { deviceId: string }): Promise<Uint8Array<ArrayBuffer>> {
  return sealToRecipient(key(threadKey), devicePublicKey, threadContext(identity, identity.deviceId));
}

export async function openThreadKeyFromDevice(envelope: Uint8Array, device: CryptoKeyPair,
  identity: ThreadKeyIdentity & { deviceId: string }): Promise<Uint8Array<ArrayBuffer>> {
  return key(await openForRecipient(envelope, device, { context: threadContext(identity, identity.deviceId) }));
}

/** Epoch chain: the previous epoch key sealed under the current one keeps history readable. */
export async function sealPreviousThreadKey(previous: Uint8Array, current: Uint8Array,
  previousIdentity: ThreadKeyIdentity): Promise<Uint8Array<ArrayBuffer>> {
  const writer = await createSymmetricWriter(key(current));
  return writer.seal(key(previous), threadContext(previousIdentity));
}

export async function openPreviousThreadKey(envelope: Uint8Array, current: Uint8Array,
  previousIdentity: ThreadKeyIdentity): Promise<Uint8Array<ArrayBuffer>> {
  return key(await openSymmetric(envelope, key(current), { context: threadContext(previousIdentity) }));
}

type CommentIdentity = { ownerId: string; commentId: string; keyId: string; epoch: number; revision: number };
function commentContext(identity: CommentIdentity): EnvelopeContext {
  return { purpose: "comment-content", vaultId: identity.ownerId, objectId: identity.commentId,
    keyId: identity.keyId, keyEpoch: identity.epoch, revision: identity.revision };
}

/** The author's Account is inside the ciphertext, so a stored row cannot be reattributed. */
export async function sealComment(threadKey: Uint8Array, identity: CommentIdentity & { authorId: string;
  text: string }): Promise<Uint8Array<ArrayBuffer>> {
  const text = normalizeCommentText(identity.text);
  const writer = await createSymmetricWriter(key(threadKey));
  return writer.seal(encoder.encode(JSON.stringify([COMMENT_FRAME, identity.authorId, text])), commentContext(identity));
}

export async function openComment(envelope: Uint8Array, threadKey: Uint8Array,
  identity: CommentIdentity & { authorId: string }): Promise<string> {
  const plaintext = await openSymmetric(envelope, key(threadKey), { context: commentContext(identity) });
  const value: unknown = JSON.parse(decoder.decode(plaintext));
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== COMMENT_FRAME || value[1] !== identity.authorId ||
      typeof value[2] !== "string" || normalizeCommentText(value[2]) !== value[2]) {
    throw new EnvelopeError("context-mismatch");
  }
  return value[2];
}

type AttributionIdentity = { ownerId: string; accountId: string; keyId: string; epoch: number; revision: number };
function attributionContext(identity: AttributionIdentity): EnvelopeContext {
  return { purpose: "attribution", vaultId: identity.ownerId, objectId: identity.accountId,
    keyId: identity.keyId, keyEpoch: identity.epoch, revision: identity.revision };
}

/** A per-thread Public-pseudonym declaration, bound to its Account inside and outside the plaintext. */
export async function sealAttribution(threadKey: Uint8Array, identity: AttributionIdentity & {
  pseudonym: string }): Promise<Uint8Array<ArrayBuffer>> {
  if (!identity.pseudonym || identity.pseudonym.length > 256) throw new EnvelopeError("malformed");
  const writer = await createSymmetricWriter(key(threadKey));
  return writer.seal(encoder.encode(JSON.stringify([ATTRIBUTION_FRAME, identity.accountId, identity.pseudonym])),
    attributionContext(identity));
}

export async function openAttribution(envelope: Uint8Array, threadKey: Uint8Array,
  identity: AttributionIdentity): Promise<string> {
  const plaintext = await openSymmetric(envelope, key(threadKey), { context: attributionContext(identity) });
  const value: unknown = JSON.parse(decoder.decode(plaintext));
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== ATTRIBUTION_FRAME ||
      value[1] !== identity.accountId || typeof value[2] !== "string" || !value[2] || value[2].length > 256) {
    throw new EnvelopeError("context-mismatch");
  }
  return value[2];
}
