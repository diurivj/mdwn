import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearPrivateTabMemory,
  clearWhenHidden,
  parseMemoryMessage,
  registerPrivateTabMemory,
} from "../app/shared/device/private-tab-memory";
import type { DirectoryListing, RootAccess, TreeEntry } from "../app/shared/tree/client";
import { EXPANDED_CHECKED } from "../app/shared/tree/path-rules";
import {
  invalidateMessage,
  parseTreeMessage,
  VerifiedTreeCache,
  type TreeCacheScope,
} from "../app/shared/tree/verified-tree-cache";

/** Opaque UUIDv7-shaped identifiers, as the tree and the broadcast messages use. */
function id(n: number): string {
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}
const ACCOUNT = id(1);
const ROOT = id(2);
const scope: TreeCacheScope = { accountId: ACCOUNT, deviceId: id(3) };

function key(n: number) {
  return new Uint8Array(32).fill(n);
}
const access: RootAccess = {
  vaultId: ACCOUNT,
  actorAccountId: ACCOUNT,
  rootId: ROOT,
  rootKind: "directory",
  rootKey: key(1),
  actorVaultRootKey: key(9),
  capability: { id: ROOT, epoch: 1 },
};
function entry(nodeId: string, kind: "directory" | "file", name: string, keyEpoch?: number): TreeEntry {
  return {
    nodeId,
    kind,
    name,
    order: name,
    nameCiphertext: `sealed-name-${nodeId}`,
    orderCiphertext: `sealed-order-${nodeId}`,
    keyEnvelope: `sealed-key-${nodeId}`,
    ...(keyEpoch === undefined ? {} : { keyEpoch }),
  };
}
function listing(directoryId: string, entries: TreeEntry[], entriesRevision = 2, keyEpoch?: number): DirectoryListing {
  return { directoryId, entriesRevision, entries, canCreate: true, ...(keyEpoch === undefined ? {} : { keyEpoch }) };
}
/** What a walk records: each key carries the epoch of the entry it was opened from, in this walk's own listings. */
function verified(listings: DirectoryListing[], keys: Record<string, Uint8Array> = {}, root = access) {
  const epochOf = (id: string) =>
    listings.flatMap((item) => item.entries).find((child) => child.nodeId === id)?.keyEpoch ?? 1;
  return {
    access: root,
    listings: Object.fromEntries(
      listings.map((item) => [item.directoryId, { listing: item, digest: `d${item.entriesRevision}` }]),
    ),
    keys: Object.fromEntries(Object.entries(keys).map(([id, value]) => [id, { key: value, epoch: epochOf(id) }])),
  };
}

/** A cache whose device state, rollback checkpoints and hidden expiry are controlled by the test. */
function harness(limit?: number) {
  const state = {
    generation: 1,
    scope: scope as TreeCacheScope | null,
    suspended: false,
    checkpoints: new Map<string, { revision: number; digest: string } | "malformed">(),
  };
  const cache = new VerifiedTreeCache({
    limit,
    generation: () => state.generation,
    scope: () => state.scope,
    suspended: () => state.suspended,
    checkpoint: (vaultId, directoryId) => state.checkpoints.get(`${vaultId}:${directoryId}`) ?? null,
  });
  return { cache, state };
}

// Library: ROOT / Notes (A) / Deep (B) / Leaf.md (F); ROOT / Draft.md (D)
const A = id(10);
const B = id(11);
const F = id(12);
const D = id(13);
const tree = () => [
  listing(ROOT, [entry(A, "directory", "Notes"), entry(D, "file", "Draft.md")]),
  listing(A, [entry(B, "directory", "Deep", 2)]),
  listing(B, [entry(F, "file", "Leaf.md")]),
];

