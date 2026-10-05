/**
 * Import source normalization (ticket 29).
 *
 * Turns one local selection — a recognized mdwn archive, or loose UTF-8
 * `.md`/`.markdown` files and folders — into a bounded source tree that no
 * upload has touched. Every bound from `docs/buildable-spec.md` §9.8 is
 * enforced here with a safe, content-free failure: the caller gets an
 * `ImportError` naming at most the local item and the configured limit.
 *
 * The archive half deliberately reuses ticket 28's `inspectArchive` (format
 * recognition, metadata set, safe `mdwn/namespace-v1` paths, folded duplicate
 * rejection, root resolution, node/depth/source/expanded/Comment bounds) and
 * then confirms the tree shape itself, because omitted ZIP directory entries
 * must not let implicit parents escape the node/depth bounds.
 */

import {
  ArchiveError,
  checkArchiveCompressedSize,
  inspectArchive,
  type HistoricalComment,
} from "~/archive/format";
import { readZip, ZipError, type ZipEntry } from "~/archive/zip";
import { canonicalizeSegment, comparisonKey, NamespaceError, splitSourcePath, utf8Bytes } from "~/namespace-v1";
import { IMPORT_LIMITS, ImportError, type ImportLimits } from "./limits";

/** One raw local item: a folder entry, a loose File, or a candidate archive. */
export type RawImportInput = { path: string; directory?: boolean; bytes?: Uint8Array };

export type ImportSourceFile = {
  kind: "file";
  path: readonly string[];
  name: string;
  markdown: string;
  bytes: number;
};

export type ImportSourceDirectory = {
  kind: "directory";
  path: readonly string[];
  name: string;
  children: ImportSourceChild[];
};

export type ImportSourceChild = ImportSourceFile | ImportSourceDirectory;

export type ImportSourceEntry = { path: string; kind: "file" | "directory"; name: string };

export type ImportSource = {
  kind: "archive" | "loose";
  /** Children of the Import target root, in deterministic bytewise-name order. */
  roots: ImportSourceChild[];
  /** Every normalized source node, pre-order; skips and replaces still count. */
  nodes: readonly ImportSourceEntry[];
  comments: ReadonlyMap<string, readonly HistoricalComment[]>;
  nodeCount: number;
  maxDepth: number;
  sourceBytes: number;
  compressedBytes: number | null;
  expandedBytes: number;
  commentCount: number;
};

type TreeFile = { kind: "file"; name: string; markdown: string; bytes: number };
type TreeDirectory = { kind: "directory"; name: string; children: Map<string, TreeNode> };
type TreeNode = TreeFile | TreeDirectory;

const decoder = new TextDecoder("utf-8", { fatal: true });
const MARKDOWN_NAME = /\.(md|markdown)$/i;

/** Folded sibling-comparison token; the same relation the namespace contract uses. */
function token(segment: string): string {
  return Array.from(comparisonKey(segment), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareUtf8(a: string, b: string): number {
  const left = utf8Bytes(a), right = utf8Bytes(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) if (left[index] !== right[index]) return left[index]! - right[index]!;
  return left.length - right.length;
}

function isMarkdownName(name: string): boolean {
  return MARKDOWN_NAME.test(name);
}

function looksLikeZip(input: RawImportInput): boolean {
  if (input.directory) return false;
  if (/\.zip$/i.test(input.path)) return true;
  const bytes = input.bytes;
  return !!bytes && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05) && (bytes[3] === 0x04 || bytes[3] === 0x06);
}

function decodeMarkdown(bytes: Uint8Array, item: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new ImportError("not-utf8", { item, action: "fix" });
  }
}

function canonicalLoosePath(path: string): readonly string[] {
  try {
    return splitSourcePath(path);
  } catch (error) {
    if (error instanceof NamespaceError) {
      throw new ImportError("invalid-path", { item: path, reason: error.code, action: "fix" });
    }
    throw error;
  }
}

