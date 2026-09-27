import {
  loadAncestors, loadDirectory, loadFile, openChildDirectory, openRoot, TreeNotFoundError,
  type DirectoryListing, type LoadedFile, type RootAccess, type TreeKind,
} from "./client";

export type Crumb = { id: string; name: string };
export type FilesSnapshot = {
  access: RootAccess;
  listings: Record<string, DirectoryListing>;
  keys: Record<string, Uint8Array>;
  crumbs: Crumb[];
  file: LoadedFile | null;
};
export type FilesPageData = { status: "ready"; snapshot: FilesSnapshot } |
  { status: "not-found" | "unavailable"; snapshot: null };

export const expandedPreferenceKey = (accountId: string) => `mdwn:files-expanded:${accountId}`;
export function savedExpanded(accountId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(expandedPreferenceKey(accountId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(0, 200).filter((value): value is string => typeof value === "string") : [];
  } catch { return []; }
}

async function selectedPath(nodeId: string, kind: TreeKind, signal: AbortSignal): Promise<FilesSnapshot> {
  const access = await openRoot(signal);
  const path = await loadAncestors(nodeId, signal);
  if (path[0] !== access.rootId) throw new TreeNotFoundError();
  const listings: Record<string, DirectoryListing> = {};
  const keys: Record<string, Uint8Array> = { [access.rootId]: access.rootKey };
  const crumbs: Crumb[] = [{ id: access.rootId, name: "Files" }];
  let file: LoadedFile | null = null;
  for (let index = 0; index < path.length; index++) {
    const parent = path[index]!;
    // A File is the final path member, not a Directory with a capability.
    if (index === path.length - 1 && kind === "file") break;
    const key = keys[parent];
    if (!key) throw new TreeNotFoundError();
    const listing = await loadDirectory(access, parent, key, signal);
    listings[parent] = listing;
    const next = path[index + 1];
    if (!next) continue;
    const entry = listing.entries.find((child) => child.nodeId === next);
    if (!entry || (index < path.length - 2 && entry.kind !== "directory") ||
        (index === path.length - 2 && entry.kind !== kind)) throw new TreeNotFoundError();
    crumbs.push({ id: next, name: entry.name });
    if (entry.kind === "directory") keys[next] = await openChildDirectory(access, key, entry);
  }
  if (kind === "file") {
    const parent = path.at(-2);
    if (!parent || !keys[parent]) throw new TreeNotFoundError();
    const entry = listings[parent]?.entries.find((child) => child.nodeId === nodeId);
    if (!entry || entry.kind !== "file") throw new TreeNotFoundError();
    file = await loadFile(access, nodeId, parent, keys[parent], entry, signal);
  }
  // Preferences are browser-only, never encoded in a deep link. Restore only
  // descendants discoverable through a decrypted Directory in this Account.
  const pending = new Set(savedExpanded(access.actorAccountId ?? access.vaultId));
  for (let pass = 0; pass < 201 && pending.size; pass++) {
    let progressed = false;
    for (const id of pending) {
      if (listings[id]) { pending.delete(id); continue; }
      const parent = Object.values(listings).find((listing) => listing.entries.some((entry) => entry.nodeId === id));
      const entry = parent?.entries.find((item) => item.nodeId === id);
      if (!parent || !entry || entry.kind !== "directory" || !keys[parent.directoryId]) continue;
      pending.delete(id);
      try {
        const key = await openChildDirectory(access, keys[parent.directoryId], entry);
        keys[id] = key;
        listings[id] = await loadDirectory(access, id, key, signal);
        progressed = true;
      } catch { /* An old local preference must not block opening the selected object. */ }
    }
    if (!progressed) break;
  }
  return { access, listings, keys, crumbs, file };
}

/** Browser-only clientLoader data; SSR renders a public HydrateFallback instead. */
export async function loadFilesPage(nodeId: string, kind: TreeKind, signal: AbortSignal): Promise<FilesPageData> {
  try { return { status: "ready", snapshot: await selectedPath(nodeId, kind, signal) }; }
  catch (error) {
    if (signal.aborted) throw error;
    return { status: error instanceof TreeNotFoundError ? "not-found" : "unavailable", snapshot: null };
  }
}
