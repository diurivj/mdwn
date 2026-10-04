/**
 * Pure owned-Files export collection (ticket 28).
 *
 * The collector walks a decrypted Directory tree through an injected
 * `ExportSource`, allocates deterministic archive paths, and produces the
 * `.mdwn/manifest.json` plus `.mdwn/private-comments.json` representation.
 * It never performs network I/O itself, so no plaintext can reach the service
 * from this module; the production adapter in `export-client.ts` supplies the
 * proof-guarded readers that return ciphertext-only responses.
 *
 * Path allocation mirrors `mdwn/namespace-v1`: Directory names are fixed (a
 * Directory never silently merges or renames), while File names append `.md`
 * unless they already carry a `.md`/`.markdown` extension. A collision that
 * this mapping creates — including folded case/Unicode collisions — uses the
 * same Keep-both suffix rule as Import, so the produced archive always passes
 * the Import duplicate-path preflight.
 */

import {
  canonicalizeSegment, comparisonKey, keepBothCandidate, NamespaceError, utf8Bytes,
} from "~/namespace-v1";
import {
  ARCHIVE_COMMENTS_PATH, ARCHIVE_MANIFEST_PATH, ARCHIVE_METADATA_DIRECTORY,
  createArchiveManifest, createPrivateCommentsSidecar, serializeArchiveManifest,
  serializePrivateCommentsSidecar, type ArchiveRoot, type HistoricalComment,
} from "~/archive/format";

