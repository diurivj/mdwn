import { inspectEnvelope } from "~/crypto/enc-v1";
import {
  openDeviceEnrollmentEnvelope, openOwnedDeviceEnvelope,
  openVaultRecoveryEnvelope, sealOwnedDeviceEnvelope,
} from "~/crypto/vault";
import { privateRequest } from "~/device/private-client";
import { getDevice } from "~/device/store";
import { decodeBytes, encodeBytes } from "~/signup/protocol";

type Next = {
  state: "pending" | "complete";
  cursor?: string | null;
  item: { objectId: string; envelope: string; keyEpoch: number } | null;
};

/** Each request handles one opaque owned key; a later visit safely resumes the cursor. */
export async function resumeRecoveryProvisioning(signal?: AbortSignal, maxSteps = 20): Promise<boolean> {
  const stateResponse = await fetch("/api/device/state", { cache: "no-store", signal });
  if (!stateResponse.ok) throw new Error("Device state unavailable");
  const state = await stateResponse.json() as { accountId: string; deviceId: string | null };
  if (!state.deviceId) throw new Error("Device unavailable");
  const device = await getDevice(state.accountId);
  if (!device || device.deviceId !== state.deviceId) throw new Error("Device keys unavailable");
  const bootstrapResponse = await privateRequest("/api/private/bootstrap", { method: "POST", signal });
  if (!bootstrapResponse.ok) throw new Error("Private access unavailable");
  const bootstrap = await bootstrapResponse.json() as { enrollmentEnvelope: string };
  const vaultRootKey = await openDeviceEnrollmentEnvelope(decodeBytes(bootstrap.enrollmentEnvelope),
    device.transportKeyPair, {
      purpose: "device-enrollment", vaultId: state.accountId,
      objectId: state.deviceId, keyId: state.deviceId,
      keyEpoch: 1, revision: 1, recipientId: state.deviceId,
    });
  for (let step = 0; step < maxSteps; step++) {
    const response = await privateRequest("/api/private/recovery-provision/next", { method: "POST", signal });
    if (!response.ok) throw new Error("Recovery job unavailable");
    const next = await response.json() as Next;
    if (next.state === "complete") return true;
    if (!next.item) {
      const body = JSON.stringify({ operation: "finish" });
      const finished = await privateRequest("/api/private/recovery-provision/step",
        { method: "PATCH", body, signal });
      if (!finished.ok) throw new Error("Recovery job changed");
      return true;
    }
    const source = decodeBytes(next.item.envelope);
    const header = inspectEnvelope(source);
    if (header.context.purpose !== "vault-recovery" || header.context.vaultId !== state.accountId ||
        header.context.objectId !== next.item.objectId ||
        header.context.keyEpoch !== next.item.keyEpoch) throw new Error("Invalid owned envelope");
    const capability = await openVaultRecoveryEnvelope(source, vaultRootKey, header.context);
    const context = {
      purpose: "owned-device" as const, vaultId: state.accountId,
      objectId: next.item.objectId, keyId: header.context.keyId,
      keyEpoch: next.item.keyEpoch, revision: 1, recipientId: state.deviceId,
    };
    const wrapped = await sealOwnedDeviceEnvelope({
      key: capability, objectId: next.item.objectId,
      keyId: header.context.keyId, scope: "owned",
    }, device.transportKeyPair.publicKey, context);
    const opened = await openOwnedDeviceEnvelope(wrapped, device.transportKeyPair, context);
    if (!opened.every((byte, index) => byte === capability[index])) throw new Error("Owned envelope failed");
    const body = JSON.stringify({ operation: "step", cursor: next.cursor ?? null,
      objectId: next.item.objectId, envelope: encodeBytes(wrapped) });
    const updated = await privateRequest("/api/private/recovery-provision/step",
      { method: "PATCH", body, signal });
    if (!updated.ok) throw new Error("Recovery job changed");
  }
  return false;
}
