import { EnvelopeError } from "./errors";

export const VERSION = "mdwn/enc-v1";
export const SYMMETRIC_SUITE = "AES-256-GCM/HKDF-SHA-256";
export const HPKE_SUITE = "HPKE-P256/HKDF-SHA-256/AES-256-GCM";

// Names follow CONTEXT.md (`Directory capability`, `File content key`, `Comment
// audience epoch`). Order is part of the enc-v1 wire format. Never renumber or
// reorder an existing purpose; only the numeric id is serialized.
export const PURPOSES = [
  "directory-capability", "file-content-key", "file-content", "directory-metadata",
  "grant", "device-enrollment", "vault-recovery", "recovery-capsule",
  "public-representation", "private-comment-thread", "public-comment-audience-epoch",
  "comment-content", "attribution", "archive-manifest", "import-staging-manifest", "import-chunk",
  "account-profile",
  "owned-device",
] as const;

export const MANIFEST_PURPOSES: readonly EnvelopePurpose[] = ["archive-manifest", "import-staging-manifest"];

export type EnvelopePurpose = (typeof PURPOSES)[number];
export type EnvelopeSuite = typeof SYMMETRIC_SUITE | typeof HPKE_SUITE;

export interface EnvelopeContext {
  purpose: EnvelopePurpose;
  vaultId: string;
  objectId: string;
  keyId: string;
  keyEpoch: number;
  revision: number;
  recipientId?: string;
  publicationId?: string;
}

export interface EnvelopeExpectation {
  context: EnvelopeContext;
  /** Required for manifests; obtained from a trusted current head, not this envelope. */
  manifestDigest?: Uint8Array;
}

export interface EnvelopeHeader {
  version: typeof VERSION;
  suite: EnvelopeSuite;
  context: EnvelopeContext;
  salt?: Uint8Array;
  nonce?: Uint8Array;
  enc?: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const magic = encoder.encode(`${VERSION}\0`);
export const MAX_ENVELOPE_BYTES = 512 * 1024;

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function integer(value: number, width: 2 | 4 | 8): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(width);
  const view = new DataView(bytes.buffer);
  if (width === 2) view.setUint16(0, value);
  if (width === 4) view.setUint32(0, value);
  if (width === 8) view.setBigUint64(0, BigInt(value));
  return bytes;
}

function text(value: string | undefined): Uint8Array<ArrayBuffer> {
  if (value === undefined) return integer(0, 2);
  if (typeof value !== "string") throw new EnvelopeError("malformed");
  const bytes = encoder.encode(value);
  if (!bytes.length || bytes.length > 256 || decoder.decode(bytes) !== value) throw new EnvelopeError("malformed");
  return concat(integer(bytes.length, 2), bytes);
}

const contextFields = new Set([
  "purpose", "vaultId", "objectId", "keyId", "keyEpoch", "revision", "recipientId", "publicationId",
]);

export function encodeContext(context: EnvelopeContext): Uint8Array<ArrayBuffer> {
  if (!context || Object.keys(context).some((key) => !contextFields.has(key)) ||
      !PURPOSES.includes(context.purpose) ||
      !Number.isSafeInteger(context.keyEpoch) || context.keyEpoch < 0 ||
      !Number.isSafeInteger(context.revision) || context.revision < 0 ||
      context.vaultId === undefined || context.objectId === undefined || context.keyId === undefined) {
    throw new EnvelopeError("malformed");
  }
  return concat(
    Uint8Array.of(PURPOSES.indexOf(context.purpose) + 1),
    integer(context.keyEpoch, 8), integer(context.revision, 8),
    text(context.vaultId), text(context.objectId), text(context.keyId),
    text(context.recipientId), text(context.publicationId),
  );
}

