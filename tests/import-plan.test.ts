import { describe, expect, it } from "vitest";

import { createPublicationKeyPair, newPublicationIdentifier } from "../app/shared/publications/capability";
import { digestEnvelope, openSymmetric } from "../app/shared/crypto/enc-v1";
import { encodeTreeBytes } from "../app/shared/tree/wire";
import { IMPORT_LIMITS, ImportError } from "../app/shared/import/limits";
import { prepareImportPlan, type ImportPlan, type ImportReplacementDocument } from "../app/shared/import/plan";
import { encodeImportChunkBody } from "../app/shared/import/staging";
import { reviewImport, type ImportChoice, type ImportCollisionSibling, type ImportTarget } from "../app/shared/import/review";
import { analyzeImportSelection, type ImportSource, type ImportSourceFile } from "../app/shared/import/source";
import type { HistoricalComment } from "../app/shared/archive/format";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const TARGET_ID = "0198c0de-0000-7000-8000-0000000000aa";
const EXISTING_FILE_ID = "0198c0de-0000-7000-8000-0000000000bb";

function target(siblings: readonly ImportCollisionSibling[] = []): ImportTarget {
  return { directoryId: TARGET_ID, keyEpoch: 1, entriesRevision: 2, ownerAccountId: "owner-id",
    actorAccountId: "owner-id", label: "Files", siblings, listing: [] };
}

const listingHead = {
  ciphertext: encodeTreeBytes(encoder.encode("listing")),
  digest: encodeTreeBytes(new Uint8Array(32).fill(3)),
  signature: encodeTreeBytes(new Uint8Array(64).fill(4)),
};

async function makePlan(paths: readonly string[], options: {
  siblings?: readonly ImportCollisionSibling[];
  choices?: Record<string, ImportChoice>;
  replacements?: Map<string, ImportReplacementDocument>;
  markdowns?: Record<string, string>;
} = {}): Promise<{ plan: ImportPlan; source: ImportSource; targetKey: Uint8Array }> {
  const source = await analyzeImportSelection(paths.map((path) => ({
    path, bytes: encoder.encode(options.markdowns?.[path] ?? "x"),
  })));
  const planTarget = target(options.siblings);
  const review = reviewImport(source, planTarget, options.choices ?? {});
  const files = new Map<string, ImportSourceFile>();
  const collect = (children: readonly ImportSourceChild[], files: Map<string, ImportSourceFile>): void => {
    for (const child of children) {
      if (child.kind === "file") files.set(child.path.join("/"), child);
      else collect(child.children, files);
    }
  };
  collect(source.roots, files);
  const targetKey = crypto.getRandomValues(new Uint8Array(32));
  const plan = await prepareImportPlan({
    review, files, targetKey, replacements: options.replacements ?? new Map(),
    signFileHead: async () => ({
      digest: encodeTreeBytes(new Uint8Array(32).fill(1)),
      signature: encodeTreeBytes(new Uint8Array(64).fill(2)),
    }),
    signListingHead: async () => listingHead,
  });
  return { plan, source, targetKey };
}

import type { ImportSourceChild } from "../app/shared/import/source";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readManifest(plan: ImportPlan, targetKey: Uint8Array) {
  const bytes = await openSymmetric(plan.manifest.envelope, targetKey, { context: {
    purpose: "import-staging-manifest", vaultId: "owner-id", objectId: plan.importId,
    keyId: TARGET_ID, keyEpoch: 1, revision: 1,
  }, manifestDigest: await digestEnvelope(plan.manifest.envelope) });
  return JSON.parse(decoder.decode(bytes)) as {
    counts: Record<string, number>; bytes: { payload: number }; chunks: { sequence: number; digest: string; records: number; bytes: number }[];
    aggregateDigest: string; planDigest: string;
  };
}

