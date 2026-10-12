import type { DirectoryListing, RootAccess, TreeKind } from "./client";
import { isV7 } from "./wire";

/**
 * The tab's memory of what it has already verified in the private tree
 * (ticket 57): opened root and Grant-root access, verified Directory listings
 * with the head digest they were verified against, and opened Directory keys.
 * A revisit renders from it at once, then revalidates in the background.
 *
 * It holds no File content and no File capability or content key: a File is
 * fetched and opened every time it is shown. It lives in memory only, is
 * never persisted or posted, holds at most `limit` listings and keys (least
 * recently used first out), and belongs to one Account and Encryption device
 * at one device-state generation. A different scope or generation in device
 * state is a miss and clears it, so every discard of device state (sign-in,
 * sign-out, recovery, enrollment, `401`, mismatches) also forgets it.
 */
export type TreeCacheScope = { accountId: string; deviceId: string };
export type VerifiedListing = { listing: DirectoryListing; digest: string };
export type VerifiedTree = {
  access: RootAccess;
  listings: Record<string, VerifiedListing>;
  keys: Record<string, Uint8Array>;
};
export type PathSnapshot = {
  access: RootAccess;
  /** Root first; ends with the target, which is a File for a File target. */
  path: string[];
  listings: Record<string, DirectoryListing>;
  keys: Record<string, Uint8Array>;
};
export type TreeCacheChange =
  | { type: "invalidate"; directoryIds: string[]; origin: "local" | "remote" }
  | { type: "clear" };

const DEFAULT_LIMIT = 200;
/** Grant roots are few; this only bounds a long session that opens many. */
const ROOT_LIMIT = 32;
/** The private path bound the Worker enforces (ticket 16). */
const MAX_DEPTH = 101;

type KeyRecord = { key: Uint8Array; epoch: number };

export class VerifiedTreeCache {
  readonly #limit: number;
  readonly #generation: () => number;
  readonly #scope: () => TreeCacheScope | null;
  #filled: { generation: number; scope: TreeCacheScope } | null = null;
  #libraryRootId: string | null = null;
  readonly #roots = new Map<string, RootAccess>();
  /** Map order is recency: the first entry is the least recently used. */
  readonly #listings = new Map<string, VerifiedListing>();
  readonly #keys = new Map<string, KeyRecord>();
  /** Child node id → the cached Directory listing that contains it. */
  readonly #parents = new Map<string, string>();
  readonly #listeners = new Set<(change: TreeCacheChange) => void>();

  constructor(options: { limit?: number; generation: () => number; scope: () => TreeCacheScope | null }) {
    this.#limit = options.limit ?? DEFAULT_LIMIT;
    this.#generation = options.generation;
    this.#scope = options.scope;
  }

  /** Cached listings. */
  get size(): number {
    return this.#listings.size;
  }

  /** The Account this memory belongs to, or null when it is empty or outdated. */
  get accountId(): string | null {
    return this.#current() ? this.#filled!.scope.accountId : null;
  }

