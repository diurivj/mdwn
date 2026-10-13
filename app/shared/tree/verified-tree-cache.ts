import type { DirectoryListing, RootAccess, TreeKind } from "./client";
import { headBehind, type ListingMark } from "./listing";
import { EXPANDED_CHECKED, keyProven, pathStep, restorableFolders, rootAccepts } from "./path-rules";
import { isPlainRecord } from "~/shared/plain-record";
import { isV7 } from "./wire";

/**
 * The tab's memory of what it has already verified in the private tree
 * (ticket 57): opened root and Grant-root access, verified Directory listings
 * with the head digest they were verified against, and opened Directory keys.
 * A revisit renders from it at once, then revalidates in the background.
 *
 * It holds no File content and no capability key of a File inside a cached
 * Directory: a File is fetched and opened every time it is shown. (A received
 * File Grant's root access is kept as Grant-root access.) It lives in memory
 * only, is never persisted or posted, holds at most `limit` listings and keys
 * (least recently used first out), and belongs to one Account and Encryption
 * device at one device-state generation. A different scope or generation in
 * device state is a miss and clears it, so every discard of device state
 * also forgets it. It never serves a listing behind this browser's rollback
 * checkpoint, never goes back to an older listing, and refuses to refill
 * while the tab stays hidden after its hidden-timeout clear.
 */
export type TreeCacheScope = { accountId: string; deviceId: string };
export type VerifiedListing = { listing: DirectoryListing; digest: string };
/** An opened Directory key with the key epoch of the entry it was opened from. */
export type OpenedKey = { key: Uint8Array; epoch: number };
export type VerifiedTree = {
  access: RootAccess;
  listings: Record<string, VerifiedListing>;
  keys: Record<string, OpenedKey>;
};
export type PathSnapshot = {
  access: RootAccess;
  /** Root first; ends with the target, which is a File for a File target. */
  path: string[];
  listings: Record<string, DirectoryListing>;
  keys: Record<string, Uint8Array>;
};
/** The browser's rollback checkpoint for a listing (`listingCheckpoint`): none, a head, or unreadable. */
export type ListingCheckpoint = (vaultId: string, directoryId: string) => ListingMark | null | "malformed";

const DEFAULT_LIMIT = 200;
/** Grant roots are few; this only bounds a long session that opens many. */
const ROOT_LIMIT = 32;
/** The private path bound the Worker enforces (ticket 16). */
const MAX_DEPTH = 101;

const markOf = (verified: VerifiedListing): ListingMark => ({
  revision: verified.listing.entriesRevision,
  digest: verified.digest,
});

export class VerifiedTreeCache {
  readonly #limit: number;
  readonly #generation: () => number;
  readonly #scope: () => TreeCacheScope | null;
  readonly #suspended: () => boolean;
  readonly #checkpoint: ListingCheckpoint;
  /** The device state this memory was filled under. */
  #owner: { generation: number; scope: TreeCacheScope } | null = null;
  #libraryRootId: string | null = null;
  readonly #roots = new Map<string, RootAccess>();
  /** Map order is recency: the first entry is the least recently used. */
  readonly #listings = new Map<string, VerifiedListing>();
  readonly #keys = new Map<string, OpenedKey>();
  /** Child node id → the cached Directory listing that contains it. */
  readonly #parents = new Map<string, string>();
  readonly #listeners = new Set<(directoryIds: string[]) => void>();

  constructor(options: {
    limit?: number;
    generation: () => number;
    scope: () => TreeCacheScope | null;
    suspended?: () => boolean;
    checkpoint?: ListingCheckpoint;
  }) {
    this.#limit = options.limit ?? DEFAULT_LIMIT;
    this.#generation = options.generation;
    this.#scope = options.scope;
    this.#suspended = options.suspended ?? (() => false);
    this.#checkpoint = options.checkpoint ?? (() => null);
  }

  /** Cached listings. */
  get size(): number {
    return this.#listings.size;
  }

