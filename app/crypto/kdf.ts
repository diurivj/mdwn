import {
  ALGORITHM_SUITE,
  canonicalAuthenticatedContext,
  type EnvelopeContext,
} from "./envelope";
import {
  ByteWriter,
  type ByteSource,
  toBytes,
  utf8,
} from "./encoding";
import { asArrayBuffer, getSubtleCrypto } from "./webcrypto";

const HKDF_DOMAIN = utf8("mdwn/hkdf-sha256/v1");

export interface HkdfSha256Request {
  inputKeyMaterial: ByteSource;
  /** Public salt; omitted means the RFC 5869 all-zero hash-length salt. */
  salt?: ByteSource;
  /** Application label; labels are length-delimited and domain-separated. */
  label: string;
  /** Additional canonical context, usually an enc-v1 context. */
  context?: ByteSource | EnvelopeContext;
  length?: number;
}

export async function hkdfSha256({
  inputKeyMaterial,
  salt,
  label,
  context,
  length = 32,
}: HkdfSha256Request): Promise<Uint8Array> {
  if (!Number.isSafeInteger(length) || length < 1 || length > 255 * 32) {
    throw new RangeError("HKDF output length must be between 1 and 8160 bytes");
  }
  if (typeof label !== "string" || label.length === 0) {
    throw new TypeError("HKDF label is required");
  }

  const contextBytes =
    context === undefined
      ? new Uint8Array()
      : "vaultId" in Object(context)
        ? canonicalAuthenticatedContext({
            suite: ALGORITHM_SUITE.AES_256_GCM,
            context: context as EnvelopeContext,
          })
        : toBytes(context as ByteSource);
  const info = new ByteWriter()
    .writeBytes(HKDF_DOMAIN)
    .writeLengthPrefixedString(label)
    .writeLengthPrefixedBytes(contextBytes)
    .writeU32(length)
    .toBytes();
  const baseKey = await getSubtleCrypto().importKey(
    "raw",
    asArrayBuffer(inputKeyMaterial),
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const bits = await getSubtleCrypto().deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: asArrayBuffer(salt ?? new Uint8Array(32)),
      info: asArrayBuffer(info),
    },
    baseKey,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function deriveAes256Key(
  request: Omit<HkdfSha256Request, "length">,
): Promise<CryptoKey> {
  const raw = await hkdfSha256({ ...request, length: 32 });
  return getSubtleCrypto().importKey(
    "raw",
    asArrayBuffer(raw),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sha256(value: ByteSource): Promise<Uint8Array> {
  const digest = await getSubtleCrypto().digest("SHA-256", asArrayBuffer(value));
  return new Uint8Array(digest);
}

export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError("random byte length is invalid");
  }
  const result = new Uint8Array(length);
  // WebCrypto limits one getRandomValues call to 65,536 bytes.
  for (let offset = 0; offset < result.byteLength; offset += 65_536) {
    getSubtleCrypto();
    globalThis.crypto.getRandomValues(
      result.subarray(offset, Math.min(offset + 65_536, result.byteLength)),
    );
  }
  return result;
}
