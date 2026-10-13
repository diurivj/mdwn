import type { DirectoryListing, RootAccess, TreeEntry, TreeKind } from "./client";

/**
 * The one rule for accepting a private path, shared by the cold walk, the
 * tab's verified memory and background revalidation (ticket 57), so a path
 * served from memory is exactly a path the cold walk would accept.
 */
export type Crumb = { id: string; name: string };

/** Remembered expanded folders fetched with the selected path, and the most memory serves and revalidation checks. */
export const EXPANDED_CHECKED = 24;

/**
 * The workspace root's name: the person's own library, or the folder or File
 * another Account shared with them.
 */
export function rootName(access: RootAccess): string {
  if (access.rootKind !== "file" && access.vaultId === access.actorAccountId) return "Library";
  return sharedRootName(access.rootKind ?? "directory");
}

/** "File" or "folder"; "Folder" where it starts a sentence or label. */
export function kindName(kind: TreeKind, position: "inline" | "start" = "inline"): string {
  return kind === "file" ? "File" : position === "start" ? "Folder" : "folder";
}

/** A received Grant root's generic label: its name stays encrypted from the recipient. */
export function sharedRootName(kind: TreeKind): string {
  return `Shared ${kindName(kind)}`;
}

/** A shared File root opens only as that single File. */
export function rootAccepts(access: RootAccess, path: readonly string[], kind: TreeKind): boolean {
  return access.rootKind !== "file" || (kind === "file" && path.length === 1);
}

/**
 * The entry for `path[index + 1]` in the listing of `path[index]`, if it may
 * stand there: a Directory before the end, the target's own kind at the end.
 */
export function pathStep(
  listing: DirectoryListing | undefined,
  path: readonly string[],
  index: number,
  kind: TreeKind,
): TreeEntry | null {
  const next = path[index + 1];
  const entry = next === undefined ? undefined : listing?.entries.find((child) => child.nodeId === next);
  if (!entry || entry.kind !== (index === path.length - 2 ? kind : "directory")) return null;
  return entry;
}

/** Breadcrumbs for a path every listing on it accepts, or null. */
export function pathCrumbs(
  access: RootAccess,
  path: readonly string[],
  listings: Readonly<Record<string, DirectoryListing>>,
  kind: TreeKind,
): Crumb[] | null {
  if (path[0] !== access.rootId || !rootAccepts(access, path, kind)) return null;
  const crumbs: Crumb[] = [{ id: access.rootId, name: rootName(access) }];
  for (let index = 0; index < path.length - 1; index++) {
    const entry = pathStep(listings[path[index]!], path, index, kind);
    if (!entry) return null;
    crumbs.push({ id: entry.nodeId, name: entry.name });
  }
  return crumbs;
}

/**
 * The next level of remembered folders to restore: those a listing already
 * open reveals as a Directory whose parent key is open. Preferences are
 * browser-only and never encoded in a deep link, so nothing else is restored.
 * Folders already open, or revealed as something else, leave `pending`.
 */
export function restorableFolders(
  pending: Set<string>,
  listings: Readonly<Record<string, DirectoryListing>>,
  keys: Readonly<Record<string, Uint8Array>>,
): { id: string; entry: TreeEntry; parentId: string }[] {
  const level: { id: string; entry: TreeEntry; parentId: string }[] = [];
  for (const id of pending) {
    if (listings[id]) {
      pending.delete(id);
      continue;
    }
    const parent = Object.values(listings).find((listing) => listing.entries.some((entry) => entry.nodeId === id));
    const entry = parent?.entries.find((item) => item.nodeId === id);
    if (!parent || !entry) continue;
    pending.delete(id);
    if (entry.kind === "directory" && keys[parent.directoryId]) level.push({ id, entry, parentId: parent.directoryId });
  }
  return level;
}

/**
 * Whether `parent` — an accepted listing — has a Directory entry for
 * `childId` at this key epoch. A Directory key is kept only with the accepted
 * entry that proves its epoch, so a key opened from an older entry (before a
 * Key rotation, say) never stands beside a newer listing.
 */
export function keyProven(parent: DirectoryListing | undefined, childId: string, epoch: number): boolean {
  const entry = parent?.entries.find((child) => child.nodeId === childId);
  return entry?.kind === "directory" && (entry.keyEpoch ?? 1) === epoch;
}

/** The parent and key epoch of the Directory entry a key was opened from, in the listings it was opened with. */
export function keyOpenedFrom(
  listings: Readonly<Record<string, DirectoryListing>>,
  childId: string,
): { parentId: string; epoch: number } | null {
  for (const listing of Object.values(listings)) {
    const entry = listing.entries.find((child) => child.nodeId === childId);
    if (entry?.kind === "directory") return { parentId: listing.directoryId, epoch: entry.keyEpoch ?? 1 };
  }
  return null;
}

type Opened = { listings: Record<string, DirectoryListing>; keys: Record<string, Uint8Array> };

/**
 * Merge a later result over what a page holds without going backwards: a
 * listing is replaced only by one at the same or a newer revision (one
 * browser's rollback checkpoint makes a same-revision listing the same head),
 * and a child key only when the merged parent entry proves its epoch.
 */
export function mergeListings(previous: Opened, update: Opened): Opened {
  const listings = { ...previous.listings };
  for (const [id, listing] of Object.entries(update.listings)) {
    const held = previous.listings[id];
    if (!held || held.entriesRevision <= listing.entriesRevision) listings[id] = listing;
  }
  const keys = { ...previous.keys };
  for (const [id, key] of Object.entries(update.keys)) {
    const source = keyOpenedFrom(update.listings, id);
    if (source ? keyProven(listings[source.parentId], id, source.epoch) : !keys[id]) keys[id] = key;
  }
  return { listings, keys };
}