describe("VerifiedTreeCache path snapshots", () => {
  it("rebuilds the library root and a nested path from cached parent links", () => {
    const { cache } = harness();
    expect(cache.record(verified(tree(), { [A]: key(10), [B]: key(11) }), 1)).toBe(true);

    const root = cache.pathSnapshot(null);
    expect(root?.access).toBe(access);
    expect(root?.path).toEqual([ROOT]);
    expect(Object.keys(root!.listings)).toEqual([ROOT]);
    expect(root!.keys[ROOT]).toBe(access.rootKey);

    const file = cache.pathSnapshot({ nodeId: F, kind: "file" });
    expect(file?.path).toEqual([ROOT, A, B, F]);
    expect(Object.keys(file!.listings).sort()).toEqual([ROOT, A, B].sort());
    expect(file!.keys[B]).toEqual(key(11));

    const folder = cache.pathSnapshot({ nodeId: A, kind: "directory" });
    expect(folder?.path).toEqual([ROOT, A]);
  });

  it("misses when any listing, key or kind on the path is unknown", () => {
    const { cache } = harness();
    cache.record(verified(tree().slice(0, 2), { [A]: key(10), [B]: key(11) }), 1);
    expect(cache.pathSnapshot({ nodeId: F, kind: "file" })).toBeNull(); // B's listing is missing
    expect(cache.pathSnapshot({ nodeId: B, kind: "directory" })).toBeNull();
    expect(cache.pathSnapshot({ nodeId: A, kind: "file" })).toBeNull(); // wrong kind
    expect(cache.pathSnapshot({ nodeId: id(99), kind: "file" })).toBeNull(); // unknown node

    const { cache: keyless } = harness();
    keyless.record(verified(tree(), { [A]: key(10) }), 1);
    expect(keyless.pathSnapshot({ nodeId: F, kind: "file" })).toBeNull();
  });

  it("drops a child key whose epoch no longer matches its re-verified parent entry", () => {
    const { cache } = harness();
    cache.record(verified(tree(), { [A]: key(10), [B]: key(11) }), 1);
    cache.record(verified([listing(A, [entry(B, "directory", "Deep", 3)], 3)]), 1);
    expect(cache.pathSnapshot({ nodeId: B, kind: "directory" })).toBeNull();
  });

  it("includes remembered expanded folders discoverable from included listings", () => {
    const { cache } = harness();
    cache.record(verified(tree(), { [A]: key(10), [B]: key(11) }), 1);
    const snapshot = cache.pathSnapshot(null, () => [A, B, id(77)]);
    expect(Object.keys(snapshot!.listings).sort()).toEqual([ROOT, A, B].sort());
  });

  it("serves no more remembered folders than one background revalidation checks", () => {
    const { cache } = harness();
    const folders = Array.from({ length: 30 }, (_, n) => id(100 + n));
    cache.record(
      verified(
        [
          listing(
            ROOT,
            folders.map((folder, n) => entry(folder, "directory", `F${n}`)),
          ),
          ...folders.map((f) => listing(f, [])),
        ],
        Object.fromEntries(folders.map((folder) => [folder, key(7)])),
      ),
      1,
    );
    const snapshot = cache.pathSnapshot(null, () => folders);
    // The root plus EXPANDED_CHECKED remembered folders; the rest load the cold way.
    expect(Object.keys(snapshot!.listings)).toHaveLength(1 + EXPANDED_CHECKED);
    expect(Object.keys(snapshot!.listings)).toEqual([ROOT, ...folders.slice(0, EXPANDED_CHECKED)]);
  });

  it("misses a listing behind this browser's rollback checkpoint", () => {
    const { cache, state } = harness();
    cache.record(verified(tree(), { [A]: key(10), [B]: key(11) }), 1);
    // Another tab, or a Key rotation, has verified a newer head of Notes since.
    state.checkpoints.set(`${ACCOUNT}:${A}`, { revision: 3, digest: "d3" });
    expect(cache.pathSnapshot({ nodeId: B, kind: "directory" })).toBeNull();
    expect(cache.cached(A)).toBeNull();
    expect(cache.pathSnapshot(null)).not.toBeNull();
  });

  it("misses a listing whose checkpoint is malformed, as the cold walk refuses it", () => {
    const { cache, state } = harness();
    cache.record(verified(tree()), 1);
    state.checkpoints.set(`${ACCOUNT}:${ROOT}`, "malformed");
    expect(cache.pathSnapshot(null)).toBeNull();
  });

  it("misses a listing whose same-revision checkpoint names another head", () => {
    const { cache, state } = harness();
    cache.record(verified(tree()), 1);
    state.checkpoints.set(`${ACCOUNT}:${ROOT}`, { revision: 2, digest: "forked" });
    expect(cache.pathSnapshot(null)).toBeNull();
    state.checkpoints.set(`${ACCOUNT}:${ROOT}`, { revision: 2, digest: "d2" });
    cache.record(verified(tree()), 1);
    expect(cache.pathSnapshot(null)).not.toBeNull();
  });

  it("opens a Grant root by its target id", () => {
    const { cache } = harness();
    const owner = id(40);
    const shared = id(41);
    const child = id(42);
    const grant: RootAccess = { ...access, vaultId: owner, rootId: shared, rootKey: key(41) };
    cache.record(verified([listing(shared, [entry(child, "file", "Shared.md")])], {}, grant), 1);
    expect(cache.pathSnapshot({ nodeId: child, kind: "file" })?.access).toBe(grant);
    expect(cache.pathSnapshot(null)).toBeNull(); // the library root was never recorded
  });
});

