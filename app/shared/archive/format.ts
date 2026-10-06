/**
 * Portable mdwn archive format: the versioned `.mdwn/manifest.json` and
 * `.mdwn/private-comments.json` of an owned-Files export.
 *
 * This module is browser- and Node-safe and carries no live authority: the
 * manifest identifies the archive format and its roots only, and the sidecar
 * preserves historical Private Comment display data for a later Import to
 * rebuild as bounded Historical Comments. Neither file ever contains Shares,
 * Grants, capabilities, keys, credentials, sessions, service IDs, local
 * drafts, or Publication state.
 *
 * `inspectArchive` is the archive-level half of the Import preflight (ticket
 * 29): format recognition, safe normalized paths, duplicate detection, root
 * resolution, and the settled node/depth/source/expanded/Historical-Comment
 * bounds. Collision choices, Import targets, and the encrypted staging plan
 * remain the Import flow's responsibility.
 */

import { MAX_COMMENT_CHARS, normalizeCommentText, validCommentText } from "~/shared/comments/content";
import { FILE_SOURCE_LIMIT } from "~/shared/crypto/file-source";
import { canonicalizeSegment, comparisonKey, NamespaceError, utf8Bytes } from "~/shared/namespace-v1";
import type { ZipEntry } from "./zip";

export const ARCHIVE_METADATA_DIRECTORY = ".mdwn";
export const ARCHIVE_MANIFEST_PATH = `${ARCHIVE_METADATA_DIRECTORY}/manifest.json`;
export const ARCHIVE_COMMENTS_PATH = `${ARCHIVE_METADATA_DIRECTORY}/private-comments.json`;
export const ARCHIVE_FORMAT = "mdwn-export";
export const ARCHIVE_VERSION = 1;
export const COMMENTS_FORMAT = "mdwn-private-comments";
export const COMMENTS_VERSION = 1;

export const MAX_ARCHIVE_NODES = 100;
export const MAX_ARCHIVE_DEPTH = 32;
export const MAX_ARCHIVE_COMPRESSED_BYTES = 8_388_608;
export const MAX_ARCHIVE_EXPANDED_BYTES = 16_777_216;
export const MAX_HISTORICAL_COMMENTS = 1_000;

export type ArchiveErrorCode =
  | "not-mdwn-archive"
  | "malformed-manifest"
  | "unsupported-version"
  | "malformed-comments"
  | "invalid-path"
  | "duplicate-path"
  | "unexpected-metadata"
  | "missing-root"
  | "too-many-nodes"
  | "too-deep"
  | "source-too-large"
  | "expanded-too-large"
  | "archive-too-large"
  | "too-many-comments";