  /**
   * The root and every listing and key on the target's path, rebuilt from
   * cached parent links, or null unless all of them are cached, current and
   * accepted by the path rule. A null target is the Account's own library
   * root. At most `EXPANDED_CHECKED` remembered expanded folders are added,
   * the ones a listing already included reveals: no more than one background
   * revalidation checks.
   */
  pathSnapshot(
    target: { nodeId: string; kind: TreeKind } | null,
    remembered: (accountId: string) => readonly string[] = () => [],
  ): PathSnapshot | null {
    if (!this.#current()) return null;
    let path: string[];
    let access: RootAccess | undefined;
    if (!target) {
      access = this.#libraryRootId ? this.#roots.get(this.#libraryRootId) : undefined;
      path = access ? [access.rootId] : [];
    } else {
      path = [target.nodeId];
      while (!this.#roots.has(path[0]!)) {
        const parent = this.#parents.get(path[0]!);
        if (!parent || path.length >= MAX_DEPTH) return null;
        path.unshift(parent);
      }
      access = this.#roots.get(path[0]!);
    }
    const kind = target?.kind ?? "directory";
    if (!access || !rootAccepts(access, path, kind)) return null;
    const listings: Record<string, DirectoryListing> = {};
    const keys: Record<string, Uint8Array> = { [access.rootId]: access.rootKey };
    const directories = kind === "file" ? path.slice(0, -1) : path;
    for (let index = 0; index < directories.length; index++) {
      const directoryId = directories[index]!;
      const listing = this.#servable(access, directoryId);
      if (!listing || !keys[directoryId]) return null;
      listings[directoryId] = listing;
      if (index === path.length - 1) continue;
      const entry = pathStep(listing, path, index, kind);
      if (!entry) return null;
      if (entry.kind === "directory") {
        const key = this.#key(entry.nodeId, entry.keyEpoch ?? 1);
        if (!key) return null;
        keys[entry.nodeId] = key;
      }
    }
    const pending = new Set(remembered(access.actorAccountId).filter((id) => !listings[id]));
    for (let added = 0; added < EXPANDED_CHECKED && pending.size; ) {
      const level = restorableFolders(pending, listings, keys);
      if (!level.length) break;
      for (const { id, entry } of level) {
        if (added >= EXPANDED_CHECKED) break;
        const listing = this.#servable(access, id);
        const key = this.#key(id, entry.keyEpoch ?? 1);
        if (!listing || !key) continue;
        listings[id] = listing;
        keys[id] = key;
        added++;
      }
    }
    for (const id of Object.keys(listings)) this.#touch(this.#listings, id);
    return { access, path, listings, keys };
  }

  /** The cached listing and its verified head digest, without changing recency. */
  cached(directoryId: string): VerifiedListing | null {
    return this.#current() ? (this.#listings.get(directoryId) ?? null) : null;
  }

  /**
   * Keep what a verified walk opened. `since` is the device-state generation
   * the walk started under: results from before a discard, for an Account
   * other than device state's, or while the tab stays hidden after its
   * hidden-timeout clear are refused. A listing never replaces a newer one,
   * or another head at the same revision; root access never replaces one
   * with a newer capability epoch; and a key is kept only when the held
   * parent entry proves the epoch it was opened from. So an older walk that
   * records last (across a Key rotation, say) cannot bring back a retired
   * key. Returns whether anything was kept.
   */
  record(tree: VerifiedTree, since: number): boolean {
    const scope = this.#scope();
    if (since !== this.#generation() || !scope || scope.accountId !== tree.access.actorAccountId) return false;
    if (this.#suspended()) return false;
    if (this.#owner && (this.#owner.generation !== since || !sameScope(this.#owner.scope, scope))) this.clear();
    this.#owner = { generation: since, scope };
    const { access } = tree;
    const heldRoot = this.#roots.get(access.rootId);
    if (!heldRoot || (heldRoot.capability?.epoch ?? 1) <= (access.capability?.epoch ?? 1)) {
      this.#roots.delete(access.rootId);
      this.#roots.set(access.rootId, access);
    }
    if (access.vaultId === access.actorAccountId) this.#libraryRootId = access.rootId;
    for (const rootId of this.#roots.keys()) {
      if (this.#roots.size <= ROOT_LIMIT) break;
      if (rootId !== this.#libraryRootId) this.#roots.delete(rootId);
    }
    for (const [directoryId, verified] of Object.entries(tree.listings)) {
      if (verified.listing.directoryId !== directoryId) continue;
      const held = this.#listings.get(directoryId);
      if (held && headBehind(markOf(held), markOf(verified))) continue;
      this.#dropListing(directoryId);
      this.#listings.set(directoryId, verified);
      for (const child of verified.listing.entries) {
        this.#parents.set(child.nodeId, directoryId);
        // A key opened from an older entry no longer matches its parent's verified listing.
        const key = this.#keys.get(child.nodeId);
        if (key && !keyProven(verified.listing, child.nodeId, key.epoch)) this.#keys.delete(child.nodeId);
      }
    }
    for (const [directoryId, opened] of Object.entries(tree.keys)) {
      if (this.#roots.has(directoryId)) continue; // Root keys belong to their access.
      const parent = this.#parents.get(directoryId);
      if (!keyProven(parent ? this.#listings.get(parent)?.listing : undefined, directoryId, opened.epoch)) continue;
      this.#keys.delete(directoryId);
      this.#keys.set(directoryId, opened);
    }
    while (this.#listings.size > this.#limit) this.#dropListing(this.#listings.keys().next().value!);
    while (this.#keys.size > this.#limit) this.#keys.delete(this.#keys.keys().next().value!);
    return true;
  }

  /**
   * Drop these Directories' listings. Keys stay, checked against the next
   * verified parent. Subscribers hear only other tabs' changes: this tab's
   * own changes reach its page through the change itself.
   */
  invalidate(accountId: string, directoryIds: readonly string[], origin: "local" | "remote"): void {
    if (!this.#current() || this.#owner!.scope.accountId !== accountId) return;
    for (const id of directoryIds) this.#dropListing(id);
    if (origin === "remote") this.#emit([...directoryIds]);
  }

  /** Forget a root's access, so the next load opens it again. */
  forgetRoot(rootId: string): void {
    this.#roots.delete(rootId);
    if (this.#libraryRootId === rootId) this.#libraryRootId = null;
  }

  clear(): void {
    this.#owner = null;
    this.#libraryRootId = null;
    this.#roots.clear();
    this.#listings.clear();
    this.#keys.clear();
    this.#parents.clear();
  }

  /** Hear which Directories another tab changed. */
  subscribe(listener: (directoryIds: string[]) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Whether the memory still belongs to device state's current scope and generation; clears it if not. */
  #current(): boolean {
    if (!this.#owner) return false;
    const scope = this.#scope();
    if (this.#generation() === this.#owner.generation && scope && sameScope(scope, this.#owner.scope)) return true;
    this.clear();
    return false;
  }

  /** A cached listing this browser's rollback checkpoint has not moved past; a listing behind it is dropped. */
  #servable(access: RootAccess, directoryId: string): DirectoryListing | null {
    const record = this.#listings.get(directoryId);
    if (!record) return null;
    const checkpoint = this.#checkpoint(access.vaultId, directoryId);
    if (checkpoint === "malformed" || (checkpoint && headBehind(checkpoint, markOf(record)))) {
      this.#dropListing(directoryId);
      return null;
    }
    return record.listing;
  }

  #key(directoryId: string, epoch: number): Uint8Array | null {
    const record = this.#keys.get(directoryId);
    if (!record || record.epoch !== epoch) return null;
    this.#touch(this.#keys, directoryId);
    return record.key;
  }

  #dropListing(directoryId: string): void {
    const record = this.#listings.get(directoryId);
    if (!record) return;
    this.#listings.delete(directoryId);
    for (const child of record.listing.entries)
      if (this.#parents.get(child.nodeId) === directoryId) this.#parents.delete(child.nodeId);
  }

  #touch<T>(map: Map<string, T>, id: string): void {
    const value = map.get(id);
    if (value === undefined) return;
    map.delete(id);
    map.set(id, value);
  }

  #emit(directoryIds: string[]): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(directoryIds);
      } catch {
        // A subscriber's failure must not stop the others.
      }
    }
  }
}

function sameScope(a: TreeCacheScope, b: TreeCacheScope): boolean {
  return a.accountId === b.accountId && a.deviceId === b.deviceId;
}

/**
 * What tabs tell each other on the `mdwn-tree` BroadcastChannel: which
 * Directories changed. Ids only — never a name, key, ciphertext or snapshot —
 * and receivers accept nothing else. The tab-wide clear has its own channel
 * (`private-tab-memory.ts`).
 */
export type TreeMessage = { type: "invalidate"; accountId: string; directoryIds: string[] };
export const TREE_CHANNEL = "mdwn-tree";
const MAX_MESSAGE_IDS = 256;

/** Strictly validate a received message: exact fields, opaque ids only. */
export function parseTreeMessage(value: unknown): TreeMessage | null {
  if (!isPlainRecord(value)) return null;
  const record = value;
  if (record.type !== "invalidate" || Object.keys(record).sort().join(",") !== "accountId,directoryIds,type")
    return null;
  const { accountId, directoryIds } = record;
  if (
    !isV7(accountId) ||
    !Array.isArray(directoryIds) ||
    directoryIds.length < 1 ||
    directoryIds.length > MAX_MESSAGE_IDS ||
    !directoryIds.every(isV7)
  )
    return null;
  return { type: "invalidate", accountId, directoryIds: [...directoryIds] };
}

/** The id-only invalidation to post, or null when anything given is not an opaque id. */
export function invalidateMessage(accountId: string, directoryIds: readonly string[]): TreeMessage | null {
  return parseTreeMessage({ type: "invalidate", accountId, directoryIds: [...new Set(directoryIds)] });
}
