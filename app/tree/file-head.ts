import { digestEnvelope } from "~/crypto/enc-v1";
import { decodeTreeBytes, encodeTreeBytes, MAX_REPRESENTATION_BYTES } from "./wire";

export type FileHead = { digest: string; signature: string };
export type FileHeadIdentity = {
  vaultId: string; fileId: string; capabilityId: string; capabilityEpoch: number;
  representationId: string; contentKeyId: string; keyEpoch: number; revision: number;
  deviceId: string; ciphertext: string; keyEnvelope: string;
};

/** Canonical, versioned intent: neither a decrypted key nor a successful MAC
 * alone authorizes a content writer. Bind the stable scope and exact new bytes.
 */
async function message(value: FileHeadIdentity): Promise<Uint8Array<ArrayBuffer>> {
  return new TextEncoder().encode(JSON.stringify([
    "mdwn/file-head/v1", value.vaultId, value.fileId, value.capabilityId, value.capabilityEpoch,
    value.representationId, value.contentKeyId, value.keyEpoch, value.revision, value.deviceId,
    encodeTreeBytes(await digestEnvelope(decodeTreeBytes(value.ciphertext, MAX_REPRESENTATION_BYTES))),
    encodeTreeBytes(await digestEnvelope(decodeTreeBytes(value.keyEnvelope, 16_384))),
  ]));
}

export async function createFileHead(assertionKey: CryptoKey, value: FileHeadIdentity): Promise<FileHead> {
  const bytes = await message(value);
  return { digest: encodeTreeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))),
    signature: encodeTreeBytes(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, assertionKey, bytes))) };
}

export async function verifyFileHead(publicKey: Uint8Array, value: FileHeadIdentity, head: FileHead): Promise<boolean> {
  try {
    const bytes = await message(value), digest = decodeTreeBytes(head.digest, 32), signature = decodeTreeBytes(head.signature, 64);
    const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    if (digest.length !== 32 || signature.length !== 64 || !expected.every((byte, i) => byte === digest[i])) return false;
    const key = await crypto.subtle.importKey("raw", new Uint8Array(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, bytes);
  } catch { return false; }
}