describe("import plan: complete encrypted record and chunk plan", () => {
  it("constructs canonical records and measures every chunk and digest", async () => {
    const { plan, targetKey } = await makePlan(["notes/draft.md"]);
    expect(plan.records.map((record) => record.kind)).toEqual([
      "node-directory", "entry-name", "entry-order", "directory-capability",
      "node-file", "entry-name", "entry-order", "file-capability", "representation-key", "representation", "file-head",
      "listing-ciphertext", "listing-digest", "listing-signature",
      "listing-ciphertext", "listing-digest", "listing-signature",
    ]);
    expect(plan.chunks.length).toBe(1);
    for (const chunk of plan.chunks) {
      expect(chunk.payload.length).toBeLessThanOrEqual(524_288);
      expect(chunk.descriptors.length).toBeLessThanOrEqual(50);
      let offset = 0;
      for (const descriptor of chunk.descriptors) {
        expect(descriptor.offset).toBe(offset);
        expect(descriptor.digest).toBe(await sha256Hex(chunk.payload.subarray(offset, offset + descriptor.length)));
        offset += descriptor.length;
      }
      expect(offset).toBe(chunk.payload.length);
      expect(chunk.digest).toBe(await sha256Hex(encodeImportChunkBody(chunk.descriptors, chunk.payload)));
    }
    const concatenated = new Uint8Array(plan.chunks.length * 32);
    plan.chunks.forEach((chunk, index) => concatenated.set(
      Uint8Array.from(chunk.digest.match(/../g)!.map((byte) => Number.parseInt(byte, 16))), index * 32));
    expect(plan.manifest.metadata.aggregateDigest).toBe(await sha256Hex(concatenated));
    expect(plan.manifest.metadata.chunkCount).toBe(plan.chunks.length);
    expect(plan.manifest.metadata.recordCount).toBe(plan.records.length);
    expect(plan.manifest.metadata.manifestDigest).toBe(
      Array.from(await digestEnvelope(plan.manifest.envelope), (byte) => byte.toString(16).padStart(2, "0")).join(""));

    const manifest = await readManifest(plan, targetKey);
    expect(manifest.counts).toMatchObject({ sources: 2, createFiles: 1, createDirectories: 1, records: 17, chunks: 1 });
    expect(manifest.bytes.payload).toBe(plan.manifest.metadata.payloadBytes);
    expect(manifest.chunks[0]).toMatchObject({ sequence: 0, digest: plan.chunks[0]!.digest,
      records: plan.chunks[0]!.descriptors.length });
    expect(manifest.aggregateDigest).toBe(plan.manifest.metadata.aggregateDigest);
    expect(manifest.planDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("imports only comments attached to Files that survive the review", async () => {
    const history: HistoricalComment[] = [{ sequence: 1, text: "kept", pseudonym: "Old Me", createdAt: 1, updatedAt: 1 }];
    const source: ImportSource = {
      kind: "loose",
      roots: [{ kind: "file", path: ["draft.md"], name: "draft.md", markdown: "# hi", bytes: 4 }],
      nodes: [{ path: "draft.md", kind: "file", name: "draft.md" }],
      comments: new Map([["draft.md", history]]),
      nodeCount: 1, maxDepth: 0, sourceBytes: 4, compressedBytes: null, expandedBytes: 4, commentCount: 1,
    };
    const files = new Map<string, ImportSourceFile>([["draft.md", source.roots[0] as ImportSourceFile]]);
    const targetKey = crypto.getRandomValues(new Uint8Array(32));
    const build = (choices: Record<string, ImportChoice>) => prepareImportPlan({
      review: reviewImport(source, target([{ nodeId: "existing", kind: "file", name: "draft.md" }]), choices),
      files, comments: source.comments, targetKey, replacements: new Map(),
      signFileHead: async () => ({ digest: encodeTreeBytes(new Uint8Array(32).fill(1)),
        signature: encodeTreeBytes(new Uint8Array(64).fill(2)) }),
      signListingHead: async () => listingHead,
    });
    // A skipped commented File emits nothing at all, rather than tripping the
    // comment-count equality check deep in the plan.
    await expect(build({ "draft.md": { action: "skip" } })).rejects.toMatchObject({ code: "nothing-to-import" });
    const kept = await build({ "draft.md": { action: "keep_both" } });
    expect(kept.records.filter((record) => record.kind === "comment-body")).toHaveLength(1);
    expect(kept.records.some((record) => record.kind === "comment-meta")).toBe(true);
  });

  it("rejects a 1,001st Historical Comment before any session exists", async () => {
    const history: HistoricalComment[] = Array.from({ length: 1_001 }, (_, index) => ({
      sequence: index + 1, text: `n${index}`, pseudonym: "Old Me", createdAt: index, updatedAt: index,
    }));
    const source: ImportSource = {
      kind: "loose",
      roots: [{ kind: "file", path: ["draft.md"], name: "draft.md", markdown: "# hi", bytes: 4 }],
      nodes: [{ path: "draft.md", kind: "file", name: "draft.md" }],
      comments: new Map([["draft.md", history]]),
      nodeCount: 1, maxDepth: 0, sourceBytes: 4, compressedBytes: null, expandedBytes: 4, commentCount: 1_001,
    };
    const files = new Map<string, ImportSourceFile>([["draft.md", source.roots[0] as ImportSourceFile]]);
    await expect(prepareImportPlan({
      review: reviewImport(source, target()),
      files, comments: source.comments, targetKey: crypto.getRandomValues(new Uint8Array(32)), replacements: new Map(),
      signFileHead: async () => ({ digest: encodeTreeBytes(new Uint8Array(32).fill(1)),
        signature: encodeTreeBytes(new Uint8Array(64).fill(2)) }),
      signListingHead: async () => listingHead,
    })).rejects.toMatchObject({ code: "too-many-comments" });
  });

  it("keeps a maximum-source representation inside its canonical bound", async () => {
    const markdown = "a".repeat(IMPORT_LIMITS.maxSourceBytes);
    const { plan } = await makePlan(["big.md"], { markdowns: { "big.md": markdown } });
    const representation = plan.records.find((record) => record.kind === "representation")!;
    expect(representation.bytes.length).toBeGreaterThan(IMPORT_LIMITS.maxSourceBytes);
    expect(representation.bytes.length).toBeLessThanOrEqual(524_288);
  });

  it("bounds descriptors per chunk and chunks per session for a 100-node selection", async () => {
    const paths = Array.from({ length: 100 }, (_, index) => `f${String(index).padStart(3, "0")}.md`);
    const { plan } = await makePlan(paths);
    expect(plan.records.length).toBe(703);
    expect(plan.chunks.length).toBe(15);
    for (const chunk of plan.chunks) {
      expect(chunk.descriptors.length).toBeLessThanOrEqual(50);
      expect(chunk.payload.length).toBeLessThanOrEqual(524_288);
    }
    const total = plan.chunks.reduce((sum, chunk) => sum + chunk.payload.length, 0);
    expect(total).toBeLessThanOrEqual(20_971_520);
  });

  it("plans a File Replace as a new representation while preserving identity", async () => {
    const document: ImportReplacementDocument = {
      revision: 3, keyEpoch: 2, contentKeyId: "0198c0de-0000-7000-8000-0000000000cc", representationId: "0198c0de-0000-7000-8000-0000000000dd",
      markdown: "old", metadata: new Uint8Array(), capability: { id: "0198c0de-0000-7000-8000-0000000000ee", epoch: 1 },
      capabilityKey: crypto.getRandomValues(new Uint8Array(32)), publication: null,
    };
    const { plan } = await makePlan(["draft.md"], {
      siblings: [{ nodeId: EXISTING_FILE_ID, kind: "file", name: "draft.md" }],
      choices: { "draft.md": { action: "replace" } },
      replacements: new Map([[EXISTING_FILE_ID, document]]),
      markdowns: { "draft.md": "replacement" },
    });
    expect(plan.records.map((record) => record.kind)).toEqual([
      "replace", "representation-key", "representation", "file-head",
      "listing-ciphertext", "listing-digest", "listing-signature",
    ]);
    expect(plan.review.nodes[0]!.existingNodeId).toBe(EXISTING_FILE_ID);
  });

  it("pairs an active Publication on Replace", async () => {
    const { publicKey } = await createPublicationKeyPair();
    const document: ImportReplacementDocument = {
      revision: 1, keyEpoch: 1, contentKeyId: "0198c0de-0000-7000-8000-0000000000cc", representationId: "0198c0de-0000-7000-8000-0000000000dd",
      markdown: "old", metadata: new Uint8Array(), capability: { id: "0198c0de-0000-7000-8000-0000000000ee", epoch: 1 },
      capabilityKey: crypto.getRandomValues(new Uint8Array(32)),
      publication: { publicationId: newPublicationIdentifier(), linkId: newPublicationIdentifier(),
        publicKey, revision: 1, declaration: null },
    };
    const { plan } = await makePlan(["draft.md"], {
      siblings: [{ nodeId: EXISTING_FILE_ID, kind: "file", name: "draft.md" }],
      choices: { "draft.md": { action: "replace" } },
      replacements: new Map([[EXISTING_FILE_ID, document]]),
    });
    expect(plan.records.map((record) => record.kind)).toEqual([
      "replace", "representation-key", "representation", "file-head", "public-representation",
      "listing-ciphertext", "listing-digest", "listing-signature",
    ]);
  });

  it("fails closed for a Replace the plan cannot represent", async () => {
    const publishedLegacy: ImportReplacementDocument = {
      revision: 1, keyEpoch: 1, contentKeyId: "0198c0de-0000-7000-8000-0000000000cc", representationId: "0198c0de-0000-7000-8000-0000000000dd",
      markdown: "old", metadata: new Uint8Array(), capability: null, capabilityKey: null,
      publication: { publicationId: newPublicationIdentifier(), linkId: newPublicationIdentifier(),
        publicKey: (await createPublicationKeyPair()).publicKey, revision: 1, declaration: null },
    };
    await expect(makePlan(["draft.md"], {
      siblings: [{ nodeId: EXISTING_FILE_ID, kind: "file", name: "draft.md" }],
      choices: { "draft.md": { action: "replace" } },
      replacements: new Map([["file-1", publishedLegacy]]),
    })).rejects.toMatchObject({ code: "replacement-unavailable" });

    await expect(makePlan(["draft.md"], {
      siblings: [{ nodeId: EXISTING_FILE_ID, kind: "file", name: "draft.md" }],
      choices: { "draft.md": { action: "replace" } },
    })).rejects.toBeInstanceOf(ImportError);
  });
});
