import { startRegistration } from "@simplewebauthn/browser";

import { normalizePseudonym, pseudonymProblem } from "~/shared/account/pseudonym";
import { prepareRecoveryCodeSet } from "~/shared/auth/recovery-codes";
import { sealAccountProfile } from "~/shared/crypto/account-profile";
import { digestEnvelope, inspectEnvelope } from "~/shared/crypto/enc-v1";
import {
  createRecoveryMaterial,
  createVaultKeyHierarchy,
  openDeviceEnrollmentEnvelope,
  sealDeviceEnrollmentEnvelope,
} from "~/shared/crypto/vault";
import { createDevice, getDevice, updateRegistryEpoch } from "~/shared/device/store";
import { newOpaqueId } from "~/shared/opaque-id";
import {
  bindingMessage,
  decodeBytes,
  encodeBytes,
  SIGNUP_CHALLENGE_MS,
  solveProofOfWork,
  type SignupTranscript,
} from "~/shared/signup/protocol";
import { RECOVERY_CONFIRMATION_GATE_KEY } from "~/shared/signup/recovery-gate";

export { confirmSignupRecovery, isSignupRecoveryConfirmationPending } from "~/shared/signup/recovery-gate";

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

/**
 * Prepare locally, then let the user save and verify recovery material before
 * any network request. The chosen Public pseudonym is sealed into the Account
 * profile here, so the service only ever receives it encrypted.
 */
