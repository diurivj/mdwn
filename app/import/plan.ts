/**
 * Import encrypted record and chunk plan (ticket 29).
 *
 * After a conforming review, the browser constructs the complete encrypted
 * record plan before any Import session exists: canonical `mdwn/enc-v1`
 * envelopes for every new Directory entry, Directory capability, File
 * capability, representation key, representation, signed File head, and
 * replacement payload; an encrypted `import-staging-manifest` that binds the
 * reviewed plan, chunk digests, and aggregate digests; and the bounded import
 * chunks the staging protocol will upload (ticket 30).
 *
 * Nothing here performs network I/O. A plan that would violate any canonical
 * field, descriptor, chunk, manifest, or aggregate bound throws an
 * `ImportError` and the caller creates no session and uploads nothing.
 *
 * Historical Comment records are ticket 30's extension of this plan; the
 * preflight still validates the settled 1,000-Comment bound.
 */

import { digestEnvelope, createSymmetricWriter, type EnvelopeContext } from "~/crypto/enc-v1";
import { createChildDirectoryCapability, createFileRepresentation } from "~/crypto/vault";
import { newOpaqueId } from "~/opaque-id";
import { publicPresentation, sealPublicRepresentation } from "~/publications/content";
import type { FileHead, FileHeadIdentity } from "~/tree/file-head";
import type { FileDocument } from "~/tree/file-client";
import { decodeTreeBytes, encodeTreeBytes } from "~/tree/wire";
import {
  MAX_STAGING_CHUNK_BYTES,
  MAX_STAGING_CHUNK_RECORDS,
  MAX_STAGING_CHUNKS,
  MAX_STAGING_MANIFEST_BYTES,
  MAX_STAGING_PAYLOAD_BYTES,
  MAX_STAGING_RECORDS,
  ImportError,
} from "./limits";
import type { ImportReview, ImportReviewNode } from "./review";
import type { ImportSourceFile } from "./source";

export type ImportRecordKind =
  | "entry-name"
  | "entry-order"
  | "entry-key"
  | "directory-capability"
  | "file-capability"
  | "representation-key"
  | "representation"
  | "file-head"
  | "public-representation";

export const IMPORT_RECORD_LIMITS: Readonly<Record<ImportRecordKind, number>> = {
  "entry-name": 4_096,
  "entry-order": 4_096,
  "entry-key": 16_384,
  "directory-capability": 16_384,
  "file-capability": 16_384,
  "representation-key": 16_384,
  representation: 524_288,
  "public-representation": 524_288,
  "file-head": 4_096,
};

export type ImportPlanDescriptor = {
  kind: ImportRecordKind;
  /** Opaque fixed-size IDs/references only; never a display name or capability. */
  refs: readonly string[];
  /** Byte offset of this complete record inside its chunk payload. */
  offset: number;
  length: number;
  /** Lowercase hex SHA-256 of the record bytes. */
  digest: string;
};

export type ImportPlanRecord = ImportPlanDescriptor & { bytes: Uint8Array };

export type ImportPlanChunk = {
  /** 0-based, below 40. */
  sequence: number;
  payload: Uint8Array;
  /** Lowercase hex SHA-256 of the raw payload. */
  digest: string;
  descriptors: readonly ImportPlanDescriptor[];
};

export type ImportStagingMetadata = {
  importId: string;
  vaultId: string;
  targetDirectoryId: string;
  actorAccountId: string;
  reviewedEntryRevision: number;
  recordCount: number;
  chunkCount: number;
  payloadBytes: number;
  commentCount: number;
  /** SHA-256 over the sequence-ordered raw chunk payloads. */
  aggregateDigest: string;
  /** SHA-256 of the whole canonical staging-manifest envelope. */
  manifestDigest: string;
};

export type StagingManifest = {
  format: "mdwn-import-staging";
  version: 1;
  importId: string;
  vaultId: string;
  targetDirectoryId: string;
  actorAccountId: string;
  reviewedEntryRevision: number;
  counts: {
    sources: number;
    createFiles: number;
    createDirectories: number;
    replaces: number;
    skips: number;
    records: number;
    chunks: number;
    comments: number;
  };
  bytes: { payload: number };
  chunks: readonly { sequence: number; digest: string; records: number; bytes: number }[];
  aggregateDigest: string;
  /** SHA-256 of the private review structure; binds this exact reviewed plan. */
  planDigest: string;
};

