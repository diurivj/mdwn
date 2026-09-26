import { authFailure, authGet, authPost } from "~/auth/client";
import { confirmFreshPasskey } from "~/auth/fresh-client";
import { digestEnvelope } from "~/crypto/enc-v1";
import {
  createRecoveryMaterial, openDeviceEnrollmentEnvelope, openRecoveryCapsule,
  sealDeviceEnrollmentEnvelope,
} from "~/crypto/vault";
import {
  activateRecoveryCandidate, createRecoveryCandidate, getDevice, getRecoveryCandidate,
  listRecoveryCandidates,
} from "~/device/store";
import { newOpaqueId } from "~/opaque-id";
import { decodeBytes, encodeBytes } from "~/signup/protocol";

import { nextRecoveryMetadataDigest, possessionMessage, recoveryIntentMessage, sha256, type NextRecoveryMetadata, type RecoveryIntent } from "./protocol";
import { ownedProvisioningNeeded } from "~/device/owned-provision-client";

type Start = {
  enrollmentId: string; accountId: string; generation: number; registryEpoch: number;
  nonce: string; recoverySalt: string; capsule: string; verificationPublicKey: string;
};
type Loaded = { state: "ready" | "signed-out" | "restricted" | "failed"; phrase?: string; restoring?: boolean };
const PHRASE_KEY = "mdwn:pending-recovery-phrase";

/** Repair a committed cutover whose response or browser activation was interrupted. */
export async function loadVaultRecovery(signal: AbortSignal): Promise<Loaded> {
  try {
    const { identifier: accountId } = await authGet<{ identifier: string }>(
      "/api/auth/recovery/identifier", signal);
    for (const pending of await listRecoveryCandidates(accountId)) {
      const state = await authGet<{ candidateActive: boolean; registryEpoch: number }>(
        `/api/device/state?candidateDeviceId=${pending.deviceId}`, signal);
      if (state.candidateActive && Number.isSafeInteger(state.registryEpoch)) {
        await activateRecoveryCandidate(accountId, pending.deviceId, state.registryEpoch);
        break;
      }
    }
    const saved = sessionStorage.getItem(PHRASE_KEY);
    const parsed = saved ? JSON.parse(saved) as { accountId?: string; deviceId?: string; phrase?: string } : null;
    const device = await getDevice(accountId);
    let restoring = false;
    if (device) {
      try { restoring = await ownedProvisioningNeeded(signal); }
      catch { restoring = true; }
    }
    return { state: "ready", ...(parsed?.accountId === accountId &&
      parsed.deviceId === device?.deviceId && typeof parsed.phrase === "string"
      ? { phrase: parsed.phrase } : {}), restoring };
  } catch (error) { return { state: authFailure(error, signal) }; }
}

export function forgetRecoveryPhrase(): void {
  sessionStorage.removeItem(PHRASE_KEY);
}

