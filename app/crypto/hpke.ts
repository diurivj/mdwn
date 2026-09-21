import {
  Aes256Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";

import {
  ALGORITHM_SUITE,
  assertOpenPolicy,
  canonicalAuthenticatedContext,
  decodeEnvelope,
  encodeEnvelope,
  EnvelopeAuthenticationError,
  ReplayDetectedError,
  type EnvelopeContext,
  normalizeContext,
} from "./envelope";
import { concatBytes, type ByteSource, toBytes, utf8 } from "./encoding";
import { sha256 } from "./kdf";
import { type ReplayGuard } from "./nonce";
import {
  asArrayBuffer,
  getSubtleCrypto,
  isCryptoKey,
  isCryptoKeyPair,
} from "./webcrypto";

/** RFC 9180 DHKEM(P-256)/HKDF-SHA-256 + HKDF-SHA-256 + AES-256-GCM. */
export const HPKE_SUITE = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

// PKCS#8 PrivateKeyInfo prefix for an uncompressed P-256 scalar. This is only
// key representation; HPKE remains entirely delegated to @hpke/core.
const P256_PKCS8_PRIVATE_PREFIX = Uint8Array.from([
  48, 65, 2, 1, 0, 48, 19, 6, 7, 42, 134, 72, 206, 61, 2, 1, 6, 8, 42,
  134, 72, 206, 61, 3, 1, 7, 4, 39, 48, 37, 2, 1, 1, 4, 32,
]);

export interface HpkeKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyBytes: Uint8Array;
}

export type HpkePublicKey = CryptoKey | ByteSource;
export type HpkePrivateKey = CryptoKey | CryptoKeyPair | ByteSource;

export interface SealHpkeRequest {
  context: EnvelopeContext;
  plaintext: ByteSource;
  recipientPublicKey: HpkePublicKey;
  /** Test-vector-only deterministic ephemeral key material. */
  ephemeralKeyMaterial?: ByteSource | CryptoKeyPair;
}

export interface OpenHpkeRequest {
  envelope: ByteSource;
  recipientPrivateKey: HpkePrivateKey;
  /** Required when a standalone non-extractable private key is supplied. */
  recipientPublicKey?: HpkePublicKey;
  expectedContext: EnvelopeContext;
  minimumEpoch?: number;
  replayGuard?: ReplayGuard;
}

export async function generateHpkeKeyPair(): Promise<HpkeKeyPair> {
  const generated = await getSubtleCrypto().generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  if (!isCryptoKeyPair(generated)) {
    throw new Error("Web Crypto returned an incomplete HPKE key pair");
  }
  return {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    publicKeyBytes: new Uint8Array(
      await HPKE_SUITE.kem.serializePublicKey(generated.publicKey),
    ),
  };
}

export async function exportHpkePublicKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await HPKE_SUITE.kem.serializePublicKey(key));
}

export async function importHpkePublicKey(rawKey: ByteSource): Promise<CryptoKey> {
  const raw = toBytes(rawKey);
  if (raw.byteLength !== 65) {
    throw new TypeError("P-256 HPKE public keys must be 65 bytes");
  }
  return HPKE_SUITE.kem.deserializePublicKey(asArrayBuffer(raw));
}

