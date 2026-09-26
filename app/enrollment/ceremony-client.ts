import { authGet, authPost } from "~/auth/client";
import { confirmFreshPasskey } from "~/auth/fresh-client";
import { createSymmetricWriter, digestEnvelope } from "~/crypto/enc-v1";
import { openDeviceEnrollmentEnvelope, sealDeviceEnrollmentEnvelope } from "~/crypto/vault";
import { privateRequest } from "~/device/private-client";
import { activateEnrollmentCandidate, createEnrollmentCandidate, getDevice,
  getEnrollmentCandidate } from "~/device/store";
import { newOpaqueId } from "~/opaque-id";
import { decodeBytes, encodeBytes } from "~/signup/protocol";

import { approvalMessage, candidateTranscriptMessage, parseQrPayload, possessionMessage,
  qrPayload, sha256, type CandidateTranscript, type EnrollmentApproval } from "./protocol";

const PENDING_KEY = "mdwn:pending-device-enrollment";

type DeviceState = { accountId: string; deviceId: string | null; registryEpoch: number;
  candidateActive?: boolean };

export type PendingCandidate = {
  enrollmentId: string; expiresAt: number; transcript: CandidateTranscript;
  transcriptDigest: string; pairingLink: string; label?: string;
};

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function savedPending(): PendingCandidate | null {
  try {
    const saved = sessionStorage.getItem(PENDING_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved) as PendingCandidate;
    const url = new URL(parsed.pairingLink);
    const qr = parseQrPayload(url.hash.slice(1));
    if (qr.enrollmentId !== parsed.enrollmentId || qr.expiresAt !== parsed.expiresAt ||
        !same(candidateTranscriptMessage(qr.transcript), candidateTranscriptMessage(parsed.transcript)) ||
        qr.transcriptDigest !== parsed.transcriptDigest) return null;
    return parsed;
  } catch { return null; }
}

export async function loadEnrollmentPage(signal: AbortSignal): Promise<{
  state: "ready" | "unprovisioned" | "pending" | "sign-in-again" | "signed-out" | "failed";
  pending?: PendingCandidate;
}> {
  const pending = savedPending();
  try {
    const state = await authGet<DeviceState>(pending
      ? `/api/device/state?candidateDeviceId=${encodeURIComponent(pending.transcript.deviceId)}`
      : "/api/device/state", signal);
    if (pending && pending.transcript.accountId === state.accountId && state.candidateActive) {
      await activateEnrollmentCandidate(state.accountId, pending.transcript.deviceId, state.registryEpoch);
      sessionStorage.removeItem(PENDING_KEY);
      return { state: state.deviceId === pending.transcript.deviceId ? "ready" : "sign-in-again" };
    }
    if (state.deviceId) return { state: "ready" };
    if (pending && pending.transcript.accountId === state.accountId &&
        pending.expiresAt > Date.now() &&
        await getEnrollmentCandidate(state.accountId, pending.transcript.deviceId)) {
      return { state: "pending", pending };
    }
    return { state: "unprovisioned" };
  } catch (error) {
    if (signal.aborted) throw error;
    return { state: "signed-out" };
  }
}

export async function beginCandidate(signal: AbortSignal, label: string): Promise<PendingCandidate> {
  if (label.length > 80) throw new Error("Device label is too long");
  await confirmFreshPasskey(signal);
  const state = await authGet<DeviceState>("/api/device/state", signal);
  if (state.deviceId || !Number.isSafeInteger(state.registryEpoch) || state.registryEpoch < 1) {
    throw new Error("Device is already active");
  }
  const deviceId = newOpaqueId();
  await createEnrollmentCandidate(state.accountId, deviceId);
  const device = await getEnrollmentCandidate(state.accountId, deviceId);
  if (!device) throw new Error("Candidate keys unavailable");
  const pairingSecret = crypto.getRandomValues(new Uint8Array(32));
  const transcript: CandidateTranscript = {
    accountId: state.accountId, registryEpoch: state.registryEpoch, deviceId,
    transportPublicKey: encodeBytes(new Uint8Array(await crypto.subtle.exportKey("raw", device.transportKeyPair.publicKey))),
    assertionPublicKey: encodeBytes(new Uint8Array(await crypto.subtle.exportKey("raw", device.assertionKeyPair.publicKey))),
    pairingSecretHash: encodeBytes(await sha256(pairingSecret)),
  };
  const transcriptDigest = encodeBytes(await sha256(candidateTranscriptMessage(transcript)));
  const started = await authPost<{ enrollmentId: string; expiresAt: number }>(
    "/api/device-enrollment/start", { transcript, transcriptDigest }, signal, "failed");
  const payload = qrPayload(started.enrollmentId, started.expiresAt, transcript,
    transcriptDigest, pairingSecret);
  const pairingLink = `${location.origin}/enroll-device/approve#${payload}`;
  const pending: PendingCandidate = { enrollmentId: started.enrollmentId,
    expiresAt: started.expiresAt, transcript, transcriptDigest, pairingLink,
    ...(label.trim() ? { label: label.trim() } : {}) };
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  return pending;
}

