import { describe, expect, it } from "vitest";

import { findSharedRootByGrantId } from "../../app/tree/navigation-client";
import type { GrantRoot, SharedRootsPage } from "../../app/sharing/client";

const root = (grantId: string, targetId: string): GrantRoot => ({ grantId, ownerId: "owner-id",
  targetId, kind: "file", permission: "read_only", generation: 1, labelId: "label-id",
  labelCiphertext: "ciphertext", labelDigest: "digest", offerBytes: "offer",
  offerDigest: "offer-digest", offerSignature: "signature", signerPublicKey: "public-key",
  status: "provisioning" });

const emptyPage = (nextCursor: string | null): SharedRootsPage => ({ roots: [], nextCursor });

describe("direct Grant cursor lookup", () => {
  it("finds the exact Grant on the next 100-root page and passes the route signal", async () => {
    const wanted = root("grant-wanted", "file-wanted");
    const cursor = "018f0000-0000-7000-8000-000000000401";
    const first: SharedRootsPage = { roots: Array.from({ length: 100 }, (_, index) =>
      root(`grant-${index}`, `file-${index}`)), nextCursor: cursor };
    const calls: { signal: AbortSignal; cursor: string | null }[] = [];
    const fetchPage = async (signal: AbortSignal, pageCursor: string | null) => {
      calls.push({ signal, cursor: pageCursor });
      return pageCursor === null ? first : { roots: [wanted], nextCursor: null };
    };
    const signal = new AbortController().signal;

    await expect(findSharedRootByGrantId(wanted.grantId, wanted.targetId, signal, fetchPage)).resolves.toEqual(wanted);
    expect(calls).toEqual([{ signal, cursor: null }, { signal, cursor }]);
  });

  it("continues beyond an arbitrary page limit until the cursor ends or the Grant is found", async () => {
    const wanted = root("grant-after-many-pages", "file-wanted");
    const calls: string[] = [];
    const fetchPage = async (_signal: AbortSignal, cursor: string | null) => {
      calls.push(cursor ?? "first");
      if (calls.length === 105) return { roots: [wanted], nextCursor: null };
      return emptyPage(`cursor-${calls.length}`);
    };

    await expect(findSharedRootByGrantId(wanted.grantId, wanted.targetId, new AbortController().signal, fetchPage))
      .resolves.toEqual(wanted);
    expect(calls).toHaveLength(105);
  });

  it("reports a missing Grant only after the final cursor page", async () => {
    const calls: (string | null)[] = [];
    const fetchPage = async (_signal: AbortSignal, cursor: string | null) => {
      calls.push(cursor);
      return calls.length === 1 ? emptyPage("cursor-next") : emptyPage(null);
    };

    await expect(findSharedRootByGrantId("grant-missing", "file-missing", new AbortController().signal, fetchPage))
      .resolves.toBeUndefined();
    expect(calls).toEqual([null, "cursor-next"]);
  });

  it("fails closed on a repeated cursor instead of looping or truncating silently", async () => {
    const fetchPage = async () => emptyPage("cursor-repeated");

    await expect(findSharedRootByGrantId("grant-missing", "file-missing",
      new AbortController().signal, fetchPage)).rejects.toThrow();
  });

  it("does not accept the authorized Grant ID for a different target", async () => {
    const fetchPage = async () => ({ roots: [root("grant-wanted", "file-other")], nextCursor: null });

    await expect(findSharedRootByGrantId("grant-wanted", "file-wanted",
      new AbortController().signal, fetchPage)).rejects.toThrow();
  });

  it("honors cancellation that arrives while a root page is loading", async () => {
    const controller = new AbortController();
    const fetchPage = async () => {
      controller.abort();
      return emptyPage("cursor-next");
    };

    await expect(findSharedRootByGrantId("grant-wanted", "file-wanted", controller.signal, fetchPage))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});
