import { startRegistration } from "@simplewebauthn/browser";

import { authPost } from "~/auth/client";
import { sealAccountProfile } from "~/crypto/account-profile";
import { digestEnvelope, inspectEnvelope } from "~/crypto/enc-v1";
import {
  createRecoveryMaterial, createVaultKeyHierarchy, openDeviceEnrollmentEnvelope,
  sealDeviceEnrollmentEnvelope,
} from "~/crypto/vault";
import { createDevice, getDevice, updateRegistryEpoch } from "~/device/store";
import { bindingMessage, decodeBytes, encodeBytes, solveProofOfWork, type SignupTranscript } from "~/signup/protocol";

const encoder = new TextEncoder();
const GATE_KEY = "mdwn:signup:recovery-confirmation-pending";

/** A pending local gate must be checked before enabling private mutations or imports. */
export function isSignupRecoveryConfirmationPending(): boolean {
  try {
    return typeof window !== "undefined" && localStorage.getItem(GATE_KEY) !== null;
  } catch {
    // Unreadable client storage cannot grant private write access.
    return true;
  }
}

export function confirmSignupRecovery(): void {
  localStorage.removeItem(GATE_KEY);
}

/** RFC 9562 UUIDv7: millisecond timestamp followed by cryptographic random bits. */
export function newSignupId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(timestamp & 255n);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 15) | 0x70;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function digest(bytes: Uint8Array): Promise<string> {
  return encodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))));
}

function randomCode(): string {
  return encodeBytes(crypto.getRandomValues(new Uint8Array(24)));
}

export type SignupSecrets = { phrase: string; recoveryCodes: string[] };
export type PreparedSignup = {
  readonly secrets: SignupSecrets;
  readonly transcriptBase: Omit<SignupTranscript, "registrationChallenge" | "proofNonce">;
  readonly material: {
    readonly rootRecoveryEnvelope: string;
    readonly enrollmentEnvelope: string;
    readonly capsule: string;
    readonly encryptedProfile: string;
  };
};

/** Prepare locally, then let the user save and verify recovery material before any network request. */
export async function prepareSignup(): Promise<PreparedSignup> {
  const accountId = newSignupId();
  const rootDirectoryId = newSignupId();
  const deviceId = newSignupId();
  const device = await createDevice(accountId, deviceId);
  // Persist the *candidate* epoch before network I/O: a lost commit response
  // must still allow the saved keys to bind on the next Passkey sign-in.
  await updateRegistryEpoch(accountId, 1);
  const hierarchy = await createVaultKeyHierarchy({ accountId, rootDirectoryId });
  const recovery = await createRecoveryMaterial(accountId, { vaultRootKey: hierarchy.vaultRootKey });
  const enrollmentContext = {
    purpose: "device-enrollment" as const, vaultId: accountId, objectId: deviceId,
    keyId: deviceId, keyEpoch: 1, revision: 1, recipientId: deviceId,
  };
  const enrollmentEnvelope = await sealDeviceEnrollmentEnvelope(
    hierarchy.vaultRootKey, device.transportKeyPair.publicKey, enrollmentContext,
  );
  const encryptedProfile = await sealAccountProfile(
    hierarchy.vaultRootKey,
    { publicPseudonym: `Member ${encodeBytes(crypto.getRandomValues(new Uint8Array(9)))}` },
    { accountId, epoch: 1, revision: 1 },
  );
  const recoveryCodes = Array.from({ length: 10 }, randomCode);
  const recoveryCodeHashes = await Promise.all(recoveryCodes.map((code) => digest(encoder.encode(code))));
  // Reject noncanonical material locally rather than submitting an inconsistent transcript.
  inspectEnvelope(hierarchy.rootDirectoryRecoveryEnvelope);
  inspectEnvelope(enrollmentEnvelope);
  inspectEnvelope(recovery.record.capsule);
  inspectEnvelope(encryptedProfile.ciphertext);
  const [transportPublicKey, assertionPublicKey] = await Promise.all([
    crypto.subtle.exportKey("raw", device.transportKeyPair.publicKey),
    crypto.subtle.exportKey("raw", device.assertionKeyPair.publicKey),
  ]);
  const material = {
    rootRecoveryEnvelope: encodeBytes(hierarchy.rootDirectoryRecoveryEnvelope),
    enrollmentEnvelope: encodeBytes(enrollmentEnvelope),
    capsule: encodeBytes(recovery.record.capsule),
    encryptedProfile: encodeBytes(encryptedProfile.ciphertext),
  };
  const [capsuleDigest, rootRecoveryEnvelopeDigest, enrollmentEnvelopeDigest, profileDigest] = await Promise.all([
    digestEnvelope(recovery.record.capsule), digestEnvelope(hierarchy.rootDirectoryRecoveryEnvelope),
    digestEnvelope(enrollmentEnvelope), digestEnvelope(encryptedProfile.ciphertext),
  ]);

  const transcriptBase: PreparedSignup["transcriptBase"] = {
    accountId, rootDirectoryId, deviceId,
    transportPublicKey: encodeBytes(new Uint8Array(transportPublicKey)),
    assertionPublicKey: encodeBytes(new Uint8Array(assertionPublicKey)),
    capsuleGeneration: 1,
    capsuleDigest: encodeBytes(capsuleDigest),
    recoverySalt: encodeBytes(recovery.recoverySalt),
    recoveryVerificationPublicKey: encodeBytes(recovery.recoveryVerificationPublicKeyBytes),
    rootRecoveryEnvelopeDigest: encodeBytes(rootRecoveryEnvelopeDigest),
    enrollmentEnvelopeDigest: encodeBytes(enrollmentEnvelopeDigest),
    profileDigest: encodeBytes(profileDigest),
    recoveryCodeHashes,
    registryEpoch: 1,
  };
  localStorage.setItem(GATE_KEY, accountId);
  return { secrets: { phrase: recovery.phrase, recoveryCodes }, transcriptBase, material };
}