describe("VerifiedTreeCache bounds and invalidation", () => {
  it("evicts the least recently used listings beyond its bound", () => {
    const { cache } = harness(3);
    const ids = [id(20), id(21), id(22)];
    cache.record(
      verified([
        listing(
          ROOT,
          ids.map((child, n) => entry(child, "directory", `F${n}`)),
        ),
      ]),
      1,
    );
    for (const child of ids) cache.record(verified([listing(child, [])], { [child]: key(5) }), 1);
    // ROOT is the oldest of four listings in a three-listing cache.
    expect(cache.size).toBe(3);
    expect(cache.pathSnapshot(null)).toBeNull();
    expect(cache.cached(ids[0]!)).not.toBeNull();

    cache.record(
      verified([
        listing(
          ROOT,
          ids.map((child, n) => entry(child, "directory", `F${n}`)),
        ),
      ]),
      1,
    );
    cache.pathSnapshot({ nodeId: ids[1]!, kind: "directory" }); // a read refreshes recency
    cache.record(verified([listing(id(23), [])]), 1);
    expect(cache.cached(ids[0]!)).toBeNull();
    expect(cache.cached(ids[1]!)).not.toBeNull();
  });

  it("invalidates Directory ids for the cached Account only and tells subscribers of other tabs' changes", () => {
    const { cache } = harness();
    const changes: unknown[] = [];
    cache.subscribe((directoryIds) => changes.push(directoryIds));
    cache.record(verified(tree(), { [A]: key(10), [B]: key(11) }), 1);

    cache.invalidate(id(500), [A], "remote");
    expect(cache.pathSnapshot({ nodeId: B, kind: "directory" })).not.toBeNull();
    expect(changes).toEqual([]);

    cache.invalidate(ACCOUNT, [B], "local");
    expect(cache.cached(B)).toBeNull();
    expect(changes).toEqual([]); // this tab's own changes reach its page through the change itself

    cache.invalidate(ACCOUNT, [A], "remote");
    expect(cache.cached(A)).toBeNull();
    expect(cache.pathSnapshot({ nodeId: F, kind: "file" })).toBeNull();
    expect(cache.pathSnapshot(null)).not.toBeNull();
    expect(changes).toEqual([[A]]);
  });

  it("never replaces a listing with an older revision or another head at the same revision", () => {
    const { cache } = harness();
    const newer = listing(
      ROOT,
      [entry(A, "directory", "Notes"), entry(D, "file", "Draft.md"), entry(id(14), "file", "New.md")],
      3,
    );
    cache.record(verified([newer]), 1);
    // A revalidation fetched before this page's own create committed arrives late.
    cache.record(verified(tree()), 1);
    expect(cache.cached(ROOT)?.listing).toBe(newer);
    cache.record(
      { access, listings: { [ROOT]: { listing: { ...newer, entries: [] }, digest: "other" } }, keys: {} },
      1,
    );
    expect(cache.cached(ROOT)?.listing).toBe(newer);
  });

  it("forgets a root's access so the next load bootstraps it again", () => {
    const { cache } = harness();
    cache.record(verified(tree()), 1);
    cache.forgetRoot(ROOT);
    expect(cache.pathSnapshot(null)).toBeNull();
  });
});

