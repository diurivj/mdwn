import { createSymmetricWriter, inspectEnvelope, openSymmetric, type EnvelopeContext } from "~/crypto/enc-v1";
import { SYMMETRIC_SUITE } from "~/crypto/enc-v1/format";
import { decodeTreeBytes, encodeTreeBytes } from "~/tree/wire";
import { commentCharacters, MAX_ATTRIBUTION_BYTES, MAX_ATTRIBUTION_KEY_ENVELOPE_BYTES, MAX_COMMENT_BODY_BYTES,
  MAX_COMMENT_KEY_ENVELOPE_BYTES, normalizeCommentText, validCommentText } from "./content";

/**
 * Public Comment audience epochs (ticket 23).
 *
 * A Public Comment thread is partitioned into ordered, independently keyed
 * **Comment audience epochs**. Every epoch capability is a random 32-byte key
 * wrapped two ways:
 *
 * - each eligible Owner/Collaborator device receives an HPKE `public-comment-
 *   audience-epoch` envelope through the ticket 18/20 delivery machinery
 *   (the Owner's devices open the thread's `vault-recovery` envelope);
 * - a `public` epoch is additionally wrapped to the **Publication capability**
 *   in the URL fragment as a symmetric `public-comment-epoch-link` envelope.
 *
 * The link wrapper's AES key is derived only in the reader's browser with
 * HKDF-SHA-256 over the fragment scalar. The service stores the wrapper
 * ciphertext, the link's public key and the epoch identity, but can never
 * derive that key: no fragment, plaintext capability or derived key ever
 * reaches a request, log, error or D1 row.
 */

/** The service may hold one link wrapper per public epoch; the bound is the
 * same as every other Key envelope ciphertext. */
export const MAX_PUBLIC_EPOCH_LINK_BYTES = 16_384;
const LINK_KEY_INFO = new TextEncoder().encode("mdwn/public-comment-epoch-link/v1");
const CAPABILITY_BYTES = 32;

/** The fragment scalar and stored public point together derive the wrapper key. */
export async function derivePublicationCapabilityKey(privateKey: Uint8Array<ArrayBuffer>, publicKey: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== CAPABILITY_BYTES) {
    throw new Error("invalid publication capability");
  }
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 65 || publicKey[0] !== 4) {
    throw new Error("invalid publication capability");
  }
  const point = new Uint8Array(publicKey);
  const ikm = await crypto.subtle.importKey("raw", privateKey, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: point, info: LINK_KEY_INFO }, ikm, 256);
  return new Uint8Array(bits);
}

/** Symmetric wrapper context: only the Publication, never the Owner, File or Account. */
export function commentEpochLinkContext(input: {
  publicationId: string; linkId: string; epochId: string; capabilityId: string; keyEpoch: number;
}): EnvelopeContext {
  return { purpose: "public-comment-epoch-link", vaultId: input.publicationId, objectId: input.epochId,
    keyId: input.capabilityId, keyEpoch: input.keyEpoch, revision: 1, recipientId: input.linkId,
    publicationId: input.publicationId };
}

/** Seals one epoch capability to the complete link. Browser-only. */
export async function sealCommentEpochLink(privateKey: Uint8Array<ArrayBuffer>, publicKey: Uint8Array, input: {
  publicationId: string; linkId: string; epochId: string; capabilityId: string; keyEpoch: number; capability: Uint8Array;
}): Promise<Uint8Array<ArrayBuffer>> {
  if (!(input.capability instanceof Uint8Array) || input.capability.length !== CAPABILITY_BYTES) {
    throw new Error("invalid comment epoch capability");
  }
  const key = await derivePublicationCapabilityKey(privateKey, publicKey);
  const writer = await createSymmetricWriter(key);
  return writer.seal(new Uint8Array(input.capability), commentEpochLinkContext(input));
}

