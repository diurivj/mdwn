import {
  ALGORITHM_SUITE,
  assertOpenPolicy,
  canonicalAuthenticatedContext,
  decodeEnvelope,
  encodeEnvelope,
  EnvelopeAuthenticationError,
  ReplayDetectedError,
  type EncV1Envelope,
  normalizeContext,
  type EnvelopeContext,
} from "./envelope";
import { type ByteSource, toBytes } from "./encoding";
import { sha256 } from "./kdf";
import { NonceAllocationError, type NonceAllocator, type ReplayGuard } from "./nonce";
import { asArrayBuffer, getSubtleCrypto, isCryptoKey } from "./webcrypto";

export type Aes256Key = CryptoKey | ByteSource;

export interface SealAesGcmRequest {
  context: EnvelopeContext;
  key: Aes256Key;
  plaintext: ByteSource;
  /** Test-vector/import path. Production code must use nonceAllocator. */
  nonce?: ByteSource;
  /** Allocates a never-reused nonce before encryption. */
  nonceAllocator?: NonceAllocator;
}

export interface OpenAesGcmRequest {
  envelope: ByteSource;
  key: Aes256Key;
  expectedContext: EnvelopeContext;
  minimumEpoch?: number;
  replayGuard?: ReplayGuard;
}

export async function generateAes256Key(options?: {
  extractable?: boolean;
  usages?: KeyUsage[];
}): Promise<CryptoKey> {
  const key = await getSubtleCrypto().generateKey(
    { name: "AES-GCM", length: 256 },
    options?.extractable ?? false,
    options?.usages ?? ["encrypt", "decrypt"],
  );
  if (!isCryptoKey(key)) {
    throw new Error("Web Crypto returned an invalid AES key");
  }
  return key;
}

export async function importAes256Key(
  rawKey: ByteSource,
  options?: { extractable?: boolean; usages?: KeyUsage[] },
): Promise<CryptoKey> {
  const raw = toBytes(rawKey);
  if (raw.byteLength !== 32) throw new TypeError("AES-256 keys must be 32 bytes");
  return getSubtleCrypto().importKey(
    "raw",
    asArrayBuffer(raw),
    { name: "AES-GCM", length: 256 },
    options?.extractable ?? false,
    options?.usages ?? ["encrypt", "decrypt"],
  );
}

export async function sealAesGcm({
  context: inputContext,
  key,
  plaintext,
  nonce,
  nonceAllocator,
}: SealAesGcmRequest): Promise<Uint8Array> {
  const context = normalizeContext(inputContext);
  if (nonce !== undefined && nonceAllocator !== undefined) {
    throw new NonceAllocationError("provide either a nonce or a nonce allocator, not both");
  }
  const allocatedNonce =
    nonce === undefined
      ? nonceAllocator === undefined
        ? (() => {
            throw new NonceAllocationError(
              "a nonce allocator is required for production AES-GCM encryption",
            );
          })()
        : await nonceAllocator.allocate(context.keyId)
      : toBytes(nonce);
  if (allocatedNonce.byteLength !== 12) {
    throw new NonceAllocationError("AES-GCM nonces must be exactly 96 bits");
  }

  const aad = canonicalAuthenticatedContext({
    suite: ALGORITHM_SUITE.AES_256_GCM,
    context,
  });
  const ciphertext = await getSubtleCrypto().encrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(allocatedNonce),
      additionalData: asArrayBuffer(aad),
      tagLength: 128,
    },
    await resolveAesKey(key),
    asArrayBuffer(plaintext),
  );
  return encodeEnvelope({
    version: 1,
    suite: ALGORITHM_SUITE.AES_256_GCM,
    context,
    nonce: allocatedNonce,
    ciphertext: new Uint8Array(ciphertext),
  });
}

export async function openAesGcm({
  envelope: encodedEnvelope,
  key,
  expectedContext,
  minimumEpoch,
  replayGuard,
}: OpenAesGcmRequest): Promise<Uint8Array> {
  const encoded = toBytes(encodedEnvelope);
  const envelope = decodeEnvelope(encoded);
  assertOpenPolicy(
    envelope,
    ALGORITHM_SUITE.AES_256_GCM,
    expectedContext,
    minimumEpoch,
  );
  if (envelope.nonce === undefined) {
    throw new EnvelopeAuthenticationError("AES-GCM envelope has no nonce");
  }

  let plaintext: ArrayBuffer;
  try {
    plaintext = await getSubtleCrypto().decrypt(
      {
        name: "AES-GCM",
        iv: asArrayBuffer(envelope.nonce),
        additionalData: asArrayBuffer(
          canonicalAuthenticatedContext({
            suite: ALGORITHM_SUITE.AES_256_GCM,
            context: envelope.context,
          }),
        ),
        tagLength: 128,
      },
      await resolveAesKey(key),
      asArrayBuffer(envelope.ciphertext),
    );
  } catch (error) {
    throw new EnvelopeAuthenticationError("AES-GCM authentication failed", {
      cause: error,
    });
  }

  if (replayGuard !== undefined) {
    const fresh = await replayGuard.consume(await sha256(encoded));
    if (!fresh) throw new ReplayDetectedError("envelope was replayed");
  }
  return new Uint8Array(plaintext);
}

async function resolveAesKey(key: Aes256Key): Promise<CryptoKey> {
  if (isCryptoKey(key)) {
    if (
      key.algorithm.name !== "AES-GCM" ||
      (key.algorithm as AesKeyAlgorithm).length !== 256
    ) {
      throw new TypeError("an AES-256-GCM CryptoKey is required");
    }
    return key;
  }
  return importAes256Key(key);
}

export function isAesEnvelope(value: EncV1Envelope): boolean {
  return value.suite === ALGORITHM_SUITE.AES_256_GCM;
}
