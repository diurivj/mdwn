import { inspectEnvelope, type EnvelopePurpose } from "~/shared/crypto/enc-v1";

export const MAX_REPRESENTATION_BYTES = 524_288;
const MAX_ENTRY_BYTES = 4_096;

/** Binary-only wire format: canonical unpadded base64url, never a name token. */
export function encodeTreeBytes(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_REPRESENTATION_BYTES) throw new Error("invalid ciphertext");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeTreeBytes(value: unknown, max = MAX_ENTRY_BYTES): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > Math.ceil((max * 4) / 3) + 2 ||
    !/^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/.test(value)
  )
    throw new Error("invalid ciphertext");
  const decoded = Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4)),
    (character) => character.charCodeAt(0),
  );
  if (decoded.length > max || encodeTreeBytes(decoded) !== value) throw new Error("invalid ciphertext");
  return decoded;
}

/** Header inspection is structural only; the browser authenticates ciphertext with its capability. */
export function treeEnvelope(
  value: unknown,
  max: number,
  expected: {
    purpose: EnvelopePurpose;
    vaultId: string;
    objectId: string;
    keyId: string;
    revision: number;
    keyEpoch: number;
  },
): Uint8Array<ArrayBuffer> {
  const bytes = decodeTreeBytes(value, max);
  const header = inspectEnvelope(bytes);
  if (
    header.suite !== "AES-256-GCM/HKDF-SHA-256" ||
    header.context.purpose !== expected.purpose ||
    header.context.vaultId !== expected.vaultId ||
    header.context.objectId !== expected.objectId ||
    header.context.keyId !== expected.keyId ||
    header.context.revision !== expected.revision ||
    header.context.keyEpoch !== expected.keyEpoch ||
    Object.hasOwn(header.context, "recipientId") ||
    Object.hasOwn(header.context, "publicationId")
  ) {
    throw new Error("invalid ciphertext");
  }
  return bytes;
}

export function isV7(value: unknown): value is string {
  return (
    typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}
