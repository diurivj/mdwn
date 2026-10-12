import { describe, expect, it } from "vitest";

import {
  MAX_RELATIONSHIP_PAGES,
  parseGrantsPage,
  parseShareIdentifier,
  parseSharesPage,
  readAllPages,
} from "../app/shared/sharing/relationships-client";

const me = "0190a6c4-1111-7aaa-8bbb-000000000001";
const other = "0190a6c4-1111-7aaa-8bbb-000000000002";
const id = (n: number) => `0190a6c4-2222-7aaa-8bbb-${n.toString().padStart(12, "0")}`;

const incoming = {
  shareId: id(1),
  ownerId: other,
  recipientId: me,
  targetId: id(2),
  targetKind: "file",
  permission: "read_only",
};
const outgoing = {
  shareId: id(3),
  ownerId: me,
  recipientId: other,
  recipientShareId: id(9),
  targetId: id(4),
  targetKind: "directory",
  permission: "read_write",
};
const received = {
  grantId: id(5),
  revision: 2,
  keyEpoch: 1,
  expiresAt: null,
  ownerId: other,
  recipientId: me,
  targetId: id(6),
  targetKind: "directory",
  permission: "read_write",
};
const owned = { ...received, grantId: id(7), ownerId: me, recipientId: other, recipientShareId: id(9), expiresAt: 5 };

describe("relationship list validation", () => {
  it("accepts each direction's exact row shape for the signed-in Account", () => {
    expect(parseSharesPage({ incoming: [incoming], outgoing: [outgoing], nextCursor: null }, me)).toEqual({
      incoming: [incoming],
      outgoing: [outgoing],
      nextCursor: null,
    });
    expect(parseGrantsPage({ received: [received], owned: [owned], nextCursor: id(8) }, me)).toEqual({
      received: [received],
      owned: [owned],
      nextCursor: id(8),
    });
  });

  it("rejects Owner identity on recipient rows and missing recipient identity on owned rows", () => {
    expect(() =>
      parseSharesPage({ incoming: [{ ...incoming, recipientShareId: id(9) }], outgoing: [], nextCursor: null }, me),
    ).toThrow();
    const { recipientShareId: _omitted, ...anonymous } = owned;
    expect(() => parseGrantsPage({ received: [], owned: [anonymous], nextCursor: null }, me)).toThrow();
  });

  it("rejects rows filed under the wrong direction or Account", () => {
    expect(() => parseSharesPage({ incoming: [outgoing], outgoing: [], nextCursor: null }, me)).toThrow();
    expect(() => parseGrantsPage({ received: [owned], owned: [], nextCursor: null }, me)).toThrow();
    expect(() => parseGrantsPage({ received: [received], owned: [], nextCursor: null }, other)).toThrow();
  });

  it("rejects malformed fields, extra fields and oversized pages", () => {
    for (const row of [
      { ...incoming, targetKind: "symlink" },
      { ...incoming, permission: "admin" },
      { ...incoming, shareId: "not-an-id" },
      { ...incoming, extra: true },
    ])
      expect(() => parseSharesPage({ incoming: [row], outgoing: [], nextCursor: null }, me)).toThrow();
    for (const row of [
      { ...received, revision: 0 },
      { ...received, expiresAt: "soon" },
      { ...received, keyEpoch: 1.5 },
    ])
      expect(() => parseGrantsPage({ received: [row], owned: [], nextCursor: null }, me)).toThrow();
    expect(() =>
      parseSharesPage({ incoming: Array(101).fill(incoming), outgoing: [], nextCursor: null }, me),
    ).toThrow();
    expect(() => parseSharesPage({ incoming: [], outgoing: [], nextCursor: "bad" }, me)).toThrow();
    expect(() => parseSharesPage({ incoming: [], outgoing: [], nextCursor: null, extra: 1 }, me)).toThrow();
  });

  it("accepts only the caller's opaque share identifier", () => {
    expect(parseShareIdentifier({ shareId: id(9) })).toBe(id(9));
    expect(() => parseShareIdentifier({ shareId: "" })).toThrow();
    expect(() => parseShareIdentifier({ shareId: id(9), handle: "x" })).toThrow();
  });
});

describe("relationship pagination", () => {
  it("follows cursors until the last page", async () => {
    const requested: (string | null)[] = [];
    const pages = await readAllPages(async (cursor) => {
      requested.push(cursor);
      return { nextCursor: cursor === null ? id(1) : cursor === id(1) ? id(2) : null };
    });
    expect(requested).toEqual([null, id(1), id(2)]);
    expect(pages).toHaveLength(3);
  });

  it("refuses a repeated or non-advancing cursor instead of looping", async () => {
    await expect(readAllPages(async () => ({ nextCursor: id(1) }))).rejects.toThrow();
    await expect(readAllPages(async (cursor) => ({ nextCursor: cursor === null ? id(5) : id(4) }))).rejects.toThrow();
  });

  it("stops at the total page bound", async () => {
    let count = 0;
    await expect(
      readAllPages(async () => {
        count += 1;
        return { nextCursor: id(count) };
      }),
    ).rejects.toThrow();
    expect(count).toBe(MAX_RELATIONSHIP_PAGES);
  });
});
