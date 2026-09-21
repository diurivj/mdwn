import {
  bytesEqual,
  ByteReader,
  ByteWriter,
  type ByteSource,
  concatBytes,
  decodeUtf8,
  toBytes,
  utf8,
} from "./encoding";

export const ENC_V1_VERSION = 1 as const;
export const ENC_V1_MAGIC = utf8("mdwn/enc-v1");
const AUTHENTICATED_CONTEXT_MAGIC = utf8("mdwn/enc-v1/aad");
const MAX_FIELD_BYTES = 256;
export const MAX_ENVELOPE_BYTES = 524_288;
export const GCM_TAG_BYTES = 16;
export const AES_GCM_NONCE_BYTES = 12;
export const HPKE_ENCAPSULATED_KEY_BYTES = 65;

export const ALGORITHM_SUITE = {
  AES_256_GCM: "aes-256-gcm",
  HPKE_P256_HKDF_SHA256_AES_256_GCM:
    "hpke-dhkem-p256-hkdf-sha256-hkdf-sha256-aes-256-gcm",
} as const;

export type AlgorithmSuite = (typeof ALGORITHM_SUITE)[keyof typeof ALGORITHM_SUITE];

const SUITE_IDS: Record<AlgorithmSuite, number> = {
  [ALGORITHM_SUITE.AES_256_GCM]: 0x01,
  [ALGORITHM_SUITE.HPKE_P256_HKDF_SHA256_AES_256_GCM]: 0x02,
};

const SUITES_BY_ID = new Map<number, AlgorithmSuite>(
  Object.entries(SUITE_IDS).map(([suite, id]) => [id, suite as AlgorithmSuite]),
);

export const ENVELOPE_PURPOSE = {
  DIRECTORY_CHILD: "directory-child",
  FILE_CONTENT: "file-content",
  GRANT: "grant",
  DEVICE_ENROLLMENT: "device-enrollment",
  VAULT_RECOVERY: "vault-recovery",
  PUBLICATION: "publication",
  PRIVATE_COMMENT_THREAD: "private-comment-thread",
  PUBLIC_COMMENT_EPOCH: "public-comment-epoch",
  ATTRIBUTION: "attribution",
} as const;

export type EnvelopePurpose = (typeof ENVELOPE_PURPOSE)[keyof typeof ENVELOPE_PURPOSE] | string;

export interface EnvelopeContext {
  /** Opaque Account Vault identifier. */
  vaultId: string;
  /** Opaque object whose key/capability is protected. */
  objectId: string;
  /** Opaque identifier for the protected key or representation. */
  keyId: string;
  /** Purpose-specific domain separator. */
  purpose: EnvelopePurpose;
  /** Monotonic key/capability epoch. */
  epoch: number;
  /** Device/recipient identifier when the envelope targets one recipient. */
  recipientId?: string;
  /** Publication identifier when the envelope is Publication-bound. */
  publicationId?: string;
}

export interface EncV1Envelope {
  version: typeof ENC_V1_VERSION;
  suite: AlgorithmSuite;
  context: EnvelopeContext;
  /** AES-GCM's explicit 96-bit nonce. */
  nonce?: Uint8Array;
  /** HPKE's serialized DHKEM(P-256) encapsulated public key. */
  enc?: Uint8Array;
  ciphertext: Uint8Array;
}

export class EncV1Error extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class InvalidContextError extends EncV1Error {}
export class UnsupportedVersionError extends EncV1Error {}
export class UnsupportedSuiteError extends EncV1Error {}
export class MalformedEnvelopeError extends EncV1Error {}
export class ContextMismatchError extends EncV1Error {}
export class StaleEpochError extends EncV1Error {}
export class AlgorithmDowngradeError extends EncV1Error {}
export class EnvelopeAuthenticationError extends EncV1Error {}
export class ReplayDetectedError extends EncV1Error {}

export interface AuthenticatedContextInput {
  suite: AlgorithmSuite;
  context: EnvelopeContext;
}

/**
 * Canonical binary AAD for every enc-v1 operation.
 *
 * The field order is fixed and all optional fields have an explicit presence
 * bit. IDs and purpose are restricted to printable ASCII so Unicode
 * normalization cannot produce two authenticated spellings of one ID.
 */
export function canonicalAuthenticatedContext(
  input: AuthenticatedContextInput,
): Uint8Array {
  const suiteId = suiteToId(input.suite);
  const context = normalizeContext(input.context);
  return writeAuthenticatedContext(suiteId, context);
}

