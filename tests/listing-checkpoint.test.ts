import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { headBehind, listingCheckpoint, rememberListing } from "../app/shared/tree/listing";

const KEY = "mdwn:files-listing:vault:dir";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("one rollback checkpoint rule", () => {
  it("orders heads: an older revision, or another digest at the same revision, is behind", () => {
    const held = { revision: 3, digest: "a" };
    expect(headBehind(held, { revision: 2, digest: "a" })).toBe(true);
    expect(headBehind(held, { revision: 3, digest: "b" })).toBe(true);
    expect(headBehind(held, { revision: 3, digest: "a" })).toBe(false);
    expect(headBehind(held, { revision: 4, digest: "z" })).toBe(false);
  });

  it("reads what rememberListing keeps", () => {
    expect(listingCheckpoint("vault", "dir")).toBeNull();
    rememberListing("vault", "dir", 2, "d2");
    expect(listingCheckpoint("vault", "dir")).toEqual({ revision: 2, digest: "d2" });
    expect(() => rememberListing("vault", "dir", 1, "d1")).toThrow("replayed-manifest");
    expect(() => rememberListing("vault", "dir", 2, "other")).toThrow("replayed-manifest");
  });

  it.each([["not json"], ["[3]"], ['[3,"d",1]'], ['["3","d"]'], ['{"revision":3}']])(
    "refuses a malformed checkpoint %s everywhere",
    (stored) => {
      localStorage.setItem(KEY, stored);
      // Memory treats it as a miss; the cold walk refuses the listing.
      expect(listingCheckpoint("vault", "dir")).toBe("malformed");
      expect(() => rememberListing("vault", "dir", 9, "d9")).toThrow("replayed-manifest");
    },
  );
});