/** Create (or find) every directory in `segments`; a File in the way is a duplicate path. */
function ensureDirectory(root: TreeDirectory, segments: readonly string[], item: string): TreeDirectory {
  let directory = root;
  for (const name of segments) {
    const key = token(name);
    const existing = directory.children.get(key);
    if (!existing) {
      const child: TreeDirectory = { kind: "directory", name, children: new Map() };
      directory.children.set(key, child);
      directory = child;
      continue;
    }
    if (existing.kind !== "directory") throw new ImportError("duplicate-source-path", { item, action: "remove" });
    directory = existing;
  }
  return directory;
}

function addFile(root: TreeDirectory, segments: readonly string[], markdown: string, bytes: number, item: string): void {
  const parent = ensureDirectory(root, segments.slice(0, -1), item);
  const name = segments.at(-1)!;
  const key = token(name);
  if (parent.children.has(key)) throw new ImportError("duplicate-source-path", { item, action: "remove" });
  parent.children.set(key, { kind: "file", name, markdown, bytes });
}

function treeFromLoose(inputs: readonly RawImportInput[], limits: ImportLimits): { root: TreeDirectory; expandedBytes: number } {
  const root: TreeDirectory = { kind: "directory", name: "", children: new Map() };
  const explicitDirectories = new Set<string>();
  let expandedBytes = 0;
  for (const input of inputs) {
    const segments = canonicalLoosePath(input.path);
    if (input.directory) {
      // Two explicit entries for the same Directory path are duplicate source
      // paths; an implicit parent shared by two Files is not.
      const key = segments.map((segment) => token(segment)).join("/");
      if (explicitDirectories.has(key)) throw new ImportError("duplicate-source-path", { item: input.path, action: "remove" });
      explicitDirectories.add(key);
      ensureDirectory(root, segments, input.path);
      continue;
    }
    const name = segments.at(-1)!;
    if (!isMarkdownName(name)) {
      throw new ImportError("unsupported-input", { item: input.path, reason: "extension", action: "remove" });
    }
    const bytes = input.bytes ?? new Uint8Array();
    if (bytes.length > limits.maxSourceBytes) {
      throw new ImportError("source-too-large", { item: input.path, limit: limits.maxSourceBytes, measured: bytes.length, action: "split" });
    }
    expandedBytes += bytes.length;
    if (expandedBytes > limits.maxExpandedBytes) {
      throw new ImportError("expanded-too-large", { item: input.path, limit: limits.maxExpandedBytes, measured: expandedBytes, action: "split" });
    }
    addFile(root, segments, decodeMarkdown(bytes, input.path), bytes.length, input.path);
  }
  return { root, expandedBytes };
}

type Shape = { nodes: ImportSourceEntry[]; maxDepth: number; sourceBytes: number };

/** Count every node (including implicit parents) and enforce the settled bounds. */
function measureTree(root: TreeDirectory, limits: ImportLimits): Shape {
  const nodes: ImportSourceEntry[] = [];
  let maxDepth = 0;
  let sourceBytes = 0;
  const visit = (directory: TreeDirectory, parent: readonly string[]): void => {
    for (const child of [...directory.children.values()].sort((a, b) => compareUtf8(a.name, b.name))) {
      const path = [...parent, child.name];
      // A File's Directory segments exclude its own leaf; a Directory's include it.
      const depth = child.kind === "file" ? path.length - 1 : path.length;
      maxDepth = Math.max(maxDepth, depth);
      if (depth > limits.maxDepth) {
        throw new ImportError("too-deep", { item: path.join("/"), limit: limits.maxDepth, action: "fix" });
      }
      nodes.push({ path: path.join("/"), kind: child.kind, name: child.name });
      if (nodes.length > limits.maxNodes) {
        throw new ImportError("too-many-nodes", { item: path.join("/"), limit: limits.maxNodes, measured: nodes.length, action: "split" });
      }
      if (child.kind === "file") {
        sourceBytes = Math.max(sourceBytes, child.bytes);
        if (child.bytes > limits.maxSourceBytes) {
          throw new ImportError("source-too-large", { item: path.join("/"), limit: limits.maxSourceBytes, measured: child.bytes, action: "split" });
        }
      } else {
        visit(child, path);
      }
    }
  };
  visit(root, []);
  return { nodes, maxDepth, sourceBytes };
}

