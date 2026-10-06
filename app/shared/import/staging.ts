/**
 * Import staging protocol (ticket 30).
 *
 * Browser and Worker together speak one binary-only staging protocol: a
 * confirmed Import opens a session with a canonical routing header and the
 * browser's encrypted manifest, then uploads 1–40 raw binary chunks. Each
 * chunk body is `magic || descriptorCount || descriptors || payload`; every
 * descriptor names one complete canonical `mdwn/enc-v1` record by kind, opaque
 * fixed-size references, byte range, and SHA-256 digest. There is no
 * free-form, JSON, base64, retry, or metadata field anywhere in the protocol.
 *
 * This module is shared by the browser and the Worker and performs structural
 * validation only. Semantic checks that need authorization, session state, or
 * D1 (envelope context, per-record ceilings, session counters) live in the
 * staging route; a record whose header is authenticated only after a
 * successful browser open is validated structurally with `inspectEnvelope`.
 */

import type { ImportPlanDescriptor } from "./plan";
import {
  MAX_STAGING_CHUNK_BYTES,
  MAX_STAGING_CHUNK_RECORDS,
  MAX_STAGING_CHUNKS,
  MAX_STAGING_MANIFEST_BYTES,
  MAX_STAGING_PAYLOAD_BYTES,
  MAX_STAGING_RECORDS,
} from "./limits";

export const IMPORT_SESSION_MAGIC = "mdwn/import-session/v1\0";
export const IMPORT_CHUNK_MAGIC = "mdwn/import-chunk/v1\0";

/** UUIDv7 text, including dashes. */
export const IMPORT_REF_UUID_BYTES = 36;
/** Unpadded 256-bit base64url (Publication/link IDs). */
export const IMPORT_REF_OPAQUE_BYTES = 43;

export type ImportRefKind = "uuid" | "opaque";

/**
 * The canonical record kinds one Import may stage. `min`/`max` are the decoded
 * binary payload bounds from the locked import envelope; the Worker and D1
 * enforce the same numbers. `envelope` says which structural envelope shape (if
 * any) the payload must be, and `purpose` the envelope purpose the Worker
 * checks without decrypting.
 */
export const IMPORT_RECORD_KINDS = {
  "node-directory": { id: 1, refs: ["uuid", "uuid"], min: 0, max: 0, envelope: null },
  "node-file": { id: 2, refs: ["uuid", "uuid"], min: 0, max: 0, envelope: null },
  "entry-name": {
    id: 3,
    refs: ["uuid", "uuid"],
    min: 1,
    max: 4_096,
    envelope: "symmetric",
    purpose: "directory-metadata",
  },
  "entry-order": {
    id: 4,
    refs: ["uuid", "uuid"],
    min: 1,
    max: 4_096,
    envelope: "symmetric",
    purpose: "directory-metadata",
  },
  "directory-capability": {
    id: 5,
    refs: ["uuid", "uuid"],
    min: 1,
    max: 16_384,
    envelope: "symmetric",
    purpose: "directory-capability",
  },
  "file-capability": {
    id: 6,
    refs: ["uuid", "uuid", "uuid"],
    min: 1,
    max: 16_384,
    envelope: "symmetric",
    purpose: "file-capability",
  },
  "entry-key": {
    id: 7,
    refs: ["uuid", "uuid"],
    min: 1,
    max: 16_384,
    envelope: "symmetric",
    purpose: "file-content-key",
  },
  "representation-key": {
    id: 8,
    refs: ["uuid", "uuid", "uuid"],
    min: 1,
    max: 16_384,
    envelope: "symmetric",
    purpose: "file-content-key",
  },
  representation: {
    id: 9,
    refs: ["uuid", "uuid", "uuid"],
    min: 1,
    max: 524_288,
    envelope: "symmetric",
    purpose: "file-content",
  },
  "file-head": { id: 10, refs: ["uuid", "uuid"], min: 96, max: 96, envelope: null },
  replace: { id: 11, refs: ["uuid", "uuid"], min: 8, max: 8, envelope: null },
  "public-representation": {
    id: 12,
    refs: ["opaque", "opaque", "opaque"],
    min: 1,
    max: 524_288,
    envelope: "hpke",
    purpose: "public-representation",
  },
  "comment-thread": {
    id: 13,
    refs: ["uuid", "uuid", "uuid", "uuid"],
    min: 1,
    max: 16_384,
    envelope: "symmetric",
    purpose: "private-comment-thread",
  },
  "comment-meta": {
    id: 14,
    refs: ["uuid", "uuid"],
    min: 1,
    max: 4_096,
    envelope: "symmetric",
    purpose: "comment-content",
  },
  "comment-body": {
    id: 15,
    refs: ["uuid", "uuid"],
    min: 1,
    max: 16_384,
    envelope: "symmetric",
    purpose: "comment-content",
  },
  "comment-key": {
    id: 16,
    refs: ["uuid", "uuid"],
    min: 1,
    max: 16_384,
    envelope: "symmetric",
    purpose: "comment-content",
  },
  "comment-attribution": {
    id: 17,
    refs: ["uuid", "uuid"],
    min: 1,
    max: 4_096,
    envelope: "symmetric",
    purpose: "attribution",
  },
  "comment-attribution-key": {
    id: 18,
    refs: ["uuid", "uuid"],
    min: 1,
    max: 16_384,
    envelope: "symmetric",
    purpose: "attribution",
  },
  "listing-ciphertext": {
    id: 19,
    refs: ["uuid"],
    min: 1,
    max: 524_288,
    envelope: "symmetric",
    purpose: "directory-metadata",
  },
  "listing-digest": { id: 20, refs: ["uuid"], min: 32, max: 32, envelope: null },
  "listing-signature": { id: 21, refs: ["uuid"], min: 64, max: 64, envelope: null },
} as const satisfies Record<
  string,
  {
    id: number;
    refs: readonly ImportRefKind[];
    min: number;
    max: number;
    envelope: "symmetric" | "hpke" | null;
    purpose?: string;
  }
