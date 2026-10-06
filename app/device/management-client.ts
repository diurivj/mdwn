import { confirmFreshPasskey } from "~/auth/fresh-client";
import { openSymmetric } from "~/shared/crypto/enc-v1";
import { openDeviceEnrollmentEnvelope } from "~/shared/crypto/vault";
import { decodeBytes, encodeBytes } from "~/shared/signup/protocol";

import { privateRequest, PrivateAccessError } from "../shared/device/private-client";
import { getDevice } from "../shared/device/store";

export type ListedDevice = {
  id: string; label: string; labelCiphertext: string | null;
  state: "active" | "revoked" | "tombstoned"; createdAt: number; lastUseAt: number | null;
};
export type DeviceInventory = {
  registryEpoch: number; currentDeviceId: string; devices: ListedDevice[];
};
type InventoryResponse = {
  accountId: string; registryEpoch: number; currentDeviceId: string;
  devices: Array<Omit<ListedDevice, "label">>;
};

export class DeviceListChangedError extends Error {
  constructor() { super("Device inventory changed"); }
}

/** Only the browser can open labels; do not SSR or send the result to an action. */
export async function loadDeviceInventory(signal: AbortSignal): Promise<DeviceInventory> {
  const inventoryResponse = await privateRequest("/api/private/devices/inventory", { method: "POST", signal });
  if (!inventoryResponse.ok) throw new PrivateAccessError("unavailable");
  const inventory = await inventoryResponse.json() as InventoryResponse;
  const device = await getDevice(inventory.accountId);
  if (!device || device.deviceId !== inventory.currentDeviceId ||
      device.registryEpoch !== inventory.registryEpoch) throw new PrivateAccessError("device-lost");
  const bootstrapResponse = await privateRequest("/api/private/bootstrap", { method: "POST", signal });
  if (!bootstrapResponse.ok) throw new PrivateAccessError("unavailable");
  // A membership change between the two reads cannot authorize stale labels.
  const updatedDevice = await getDevice(inventory.accountId);
  if (!updatedDevice || updatedDevice.deviceId !== device.deviceId ||
      updatedDevice.registryEpoch !== inventory.registryEpoch) throw new DeviceListChangedError();
  const bootstrap = await bootstrapResponse.json() as { enrollmentEnvelope: string };
  const root = await openDeviceEnrollmentEnvelope(decodeBytes(bootstrap.enrollmentEnvelope),
    updatedDevice.transportKeyPair, {
      purpose: "device-enrollment", vaultId: inventory.accountId,
      objectId: inventory.currentDeviceId, keyId: inventory.currentDeviceId,
      keyEpoch: 1, revision: 1, recipientId: inventory.currentDeviceId,
    });
  const devices = await Promise.all(inventory.devices.map(async (item) => {
    if (!item.labelCiphertext) return { ...item, label: "Unlabelled device" };
    const plain = await openSymmetric(decodeBytes(item.labelCiphertext), root, {
      context: { purpose: "device-label", vaultId: inventory.accountId,
        objectId: item.id, keyId: item.id, keyEpoch: 1, revision: 1 },
    });
    const label = new TextDecoder("utf-8", { fatal: true }).decode(plain);
    if (!label || label.length > 256) throw new PrivateAccessError("unavailable");
    return { ...item, label };
  }));
  return { registryEpoch: inventory.registryEpoch, currentDeviceId: inventory.currentDeviceId, devices };
}

/** Compare the just-decrypted label and registry before *and* after fresh Passkey authentication. */
export async function removeListedDevice(inventory: DeviceInventory, target: ListedDevice,
  typedLabel: string, signal: AbortSignal): Promise<void> {
  if (target.id === inventory.currentDeviceId || target.state !== "active" ||
      inventory.devices.filter((item) => item.state === "active").length < 2 || typedLabel !== target.label) {
    throw new DeviceListChangedError();
  }
  await confirmFreshPasskey(signal);
  const current = await loadDeviceInventory(signal);
  const liveTarget = current.devices.find((item) => item.id === target.id);
  if (current.registryEpoch !== inventory.registryEpoch ||
      current.currentDeviceId !== inventory.currentDeviceId ||
      liveTarget?.state !== "active" || liveTarget.labelCiphertext !== target.labelCiphertext ||
      liveTarget.label !== typedLabel) throw new DeviceListChangedError();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(target.labelCiphertext ?? "")));
  const body = JSON.stringify({ targetDeviceId: target.id, expectedEpoch: inventory.registryEpoch,
    labelDigest: encodeBytes(digest), confirmation: "remove-device" });
  const response = await privateRequest("/api/private/devices/remove", { method: "POST", body, signal });
  if (response.status === 409) throw new DeviceListChangedError();
  if (!response.ok) throw new PrivateAccessError("denied");
}
