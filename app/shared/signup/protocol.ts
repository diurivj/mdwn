/** Browser/Worker signup wire protocol. Never serialize this transcript with object key order. */
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const TRANSCRIPT_TAG = encoder.encode("mdwn/signup-transcript/v1\0");
const BINDING_TAG = encoder.encode("mdwn/signup-device-binding/v1\0");
const MAX_BYTES = 65_536;
const TRANSCRIPT_FIELDS = [
  "accountId",
  "rootDirectoryId",
  "deviceId",
  "transportPublicKey",
  "assertionPublicKey",
  "capsuleGeneration",
  "capsuleDigest",
  "recoverySalt",
  "recoveryVerificationPublicKey",
  "rootRecoveryEnvelopeDigest",
  "enrollmentEnvelopeDigest",
  "profileDigest",
  "recoveryCodeHashes",
  "registrationChallenge",
  "proofNonce",
  "registryEpoch",
];

export function encodeBytes(input: Uint8Array): string {
  const bytes = input;
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BYTES) throw new Error("malformed base64url bytes");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Rejects padding, alternate spellings, invalid trailing bits and oversized input before allocating. */
export function decodeBytes(value: string, expectedLength?: number): Uint8Array<ArrayBuffer> {
  if (
    expectedLength !== undefined &&
    (!Number.isSafeInteger(expectedLength) || expectedLength < 0 || expectedLength > MAX_BYTES)
  ) {
    throw new Error("malformed base64url length");
  }
  const maxBytes = expectedLength ?? MAX_BYTES;
  if (
    typeof value !== "string" ||
    value.length > Math.ceil((maxBytes * 4) / 3) + 2 ||
    !/^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/.test(value)
  ) {
    throw new Error("malformed base64url");
  }
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4));
  if (binary.length > maxBytes || (expectedLength !== undefined && binary.length !== expectedLength))
    throw new Error("malformed base64url");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBytes(bytes) !== value) throw new Error("malformed base64url");
  return bytes;
}

export interface SignupTranscript {
  accountId: string;
  rootDirectoryId: string;
  deviceId: string;
  transportPublicKey: string;
  assertionPublicKey: string;
  capsuleGeneration: 1;
  capsuleDigest: string;
  recoverySalt: string;
  recoveryVerificationPublicKey: string;
  rootRecoveryEnvelopeDigest: string;
  enrollmentEnvelopeDigest: string;
  profileDigest: string;
  recoveryCodeHashes: string[];
  registrationChallenge: string;
  proofNonce: string;
  registryEpoch: 1;
}

function bytesOf(value: unknown, length: number): Uint8Array {
  const bytes = decodeBytes(value as string, length);
  if (bytes.length !== length) throw new Error("invalid signup field length");
  return bytes;
}

function publicKey(value: unknown): Uint8Array {
  const bytes = bytesOf(value, 65);
  if (bytes[0] !== 4) throw new Error("invalid SEC1 public key");
  return bytes;
}

function text(value: unknown): Uint8Array {
  if (typeof value !== "string") throw new Error("invalid signup ID");
  const bytes = encoder.encode(value);
  if (!bytes.length || bytes.length > 256) throw new Error("invalid signup ID");
  try {
    if (decoder.decode(bytes) !== value) throw new Error("invalid signup ID");
  } catch {
    throw new Error("invalid signup ID");
  }
  return bytes;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Each ordered field is u16 big-endian length-prefixed; fixed integers are single bytes. */
function canonicalTranscript(value: SignupTranscript): Uint8Array {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== TRANSCRIPT_FIELDS.length ||
    !TRANSCRIPT_FIELDS.every((name) => Object.hasOwn(value, name)) ||
    value.capsuleGeneration !== 1 ||
    value.registryEpoch !== 1 ||
    !Array.isArray(value.recoveryCodeHashes) ||
    value.recoveryCodeHashes.length !== 10
  ) {
    throw new Error("invalid signup transcript");
  }
  const fields = [
    text(value.accountId),
    text(value.rootDirectoryId),
    text(value.deviceId),
    publicKey(value.transportPublicKey),
    publicKey(value.assertionPublicKey),
    Uint8Array.of(1),
    bytesOf(value.capsuleDigest, 32),
    bytesOf(value.recoverySalt, 32),
    publicKey(value.recoveryVerificationPublicKey),
    bytesOf(value.rootRecoveryEnvelopeDigest, 32),
    bytesOf(value.enrollmentEnvelopeDigest, 32),
    bytesOf(value.profileDigest, 32),
    ...value.recoveryCodeHashes.map((hash) => bytesOf(hash, 32)),
    bytesOf(value.registrationChallenge, 32),
    bytesOf(value.proofNonce, 8),
    Uint8Array.of(1),
  ];
  return join(
    TRANSCRIPT_TAG,
    ...fields.map((field) => {
      const prefix = Uint8Array.of(field.length >>> 8, field.length & 255);
      return join(prefix, field);
    }),
  );
}

async function transcriptHash(transcript: SignupTranscript): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(canonicalTranscript(transcript))));
}

export async function transcriptDigest(transcript: SignupTranscript): Promise<string> {
  return encodeBytes(await transcriptHash(transcript));
}

/** Domain tag followed by the raw canonical transcript SHA-256 digest. */
export async function bindingMessage(transcript: SignupTranscript): Promise<Uint8Array> {
  return join(BINDING_TAG, await transcriptHash(transcript));
}

function validHash(bytes: Uint8Array): boolean {
  return bytes[0] === 0 && bytes[1] === 0 && (bytes[2]! & 0xc0) === 0;
}

export async function verifyProofOfWork(challenge: string, nonce: string): Promise<boolean> {
  const challengeBytes = bytesOf(challenge, 32);
  const nonceBytes = bytesOf(nonce, 8);
  return validHash(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(join(challengeBytes, nonceBytes)))),
  );
}

/** Random starting point, wrapping the full 64-bit nonce space, with cooperative yields. */
export async function solveProofOfWork(challenge: string, signal?: AbortSignal): Promise<string> {
  const challengeBytes = bytesOf(challenge, 32);
  const candidate = join(challengeBytes, crypto.getRandomValues(new Uint8Array(8)));
  const view = new DataView(candidate.buffer);
  let nonce = view.getBigUint64(32);
  const start = nonce;
  for (;;) {
    if (signal?.aborted) throw new DOMException("Proof of work aborted", "AbortError");
    for (let i = 0; i < 256; i++) {
      view.setBigUint64(32, nonce);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(candidate)));
      if (validHash(digest)) return encodeBytes(candidate.subarray(32));
      nonce = BigInt.asUintN(64, nonce + 1n);
      if (nonce === start) throw new Error("nonce space exhausted");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
