import { decodeBytes, encodeBytes } from "~/shared/signup/protocol";

const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type RecoveryIntent = {
  accountId: string;
  generation: number;
  nonce: string;
  registryEpoch: number;
  deviceId: string;
  transportPublicKey: string;
  assertionPublicKey: string;
  nextMetadataDigest: string;
};

export type NextRecoveryMetadata = {
  generation: number;
  recoverySalt: string;
  verificationPublicKey: string;
  capsuleDigest: string;
  enrollmentEnvelopeDigest: string;
};

function generation(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) throw new Error("invalid recovery generation");
  return value;
}

function publicKey(value: string): string {
  if (decodeBytes(value, 65)[0] !== 4) throw new Error("invalid recovery key");
  return value;
}

function bytes(value: string, length: number): string {
  decodeBytes(value, length);
  return value;
}

/** Canonical ordered wire transcript; no phrase or plaintext key belongs here. */
export function recoveryIntentMessage(value: RecoveryIntent): Uint8Array {
  if (!value || !uuid.test(value.accountId) || !uuid.test(value.deviceId)) throw new Error("invalid recovery intent");
  const fields = [
    "mdwn/recovery-enrollment-intent/v1", value.accountId,
    String(generation(value.generation)), bytes(value.nonce, 32),
    String(generation(value.registryEpoch)), value.deviceId,
    publicKey(value.transportPublicKey), publicKey(value.assertionPublicKey),
    bytes(value.nextMetadataDigest, 32),
  ];
  return encoder.encode(JSON.stringify(fields));
}

export async function nextRecoveryMetadataDigest(value: NextRecoveryMetadata): Promise<string> {
  const fields = [
    "mdwn/recovery-next-metadata/v1", String(generation(value.generation)),
    bytes(value.recoverySalt, 32), publicKey(value.verificationPublicKey),
    bytes(value.capsuleDigest, 32), bytes(value.enrollmentEnvelopeDigest, 32),
  ];
  return encodeBytes(await sha256(encoder.encode(JSON.stringify(fields))));
}

export async function sha256(input: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(input)));
}

export function possessionMessage(intentDigest: Uint8Array, challenge: Uint8Array): Uint8Array {
  if (intentDigest.length !== 32 || challenge.length !== 32) throw new Error("invalid recovery challenge");
  const message = new Uint8Array(encoder.encode("mdwn/recovery-possession/v1\0").length + 64);
  const tag = encoder.encode("mdwn/recovery-possession/v1\0");
  message.set(tag);
  message.set(intentDigest, tag.length);
  message.set(challenge, tag.length + 32);
  return message;
}