>;

export type StagingRecordKind = keyof typeof IMPORT_RECORD_KINDS;

export const STAGING_RECORD_BY_ID: Readonly<Record<number, StagingRecordKind>> = Object.fromEntries(
  Object.entries(IMPORT_RECORD_KINDS).map(([kind, schema]) => [schema.id, kind]),
) as Record<number, StagingRecordKind>;

export type ImportSessionKindCount = { kind: StagingRecordKind; count: number };

export type ImportSessionMetadata = {
  /** Unguessable 256-bit base64url identity minted with the reviewed plan. */
  importId: string;
  targetDirectoryId: string;
  reviewedEntryRevision: number;
  recordCount: number;
  chunkCount: number;
  payloadBytes: number;
  commentCount: number;
  /** Lowercase hex SHA-256 over the sequence-ordered raw chunk payloads. */
  aggregateDigest: string;
  /** Lowercase hex SHA-256 of the whole canonical staging-manifest envelope. */
  manifestDigest: string;
  kindCounts: readonly ImportSessionKindCount[];
};

export type StagingErrorCode = "malformed" | "too-large" | "unsupported-version" | "wrong-shape";

/** Structural staging failure; `detail` never contains private content. */
export class StagingError extends Error {
  constructor(
    readonly code: StagingErrorCode,
    readonly detail?: string,
  ) {
    super(`mdwn/import-staging: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "StagingError";
  }
}

const encoder = new TextEncoder();
const SESSION_PREFIX = encoder.encode(IMPORT_SESSION_MAGIC);
const CHUNK_PREFIX = encoder.encode(IMPORT_CHUNK_MAGIC);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isValidImportRef(kind: ImportRefKind, value: string): boolean {
  return kind === "uuid" ? UUID_PATTERN.test(value) : OPAQUE_PATTERN.test(value);
}

function readInteger(bytes: Uint8Array, offset: number, width: 4 | 8): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (width === 4) return view.getUint32(offset);
  const value = Number(view.getBigUint64(offset));
  if (!Number.isSafeInteger(value)) throw new StagingError("too-large");
  return value;
}

function writeInteger(bytes: Uint8Array, offset: number, width: 4 | 8, value: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (width === 4) view.setUint32(offset, value);
  else view.setBigUint64(offset, BigInt(value));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((length, part) => length + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** `digestEnvelope`'s whole-envelope SHA-256 in lowercase hex, without opening. */
export async function envelopeDigestHex(envelope: Uint8Array): Promise<string> {
  return sha256HexBytes(envelope);
}

export type DecodedDescriptor = {
  kind: StagingRecordKind;
  refs: readonly string[];
  offset: number;
  length: number;
  digest: Uint8Array;
};

export type DecodedChunk = { descriptors: readonly DecodedDescriptor[]; payload: Uint8Array };

/** Encode one upload chunk: typed descriptor framing followed by the raw payload. */
export function encodeImportChunkBody(descriptors: readonly ImportPlanDescriptor[], payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_STAGING_CHUNK_BYTES) throw new StagingError("too-large");
  if (descriptors.length < 1 || descriptors.length > MAX_STAGING_CHUNK_RECORDS) throw new StagingError("wrong-shape");
  const parts: Uint8Array[] = [CHUNK_PREFIX, Uint8Array.of(descriptors.length)];
  let expectedOffset = 0;
  for (const descriptor of descriptors) {
    const schema = IMPORT_RECORD_KINDS[descriptor.kind];
    if (!schema) throw new StagingError("wrong-shape");
    if (
      descriptor.refs.length !== schema.refs.length ||
      descriptor.refs.some((ref, index) => !isValidImportRef(schema.refs[index]!, ref)) ||
      descriptor.offset !== expectedOffset ||
      descriptor.length < schema.min ||
      descriptor.length > schema.max
    ) {
      throw new StagingError("wrong-shape", descriptor.kind);
    }
    const digest = decodeHex(descriptor.digest, 32);
    parts.push(Uint8Array.of(schema.id));
    for (const ref of descriptor.refs) parts.push(encoder.encode(ref));
    const range = new Uint8Array(20);
    writeInteger(range, 0, 8, descriptor.offset);
    writeInteger(range, 8, 8, descriptor.length);
    parts.push(range, digest);
    expectedOffset += descriptor.length;
  }
  if (expectedOffset !== payload.length) throw new StagingError("wrong-shape");
  parts.push(payload);
  return concat(parts);
}

function decodeHex(value: string, bytes: number): Uint8Array {
  if (typeof value !== "string" || value.length !== bytes * 2 || !/^[0-9a-f]*$/.test(value)) {
    throw new StagingError("wrong-shape");
  }
  const result = new Uint8Array(bytes);
  for (let index = 0; index < bytes; index++)
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return result;
}

/** Decode and structurally validate one chunk body. Every byte must be covered. */
export function decodeImportChunkBody(bytes: Uint8Array, maxBodyBytes?: number): DecodedChunk {
  if (!(bytes instanceof Uint8Array) || bytes.length < CHUNK_PREFIX.length + 1) throw new StagingError("malformed");
  if (maxBodyBytes !== undefined && bytes.length > maxBodyBytes) throw new StagingError("too-large");
  if (!CHUNK_PREFIX.every((byte, index) => bytes[index] === byte)) throw new StagingError("unsupported-version");
  let offset = CHUNK_PREFIX.length;
  const count = bytes[offset++]!;
  if (count < 1 || count > MAX_STAGING_CHUNK_RECORDS) throw new StagingError("wrong-shape", "descriptor count");
  const descriptors: DecodedDescriptor[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let expectedPayloadOffset = 0;
  try {
    for (let index = 0; index < count; index++) {
      const kind = STAGING_RECORD_BY_ID[bytes[offset++]!];
      if (!kind) throw new StagingError("wrong-shape", "unknown kind");
      const schema = IMPORT_RECORD_KINDS[kind];
      const refs: string[] = [];
      for (const refKind of schema.refs) {
        const length = refKind === "uuid" ? IMPORT_REF_UUID_BYTES : IMPORT_REF_OPAQUE_BYTES;
        if (offset + length > bytes.length) throw new StagingError("malformed");
        const ref = decoder.decode(bytes.subarray(offset, offset + length));
        offset += length;
        if (!isValidImportRef(refKind, ref)) throw new StagingError("wrong-shape", "reference");
        refs.push(ref);
      }
      if (offset + 48 > bytes.length) throw new StagingError("malformed");
      const range = bytes.subarray(offset, offset + 20);
      const declaredOffset = readInteger(range, 0, 8);
      const length = readInteger(range, 8, 8);
      const digest = bytes.slice(offset + 20, offset + 52);
      offset += 52;
      if (declaredOffset !== expectedPayloadOffset || length < schema.min || length > schema.max) {
        throw new StagingError("wrong-shape", "record range");
      }
      descriptors.push({ kind, refs, offset: declaredOffset, length, digest });
      expectedPayloadOffset += length;
    }
  } catch (error) {
    if (error instanceof StagingError) throw error;
    throw new StagingError("malformed");
  }
  const payload = bytes.subarray(offset);
  if (payload.length !== expectedPayloadOffset || payload.length > MAX_STAGING_CHUNK_BYTES) {
    throw new StagingError("wrong-shape", "payload range");
  }
  return { descriptors, payload };
}

/**
 * Verify every descriptor's record digest. The chunk body digest is already
 * authenticated by the device proof and covers framing plus payload, so this
 * hashes only the records and reuses one cached digest for empty records.
 */
export async function verifyChunkDigests(chunk: DecodedChunk): Promise<boolean> {
  let empty: Uint8Array | null = null;
  for (const descriptor of chunk.descriptors) {
    const record = chunk.payload.subarray(descriptor.offset, descriptor.offset + descriptor.length);
    if (!record.length) {
      empty ??= new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array()));
      if (!empty.every((byte, index) => byte === descriptor.digest[index])) return false;
      continue;
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(record)));
    if (!digest.every((byte, index) => byte === descriptor.digest[index])) return false;
  }
  return true;
}

/**
 * Encode the confirmed-Import session body. Layout, all integers big-endian:
 *
 *   magic | targetDirectoryId (36 raw bytes) | reviewedEntryRevision u64 |
 *   recordCount u64 | chunkCount u64 | payloadBytes u64 | commentCount u64 |
 *   kindCount u32 | aggregateDigest 32 | manifestDigest 32 | manifestLength u32 |
 *   kindCount x (kindId u8, count u32) | manifest bytes
 */
export function encodeImportSessionBody(metadata: ImportSessionMetadata, manifest: Uint8Array): Uint8Array {
  if (
    metadata.kindCounts.length > Object.keys(IMPORT_RECORD_KINDS).length ||
    new Set(metadata.kindCounts.map((entry) => entry.kind)).size !== metadata.kindCounts.length
  ) {
    throw new StagingError("wrong-shape", "kind counts");
  }
  const target = encodeIdentifier(metadata.targetDirectoryId, UUID_PATTERN);
  const sessionId = encodeIdentifier(metadata.importId, OPAQUE_PATTERN);
  const header = new Uint8Array(8 * 5 + 4 + 32 + 32 + 4);
  writeInteger(header, 0, 8, metadata.reviewedEntryRevision);
  writeInteger(header, 8, 8, metadata.recordCount);
  writeInteger(header, 16, 8, metadata.chunkCount);
  writeInteger(header, 24, 8, metadata.payloadBytes);
  writeInteger(header, 32, 8, metadata.commentCount);
  writeInteger(header, 40, 4, metadata.kindCounts.length);
  header.set(decodeHex(metadata.aggregateDigest, 32), 44);
  header.set(decodeHex(metadata.manifestDigest, 32), 76);
  writeInteger(header, 108, 4, manifest.length);
  const kinds = new Uint8Array(metadata.kindCounts.length * 5);
  metadata.kindCounts.forEach((entry, index) => {
    const schema = IMPORT_RECORD_KINDS[entry.kind];
    if (!schema || entry.count < 1 || entry.count > MAX_STAGING_RECORDS)
      throw new StagingError("wrong-shape", "kind count");
    kinds[index * 5] = schema.id;
    writeInteger(kinds, index * 5 + 1, 4, entry.count);
  });
  return concat([SESSION_PREFIX, sessionId, target, header, kinds, manifest]);
}

function encodeIdentifier(value: string, pattern: RegExp): Uint8Array {
  if (!pattern.test(value)) throw new StagingError("wrong-shape", "identifier");
  return encoder.encode(value);
}

export type DecodedSessionBody = { metadata: ImportSessionMetadata; manifest: Uint8Array };

/** Decode the session body exactly; the manifest is the trailing bytes. */
export function decodeImportSessionBody(
  bytes: Uint8Array,
  maxBytes: number = MAX_IMPORT_SESSION_BODY_BYTES,
): DecodedSessionBody {
  if (!(bytes instanceof Uint8Array)) throw new StagingError("malformed");
  if (bytes.length > maxBytes) throw new StagingError("too-large");
  const fixed = SESSION_PREFIX.length + IMPORT_REF_OPAQUE_BYTES + IMPORT_REF_UUID_BYTES + 8 * 5 + 4 + 32 + 32 + 4;
  if (bytes.length < fixed) throw new StagingError("malformed");
  if (!SESSION_PREFIX.every((byte, index) => bytes[index] === byte)) throw new StagingError("unsupported-version");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = SESSION_PREFIX.length;
  let importId: string;
  try {
    importId = decoder.decode(bytes.subarray(offset, offset + IMPORT_REF_OPAQUE_BYTES));
  } catch {
    throw new StagingError("malformed");
  }
  if (!OPAQUE_PATTERN.test(importId)) throw new StagingError("wrong-shape", "import id");
  offset += IMPORT_REF_OPAQUE_BYTES;
  let targetDirectoryId: string;
  try {
    targetDirectoryId = decoder.decode(bytes.subarray(offset, offset + IMPORT_REF_UUID_BYTES));
  } catch {
    throw new StagingError("malformed");
  }
  if (!UUID_PATTERN.test(targetDirectoryId)) throw new StagingError("wrong-shape", "target");
  offset += IMPORT_REF_UUID_BYTES;
  const reviewedEntryRevision = readInteger(bytes, offset, 8);
  offset += 8;
  const recordCount = readInteger(bytes, offset, 8);
  offset += 8;
  const chunkCount = readInteger(bytes, offset, 8);
  offset += 8;
  const payloadBytes = readInteger(bytes, offset, 8);
  offset += 8;
  const commentCount = readInteger(bytes, offset, 8);
  offset += 8;
  const kindCountValue = readInteger(bytes, offset, 4);
  offset += 4;
  if (kindCountValue > Object.keys(IMPORT_RECORD_KINDS).length) throw new StagingError("wrong-shape", "kind count");
  const aggregateDigest = bytes.slice(offset, offset + 32);
  offset += 32;
  const manifestDigest = bytes.slice(offset, offset + 32);
  offset += 32;
  const manifestLength = readInteger(bytes, offset, 4);
  offset += 4;
  if (
    offset + kindCountValue * 5 > bytes.length ||
    offset + kindCountValue * 5 + manifestLength !== bytes.length ||
    manifestLength > MAX_STAGING_MANIFEST_BYTES ||
    manifestLength < 1
  )
    throw new StagingError("wrong-shape", "manifest");
  const kindCounts: ImportSessionKindCount[] = [];
  for (let index = 0; index < kindCountValue; index++) {
    const kind = STAGING_RECORD_BY_ID[bytes[offset]!];
    if (!kind) throw new StagingError("wrong-shape", "kind");
    const count = readInteger(bytes, offset + 1, 4);
    offset += 5;
    if (count < 1 || count > MAX_STAGING_RECORDS) throw new StagingError("wrong-shape", "kind count");
    kindCounts.push({ kind, count });
  }
  const manifest = bytes.slice(offset);
  if (
    !Number.isSafeInteger(reviewedEntryRevision) ||
    reviewedEntryRevision < 1 ||
    recordCount < 1 ||
    recordCount > MAX_STAGING_RECORDS ||
    chunkCount < 1 ||
    chunkCount > MAX_STAGING_CHUNKS ||
    payloadBytes < 1 ||
    payloadBytes > MAX_STAGING_PAYLOAD_BYTES ||
    commentCount < 0 ||
    commentCount > 1_000
  )
    throw new StagingError("wrong-shape", "session bounds");
  const kindTotal = kindCounts.reduce((total, entry) => total + entry.count, 0);
  if (kindTotal !== recordCount) throw new StagingError("wrong-shape", "record counts");
  const commentKinds = kindCounts
    .filter((entry) => entry.kind === "comment-body")
    .reduce((total, entry) => total + entry.count, 0);
  if (commentKinds !== commentCount) throw new StagingError("wrong-shape", "comment counts");
  return {
    metadata: {
      importId,
      targetDirectoryId,
      reviewedEntryRevision,
      recordCount,
      chunkCount,
      payloadBytes,
      commentCount,
      aggregateDigest: hex(aggregateDigest),
      manifestDigest: hex(manifestDigest),
      kindCounts,
    },
    manifest,
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The largest session-creation body: fixed routing header plus the 128 KiB manifest. */
export const MAX_IMPORT_SESSION_BODY_BYTES =
  SESSION_PREFIX.length +
  IMPORT_REF_OPAQUE_BYTES +
  IMPORT_REF_UUID_BYTES +
  8 * 5 +
  4 +
  32 +
  32 +
  4 +
  Object.keys(IMPORT_RECORD_KINDS).length * 5 +
  MAX_STAGING_MANIFEST_BYTES;

/** The largest chunk body: framing plus 50 four-reference descriptors plus one 512 KiB payload. */
export const MAX_IMPORT_CHUNK_BODY_BYTES =
  CHUNK_PREFIX.length +
  1 +
  MAX_STAGING_CHUNK_RECORDS * (1 + 4 * IMPORT_REF_OPAQUE_BYTES + 52) +
  MAX_STAGING_CHUNK_BYTES;

/** Unguessable 256-bit base64url staging ID. */
export function newStagingId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