export class ExportError extends Error {
  constructor(
    readonly code: "not_owned" | "invalid_name" | "reserved_name" | "name_exhausted" | "too_deep",
    readonly detail?: string,
  ) {
    super(`mdwn/export: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "ExportError";
  }
}

export type ExportEntry = { nodeId: string; kind: "directory" | "file"; name: string };

export type ExportProgress = { directories: number; files: number };

export type ExportSource<Entry extends ExportEntry> = {
  listDirectory(directoryId: string, key: Uint8Array, signal: AbortSignal): Promise<readonly Entry[]>;
  openDirectory(parentKey: Uint8Array, entry: Entry): Promise<Uint8Array>;
  /** `commentsComplete: false` means some Comment display data was unreadable. */
  readFile(fileId: string, parentKey: Uint8Array, signal: AbortSignal): Promise<{
    markdown: string; comments: readonly HistoricalComment[]; commentsComplete: boolean;
  }>;
};

export type CollectedFile = {
  path: string[];
  markdown: string;
  comments: readonly HistoricalComment[];
  commentsComplete: boolean;
};

export type CollectedExport = {
  /** Archive-relative Directory paths, each a sequence of display segments. */
  directories: string[][];
  files: CollectedFile[];
  incompleteCommentFiles: number;
};

export type ArchiveFile = { path: string; directory: boolean; data: Uint8Array };

const encoder = new TextEncoder();
const MD_EXTENSION = /\.(md|markdown)$/i;
/** Defensive ceiling well above both the Import depth bound and any practical Vault. */
export const MAX_EXPORT_DIRECTORY_DEPTH = 256;

function comparisonToken(segment: string): string {
  let token = "";
  for (const byte of comparisonKey(segment)) token += byte.toString(16).padStart(2, "0");
  return token;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}

/** Append `.md` unless the File already carries a Markdown extension or the result would break the segment profile. */
export function exportFileName(name: string): string {
  if (MD_EXTENSION.test(name)) return name;
  const candidate = `${name}.md`;
  try { return canonicalizeSegment(candidate).display; }
  catch { return name; }
}

export type ExportPathAllocation = { nodeId: string; directory: boolean; segments: string[] };

/**
 * Allocate archive paths for one Directory's children. Directory display names
 * are preserved exactly; File candidates that collide with a preserved
 * Directory name or another File candidate get the locked Keep-both suffix.
 */
export function allocateExportPaths(parent: readonly string[], children: readonly ExportEntry[]): ExportPathAllocation[] {
  const allocations = new Map<string, ExportPathAllocation>();
  const used = new Set<string>();
  const ordered = children.slice().sort((a, b) =>
    compareBytes(utf8Bytes(a.name), utf8Bytes(b.name)) || a.nodeId.localeCompare(b.nodeId));
  for (const child of ordered) {
    if (child.kind !== "directory") continue;
    let display: string;
    try { display = canonicalizeSegment(child.name).display; }
    catch (error) {
      if (error instanceof NamespaceError) throw new ExportError("invalid_name", child.name);
      throw error;
    }
    if (!parent.length && comparisonToken(display) === comparisonToken(ARCHIVE_METADATA_DIRECTORY)) {
      throw new ExportError("reserved_name", display);
    }
    if (used.has(comparisonToken(display))) throw new ExportError("invalid_name", child.name);
    used.add(comparisonToken(display));
    allocations.set(child.nodeId, { nodeId: child.nodeId, directory: true, segments: [...parent, display] });
  }
  for (const child of ordered) {
    if (child.kind !== "file") continue;
    let chosen: string;
    try { chosen = canonicalizeSegment(exportFileName(child.name)).display; }
    catch (error) {
      if (error instanceof NamespaceError) throw new ExportError("invalid_name", child.name);
      throw error;
    }
    if (used.has(comparisonToken(chosen))) {
      let number = 2;
      for (;;) {
        let candidate;
        try { candidate = keepBothCandidate(chosen, number); }
        catch { throw new ExportError("name_exhausted", child.name); }
        if (!used.has(comparisonToken(candidate.display))) { chosen = candidate.display; break; }
        number += 1;
      }
    }
    used.add(comparisonToken(chosen));
    allocations.set(child.nodeId, { nodeId: child.nodeId, directory: false, segments: [...parent, chosen] });
  }
  return children.map((child) => allocations.get(child.nodeId)!);
}

function assertOwned(access: { vaultId: string; actorAccountId: string }): void {
  if (access.vaultId !== access.actorAccountId) throw new ExportError("not_owned");
}

async function walk<Entry extends ExportEntry>(
  source: ExportSource<Entry>,
  directoryId: string,
  key: Uint8Array,
  path: string[],
  signal: AbortSignal,
  collected: CollectedExport,
  onProgress?: (progress: ExportProgress) => void,
): Promise<void> {
  if (path.length > MAX_EXPORT_DIRECTORY_DEPTH) throw new ExportError("too_deep");
  const entries = await source.listDirectory(directoryId, key, signal);
  for (const allocation of allocateExportPaths(path, entries)) {
    signal.throwIfAborted();
    const entry = entries.find((item) => item.nodeId === allocation.nodeId)!;
    if (allocation.directory) {
      const childKey = await source.openDirectory(key, entry);
      collected.directories.push(allocation.segments);
      onProgress?.({ directories: collected.directories.length, files: collected.files.length });
      await walk(source, entry.nodeId, childKey, allocation.segments, signal, collected, onProgress);
    } else {
      const file = await source.readFile(entry.nodeId, key, signal);
      collected.files.push({ path: allocation.segments, markdown: file.markdown,
        comments: file.comments, commentsComplete: file.commentsComplete });
      if (!file.commentsComplete) collected.incompleteCommentFiles += 1;
      onProgress?.({ directories: collected.directories.length, files: collected.files.length });
    }
  }
}

/** Collect one owned Directory subtree. `includeRoot` adds the selected Directory itself. */
export async function collectExportTree<Entry extends ExportEntry>(
  access: { vaultId: string; actorAccountId: string },
  source: ExportSource<Entry>,
  start: { directoryId: string; key: Uint8Array; path: string[]; includeRoot: boolean },
  options: { signal: AbortSignal; onProgress?: (progress: ExportProgress) => void },
): Promise<CollectedExport> {
  assertOwned(access);
  if (start.includeRoot && start.path.length === 1 &&
      comparisonToken(start.path[0]!) === comparisonToken(ARCHIVE_METADATA_DIRECTORY)) {
    throw new ExportError("reserved_name", start.path[0]);
  }
  options.signal.throwIfAborted();
  const collected: CollectedExport = { directories: [], files: [], incompleteCommentFiles: 0 };
  if (start.includeRoot) collected.directories.push([...start.path]);
  await walk(source, start.directoryId, start.key, start.path, options.signal, collected, options.onProgress);
  return collected;
}

/** Collect exactly one owned File, placed at the archive root. */
export async function collectExportFile<Entry extends ExportEntry>(
  access: { vaultId: string; actorAccountId: string },
  source: ExportSource<Entry>,
  file: { fileId: string; parentKey: Uint8Array; name: string },
  options: { signal: AbortSignal; onProgress?: (progress: ExportProgress) => void },
): Promise<CollectedExport> {
  assertOwned(access);
  options.signal.throwIfAborted();
  const [allocation] = allocateExportPaths([], [{ nodeId: file.fileId, kind: "file", name: file.name }]);
  const entry = await source.readFile(file.fileId, file.parentKey, options.signal);
  options.onProgress?.({ directories: 0, files: 1 });
  return { directories: [], files: [{ path: allocation!.segments, markdown: entry.markdown,
    comments: entry.comments, commentsComplete: entry.commentsComplete }],
  incompleteCommentFiles: entry.commentsComplete ? 0 : 1 };
}

/**
 * Assemble the final archive entries. Metadata is written first; content paths
 * are bytewise-sorted so the same tree always produces the same archive bytes.
 */
export function buildArchiveFiles(
  collected: CollectedExport,
  options: { createdAt: string; roots: readonly ArchiveRoot[] },
): ArchiveFile[] {
  const manifest = createArchiveManifest(options.roots, options.createdAt);
  const files: ArchiveFile[] = [
    { path: ARCHIVE_METADATA_DIRECTORY, directory: true, data: new Uint8Array() },
    { path: ARCHIVE_MANIFEST_PATH, directory: false, data: encoder.encode(serializeArchiveManifest(manifest)) },
  ];
  const commented = collected.files.filter((file) => file.comments.length > 0);
  if (commented.length) {
    const sidecar = createPrivateCommentsSidecar(commented.map((file) => ({
      path: file.path.join("/"), comments: [...file.comments],
    })));
    files.push({ path: ARCHIVE_COMMENTS_PATH, directory: false, data: encoder.encode(serializePrivateCommentsSidecar(sidecar)) });
  }
  const content: ArchiveFile[] = [
    ...collected.directories.map((path): ArchiveFile => ({ path: path.join("/"), directory: true, data: new Uint8Array() })),
    ...collected.files.map((file): ArchiveFile => ({ path: file.path.join("/"), directory: false, data: encoder.encode(file.markdown) })),
  ];
  content.sort((a, b) => compareBytes(utf8Bytes(a.path), utf8Bytes(b.path)));
  return [...files, ...content];
}