export type ImportPlan = {
  importId: string;
  review: ImportReview;
  records: readonly ImportPlanRecord[];
  chunks: readonly ImportPlanChunk[];
  manifest: {
    envelope: Uint8Array;
    manifest: StagingManifest;
    /** Server-visible routing metadata; never contains a name or capability. */
    metadata: ImportStagingMetadata;
  };
};

const encoder = new TextEncoder();

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(await sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((length, part) => length + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

/** `FileDocument` shape loadFile returns; only these fields are needed to plan a Replace. */
export type ImportReplacementDocument = Pick<FileDocument,
  "revision" | "keyEpoch" | "contentKeyId" | "representationId" | "markdown" | "metadata" |
  "capability" | "capabilityKey" | "publication">;

export type PrepareImportPlanOptions = {
  review: ImportReview;
  /** File sources keyed by canonical source path. */
  files: ReadonlyMap<string, ImportSourceFile>;
  targetKey: Uint8Array;
  /** Current File documents for every Replace candidate, keyed by File node ID. */
  replacements: ReadonlyMap<string, ImportReplacementDocument>;
  /** Signs a File head with the importing browser's device assertion key. */
  signFileHead: (identity: Omit<FileHeadIdentity, "deviceId">) => Promise<FileHead>;
  newId?: () => string;
};

function metadataContext(vaultId: string, parentId: string, nodeId: string, keyEpoch: number): EnvelopeContext {
  return { purpose: "directory-metadata", vaultId, objectId: nodeId, keyId: parentId, keyEpoch, revision: 1 };
}

async function entryRecords(parentKey: Uint8Array, vaultId: string, parentId: string, nodeId: string,
  keyEpoch: number, displayName: string, order: string): Promise<{ name: Uint8Array; order: Uint8Array }> {
  const writer = await createSymmetricWriter(parentKey);
  const context = metadataContext(vaultId, parentId, nodeId, keyEpoch);
  return {
    name: await writer.seal(encoder.encode(displayName), context),
    order: await writer.seal(encoder.encode(order), context),
  };
}

function fileHeadBytes(head: FileHead): Uint8Array {
  return concat([decodeTreeBytes(head.digest, 32), decodeTreeBytes(head.signature, 64)]);
}

/**
 * Build, measure, and chunk the complete encrypted Import plan. All canonical
 * fields are validated against the settled per-kind caps before any chunk is
 * considered, so a nonconforming plan creates no session and uploads nothing.
 */
export async function prepareImportPlan(options: PrepareImportPlanOptions): Promise<ImportPlan> {
  const review = options.review;
  const vaultId = review.target.ownerAccountId;
  const targetId = review.target.directoryId;
  const newId = options.newId ?? newOpaqueId;
  const records: ImportPlanRecord[] = [];

  const push = async (kind: ImportRecordKind, refs: readonly string[], bytes: Uint8Array): Promise<void> => {
    const limit = IMPORT_RECORD_LIMITS[kind];
    if (bytes.length > limit) {
      throw new ImportError("plan-record-too-large", { item: refs.join("/"), limit, measured: bytes.length, action: "split" });
    }
    records.push({ kind, refs, offset: 0, length: bytes.length, digest: await sha256Hex(bytes), bytes });
  };

  const planFile = async (node: ImportReviewNode, parentId: string, parentKey: Uint8Array, keyEpoch: number): Promise<void> => {
    const source = options.files.get(node.sourcePath);
    if (!source) throw new ImportError("nothing-to-import", { item: node.sourcePath, action: "fix" });
    const nodeId = newId();
    const order = newId();
    const entry = await entryRecords(parentKey, vaultId, parentId, nodeId, keyEpoch, node.displayName, order);
    await push("entry-name", [nodeId, parentId], entry.name);
    await push("entry-order", [nodeId, parentId], entry.order);
    const capability = { id: newId(), epoch: 1 };
    const scopeKey = crypto.getRandomValues(new Uint8Array(32));
    const capabilityEnvelope = await (await createSymmetricWriter(parentKey)).seal(scopeKey, {
      purpose: "file-capability", vaultId, objectId: nodeId, keyId: capability.id, keyEpoch: 1, revision: 1,
    });
    await push("file-capability", [nodeId, parentId], capabilityEnvelope);
    await pushRepresentation(scopeKey, nodeId, source.markdown, new Uint8Array(), {
      capabilityId: capability.id, capabilityEpoch: 1,
    });
  };

  const pushRepresentation = async (wrappingKey: Uint8Array, fileId: string, markdown: string, metadata: Uint8Array,
    capability: { capabilityId: string; capabilityEpoch: number }, replacement?: { revision: number; keyEpoch: number }): Promise<void> => {
    const revision = replacement?.revision ?? 1;
    const keyEpoch = replacement?.keyEpoch ?? 1;
    const contentKeyId = newId();
    const representationId = newId();
    const representation = await createFileRepresentation(wrappingKey, { markdown, metadata }, {
      vaultId, fileId, keyId: contentKeyId, keyEpoch, revision,
    });
    await push("representation-key", [fileId, representationId, contentKeyId], representation.fileContentKeyEnvelope);
    await push("representation", [fileId, representationId], representation.contentEnvelope);
    const head = await options.signFileHead({
      vaultId, fileId, capabilityId: capability.capabilityId, capabilityEpoch: capability.capabilityEpoch,
      representationId, contentKeyId, keyEpoch, revision,
      ciphertext: encodeTreeBytes(representation.contentEnvelope),
      keyEnvelope: encodeTreeBytes(representation.fileContentKeyEnvelope),
    });
    await push("file-head", [fileId, representationId], fileHeadBytes(head));
  };

  const planReplace = async (node: ImportReviewNode, parentId: string, parentKey: Uint8Array): Promise<void> => {
    const fileId = node.existingNodeId;
    const source = options.files.get(node.sourcePath);
    if (!fileId || !source) throw new ImportError("replacement-unavailable", { item: node.sourcePath, action: "fix" });
    const document = options.replacements.get(fileId);
    if (!document) throw new ImportError("replacement-unavailable", { item: node.sourcePath, action: "fix" });
    const revision = document.revision + 1;
    const keyEpoch = document.keyEpoch + 1;
    const published = document.publication && document.publication.revision !== null ? document.publication : null;
    if (published && !document.capability) {
      throw new ImportError("replacement-unavailable", { item: node.sourcePath, reason: "published-legacy", action: "fix" });
    }
    if (document.capability) {
      if (!document.capabilityKey) throw new ImportError("replacement-unavailable", { item: node.sourcePath, action: "fix" });
      await pushRepresentation(document.capabilityKey, fileId, source.markdown, document.metadata,
        { capabilityId: document.capability.id, capabilityEpoch: document.capability.epoch }, { revision, keyEpoch });
    } else {
      const contentKeyId = newId();
      const representationId = newId();
      const representation = await createFileRepresentation(parentKey, { markdown: source.markdown, metadata: document.metadata }, {
        vaultId, fileId, keyId: contentKeyId, keyEpoch, revision,
      });
      await push("entry-key", [fileId, parentId], representation.fileContentKeyEnvelope);
      await push("representation", [fileId, representationId], representation.contentEnvelope);
    }
    if (published) {
      const envelope = await sealPublicRepresentation({
        publicationId: published.publicationId, linkId: published.linkId, publicKey: published.publicKey,
        revision: published.revision! + 1,
      }, publicPresentation(source.markdown));
      await push("public-representation", [published.publicationId], envelope);
    }
  };

  const walk = async (node: ImportReviewNode, parentId: string, parentKey: Uint8Array, keyEpoch: number): Promise<void> => {
    for (const child of node.children) {
      if (child.blocked || (child.action !== "create" && child.action !== "replace")) continue;
      if (child.action === "replace") {
        await planReplace(child, parentId, parentKey);
        continue;
      }
      if (child.kind === "file") {
        await planFile(child, parentId, parentKey, keyEpoch);
        continue;
      }
      const nodeId = newId();
      const order = newId();
      const entry = await entryRecords(parentKey, vaultId, parentId, nodeId, keyEpoch, child.displayName, order);
      await push("entry-name", [nodeId, parentId], entry.name);
      await push("entry-order", [nodeId, parentId], entry.order);
      const capability = await createChildDirectoryCapability(parentKey, {
        vaultId, parentDirectoryId: parentId, childDirectoryId: nodeId,
      });
      await push("directory-capability", [nodeId, parentId], capability.envelope);
      await walk(child, nodeId, capability.capabilityKey, 1);
    }
  };

  const targetKeyEpoch = review.target.keyEpoch;
  await walk(review.tree, targetId, options.targetKey, targetKeyEpoch);
  if (!records.length) throw new ImportError("nothing-to-import", { action: "fix" });

  const chunks = await packChunks(records);
  const payloadBytes = chunks.reduce((total, chunk) => total + chunk.payload.length, 0);
  const aggregateDigest = await sha256Hex(concat(chunks.map((chunk) => chunk.payload)));
  const importId = newId();
  const manifest: StagingManifest = {
    format: "mdwn-import-staging",
    version: 1,
    importId,
    vaultId,
    targetDirectoryId: targetId,
    actorAccountId: review.target.actorAccountId,
    reviewedEntryRevision: review.target.entriesRevision,
    counts: {
      sources: review.counts.sources,
      createFiles: review.counts.createFiles,
      createDirectories: review.counts.createDirectories,
      replaces: review.counts.replaces,
      skips: review.counts.skips,
      records: records.length,
      chunks: chunks.length,
      comments: review.counts.comments,
    },
    bytes: { payload: payloadBytes },
    chunks: chunks.map((chunk) => ({ sequence: chunk.sequence, digest: chunk.digest,
      records: chunk.descriptors.length, bytes: chunk.payload.length })),
    aggregateDigest,
    planDigest: await sha256Hex(encoder.encode(canonicalPlanJson(review))),
  };
  const plaintext = encoder.encode(JSON.stringify(manifest));
  const envelope = await (await createSymmetricWriter(options.targetKey)).seal(plaintext, {
    purpose: "import-staging-manifest", vaultId, objectId: importId, keyId: targetId,
    keyEpoch: targetKeyEpoch, revision: 1,
  });
  if (envelope.length > MAX_STAGING_MANIFEST_BYTES) {
    throw new ImportError("plan-too-large", { limit: MAX_STAGING_MANIFEST_BYTES, measured: envelope.length, action: "split" });
  }
  const manifestDigest = await sha256Hex(await digestEnvelope(envelope));
  return {
    importId,
    review,
    records,
    chunks,
    manifest: {
      envelope,
      manifest,
      metadata: {
        importId, vaultId, targetDirectoryId: targetId, actorAccountId: review.target.actorAccountId,
        reviewedEntryRevision: review.target.entriesRevision, recordCount: records.length,
        chunkCount: chunks.length, payloadBytes, commentCount: review.counts.comments,
        aggregateDigest, manifestDigest,
      },
    },
  };
}

/** Canonical private plan binding; hashed into the manifest, never uploaded. */
function canonicalPlanJson(review: ImportReview): string {
  return JSON.stringify({
    targetDirectoryId: review.target.directoryId,
    reviewedEntryRevision: review.target.entriesRevision,
    nodes: review.nodes.map((node) => ({
      sourcePath: node.sourcePath,
      kind: node.kind,
      action: node.action,
      displayName: node.displayName,
      existingNodeId: node.existingNodeId,
      generated: node.generated,
    })),
  });
}

async function packChunks(records: readonly ImportPlanRecord[]): Promise<ImportPlanChunk[]> {
  const chunks: ImportPlanChunk[] = [];
  let payloads: Uint8Array[] = [];
  let descriptors: ImportPlanDescriptor[] = [];
  let bytes = 0;
  const flush = async (): Promise<void> => {
    if (!descriptors.length) return;
    if (chunks.length >= MAX_STAGING_CHUNKS) {
      throw new ImportError("plan-too-large", { limit: MAX_STAGING_CHUNKS, measured: chunks.length + 1, action: "split" });
    }
    const payload = concat(payloads);
    chunks.push({ sequence: chunks.length, payload, digest: await sha256Hex(payload), descriptors });
    payloads = [];
    descriptors = [];
    bytes = 0;
  };
  for (const record of records) {
    if (record.bytes.length > MAX_STAGING_CHUNK_BYTES) {
      throw new ImportError("plan-record-too-large", { item: record.refs.join("/"), limit: MAX_STAGING_CHUNK_BYTES, measured: record.bytes.length, action: "split" });
    }
    if (descriptors.length >= MAX_STAGING_CHUNK_RECORDS || bytes + record.bytes.length > MAX_STAGING_CHUNK_BYTES) {
      await flush();
    }
    descriptors.push({
      kind: record.kind, refs: record.refs, offset: bytes, length: record.bytes.length, digest: record.digest,
    });
    payloads.push(record.bytes);
    bytes += record.bytes.length;
  }
  await flush();
  const total = chunks.reduce((sum, chunk) => sum + chunk.payload.length, 0);
  if (total > MAX_STAGING_PAYLOAD_BYTES) {
    throw new ImportError("plan-too-large", { limit: MAX_STAGING_PAYLOAD_BYTES, measured: total, action: "split" });
  }
  if (records.length > MAX_STAGING_RECORDS) {
    throw new ImportError("plan-too-large", { limit: MAX_STAGING_RECORDS, measured: records.length, action: "split" });
  }
  return chunks;
}
