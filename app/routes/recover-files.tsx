import { Link, useFetcher } from "react-router";

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
import { nextRecoveryMetadataDigest, possessionMessage, recoveryIntentMessage, sha256, type NextRecoveryMetadata, type RecoveryIntent } from "~/recovery/protocol";
import { resumeRecoveryProvisioning } from "~/recovery/provision-client";
import { newSignupId } from "~/signup/bootstrap";
import { decodeBytes, encodeBytes } from "~/signup/protocol";

import type { Route } from "./+types/recover-files";

type Start = {
  enrollmentId: string; accountId: string; generation: number; registryEpoch: number;
  nonce: string; recoverySalt: string; capsule: string; verificationPublicKey: string;
};
type Loaded = { state: "ready" | "signed-out" | "restricted" | "failed"; phrase?: string; restoring?: boolean };
const PHRASE_KEY = "mdwn:pending-recovery-phrase";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Recover your Files — mdwn" }];
}

/** Repair a committed cutover whose response or browser activation was interrupted. */
export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<Loaded> {
  try {
    const { identifier: accountId } = await authGet<{ identifier: string }>(
      "/api/auth/recovery/identifier", request.signal);
    for (const pending of await listRecoveryCandidates(accountId)) {
      const state = await authGet<{ candidateActive: boolean; registryEpoch: number }>(
        `/api/device/state?candidateDeviceId=${pending.deviceId}`, request.signal);
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
      try { restoring = !await resumeRecoveryProvisioning(request.signal); }
      catch { restoring = true; }
    }
    return { state: "ready", ...(parsed?.accountId === accountId &&
      parsed.deviceId === device?.deviceId && typeof parsed.phrase === "string"
      ? { phrase: parsed.phrase } : {}), restoring };
  } catch (error) { return { state: authFailure(error, request.signal) }; }
}

export function HydrateFallback() {
  return <main className="mx-auto max-w-xl px-4 py-12"><h1 className="text-2xl font-semibold">Preparing recovery…</h1></main>;
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  let committedPhrase: string | null = null;
  let commitSubmitted = false;
  try {
    const form = await request.formData();
    const phrase = form.get("phrase");
    if (typeof phrase !== "string" || !phrase.trim()) return { state: "failed" } as const;
    await confirmFreshPasskey(request.signal);
    const start = await authPost<Start>("/api/vault-recovery/start", {}, request.signal, "failed");
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
    const candidate = await createRecoveryCandidate(start.accountId, newSignupId());
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
    const challenge = await authPost<{ challenge: string }>("/api/vault-recovery/challenge",
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
      "/api/vault-recovery/commit", {
        enrollmentId: start.enrollmentId, intent, intentSignature,
        challengeSecret: encodeBytes(secret), challengeSignature,
        nextMetadata: metadata, nextCapsule: encodeBytes(next.record.capsule),
        enrollmentEnvelope: encodeBytes(enrollmentEnvelope),
      }, request.signal, "failed");
    if (committed.ok !== true || !Number.isSafeInteger(committed.registryEpoch)) throw new Error("Recovery failed");
    committedPhrase = next.phrase;
    try {
      await activateRecoveryCandidate(start.accountId, candidate.deviceId, committed.registryEpoch);
      const finished = await resumeRecoveryProvisioning(request.signal);
      return { state: "success", phrase: next.phrase, restoring: !finished } as const;
    } catch { /* The committed device can resume from the pending record or normal private access. */ }
    return { state: "success", phrase: next.phrase, restoring: true } as const;
  } catch (error) {
    if (committedPhrase) return { state: "success", phrase: committedPhrase, restoring: true } as const;
    if (commitSubmitted) return { state: "uncertain" } as const;
    return { state: authFailure(error, request.signal) } as const;
  }
}

export default function RecoverFiles({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof clientAction>();
  const busy = fetcher.state !== "idle";
  const phrase = fetcher.data?.state === "success" ? fetcher.data.phrase : loaderData.phrase;
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <Link to="/" className="text-sm underline">mdwn</Link>
      <h1 className="mt-8 text-2xl font-semibold">Recover your Files</h1>
      {loaderData.state === "signed-out" ? (
        <p className="mt-4"><Link to="/sign-in" className="underline">Sign in with a passkey</Link> first.</p>
      ) : loaderData.state === "restricted" ? (
        <p className="mt-4">Finish replacing your passkey, then sign in with it before recovering your Files.</p>
      ) : loaderData.state === "failed" ? (
        <p className="mt-4">Recovery is unavailable. Please try again.</p>
      ) : (
        <>
          <p className="mt-4 text-stone-600">Confirm with a passkey and enter your current 24-word Files recovery phrase. Your phrase stays in this browser. Recovery replaces every previous Encryption device and signs out other Sessions.</p>
          {!phrase && <fetcher.Form method="post" className="mt-6 space-y-4">
            <label className="block text-sm font-medium" htmlFor="phrase">Current recovery phrase</label>
            <textarea id="phrase" name="phrase" required autoComplete="off" spellCheck={false}
              className="min-h-28 w-full rounded-md border border-stone-300 p-3 font-mono text-sm" />
            <button type="submit" disabled={busy}
              className="rounded-md bg-stone-900 px-4 py-2 text-white disabled:opacity-60">Recover Files</button>
          </fetcher.Form>}
          {busy && <p role="status" className="mt-4">Restoring your Files securely…</p>}
          {!busy && fetcher.data?.state === "failed" &&
            <p role="alert" className="mt-4 text-red-700">Recovery could not be completed. Start again with your current phrase.</p>}
          {!busy && fetcher.data?.state === "uncertain" &&
            <p role="alert" className="mt-4 text-amber-800">We could not confirm the result. <Link to="/sign-in" className="underline">Sign in with a passkey</Link> to check whether this device was activated before starting again.</p>}
          {phrase && <section className="mt-6 rounded-md border border-amber-300 bg-amber-50 p-4" role="status">
            <h2 className="font-semibold">Save your new recovery phrase</h2>
            <p className="mt-2 text-sm">Your previous phrase no longer works. Keep these 24 words offline.</p>
            <p className="mt-3 break-words font-mono">{phrase}</p>
            <button type="button" className="mt-4 underline" onClick={() => sessionStorage.removeItem(PHRASE_KEY)}>
              I saved this phrase
            </button>
          </section>}
          {fetcher.data?.state === "success" && fetcher.data.restoring &&
            <p role="status" className="mt-4">Restoring your Files securely…</p>}
          {loaderData.restoring && fetcher.data?.state !== "success" &&
            <p role="status" className="mt-4">Restoring your Files securely…</p>}
          {phrase && <Link to="/account/device-access" className="mt-4 inline-block underline">Open your Files</Link>}
        </>
      )}
    </main>
  );
}
