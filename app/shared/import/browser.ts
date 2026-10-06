/**
 * Browser adapters for the Import preflight (ticket 29).
 *
 * Reads a local selection into raw inputs, loads the current File documents a
 * Replace candidate needs through the existing proof-guarded tree reads, and
 * signs File heads with this browser's device assertion key. No Import session
 * or upload endpoint exists in this module.
 */

import { getDevice } from "~/shared/device/store";
import { createFileHead, type FileHead, type FileHeadIdentity } from "~/shared/tree/file-head";
import { createListingHead, type ListingHead } from "~/shared/tree/listing";
import { loadFile, type RootAccess } from "~/shared/tree/client";
import { IMPORT_LIMITS, ImportError } from "./limits";
import type { ImportReplacementDocument } from "./plan";
import type { ImportListingEntry } from "./review";
import type { ImportReview } from "./review";
import type { RawImportInput } from "./source";

/** Defensive ceiling above the settled 100-node bound; prevents a runaway walk. */
const MAX_RAW_INPUTS = 10_000;

async function readFile(file: File, path: string, total: { bytes: number }): Promise<RawImportInput> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  total.bytes += buffer.length;
  if (total.bytes > IMPORT_LIMITS.maxExpandedBytes) {
    throw new ImportError("expanded-too-large", {
      item: path,
      limit: IMPORT_LIMITS.maxExpandedBytes,
      measured: total.bytes,
      action: "split",
    });
  }
  return { path, bytes: buffer };
}

function relativePath(file: File): string {
  const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return path && path.length ? path : file.name;
}

/** Read one `<input type="file">` selection (loose Files or a selected folder). */
export async function inputsFromFiles(files: Iterable<File>): Promise<RawImportInput[]> {
  const inputs: RawImportInput[] = [];
  const total = { bytes: 0 };
  for (const file of files) {
    if (inputs.length >= MAX_RAW_INPUTS) {
      throw new ImportError("too-many-nodes", {
        limit: IMPORT_LIMITS.maxNodes,
        measured: inputs.length + 1,
        action: "split",
      });
    }
    inputs.push(await readFile(file, relativePath(file), total));
  }
  return inputs;
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  inputs: RawImportInput[],
  total: { bytes: number },
): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    if (inputs.length >= MAX_RAW_INPUTS) {
      throw new ImportError("too-many-nodes", {
        limit: IMPORT_LIMITS.maxNodes,
        measured: inputs.length + 1,
        action: "split",
      });
    }
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    inputs.push(await readFile(file, path, total));
    return;
  }
  if (!entry.isDirectory) return;
  inputs.push({ path, directory: true });
  const children = await readEntries((entry as FileSystemDirectoryEntry).createReader());
  for (const child of children) await walkEntry(child, path, inputs, total);
}

/** Read a drag-and-drop selection, including explicitly empty folders. */
export async function inputsFromDataTransfer(dataTransfer: DataTransfer): Promise<RawImportInput[]> {
  const inputs: RawImportInput[] = [];
  const total = { bytes: 0 };
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file" || typeof item.webkitGetAsEntry !== "function") continue;
    const entry = item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }
  if (entries.length) {
    for (const entry of entries) await walkEntry(entry, "", inputs, total);
    return inputs;
  }
  return inputsFromFiles(Array.from(dataTransfer.files));
}

/** The importing browser's device signer for new File and Directory listing heads. */
export async function importSigners(access: RootAccess): Promise<{
  signFileHead: (identity: Omit<FileHeadIdentity, "deviceId">) => Promise<FileHead>;
  signListingHead: (input: {
    parentKey: Uint8Array;
    vaultId: string;
    directoryId: string;
    keyEpoch: number;
    revision: number;
    entries: readonly ImportListingEntry[];
  }) => Promise<ListingHead>;
}> {
  const device = await getDevice(access.actorAccountId);
  if (!device) throw new ImportError("replacement-unavailable", { reason: "device-unavailable", action: "fix" });
  return {
    signFileHead: (identity) =>
      createFileHead(device.assertionKeyPair.privateKey, { ...identity, deviceId: device.deviceId }),
    signListingHead: (input) =>
      createListingHead(input.parentKey, device.assertionKeyPair.privateKey, {
        vaultId: input.vaultId,
        directoryId: input.directoryId,
        deviceId: device.deviceId,
        keyEpoch: input.keyEpoch,
        revision: input.revision,
        entries: input.entries,
      }),
  };
}

/**
 * Load the current document for every Replace candidate through the existing
 * tree read. A File that changed or cannot be edited fails the whole plan
 * before any session exists.
 */
export async function loadReplacementDocuments(
  access: RootAccess,
  targetKey: Uint8Array,
  review: ImportReview,
): Promise<Map<string, ImportReplacementDocument>> {
  const documents = new Map<string, ImportReplacementDocument>();
  for (const node of review.nodes) {
    if (node.action !== "replace" || !node.existingNodeId) continue;
    let document;
    try {
      document = await loadFile(access, node.existingNodeId, targetKey);
    } catch {
      throw new ImportError("replacement-unavailable", { item: node.displayPath.join("/"), action: "fix" });
    }
    if (!document.canEdit || document.revision < 1) {
      throw new ImportError("replacement-unavailable", { item: node.displayPath.join("/"), action: "fix" });
    }
    documents.set(node.existingNodeId, document);
  }
  return documents;
}
