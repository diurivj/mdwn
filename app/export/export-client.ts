/**
 * Owned Files export (ticket 28): browser-only decryption and ZIP creation.
 *
 * The adapter below is the only place export touches the service, and it uses
 * the existing proof-guarded private reads, whose responses are ciphertext
 * only. Plaintext Markdown and Comment bodies are opened in this browser and
 * never submitted anywhere; no export-specific endpoint exists, and export
 * performs no writes. Publication state, Shares, Grants, capabilities, keys,
 * credentials, sessions, and local drafts are never read or serialized.
 */

import { type ArchiveRoot, type HistoricalComment } from "~/archive/format";
import { createZip } from "~/archive/zip";
import { loadAllPrivateComments } from "~/comments/comments-client";
import { normalizeCommentText } from "~/comments/content";
import { canonicalizeSegment } from "~/namespace-v1";
import {
  loadDirectory, loadFile, openChildDirectory, openRoot, type RootAccess, type TreeEntry,
} from "~/tree/client";
import {
  buildArchiveFiles, collectExportFile, collectExportTree, ExportError,
  type CollectedExport, type ExportProgress, type ExportSource,
} from "./collect";

export type ExportSelection =
  | { kind: "all" }
  | { kind: "file"; fileId: string; parentKey: Uint8Array; name: string }
  | { kind: "directory"; directoryId: string; key: Uint8Array; name: string };

export type ExportResult = {
  blob: Blob;
  filename: string;
  files: number;
  directories: number;
  comments: number;
  incompleteCommentFiles: number;
};

export type { ExportProgress };

function createSource(access: RootAccess): ExportSource<TreeEntry> {
  return {
    async listDirectory(directoryId, key, signal) {
      return (await loadDirectory(access, directoryId, key, signal)).entries;
    },
    async openDirectory(parentKey, entry) {
      return openChildDirectory(access, parentKey, entry);
    },
    async readFile(fileId, parentKey, signal) {
      const file = await loadFile(access, fileId, parentKey, signal);
      let loaded: Awaited<ReturnType<typeof loadAllPrivateComments>>;
      try {
        loaded = await loadAllPrivateComments(access, fileId, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        // Comment history must not block exporting the File's exact source.
        loaded = { comments: [], pseudonyms: new Map(), complete: false };
      }
      const comments: HistoricalComment[] = [];
      for (const comment of loaded.comments) {
        const pseudonym = loaded.pseudonyms.get(comment.authorId);
        if (comment.text === null || pseudonym === undefined) continue;
        comments.push({ sequence: comment.sequence, text: normalizeCommentText(comment.text),
          pseudonym, createdAt: comment.createdAt, updatedAt: comment.updatedAt });
      }
      return { markdown: file.markdown, comments,
        commentsComplete: loaded.complete && comments.length === loaded.comments.length };
    },
  };
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/[ .]+$/g, "").trim();
  return cleaned ? Array.from(cleaned).slice(0, 80).join("") : "export";
}

export function archiveFilename(selection: ExportSelection, at: Date): string {
  const stamp = at.toISOString().slice(0, 10);
  return selection.kind === "all" ? `mdwn-files-${stamp}.zip`
    : `mdwn-${sanitizeFilename(selection.name)}-${stamp}.zip`;
}

/**
 * Decrypt every requested owned File and Directory and build one ZIP.
 * A selected Directory is included as a child of the archive root; "all"
 * places the account's owned contents at the archive root.
 */
export async function exportOwnedFiles(options: {
  selection?: ExportSelection;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
  now?: () => Date;
} = {}): Promise<ExportResult> {
  const signal = options.signal ?? new AbortController().signal;
  const access = await openRoot(signal);
  if (access.vaultId !== access.actorAccountId) throw new ExportError("not_owned");
  const source = createSource(access);
  const selection = options.selection ?? { kind: "all" };
  const at = options.now?.() ?? new Date();
  let collected: CollectedExport;
  let roots: ArchiveRoot[];
  if (selection.kind === "all") {
    collected = await collectExportTree(access, source,
      { directoryId: access.rootId, key: access.rootKey, path: [], includeRoot: false },
      { signal, onProgress: options.onProgress });
    roots = [{ kind: "directory", path: "" }];
  } else if (selection.kind === "directory") {
    const name = canonicalizeSegment(selection.name).display;
    collected = await collectExportTree(access, source,
      { directoryId: selection.directoryId, key: selection.key, path: [name], includeRoot: true },
      { signal, onProgress: options.onProgress });
    roots = [{ kind: "directory", path: collected.directories[0]!.join("/") }];
  } else {
    collected = await collectExportFile(access, source,
      { fileId: selection.fileId, parentKey: selection.parentKey, name: selection.name },
      { signal, onProgress: options.onProgress });
    roots = [{ kind: "file", path: collected.files[0]!.path.join("/") }];
  }
  const bytes = await createZip(buildArchiveFiles(collected, { createdAt: at.toISOString(), roots }), { at });
  return { blob: new Blob([bytes.slice()], { type: "application/zip" }), filename: archiveFilename(selection, at),
    files: collected.files.length, directories: collected.directories.length,
    comments: collected.files.reduce((total, file) => total + file.comments.length, 0),
    incompleteCommentFiles: collected.incompleteCommentFiles };
}

/** Hand one finished archive to the browser's download UI; nothing leaves the device. */
export function downloadExport(result: ExportResult): void {
  const url = URL.createObjectURL(result.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
