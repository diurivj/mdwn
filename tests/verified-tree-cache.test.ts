import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearPrivateTabMemory,
  clearWhenHidden,
  registerPrivateTabMemory,
} from "../app/shared/device/private-tab-memory";
import type { DirectoryListing, RootAccess, TreeEntry } from "../app/shared/tree/client";
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
function listing(directoryId: string, entries: TreeEntry[], entriesRevision = 2): DirectoryListing {
  return { directoryId, entriesRevision, entries, canCreate: true };
}
function verified(listings: DirectoryListing[], keys: Record<string, Uint8Array> = {}, root = access) {
  return {
    access: root,
    listings: Object.fromEntries(
      listings.map((item) => [item.directoryId, { listing: item, digest: `d${item.entriesRevision}` }]),
    ),
    keys,
  };
}

/** A cache whose device state is controlled by the test, as private-client's would be. */
function harness(limit?: number) {
  const state = { generation: 1, scope: scope as TreeCacheScope | null };
  const cache = new VerifiedTreeCache({ limit, generation: () => state.generation, scope: () => state.scope });
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

  it("invalidates Directory ids for the cached Account only and notifies subscribers", () => {
    const { cache } = harness();
    const changes: unknown[] = [];
    cache.subscribe((change) => changes.push(change));
    cache.record(verified(tree(), { [A]: key(10), [B]: key(11) }), 1);

    cache.invalidate(id(500), [A], "remote");
    expect(cache.pathSnapshot({ nodeId: B, kind: "directory" })).not.toBeNull();
    expect(changes).toEqual([]);

    cache.invalidate(ACCOUNT, [A], "remote");
    expect(cache.cached(A)).toBeNull();
    expect(cache.pathSnapshot({ nodeId: F, kind: "file" })).toBeNull();
    expect(cache.pathSnapshot(null)).not.toBeNull();
    expect(changes).toEqual([{ type: "invalidate", directoryIds: [A], origin: "remote" }]);
  });

  it("forgets a root's access so the next load bootstraps it again", () => {
    const { cache } = harness();
    cache.record(verified(tree()), 1);
    cache.forgetRoot(ROOT);
    expect(cache.pathSnapshot(null)).toBeNull();
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

  it("refuses to record another Account's access or results from before a discard", () => {
    const { cache, state } = harness();
    expect(cache.record(verified(tree(), {}, { ...access, actorAccountId: id(6) }), 1)).toBe(false);
    state.generation = 2;
    expect(cache.record(verified(tree()), 1)).toBe(false);
    expect(cache.size).toBe(0);
  });

  it("treats a changed device-state generation as a miss and a clear", () => {
    const { cache, state } = harness();
    const changes: unknown[] = [];
    cache.subscribe((change) => changes.push(change));
    cache.record(verified(tree()), 1);
    state.generation = 2;
    expect(cache.pathSnapshot(null)).toBeNull();
    expect(cache.size).toBe(0);
    expect(changes).toEqual([{ type: "clear" }]);
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

  it("clears after the tab has been hidden for ten minutes, measured from visibilitychange", () => {
    vi.useFakeTimers();
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    const clear = vi.fn();
    const stop = clearWhenHidden(page, clear);
    const show = (visibilityState: DocumentVisibilityState) => {
      page.visibilityState = visibilityState;
      page.dispatchEvent(new Event("visibilitychange"));
    };

    show("hidden");
    vi.advanceTimersByTime(9 * 60_000);
    show("visible");
    vi.advanceTimersByTime(60 * 60_000);
    expect(clear).not.toHaveBeenCalled(); // hidden for nine minutes only

    show("hidden");
    vi.advanceTimersByTime(10 * 60_000);
    expect(clear).toHaveBeenCalledOnce();
    show("visible");
    expect(clear).toHaveBeenCalledOnce();
    stop();
  });

  it("clears on return when a throttled hidden-tab timer has not fired yet", () => {
    vi.useFakeTimers();
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    const clear = vi.fn();
    clearWhenHidden(page, clear);
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    // Browsers may delay timers in background tabs; only the clock moves here.
    vi.setSystemTime(Date.now() + 11 * 60_000);
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(clear).toHaveBeenCalledOnce();
  });
});

describe("tree broadcast messages", () => {
  it("accepts exactly the two id-only message shapes", () => {
    expect(parseTreeMessage({ type: "clear" })).toEqual({ type: "clear" });
    expect(parseTreeMessage({ type: "invalidate", accountId: ACCOUNT, directoryIds: [A, B] })).toEqual({
      type: "invalidate",
      accountId: ACCOUNT,
      directoryIds: [A, B],
    });
  });

  it.each([
    ["extra field on clear", { type: "clear", accountId: ACCOUNT }],
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
