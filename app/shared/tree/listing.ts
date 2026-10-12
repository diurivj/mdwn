import { createSymmetricWriter, digestEnvelope, EnvelopeError, openSymmetric } from "~/shared/crypto/enc-v1";
import { decodeTreeBytes, encodeTreeBytes } from "./wire";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const MAX_LISTING_BYTES = 524_288;
// Even a one-byte node ID needs 52 bytes per canonical member including its separator.
const MAX_LISTING_MEMBERS = Math.floor(MAX_LISTING_BYTES / 52);

export type SealedEntry = {
  nodeId: string;
  kind: "directory" | "file";
  keyEpoch?: number;
  nameCiphertext: string;
  orderCiphertext: string;
  keyEnvelope: string;
};
export type ListingHead = { ciphertext: string; digest: string; signature: string };
export type StoredListingHead = ListingHead & { signerDeviceId: string; signerPublicKey: Uint8Array };

async function digestBytes(bytes: Uint8Array): Promise<string> {
  return encodeTreeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))));
}

async function memberDigest(entry: SealedEntry): Promise<string> {
  // Preserve the v1 layout: the capability epoch is bound inside its envelope.
  return digestBytes(
    encoder.encode(JSON.stringify([entry.kind, entry.nameCiphertext, entry.orderCiphertext, entry.keyEnvelope])),
  );
}

/** Canonical member commitment. The encrypted listing contains no display or ordering plaintext. */
async function members(entries: readonly SealedEntry[]): Promise<string> {
  if (entries.length > MAX_LISTING_MEMBERS) throw new EnvelopeError("malformed");
  const sorted = entries.slice().sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  if (sorted.some((entry, index) => index && entry.nodeId === sorted[index - 1]?.nodeId)) {
    throw new EnvelopeError("replayed-manifest");
  }
  const committed = await Promise.all(sorted.map(async (entry) => [entry.nodeId, await memberDigest(entry)]));
  return JSON.stringify(committed);
}

function signatureMessage(
  vaultId: string,
  directoryId: string,
  deviceId: string,
  revision: number,
  digest: string,
): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    encoder.encode(JSON.stringify(["mdwn/directory-listing/v1", vaultId, directoryId, deviceId, revision, digest])),
  );
}

export async function createListingHead(
  parentKey: Uint8Array,
  assertionKey: CryptoKey,
  options: {
    vaultId: string;
    directoryId: string;
    deviceId: string;
    keyEpoch?: number;
    revision: number;
    entries: readonly SealedEntry[];
  },
): Promise<ListingHead> {
  const keyEpoch = options.keyEpoch ?? 1;
  if (
    !Number.isSafeInteger(keyEpoch) ||
    keyEpoch < 1 ||
    !Number.isSafeInteger(options.revision) ||
    options.revision < 2 ||
    !assertionKey ||
    assertionKey.type !== "private" ||
    assertionKey.extractable ||
    assertionKey.algorithm.name !== "ECDSA"
  )
    throw new EnvelopeError("malformed");
  const writer = await createSymmetricWriter(parentKey);
  const ciphertext = await writer.seal(encoder.encode(await members(options.entries)), {
    purpose: "directory-metadata",
    vaultId: options.vaultId,
    objectId: options.directoryId,
    keyId: options.directoryId,
    keyEpoch,
    revision: options.revision,
  });
  if (ciphertext.length > MAX_LISTING_BYTES) throw new EnvelopeError("malformed");
  const digest = encodeTreeBytes(await digestEnvelope(ciphertext));
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      assertionKey,
      signatureMessage(options.vaultId, options.directoryId, options.deviceId, options.revision, digest),
    ),
  );
  return { ciphertext: encodeTreeBytes(ciphertext), digest, signature: encodeTreeBytes(signature) };
}

export async function verifyListingSignature(
  head: ListingHead,
  values: {
    vaultId: string;
    directoryId: string;
    deviceId: string;
    revision: number;
    publicKey: Uint8Array;
  },
): Promise<boolean> {
  try {
    const digest = decodeTreeBytes(head.digest, 32);
    const signature = decodeTreeBytes(head.signature, 64);
    if (
      digest.length !== 32 ||
      signature.length !== 64 ||
      !(values.publicKey instanceof Uint8Array) ||
      values.publicKey.length !== 65
    )
      return false;
    const signer = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(values.publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      signer,
      signature,
      signatureMessage(values.vaultId, values.directoryId, values.deviceId, values.revision, head.digest),
    );
  } catch {
    return false;
  }
}

