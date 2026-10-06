import { describe, expect, it } from "vitest";

import type { ImportPlanDescriptor } from "../app/shared/import/plan";
import {
  MAX_IMPORT_CHUNK_BODY_BYTES,
  decodeImportChunkBody,
  decodeImportSessionBody,
  encodeImportChunkBody,
  encodeImportSessionBody,
  verifyChunkDigests,
  type ImportSessionMetadata,
} from "../app/shared/import/staging";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function uuid(): string {
  const value = crypto.randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

function opaque(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function descriptor(
  kind: ImportPlanDescriptor["kind"],
  refs: string[],
  bytes: Uint8Array,
  offset: number,
): Promise<ImportPlanDescriptor> {
  return { kind, refs, offset, length: bytes.length, digest: await digestHex(bytes) };
}

function sessionMetadata(overrides: Partial<ImportSessionMetadata> = {}): ImportSessionMetadata {
  return {
    importId: opaque(),
    targetDirectoryId: uuid(),
    reviewedEntryRevision: 3,
    recordCount: 2,
    chunkCount: 1,
    payloadBytes: 10,
    commentCount: 1,
    aggregateDigest: "a".repeat(64),
    manifestDigest: "b".repeat(64),
    kindCounts: [
      { kind: "node-file", count: 1 },
      { kind: "comment-body", count: 1 },
    ],
    ...overrides,
  };
}

describe("import staging wire format", () => {
  it("round-trips the session body and the encrypted manifest", () => {
    const manifest = encoder.encode("manifest bytes");
    const metadata = sessionMetadata();
    const decoded = decodeImportSessionBody(encodeImportSessionBody(metadata, manifest));
    expect(decoded.metadata).toEqual(metadata);
    expect(decoder.decode(decoded.manifest)).toBe("manifest bytes");
  });

  it("rejects a session body whose counts do not agree", () => {
    const manifest = encoder.encode("m");
    expect(() =>
      decodeImportSessionBody(encodeImportSessionBody(sessionMetadata({ recordCount: 3 }), manifest)),
    ).toThrow();
    expect(() =>
      decodeImportSessionBody(encodeImportSessionBody(sessionMetadata({ commentCount: 0 }), manifest)),
    ).toThrow();
    const body = encodeImportSessionBody(sessionMetadata(), manifest);
    body[body.length - 1] = body[body.length - 1]! ^ 0xff;
    expect(() => decodeImportSessionBody(body)).not.toThrow();
  });

  it("rejects malformed session framing", () => {
    const manifest = encoder.encode("m");
    const body = encodeImportSessionBody(sessionMetadata(), manifest);
    const bad = new Uint8Array(body);
    bad[0] = 0;
    expect(() => decodeImportSessionBody(bad)).toThrow();
    expect(() => decodeImportSessionBody(new Uint8Array(8))).toThrow();
    expect(() => decodeImportSessionBody(new Uint8Array(MAX_IMPORT_CHUNK_BODY_BYTES + 1))).toThrow();
  });

  it("round-trips a typed chunk and verifies every descriptor digest", async () => {
    const fileId = uuid(),
      representationId = uuid(),
      contentKeyId = uuid();
    const recordA = encoder.encode("name");
    const recordB = encoder.encode("representation payload");
    const descriptors = [
      await descriptor("entry-name", [fileId, uuid()], recordA, 0),
      await descriptor("representation", [fileId, representationId, contentKeyId], recordB, recordA.length),
    ];
    const payload = new Uint8Array([...recordA, ...recordB]);
    const decoded = decodeImportChunkBody(encodeImportChunkBody(descriptors, payload));
    expect(decoded.descriptors.map((item) => item.kind)).toEqual(["entry-name", "representation"]);
    expect(decoded.descriptors.map((item) => item.refs)).toEqual(descriptors.map((item) => item.refs));
    expect(decoded.payload).toEqual(payload);
    expect(await verifyChunkDigests(decoded)).toBe(true);

    const tampered = new Uint8Array(decoded.payload);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    expect(await verifyChunkDigests({ ...decoded, payload: tampered })).toBe(false);
  });

  it("rejects a 51st descriptor, an uncovered byte, and a wrong reference shape", () => {
    const refs = [uuid(), uuid(), uuid()];
    const bytes = encoder.encode("r");
    const descriptors = Array.from({ length: 51 }, (_, index) => ({
      kind: "representation" as const,
      refs,
      offset: index,
      length: 1,
      digest: "0".repeat(64),
    }));
    expect(() => encodeImportChunkBody(descriptors, new Uint8Array(51))).toThrow();
    expect(() =>
      encodeImportChunkBody(
        [{ kind: "representation", refs, offset: 0, length: 2, digest: "0".repeat(64) }],
        encoder.encode("r"),
      ),
    ).toThrow();
    expect(() =>
      encodeImportChunkBody(
        [{ kind: "representation", refs: [uuid(), uuid(), "not-an-id"], offset: 0, length: 1, digest: "0".repeat(64) }],
        encoder.encode("r"),
      ),
    ).toThrow();
    const body = encodeImportChunkBody(
      [{ kind: "representation", refs: [uuid(), uuid(), uuid()], offset: 0, length: 1, digest: "0".repeat(64) }],
      encoder.encode("r"),
    );
    expect(() => decodeImportChunkBody(body.subarray(0, body.length - 1))).toThrow();
  });
});
