/**
 * Import encrypted record and chunk plan (tickets 29–30).
 *
 * After a conforming review, the browser constructs the complete encrypted
 * record plan before any Import session exists: canonical `mdwn/enc-v1`
 * envelopes and typed structural records for every new Directory/File,
 * capability, representation, signed File head, replacement, paired Public
 * representation, and Historical Comment thread; an encrypted
 * `import-staging-manifest` that binds the reviewed plan, chunk digests, and
 * aggregate digests; and the bounded import chunks the staging protocol
 * uploads.
 *
 * Nothing here performs network I/O. A plan that would violate any canonical
 * field, descriptor, chunk, manifest, or aggregate bound throws an
 * `ImportError` and the caller creates no session and uploads nothing.
 *
 * A descriptor carries only a typed record kind, opaque fixed-size references,
 * the exact byte range inside the chunk payload, and the record's SHA-256
 * digest. Structural records (`node-*`, `file-head`, `replace`,
 * `comment-meta`) carry only fixed canonical bytes; every other record is one
 * complete encrypted envelope occupying exactly one descriptor range.
 */

import { createSymmetricWriter, type EnvelopeContext } from "~/shared/crypto/enc-v1";
import { sealAttribution, sealCommentBody } from "~/shared/comments/content";
import { createChildDirectoryCapability, createFileRepresentation } from "~/shared/crypto/vault";
import { newOpaqueId } from "~/shared/opaque-id";
import { publicPresentation, sealPublicRepresentation } from "~/shared/publications/content";
import type { HistoricalComment } from "~/shared/archive/format";
import type { FileHead, FileHeadIdentity } from "~/shared/tree/file-head";
import type { FileDocument } from "~/shared/tree/file-client";
import {
  IMPORT_RECORD_KINDS,
  encodeImportChunkBody,
  envelopeDigestHex,
  newStagingId,
  type ImportSessionMetadata,
  type ImportSessionKindCount,
  type StagingRecordKind,
} from "./staging";
import {
  MAX_STAGING_CHUNK_BYTES,
  MAX_STAGING_CHUNK_RECORDS,
  MAX_STAGING_CHUNKS,
  MAX_STAGING_MANIFEST_BYTES,
  MAX_STAGING_PAYLOAD_BYTES,
  MAX_STAGING_RECORDS,
  ImportError,
} from "./limits";
import type { ImportListingEntry, ImportReview, ImportReviewNode } from "./review";
import type { ImportSourceFile } from "./source";

export type ImportPlanDescriptor = {
  kind: StagingRecordKind;
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
  /** Lowercase hex SHA-256 of the encoded chunk body (framing + payload). */
  digest: string;
  descriptors: readonly ImportPlanDescriptor[];
};

export type ImportStagingMetadata = ImportSessionMetadata & {
  importId: string;
  vaultId: string;
  targetOwnerId: string;
  actorAccountId: string;
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
  kinds: readonly ImportSessionKindCount[];
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

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeHexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await sha256(bytes));
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

/** `FileDocument` shape loadFile returns; only these fields are needed to plan a Replace. */
export type ImportReplacementDocument = Pick<
  FileDocument,
  | "revision"
  | "keyEpoch"
  | "contentKeyId"
  | "representationId"
  | "markdown"
  | "metadata"
  | "capability"
  | "capabilityKey"
  | "publication"
>;

export type ImportListingHead = { ciphertext: string; digest: string; signature: string };

/** The importing browser's signers for one prepared plan. */
export type ImportSigners = {
  /** Signs a File head with the importing browser's device assertion key. */
  signFileHead: (identity: Omit<FileHeadIdentity, "deviceId">) => Promise<FileHead>;
  /** Signs a post-Import Directory listing head with the same device key. */
  signListingHead: (input: {
    parentKey: Uint8Array;
    vaultId: string;
    directoryId: string;
    keyEpoch: number;
    revision: number;
    entries: readonly ImportListingEntry[];
  }) => Promise<ImportListingHead>;
};

export type PrepareImportPlanOptions = {
  review: ImportReview;
  /** File sources keyed by canonical source path. */
  files: ReadonlyMap<string, ImportSourceFile>;
  /** Sidecar Historical Comments keyed by canonical source path. */
  comments?: ReadonlyMap<string, readonly HistoricalComment[]>;
  targetKey: Uint8Array;
  /** Current File documents for every Replace candidate, keyed by File node ID. */
  replacements: ReadonlyMap<string, ImportReplacementDocument>;
  newId?: () => string;
} & ImportSigners;