/** Verify the signed head once, then authenticate individually paginated entries against its members. */
export async function openListingMembers(
  parentKey: Uint8Array,
  options: {
    vaultId: string;
    directoryId: string;
    keyEpoch?: number;
    revision: number;
    head: StoredListingHead;
  },
): Promise<Map<string, string>> {
  try {
    const { head, vaultId, directoryId, revision } = options;
    const keyEpoch = options.keyEpoch ?? 1;
    const digest = decodeTreeBytes(head.digest, 32);
    if (
      !Number.isSafeInteger(keyEpoch) ||
      keyEpoch < 1 ||
      !Number.isSafeInteger(revision) ||
      revision < 2 ||
      digest.length !== 32 ||
      !(await verifyListingSignature(head, {
        vaultId,
        directoryId,
        deviceId: head.signerDeviceId,
        revision,
        publicKey: head.signerPublicKey,
      }))
    )
      throw new EnvelopeError("replayed-manifest");
    const plaintext = await openSymmetric(decodeTreeBytes(head.ciphertext, MAX_LISTING_BYTES), parentKey, {
      context: {
        purpose: "directory-metadata",
        vaultId,
        objectId: directoryId,
        keyId: directoryId,
        keyEpoch,
        revision,
      },
      manifestDigest: digest,
    });
    const text = decoder.decode(plaintext);
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length > MAX_LISTING_MEMBERS || JSON.stringify(parsed) !== text) {
      throw new EnvelopeError("replayed-manifest");
    }
    const committed = new Map<string, string>();
    let previous: string | undefined;
    for (const member of parsed) {
      if (
        !Array.isArray(member) ||
        member.length !== 2 ||
        typeof member[0] !== "string" ||
        typeof member[1] !== "string" ||
        !member[0] ||
        encoder.encode(member[0]).length > 256 ||
        decoder.decode(encoder.encode(member[0])) !== member[0] ||
        (previous !== undefined && member[0] <= previous) ||
        decodeTreeBytes(member[1], 32).length !== 32
      ) {
        throw new EnvelopeError("replayed-manifest");
      }
      committed.set(member[0], member[1]);
      previous = member[0];
    }
    return committed;
  } catch {
    throw new EnvelopeError("replayed-manifest");
  }
}

/** A member digest uses exactly the same v1 encoding as complete listing verification. */
export async function assertListingMember(entry: SealedEntry, committed: ReadonlyMap<string, string>): Promise<void> {
  try {
    if (committed.get(entry.nodeId) !== (await memberDigest(entry))) throw new EnvelopeError("replayed-manifest");
  } catch {
    throw new EnvelopeError("replayed-manifest");
  }
}

/** Shared browser read contract; rotation authenticates listings without opening display names. */
export async function openDirectoryListing(
  parentKey: Uint8Array,
  options: {
    vaultId: string;
    directoryId: string;
    keyEpoch?: number;
    revision: number;
    entries: readonly SealedEntry[];
    head: StoredListingHead | null;
  },
): Promise<void> {
  const keyEpoch = options.keyEpoch ?? 1;
  if (
    !Number.isSafeInteger(keyEpoch) ||
    keyEpoch < 1 ||
    !Number.isSafeInteger(options.revision) ||
    options.revision < 1
  )
    throw new EnvelopeError("replayed-manifest");
  if (options.revision === 1) {
    if (options.head || options.entries.length) throw new EnvelopeError("replayed-manifest");
  } else {
    if (!options.head) throw new EnvelopeError("replayed-manifest");
    await openListingHead(parentKey, { ...options, head: options.head });
  }
  rememberListing(options.vaultId, options.directoryId, options.revision, options.head?.digest ?? "");
}

const checkpointKey = (vaultId: string, directoryId: string) => `mdwn:files-listing:${vaultId}:${directoryId}`;

/** A listing head as the rollback checkpoint orders it. */
export type ListingMark = { revision: number; digest: string };

/**
 * The one ordering rule for listing heads: `candidate` is behind `held` when
 * its revision is older, or the same with another digest. Used by the
 * checkpoint below and by the tab's verified memory (ticket 57).
 */
export function headBehind(held: ListingMark, candidate: ListingMark): boolean {
  return (
    candidate.revision < held.revision || (candidate.revision === held.revision && candidate.digest !== held.digest)
  );
}

/**
 * The browser-local high-water mark `rememberListing` keeps: null when there
 * is none, `"malformed"` when it cannot be read. Every reader refuses a
 * malformed one alike: the cold walk throws, and memory misses.
 */
export function listingCheckpoint(vaultId: string, directoryId: string): ListingMark | null | "malformed" {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(checkpointKey(vaultId, directoryId));
  if (stored === null) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "number" &&
      typeof parsed[1] === "string"
      ? { revision: parsed[0], digest: parsed[1] }
      : "malformed";
  } catch {
    return "malformed";
  }
}

/** Browser-local high-water mark detects rolled-back/same-revision heads across navigations. */
export function rememberListing(vaultId: string, directoryId: string, revision: number, digest: string): void {
  if (typeof window === "undefined") return;
  const held = listingCheckpoint(vaultId, directoryId);
  if (held === "malformed" || (held && headBehind(held, { revision, digest }))) throw new Error("replayed-manifest");
  localStorage.setItem(checkpointKey(vaultId, directoryId), JSON.stringify([revision, digest]));
}

/** The trusted digest is established by a verified device signature, never the envelope header. */
export async function openListingHead(
  parentKey: Uint8Array,
  options: {
    vaultId: string;
    directoryId: string;
    keyEpoch?: number;
    revision: number;
    entries: readonly SealedEntry[];
    head: StoredListingHead;
  },
): Promise<void> {
  try {
    const committed = await openListingMembers(parentKey, options);
    const entries = options.entries;
    if (entries.length !== committed.size || new Set(entries.map((entry) => entry.nodeId)).size !== entries.length) {
      throw new EnvelopeError("replayed-manifest");
    }
    await Promise.all(entries.map((entry) => assertListingMember(entry, committed)));
  } catch {
    throw new EnvelopeError("replayed-manifest");
  }
}
