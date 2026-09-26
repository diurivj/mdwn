import {
  openDeviceEnrollmentEnvelope, openOwnedDeviceEnvelope,
  openVaultRecoveryEnvelope, sealOwnedDeviceEnvelope,
} from "~/crypto/vault";
import { privateRequest } from "~/device/private-client";
import { getDevice } from "~/device/store";
import { decodeBytes, encodeBytes } from "~/signup/protocol";

type Next = {
  state: "pending" | "complete";
  kind?: "recovery_owned" | "enrollment_owned";
  cursor?: string | null;
  item: { objectId: string; envelope: string; keyEpoch: number } | null;
};

/** Read the private job state without advancing its cursor during route loading. */
export async function ownedProvisioningNeeded(signal?: AbortSignal): Promise<boolean> {
  return (await ownedProvisioningKind(signal)) !== null;
}

export async function ownedProvisioningKind(signal?: AbortSignal): Promise<"recovery" | "enrollment" | null> {
  const response = await privateRequest("/api/private/recovery-provision/next", { method: "POST", signal });
  if (!response.ok) throw new Error("Owned provisioning job unavailable");
  const next = await response.json() as Next;
  return next.state === "pending" ? next.kind === "enrollment_owned" ? "enrollment" : "recovery" : null;
}

/** Each request handles one opaque owned key; a later visit safely resumes the cursor. */
export async function resumeOwnedProvisioning(signal?: AbortSignal, maxSteps = 20): Promise<boolean> {
  const stateResponse = await fetch("/api/device/state", { cache: "no-store", signal });
  if (!stateResponse.ok) throw new Error("Device state unavailable");
  const state = await stateResponse.json() as { accountId: string; deviceId: string | null };
  if (!state.deviceId) throw new Error("Device unavailable");
  const device = await getDevice(state.accountId);
  if (!device || device.deviceId !== state.deviceId) throw new Error("Device keys unavailable");
  const bootstrapResponse = await privateRequest("/api/private/bootstrap", { method: "POST", signal });
  if (!bootstrapResponse.ok) throw new Error("Private access unavailable");
  const bootstrap = await bootstrapResponse.json() as {
    rootDirectoryId: string; rootRecoveryEnvelope: string; enrollmentEnvelope: string;
  };
  const vaultRootKey = await openDeviceEnrollmentEnvelope(decodeBytes(bootstrap.enrollmentEnvelope),
    device.transportKeyPair, {
      purpose: "device-enrollment", vaultId: state.accountId,
      objectId: state.deviceId, keyId: state.deviceId,
      keyEpoch: 1, revision: 1, recipientId: state.deviceId,
    });
  for (let step = 0; step < maxSteps; step++) {
    const response = await privateRequest("/api/private/recovery-provision/next", { method: "POST", signal });
    if (!response.ok) throw new Error("Owned provisioning job unavailable");
    const next = await response.json() as Next;
    if (next.state === "complete") return true;
    if (!next.item) {
      const body = JSON.stringify({ operation: "finish" });
      const finished = await privateRequest("/api/private/recovery-provision/step",
        { method: "PATCH", body, signal });
      if (!finished.ok) throw new Error("Owned provisioning job changed");
      return true;
    }
    // v1 owned recovery sources bind keyId to objectId and epoch/revision to 1.
    // The proof-guarded current D1 row supplies objectId; never adopt header
    // metadata as the expected context. Bootstrap also pins the root source.
    if (next.item.keyEpoch !== 1 ||
        (next.item.objectId === bootstrap.rootDirectoryId &&
          next.item.envelope !== bootstrap.rootRecoveryEnvelope)) throw new Error("Invalid owned envelope");
    const source = decodeBytes(next.item.envelope);
    const sourceContext = {
      purpose: "vault-recovery" as const, vaultId: state.accountId,
      objectId: next.item.objectId, keyId: next.item.objectId,
      keyEpoch: 1, revision: 1,
    };
    const capability = await openVaultRecoveryEnvelope(source, vaultRootKey, sourceContext);
    const context = {
      purpose: "owned-device" as const, vaultId: state.accountId,
      objectId: next.item.objectId, keyId: next.item.objectId,
      keyEpoch: 1, revision: 1, recipientId: state.deviceId,
    };
    const wrapped = await sealOwnedDeviceEnvelope({
      key: capability, objectId: next.item.objectId,
      keyId: next.item.objectId, scope: "owned",
    }, device.transportKeyPair.publicKey, context);
    const opened = await openOwnedDeviceEnvelope(wrapped, device.transportKeyPair, context);
    if (!opened.every((byte, index) => byte === capability[index])) throw new Error("Owned envelope failed");
    const body = JSON.stringify({ operation: "step", cursor: next.cursor ?? null,
      objectId: next.item.objectId, envelope: encodeBytes(wrapped) });
    const updated = await privateRequest("/api/private/recovery-provision/step",
      { method: "PATCH", body, signal });
    if (!updated.ok) throw new Error("Owned provisioning job changed");
  }
  return false;
}

/** Keep scheduling bounded passes while the page is open; an interrupted visit resumes from the job cursor. */
export async function finishOwnedProvisioning(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      if (await resumeOwnedProvisioning(signal)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } catch {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    }
  }
}
