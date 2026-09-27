import { createSymmetricWriter, digestEnvelope, EnvelopeError, openSymmetric } from "~/crypto/enc-v1";
import { decodeTreeBytes, encodeTreeBytes } from "./wire";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const MAX_LISTING_BYTES = 524_288;

export type SealedEntry = {
  nodeId: string; kind: "directory" | "file";
  nameCiphertext: string; orderCiphertext: string; keyEnvelope: string;
};
export type ListingHead = { ciphertext: string; digest: string; signature: string };
export type StoredListingHead = ListingHead & { signerDeviceId: string; signerPublicKey: Uint8Array };

async function digestBytes(bytes: Uint8Array): Promise<string> {
  return encodeTreeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))));
}

/** Canonical member commitment. The encrypted listing contains no display or ordering plaintext. */
async function members(entries: readonly SealedEntry[]): Promise<string> {
  const sorted = entries.slice().sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0);
  if (sorted.some((entry, index) => index && entry.nodeId === sorted[index - 1]?.nodeId)) {
    throw new EnvelopeError("replayed-manifest");
  }
  const committed = await Promise.all(sorted.map(async (entry) => [entry.nodeId,
    await digestBytes(encoder.encode(JSON.stringify([
      entry.kind, entry.nameCiphertext, entry.orderCiphertext, entry.keyEnvelope,
    ])))]));
  return JSON.stringify(committed);
}

function signatureMessage(vaultId: string, directoryId: string, deviceId: string, revision: number, digest: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(JSON.stringify(["mdwn/directory-listing/v1", vaultId, directoryId, deviceId, revision, digest])));
}

export async function createListingHead(parentKey: Uint8Array, assertionKey: CryptoKey, options: {
  vaultId: string; directoryId: string; deviceId: string; revision: number; entries: readonly SealedEntry[];
}): Promise<ListingHead> {
  if (!Number.isSafeInteger(options.revision) || options.revision < 2 ||
      !assertionKey || assertionKey.type !== "private" || assertionKey.extractable ||
      assertionKey.algorithm.name !== "ECDSA") throw new EnvelopeError("malformed");
  const writer = await createSymmetricWriter(parentKey);
  const ciphertext = await writer.seal(encoder.encode(await members(options.entries)), {
    purpose: "directory-metadata", vaultId: options.vaultId,
    objectId: options.directoryId, keyId: options.directoryId, keyEpoch: 1, revision: options.revision,
  });
  if (ciphertext.length > MAX_LISTING_BYTES) throw new EnvelopeError("malformed");
  const digest = encodeTreeBytes(await digestEnvelope(ciphertext));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" },
    assertionKey, signatureMessage(options.vaultId, options.directoryId, options.deviceId, options.revision, digest)));
  return { ciphertext: encodeTreeBytes(ciphertext), digest, signature: encodeTreeBytes(signature) };
}

export async function verifyListingSignature(head: ListingHead, values: {
  vaultId: string; directoryId: string; deviceId: string; revision: number; publicKey: Uint8Array;
}): Promise<boolean> {
  try {
    const digest = decodeTreeBytes(head.digest, 32);
    const signature = decodeTreeBytes(head.signature, 64);
    if (digest.length !== 32 || signature.length !== 64 ||
        !(values.publicKey instanceof Uint8Array) || values.publicKey.length !== 65) return false;
    const signer = await crypto.subtle.importKey("raw", new Uint8Array(values.publicKey),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, signer, signature,
      signatureMessage(values.vaultId, values.directoryId, values.deviceId, values.revision, head.digest));
  } catch { return false; }
}

/** The trusted digest is established by a verified device signature, never the envelope header. */
export async function openListingHead(parentKey: Uint8Array, options: {
  vaultId: string; directoryId: string; revision: number;
  entries: readonly SealedEntry[]; head: StoredListingHead;
}): Promise<void> {
  try {
    const { head, vaultId, directoryId, revision, entries } = options;
    const digest = decodeTreeBytes(head.digest, 32);
    if (digest.length !== 32 || !await verifyListingSignature(head, {
      vaultId, directoryId, deviceId: head.signerDeviceId, revision, publicKey: head.signerPublicKey,
    })) throw new EnvelopeError("replayed-manifest");
    const plaintext = await openSymmetric(decodeTreeBytes(head.ciphertext, MAX_LISTING_BYTES), parentKey, {
      context: { purpose: "directory-metadata", vaultId, objectId: directoryId, keyId: directoryId,
        keyEpoch: 1, revision }, manifestDigest: digest,
    });
    if (decoder.decode(plaintext) !== await members(entries)) throw new EnvelopeError("replayed-manifest");
  } catch { throw new EnvelopeError("replayed-manifest"); }
}
