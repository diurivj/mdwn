import {
  createSymmetricWriter,
  EnvelopeError,
  openSymmetric,
  type EnvelopeContext,
} from "./enc-v1";

export const ACCOUNT_PROFILE_OBJECT_ID = "account-profile";
export const ACCOUNT_PROFILE_KEY_ID = "vault-root";

const KEY_BYTES = 32;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const magic = encoder.encode("mdwn/account-profile/v1\0");

export type AccountProfile = {
  /** Generated Public pseudonym. It never crosses the service boundary unencrypted. */
  publicPseudonym: string;
};

/** Trusted current Account/Vault metadata, never parsed from an envelope header. */
export type AccountProfileExpectation = {
  accountId: string;
  epoch: number;
  revision: number;
};

/** The only Account-profile fields a service persists or sends. */
export type EncryptedAccountProfile = {
  ciphertext: Uint8Array<ArrayBuffer>;
  epoch: number;
  revision: number;
};

function malformed(): never {
  throw new EnvelopeError("malformed");
}

function copy(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

function canonicalText(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string") malformed();
  const bytes = encoder.encode(value);
  try {
    if (!bytes.length || bytes.length > 0xffff || decoder.decode(bytes) !== value) malformed();
  } catch (error) {
    if (error instanceof EnvelopeError) throw error;
    malformed();
  }
  return bytes;
}

function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) malformed();
  return value;
}

function vaultRootKey(value: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || value.length !== KEY_BYTES) malformed();
  return copy(value);
}

/**
 * Canonical `mdwn/enc-v1` binding for the current encrypted Account profile.
 * The Account, Vault-root epoch, and profile revision are supplied by trusted
 * caller state, never accepted from the envelope's unauthenticated header.
 */
export function accountProfileContext(expected: AccountProfileExpectation): EnvelopeContext {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) malformed();
  const accountId = (expected as AccountProfileExpectation).accountId;
  const epoch = (expected as AccountProfileExpectation).epoch;
  const revision = (expected as AccountProfileExpectation).revision;
  canonicalText(accountId);
  return {
    purpose: "account-profile",
    vaultId: accountId,
    objectId: ACCOUNT_PROFILE_OBJECT_ID,
    keyId: ACCOUNT_PROFILE_KEY_ID,
    keyEpoch: positive(epoch),
    revision: positive(revision),
  };
}

/** Stable, bounded private Account-profile plaintext framing. */
export function encodeAccountProfile(profile: AccountProfile): Uint8Array<ArrayBuffer> {
  if (!profile || typeof profile !== "object" || Array.isArray(profile) ||
      Object.keys(profile).length !== 1 || !("publicPseudonym" in profile)) {
    malformed();
  }
  const pseudonym = canonicalText(profile.publicPseudonym);
  const length = new Uint8Array(2);
  new DataView(length.buffer).setUint16(0, pseudonym.length);
  const result = new Uint8Array(magic.length + length.length + pseudonym.length);
  result.set(magic);
  result.set(length, magic.length);
  result.set(pseudonym, magic.length + length.length);
  return result;
}

export function decodeAccountProfile(input: Uint8Array): AccountProfile {
  if (!(input instanceof Uint8Array)) malformed();
  const bytes = copy(input);
  if (bytes.length < magic.length + 2 || !equal(bytes.slice(0, magic.length), magic)) {
    malformed();
  }
  const length = new DataView(bytes.buffer).getUint16(magic.length);
  const offset = magic.length + 2;
  if (offset + length !== bytes.length) malformed();
  try {
    const publicPseudonym = decoder.decode(bytes.slice(offset));
    canonicalText(publicPseudonym);
    return { publicPseudonym };
  } catch (error) {
    if (error instanceof EnvelopeError) throw error;
    malformed();
  }
}

/**
 * Encrypts a generated Account profile under Account-owned Vault-root material.
 * Callers persist only the returned opaque ciphertext, epoch, and revision.
 */
export async function sealAccountProfile(
  rootKey: Uint8Array,
  profile: AccountProfile,
  expected: AccountProfileExpectation,
): Promise<EncryptedAccountProfile> {
  const context = accountProfileContext(expected);
  const writer = await createSymmetricWriter(vaultRootKey(rootKey));
  return {
    ciphertext: await writer.seal(encodeAccountProfile(profile), context),
    epoch: context.keyEpoch,
    revision: context.revision,
  };
}

/** Opens a profile only against externally supplied current Account/Vault metadata. */
export async function openAccountProfile(
  ciphertext: Uint8Array,
  rootKey: Uint8Array,
  expected: AccountProfileExpectation,
): Promise<AccountProfile> {
  const plaintext = await openSymmetric(
    copy(ciphertext),
    vaultRootKey(rootKey),
    { context: accountProfileContext(expected) },
  );
  return decodeAccountProfile(plaintext);
}
