import { afterEach, describe, expect, it, vi } from "vitest";

import { clientAction, clientLoader } from "../../app/routes/resources/sharing";
import { stageShareInviteAction } from "../../app/sharing/client";

afterEach(() => vi.unstubAllGlobals());

function callRouteHandler(handler: (args: never) => unknown, request: Request): Promise<unknown> {
  return Reflect.apply(handler, undefined, [{ request }]) as Promise<unknown>;
}

type ResourceCall = { path: string; method: string; body: unknown; signal: AbortSignal | null };

async function stubPrivateWorker(respond: (call: ResourceCall) => unknown): Promise<ResourceCall[]> {
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
    const call = { path: url.pathname, method: init?.method ?? "GET", body, signal: init?.signal ?? null };
    calls.push(call);
    return Response.json(respond(call));
  });
  return calls;
}

const incomingCursor = "018f0000-0000-7000-8000-000000000101";
const outgoingCursor = "018f0000-0000-7000-8000-000000000201";
const grantsCursor = "018f0000-0000-7000-8000-000000000301";
const shareId = "018f0000-0000-7000-8000-000000000501";
const grantId = "018f0000-0000-7000-8000-000000000601";

describe("browser sharing resource route", () => {
  it("loads no private data for an invalid collection request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = await callRouteHandler(clientLoader, new Request(
      "https://mdwn.test/resources/sharing?collection=unknown",
    ));

    expect(result).toEqual({ state: "error", collection: "unknown" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes root and independent invitation cursors and the router signal to the client adapters", async () => {
    const calls = await stubPrivateWorker((call) => call.path.endsWith("/roots")
      ? { roots: [], nextCursor: null }
      : { incoming: [], outgoing: [], grants: [], next: {
        incomingCursor: null, outgoingCursor: null, grantsCursor: null,
      } });
    const rootsRequest = new Request(
      `https://mdwn.test/resources/sharing?collection=roots&cursor=${shareId}`,
      { signal: new AbortController().signal },
    );
    const invitationsRequest = new Request(
      `https://mdwn.test/resources/sharing?collection=invitations&incomingCursor=${incomingCursor}` +
        `&outgoingCursor=${outgoingCursor}&grantsCursor=${grantsCursor}`,
      { signal: new AbortController().signal },
    );
    const roots = await callRouteHandler(clientLoader, rootsRequest);
    const invitations = await callRouteHandler(clientLoader, invitationsRequest);

    expect(roots).toEqual({ state: "success", collection: "roots", roots: [], nextCursor: null });
    expect(invitations).toEqual({ state: "success", collection: "invitations", incoming: [], outgoing: [],
      grants: [], next: { incomingCursor: null, outgoingCursor: null, grantsCursor: null } });
    expect(calls.map(({ path, method, body }) => ({ path, method, body }))).toEqual([
      { path: "/api/private/sharing/roots", method: "POST", body: { cursor: shareId } },
      { path: "/api/private/sharing/invitations", method: "POST", body: {
        incomingCursor, outgoingCursor, grantsCursor,
      } },
    ]);
    expect(calls[0]?.signal).toBe(rootsRequest.signal);
    expect(calls[1]?.signal).toBe(invitationsRequest.signal);
  });

  it("runs a staged Share invite once through clientAction using the router request signal", async () => {
    let executions = 0;
    let actionSignal: AbortSignal | undefined;
    const operationId = stageShareInviteAction(async (signal) => {
      executions++;
      actionSignal = signal;
      return shareId;
    });
    const body = new FormData();
    body.set("intent", "invite");
    body.set("operationId", operationId);
    const request = new Request("https://mdwn.test/resources/sharing", { method: "POST", body });

    const result = await callRouteHandler(clientAction, request);
    expect(result).toEqual({ state: "success", intent: "invite", itemId: shareId, message: "Invitation sent." });
    expect(actionSignal).toBe(request.signal);
    expect(executions).toBe(1);

    const duplicate = new FormData();
    duplicate.set("intent", "invite");
    duplicate.set("operationId", operationId);
    await callRouteHandler(clientAction, new Request("https://mdwn.test/resources/sharing",
      { method: "POST", body: duplicate }));
    expect(executions).toBe(1);
  });

  it("dispatches the existing invitation and grant mutation intents", async () => {
    const calls = await stubPrivateWorker(() => ({ ok: true }));
    const actions = [
      { intent: "accept", itemId: shareId, path: `/api/private/sharing/shares/${shareId}/accept`,
        method: "POST", body: { materialRevision: 1 } },
      { intent: "decline", itemId: shareId, path: `/api/private/sharing/shares/${shareId}/decline`,
        method: "DELETE", body: undefined },
      { intent: "cancel", itemId: shareId, path: `/api/private/sharing/shares/${shareId}`,
        method: "DELETE", body: undefined },
      { intent: "leave", itemId: grantId, path: `/api/private/sharing/grants/${grantId}/leave`,
        method: "DELETE", body: undefined },
      { intent: "revoke", itemId: grantId, path: `/api/private/sharing/grants/${grantId}`,
        method: "DELETE", body: undefined },
      { intent: "change-permission", itemId: grantId, permission: "read_write",
        path: `/api/private/sharing/grants/${grantId}`, method: "PATCH", body: { permission: "read_write" } },
    ] as const;

    for (const action of actions) {
      const form = new FormData();
      form.set("intent", action.intent);
      form.set("itemId", action.itemId);
      if (action.intent === "change-permission") form.set("permission", action.permission);
      const request = new Request("https://mdwn.test/resources/sharing", { method: "POST", body: form });
      const result = await callRouteHandler(clientAction, request);
      expect(result).toMatchObject({ state: "success", intent: action.intent, itemId: action.itemId });
      expect(calls.at(-1)).toMatchObject({ path: action.path, method: action.method, body: action.body });
      expect(calls.at(-1)?.signal).toBe(request.signal);
    }
  });
});
