import { openDeviceEnrollmentEnvelope } from "~/crypto/vault";
import { privateRequest } from "~/device/private-client";
import { getDevice } from "~/device/store";
import { decodeTreeBytes } from "~/tree/wire";

/**
 * Browser-held device and Vault-root material for resumable Account jobs
 * (Key rotation and the Public-pseudonym update). A job driver adds its own
 * proof-bound `request`; this module never sends plaintext anywhere.
 */

export type PrivateBrowser = {
  accountId: string; deviceId: string; vaultRootKey: Uint8Array<ArrayBuffer>;
  assertionKey: CryptoKey; transportKeyPair: CryptoKeyPair;
};

/** Production adapter: device handles and Vault keys are loaded only in the browser. */
export async function loadPrivateBrowser(signal?: AbortSignal): Promise<PrivateBrowser> {
  const stateResponse = await fetch("/api/device/state", { cache: "no-store", signal });
  if (!stateResponse.ok) throw new Error("Device state unavailable");
  const state = await stateResponse.json() as { accountId: string; deviceId: string };
  const device = await getDevice(state.accountId);
  if (!device || device.deviceId !== state.deviceId) throw new Error("An enrolled device is required");
  const response = await privateRequest("/api/private/bootstrap", { method: "POST", signal });
  if (!response.ok) throw new Error("Private access unavailable");
  const boot = await response.json() as { enrollmentEnvelope: string };
  const vaultRootKey = await openDeviceEnrollmentEnvelope(decodeTreeBytes(boot.enrollmentEnvelope, 16_384),
    device.transportKeyPair, { purpose: "device-enrollment", vaultId: state.accountId, objectId: state.deviceId,
      keyId: state.deviceId, keyEpoch: 1, revision: 1, recipientId: state.deviceId });
  return { accountId: state.accountId, deviceId: state.deviceId, vaultRootKey,
    assertionKey: device.assertionKeyPair.privateKey, transportKeyPair: device.transportKeyPair };
}
