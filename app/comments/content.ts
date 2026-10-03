import { createSymmetricWriter, openSymmetric, type EnvelopeContext } from "~/crypto/enc-v1";
import { decodeTreeBytes, encodeTreeBytes } from "~/tree/wire";

/**
 * Private Comment plain text and `mdwn/enc-v1` envelope shapes.
 *
 * A Comment body is a `comment-content` envelope under a fresh per-record
 * content key. That content key is wrapped in a second `comment-content`
 * envelope beneath the current thread capability, so a thread-capability
 * rotation rewraps wrappers without touching body ciphertext or history.
 * A displayed pseudonym follows the same shape with the `attribution` purpose.
 * A record's own opaque identity is its content-key identity, so no extra
 * plaintext-bearing column is needed and every open still needs an external
 * expected context.
 */

export const MAX_COMMENT_CHARS = 2_000;
export const MAX_COMMENT_BODY_BYTES = 16_384;
export const MAX_COMMENT_KEY_ENVELOPE_BYTES = 16_384;
export const MAX_ATTRIBUTION_BYTES = 4_096;
export const MAX_ATTRIBUTION_KEY_ENVELOPE_BYTES = 16_384;
export const MAX_COMMENTS_PAGE = 50;
export const MAX_ATTRIBUTIONS_PAGE = 50;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Plain text only: normalize CRLF/CR line breaks and count Unicode characters. */
export function normalizeCommentText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function commentCharacters(text: string): number {
  return Array.from(text).length;
}

export function validCommentText(text: unknown): text is string {
  return typeof text === "string" && commentCharacters(normalizeCommentText(text)) <= MAX_COMMENT_CHARS;
}

/** Body envelope context: protected by one fresh per-record content key. */
export function commentBodyContext(vaultId: string, commentId: string, revision: number): EnvelopeContext {
  return { purpose: "comment-content", vaultId, objectId: commentId, keyId: commentId, keyEpoch: 1, revision };
}

/** Content-key wrapper context: protected by the current thread capability. */
export function commentKeyContext(vaultId: string, commentId: string, capabilityId: string, keyEpoch: number, revision: number): EnvelopeContext {
  return { purpose: "comment-content", vaultId, objectId: commentId, keyId: capabilityId, keyEpoch, revision };
}

/** Attribution envelope context: protected by one fresh per-attribution content key. */
export function attributionContext(vaultId: string, attributionId: string, revision: number): EnvelopeContext {
  return { purpose: "attribution", vaultId, objectId: attributionId, keyId: attributionId, keyEpoch: 1, revision };
}

/** Attribution content-key wrapper context: protected by the thread capability. */
export function attributionKeyContext(vaultId: string, attributionId: string, capabilityId: string, keyEpoch: number, revision: number): EnvelopeContext {
  return { purpose: "attribution", vaultId, objectId: attributionId, keyId: capabilityId, keyEpoch, revision };
}

export type SealedCommentBody = { bodyCiphertext: string; contentKeyEnvelope: string };
export type SealedAttribution = { attributionId: string; ciphertext: string; contentKeyEnvelope: string };

/** Fresh writer per record; a later edit uses a fresh content key and writer. */
export async function sealCommentBody(threadKey: Uint8Array, input: {
  vaultId: string; commentId: string; capabilityId: string; keyEpoch: number; revision: number; text: string;
}): Promise<SealedCommentBody> {
  if (!validCommentText(input.text)) throw new Error("comment_too_long");
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const body = await (await createSymmetricWriter(contentKey)).seal(
    encoder.encode(normalizeCommentText(input.text)),
    commentBodyContext(input.vaultId, input.commentId, input.revision));
  const wrapper = await (await createSymmetricWriter(threadKey)).seal(
    contentKey, commentKeyContext(input.vaultId, input.commentId, input.capabilityId, input.keyEpoch, input.revision));
  return { bodyCiphertext: encodeTreeBytes(body), contentKeyEnvelope: encodeTreeBytes(wrapper) };
}

export async function openCommentBody(threadKey: Uint8Array, input: {
  vaultId: string; commentId: string; revision: number; capabilityId: string; keyEpoch: number;
  bodyCiphertext: string; contentKeyEnvelope: string;
}): Promise<string> {
  const contentKey = await openSymmetric(decodeTreeBytes(input.contentKeyEnvelope, MAX_COMMENT_KEY_ENVELOPE_BYTES), threadKey, {
    context: commentKeyContext(input.vaultId, input.commentId, input.capabilityId, input.keyEpoch, input.revision),
  });
  const plaintext = await openSymmetric(decodeTreeBytes(input.bodyCiphertext, MAX_COMMENT_BODY_BYTES), contentKey, {
    context: commentBodyContext(input.vaultId, input.commentId, input.revision),
  });
  const text = decoder.decode(plaintext);
  if (!validCommentText(text)) throw new Error("invalid_comment");
  return text;
}

export async function sealAttribution(threadKey: Uint8Array, input: {
  vaultId: string; attributionId: string; pseudonym: string; capabilityId: string; keyEpoch: number;
}): Promise<SealedAttribution> {
  if (typeof input.pseudonym !== "string" || !input.pseudonym || commentCharacters(input.pseudonym) > 256) {
    throw new Error("invalid_pseudonym");
  }
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const ciphertext = await (await createSymmetricWriter(contentKey)).seal(
    encoder.encode(input.pseudonym), attributionContext(input.vaultId, input.attributionId, 1));
  const wrapper = await (await createSymmetricWriter(threadKey)).seal(
    contentKey, attributionKeyContext(input.vaultId, input.attributionId, input.capabilityId, input.keyEpoch, 1));
  return { attributionId: input.attributionId, ciphertext: encodeTreeBytes(ciphertext), contentKeyEnvelope: encodeTreeBytes(wrapper) };
}

export async function openAttribution(threadKey: Uint8Array, input: {
  vaultId: string; attributionId: string; revision: number; capabilityId: string; keyEpoch: number;
  ciphertext: string; contentKeyEnvelope: string;
}): Promise<string> {
  const contentKey = await openSymmetric(decodeTreeBytes(input.contentKeyEnvelope, MAX_ATTRIBUTION_KEY_ENVELOPE_BYTES), threadKey, {
    context: attributionKeyContext(input.vaultId, input.attributionId, input.capabilityId, input.keyEpoch, input.revision),
  });
  const plaintext = await openSymmetric(decodeTreeBytes(input.ciphertext, MAX_ATTRIBUTION_BYTES), contentKey, {
    context: attributionContext(input.vaultId, input.attributionId, input.revision),
  });
  return decoder.decode(plaintext);
}
