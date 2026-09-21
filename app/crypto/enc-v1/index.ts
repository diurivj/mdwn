import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";

import { EnvelopeError } from "./errors";

export { EnvelopeError, type EnvelopeErrorCode } from "./errors";

import {
  concat, encodeContext, equal, header, HPKE_SUITE, MANIFEST_PURPOSES, parseEnvelope, prefix, SYMMETRIC_SUITE,
  type EnvelopeContext, type EnvelopeExpectation,
} from "./format";

export {
  inspectEnvelope,
  type EnvelopeContext, type EnvelopeExpectation, type EnvelopeHeader,
  type EnvelopePurpose, type EnvelopeSuite,
} from "./format";

const encoder = new TextEncoder();
const hpke = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });

/**
 * Per-derived-key ceiling on total authenticated GCM bytes (AAD + plaintext,
 * each padded to an AES block, plus the 128-bit tag). 2^30 bytes is far below
 * GCM's aggregate forgery bound and above any single v1 envelope. `maxMessages`
 * alone would not bound the total data protected by one key.
 */
const MAX_AUTHENTICATED_BYTES = 2 ** 30;

function paddedToBlock(value: number): number {
  return Math.ceil(value / 16) * 16;
}

async function writerKey(baseKey: Uint8Array, salt: Uint8Array) {
  if (!(baseKey instanceof Uint8Array) || baseKey.length !== 32) throw new EnvelopeError("malformed");
  const key = await crypto.subtle.importKey("raw", new Uint8Array(baseKey), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(salt), info: encoder.encode("mdwn/enc-v1/aes-256-gcm") },
    key, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

export interface SymmetricWriter {
  seal(plaintext: Uint8Array, context: EnvelopeContext): Promise<Uint8Array<ArrayBuffer>>;
}

/** A writer is ephemeral. Never persist or restore its derived key/nonce state. */
export async function createSymmetricWriter(
  baseKey: Uint8Array,
  {
    maxMessages = 2 ** 32,
    maxAuthenticatedBytes = MAX_AUTHENTICATED_BYTES,
  }: { maxMessages?: number; maxAuthenticatedBytes?: number } = {},
): Promise<SymmetricWriter> {
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 2 ** 32) throw new EnvelopeError("malformed");
  if (!Number.isSafeInteger(maxAuthenticatedBytes) || maxAuthenticatedBytes < 1 || maxAuthenticatedBytes > MAX_AUTHENTICATED_BYTES) {
    throw new EnvelopeError("malformed");
  }
  // Snapshot the base key: caller mutation must not change the derived writer key.
  const snapshot = new Uint8Array(baseKey);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const key = await writerKey(snapshot, salt);
  let counter = 0;
  let authenticatedBytes = 0;
  return {
    async seal(plaintext, context) {
      if (counter >= maxMessages) throw new EnvelopeError("nonce-exhausted");
      const message = new Uint8Array(plaintext);
      // Reserve before any asynchronous work. A failed or abandoned encryption burns this nonce.
      const nonce = new Uint8Array(12);
      new DataView(nonce.buffer).setUint32(8, counter++);
      const aad = header(prefix(SYMMETRIC_SUITE, context), concat(salt, nonce), message.length);
      const cost = paddedToBlock(aad.length) + paddedToBlock(message.length) + 16;
      if (authenticatedBytes + cost > maxAuthenticatedBytes) throw new EnvelopeError("nonce-exhausted");
      authenticatedBytes += cost;
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, message,
      );
      return concat(aad, new Uint8Array(ciphertext));
    },
  };
}

function checkTransportKey(key: CryptoKey, type: "public" | "private") {
  if (!key || key.type !== type || key.algorithm.name !== "ECDH" ||
      !("namedCurve" in key.algorithm) || key.algorithm.namedCurve !== "P-256" ||
      (type === "private" && !key.usages.includes("deriveBits"))) {
    throw new EnvelopeError("malformed");
  }
}

export async function sealToRecipient(
  plaintext: Uint8Array, recipientPublicKey: CryptoKey, context: EnvelopeContext,
): Promise<Uint8Array<ArrayBuffer>> {
  checkTransportKey(recipientPublicKey, "public");
  const info = prefix(HPKE_SUITE, context);
  const message = new Uint8Array(plaintext);
  // A fresh RFC 9180 base-mode context for exactly one message; never expose it for reuse.
  const sender = await hpke.createSenderContext({ recipientPublicKey, info });
  const aad = header(info, new Uint8Array(sender.enc), message.length);
  return concat(aad, new Uint8Array(await sender.seal(message, aad)));
}

export async function openForRecipient(
  input: Uint8Array, recipient: CryptoKeyPair, expected: EnvelopeExpectation,
): Promise<Uint8Array<ArrayBuffer>> {
  const envelope = parseEnvelope(input);
  if (envelope.suite !== HPKE_SUITE) throw new EnvelopeError("unsupported-suite");
  // Providing both handles avoids exporting a non-extractable private key to recover its public key.
  const recipientKey = { privateKey: recipient.privateKey, publicKey: recipient.publicKey };
  checkTransportKey(recipientKey.privateKey, "private");
  checkTransportKey(recipientKey.publicKey, "public");
  await checkExpected(envelope, expected);
  try {
    return new Uint8Array(await hpke.open(
      { recipientKey, enc: envelope.enc!, info: prefix(HPKE_SUITE, envelope.context) },
      envelope.ciphertext, envelope.aad,
    ));
  } catch {
    throw new EnvelopeError("authentication-failed");
  }
}

export async function digestEnvelope(input: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", parseEnvelope(input).bytes));
}

async function checkExpected(envelope: ReturnType<typeof parseEnvelope>, expected: EnvelopeExpectation) {
  const expectedContext = encodeContext(expected.context);
  const manifest = MANIFEST_PURPOSES.includes(envelope.context.purpose);
  // Older-than-current is ordinary staleness; newer-than-current is not something a
  // re-key can explain, so callers can fail closed instead of silently re-keying.
  if (envelope.context.keyEpoch < expected.context.keyEpoch) throw new EnvelopeError("stale-epoch");
  if (envelope.context.keyEpoch > expected.context.keyEpoch) throw new EnvelopeError("unexpected-epoch");
  if (manifest && envelope.context.revision !== expected.context.revision) throw new EnvelopeError("replayed-manifest");
  if (!equal(encodeContext(envelope.context), expectedContext)) throw new EnvelopeError("context-mismatch");
  if (manifest || expected.manifestDigest !== undefined) {
    if (!expected.manifestDigest) throw new EnvelopeError("replayed-manifest");
    const digest = new Uint8Array(expected.manifestDigest);
    if (digest.length !== 32) throw new EnvelopeError("malformed");
    const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", envelope.bytes));
    if (!equal(actual, digest)) throw new EnvelopeError("replayed-manifest");
  }
}

export async function openSymmetric(input: Uint8Array, baseKey: Uint8Array, expected: EnvelopeExpectation): Promise<Uint8Array<ArrayBuffer>> {
  const envelope = parseEnvelope(input);
  if (envelope.suite !== SYMMETRIC_SUITE) throw new EnvelopeError("unsupported-suite");
  const baseKeySnapshot = new Uint8Array(baseKey);
  await checkExpected(envelope, expected);
  const key = await writerKey(baseKeySnapshot, envelope.salt!);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(envelope.nonce!), additionalData: envelope.aad, tagLength: 128 },
      key, envelope.ciphertext,
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new EnvelopeError("authentication-failed");
  }
}