/** A confirmed copy exists before the one-use challenge and any possible Account commit. */
export async function commitSignup(prepared: PreparedSignup, honeypot: string, signal: AbortSignal): Promise<void> {
  const { material, transcriptBase } = prepared;
  const { accountId, deviceId } = transcriptBase;
  const challenge = await authPost<{ challengeId: string; challenge: string }>(
    "/api/signup/challenge", {}, signal, "failed",
  );
  decodeBytes(challenge.challenge, 32);
  const nonce = await solveProofOfWork(challenge.challenge, signal);
  const transcript: SignupTranscript = { ...transcriptBase, registrationChallenge: challenge.challenge, proofNonce: nonce };
  const options = await authPost<{
    challengeId: string;
    options: Parameters<typeof startRegistration>[0]["optionsJSON"];
    transportChallenge: string;
  }>("/api/signup/options", { challengeId: challenge.challengeId, nonce, transcript }, signal, "failed");
  if (typeof options.challengeId !== "string" || !options.challengeId) throw new Error("Invalid signup challenge");
  // Prove possession of the persisted handles, not just the in-memory keypair.
  const persisted = await getDevice(accountId);
  if (!persisted || persisted.deviceId !== deviceId || !persisted.transportKeyPair.privateKey ||
      !persisted.assertionKeyPair.privateKey) throw new Error("Device keys unavailable");
  const transportProof = encodeBytes(await openDeviceEnrollmentEnvelope(
    decodeBytes(options.transportChallenge), persisted.transportKeyPair,
    { purpose: "device-enrollment", vaultId: accountId,
      objectId: "signup-transport-challenge", keyId: "signup-transport-challenge",
      keyEpoch: 1, revision: 1, recipientId: deviceId },
  ));
  const bindingSignature = encodeBytes(new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, persisted.assertionKeyPair.privateKey,
    new Uint8Array(await bindingMessage(transcript)),
  )));
  const response = await startRegistration({ optionsJSON: options.options });
  const result = await authPost<{ ok: true; sessionBinding: string }>(
    "/api/signup/verify",
    { challengeId: options.challengeId, transcript, material, transportProof, bindingSignature, response, honeypot },
    signal, "failed",
  );
  if (result.ok !== true || typeof result.sessionBinding !== "string" || !result.sessionBinding) {
    throw new Error("Signup verification failed");
  }
}
