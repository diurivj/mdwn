import { describe, expect, it } from "vitest";

import type { DirectoryListing, RootAccess, TreeEntry } from "../app/shared/tree/client";
import {
  mergeListings,
  pathCrumbs,
  pathStep,
  restorableFolders,
  rootAccepts,
  rootName,
} from "../app/shared/tree/path-rules";

const key = (n: number) => new Uint8Array(32).fill(n);
const access: RootAccess = {
  vaultId: "account",
  actorAccountId: "account",
  rootId: "root",
  rootKind: "directory",
  rootKey: key(1),
  actorVaultRootKey: key(2),
};
function entry(nodeId: string, kind: "directory" | "file", name = nodeId): TreeEntry {
  return { nodeId, kind, name, order: name, nameCiphertext: "n", orderCiphertext: "o", keyEnvelope: "k" };
}
function listing(directoryId: string, entries: TreeEntry[], entriesRevision = 2): DirectoryListing {
  return { directoryId, entriesRevision, entries, canCreate: true };
}
// root / notes / leaf.md
const listings = {
  root: listing("root", [entry("notes", "directory", "Notes"), entry("draft", "file", "Draft.md")]),
  notes: listing("notes", [entry("leaf", "file", "Leaf.md"), entry("deep", "directory", "Deep")]),
};

describe("one path acceptance rule", () => {
  it("accepts Directories before the end and the target's kind at the end", () => {
    const path = ["root", "notes", "leaf"];
    expect(pathStep(listings.root, path, 0, "file")?.name).toBe("Notes");
    expect(pathStep(listings.notes, path, 1, "file")?.name).toBe("Leaf.md");
    expect(pathStep(listings.notes, path, 1, "directory")).toBeNull();
    expect(pathStep(listings.root, ["root", "draft", "leaf"], 0, "file")).toBeNull(); // a File mid-path
    expect(pathStep(listings.root, ["root", "gone"], 0, "file")).toBeNull();
    expect(pathStep(undefined, path, 0, "file")).toBeNull();
  });

  it("builds breadcrumbs only for a path every listing accepts", () => {
    expect(pathCrumbs(access, ["root", "notes", "leaf"], listings, "file")).toEqual([
      { id: "root", name: "Library" },
      { id: "notes", name: "Notes" },
      { id: "leaf", name: "Leaf.md" },
    ]);
    expect(pathCrumbs(access, ["root"], listings, "directory")).toEqual([{ id: "root", name: "Library" }]);
    expect(pathCrumbs(access, ["root", "notes", "leaf"], listings, "directory")).toBeNull();
    expect(pathCrumbs(access, ["root", "notes", "missing"], listings, "file")).toBeNull();
  });

  it("opens a shared File root only as that single File", () => {
    const shared = { ...access, vaultId: "owner", rootKind: "file" as const, rootId: "shared" };
    expect(rootName(shared)).toBe("Shared File");
    expect(rootAccepts(shared, ["shared"], "file")).toBe(true);
    expect(rootAccepts(shared, ["shared"], "directory")).toBe(false);
    expect(rootAccepts(shared, ["shared", "other"], "file")).toBe(false);
    expect(rootAccepts(access, ["root", "notes"], "directory")).toBe(true);
  });

  it("restores remembered folders one discoverable level at a time", () => {
    const pending = new Set(["deep", "notes", "draft", "unknown"]);
    const keys = { root: key(1) };
    expect(restorableFolders(pending, { root: listings.root }, keys).map((item) => item.id)).toEqual(["notes"]);
    // A File is never restored as a folder, and an already open folder is done.
    expect(pending).toEqual(new Set(["deep", "unknown"]));
    expect(
      restorableFolders(pending, { root: listings.root, notes: listings.notes }, { ...keys, notes: key(3) }).map(
        (item) => [item.id, item.parentId],
      ),
    ).toEqual([["deep", "notes"]]);
    expect(pending).toEqual(new Set(["unknown"]));
  });
});

describe("monotonic listing merges", () => {
  it("never replaces a listing with an older revision, and takes keys only from accepted parents", () => {
    const newer = listing("root", [...listings.root.entries, entry("made", "directory", "Made")], 3);
    const merged = mergeListings(
      { listings: { root: newer }, keys: { root: key(1), made: key(9) } },
      { listings: { root: listings.root, notes: listings.notes }, keys: { root: key(1), notes: key(4), made: key(5) } },
    );
    expect(merged.listings.root).toBe(newer);
    expect(merged.listings.notes).toBe(listings.notes);
    expect(merged.keys.made).toEqual(key(9));
    expect(merged.keys.notes).toEqual(key(4));
  });

  it("takes a newer or equal revision", () => {
    const newer = listing("root", [entry("notes", "directory", "Renamed")], 3);
    const merged = mergeListings(
      { listings: { root: listings.root }, keys: {} },
      { listings: { root: newer }, keys: {} },
    );
    expect(merged.listings.root).toBe(newer);
  });
});