  /**
   * The root and every listing and key on the target's path, rebuilt from
   * cached parent links, or null unless all of them are cached and agree. A
   * null target is the Account's own library root. Remembered expanded
   * folders are included when a listing already included reveals them.
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
    if (!access) return null;
    const kind = target?.kind ?? "directory";
    if (access.rootKind === "file" && (kind !== "file" || path.length !== 1)) return null;
    const listings: Record<string, DirectoryListing> = {};
    const keys: Record<string, Uint8Array> = { [access.rootId]: access.rootKey };
    const directories = kind === "file" ? path.slice(0, -1) : path;
    for (let index = 0; index < directories.length; index++) {
      const directoryId = directories[index]!;
      const record = this.#listings.get(directoryId);
      if (!record || !keys[directoryId]) return null;
      listings[directoryId] = record.listing;
      const next = path[index + 1];
      if (!next) continue;
      const entry = record.listing.entries.find((child) => child.nodeId === next);
      const last = index === path.length - 2;
      if (!entry || entry.kind !== (last ? kind : "directory")) return null;
      if (entry.kind === "directory") {
        const key = this.#key(next, entry.keyEpoch ?? 1);
        if (!key) return null;
        keys[next] = key;
      }
    }
    // Restore remembered folders level by level, as a cold load would, from memory only.
    const pending = new Set(remembered(access.actorAccountId).filter((id) => !listings[id]));
    for (let added = true; added && pending.size; ) {
      added = false;
      for (const id of pending) {
        const parent = this.#parents.get(id);
        const entry = parent && listings[parent]?.entries.find((child) => child.nodeId === id);
        if (!entry) continue;
        pending.delete(id);
        const record = this.#listings.get(id);
        const key = entry.kind === "directory" ? this.#key(id, entry.keyEpoch ?? 1) : null;
        if (!record || !key) continue;
        listings[id] = record.listing;
        keys[id] = key;
        added = true;
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
   * the walk started under: results from before a discard, or for an Account
   * other than device state's, are refused. Returns whether it was kept.
   */
  record(tree: VerifiedTree, since: number): boolean {
    const scope = this.#scope();
    if (since !== this.#generation() || !scope || scope.accountId !== tree.access.actorAccountId) return false;
    if (this.#filled && (this.#filled.generation !== since || !sameScope(this.#filled.scope, scope))) this.clear();
    this.#filled = { generation: since, scope };
    const { access } = tree;
    this.#roots.delete(access.rootId);
    this.#roots.set(access.rootId, access);
    if (access.vaultId === access.actorAccountId) this.#libraryRootId = access.rootId;
    for (const rootId of this.#roots.keys()) {
      if (this.#roots.size <= ROOT_LIMIT) break;
      if (rootId !== this.#libraryRootId) this.#roots.delete(rootId);
    }
    for (const [directoryId, verified] of Object.entries(tree.listings)) {
      if (verified.listing.directoryId !== directoryId) continue;
      this.#dropListing(directoryId);
      this.#listings.set(directoryId, verified);
      for (const child of verified.listing.entries) {
        this.#parents.set(child.nodeId, directoryId);
        // A key opened from an older entry no longer matches its parent's verified listing.
        const key = this.#keys.get(child.nodeId);
        if (key && (child.kind !== "directory" || key.epoch !== (child.keyEpoch ?? 1))) this.#keys.delete(child.nodeId);
      }
    }
    for (const [directoryId, key] of Object.entries(tree.keys)) {
      if (this.#roots.has(directoryId)) continue; // Root keys belong to their access.
      const parent = this.#parents.get(directoryId);
      const entry = parent
        ? this.#listings.get(parent)?.listing.entries.find((child) => child.nodeId === directoryId)
        : undefined;
      if (entry?.kind !== "directory") continue; // A key is kept only with the entry that proves its epoch.
      this.#keys.delete(directoryId);
      this.#keys.set(directoryId, { key, epoch: entry.keyEpoch ?? 1 });
    }
    while (this.#listings.size > this.#limit) this.#dropListing(this.#listings.keys().next().value!);
    while (this.#keys.size > this.#limit) this.#keys.delete(this.#keys.keys().next().value!);
    return true;
  }

  /** Drop these Directories' listings. Keys stay, checked against the next verified parent. */
  invalidate(accountId: string, directoryIds: readonly string[], origin: "local" | "remote"): void {
    if (!this.#current() || this.#filled!.scope.accountId !== accountId) return;
    for (const id of directoryIds) this.#dropListing(id);
    this.#emit({ type: "invalidate", directoryIds: [...directoryIds], origin });
  }

  /** Forget a root's access, so the next load opens it again. */
  forgetRoot(rootId: string): void {
    this.#roots.delete(rootId);
    if (this.#libraryRootId === rootId) this.#libraryRootId = null;
  }

  clear(): void {
    const had = this.#filled !== null || this.#roots.size > 0 || this.#listings.size > 0;
    this.#filled = null;
    this.#libraryRootId = null;
    this.#roots.clear();
    this.#listings.clear();
    this.#keys.clear();
    this.#parents.clear();
    if (had) this.#emit({ type: "clear" });
  }

  subscribe(listener: (change: TreeCacheChange) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Whether the memory still belongs to device state's current scope and generation; clears it if not. */
  #current(): boolean {
    if (!this.#filled) return false;
    const scope = this.#scope();
    if (this.#generation() === this.#filled.generation && scope && sameScope(scope, this.#filled.scope)) return true;
    this.clear();
    return false;
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

  #emit(change: TreeCacheChange): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
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
 * Directories changed, or that everything must be forgotten. Ids only — never
 * a name, key, ciphertext or snapshot — and receivers accept nothing else.
 */
export type TreeMessage = { type: "invalidate"; accountId: string; directoryIds: string[] } | { type: "clear" };
export const TREE_CHANNEL = "mdwn-tree";
const MAX_MESSAGE_IDS = 256;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Strictly validate a received message: exact fields, opaque ids only. */
export function parseTreeMessage(value: unknown): TreeMessage | null {
  if (!plainObject(value)) return null;
  const fields = Object.keys(value).sort().join(",");
  if (value.type === "clear") return fields === "type" ? { type: "clear" } : null;
  if (value.type !== "invalidate" || fields !== "accountId,directoryIds,type") return null;
  const { accountId, directoryIds } = value;
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