function metadataContext(vaultId: string, parentId: string, nodeId: string, keyEpoch: number): EnvelopeContext {
  return { purpose: "directory-metadata", vaultId, objectId: nodeId, keyId: parentId, keyEpoch, revision: 1 };
}

async function entryRecords(
  parentKey: Uint8Array,
  vaultId: string,
  parentId: string,
  nodeId: string,
  keyEpoch: number,
  displayName: string,
  order: string,
): Promise<{ name: Uint8Array; order: Uint8Array }> {
  const writer = await createSymmetricWriter(parentKey);
  const context = metadataContext(vaultId, parentId, nodeId, keyEpoch);
  return {
    name: await writer.seal(encoder.encode(displayName), context),
    order: await writer.seal(encoder.encode(order), context),
  };
}

function fileHeadBytes(head: FileHead): Uint8Array {
  const digest = decodeImportBytes(head.digest, 32),
    signature = decodeImportBytes(head.signature, 64);
  if (digest.length !== 32 || signature.length !== 64)
    throw new ImportError("plan-record-too-large", { action: "fix" });
  return concat([digest, signature]);
}

function u64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function decodeImportBytes(value: string, max: number): Uint8Array {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length < 1 || bytes.length > max) throw new ImportError("plan-record-too-large", { action: "fix" });
  return bytes;
}

/** One canonical Comment record: `comment-meta`, body, and content-key wrapper. */

/**
 * Build, measure, and chunk the complete encrypted Import plan. All canonical
 * fields are validated against the settled per-kind caps before any chunk is
 * considered, so a nonconforming plan creates no session and uploads nothing.
 */