export function encodeEnvelope(input: EncV1Envelope): Uint8Array {
  if (input.version !== ENC_V1_VERSION) {
    throw new UnsupportedVersionError(`unsupported enc-v1 version: ${input.version}`);
  }

  const suiteId = suiteToId(input.suite);
  const context = normalizeContext(input.context);
  const ciphertext = toBytes(input.ciphertext);
  if (ciphertext.byteLength < GCM_TAG_BYTES) {
    throw new MalformedEnvelopeError("ciphertext is missing its authentication tag");
  }

  const writer = new ByteWriter()
    .writeBytes(ENC_V1_MAGIC)
    .writeU8(ENC_V1_VERSION)
    .writeU8(suiteId)
    .writeU8(contextFlags(context));
  writeContextFields(writer, context);

  if (input.suite === ALGORITHM_SUITE.AES_256_GCM) {
    const nonce = input.nonce === undefined ? undefined : toBytes(input.nonce);
    if (nonce === undefined || nonce.byteLength !== AES_GCM_NONCE_BYTES) {
      throw new MalformedEnvelopeError("AES-GCM envelopes require a 96-bit nonce");
    }
    if (input.enc !== undefined) {
      throw new MalformedEnvelopeError("AES-GCM envelopes cannot carry an HPKE key");
    }
    writer.writeBytes(nonce);
  } else {
    const enc = input.enc === undefined ? undefined : toBytes(input.enc);
    if (enc === undefined || enc.byteLength !== HPKE_ENCAPSULATED_KEY_BYTES) {
      throw new MalformedEnvelopeError("HPKE envelopes require a P-256 encapsulated key");
    }
    if (input.nonce !== undefined) {
      throw new MalformedEnvelopeError("HPKE envelopes cannot carry an AES-GCM nonce");
    }
    writer.writeBytes(enc);
  }

  const encoded = writer
    .writeU32(ciphertext.byteLength)
    .writeBytes(ciphertext)
    .toBytes();
  if (encoded.byteLength > MAX_ENVELOPE_BYTES) {
    throw new MalformedEnvelopeError("envelope exceeds the binary payload limit");
  }
  return encoded;
}

export function decodeEnvelope(input: ByteSource): EncV1Envelope {
  const encoded = toBytes(input);
  if (encoded.byteLength > MAX_ENVELOPE_BYTES) {
    throw new MalformedEnvelopeError("envelope exceeds the binary payload limit");
  }

  try {
    const reader = new ByteReader(encoded);
    if (!bytesEqual(reader.readBytes(ENC_V1_MAGIC.byteLength), ENC_V1_MAGIC)) {
      throw new MalformedEnvelopeError("invalid enc-v1 magic");
    }

    const version = reader.readU8();
    if (version !== ENC_V1_VERSION) {
      throw new UnsupportedVersionError(`unsupported enc-v1 version: ${version}`);
    }
    const suite = suiteFromId(reader.readU8());
    const flags = reader.readU8();
    if ((flags & ~0x03) !== 0) {
      throw new MalformedEnvelopeError("unknown authenticated-context flags");
    }

    const context = normalizeContext({
      purpose: reader.readLengthPrefixedString(),
      vaultId: reader.readLengthPrefixedString(),
      objectId: reader.readLengthPrefixedString(),
      keyId: reader.readLengthPrefixedString(),
      epoch: bigintToSafeNumber(reader.readU64(), "key epoch"),
      ...(flags & 0x01 ? { recipientId: reader.readLengthPrefixedString() } : {}),
      ...(flags & 0x02 ? { publicationId: reader.readLengthPrefixedString() } : {}),
    });

    const payloadKey =
      suite === ALGORITHM_SUITE.AES_256_GCM
        ? { nonce: reader.readBytes(AES_GCM_NONCE_BYTES) }
        : { enc: reader.readBytes(HPKE_ENCAPSULATED_KEY_BYTES) };
    const ciphertextLength = reader.readU32();
    if (ciphertextLength < GCM_TAG_BYTES || ciphertextLength > reader.remaining) {
      throw new MalformedEnvelopeError("invalid ciphertext length");
    }
    const ciphertext = reader.readBytes(ciphertextLength);
    reader.assertDone();

    const result: EncV1Envelope = {
      version: ENC_V1_VERSION,
      suite,
      context,
      ciphertext,
      ...payloadKey,
    };
    const canonical = encodeEnvelope(result);
    if (!bytesEqual(canonical, encoded)) {
      throw new MalformedEnvelopeError("envelope is not in canonical binary form");
    }
    return result;
  } catch (error) {
    if (error instanceof EncV1Error) throw error;
    throw new MalformedEnvelopeError("malformed enc-v1 envelope", { cause: error });
  }
}