describe("VerifiedTreeCache across a Key rotation", () => {
  // Before the rotation: Notes (A) at key epoch 1. After it: epoch 2, a new key, new revisions.
  const before = () =>
    verified([listing(ROOT, [entry(A, "directory", "Notes", 1)], 2), listing(A, [], 2, 1)], { [A]: key(10) });
  const after = () =>
    verified([listing(ROOT, [entry(A, "directory", "Notes", 2)], 3), listing(A, [], 3, 2)], { [A]: key(20) });

  it.each([
    ["the older walk records last", [after, before]],
    ["the older walk records first", [before, after]],
  ])("keeps the rotated key and listing when %s", (_label, order) => {
    const { cache } = harness();
    for (const walk of order) cache.record(walk(), 1);
    const snapshot = cache.pathSnapshot({ nodeId: A, kind: "directory" });
    expect(snapshot?.keys[A]).toEqual(key(20));
    expect(snapshot?.listings[A]?.keyEpoch).toBe(2);
    expect(snapshot?.listings[ROOT]?.entriesRevision).toBe(3);
  });

  it("never replaces root access with an older capability epoch", () => {
    const { cache } = harness();
    const rotated = { ...access, rootKey: key(30), capability: { id: ROOT, epoch: 2 } };
    cache.record(verified([listing(ROOT, [], 3, 2)], {}, rotated), 1);
    cache.record(verified([listing(ROOT, [], 2, 1)], {}, access), 1);
    expect(cache.pathSnapshot(null)?.access).toBe(rotated);
  });
});

describe("VerifiedTreeCache clearing", () => {
  it("clears on an Account or device change in device state", () => {
    const { cache, state } = harness();
    cache.record(verified(tree()), 1);
    state.scope = { ...scope, deviceId: id(4) };
    expect(cache.pathSnapshot(null)).toBeNull();
    expect(cache.size).toBe(0);

    state.scope = scope;
    cache.record(verified(tree()), 1);
    state.scope = { accountId: id(5), deviceId: scope.deviceId };
    expect(cache.pathSnapshot(null)).toBeNull();
    expect(cache.size).toBe(0);
  });

  it("refuses to refill while the tab stays hidden after its hidden-timeout clear", () => {
    const { cache, state } = harness();
    state.suspended = true;
    expect(cache.record(verified(tree()), 1)).toBe(false);
    expect(cache.size).toBe(0);
    state.suspended = false;
    expect(cache.record(verified(tree()), 1)).toBe(true);
  });

  it("refuses to record another Account's access or results from before a discard", () => {
    const { cache, state } = harness();
    expect(cache.record(verified(tree(), {}, { ...access, actorAccountId: id(6) }), 1)).toBe(false);
    state.generation = 2;
    expect(cache.record(verified(tree()), 1)).toBe(false);
    expect(cache.size).toBe(0);
  });

  it("treats a changed device-state generation as a miss and a clear", () => {
    const { cache, state } = harness();
    cache.record(verified(tree()), 1);
    state.generation = 2;
    expect(cache.pathSnapshot(null)).toBeNull();
    expect(cache.size).toBe(0);
  });

  it("clears everything on demand", () => {
    const { cache } = harness();
    cache.record(verified(tree(), { [A]: key(10) }), 1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.pathSnapshot(null)).toBeNull();
  });
});

