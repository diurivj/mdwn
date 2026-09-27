import { afterEach, describe, expect, it, vi } from "vitest";

import { sealToRecipient } from "../../app/crypto/enc-v1";
import type { StoredDevice } from "../../app/device/store";
import { clientAction, clientLoader } from "../../app/routes/resources/sharing";
import { digestBytes, hex, signOffer, type Offer } from "../../app/sharing/offer";
import type { FileProvisioningBootstrap } from "../../app/sharing/provisioning-wire";
import { stageShareInviteAction } from "../../app/sharing/client";
import { signFileHead } from "../../app/tree/file-head";
import { encodeTreeBytes } from "../../app/tree/wire";

afterEach(() => vi.unstubAllGlobals());

function callRouteHandler(handler: (args: never) => unknown, request: Request): Promise<unknown> {
  return Reflect.apply(handler, undefined, [{ request }]) as Promise<unknown>;
}

type ResourceCall = { path: string; method: string; body: unknown; signal: AbortSignal | null; headers: Headers };

const id = (value: number) => `018f0000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
const randomDigest = () => crypto.getRandomValues(new Uint8Array(32));

async function stubPrivateWorker(respond: (call: ResourceCall) => unknown,
  activeDevice?: StoredDevice): Promise<ResourceCall[]> {
  const [transportKeyPair, assertionKeyPair] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]),
  ]);
  const device = activeDevice ?? { accountId: "account-one", deviceId: "device-one", registryEpoch: 1,
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
      return Response.json({ accountId: device.accountId, deviceId: device.deviceId,
        registryEpoch: device.registryEpoch, sessionBinding: "session-binding" });
    }
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    const call = { path: url.pathname, method: init?.method ?? "GET", body,
      signal: init?.signal ?? null, headers: new Headers(init?.headers) };
    calls.push(call);
    const response = respond(call);
    return response instanceof Response ? response : Response.json(response);
  });
  return calls;
}

async function directProvisioningFixture() {
  const ownerId = id(1), ownerSignerId = id(2), accountId = id(3), deviceId = id(4);
  const grantId = id(5), fileId = id(6), contentKeyId = id(7), receivingKeyId = id(8);
  const representationId = id(9), otherAccountId = id(10), otherDeviceId = id(11), otherGrantId = id(12);
  const shareId = id(13), labelId = id(14);
  const [transportKeyPair, assertionKeyPair, ownerAssertion, otherTransport] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]),
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
  ]);
  const device: StoredDevice = { accountId, deviceId, registryEpoch: 2, transportKeyPair, assertionKeyPair };
  const localPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", transportKeyPair.publicKey));
  const ownerPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", ownerAssertion.publicKey));
  const otherPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", otherTransport.publicKey));
  const localPublicKeyDigest = await digestBytes(localPublicKey);
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const retainedCiphertext = await sealToRecipient(contentKey, transportKeyPair.publicKey, {
    purpose: "grant", vaultId: ownerId, objectId: fileId, keyId: contentKeyId,
    keyEpoch: 1, revision: 7, recipientId: deviceId,
  });
  const retainedDigest = await digestBytes(retainedCiphertext);
  const head = await signFileHead({ ownerId, vaultId: ownerId, fileId, revision: 7,
    contentKey: { id: contentKeyId, epoch: 1 },
    receivingKey: { id: receivingKeyId, epoch: 1, publicKeyDigest: randomDigest() },
    representation: { id: representationId, digest: randomDigest() },
    parentEnvelopeDigest: randomDigest(), recipientSetVersion: 2,
    recipients: [{ accountId, deviceId, registryEpoch: 1, publicKeyDigest: localPublicKeyDigest,
      grants: [{ id: grantId, generation: 1 }], envelopeDigest: retainedDigest }],
    publication: { status: "none" }, signerDeviceId: ownerSignerId }, ownerAssertion.privateKey);
  const signedOffer: Offer = { shareId, grantId, ownerId, recipientId: accountId, targetId: fileId,
    kind: "file", permission: "read_only", materialRevision: 1, targetKeyId: contentKeyId,
    targetEpoch: 1, contentRevision: 7, headDigest: hex(head.digest), labelId,
    ownerCopyDigest: hex(randomDigest()), registryEpoch: 1,
    devices: [{ accountId, deviceId, registryEpoch: 1, publicKeyDigest: hex(localPublicKeyDigest),
      contentDigest: hex(retainedDigest), labelDigest: hex(randomDigest()) }],
    candidateDigest: hex(randomDigest()), signerDeviceId: ownerSignerId };
  const offer = await signOffer(signedOffer, ownerAssertion.privateKey);
  const bootstrap: FileProvisioningBootstrap = { ownerId, fileId,
    currentHead: { bytes: encodeTreeBytes(head.bytes), digest: encodeTreeBytes(head.digest),
      signature: encodeTreeBytes(head.signature), signerDeviceId: ownerSignerId,
      signerPublicKey: encodeTreeBytes(ownerPublicKey) },
    recipients: [
      { accountId, deviceId, registryEpoch: 2, publicKey: encodeTreeBytes(localPublicKey),
        grants: [{ id: grantId, generation: 1 }] },
      { accountId: otherAccountId, deviceId: otherDeviceId, registryEpoch: 1,
        publicKey: encodeTreeBytes(otherPublicKey), grants: [{ id: otherGrantId, generation: 1 }] },
    ],
    retained: { ciphertext: encodeTreeBytes(retainedCiphertext), digest: encodeTreeBytes(retainedDigest),
      contentKeyId, contentEpoch: 1, revision: 7,
      provenance: { grantId, offerBytes: encodeTreeBytes(offer.bytes),
        offerDigest: encodeTreeBytes(offer.digest), offerSignature: encodeTreeBytes(offer.signature),
        signerDeviceId: ownerSignerId, signerPublicKey: encodeTreeBytes(ownerPublicKey) } } };
  return { bootstrap, device, fileId };
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

  it("completes signed direct File provisioning through the empty bootstrap and same-revision PATCH", async () => {
    const current = await directProvisioningFixture();
    const calls = await stubPrivateWorker((call) => {
      if (call.path.endsWith("/bootstrap")) return Response.json(current.bootstrap);
      if (call.path.endsWith("/complete")) return Response.json({ status: "ready", headDigest: "opaque" });
      throw new Error(`Unexpected private request: ${call.path}`);
    }, current.device);
    const form = new FormData();
    form.set("intent", "provision-direct-file");
    form.set("fileId", current.fileId);
    const request = new Request("https://mdwn.test/resources/sharing", { method: "POST", body: form });

    const result = await callRouteHandler(clientAction, request);

    expect(result).toEqual({ state: "ready", intent: "provision-direct-file" });
    const bootstrap = calls.find((call) => call.path.endsWith("/bootstrap"));
    const complete = calls.find((call) => call.path.endsWith("/complete"));
    expect(bootstrap).toMatchObject({ method: "POST", body: undefined, signal: request.signal });
    expect(bootstrap?.headers.get("X-Mdwn-Device-Proof")).toBeTruthy();
    expect(complete).toMatchObject({ method: "PATCH", signal: request.signal });
    expect(complete?.headers.get("X-Mdwn-Device-Proof")).toBeTruthy();
    expect(complete?.body).toMatchObject({ expectedRevision: 7, expectedRecipientSetVersion: 2 });
    expect((complete?.body as { recipientEnvelopes: unknown[] }).recipientEnvelopes).toHaveLength(2);
    expect(Object.keys(result as object).sort()).toEqual(["intent", "state"]);
  });

  for (const [status, state] of [[202, "provisioning"], [409, "stale"], [404, "error"]] as const) {
    it(`maps direct File bootstrap ${status} to a nameless safe action result`, async () => {
      const calls = await stubPrivateWorker(() => new Response("{}", { status }));
      const form = new FormData();
      form.set("intent", "provision-direct-file");
      form.set("fileId", id(20));
      const request = new Request("https://mdwn.test/resources/sharing", { method: "POST", body: form });

      const result = await callRouteHandler(clientAction, request);

      expect(result).toEqual({ state, intent: "provision-direct-file" });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ path: `/api/private/sharing/direct-files/${id(20)}/bootstrap`,
        method: "POST", body: undefined, signal: request.signal });
      expect(calls[0]?.headers.get("X-Mdwn-Device-Proof")).toBeTruthy();
      expect(JSON.stringify(result)).not.toContain(id(20));
    });
  }

  it("rejects malformed direct File provisioning form fields before any network request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const form = new FormData();
    form.set("intent", "provision-direct-file");
    form.set("fileId", "not-a-v7-id");
    form.set("name", "must not cross the resource boundary");

    const result = await callRouteHandler(clientAction, new Request(
      "https://mdwn.test/resources/sharing", { method: "POST", body: form },
    ));

    expect(result).toEqual({ state: "error", intent: "provision-direct-file" });
    expect(fetch).not.toHaveBeenCalled();
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