export async function prepareSignup(publicPseudonym: string): Promise<PreparedSignup> {
  if (pseudonymProblem(publicPseudonym)) throw new Error("invalid Public pseudonym");
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
    purpose: "device-enrollment" as const,
    vaultId: accountId,
    objectId: deviceId,
    keyId: deviceId,
    keyEpoch: 1,
    revision: 1,
    recipientId: deviceId,
  };
  const enrollmentEnvelope = await sealDeviceEnrollmentEnvelope(
    hierarchy.vaultRootKey,
    device.transportKeyPair.publicKey,
    enrollmentContext,
  );
  const encryptedProfile = await sealAccountProfile(
    hierarchy.vaultRootKey,
    { publicPseudonym: normalizePseudonym(publicPseudonym) },
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
    digestEnvelope(recovery.record.capsule),
    digestEnvelope(hierarchy.rootDirectoryRecoveryEnvelope),
    digestEnvelope(enrollmentEnvelope),
    digestEnvelope(encryptedProfile.ciphertext),
  ]);

  const transcriptBase: PreparedSignup["transcriptBase"] = {
    accountId,
    rootDirectoryId,
    deviceId,
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

/** What the person waits on after confirming recovery: the proof of work, their passkey, then the commit. */
export type SignupStep = "check" | "passkey" | "save";

/**
 * Why a commit attempt stopped, which decides what the person can do next.
 * After `request`, `limited` (a rate-limited start) or `passkey`, no passkey or
 * Account exists, so the same recovery material can try again. After `device`
 * this browser has lost the new device keys, and after `full` (a rate-limited
 * commit) a passkey exists for an Account that was not created: signup starts
 * over. After `unconfirmed` a passkey exists but the commit's outcome is
 * unknown: the person signs in, or starts over.
 */
export type SignupFailure = "request" | "limited" | "passkey" | "device" | "full" | "unconfirmed";

export class SignupCommitError extends Error {
  constructor(
    readonly failure: SignupFailure,
    /** The Retry-After, in seconds, of a `limited` or `full` refusal, when the service sent one. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`signup ${failure}`);
  }
}

type RegistrationOptions = Parameters<typeof startRegistration>[0]["optionsJSON"];

/** One rate-limited start, ready to open the passkey prompt. */
type Registration = {
  readonly challengeId: string;
  readonly options: RegistrationOptions;
  readonly transcript: SignupTranscript;
  readonly transportProof: string;
  readonly bindingSignature: string;
  readonly reusableUntil: number;
};

/**
 * A dismissed prompt reopens with its registration only while a full prompt
 * (60 seconds by default) and the commit still fit in the WebAuthn challenge's lifetime.
 */
const REGISTRATION_REUSE_MS = SIGNUP_CHALLENGE_MS - 2 * 60_000;

/**
 * Commits a prepared signup after its recovery material is confirmed. A
 * failure that leaves no passkey can be retried with the same material, so the
 * phrase and codes the person saved still apply; a dismissed prompt reopens
 * without another rate-limited start. Once a passkey exists, an unknown outcome
 * is never retried with this material: if the Account was committed, another
 * passkey for the same Account ID would replace the registered one in the
 * person's passkey manager. It keeps only what it sends, never the phrase or codes.
 */
export function signupCommit({ transcriptBase, material }: PreparedSignup, honeypot: string) {
  let registration: Registration | null = null;
  let spent = false;
  return async function commit(signal: AbortSignal, onStep: (step: SignupStep) => void): Promise<void> {
    if (spent) throw new SignupCommitError("unconfirmed");
    if (!registration || Date.now() >= registration.reusableUntil) {
      registration = null;
      onStep("check");
      registration = await register(transcriptBase, signal);
    }
    onStep("passkey");
    // No await precedes this call when a retry reuses the registration, so it
    // runs inside the click that asked for it.
    const response = await startRegistration({ optionsJSON: registration.options }).catch(() => {
      throw new SignupCommitError("passkey");
    });
    // The commit consumes the WebAuthn challenge whatever its outcome.
    const { challengeId, transcript, transportProof, bindingSignature } = registration;
    registration = null;
    onStep("save");
    try {
      const result = await signupPost<{ ok: true; sessionBinding: string }>(
        "/api/signup/verify",
        { challengeId, transcript, material, transportProof, bindingSignature, response, honeypot },
        signal,
      );
      if (result.ok !== true || typeof result.sessionBinding !== "string" || !result.sessionBinding) {
        throw new Error("Signup verification failed");
      }
    } catch (error) {
      spent = true;
      // The service refuses a rate-limited commit without creating the Account.
      if (error instanceof SignupCommitError && error.failure === "limited") {
        throw new SignupCommitError("full", error.retryAfterSeconds);
      }
      throw new SignupCommitError("unconfirmed");
    }
  };
}

/** Challenge, proof of work and WebAuthn options, then proofs from the persisted device keys. */
async function register(transcriptBase: PreparedSignup["transcriptBase"], signal: AbortSignal): Promise<Registration> {
  const { accountId, deviceId } = transcriptBase;
  let transcript: SignupTranscript;
  let started: { challengeId: string; options: RegistrationOptions; transportChallenge: Uint8Array };
  try {
    const challenge = await signupPost<{ challengeId: string; challenge: string }>("/api/signup/challenge", {}, signal);
    decodeBytes(challenge.challenge, 32);
    const nonce = await solveProofOfWork(challenge.challenge, signal);
    transcript = { ...transcriptBase, registrationChallenge: challenge.challenge, proofNonce: nonce };
    const options = await signupPost<{ challengeId: string; options: RegistrationOptions; transportChallenge: string }>(
      "/api/signup/options",
      { challengeId: challenge.challengeId, nonce, transcript },
      signal,
    );
    if (typeof options.challengeId !== "string" || !options.challengeId) throw new Error("Invalid signup challenge");
    started = { ...options, transportChallenge: decodeBytes(options.transportChallenge) };
  } catch (error) {
    if (signal.aborted) throw error;
    throw error instanceof SignupCommitError ? error : new SignupCommitError("request");
  }
  const reusableUntil = Date.now() + REGISTRATION_REUSE_MS;
  try {
    // Prove possession of the persisted handles, not just the in-memory keypair.
    const persisted = await getDevice(accountId);
    if (
      !persisted ||
      persisted.deviceId !== deviceId ||
      !persisted.transportKeyPair.privateKey ||
      !persisted.assertionKeyPair.privateKey
    )
      throw new Error("Device keys unavailable");
    const transportProof = encodeBytes(
      await openDeviceEnrollmentEnvelope(started.transportChallenge, persisted.transportKeyPair, {
        purpose: "device-enrollment",
        vaultId: accountId,
        objectId: "signup-transport-challenge",
        keyId: "signup-transport-challenge",
        keyEpoch: 1,
        revision: 1,
        recipientId: deviceId,
      }),
    );
    const bindingSignature = encodeBytes(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          persisted.assertionKeyPair.privateKey,
          new Uint8Array(await bindingMessage(transcript)),
        ),
      ),
    );
    return {
      challengeId: started.challengeId,
      options: started.options,
      transcript,
      transportProof,
      bindingSignature,
      reusableUntil,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SignupCommitError("device");
  }
}

/** Signup's resource requests; a 429 keeps its Retry-After so the page can say when to try again. */
async function signupPost<T>(path: string, body: object, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (response.status === 429) {
    const seconds = Number(response.headers.get("Retry-After"));
    throw new SignupCommitError("limited", Number.isFinite(seconds) && seconds > 0 ? seconds : null);
  }
  if (!response.ok) throw new Error("Signup request failed");
  return (await response.json()) as T;
}