/** One poll makes no state change unless approval has produced a sealed challenge. */
export async function pollCandidate(pending: PendingCandidate, signal: AbortSignal): Promise<"pending" | "committed"> {
  if (pending.expiresAt <= Date.now()) throw new Error("Enrollment expired");
  const candidate = await getEnrollmentCandidate(pending.transcript.accountId, pending.transcript.deviceId);
  if (!candidate) throw new Error("Candidate keys unavailable");
  const response = await authPost<{
    state: "pending" | "challenged"; challenge?: string; enrollmentEnvelope?: string;
    approval?: EnrollmentApproval; approvalSignature?: string;
  }>("/api/device-enrollment/status", { enrollmentId: pending.enrollmentId }, signal, "failed");
  if (response.state === "pending") return "pending";
  if (!response.challenge || !response.enrollmentEnvelope || !response.approval || !response.approvalSignature) {
    throw new Error("Enrollment changed");
  }
  const approval = response.approval;
  const expected = pending.transcript;
  if (approval.enrollmentId !== pending.enrollmentId || approval.expiresAt !== pending.expiresAt ||
      approval.transcriptDigest !== pending.transcriptDigest ||
      !same(candidateTranscriptMessage(expected), candidateTranscriptMessage({
        accountId: approval.accountId, registryEpoch: approval.registryEpoch, deviceId: approval.deviceId,
        transportPublicKey: approval.transportPublicKey, assertionPublicKey: approval.assertionPublicKey,
        pairingSecretHash: approval.pairingSecretHash,
      })) || !same(decodeBytes(approval.envelopeDigest, 32),
        await digestEnvelope(decodeBytes(response.enrollmentEnvelope)))) throw new Error("Enrollment changed");
  approvalMessage(approval);
  const challengeSecret = await openDeviceEnrollmentEnvelope(decodeBytes(response.challenge),
    candidate.transportKeyPair, {
      purpose: "device-enrollment", vaultId: expected.accountId,
      objectId: "routine-transport-challenge", keyId: "routine-transport-challenge",
      keyEpoch: 1, revision: 1, recipientId: expected.deviceId,
    });
  const vaultRootKey = await openDeviceEnrollmentEnvelope(decodeBytes(response.enrollmentEnvelope),
    candidate.transportKeyPair, {
      purpose: "device-enrollment", vaultId: expected.accountId,
      objectId: expected.deviceId, keyId: expected.deviceId,
      keyEpoch: 1, revision: 1, recipientId: expected.deviceId,
    });
  const challengeSignature = encodeBytes(new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, candidate.assertionKeyPair.privateKey,
    possessionMessage(decodeBytes(pending.transcriptDigest, 32), challengeSecret))));
  let labelCiphertext: string | undefined;
  if (pending.label) {
    const writer = await createSymmetricWriter(vaultRootKey);
    labelCiphertext = encodeBytes(await writer.seal(new TextEncoder().encode(pending.label), {
      purpose: "device-label", vaultId: expected.accountId,
      objectId: expected.deviceId, keyId: expected.deviceId, keyEpoch: 1, revision: 1,
    }));
  }
  const committed = await authPost<{ ok: true; registryEpoch: number }>(
    "/api/device-enrollment/commit", {
      enrollmentId: pending.enrollmentId, transcript: expected,
      transcriptDigest: pending.transcriptDigest, approval,
      approvalSignature: response.approvalSignature,
      enrollmentEnvelope: response.enrollmentEnvelope,
      challengeSecret: encodeBytes(challengeSecret), challengeSignature,
      ...(labelCiphertext ? { labelCiphertext } : {}),
    }, signal, "failed");
  if (!committed.ok || !Number.isSafeInteger(committed.registryEpoch)) throw new Error("Enrollment failed");
  await activateEnrollmentCandidate(expected.accountId, expected.deviceId, committed.registryEpoch);
  sessionStorage.removeItem(PENDING_KEY);
  return "committed";
}