function toSourceChildren(directory: TreeDirectory, parent: readonly string[]): ImportSourceChild[] {
  return [...directory.children.values()]
    .sort((a, b) => compareUtf8(a.name, b.name))
    .map((child): ImportSourceChild => {
      const path = [...parent, child.name];
      return child.kind === "file"
        ? { kind: "file", path, name: child.name, markdown: child.markdown, bytes: child.bytes }
        : { kind: "directory", path, name: child.name, children: toSourceChildren(child, path) };
    });
}

function mapArchiveError(error: ArchiveError): ImportError {
  const detail = error.detail;
  switch (error.code) {
    case "invalid-path": return new ImportError("invalid-path", { item: detail, action: "fix" });
    case "duplicate-path": return new ImportError("duplicate-source-path", { item: detail, action: "remove" });
    case "too-many-nodes": return new ImportError("too-many-nodes", { limit: IMPORT_LIMITS.maxNodes, action: "split" });
    case "too-deep": return new ImportError("too-deep", { item: detail, limit: IMPORT_LIMITS.maxDepth, action: "fix" });
    case "source-too-large": return new ImportError("source-too-large", { item: detail, limit: IMPORT_LIMITS.maxSourceBytes, action: "split" });
    case "expanded-too-large": return new ImportError("expanded-too-large", { item: detail, limit: IMPORT_LIMITS.maxExpandedBytes, action: "split" });
    case "too-many-comments": return new ImportError("too-many-comments", { item: detail, limit: IMPORT_LIMITS.maxComments, action: "split" });
    case "archive-too-large": return new ImportError("archive-too-large", { limit: IMPORT_LIMITS.maxCompressedBytes, action: "split" });
    default: return new ImportError("unsupported-input", { item: detail, reason: error.code, action: "re-export" });
  }
}

async function archiveTree(bytes: Uint8Array, limits: ImportLimits) {
  try {
    checkArchiveCompressedSize(bytes, limits.maxCompressedBytes);
  } catch (error) {
    if (error instanceof ArchiveError) throw mapArchiveError(error);
    throw error;
  }
  let entries: ZipEntry[];
  try {
    entries = await readZip(bytes);
  } catch (error) {
    if (error instanceof ZipError) {
      if (error.code === "invalid-path") throw new ImportError("invalid-path", { action: "re-export", reason: error.code });
      if (error.code === "duplicate-path") throw new ImportError("duplicate-source-path", { action: "remove", reason: error.code });
      throw new ImportError("unsupported-input", { reason: "malformed-archive", action: "re-export" });
    }
    throw error;
  }
  let inspection;
  try {
    inspection = inspectArchive(entries, { limits });
  } catch (error) {
    if (error instanceof ArchiveError) throw mapArchiveError(error);
    throw error;
  }
  // `inspectArchive` reports NFC display paths; key raw ZIP bytes by the same
  // canonical path so an equivalent Unicode spelling still resolves.
  const data = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (!entry.directory) data.set(entry.path.split("/").map((segment) => canonicalizeSegment(segment).display).join("/"), entry.data);
  }
  const root: TreeDirectory = { kind: "directory", name: "", children: new Map() };
  for (const entry of inspection.entries) {
    if (entry.directory) {
      ensureDirectory(root, entry.segments, entry.path);
      continue;
    }
    if (!isMarkdownName(entry.segments.at(-1)!)) {
      throw new ImportError("unsupported-input", { item: entry.path, reason: "extension", action: "re-export" });
    }
    const raw = data.get(entry.path);
    if (!raw) throw new ImportError("unsupported-input", { item: entry.path, reason: "missing-entry", action: "re-export" });
    addFile(root, entry.segments, decodeMarkdown(raw, entry.path), raw.length, entry.path);
  }
  return { root, inspection };
}

