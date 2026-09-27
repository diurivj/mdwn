import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeRecipientAddress, invitations, mergeSharingPage, sharedRootsPage,
  type GrantRoot, type ShareItem } from "../app/sharing/client";

describe("exact Share addressing", () => {
  it("removes one leading @ and sends the reviewed canonical handle token", async () => {
    await expect(encodeRecipientAddress("@ALICE")).resolves.toEqual({
      kind: "handle",
      value: "sh1:sYgK0eW6DfzVCUcNDlphPgu7BCqXpp9jXpWA5cu2zC0",
    });
  });

  it("preserves an opaque UUIDv7 share identifier byte-for-byte", async () => {
    const shareId = "018f0000-0000-7000-8000-000000000001";
    await expect(encodeRecipientAddress(shareId)).resolves.toEqual({
      kind: "share-id",
      value: shareId,
    });
  });

  it.each([
    "",
    " ",
    "@",
    "@@alice",
    "@alice ",
    "@ alice",
    "@al\nice",
    "@álîce",
    "@Ａlice",
    "@alice@other",
    "018f0000-0000-7000-8000-00000000000 ",
    "018f0000-0000-7000-8000-00000000000é",
    "not-an-opaque-share-id",
  ])("rejects malformed address %j before it can be looked up", async (address) => {
    await expect(encodeRecipientAddress(address)).rejects.toThrow();
  });
});

type ResourceCall = { path: string; body: unknown; signal: AbortSignal | null };

async function stubPrivateWorker(
  respond: (call: ResourceCall) => unknown,
): Promise<ResourceCall[]> {
  const [transportKeyPair, assertionKeyPair] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]),
  ]);
  const device = { accountId: "account-one", deviceId: "device-one", registryEpoch: 1,
    transportKeyPair, assertionKeyPair };
  const db = {
    close() {},
    transaction() {
      return { objectStore: () => ({ get: () => {
        const request: { result?: unknown; onsuccess?: (event: Event) => void } = {};
        queueMicrotask(() => {
          request.result = device;
          request.onsuccess?.(new Event("success"));
        });
        return request;
      } }) };
    },
  };
  vi.stubGlobal("indexedDB", { open: () => {
    const request: { result?: unknown; onsuccess?: (event: Event) => void } = {};
    queueMicrotask(() => {
      request.result = db;
      request.onsuccess?.(new Event("success"));
    });
    return request;
  } });
  vi.stubGlobal("location", { origin: "https://mdwn.test" });

  const calls: ResourceCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://mdwn.test");
    if (url.pathname === "/api/device/state") {
      return Response.json({ accountId: "account-one", deviceId: "device-one", registryEpoch: 1,
        sessionBinding: "session-binding" });
    }
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    const call = { path: url.pathname, body, signal: init?.signal ?? null };
    calls.push(call);
    return Response.json(respond(call));
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const share = (id: string): ShareItem => ({ id, kind: "file", permission: "read_only", createdAt: 1 });
const grantRoot = (grantId: string, targetId: string): GrantRoot => ({ grantId, ownerId: "owner",
  targetId, kind: "directory", permission: "read_only", generation: 1, labelId: "",
  labelCiphertext: "", labelDigest: "", offerBytes: "", offerDigest: "", offerSignature: "",
  signerPublicKey: "", status: "provisioning" });

 describe("sharing pagination adapters", () => {
  it("retains all independent invitation cursors and advances each collection without dropping rows", async () => {
    const incomingCursor = "018f0000-0000-7000-8000-000000000101";
    const outgoingCursor = "018f0000-0000-7000-8000-000000000201";
    const grantsCursor = "018f0000-0000-7000-8000-000000000301";
    const calls = await stubPrivateWorker(({ body }) => {
      if (!body) return { incoming: [share("incoming-1")],
        outgoing: [{ ...share("outgoing-1"), targetId: "target-1" }],
        grants: [{ grantId: "grant-1", targetId: "target-1", permission: "read_only" }],
        next: { incomingCursor, outgoingCursor, grantsCursor } };
      if (JSON.stringify(body) === JSON.stringify({ incomingCursor })) return {
        incoming: [share("incoming-2")], outgoing: [], grants: [],
        next: { incomingCursor: null, outgoingCursor, grantsCursor },
      };
      if (JSON.stringify(body) === JSON.stringify({ outgoingCursor })) return {
        incoming: [], outgoing: [{ ...share("outgoing-2"), targetId: "target-2" }], grants: [],
        next: { incomingCursor, outgoingCursor: null, grantsCursor },
      };
      return { incoming: [], outgoing: [],
        grants: [{ grantId: "grant-2", targetId: "target-2", permission: "read_write" }],
        next: { incomingCursor, outgoingCursor, grantsCursor: null } };
    });
    const signal = new AbortController().signal;

    const first = await invitations(signal);
    expect(first.next).toEqual({ incomingCursor, outgoingCursor, grantsCursor });
    const incomingPage = await invitations(signal, { incomingCursor: first.next.incomingCursor! });
    const outgoingPage = await invitations(signal, { outgoingCursor: first.next.outgoingCursor! });
    const grantsPage = await invitations(signal, { grantsCursor: first.next.grantsCursor! });

    expect(mergeSharingPage(first.incoming, incomingPage.incoming, (item) => item.id)
      .map((item) => item.id)).toEqual(["incoming-1", "incoming-2"]);
    expect(mergeSharingPage(first.outgoing, outgoingPage.outgoing, (item) => item.id)
      .map((item) => item.id)).toEqual(["outgoing-1", "outgoing-2"]);
    expect(mergeSharingPage(first.grants, grantsPage.grants, (item) => item.grantId)
      .map((item) => item.grantId)).toEqual(["grant-1", "grant-2"]);
    expect(calls.map((call) => call.body)).toEqual([
      undefined, { incomingCursor }, { outgoingCursor }, { grantsCursor },
    ]);
    expect(calls.every((call) => call.signal === signal)).toBe(true);
  });

  it("retains and follows the shared-root cursor while merging a later page", async () => {
    const cursor = "018f0000-0000-7000-8000-000000000401";
    const calls = await stubPrivateWorker(({ body }) => body
      ? { roots: [grantRoot("grant-2", "target-2")], nextCursor: null }
      : { roots: [grantRoot("grant-1", "target-1")], nextCursor: cursor });
    const signal = new AbortController().signal;

    const first = await sharedRootsPage(signal);
    expect(first.nextCursor).toBe(cursor);
    const second = await sharedRootsPage(signal, first.nextCursor);

    expect(mergeSharingPage(first.roots, second.roots, (root) => root.grantId)
      .map((root) => root.grantId)).toEqual(["grant-1", "grant-2"]);
    expect(calls.map((call) => call.body)).toEqual([undefined, { cursor }]);
    expect(calls.every((call) => call.signal === signal)).toBe(true);
  });
});
