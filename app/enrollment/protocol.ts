import { decodeBytes, encodeBytes } from "~/signup/protocol";

const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type CandidateTranscript = {
  accountId: string;
  registryEpoch: number;
  deviceId: string;
  transportPublicKey: string;
  assertionPublicKey: string;
  pairingSecretHash: string;
};

export type EnrollmentApproval = CandidateTranscript & {
  enrollmentId: string;
  transcriptDigest: string;
  envelopeDigest: string;
  approvingDeviceId: string;
  expiresAt: number;
};

function exact(value: object, names: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === names.length && names.every((name) => Object.hasOwn(value, name));
}

function id(value: string): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new Error("invalid enrollment ID");
  return value;
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid enrollment number");
  return value;
}

function bytes(value: string, length: number): string {
  const decoded = decodeBytes(value, length);
  if (length === 65 && decoded[0] !== 4) throw new Error("invalid public key");
  return value;
}

/** Fixed-field canonical encoding shared by the QR, browser, and Worker. */
export function candidateTranscriptMessage(value: CandidateTranscript): Uint8Array<ArrayBuffer> {
  if (!value || !exact(value, ["accountId", "registryEpoch", "deviceId", "transportPublicKey",
    "assertionPublicKey", "pairingSecretHash"])) throw new Error("invalid candidate transcript");
  return encoder.encode(JSON.stringify([
    "mdwn/device-enrollment-candidate/v1", id(value.accountId), positive(value.registryEpoch),
    id(value.deviceId), bytes(value.transportPublicKey, 65), bytes(value.assertionPublicKey, 65),
    bytes(value.pairingSecretHash, 32),
  ]));
}

export function approvalMessage(value: EnrollmentApproval): Uint8Array<ArrayBuffer> {
  if (!value || !exact(value, ["accountId", "registryEpoch", "deviceId", "transportPublicKey",
    "assertionPublicKey", "pairingSecretHash", "enrollmentId", "transcriptDigest",
    "envelopeDigest", "approvingDeviceId", "expiresAt"])) throw new Error("invalid approval");
  candidateTranscriptMessage({
    accountId: value.accountId, registryEpoch: value.registryEpoch, deviceId: value.deviceId,
    transportPublicKey: value.transportPublicKey, assertionPublicKey: value.assertionPublicKey,
    pairingSecretHash: value.pairingSecretHash,
  });
  return encoder.encode(JSON.stringify([
    "mdwn/device-enrollment-approval/v1", id(value.accountId), id(value.enrollmentId),
    bytes(value.pairingSecretHash, 32), id(value.deviceId), bytes(value.transportPublicKey, 65),
    bytes(value.assertionPublicKey, 65), bytes(value.transcriptDigest, 32),
    bytes(value.envelopeDigest, 32), id(value.approvingDeviceId), positive(value.registryEpoch),
    positive(value.expiresAt),
  ]));
}

export function possessionMessage(transcriptDigest: Uint8Array, challenge: Uint8Array): Uint8Array<ArrayBuffer> {
  if (transcriptDigest.length !== 32 || challenge.length !== 32) throw new Error("invalid challenge");
  const result = new Uint8Array(encoder.encode("mdwn/device-enrollment-possession/v1\0").length + 64);
  const tag = encoder.encode("mdwn/device-enrollment-possession/v1\0");
  result.set(tag); result.set(transcriptDigest, tag.length); result.set(challenge, tag.length + 32);
  return result;
}

export async function sha256(input: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(input)));
}

export function qrPayload(enrollmentId: string, expiresAt: number, transcript: CandidateTranscript,
  transcriptDigest: string, pairingSecret: Uint8Array): string {
  id(enrollmentId); positive(expiresAt); candidateTranscriptMessage(transcript);
  bytes(transcriptDigest, 32);
  if (pairingSecret.length !== 32) throw new Error("invalid pairing secret");
  return encodeBytes(encoder.encode(JSON.stringify({ enrollmentId, expiresAt, transcript,
    transcriptDigest, pairingSecret: encodeBytes(pairingSecret) })));
}

export function parseQrPayload(value: string): {
  enrollmentId: string; expiresAt: number; transcript: CandidateTranscript;
  transcriptDigest: string; pairingSecret: Uint8Array<ArrayBuffer>;
} {
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBytes(value))) as Record<string, unknown>;
  if (!parsed || !exact(parsed, ["enrollmentId", "expiresAt", "transcript", "transcriptDigest", "pairingSecret"])) {
    throw new Error("invalid QR");
  }
  const transcript = parsed.transcript as CandidateTranscript;
  const pairingSecret = decodeBytes(parsed.pairingSecret as string, 32);
  const digest = bytes(parsed.transcriptDigest as string, 32);
  id(parsed.enrollmentId as string); positive(parsed.expiresAt as number);
  candidateTranscriptMessage(transcript);
  return { enrollmentId: parsed.enrollmentId as string, expiresAt: parsed.expiresAt as number,
    transcript, transcriptDigest: digest, pairingSecret };
}
