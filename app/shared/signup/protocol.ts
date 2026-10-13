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

/** Lifetime of a signup registration challenge, and of the WebAuthn challenge its options carry. */
export const SIGNUP_CHALLENGE_MS = 5 * 60_000;

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

/** 18 leading zero bits. */
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

// SHA-256 round constants and initial hash value (FIPS 180-4 §4.2.2, §5.3.3).
const SHA256_K = Int32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);
const SHA256_IV = Int32Array.from([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** SHA-256 compression rounds `from` to `to` (exclusive) over one message schedule, updating `state` in place. */
function sha256Rounds(state: Int32Array, w: Int32Array, from: number, to: number): void {
  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  let e = state[4];
  let f = state[5];
  let g = state[6];
  let h = state[7];
  for (let t = from; t < to; t++) {
    const t1 =
      (h +
        (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) +
        ((e & f) ^ (~e & g)) +
        SHA256_K[t] +
        w[t]) |
      0;
    const t2 =
      ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) +
        ((a & b) ^ (a & c) ^ (b & c))) |
      0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  state[0] = a;
  state[1] = b;
  state[2] = c;
  state[3] = d;
  state[4] = e;
  state[5] = f;
  state[6] = g;
  state[7] = h;
}

/**
 * Tests nonces against one challenge synchronously. The 40-byte message fills
 * a single padded SHA-256 block; rounds 0–7 read only the challenge and round 8
 * only the nonce's high word, so each candidate runs rounds 9–63. Awaiting one
 * WebCrypto digest per candidate was 45–95 times slower in Chromium, Firefox
 * and WebKit (ticket 69).
 */
function proofOfWorkSearch(challenge: Uint8Array) {
  const w = new Int32Array(64);
  const words = new DataView(challenge.buffer, challenge.byteOffset, 32);
  for (let i = 0; i < 8; i++) w[i] = words.getInt32(i * 4);
  w[10] = 0x80000000 | 0; // the padding bit after 40 bytes
  w[15] = 40 * 8; // the message length in bits
  const afterChallenge = SHA256_IV.slice();
  sha256Rounds(afterChallenge, w, 0, 8);
  const afterHigh = new Int32Array(8);
  const state = new Int32Array(8);
  return {
    setHigh(high: number): void {
      w[8] = high;
      afterHigh.set(afterChallenge);
      sha256Rounds(afterHigh, w, 8, 9);
    },
    /** The digest's first word starts with the 18 zero bits `validHash` checks. */
    matches(low: number): boolean {
      w[9] = low;
      for (let t = 16; t < 64; t++) {
        const x = w[t - 15];
        const y = w[t - 2];
        w[t] =
          ((((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)) +
            w[t - 7] +
            (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) +
            w[t - 16]) |
          0;
      }
      state.set(afterHigh);
      sha256Rounds(state, w, 9, 64);
      return (SHA256_IV[0] + state[0]) >>> 14 === 0;
    },
  };
}

/** Short enough for the page to keep painting and handling input while the search runs. */
const SOLVE_SLICE_MS = 12;

/** Unlike chained zero-delay timers, a channel message is not clamped to 4 ms between slices. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * Random starting point, wrapping the full 64-bit nonce space, in short
 * main-thread slices. The answer is checked with WebCrypto, as the Worker
 * checks it, before it is returned.
 */
export async function solveProofOfWork(challenge: string, signal?: AbortSignal): Promise<string> {
  const search = proofOfWorkSearch(bytesOf(challenge, 32));
  const start = new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer);
  const startHigh = start.getUint32(0);
  const startLow = start.getUint32(4);
  let high = startHigh;
  let low = startLow;
  search.setHigh(high);
  for (;;) {
    if (signal?.aborted) throw new DOMException("Proof of work aborted", "AbortError");
    const sliceEnd = performance.now() + SOLVE_SLICE_MS;
    do {
      for (let i = 0; i < 1024; i++) {
        if (search.matches(low)) {
          const nonce = new DataView(new ArrayBuffer(8));
          nonce.setUint32(0, high);
          nonce.setUint32(4, low);
          const encoded = encodeBytes(new Uint8Array(nonce.buffer));
          if (!(await verifyProofOfWork(challenge, encoded))) throw new Error("proof of work self-check failed");
          return encoded;
        }
        low = (low + 1) >>> 0;
        if (low === 0) {
          high = (high + 1) >>> 0;
          search.setHigh(high);
        }
        if (low === startLow && high === startHigh) throw new Error("nonce space exhausted");
      }
    } while (performance.now() < sliceEnd);
    await nextTask();
  }
}
