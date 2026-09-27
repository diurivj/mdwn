import { createSymmetricWriter, inspectEnvelope, openForRecipient, openSymmetric, sealToRecipient } from "~/crypto/enc-v1";
import { canonicalizeSegment } from "~/namespace-v1";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const MAX_SHARE_LABEL_BYTES = 4096;
const VERSION = "mdwn/share-root-label/namespace-v1";

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
  const value: unknown = JSON.parse(decoder.decode(bytes));
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== VERSION ||
      typeof value[1] !== "string" || canonicalizeSegment(value[1]).display !== value[1] ||
      JSON.stringify(value) !== decoder.decode(bytes)) throw new Error("invalid shared label");
  return value[1];
}

export async function sealShareLabel(name: string, ownerId: string, targetId: string, labelId: string,
  devices: readonly { deviceId: string; publicKey: CryptoKey }[], vaultRoot: Uint8Array) {
  const plaintext = encodeShareLabel(name);
  const writer = await createSymmetricWriter(vaultRoot);
  const ownerCopy = await writer.seal(plaintext, context(ownerId, targetId, labelId));
  const deliveries = await Promise.all(devices.map(async ({ deviceId, publicKey }) => ({ deviceId,
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