export async function prepareImportPlan(options: PrepareImportPlanOptions): Promise<ImportPlan> {
  const review = options.review;
  const comments = options.comments ?? new Map();
  const vaultId = review.target.ownerAccountId;
  const targetId = review.target.directoryId;
  const newId = options.newId ?? newOpaqueId;
  const records: ImportPlanRecord[] = [];
  let commentRecords = 0;

  const push = async (kind: StagingRecordKind, refs: readonly string[], bytes: Uint8Array): Promise<void> => {
    const limit = IMPORT_RECORD_KINDS[kind].max;
    if (bytes.length < IMPORT_RECORD_KINDS[kind].min || bytes.length > limit) {
      throw new ImportError("plan-record-too-large", {
        item: refs.join("/"),
        limit,
        measured: bytes.length,
        action: "split",
      });
    }
    records.push({ kind, refs, offset: 0, length: bytes.length, digest: await sha256Hex(bytes), bytes });
  };

  const planFile = async (
    node: ImportReviewNode,
    parentId: string,
    parentKey: Uint8Array,
    keyEpoch: number,
  ): Promise<ImportListingEntry> => {
    const source = options.files.get(node.sourcePath);
    if (!source) throw new ImportError("nothing-to-import", { item: node.sourcePath, action: "fix" });
    const nodeId = newId();
    const order = newId();
    await push("node-file", [nodeId, parentId], new Uint8Array());
    const entry = await entryRecords(parentKey, vaultId, parentId, nodeId, keyEpoch, node.displayName, order);
    await push("entry-name", [nodeId, parentId], entry.name);
    await push("entry-order", [nodeId, parentId], entry.order);
    const capability = { id: newId(), epoch: 1 };
    const scopeKey = crypto.getRandomValues(new Uint8Array(32));
    const capabilityEnvelope = await (await createSymmetricWriter(parentKey)).seal(scopeKey, {
      purpose: "file-capability",
      vaultId,
      objectId: nodeId,
      keyId: capability.id,
      keyEpoch: 1,
      revision: 1,
    });
    await push("file-capability", [nodeId, parentId, capability.id], capabilityEnvelope);
    await pushRepresentation(scopeKey, nodeId, source.markdown, new Uint8Array(), {
      capabilityId: capability.id,
      capabilityEpoch: 1,
    });
    await planComments(node, nodeId, scopeKey);
    return {
      nodeId,
      kind: "file",
      nameCiphertext: encodeBytes(entry.name),
      orderCiphertext: encodeBytes(entry.order),
      keyEnvelope: encodeBytes(capabilityEnvelope),
    };
  };

  const pushListing = async (
    directoryId: string,
    keyEpoch: number,
    revision: number,
    parentKey: Uint8Array,
    entries: readonly ImportListingEntry[],
  ): Promise<void> => {
    const head = await options.signListingHead({ parentKey, vaultId, directoryId, keyEpoch, revision, entries });
    const ciphertext = decodeImportBytes(head.ciphertext, 524_288);
    const digest = decodeImportBytes(head.digest, 32);
    const signature = decodeImportBytes(head.signature, 64);
    if (digest.length !== 32 || signature.length !== 64)
      throw new ImportError("plan-record-too-large", { action: "fix" });
    await push("listing-ciphertext", [directoryId], ciphertext);
    await push("listing-digest", [directoryId], digest);
    await push("listing-signature", [directoryId], signature);
  };

  const planComments = async (node: ImportReviewNode, fileId: string, fileCapabilityKey: Uint8Array): Promise<void> => {
    const history = comments.get(node.sourcePath);
    if (!history?.length) return;
    const threadId = newId(),
      epochId = newId(),
      threadCapabilityId = newId();
    const threadKey = crypto.getRandomValues(new Uint8Array(32));
    const threadEnvelope = await (await createSymmetricWriter(fileCapabilityKey)).seal(threadKey, {
      purpose: "private-comment-thread",
      vaultId,
      objectId: threadId,
      keyId: threadCapabilityId,
      keyEpoch: 1,
      revision: 1,
    });
    await push("comment-thread", [fileId, threadId, epochId, threadCapabilityId], threadEnvelope);
    for (const comment of history) {
      if (commentRecords >= 1_000) {
        throw new ImportError("too-many-comments", { limit: 1_000, measured: commentRecords + 1, action: "split" });
      }
      commentRecords += 1;
      const commentId = newId();
      const body = await sealCommentBody(threadKey, {
        vaultId,
        commentId,
        capabilityId: threadCapabilityId,
        keyEpoch: 1,
        revision: 1,
        text: comment.text,
        meta: { createdAt: comment.createdAt, updatedAt: comment.updatedAt },
      });
      await push("comment-meta", [threadId, commentId], decodeImportBytes(body.metaCiphertext!, 4_096));
      await push("comment-body", [threadId, commentId], decodeImportBytes(body.bodyCiphertext, 16_384));
      await push("comment-key", [threadId, commentId], decodeImportBytes(body.contentKeyEnvelope, 16_384));
    }
    // Historical comments all belong to the importing Account, so one thread
    // attribution preserves the sidecar's displayed pseudonym for the history.
    const attributionId = newId();
    const sealed = await sealAttribution(threadKey, {
      vaultId,
      attributionId,
      pseudonym: history[0]!.pseudonym,
      capabilityId: threadCapabilityId,
      keyEpoch: 1,
    });
    await push("comment-attribution", [threadId, attributionId], decodeImportBytes(sealed.ciphertext, 4_096));
    await push(
      "comment-attribution-key",
      [threadId, attributionId],
      decodeImportBytes(sealed.contentKeyEnvelope, 16_384),
    );
  };

  const pushRepresentation = async (
    wrappingKey: Uint8Array,
    fileId: string,
    markdown: string,
    metadata: Uint8Array,
    capability: { capabilityId: string; capabilityEpoch: number },
    replacement?: { revision: number; keyEpoch: number },
  ): Promise<void> => {
    const revision = replacement?.revision ?? 1;
    const keyEpoch = replacement?.keyEpoch ?? 1;
    const contentKeyId = newId();
    const representationId = newId();
    const representation = await createFileRepresentation(
      wrappingKey,
      { markdown, metadata },
      {
        vaultId,
        fileId,
        keyId: contentKeyId,
        keyEpoch,
        revision,
      },
    );
    await push("representation-key", [fileId, representationId, contentKeyId], representation.fileContentKeyEnvelope);
    await push("representation", [fileId, representationId, contentKeyId], representation.contentEnvelope);
    const head = await options.signFileHead({
      vaultId,
      fileId,
      capabilityId: capability.capabilityId,
      capabilityEpoch: capability.capabilityEpoch,
      representationId,
      contentKeyId,
      keyEpoch,
      revision,
      ciphertext: encodeBytes(representation.contentEnvelope),
      keyEnvelope: encodeBytes(representation.fileContentKeyEnvelope),
    });
    await push("file-head", [fileId, representationId], fileHeadBytes(head));
  };

  const planReplace = async (
    node: ImportReviewNode,
    parentId: string,
    parentKey: Uint8Array,
  ): Promise<string | null> => {
    const fileId = node.existingNodeId;
    const source = options.files.get(node.sourcePath);
    if (!fileId || !source) throw new ImportError("replacement-unavailable", { item: node.sourcePath, action: "fix" });
    if (comments.get(node.sourcePath)?.length) {
      throw new ImportError("historical-comments-replace", { item: node.sourcePath, action: "fix" });
    }
    const document = options.replacements.get(fileId);
    if (!document) throw new ImportError("replacement-unavailable", { item: node.sourcePath, action: "fix" });
    const revision = document.revision + 1;
    const keyEpoch = document.keyEpoch + 1;
    const published = document.publication && document.publication.revision !== null ? document.publication : null;
    if (published && !document.capability) {
      throw new ImportError("replacement-unavailable", {
        item: node.sourcePath,
        reason: "published-legacy",
        action: "fix",
      });
    }
    await push("replace", [fileId, document.representationId], u64(document.revision));
    if (document.capability) {
      if (!document.capabilityKey)
        throw new ImportError("replacement-unavailable", { item: node.sourcePath, action: "fix" });
      await pushRepresentation(
        document.capabilityKey,
        fileId,
        source.markdown,
        document.metadata,
        { capabilityId: document.capability.id, capabilityEpoch: document.capability.epoch },
        { revision, keyEpoch },
      );
    } else {
      const contentKeyId = newId();
      const representationId = newId();
      const representation = await createFileRepresentation(
        parentKey,
        { markdown: source.markdown, metadata: document.metadata },
        {
          vaultId,
          fileId,
          keyId: contentKeyId,
          keyEpoch,
          revision,
        },
      );
      await push("entry-key", [fileId, parentId], representation.fileContentKeyEnvelope);
      await push("representation", [fileId, representationId, contentKeyId], representation.contentEnvelope);
      return encodeBytes(representation.fileContentKeyEnvelope);
    }
    if (published) {
      const envelope = await sealPublicRepresentation(
        {
          publicationId: published.publicationId,
          linkId: published.linkId,
          publicKey: published.publicKey,
          revision: published.revision! + 1,
        },
        publicPresentation(source.markdown),
      );
      await push("public-representation", [published.publicationId, published.linkId, newStagingId()], envelope);
    }
    return null;
  };

  const legacyKeyUpdates = new Map<string, string>();
  const walk = async (
    node: ImportReviewNode,
    parentId: string,
    parentKey: Uint8Array,
    keyEpoch: number,
  ): Promise<ImportListingEntry[]> => {
    const sealed: ImportListingEntry[] = [];
    for (const child of node.children) {
      if (child.blocked || (child.action !== "create" && child.action !== "replace")) continue;
      if (child.action === "replace") {
        const keyEnvelope = await planReplace(child, parentId, parentKey);
        if (keyEnvelope && child.existingNodeId) legacyKeyUpdates.set(child.existingNodeId, keyEnvelope);
        continue;
      }
      if (child.kind === "file") {
        sealed.push(await planFile(child, parentId, parentKey, keyEpoch));
        continue;
      }
      const nodeId = newId();
      const order = newId();
      await push("node-directory", [nodeId, parentId], new Uint8Array());
      const entry = await entryRecords(parentKey, vaultId, parentId, nodeId, keyEpoch, child.displayName, order);
      await push("entry-name", [nodeId, parentId], entry.name);
      await push("entry-order", [nodeId, parentId], entry.order);
      const capability = await createChildDirectoryCapability(parentKey, {
        vaultId,
        parentDirectoryId: parentId,
        childDirectoryId: nodeId,
      });
      await push("directory-capability", [nodeId, parentId], capability.envelope);
      const children = await walk(child, nodeId, capability.capabilityKey, 1);
      if (children.length) await pushListing(nodeId, 1, 2, capability.capabilityKey, children);
      sealed.push({
        nodeId,
        kind: "directory",
        nameCiphertext: encodeBytes(entry.name),
        orderCiphertext: encodeBytes(entry.order),
        keyEnvelope: encodeBytes(capability.envelope),
      });
    }
    return sealed;
  };

  const targetKeyEpoch = review.target.keyEpoch;
  const created = await walk(review.tree, targetId, options.targetKey, targetKeyEpoch);
  if (!records.length) throw new ImportError("nothing-to-import", { action: "fix" });
  // The target's listing keeps every existing edge, applies legacy Replace
  // key envelopes, and appends every created node, then advances its revision.
  const sealed = new Map<string, ImportListingEntry>();
  for (const entry of review.target.listing) {
    sealed.set(entry.nodeId, {
      nodeId: entry.nodeId,
      kind: entry.kind,
      nameCiphertext: entry.nameCiphertext,
      orderCiphertext: entry.orderCiphertext,
      keyEnvelope: entry.keyEnvelope,
    });
  }
  for (const entry of created) sealed.set(entry.nodeId, entry);
  for (const [nodeId, keyEnvelope] of legacyKeyUpdates) {
    const previous = sealed.get(nodeId);
    if (!previous) throw new ImportError("replacement-unavailable", { item: nodeId, action: "fix" });
    sealed.set(nodeId, { ...previous, keyEnvelope });
  }
  await pushListing(targetId, targetKeyEpoch, review.target.entriesRevision + 1, options.targetKey, [
    ...sealed.values(),
  ]);
  if (commentRecords !== review.counts.comments) {
    throw new ImportError("too-many-comments", {
      limit: review.counts.comments,
      measured: commentRecords,
      action: "split",
    });
  }

  const chunks = await packChunks(records);
  const payloadBytes = chunks.reduce((total, chunk) => total + chunk.payload.length, 0);
  // Aggregate over the sequence-ordered chunk body digests: it transitively
  // binds every payload byte while keeping the commit recheck tiny.
  const aggregateDigest = await sha256Hex(concat(chunks.map((chunk) => decodeHexBytes(chunk.digest))));
  const importId = newStagingId();
  const kindCounts: ImportSessionKindCount[] = [];
  for (const kind of Object.keys(IMPORT_RECORD_KINDS) as StagingRecordKind[]) {
    const count = records.reduce((total, record) => total + (record.kind === kind ? 1 : 0), 0);
    if (count) kindCounts.push({ kind, count });
  }
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
    chunks: chunks.map((chunk) => ({
      sequence: chunk.sequence,
      digest: chunk.digest,
      records: chunk.descriptors.length,
      bytes: chunk.payload.length,
    })),
    kinds: kindCounts,
    aggregateDigest,
    planDigest: await sha256Hex(encoder.encode(canonicalPlanJson(review))),
  };
  const plaintext = encoder.encode(JSON.stringify(manifest));
  const envelope = await (await createSymmetricWriter(options.targetKey)).seal(plaintext, {
    purpose: "import-staging-manifest",
    vaultId,
    objectId: importId,
    keyId: targetId,
    keyEpoch: targetKeyEpoch,
    revision: 1,
  });
  if (envelope.length > MAX_STAGING_MANIFEST_BYTES) {
    throw new ImportError("plan-too-large", {
      limit: MAX_STAGING_MANIFEST_BYTES,
      measured: envelope.length,
      action: "split",
    });
  }
  const manifestDigest = await envelopeDigestHex(envelope);
  return {
    importId,
    review,
    records,
    chunks,
    manifest: {
      envelope,
      manifest,
      metadata: {
        importId,
        vaultId,
        targetOwnerId: vaultId,
        actorAccountId: review.target.actorAccountId,
        targetDirectoryId: targetId,
        reviewedEntryRevision: review.target.entriesRevision,
        recordCount: records.length,
        chunkCount: chunks.length,
        payloadBytes,
        commentCount: commentRecords,
        aggregateDigest,
        manifestDigest,
        kindCounts,
      },
    },
  };
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
      throw new ImportError("plan-too-large", {
        limit: MAX_STAGING_CHUNKS,
        measured: chunks.length + 1,
        action: "split",
      });
    }
    const payload = concat(payloads);
    const body = encodeImportChunkBody(descriptors, payload);
    chunks.push({ sequence: chunks.length, payload, digest: await sha256Hex(body), descriptors });
    payloads = [];
    descriptors = [];
    bytes = 0;
  };
  for (const record of records) {
    if (record.bytes.length > MAX_STAGING_CHUNK_BYTES) {
      throw new ImportError("plan-record-too-large", {
        item: record.refs.join("/"),
        limit: MAX_STAGING_CHUNK_BYTES,
        measured: record.bytes.length,
        action: "split",
      });
    }
    if (descriptors.length >= MAX_STAGING_CHUNK_RECORDS || bytes + record.bytes.length > MAX_STAGING_CHUNK_BYTES) {
      await flush();
    }
    descriptors.push({
      kind: record.kind,
      refs: record.refs,
      offset: bytes,
      length: record.bytes.length,
      digest: record.digest,
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
