import { describe, expect, it } from "vitest";

import { createPublicationKeyPair, newPublicationIdentifier } from "../app/publications/capability";
import { digestEnvelope, openSymmetric } from "../app/crypto/enc-v1";
import { encodeTreeBytes } from "../app/tree/wire";
import { IMPORT_LIMITS, ImportError } from "../app/import/limits";
import { prepareImportPlan, type ImportPlan, type ImportReplacementDocument } from "../app/import/plan";
import { reviewImport, type ImportChoice, type ImportCollisionSibling, type ImportTarget } from "../app/import/review";
import { analyzeImportSelection, type ImportSource, type ImportSourceFile } from "../app/import/source";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function target(siblings: readonly ImportCollisionSibling[] = []): ImportTarget {
  return { directoryId: "target-id", keyEpoch: 1, entriesRevision: 2, ownerAccountId: "owner-id",
    actorAccountId: "owner-id", label: "Files", siblings };
}

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
  });
  return { plan, source, targetKey };
}

import type { ImportSourceChild } from "../app/import/source";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readManifest(plan: ImportPlan, targetKey: Uint8Array) {
  const bytes = await openSymmetric(plan.manifest.envelope, targetKey, { context: {
    purpose: "import-staging-manifest", vaultId: "owner-id", objectId: plan.importId,
    keyId: "target-id", keyEpoch: 1, revision: 1,
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
      "entry-name", "entry-order", "directory-capability",
      "entry-name", "entry-order", "file-capability", "representation-key", "representation", "file-head",
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
      expect(chunk.digest).toBe(await sha256Hex(chunk.payload));
    }
    const concatenated = new Uint8Array(plan.chunks.reduce((total, chunk) => total + chunk.payload.length, 0));
    let offset = 0;
    for (const chunk of plan.chunks) { concatenated.set(chunk.payload, offset); offset += chunk.payload.length; }
    expect(plan.manifest.metadata.aggregateDigest).toBe(await sha256Hex(concatenated));
    expect(plan.manifest.metadata.chunkCount).toBe(plan.chunks.length);
    expect(plan.manifest.metadata.recordCount).toBe(plan.records.length);

    const manifest = await readManifest(plan, targetKey);
    expect(manifest.counts).toMatchObject({ sources: 2, createFiles: 1, createDirectories: 1, records: 9, chunks: 1 });
    expect(manifest.bytes.payload).toBe(plan.manifest.metadata.payloadBytes);
    expect(manifest.chunks[0]).toMatchObject({ sequence: 0, digest: plan.chunks[0]!.digest,
      records: plan.chunks[0]!.descriptors.length });
    expect(manifest.aggregateDigest).toBe(plan.manifest.metadata.aggregateDigest);
    expect(manifest.planDigest).toMatch(/^[0-9a-f]{64}$/);
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
    expect(plan.records.length).toBe(600);
    expect(plan.chunks.length).toBe(12);
    for (const chunk of plan.chunks) {
      expect(chunk.descriptors.length).toBeLessThanOrEqual(50);
      expect(chunk.payload.length).toBeLessThanOrEqual(524_288);
    }
    const total = plan.chunks.reduce((sum, chunk) => sum + chunk.payload.length, 0);
    expect(total).toBeLessThanOrEqual(20_971_520);
  });

  it("plans a File Replace as a new representation while preserving identity", async () => {
    const document: ImportReplacementDocument = {
      revision: 3, keyEpoch: 2, contentKeyId: "content-key", representationId: "old-representation",
      markdown: "old", metadata: new Uint8Array(), capability: { id: "capability-id", epoch: 1 },
      capabilityKey: crypto.getRandomValues(new Uint8Array(32)), publication: null,
    };
    const { plan } = await makePlan(["draft.md"], {
      siblings: [{ nodeId: "file-1", kind: "file", name: "draft.md" }],
      choices: { "draft.md": { action: "replace" } },
      replacements: new Map([["file-1", document]]),
      markdowns: { "draft.md": "replacement" },
    });
    expect(plan.records.map((record) => record.kind)).toEqual(["representation-key", "representation", "file-head"]);
    expect(plan.review.nodes[0]!.existingNodeId).toBe("file-1");
  });

  it("pairs an active Publication on Replace", async () => {
    const { publicKey } = await createPublicationKeyPair();
    const document: ImportReplacementDocument = {
      revision: 1, keyEpoch: 1, contentKeyId: "content-key", representationId: "old-representation",
      markdown: "old", metadata: new Uint8Array(), capability: { id: "capability-id", epoch: 1 },
      capabilityKey: crypto.getRandomValues(new Uint8Array(32)),
      publication: { publicationId: newPublicationIdentifier(), linkId: newPublicationIdentifier(),
        publicKey, revision: 1, declaration: null },
    };
    const { plan } = await makePlan(["draft.md"], {
      siblings: [{ nodeId: "file-1", kind: "file", name: "draft.md" }],
      choices: { "draft.md": { action: "replace" } },
      replacements: new Map([["file-1", document]]),
    });
    expect(plan.records.map((record) => record.kind)).toEqual([
      "representation-key", "representation", "file-head", "public-representation",
    ]);
  });

  it("fails closed for a Replace the plan cannot represent", async () => {
    const publishedLegacy: ImportReplacementDocument = {
      revision: 1, keyEpoch: 1, contentKeyId: "content-key", representationId: "old-representation",
      markdown: "old", metadata: new Uint8Array(), capability: null, capabilityKey: null,
      publication: { publicationId: newPublicationIdentifier(), linkId: newPublicationIdentifier(),
        publicKey: (await createPublicationKeyPair()).publicKey, revision: 1, declaration: null },
    };
    await expect(makePlan(["draft.md"], {
      siblings: [{ nodeId: "file-1", kind: "file", name: "draft.md" }],
      choices: { "draft.md": { action: "replace" } },
      replacements: new Map([["file-1", publishedLegacy]]),
    })).rejects.toMatchObject({ code: "replacement-unavailable" });

    await expect(makePlan(["draft.md"], {
      siblings: [{ nodeId: "file-1", kind: "file", name: "draft.md" }],
      choices: { "draft.md": { action: "replace" } },
    })).rejects.toBeInstanceOf(ImportError);
  });
});
