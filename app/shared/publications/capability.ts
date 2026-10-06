import { decodeTreeBytes, encodeTreeBytes } from "~/shared/tree/wire";

/**
 * Public-link capability material (ticket 22). Browser and Worker safe: no
 * key, fragment, or plaintext ever leaves the caller through this module.
 *
 * - Logical Publication, Public path (link) and author-declaration identifiers
 *   are independent 256-bit CSPRNG values in canonical unpadded base64url. They
 *   carry no timestamp, Owner, File, or name.
 * - The read-only decryption capability is the P-256 private scalar of the
 *   link's HPKE key pair. It lives only after `#` as `v1.<base64url scalar>`;
 *   the service stores only the matching public key.
 */

const IDENTIFIER_BYTES = 32;
const SCALAR_BYTES = 32;
const PUBLIC_KEY_BYTES = 65;
export const PUBLICATION_FRAGMENT_VERSION = "v1";
const FRAGMENT = /^#?v1\.([A-Za-z0-9_-]{43})$/;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

export function newPublicationIdentifier(): string {
  return encodeTreeBytes(crypto.getRandomValues(new Uint8Array(IDENTIFIER_BYTES)));
}

/** Exactly the canonical encoding of 32 bytes; never a UUID or a padded spelling. */
export function isPublicationIdentifier(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    return decodeTreeBytes(value, IDENTIFIER_BYTES).length === IDENTIFIER_BYTES;
  } catch {
    return false;
  }
}

/** A raw SEC1 uncompressed P-256 point, as stored by the service for editors. */
function publicPoint(value: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || value.length !== PUBLIC_KEY_BYTES || value[0] !== 4) {
    throw new Error("invalid publication key");
  }
  return new Uint8Array(value);
}

export function decodePublicationPublicKey(value: unknown): Uint8Array<ArrayBuffer> {
  return publicPoint(decodeTreeBytes(value, PUBLIC_KEY_BYTES));
}

/** The envelope recipient binding: the exact stored public key bytes. */
export function publicationRecipientId(publicKey: Uint8Array): string {
  return encodeTreeBytes(publicPoint(publicKey));
}

export function formatPublicationFragment(privateKey: Uint8Array): string {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== SCALAR_BYTES)
    throw new Error("invalid publication capability");
  return `${PUBLICATION_FRAGMENT_VERSION}.${encodeTreeBytes(privateKey)}`;
}

/** Accepts `location.hash` with or without `#`. A malformed or unknown version
 * yields null; callers must not echo the input into errors, logs or requests. */
export function parsePublicationFragment(hash: string): Uint8Array<ArrayBuffer> | null {
  const match = typeof hash === "string" ? FRAGMENT.exec(hash) : null;
  if (!match) return null;
  try {
    const scalar = decodeTreeBytes(match[1], SCALAR_BYTES);
    return scalar.length === SCALAR_BYTES ? scalar : null;
  } catch {
    return null;
  }
}

/** The complete Public link. Only the path is ever sent to the service. */
export function publicLinkUrl(origin: string, linkId: string, privateKey: Uint8Array): string {
  if (!isPublicationIdentifier(linkId)) throw new Error("invalid publication link");
  return `${new URL(origin).origin}/p/${linkId}#${formatPublicationFragment(privateKey)}`;
}

/**
 * A fresh link key pair from WebCrypto's CSPRNG. The private scalar is exported
 * once for the fragment and the creating browser then drops the extractable
 * handle; every engine reports the true public point for a generated key.
 */
export async function createPublicationKeyPair(): Promise<{
  privateKey: Uint8Array<ArrayBuffer>;
  publicKey: Uint8Array<ArrayBuffer>;
}> {
  const pair = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const privateKey = decodeTreeBytes(jwk.d, SCALAR_BYTES);
  if (privateKey.length !== SCALAR_BYTES) throw new Error("invalid publication capability");
  return { privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

export function importPublicationPublicKey(publicKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", publicPoint(publicKey), ECDH, true, []);
}

/**
 * Re-creates the reader's key pair from the fragment scalar and the stored
 * public point. Engines that validate JWK pairs reject a substituted point; in
 * the others a substituted point still cannot decrypt (HPKE binds `pkR`).
 */
export async function importPublicationKeyPair(privateKey: Uint8Array, publicKey: Uint8Array): Promise<CryptoKeyPair> {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== SCALAR_BYTES)
    throw new Error("invalid publication capability");
  const point = publicPoint(publicKey);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: encodeTreeBytes(point.slice(1, 33)),
    y: encodeTreeBytes(point.slice(33)),
    d: encodeTreeBytes(privateKey),
  };
  return {
    privateKey: await crypto.subtle.importKey("jwk", jwk, ECDH, false, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", point, ECDH, true, []),
  };
}