/**
 * Every content entry must live in a declared archive root. Zip readers do not
 * require directory entries, so the manifest roots remain the archive's own
 * statement of what is Import content.
 */
function checkRoots(root: TreeDirectory, roots: readonly { kind: "file" | "directory"; path: string }[]): void {
  const covered = new Set<TreeNode>();
  const mark = (node: TreeNode): void => {
    covered.add(node);
    if (node.kind === "directory") for (const child of node.children.values()) mark(child);
  };
  for (const declared of roots) {
    if (declared.kind === "directory" && declared.path === "") {
      for (const child of root.children.values()) mark(child);
      continue;
    }
    const node = nodeAt(root, declared.path.split("/"));
    if (node) mark(node);
  }
  const uncovered = [...root.children.values()].find((node) => !covered.has(node));
  if (uncovered) {
    throw new ImportError("unsupported-input", { item: uncovered.name, reason: "unexpected-entry", action: "re-export" });
  }
}

function nodeAt(root: TreeDirectory, segments: readonly string[]): TreeNode | undefined {
  let directory: TreeDirectory = root;
  for (let index = 0; index < segments.length; index++) {
    const node = directory.children.get(token(segments[index]!));
    if (!node) return undefined;
    if (index === segments.length - 1) return node;
    if (node.kind !== "directory") return undefined;
    directory = node;
  }
  return directory;
}

/**
 * Normalize one local selection into the bounded source tree. Archive and
 * loose input are never mixed; a `.zip` selection must be exactly one
 * recognized mdwn archive.
 */
export async function analyzeImportSelection(
  inputs: readonly RawImportInput[],
  options: { limits?: Partial<ImportLimits> } = {},
): Promise<ImportSource> {
  const limits: ImportLimits = { ...IMPORT_LIMITS, ...options.limits };
  if (!inputs.length) throw new ImportError("empty-selection");
  const archives = inputs.filter(looksLikeZip);
  if (archives.length) {
    if (inputs.length !== 1) {
      throw new ImportError("unsupported-input", { item: archives[0]!.path, reason: "mixed-archive", action: "remove" });
    }
    const bytes = inputs[0]!.bytes;
    if (!bytes) throw new ImportError("unsupported-input", { item: inputs[0]!.path, reason: "unreadable", action: "remove" });
    const { root, inspection } = await archiveTree(bytes, limits);
    const shape = measureTree(root, limits);
    if (shape.nodes.length === 0) throw new ImportError("empty-selection");
    checkRoots(root, inspection.roots);
    return {
      kind: "archive",
      roots: toSourceChildren(root, []),
      nodes: shape.nodes,
      comments: inspection.comments as ReadonlyMap<string, readonly HistoricalComment[]>,
      nodeCount: shape.nodes.length,
      maxDepth: shape.maxDepth,
      sourceBytes: shape.sourceBytes,
      compressedBytes: bytes.length,
      expandedBytes: inspection.expandedBytes,
      commentCount: [...inspection.comments.values()].reduce((total, comments) => total + comments.length, 0),
    };
  }
  const { root, expandedBytes } = treeFromLoose(inputs, limits);
  const shape = measureTree(root, limits);
  if (shape.nodes.length === 0) throw new ImportError("empty-selection");
  return {
    kind: "loose",
    roots: toSourceChildren(root, []),
    nodes: shape.nodes,
    comments: new Map(),
    nodeCount: shape.nodes.length,
    maxDepth: shape.maxDepth,
    sourceBytes: shape.sourceBytes,
    compressedBytes: null,
    expandedBytes,
    commentCount: 0,
  };
}