export async function runVaultRecovery(request: Request) {
  let committedPhrase: string | null = null;
  let commitSubmitted = false;
  try {
    const form = await request.formData();
    const phrase = form.get("phrase");
    if (typeof phrase !== "string" || !phrase.trim()) return { state: "failed" } as const;
    await confirmFreshPasskey(request.signal);
    const start = await authPost<Start>("/api/files-recovery/start", {}, request.signal, "failed");
    const opened = await openRecoveryCapsule({
      accountId: start.accountId, generation: start.generation,
      recoverySalt: decodeBytes(start.recoverySalt, 32),
      capsule: decodeBytes(start.capsule),
      recoveryVerificationPublicKey: decodeBytes(start.verificationPublicKey, 65),
    }, phrase, {
      accountId: start.accountId, generation: start.generation,
      recoverySalt: decodeBytes(start.recoverySalt, 32),
    });
    const next = await createRecoveryMaterial(start.accountId, {
      generation: start.generation + 1, vaultRootKey: opened.vaultRootKey,
    });
    const candidate = await createRecoveryCandidate(start.accountId, newOpaqueId());
    const persisted = await getRecoveryCandidate(start.accountId, candidate.deviceId);
    if (!persisted || persisted.deviceId !== candidate.deviceId) throw new Error("Device keys unavailable");
    const transportPublicKey = encodeBytes(new Uint8Array(await crypto.subtle.exportKey("raw", persisted.transportKeyPair.publicKey)));
    const assertionPublicKey = encodeBytes(new Uint8Array(await crypto.subtle.exportKey("raw", persisted.assertionKeyPair.publicKey)));
    const enrollmentContext = {
      purpose: "device-enrollment" as const, vaultId: start.accountId, objectId: candidate.deviceId,
      keyId: candidate.deviceId, keyEpoch: 1, revision: 1, recipientId: candidate.deviceId,
    };
    const enrollmentEnvelope = await sealDeviceEnrollmentEnvelope(
      opened.vaultRootKey, persisted.transportKeyPair.publicKey, enrollmentContext);
    const locallyOpened = await openDeviceEnrollmentEnvelope(enrollmentEnvelope,
      persisted.transportKeyPair, enrollmentContext);
    if (!locallyOpened.every((byte, index) => byte === opened.vaultRootKey[index])) throw new Error("Device envelope failed");
    const metadata: NextRecoveryMetadata = {
      generation: next.generation, recoverySalt: encodeBytes(next.recoverySalt),
      verificationPublicKey: encodeBytes(next.recoveryVerificationPublicKeyBytes),
      capsuleDigest: encodeBytes(await digestEnvelope(next.record.capsule)),
      enrollmentEnvelopeDigest: encodeBytes(await digestEnvelope(enrollmentEnvelope)),
    };
    const intent: RecoveryIntent = {
      accountId: start.accountId, generation: start.generation, nonce: start.nonce,
      registryEpoch: start.registryEpoch, deviceId: candidate.deviceId,
      transportPublicKey, assertionPublicKey,
      nextMetadataDigest: await nextRecoveryMetadataDigest(metadata),
    };
    const message = recoveryIntentMessage(intent);
    const intentDigest = await sha256(message);
    const intentSignature = encodeBytes(new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, opened.recoveryEnrollmentKeyPair.privateKey,
      new Uint8Array(message))));
    const challenge = await authPost<{ challenge: string }>("/api/files-recovery/challenge",
      { enrollmentId: start.enrollmentId, intent, intentSignature }, request.signal, "failed");
    const secret = await openDeviceEnrollmentEnvelope(decodeBytes(challenge.challenge),
      persisted.transportKeyPair, {
        purpose: "device-enrollment", vaultId: start.accountId,
        objectId: "recovery-transport-challenge", keyId: "recovery-transport-challenge",
        keyEpoch: start.generation, revision: 1, recipientId: candidate.deviceId,
      });
    const challengeSignature = encodeBytes(new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, persisted.assertionKeyPair.privateKey,
      new Uint8Array(possessionMessage(intentDigest, secret)))));
    // This browser-local copy survives a reload after commit but is never sent to the service.
    sessionStorage.setItem(PHRASE_KEY, JSON.stringify({
      accountId: start.accountId, deviceId: candidate.deviceId, phrase: next.phrase,
    }));
    commitSubmitted = true;
    const committed = await authPost<{ ok: true; registryEpoch: number }>(
      "/api/files-recovery/commit", {
        enrollmentId: start.enrollmentId, intent, intentSignature,
        challengeSecret: encodeBytes(secret), challengeSignature,
        nextMetadata: metadata, nextCapsule: encodeBytes(next.record.capsule),
        enrollmentEnvelope: encodeBytes(enrollmentEnvelope),
      }, request.signal, "failed");
    if (committed.ok !== true || !Number.isSafeInteger(committed.registryEpoch)) throw new Error("Recovery failed");
    committedPhrase = next.phrase;
    try {
      await activateRecoveryCandidate(start.accountId, candidate.deviceId, committed.registryEpoch);
    } catch { /* The committed device can resume from the pending record or normal private access. */ }
    return { state: "success", phrase: next.phrase, restoring: true } as const;
  } catch (error) {
    if (committedPhrase) return { state: "success", phrase: committedPhrase, restoring: true } as const;
    if (commitSubmitted) return { state: "uncertain" } as const;
    return { state: authFailure(error, request.signal) } as const;
  }
}
