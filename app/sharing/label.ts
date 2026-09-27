import { createSymmetricWriter, inspectEnvelope, openForRecipient, openSymmetric, sealToRecipient } from "../crypto/enc-v1";
import { canonicalizeSegment } from "../namespace-v1";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const MAX_SHARE_LABEL_BYTES = 4096;
const VERSION = "mdwn/share-root-label/namespace-v1";
const opaqueId = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validIds(...ids: string[]): boolean {
  return ids.every((id) => typeof id === "string" && opaqueId.test(id));
}

function context(ownerId: string, targetId: string, labelId: string, recipientId?: string) {
  return { purpose: "share-root-label" as const, vaultId: ownerId, objectId: targetId,
    keyId: labelId, keyEpoch: 1, revision: 1, ...(recipientId ? { recipientId } : {}) };
}

/** A snapshot name, not a content key. No parent, path or current File revision is encoded. */
export function encodeShareLabel(name: string): Uint8Array {
  const segment = canonicalizeSegment(name).display;
  const bytes = encoder.encode(JSON.stringify([VERSION, segment]));
  if (bytes.length > MAX_SHARE_LABEL_BYTES - 256) throw new Error("invalid shared label");
  return bytes;
}

function decodeLabel(bytes: Uint8Array): string {
  if (bytes.length > MAX_SHARE_LABEL_BYTES) throw new Error("invalid shared label");
  const text = decoder.decode(bytes);
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== VERSION ||
      typeof value[1] !== "string" || canonicalizeSegment(value[1]).display !== value[1] ||
      JSON.stringify(value) !== text) throw new Error("invalid shared label");
  return value[1];
}

export async function sealShareLabel(name: string, ownerId: string, targetId: string, labelId: string,
  devices: readonly { deviceId: string; publicKey: CryptoKey }[], vaultRoot: Uint8Array) {
  if (!validIds(ownerId, targetId, labelId) || !Array.isArray(devices) || devices.length > 256 ||
      !(vaultRoot instanceof Uint8Array) || vaultRoot.length !== 32) throw new Error("invalid shared label");
  // Validate and snapshot the complete recipient set before any writer/HPKE await.
  // CryptoKey handles are immutable, but the array and each descriptor are not.
  const recipients = devices.map((device) => {
    if (!device || !validIds(device.deviceId) || !device.publicKey ||
        device.publicKey.type !== "public" || device.publicKey.algorithm?.name !== "ECDH" ||
        !("namedCurve" in device.publicKey.algorithm) || device.publicKey.algorithm.namedCurve !== "P-256") {
      throw new Error("invalid shared label");
    }
    return { deviceId: device.deviceId, publicKey: device.publicKey };
  });
  if (new Set(recipients.map((d) => d.deviceId)).size !== recipients.length) throw new Error("invalid shared label");
  const root = new Uint8Array(vaultRoot);
  const plaintext = encodeShareLabel(name);
  const ownerContext = context(ownerId, targetId, labelId);
  const writer = await createSymmetricWriter(root);
  const ownerCopy = await writer.seal(plaintext, ownerContext);
  const deliveries = await Promise.all(recipients.map(async ({ deviceId, publicKey }) => ({ deviceId,
    envelope: await sealToRecipient(plaintext, publicKey, context(ownerId, targetId, labelId, deviceId)),
  })));
  if (ownerCopy.length > MAX_SHARE_LABEL_BYTES || deliveries.some((d) => d.envelope.length > MAX_SHARE_LABEL_BYTES)) {
    throw new Error("invalid shared label");
  }
  return { ownerCopy, deliveries };
}

export async function openShareLabel(envelope: Uint8Array, keyPair: CryptoKeyPair,
  ownerId: string, targetId: string, labelId: string, deviceId: string): Promise<string> {
  if (envelope.length > MAX_SHARE_LABEL_BYTES || inspectEnvelope(envelope).suite !== "HPKE-P256/HKDF-SHA-256/AES-256-GCM") {
    throw new Error("invalid shared label");
  }
  return decodeLabel(await openForRecipient(envelope, keyPair,
    { context: context(ownerId, targetId, labelId, deviceId) }));
}

export async function openOwnedShareLabel(envelope: Uint8Array, vaultRoot: Uint8Array,
  ownerId: string, targetId: string, labelId: string): Promise<string> {
  if (envelope.length > MAX_SHARE_LABEL_BYTES) throw new Error("invalid shared label");
  return decodeLabel(await openSymmetric(envelope, vaultRoot, { context: context(ownerId, targetId, labelId) }));
}
