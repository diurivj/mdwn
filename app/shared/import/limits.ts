/**
 * Import preflight bounds (ticket 29).
 *
 * These are the settled product bounds from `docs/buildable-spec.md` §9.8 and
 * the locked staging envelope from wayfinder ticket 26. They are safe local
 * validation limits: exceeding one produces a visible review problem and
 * creates no Import session, upload, or visible row.
 */

import {
  MAX_ARCHIVE_COMPRESSED_BYTES,
  MAX_ARCHIVE_DEPTH,
  MAX_ARCHIVE_EXPANDED_BYTES,
  MAX_ARCHIVE_NODES,
  MAX_HISTORICAL_COMMENTS,
} from "~/shared/archive/format";
import { FILE_SOURCE_LIMIT } from "~/shared/crypto/file-source";

export type ImportLimits = {
  /** At most 100 normalized source File/Directory nodes; skips and replaces still count. */
  maxNodes: number;
  /** At most 32 normalized Directory segments in one source path. */
  maxDepth: number;
  /** At most 256 KiB UTF-8 per Markdown source. */
  maxSourceBytes: number;
  /** At most 8 MiB compressed for a recognized archive. */
  maxCompressedBytes: number;
  /** At most 16 MiB expanded for every selection; manifests and sidecars count. */
  maxExpandedBytes: number;
  /** At most 1,000 Historical Comments. */
  maxComments: number;
};

export const IMPORT_LIMITS: ImportLimits = {
  maxNodes: MAX_ARCHIVE_NODES,
  maxDepth: MAX_ARCHIVE_DEPTH,
  maxSourceBytes: FILE_SOURCE_LIMIT,
  maxCompressedBytes: MAX_ARCHIVE_COMPRESSED_BYTES,
  maxExpandedBytes: MAX_ARCHIVE_EXPANDED_BYTES,
  maxComments: MAX_HISTORICAL_COMMENTS,
};

/** One Import staging chunk holds at most 512 KiB of raw record payload. */
export const MAX_STAGING_CHUNK_BYTES = 524_288;
/** One Import session accepts 1–40 chunks. */
export const MAX_STAGING_CHUNKS = 40;
/** One chunk carries at most 50 complete canonical-record descriptors. */
export const MAX_STAGING_CHUNK_RECORDS = 50;
/** One session accepts at most 20 MiB of chunk payload. */
export const MAX_STAGING_PAYLOAD_BYTES = 20_971_520;
/** The encrypted Import staging manifest is at most 128 KiB. */
export const MAX_STAGING_MANIFEST_BYTES = 131_072;
/** One session carries at most 2,000 descriptors. */
export const MAX_STAGING_RECORDS = 2_000;

export type ImportErrorCode =
  | "empty-selection"
  | "unsupported-input"
  | "not-utf8"
  | "invalid-path"
  | "duplicate-source-path"
  | "too-many-nodes"
  | "too-deep"
  | "source-too-large"
  | "expanded-too-large"
  | "archive-too-large"
  | "too-many-comments"
  | "ineligible-target"
  | "name-in-use"
  | "generated-name-invalid"
  | "nothing-to-import"
  | "replacement-unavailable"
  | "historical-comments-replace"
  | "plan-record-too-large"
  | "plan-too-large"
  | "staging-upload-failed"
  | "staging-changed"
  | "import-expired";

export type ImportProblemAction = "remove" | "fix" | "re-export" | "split";

/** A local, safe Import failure: `detail` never carries file content. */
export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    readonly detail?: { item?: string; limit?: number; measured?: number; action?: ImportProblemAction; reason?: string },
  ) {
    super(`mdwn/import: ${code}${detail?.item ? ` (${detail.item})` : ""}`);
    this.name = "ImportError";
  }
}

/** The user-visible failure message for one review problem. */
export function importProblemMessage(error: ImportError): string {
  const name = error.detail?.item ? `“${error.detail.item}”` : "This selection";
  switch (error.code) {
    case "empty-selection": return "Choose at least one Markdown File or folder.";
    case "unsupported-input": return `${name} is not supported. Import accepts a recognized mdwn archive, or UTF-8 .md/.markdown Files and folders. Remove it and try again.`;
    case "not-utf8": return `${name} is not valid UTF-8 Markdown. Fix or re-encode the File, then retry.`;
    case "invalid-path": return `${name} has a name mdwn cannot represent. Rename it and try again.`;
    case "duplicate-source-path": return `${name} duplicates another selected path (Files treats case and equivalent Unicode spelling as the same name). Remove the duplicate and retry.`;
    case "too-many-nodes": return `The selection has ${error.detail?.measured ?? "more"} items; one import accepts at most ${error.detail?.limit}. Split the selection and retry.`;
    case "too-deep": return `${name} is nested deeper than ${error.detail?.limit} folders. Move some folders up a level or split the selection.`;
    case "source-too-large": return `${name} is larger than the ${formatBytes(error.detail?.limit ?? 0)} Markdown limit. Reduce or split the File, then retry.`;
    case "expanded-too-large": return `The selection expands to more than ${formatBytes(error.detail?.limit ?? 0)}. Split it into smaller imports.`;
    case "archive-too-large": return `The archive is larger than the ${formatBytes(error.detail?.limit ?? 0)} compressed limit. Re-export a smaller selection or split it.`;
    case "too-many-comments": return `The archive carries more than ${error.detail?.limit} Historical Comments. Reduce the Comment history or split the export.`;
    case "ineligible-target": return "Choose a folder you own or one shared with you for editing.";
    case "name-in-use": return `${name}: that name is already used in the destination folder. Choose another name.`;
    case "generated-name-invalid": return `${name} cannot take a Keep-both suffix within the 255-byte name limit. Rename it, Skip it, or Replace an existing File.`;
    case "nothing-to-import": return "Every item is skipped. Nothing would be created.";
    case "replacement-unavailable": return `${name} changed since the review, so Replace is no longer available. Refresh and try again.`;
    case "historical-comments-replace": return `${name} carries Historical Comments, but you chose Replace. mdwn cannot merge historical Comments into an existing thread. Choose Keep both or Skip instead.`;
    case "plan-record-too-large": return `${name} exceeds its encrypted ${formatBytes(error.detail?.limit ?? 0)} field limit. Remove, fix, or split it.`;
    case "plan-too-large": return "The encrypted import plan exceeds the bounded staging envelope. Remove files or split the selection and retry.";
    case "staging-upload-failed": return "The upload was interrupted before the final step. Check the folder; if the import is not visible, you can retry it safely.";
    case "staging-changed": return "This Import changed on the server, so it was not committed. Refresh the folder, review again, and retry.";
    case "import-expired": return "This Import session expired before it committed. Nothing became visible; review and retry.";
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576 && bytes % 1_048_576 === 0) return `${bytes / 1_048_576} MiB`;
  if (bytes >= 1_024 && bytes % 1_024 === 0) return `${bytes / 1_024} KiB`;
  return `${bytes} bytes`;
}
