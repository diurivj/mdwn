import { record } from "~/auth/request.server";
import { decodeTreeBytes, isV7 } from "~/shared/tree/wire";

type DeviceEnvelope = {
  deviceId: string; ciphertext: string; signature: string;
  bytes: { ciphertext: Uint8Array<ArrayBuffer>; signature: Uint8Array<ArrayBuffer> };
};
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const positiveEpoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Shared bounded wire packet only. Each caller still verifies its own signed
 * purpose/context and commits under live scope, registry and device guards.
 */
export function readDeviceEnvelopePacket(value: unknown) {
  const input = record(value);
  if (!input || !exact(input, ["capabilityId", "capabilityEpoch", "ownerRegistryEpoch", "recipientRegistryEpoch", "envelopes"])) return null;
  const { capabilityId, capabilityEpoch, ownerRegistryEpoch, recipientRegistryEpoch } = input;
  if (!isV7(capabilityId) || !positiveEpoch(capabilityEpoch) || !positiveEpoch(ownerRegistryEpoch) ||
      !positiveEpoch(recipientRegistryEpoch) || !Array.isArray(input.envelopes) ||
      input.envelopes.length < 1 || input.envelopes.length > 20) return null;
  const envelopes: DeviceEnvelope[] = [];
  const seen = new Set<string>();
  try {
    for (const value of input.envelopes) {
      const envelope = record(value);
      if (!envelope || !exact(envelope, ["deviceId", "ciphertext", "signature"])) return null;
      const { deviceId, ciphertext, signature } = envelope;
      if (!isV7(deviceId) || seen.has(deviceId) || typeof ciphertext !== "string" || typeof signature !== "string") return null;
      const bytes = { ciphertext: decodeTreeBytes(ciphertext, 16_384), signature: decodeTreeBytes(signature, 64) };
      if (bytes.signature.length !== 64) return null;
      seen.add(deviceId);
      envelopes.push({ deviceId, ciphertext, signature, bytes });
    }
  } catch { return null; }
  return { capabilityId, capabilityEpoch, ownerRegistryEpoch, recipientRegistryEpoch, envelopes };
}
