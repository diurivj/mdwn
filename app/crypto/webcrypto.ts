import { toBytes, type ByteSource } from "./encoding";

export function getSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto API is unavailable");
  return subtle;
}

export function asArrayBuffer(value: ByteSource): ArrayBuffer {
  return toBytes(value).slice().buffer as ArrayBuffer;
}

export function isCryptoKey(value: unknown): value is CryptoKey {
  return (
    typeof value === "object" &&
    value !== null &&
    "algorithm" in value &&
    "extractable" in value &&
    "type" in value &&
    "usages" in value
  );
}

export function isCryptoKeyPair(value: unknown): value is CryptoKeyPair {
  return (
    typeof value === "object" &&
    value !== null &&
    "publicKey" in value &&
    "privateKey" in value &&
    isCryptoKey(value.publicKey) &&
    isCryptoKey(value.privateKey)
  );
}