describe("private tab memory", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears every registered holder with one call, even when one fails", () => {
    const first = vi.fn(() => {
      throw new Error("holder failed");
    });
    const second = vi.fn();
    const unregisterFirst = registerPrivateTabMemory(first);
    const unregisterSecond = registerPrivateTabMemory(second);
    clearPrivateTabMemory();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    unregisterFirst();
    unregisterSecond();
    clearPrivateTabMemory();
    expect(second).toHaveBeenCalledOnce();
  });

  function visibilityPage() {
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    const show = (visibilityState: DocumentVisibilityState) => {
      page.visibilityState = visibilityState;
      page.dispatchEvent(new Event("visibilitychange"));
    };
    return { page, show };
  }

  it("clears after the tab has been hidden for ten minutes, measured from visibilitychange", () => {
    vi.useFakeTimers();
    const { page, show } = visibilityPage();
    const clear = vi.fn();
    const returned = vi.fn();
    const watch = clearWhenHidden(page, { clear, returned });

    show("hidden");
    vi.advanceTimersByTime(9 * 60_000);
    show("visible");
    vi.advanceTimersByTime(60 * 60_000);
    expect(clear).not.toHaveBeenCalled(); // hidden for nine minutes only
    expect(returned).not.toHaveBeenCalled();

    show("hidden");
    vi.advanceTimersByTime(10 * 60_000);
    expect(clear).toHaveBeenCalledOnce();
    show("visible");
    expect(clear).toHaveBeenCalledOnce();
    expect(returned).toHaveBeenCalledOnce();
    watch.stop();
  });

  it("stays expired until the tab is visible again, so nothing refills it while hidden", () => {
    vi.useFakeTimers();
    const { page, show } = visibilityPage();
    const clear = vi.fn();
    const watch = clearWhenHidden(page, { clear, returned: () => {} });
    show("hidden");
    vi.advanceTimersByTime(10 * 60_000);
    expect(watch.expired()).toBe(true);
    vi.advanceTimersByTime(30 * 60_000);
    show("hidden"); // a repeated hidden event does not end the expiry
    expect(watch.expired()).toBe(true);
    show("visible");
    expect(watch.expired()).toBe(false);
    expect(clear).toHaveBeenCalledOnce();
  });

  it("clears on return when a throttled hidden-tab timer has not fired yet", () => {
    vi.useFakeTimers();
    const { page, show } = visibilityPage();
    const clear = vi.fn();
    const returned = vi.fn();
    clearWhenHidden(page, { clear, returned });
    show("hidden");
    // Browsers may delay timers in background tabs; only the clock moves here.
    vi.setSystemTime(Date.now() + 11 * 60_000);
    show("visible");
    expect(clear).toHaveBeenCalledOnce();
    expect(returned).toHaveBeenCalledOnce();
  });

  it("accepts exactly the tab-wide clear message", () => {
    expect(parseMemoryMessage({ type: "clear" })).toEqual({ type: "clear" });
    for (const value of [
      { type: "clear", accountId: ACCOUNT },
      { type: "invalidate", accountId: ACCOUNT, directoryIds: [A] },
      Object.assign(Object.create({ inherited: true }), { type: "clear" }),
      [{ type: "clear" }],
      "clear",
      null,
    ])
      expect(parseMemoryMessage(value)).toBeNull();
  });
});

describe("tree broadcast messages", () => {
  it("accepts exactly the id-only invalidation", () => {
    expect(parseTreeMessage({ type: "clear" })).toBeNull(); // the tab-wide clear has its own channel
    expect(parseTreeMessage({ type: "invalidate", accountId: ACCOUNT, directoryIds: [A, B] })).toEqual({
      type: "invalidate",
      accountId: ACCOUNT,
      directoryIds: [A, B],
    });
  });

  it.each([
    ["extra field on invalidate", { type: "invalidate", accountId: ACCOUNT, directoryIds: [A], names: ["Notes"] }],
    ["missing ids", { type: "invalidate", accountId: ACCOUNT }],
    ["empty ids", { type: "invalidate", accountId: ACCOUNT, directoryIds: [] }],
    ["non-id Directory", { type: "invalidate", accountId: ACCOUNT, directoryIds: ["Notes"] }],
    ["non-id Account", { type: "invalidate", accountId: "someone", directoryIds: [A] }],
    ["unknown type", { type: "snapshot", accountId: ACCOUNT }],
    ["array", [{ type: "clear" }]],
    ["string", "clear"],
    ["null", null],
    ["class instance", Object.assign(Object.create({ inherited: true }), { type: "clear" })],
    [
      "too many ids",
      { type: "invalidate", accountId: ACCOUNT, directoryIds: Array.from({ length: 257 }, (_, n) => id(n + 1000)) },
    ],
  ])("rejects %s", (_label, value) => {
    expect(parseTreeMessage(value)).toBeNull();
  });

  it("builds invalidation payloads that contain only ids", () => {
    const message = invalidateMessage(ACCOUNT, [A, A, B]);
    expect(message).toEqual({ type: "invalidate", accountId: ACCOUNT, directoryIds: [A, B] });
    expect(Object.keys(message!).sort()).toEqual(["accountId", "directoryIds", "type"]);
    // Every value other than the message type is an opaque UUIDv7: no name, key, ciphertext or snapshot fits.
    const { type, ...rest } = message!;
    expect(type).toBe("invalidate");
    for (const value of Object.values(rest).flat())
      expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Anything that is not an id is refused rather than sent.
    expect(invalidateMessage(ACCOUNT, ["Notes"])).toBeNull();
    expect(invalidateMessage("someone", [A])).toBeNull();
    expect(parseTreeMessage(structuredClone(message))).toEqual(message);
  });
});