/** QR bytes stay in this browser. Only the enrollment ID and the approved public transcript reach D1. */
export async function approveFromPairingLink(pairingLink: string, signal: AbortSignal): Promise<void> {
  const url = new URL(pairingLink);
  if (url.origin !== location.origin || url.pathname !== "/enroll-device/approve" || !url.hash) {
    throw new Error("Invalid pairing link");
  }
  const qr = parseQrPayload(url.hash.slice(1));
  if (qr.expiresAt <= Date.now() ||
      !same(await sha256(qr.pairingSecret), decodeBytes(qr.transcript.pairingSecretHash, 32)) ||
      !same(await sha256(candidateTranscriptMessage(qr.transcript)), decodeBytes(qr.transcriptDigest, 32))) {
    throw new Error("Invalid pairing link");
  }
  const pendingResponse = await privateRequest("/api/device-enrollment/pending", {
    method: "POST", body: JSON.stringify({ enrollmentId: qr.enrollmentId }), signal,
  });
  if (!pendingResponse.ok) throw new Error("Enrollment unavailable");
  const pending = await pendingResponse.json() as { enrollmentId: string; expiresAt: number;
    transcript: CandidateTranscript; transcriptDigest: string; pairingSecretHash: string };
  if (pending.enrollmentId !== qr.enrollmentId || pending.expiresAt !== qr.expiresAt ||
      pending.transcriptDigest !== qr.transcriptDigest ||
      pending.pairingSecretHash !== qr.transcript.pairingSecretHash ||
      !same(candidateTranscriptMessage(pending.transcript), candidateTranscriptMessage(qr.transcript))) {
    throw new Error("Enrollment changed");
  }
  await confirmFreshPasskey(signal);
  const state = await authGet<DeviceState>("/api/device/state", signal);
  if (state.accountId !== qr.transcript.accountId || state.registryEpoch !== qr.transcript.registryEpoch ||
      !state.deviceId) throw new Error("Device unavailable");
  const approver = await getDevice(state.accountId);
  if (!approver || approver.deviceId !== state.deviceId) throw new Error("Device keys unavailable");
  const bootstrapResponse = await privateRequest("/api/private/bootstrap", { method: "POST", signal });
  if (!bootstrapResponse.ok) throw new Error("Files unavailable");
  const bootstrap = await bootstrapResponse.json() as { enrollmentEnvelope: string };
  const vaultRootKey = await openDeviceEnrollmentEnvelope(decodeBytes(bootstrap.enrollmentEnvelope),
    approver.transportKeyPair, {
      purpose: "device-enrollment", vaultId: state.accountId,
      objectId: state.deviceId, keyId: state.deviceId,
      keyEpoch: 1, revision: 1, recipientId: state.deviceId,
    });
  const candidatePublicKey = await crypto.subtle.importKey("raw",
    decodeBytes(qr.transcript.transportPublicKey, 65),
    { name: "ECDH", namedCurve: "P-256" }, true, []);
  const envelope = await sealDeviceEnrollmentEnvelope(vaultRootKey, candidatePublicKey, {
    purpose: "device-enrollment", vaultId: state.accountId,
    objectId: qr.transcript.deviceId, keyId: qr.transcript.deviceId,
    keyEpoch: 1, revision: 1, recipientId: qr.transcript.deviceId,
  });
  const approval: EnrollmentApproval = { ...qr.transcript,
    enrollmentId: qr.enrollmentId, transcriptDigest: qr.transcriptDigest,
    envelopeDigest: encodeBytes(await digestEnvelope(envelope)),
    approvingDeviceId: state.deviceId, expiresAt: qr.expiresAt };
  const approvalSignature = encodeBytes(new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, approver.assertionKeyPair.privateKey,
    approvalMessage(approval))));
  const approved = await privateRequest("/api/device-enrollment/approve", {
    method: "POST", body: JSON.stringify({ enrollmentId: qr.enrollmentId, approval,
      approvalSignature, enrollmentEnvelope: encodeBytes(envelope) }), signal,
  });
  if (!approved.ok) throw new Error("Enrollment unavailable");
}