/** `detail` may name a local archive path or failure; it never contains content. */
export class ArchiveError extends Error {
  constructor(readonly code: ArchiveErrorCode, readonly detail?: string) {
    super(`mdwn/archive: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "ArchiveError";
  }
}

export type ArchiveRoot = { kind: "file" | "directory"; path: string };

export type ArchiveManifest = {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  createdAt: string;
  roots: ArchiveRoot[];
};

export type HistoricalComment = {
  sequence: number;
  text: string;
  pseudonym: string;
  createdAt: number;
  updatedAt: number;
};

export type PrivateCommentsFile = { path: string; comments: HistoricalComment[] };

export type PrivateCommentsSidecar = {
  format: typeof COMMENTS_FORMAT;
  version: number;
  files: PrivateCommentsFile[];
};

export type ArchiveEntry = { path: string; segments: string[]; directory: boolean; bytes: number };

export type ArchiveInspection = {
  manifest: ArchiveManifest;
  roots: ArchiveRoot[];
  entries: ArchiveEntry[];
  comments: Map<string, HistoricalComment[]>;
  expandedBytes: number;
  nodeCount: number;
  maxDepth: number;
  sourceBytes: number;
};

export type ArchiveLimits = {
  maxNodes: number;
  maxDepth: number;
  maxSourceBytes: number;
  maxExpandedBytes: number;
  maxComments: number;
};

export const ARCHIVE_LIMITS: ArchiveLimits = {
  maxNodes: MAX_ARCHIVE_NODES,
  maxDepth: MAX_ARCHIVE_DEPTH,
  maxSourceBytes: FILE_SOURCE_LIMIT,
  maxExpandedBytes: MAX_ARCHIVE_EXPANDED_BYTES,
  maxComments: MAX_HISTORICAL_COMMENTS,
};

/** The settled recognized-archive input bound; ticket 29 applies it before reading the ZIP. */
export function checkArchiveCompressedSize(bytes: Uint8Array, max = MAX_ARCHIVE_COMPRESSED_BYTES): void {
  if (bytes.length > max) throw new ArchiveError("archive-too-large");
}

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function createArchiveManifest(roots: readonly ArchiveRoot[], createdAt: string): ArchiveManifest {
  return { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, createdAt, roots: roots.map((root) => ({ ...root })) };
}

export function serializeArchiveManifest(manifest: ArchiveManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function parseArchiveManifest(text: string): ArchiveManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new ArchiveError("malformed-manifest"); }
  if (!isRecord(parsed) || !hasOnly(parsed, ["format", "version", "createdAt", "roots"])) {
    throw new ArchiveError("malformed-manifest");
  }
  if (parsed.format !== ARCHIVE_FORMAT) throw new ArchiveError("not-mdwn-archive");
  if (parsed.version !== ARCHIVE_VERSION) throw new ArchiveError("unsupported-version");
  if (typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt))) {
    throw new ArchiveError("malformed-manifest");
  }
  if (!Array.isArray(parsed.roots) || parsed.roots.length > 1_024) throw new ArchiveError("malformed-manifest");
  const roots: ArchiveRoot[] = parsed.roots.map((value) => {
    if (!isRecord(value) || !hasOnly(value, ["kind", "path"]) ||
        (value.kind !== "file" && value.kind !== "directory") || typeof value.path !== "string") {
      throw new ArchiveError("malformed-manifest");
    }
    return { kind: value.kind, path: value.path };
  });
  return { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, createdAt: parsed.createdAt, roots };
}

export function createPrivateCommentsSidecar(files: readonly PrivateCommentsFile[]): PrivateCommentsSidecar {
  return { format: COMMENTS_FORMAT, version: COMMENTS_VERSION, files: files.map((file) => ({
    path: file.path, comments: file.comments.map((comment) => ({ ...comment })),
  })) };
}

export function serializePrivateCommentsSidecar(sidecar: PrivateCommentsSidecar): string {
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

export function parsePrivateCommentsSidecar(text: string): PrivateCommentsSidecar {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new ArchiveError("malformed-comments"); }
  if (!isRecord(parsed) || !hasOnly(parsed, ["format", "version", "files"])) throw new ArchiveError("malformed-comments");
  if (parsed.format !== COMMENTS_FORMAT) throw new ArchiveError("malformed-comments");
  if (parsed.version !== COMMENTS_VERSION) throw new ArchiveError("unsupported-version");
  if (!Array.isArray(parsed.files) || parsed.files.length > MAX_HISTORICAL_COMMENTS) throw new ArchiveError("malformed-comments");
  let total = 0;
  const files = parsed.files.map((value): PrivateCommentsFile => {
    if (!isRecord(value) || !hasOnly(value, ["path", "comments"]) || typeof value.path !== "string" ||
        !value.path.length || !Array.isArray(value.comments) || !value.comments.length) {
      throw new ArchiveError("malformed-comments");
    }
    let previous = -1;
    const comments = value.comments.map((comment): HistoricalComment => {
      if (!isRecord(comment) ||
          !hasOnly(comment, ["sequence", "text", "pseudonym", "createdAt", "updatedAt"]) ||
          !nonNegativeInteger(comment.sequence) || comment.sequence <= previous ||
          !validCommentText(comment.text) || normalizeCommentText(comment.text) !== comment.text ||
          typeof comment.pseudonym !== "string" || !comment.pseudonym ||
          Array.from(comment.pseudonym).length > 256 ||
          !nonNegativeInteger(comment.createdAt) || !nonNegativeInteger(comment.updatedAt)) {
        throw new ArchiveError("malformed-comments");
      }
      previous = comment.sequence;
      total += 1;
      if (total > MAX_HISTORICAL_COMMENTS) throw new ArchiveError("too-many-comments");
      return { sequence: comment.sequence, text: comment.text, pseudonym: comment.pseudonym,
        createdAt: comment.createdAt, updatedAt: comment.updatedAt };
    });
    return { path: value.path, comments };
  });
  return { format: COMMENTS_FORMAT, version: COMMENTS_VERSION, files };
}

/** Comparison-key hex used only inside one browser/preflight; never sent to the service. */
export function comparisonToken(segment: string): string {
  let token = "";
  for (const byte of comparisonKey(segment)) token += byte.toString(16).padStart(2, "0");
  return token;
}

function canonicalSegments(path: string): string[] {
  const raw = path.split("/");
  if (!path.length || path.startsWith("/") || raw.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ArchiveError("invalid-path", path);
  }
  try { return raw.map((segment) => canonicalizeSegment(segment).display); }
  catch (error) {
    if (error instanceof NamespaceError) throw new ArchiveError("invalid-path", path);
    throw error;
  }
}

function canonicalPathKey(segments: readonly string[]): string {
  return segments.map((segment) => comparisonToken(segment)).join("/");
}

function metadataEntry(entry: ZipEntry): boolean {
  const top = entry.path.split("/", 1)[0]!;
  return top === ARCHIVE_METADATA_DIRECTORY;
}

/**
 * Validate one recognized mdwn archive before any Import work: exact metadata
 * set, safe normalized namespace paths, no duplicates, resolvable manifest
 * roots, and bounded counts and sizes. A conforming archive is returned with
 * its normalized display paths; nothing is uploaded or written here.
 */
export function inspectArchive(
  zipEntries: readonly ZipEntry[],
  options: { limits?: Partial<ArchiveLimits> } = {},
): ArchiveInspection {
  const limits: ArchiveLimits = { ...ARCHIVE_LIMITS, ...options.limits };
  let manifest: ArchiveManifest | null = null;
  let comments: Map<string, HistoricalComment[]> = new Map();
  let sawComments = false;
  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  let expandedBytes = 0;
  let maxDepth = 0;
  let sourceBytes = 0;
  for (const entry of zipEntries) {
    expandedBytes += entry.data.length;
    if (metadataEntry(entry)) {
      if (entry.directory) {
        if (entry.path !== ARCHIVE_METADATA_DIRECTORY) throw new ArchiveError("unexpected-metadata", entry.path);
        continue;
      }
      if (entry.path === ARCHIVE_MANIFEST_PATH) {
        if (manifest) throw new ArchiveError("malformed-manifest");
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(entry.data); }
        catch { throw new ArchiveError("malformed-manifest"); }
        manifest = parseArchiveManifest(text);
        continue;
      }
      if (entry.path === ARCHIVE_COMMENTS_PATH) {
        if (sawComments) throw new ArchiveError("malformed-comments");
        sawComments = true;
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(entry.data); }
        catch { throw new ArchiveError("malformed-comments"); }
        const sidecar = parsePrivateCommentsSidecar(text);
        comments = new Map();
        const paths = new Set<string>();
        for (const file of sidecar.files) {
          const segments = canonicalSegments(file.path);
          const key = canonicalPathKey(segments);
          if (paths.has(key)) throw new ArchiveError("duplicate-path", file.path);
          paths.add(key);
          comments.set(key, file.comments);
        }
        continue;
      }
      throw new ArchiveError("unexpected-metadata", entry.path);
    }
    const segments = canonicalSegments(entry.path);
    const key = canonicalPathKey(segments);
    if (seen.has(key)) throw new ArchiveError("duplicate-path", entry.path);
    seen.add(key);
    if (!entry.directory) {
      sourceBytes = Math.max(sourceBytes, entry.data.length);
      if (entry.data.length > limits.maxSourceBytes) throw new ArchiveError("source-too-large", entry.path);
    }
    const depth = entry.directory ? segments.length : segments.length - 1;
    maxDepth = Math.max(maxDepth, depth);
    entries.push({ path: segments.join("/"), segments, directory: entry.directory, bytes: entry.data.length });
  }
  if (!manifest) throw new ArchiveError("not-mdwn-archive");
  if (entries.length > limits.maxNodes) throw new ArchiveError("too-many-nodes");
  if (maxDepth > limits.maxDepth) throw new ArchiveError("too-deep");
  if (expandedBytes > limits.maxExpandedBytes) throw new ArchiveError("expanded-too-large");
  const byKey = new Map(entries.map((entry) => [canonicalPathKey(entry.segments), entry]));
  const roots = manifest.roots.map((root): ArchiveRoot => {
    const segments = root.path === "" ? [] : canonicalSegments(root.path);
    if (root.kind === "directory") {
      if (root.path === "") return { kind: "directory", path: "" };
      const found = byKey.get(canonicalPathKey(segments));
      if (!found?.directory) throw new ArchiveError("missing-root", root.path);
      return { kind: "directory", path: found.path };
    }
    const found = byKey.get(canonicalPathKey(segments));
    if (!found || found.directory) throw new ArchiveError("missing-root", root.path);
    return { kind: "file", path: found.path };
  });
  for (const key of comments.keys()) {
    const found = byKey.get(key);
    if (!found || found.directory) throw new ArchiveError("malformed-comments", found?.path);
  }
  return { manifest, roots, entries, comments: new Map([...comments].map(([key, value]) =>
    [byKey.get(key)!.path, value])), expandedBytes, nodeCount: entries.length, maxDepth, sourceBytes };
}