export function assertOpenPolicy(
  envelope: EncV1Envelope,
  expectedSuite: AlgorithmSuite,
  expectedContext: EnvelopeContext,
  minimumEpoch?: number,
): void {
  if (envelope.suite !== expectedSuite) {
    throw new AlgorithmDowngradeError(
      `expected ${expectedSuite}, received ${envelope.suite}`,
    );
  }

  const expected = canonicalAuthenticatedContext({
    suite: expectedSuite,
    context: expectedContext,
  });
  const actual = canonicalAuthenticatedContext({
    suite: envelope.suite,
    context: envelope.context,
  });
  if (!bytesEqual(expected, actual)) {
    throw new ContextMismatchError("authenticated envelope context does not match");
  }

  if (minimumEpoch !== undefined) {
    validateEpoch(minimumEpoch);
    if (envelope.context.epoch < minimumEpoch) {
      throw new StaleEpochError("envelope key epoch is stale");
    }
  }
}

export function suiteToId(suite: AlgorithmSuite): number {
  const id = SUITE_IDS[suite];
  if (id === undefined) throw new UnsupportedSuiteError(`unsupported suite: ${suite}`);
  return id;
}

export function suiteFromId(id: number): AlgorithmSuite {
  const suite = SUITES_BY_ID.get(id);
  if (suite === undefined) throw new UnsupportedSuiteError(`unsupported suite id: ${id}`);
  return suite;
}

export function normalizeContext(input: EnvelopeContext): EnvelopeContext {
  if (!input || typeof input !== "object") {
    throw new InvalidContextError("authenticated context is required");
  }
  const context = {
    vaultId: validateIdentifier(input.vaultId, "vaultId"),
    objectId: validateIdentifier(input.objectId, "objectId"),
    keyId: validateIdentifier(input.keyId, "keyId"),
    purpose: validateIdentifier(input.purpose, "purpose"),
    epoch: validateEpoch(input.epoch),
    ...(input.recipientId === undefined
      ? {}
      : { recipientId: validateIdentifier(input.recipientId, "recipientId") }),
    ...(input.publicationId === undefined
      ? {}
      : { publicationId: validateIdentifier(input.publicationId, "publicationId") }),
  } satisfies EnvelopeContext;
  return context;
}

export function contextFlags(context: EnvelopeContext): number {
  return (context.recipientId === undefined ? 0 : 0x01) |
    (context.publicationId === undefined ? 0 : 0x02);
}

function writeAuthenticatedContext(
  suiteId: number,
  context: EnvelopeContext,
): Uint8Array {
  const writer = new ByteWriter()
    .writeBytes(AUTHENTICATED_CONTEXT_MAGIC)
    .writeU8(ENC_V1_VERSION)
    .writeU8(suiteId)
    .writeU8(contextFlags(context));
  return writeContextFields(writer, context).toBytes();
}

function writeContextFields(writer: ByteWriter, context: EnvelopeContext): ByteWriter {
  writer
    .writeLengthPrefixedString(context.purpose)
    .writeLengthPrefixedString(context.vaultId)
    .writeLengthPrefixedString(context.objectId)
    .writeLengthPrefixedString(context.keyId)
    .writeU64(context.epoch);
  if (context.recipientId !== undefined) writer.writeLengthPrefixedString(context.recipientId);
  if (context.publicationId !== undefined) {
    writer.writeLengthPrefixedString(context.publicationId);
  }
  return writer;
}

function validateIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidContextError(`${label} must be a non-empty identifier`);
  }
  const bytes = utf8(value);
  if (bytes.byteLength > MAX_FIELD_BYTES) {
    throw new InvalidContextError(`${label} is too long`);
  }
  for (const byte of bytes) {
    if (byte < 0x21 || byte > 0x7e) {
      throw new InvalidContextError(`${label} must use printable ASCII`);
    }
  }
  return value;
}

function validateEpoch(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new InvalidContextError("epoch must be a non-negative safe integer");
  }
  return value;
}

function bigintToSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MalformedEnvelopeError(`${label} is too large`);
  }
  return Number(value);
}

export function contextBytesForEnvelope(
  suite: AlgorithmSuite,
  context: EnvelopeContext,
): Uint8Array {
  return canonicalAuthenticatedContext({ suite, context });
}

export function concatContextBytes(...values: ByteSource[]): Uint8Array {
  return concatBytes(...values.map(toBytes));
}

export function decodeEnvelopePurpose(bytes: Uint8Array): string {
  return decodeUtf8(bytes);
}