/** Opens one link wrapper with the capability held only in the fragment. */
export async function openCommentEpochLink(privateKey: Uint8Array<ArrayBuffer>, publicKey: Uint8Array, input: {
  publicationId: string; linkId: string; epochId: string; capabilityId: string; keyEpoch: number; ciphertext: string;
}): Promise<Uint8Array<ArrayBuffer>> {
  const key = await derivePublicationCapabilityKey(privateKey, publicKey);
  const capability = await openSymmetric(decodeTreeBytes(input.ciphertext, MAX_PUBLIC_EPOCH_LINK_BYTES), key, {
    context: commentEpochLinkContext(input),
  });
  if (capability.length !== CAPABILITY_BYTES) throw new Error("invalid comment epoch capability");
  return capability;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Public Comment envelope contexts bind the logical Publication and never the
 * Owner's Vault, the Account or the File, so an anonymous Public reader can
 * open them from the opaque link response alone.
 */
export function publicCommentBodyContext(publicationId: string, commentId: string, revision: number): EnvelopeContext {
  return { purpose: "comment-content", vaultId: publicationId, objectId: commentId, keyId: commentId,
    keyEpoch: 1, revision, publicationId };
}
export function publicCommentKeyContext(publicationId: string, commentId: string, capabilityId: string,
  keyEpoch: number, revision: number): EnvelopeContext {
  return { purpose: "comment-content", vaultId: publicationId, objectId: commentId, keyId: capabilityId,
    keyEpoch, revision, publicationId };
}
export function publicAttributionContext(publicationId: string, attributionId: string, revision: number): EnvelopeContext {
  return { purpose: "attribution", vaultId: publicationId, objectId: attributionId, keyId: attributionId,
    keyEpoch: 1, revision, publicationId };
}
export function publicAttributionKeyContext(publicationId: string, attributionId: string, capabilityId: string,
  keyEpoch: number, revision: number): EnvelopeContext {
  return { purpose: "attribution", vaultId: publicationId, objectId: attributionId, keyId: capabilityId,
    keyEpoch, revision, publicationId };
}

/** The Worker validates framing and the full Publication-bound context without
 * ever opening content. A device envelope is never trusted on open alone. */
export function publicCommentEnvelope(value: unknown, max: number, expected: EnvelopeContext): Uint8Array<ArrayBuffer> {
  const bytes = decodeTreeBytes(value, max);
  const header = inspectEnvelope(bytes);
  const fields = ["purpose", "vaultId", "objectId", "keyId", "keyEpoch", "revision", "publicationId"] as const;
  if (header.suite !== SYMMETRIC_SUITE || Object.hasOwn(header.context, "recipientId") ||
      fields.some((field) => header.context[field] !== expected[field]) ||
      Object.keys(header.context).length !== fields.length) throw new Error("invalid public comment envelope");
  return bytes;
}

export type SealedPublicComment = { bodyCiphertext: string; contentKeyEnvelope: string };
export type SealedPublicAttribution = { attributionId: string; ciphertext: string; contentKeyEnvelope: string };

/** Plain text, at most 2,000 characters; HTML and Markdown are never interpreted. */
export async function sealPublicCommentBody(epochKey: Uint8Array, input: {
  publicationId: string; commentId: string; capabilityId: string; keyEpoch: number; revision: number; text: string;
}): Promise<SealedPublicComment> {
  if (!validCommentText(input.text)) throw new Error("comment_too_long");
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const body = await (await createSymmetricWriter(contentKey)).seal(encoder.encode(normalizeCommentText(input.text)),
    publicCommentBodyContext(input.publicationId, input.commentId, input.revision));
  const wrapper = await (await createSymmetricWriter(epochKey)).seal(contentKey,
    publicCommentKeyContext(input.publicationId, input.commentId, input.capabilityId, input.keyEpoch, input.revision));
  return { bodyCiphertext: encodeTreeBytes(body), contentKeyEnvelope: encodeTreeBytes(wrapper) };
}

export async function openPublicCommentBody(epochKey: Uint8Array, input: {
  publicationId: string; commentId: string; revision: number; capabilityId: string; keyEpoch: number;
  bodyCiphertext: string; contentKeyEnvelope: string;
}): Promise<string> {
  const contentKey = await openSymmetric(decodeTreeBytes(input.contentKeyEnvelope, MAX_COMMENT_KEY_ENVELOPE_BYTES), epochKey, {
    context: publicCommentKeyContext(input.publicationId, input.commentId, input.capabilityId, input.keyEpoch, input.revision),
  });
  const plaintext = await openSymmetric(decodeTreeBytes(input.bodyCiphertext, MAX_COMMENT_BODY_BYTES), contentKey, {
    context: publicCommentBodyContext(input.publicationId, input.commentId, input.revision),
  });
  const text = decoder.decode(plaintext);
  if (!validCommentText(text)) throw new Error("invalid_comment");
  return text;
}

export async function sealPublicAttribution(epochKey: Uint8Array, input: {
  publicationId: string; attributionId: string; pseudonym: string; capabilityId: string; keyEpoch: number;
  /** A Pseudonym update re-seals the record at the next revision; new declarations are 1. */
  revision?: number;
}): Promise<SealedPublicAttribution> {
  if (typeof input.pseudonym !== "string" || !input.pseudonym || commentCharacters(input.pseudonym) > 256) {
    throw new Error("invalid_pseudonym");
  }
  const revision = input.revision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("invalid_pseudonym");
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const ciphertext = await (await createSymmetricWriter(contentKey)).seal(encoder.encode(input.pseudonym),
    publicAttributionContext(input.publicationId, input.attributionId, revision));
  const wrapper = await (await createSymmetricWriter(epochKey)).seal(contentKey,
    publicAttributionKeyContext(input.publicationId, input.attributionId, input.capabilityId, input.keyEpoch, revision));
  return { attributionId: input.attributionId, ciphertext: encodeTreeBytes(ciphertext), contentKeyEnvelope: encodeTreeBytes(wrapper) };
}

export async function openPublicAttribution(epochKey: Uint8Array, input: {
  publicationId: string; attributionId: string; revision: number; capabilityId: string; keyEpoch: number;
  ciphertext: string; contentKeyEnvelope: string;
}): Promise<string> {
  const contentKey = await openSymmetric(decodeTreeBytes(input.contentKeyEnvelope, MAX_ATTRIBUTION_KEY_ENVELOPE_BYTES), epochKey, {
    context: publicAttributionKeyContext(input.publicationId, input.attributionId, input.capabilityId, input.keyEpoch, input.revision),
  });
  const plaintext = await openSymmetric(decodeTreeBytes(input.ciphertext, MAX_ATTRIBUTION_BYTES), contentKey, {
    context: publicAttributionContext(input.publicationId, input.attributionId, input.revision),
  });
  return decoder.decode(plaintext);
}

/** Worker-side structural check: the header must be the exact public link
 * wrapper for this epoch, link and capability. The Worker never opens it. */
export function isCommentEpochLink(value: Uint8Array, input: {
  publicationId: string; linkId: string; epochId: string; capabilityId: string; keyEpoch: number;
}): boolean {
  try {
    const expected = commentEpochLinkContext(input);
    const header = inspectEnvelope(value);
    return header.suite === SYMMETRIC_SUITE &&
      Object.keys(header.context).length === Object.keys(expected).length &&
      Object.entries(expected).every(([key, expectedValue]) => header.context[key as keyof EnvelopeContext] === expectedValue);
  } catch { return false; }
}