/** Purpose-specific required bindings, checked before any encryption or decryption. */
export function assertContextBindings(suite: EnvelopeSuite, context: EnvelopeContext): void {
  if (((context.purpose === "grant" || context.purpose === "device-enrollment") && !context.recipientId) ||
      ((context.purpose === "public-representation" || context.purpose === "public-comment-audience-epoch") && !context.publicationId) ||
      (suite === HPKE_SUITE && !context.recipientId)) {
    throw new EnvelopeError("malformed");
  }
}

export function prefix(suite: EnvelopeSuite, context: EnvelopeContext): Uint8Array<ArrayBuffer> {
  assertContextBindings(suite, context);
  return concat(magic, Uint8Array.of(suite === SYMMETRIC_SUITE ? 1 : 2), encodeContext(context));
}

export function header(prefixBytes: Uint8Array, parameters: Uint8Array, plaintextLength: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(plaintextLength) || plaintextLength < 0 ||
      prefixBytes.length + parameters.length + 4 + plaintextLength + 16 > MAX_ENVELOPE_BYTES) {
    throw new EnvelopeError("malformed");
  }
  return concat(prefixBytes, parameters, integer(plaintextLength + 16, 4));
}

class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array<ArrayBuffer>) {}

  take(length: number): Uint8Array<ArrayBuffer> {
    if (length < 0 || this.offset + length > this.bytes.length) throw new EnvelopeError("malformed");
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  integer(width: 1 | 2 | 4 | 8): number {
    const view = new DataView(this.take(width).buffer);
    if (width === 1) return view.getUint8(0);
    if (width === 2) return view.getUint16(0);
    if (width === 4) return view.getUint32(0);
    const value = Number(view.getBigUint64(0));
    if (!Number.isSafeInteger(value)) throw new EnvelopeError("malformed");
    return value;
  }

  text(): string {
    const length = this.integer(2);
    if (length > 256) throw new EnvelopeError("malformed");
    try {
      return decoder.decode(this.take(length));
    } catch {
      throw new EnvelopeError("malformed");
    }
  }
}

export function parseEnvelope(input: Uint8Array) {
  if (!(input instanceof Uint8Array) || input.length > MAX_ENVELOPE_BYTES) throw new EnvelopeError("malformed");
  const bytes = new Uint8Array(input);
  const reader = new Reader(bytes);
  if (!equal(reader.take(magic.length), magic)) throw new EnvelopeError("unsupported-version");
  const suiteId = reader.integer(1);
  if (suiteId !== 1 && suiteId !== 2) throw new EnvelopeError("unsupported-suite");
  const purpose = PURPOSES[reader.integer(1) - 1];
  if (!purpose) throw new EnvelopeError("malformed");
  const keyEpoch = reader.integer(8);
  const revision = reader.integer(8);
  const context: EnvelopeContext = {
    purpose, keyEpoch, revision,
    vaultId: reader.text(), objectId: reader.text(), keyId: reader.text(),
  };
  const recipientId = reader.text();
  const publicationId = reader.text();
  if (recipientId) context.recipientId = recipientId;
  if (publicationId) context.publicationId = publicationId;
  const suite: EnvelopeSuite = suiteId === 1 ? SYMMETRIC_SUITE : HPKE_SUITE;
  assertContextBindings(suite, context);
  const result: EnvelopeHeader = { version: VERSION, suite, context };
  if (suiteId === 1) {
    result.salt = reader.take(32);
    result.nonce = reader.take(12);
  } else {
    result.enc = reader.take(65);
    if (result.enc[0] !== 4) throw new EnvelopeError("malformed");
  }
  const ciphertextLength = reader.integer(4);
  const aad = bytes.slice(0, reader.offset);
  const ciphertext = reader.take(ciphertextLength);
  if (ciphertextLength < 16 || reader.offset !== bytes.length) throw new EnvelopeError("malformed");
  return { ...result, aad, ciphertext, bytes };
}

/** Structural inspection only: returned fields are NOT authenticated authority. */
export function inspectEnvelope(bytes: Uint8Array): EnvelopeHeader {
  const { aad: _aad, ciphertext: _ciphertext, bytes: _bytes, ...result } = parseEnvelope(bytes);
  return result;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
