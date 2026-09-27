import { startRegistration } from "@simplewebauthn/browser";

import { authPost } from "~/auth/client";
import { prepareRecoveryCodeSet } from "~/auth/recovery-codes";
import { sealAccountProfile } from "~/crypto/account-profile";
import { digestEnvelope, inspectEnvelope } from "~/crypto/enc-v1";
import {
  createRecoveryMaterial, createVaultKeyHierarchy, openDeviceEnrollmentEnvelope,
  sealDeviceEnrollmentEnvelope,
} from "~/crypto/vault";
import { createDevice, getDevice, updateRegistryEpoch } from "~/device/store";
import { newOpaqueId } from "~/opaque-id";
import { bindingMessage, decodeBytes, encodeBytes, solveProofOfWork, type SignupTranscript } from "~/signup/protocol";
import { RECOVERY_CONFIRMATION_GATE_KEY } from "~/signup/recovery-gate";

export { confirmSignupRecovery, isSignupRecoveryConfirmationPending } from "~/signup/recovery-gate";

async function digest(bytes: Uint8Array): Promise<string> {
  return encodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))));
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
  const accountId = newOpaqueId();
  const rootDirectoryId = newOpaqueId();
  const deviceId = newOpaqueId();
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
  const { codes: recoveryCodes, hashes: recoveryCodeHashes } = await prepareRecoveryCodeSet();
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
  localStorage.setItem(RECOVERY_CONFIRMATION_GATE_KEY, accountId);
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