export async function importHpkePrivateKey(rawKey: ByteSource): Promise<CryptoKey> {
  const raw = toBytes(rawKey);
  if (raw.byteLength !== 32) {
    throw new TypeError("P-256 HPKE private keys must be 32 bytes");
  }
  return getSubtleCrypto().importKey(
    "pkcs8",
    asArrayBuffer(concatBytes(P256_PKCS8_PRIVATE_PREFIX, raw)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

export async function sealHpke({
  context: inputContext,
  plaintext,
  recipientPublicKey,
  ephemeralKeyMaterial,
}: SealHpkeRequest): Promise<Uint8Array> {
  const context = normalizeContext(inputContext);
  const aad = canonicalAuthenticatedContext({
    suite: ALGORITHM_SUITE.HPKE_P256_HKDF_SHA256_AES_256_GCM,
    context,
  });
  const info = await hpkeInfo(aad);
  const senderParams: Parameters<typeof HPKE_SUITE.createSenderContext>[0] = {
    recipientPublicKey: await resolvePublicKey(recipientPublicKey),
    info: asArrayBuffer(info),
  };
  if (ephemeralKeyMaterial !== undefined) {
    senderParams.ekm = isCryptoKeyPair(ephemeralKeyMaterial)
      ? ephemeralKeyMaterial
      : asArrayBuffer(ephemeralKeyMaterial);
  }

  const sender = await HPKE_SUITE.createSenderContext(senderParams);
  const ciphertext = await sender.seal(
    asArrayBuffer(plaintext),
    asArrayBuffer(aad),
  );
  return encodeEnvelope({
    version: 1,
    suite: ALGORITHM_SUITE.HPKE_P256_HKDF_SHA256_AES_256_GCM,
    context,
    enc: new Uint8Array(sender.enc),
    ciphertext: new Uint8Array(ciphertext),
  });
}

export async function openHpke({
  envelope: encodedEnvelope,
  recipientPrivateKey,
  recipientPublicKey,
  expectedContext,
  minimumEpoch,
  replayGuard,
}: OpenHpkeRequest): Promise<Uint8Array> {
  const encoded = toBytes(encodedEnvelope);
  const envelope = decodeEnvelope(encoded);
  assertOpenPolicy(
    envelope,
    ALGORITHM_SUITE.HPKE_P256_HKDF_SHA256_AES_256_GCM,
    expectedContext,
    minimumEpoch,
  );
  if (envelope.enc === undefined) {
    throw new EnvelopeAuthenticationError("HPKE envelope has no encapsulated key");
  }

  try {
    const aad = canonicalAuthenticatedContext({
      suite: ALGORITHM_SUITE.HPKE_P256_HKDF_SHA256_AES_256_GCM,
      context: envelope.context,
    });
    const recipient = await HPKE_SUITE.createRecipientContext({
      recipientKey: await resolvePrivateKey(recipientPrivateKey, recipientPublicKey),
      enc: asArrayBuffer(envelope.enc),
      info: asArrayBuffer(await hpkeInfo(aad)),
    });
    const plaintext = await recipient.open(
      asArrayBuffer(envelope.ciphertext),
      asArrayBuffer(aad),
    );

    if (replayGuard !== undefined) {
      const fresh = await replayGuard.consume(await sha256(encoded));
      if (!fresh) throw new ReplayDetectedError("envelope was replayed");
    }
    return new Uint8Array(plaintext);
  } catch (error) {
    if (error instanceof EnvelopeAuthenticationError || error instanceof ReplayDetectedError) {
      throw error;
    }
    throw new EnvelopeAuthenticationError("HPKE authentication failed", {
      cause: error,
    });
  }
}

export async function hpkeInfo(aad: ByteSource): Promise<Uint8Array> {
  return concatBytes(utf8("mdwn/enc-v1/hpke-info"), await sha256(aad));
}

async function resolvePublicKey(key: HpkePublicKey): Promise<CryptoKey> {
  if (isCryptoKey(key)) return key;
  return importHpkePublicKey(key);
}

async function resolvePrivateKey(
  key: HpkePrivateKey,
  publicKey?: HpkePublicKey,
): Promise<CryptoKey | CryptoKeyPair> {
  if (isCryptoKeyPair(key)) return key;
  const privateKey = isCryptoKey(key) ? key : await importHpkePrivateKey(key);
  if (publicKey === undefined) return privateKey;
  return {
    privateKey,
    publicKey: await resolvePublicKey(publicKey),
  };
}

export function isHpkeEnvelopeSuite(suite: string): boolean {
  return suite === ALGORITHM_SUITE.HPKE_P256_HKDF_SHA256_AES_256_GCM;
}

export function hpkeWebCryptoAvailable(): boolean {
  return Boolean(getSubtleCrypto());
}

