import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deviceStateGeneration,
  deviceStateScope,
  discardDeviceState,
  PrivateAccessError,
  PrivatePolicyError,
  privateExchange,
  privateRequest,
  PUBLIC_PARTICIPATION_SUSPENDED,
} from "../app/shared/device/private-client";
import { clearPrivateTabMemory, registerPrivateTabMemory } from "../app/shared/device/private-tab-memory";
import { verifyDeviceProof, type DeviceProof } from "../app/shared/device/proof";
import * as deviceStore from "../app/shared/device/store";
import type { StoredDevice } from "../app/shared/device/store";

const ORIGIN = "https://mdwn.test";
const STATE_PATH = "/api/device/state";
const NOW = 1_800_000_000_000;
const REUSE_MS = 10_000;
const registryState = {
  accountId: "account-1",
  deviceId: "device-1",
  registryEpoch: 1,
  sessionBinding: "session-1",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Hold each HTTP response independently, including real fetch-style cancellation.
 * Request-start barriers avoid sleeps and assumptions about WebCrypto scheduling. */
function controlledFetch() {
  const queues = new Map<
    string,
    { started: ReturnType<typeof deferred<RequestInit>>; response: ReturnType<typeof deferred<Response>> }[]
  >();
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input, ORIGIN).href;
    const pending = queues.get(url)?.shift();
    if (!pending) throw new Error(`unexpected fetch: ${url}`);
    pending.started.resolve(init);
    const signal = init.signal;
    if (signal?.aborted) throw signal.reason;
    const abort = () => pending.response.reject(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await pending.response.promise;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  });
  const queue = (path: string) => {
    const pending = { started: deferred<RequestInit>(), response: deferred<Response>() };
    const url = new URL(path, ORIGIN).href;
    const requests = queues.get(url) ?? [];
    requests.push(pending);
    queues.set(url, requests);
    return { started: pending.started.promise, response: pending.response };
  };
  return { fetchImpl, queue };
}

async function makeDevice(accountId = "account-1", deviceId = "device-1"): Promise<StoredDevice> {
  const [transportKeyPair, assertionKeyPair] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]),
  ]);
  return { accountId, deviceId, registryEpoch: 1, transportKeyPair, assertionKeyPair };
}

async function verifiedProof(
  init: RequestInit,
  device: StoredDevice,
  expected: Parameters<typeof verifyDeviceProof>[2],
): Promise<DeviceProof> {
  const encoded = new Headers(init.headers).get("X-Mdwn-Device-Proof");
  expect(encoded).not.toBeNull();
  const proof = JSON.parse(encoded!) as DeviceProof;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", device.assertionKeyPair.publicKey));
  expect(await verifyDeviceProof(proof, publicKey, { ...expected, now: Date.now() })).toBe(true);
  return proof;
}

let network: ReturnType<typeof controlledFetch>;
let device: StoredDevice;
let devices: Map<string, StoredDevice>;

beforeEach(async () => {
  // Reusable device state is module memory; each test starts without it.
  discardDeviceState();
  device = await makeDevice();
  devices = new Map([[device.accountId, device]]);
  // IndexedDB is the storage boundary; proof construction/signing remain real.
  vi.spyOn(deviceStore, "getDevice").mockImplementation(async (accountId) => devices.get(accountId) ?? null);
  vi.spyOn(deviceStore, "updateRegistryEpoch").mockImplementation(async (accountId, registryEpoch) => {
    const stored = devices.get(accountId);
    if (!stored) throw new Error("device unavailable");
    devices.set(accountId, { ...stored, registryEpoch });
  });
  network = controlledFetch();
  vi.stubGlobal("fetch", network.fetchImpl);
  vi.stubGlobal("location", new URL(ORIGIN));
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

/** Move the clock past the reuse window, so the next operation reads state again. */
function afterReuseWindow() {
  vi.mocked(Date.now).mockReturnValue(Date.now() + REUSE_MS);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("privateRequest registry-read concurrency", () => {
  it("coalesces same-signal reads but signs a fresh proof for each request, including identical reads", async () => {
    const read = network.queue(STATE_PATH);
    const controller = new AbortController();
    const operations = [
      { path: "/api/private/files?z=last&a=first", method: "GET" as const },
      { path: "/api/private/files?z=last&a=first", method: "GET" as const },
      { path: "/api/private/files", method: "POST" as const, body: '{"ciphertext":"one"}' },
      { path: "/api/private/envelope", method: "PUT" as const, body: Uint8Array.of(0, 128, 255) },
    ];
    const resources = operations.map(({ path }) => network.queue(path));
    // Identical GETs may finish signing in either order; their responses are interchangeable.
    const responses = ["read", "read", "created", "updated"].map((body) => new Response(body));
    const requests = operations.map(({ path, ...options }) =>
      privateRequest(path, { ...options, signal: controller.signal }),
    );

    expect(network.fetchImpl).toHaveBeenCalledTimes(1);
    const readInit = await read.started;
    expect(readInit).toMatchObject({ cache: "no-store" });
    expect(readInit.signal).toBe(controller.signal);
    expect(deviceStore.getDevice).not.toHaveBeenCalled();
    read.response.resolve(Response.json(registryState));
    const sent = await Promise.all(resources.map((resource) => resource.started));
    resources.forEach((resource, index) => {
      resource.response.resolve(responses[index]!);
    });
    const received = await Promise.all(requests);
    expect(await Promise.all(received.map((response) => response.text()))).toEqual([
      "read",
      "read",
      "created",
      "updated",
    ]);
    expect(network.fetchImpl).toHaveBeenCalledTimes(5);

    const proofs = await Promise.all(
      sent.map(async (init, index) => {
        const { path, ...options } = operations[index]!;
        expect(init).toMatchObject({ ...options, cache: "no-store", redirect: "error" });
        expect(init.signal).toBe(controller.signal);
        return verifiedProof(init, device, { ...registryState, ...options, url: new URL(path, ORIGIN).href });
      }),
    );
    expect(new Set(proofs.map((proof) => proof.proofId)).size).toBe(4);
    expect(proofs[0]!.path).toBe("/api/private/files?a=first&z=last");
    expect(proofs[0]!.signature).not.toBe(proofs[1]!.signature);
    expect(new Headers(sent[2]!.headers).get("Content-Type")).toBe("application/json");
    expect(new Headers(sent[3]!.headers).get("Content-Type")).toBe("application/octet-stream");
  });

  it("never borrows another active navigation's in-flight Session binding", async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstRead = network.queue(STATE_PATH);
    const secondRead = network.queue(STATE_PATH);
    const firstResource = network.queue("/api/private/first");
    const secondResource = network.queue("/api/private/second");
    const first = privateRequest("/api/private/first", { method: "GET", signal: firstController.signal });
    const second = privateRequest("/api/private/second", { method: "GET", signal: secondController.signal });

    expect(network.fetchImpl).toHaveBeenCalledTimes(2);
    expect((await firstRead.started).signal).toBe(firstController.signal);
    expect((await secondRead.started).signal).toBe(secondController.signal);
    const secondState = { ...registryState, sessionBinding: "second-navigation-session" };
    secondRead.response.resolve(Response.json(secondState));
    const secondInit = await secondResource.started;
    const secondResponse = new Response("second navigation");
    secondResource.response.resolve(secondResponse);
    expect(await second).toBe(secondResponse);
    expect(network.fetchImpl).toHaveBeenCalledTimes(3);
    expect(deviceStore.getDevice).toHaveBeenCalledTimes(1);
    await verifiedProof(secondInit, device, {
      ...secondState,
      method: "GET",
      url: `${ORIGIN}/api/private/second`,
    });

    // Both lifetimes remain active; only now does the first Session read finish.
    expect(firstController.signal.aborted).toBe(false);
    expect(secondController.signal.aborted).toBe(false);
    firstRead.response.resolve(Response.json(registryState));
    const firstInit = await firstResource.started;
    const firstResponse = new Response("first navigation");
    firstResource.response.resolve(firstResponse);
    expect(await first).toBe(firstResponse);
    expect(network.fetchImpl).toHaveBeenCalledTimes(4);
    await verifiedProof(firstInit, device, {
      ...registryState,
      method: "GET",
      url: `${ORIGIN}/api/private/first`,
    });
  });

  it("refreshes after the reuse window even while an earlier private response is pending", async () => {
    const controller = new AbortController();
    const firstRead = network.queue(STATE_PATH);
    const firstResource = network.queue("/api/private/first");
    const first = privateRequest("/api/private/first", { method: "GET", signal: controller.signal });
    expect((await firstRead.started).signal).toBe(controller.signal);
    firstRead.response.resolve(Response.json(registryState));
    const firstInit = await firstResource.started;

    const freshState = { ...registryState, registryEpoch: 2, sessionBinding: "session-2" };
    afterReuseWindow();
    const secondRead = network.queue(STATE_PATH);
    const secondResource = network.queue("/api/private/second");
    const second = privateRequest("/api/private/second", { method: "GET", signal: controller.signal });
    expect((await secondRead.started).signal).toBe(controller.signal);
    secondRead.response.resolve(Response.json(freshState));
    const secondInit = await secondResource.started;
    const response = new Response("second");
    secondResource.response.resolve(response);
    expect(await second).toBe(response);
    firstResource.response.resolve(new Response("first"));
    await first;

    expect(network.fetchImpl).toHaveBeenCalledTimes(4);
    expect(deviceStore.updateRegistryEpoch).toHaveBeenCalledWith(device.accountId, 2);
    expect(devices.get(device.accountId)!.assertionKeyPair).toBe(device.assertionKeyPair);
    await verifiedProof(firstInit, device, { ...registryState, method: "GET", url: `${ORIGIN}/api/private/first` });
    await verifiedProof(secondInit, device, { ...freshState, method: "GET", url: `${ORIGIN}/api/private/second` });
  });

  it("observes a sequential sign-out without sending a private request, then refreshes after sign-in", async () => {
    const firstRead = network.queue(STATE_PATH);
    const firstResource = network.queue("/api/private/files");
    firstRead.response.resolve(Response.json(registryState));
    firstResource.response.resolve(new Response("before sign-out"));
    await privateRequest("/api/private/files", { method: "GET" });

    afterReuseWindow();
    const signedOutRead = network.queue(STATE_PATH);
    const signedOut = privateRequest("/api/private/files", { method: "GET" });
    const denied = expect(signedOut).rejects.toMatchObject(new PrivateAccessError("signed-out"));
    signedOutRead.response.resolve(new Response(null, { status: 401 }));
    await denied;
    expect(network.fetchImpl).toHaveBeenCalledTimes(3);
    expect(deviceStore.getDevice).toHaveBeenCalledTimes(1);

    const signedInState = { ...registryState, sessionBinding: "new-session" };
    const nextRead = network.queue(STATE_PATH);
    const nextResource = network.queue("/api/private/files");
    const next = privateRequest("/api/private/files", { method: "GET" });
    nextRead.response.resolve(Response.json(signedInState));
    const init = await nextResource.started;
    const response = new Response("after sign-in");
    nextResource.response.resolve(response);
    expect(await next).toBe(response);
    expect(network.fetchImpl).toHaveBeenCalledTimes(5);
    await verifiedProof(init, device, { ...signedInState, method: "GET", url: `${ORIGIN}/api/private/files` });
  });

  // A private-response 401 is defensive (private routes answer a lost Session with a 403); see the reuse tests.
  it.each([
    { status: 401, state: "signed-out" as const },
    { status: 403, state: "denied" as const },
  ])("refreshes after private HTTP $status without automatically retrying", async ({ status, state }) => {
    const firstRead = network.queue(STATE_PATH);
    const firstResource = network.queue("/api/private/files");
    const first = privateRequest("/api/private/files", { method: "GET" });
    const rejected = expect(first).rejects.toMatchObject(new PrivateAccessError(state));
    firstRead.response.resolve(Response.json(registryState));
    await firstResource.started;
    firstResource.response.resolve(Response.json({ error: "access denied" }, { status }));
    await rejected;
    expect(network.fetchImpl).toHaveBeenCalledTimes(2);

    const freshState = { ...registryState, registryEpoch: 2, sessionBinding: "fresh-session" };
    const nextRead = network.queue(STATE_PATH);
    const nextResource = network.queue("/api/private/files");
    const next = privateRequest("/api/private/files", { method: "GET" });
    nextRead.response.resolve(Response.json(freshState));
    const init = await nextResource.started;
    const response = new Response("allowed");
    nextResource.response.resolve(response);
    expect(await next).toBe(response);
    expect(network.fetchImpl).toHaveBeenCalledTimes(4);
    await verifiedProof(init, device, { ...freshState, method: "GET", url: `${ORIGIN}/api/private/files` });
  });

  it.each([
    { name: "network rejection", failure: new TypeError("offline") },
    { name: "HTTP failure", failure: new Response(null, { status: 503 }) },
    { name: "invalid JSON", failure: new Response("not json", { status: 200 }) },
    { name: "invalid registry state", failure: Response.json({ ...registryState, sessionBinding: "" }) },
  ])("releases a shared $name so a later operation can retry", async ({ failure }) => {
    const read = network.queue(STATE_PATH);
    const first = privateRequest("/api/private/first", { method: "GET" });
    const second = privateRequest("/api/private/second", { method: "GET" });
    const rejections = Promise.all([
      expect(first).rejects.toMatchObject(new PrivateAccessError("unavailable")),
      expect(second).rejects.toMatchObject(new PrivateAccessError("unavailable")),
    ]);
    expect(network.fetchImpl).toHaveBeenCalledTimes(1);
    if (failure instanceof Error) read.response.reject(failure);
    else read.response.resolve(failure);
    await rejections;
    expect(network.fetchImpl).toHaveBeenCalledTimes(1);
    expect(deviceStore.getDevice).not.toHaveBeenCalled();

    const retryRead = network.queue(STATE_PATH);
    const retryResource = network.queue("/api/private/retry");
    const retry = privateRequest("/api/private/retry", { method: "GET" });
    retryRead.response.resolve(Response.json(registryState));
    const init = await retryResource.started;
    const response = new Response("retried");
    retryResource.response.resolve(response);
    expect(await retry).toBe(response);
    expect(network.fetchImpl).toHaveBeenCalledTimes(3);
    await verifiedProof(init, device, { ...registryState, method: "GET", url: `${ORIGIN}/api/private/retry` });
  });
});

describe("privateRequest caller cancellation", () => {
  it.each([0, 1])("cancelling lifetime %i stops only its own registry read", async (cancelled) => {
    const reads = [network.queue(STATE_PATH), network.queue(STATE_PATH)];
    const controllers = [new AbortController(), new AbortController()];
    const paths = ["/api/private/first", "/api/private/second"];
    const survivor = 1 - cancelled;
    const resource = network.queue(paths[survivor]!);
    const requests = paths.map((path, index) =>
      privateRequest(path, { method: "GET", signal: controllers[index]!.signal }),
    );
    const rejected = expect(requests[cancelled]!).rejects.toMatchObject(new PrivateAccessError("unavailable"));
    const readInits = await Promise.all(reads.map((read) => read.started));
    expect(network.fetchImpl).toHaveBeenCalledTimes(2);
    readInits.forEach((init, index) => {
      expect(init.signal).toBe(controllers[index]!.signal);
    });

    controllers[cancelled]!.abort(new DOMException("navigation cancelled", "AbortError"));
    // Cancellation settles before either held registry response, not after it.
    await rejected;
    expect(readInits[cancelled]!.signal!.aborted).toBe(true);
    expect(deviceStore.getDevice).not.toHaveBeenCalled();
    expect(readInits[survivor]!.signal!.aborted).toBe(false);
    const survivingState = { ...registryState, sessionBinding: "surviving-session" };
    reads[survivor]!.response.resolve(Response.json(survivingState));
    const init = await resource.started;
    expect(init.signal).toBe(controllers[survivor]!.signal);
    const response = new Response("survived");
    resource.response.resolve(response);
    expect(await requests[survivor]).toBe(response);
    expect(network.fetchImpl).toHaveBeenCalledTimes(3);
    expect(deviceStore.getDevice).toHaveBeenCalledTimes(1);
    await verifiedProof(init, device, {
      ...survivingState,
      method: "GET",
      url: new URL(paths[survivor]!, ORIGIN).href,
    });
  });

  it("cancels every caller sharing the same lifetime's held registry read", async () => {
    const controller = new AbortController();
    const read = network.queue(STATE_PATH);
    const requests = ["/api/private/first", "/api/private/second"].map((path) =>
      privateRequest(path, { method: "GET", signal: controller.signal }),
    );
    const rejected = Promise.all(
      requests.map((request) => expect(request).rejects.toMatchObject(new PrivateAccessError("unavailable"))),
    );
    expect((await read.started).signal).toBe(controller.signal);
    expect(network.fetchImpl).toHaveBeenCalledTimes(1);

    controller.abort();
    await rejected;
    expect(network.fetchImpl).toHaveBeenCalledTimes(1);
    expect(deviceStore.getDevice).not.toHaveBeenCalled();
  });

  it("lets navigation B use a fresh Session before cancelled navigation A's held response arrives", async () => {
    const oldController = new AbortController();
    const oldRead = network.queue(STATE_PATH);
    const old = privateRequest("/api/private/old", { method: "GET", signal: oldController.signal });
    const rejected = expect(old).rejects.toMatchObject(new PrivateAccessError("unavailable"));
    expect((await oldRead.started).signal).toBe(oldController.signal);
    oldController.abort(new DOMException("navigation replaced", "AbortError"));

    // Start B immediately, before A's rejected read has had a chance to settle.
    const nextController = new AbortController();
    const nextRead = network.queue(STATE_PATH);
    const nextResource = network.queue("/api/private/next");
    const next = privateRequest("/api/private/next", { method: "GET", signal: nextController.signal });
    expect(network.fetchImpl).toHaveBeenCalledTimes(2);
    expect((await nextRead.started).signal).toBe(nextController.signal);
    await rejected;
    expect(deviceStore.getDevice).not.toHaveBeenCalled();

    const freshState = { ...registryState, sessionBinding: "navigation-B-session" };
    nextRead.response.resolve(Response.json(freshState));
    const init = await nextResource.started;
    expect(init.signal).toBe(nextController.signal);
    const response = new Response("fresh navigation");
    nextResource.response.resolve(response);
    expect(await next).toBe(response);
    await verifiedProof(init, device, {
      ...freshState,
      method: "GET",
      url: `${ORIGIN}/api/private/next`,
    });

    // A's stale response would only arrive now; B never waited for or used it.
    oldRead.response.resolve(Response.json(registryState));
    expect(nextController.signal.aborted).toBe(false);
    expect(network.fetchImpl).toHaveBeenCalledTimes(3);
    expect(deviceStore.getDevice).toHaveBeenCalledTimes(1);
  });

  it("does no network or device-store work for an already-aborted caller and permits a later call", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      privateRequest("/api/private/files", { method: "GET", signal: controller.signal }),
    ).rejects.toMatchObject(new PrivateAccessError("unavailable"));
    expect(network.fetchImpl).not.toHaveBeenCalled();
    expect(deviceStore.getDevice).not.toHaveBeenCalled();

    const read = network.queue(STATE_PATH);
    const resource = network.queue("/api/private/files");
    read.response.resolve(Response.json(registryState));
    const response = new Response("allowed");
    resource.response.resolve(response);
    expect(await privateRequest("/api/private/files", { method: "GET" })).toBe(response);
    expect(network.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("coalesces only unscoped callers while a navigation's private fetch is cancelled independently", async () => {
    const navigationRead = network.queue(STATE_PATH);
    const unscopedRead = network.queue(STATE_PATH);
    const firstResource = network.queue("/api/private/first");
    const secondResource = network.queue("/api/private/second");
    const thirdResource = network.queue("/api/private/third");
    const controller = new AbortController();
    const first = privateRequest("/api/private/first", { method: "GET", signal: controller.signal });
    const second = privateRequest("/api/private/second", { method: "GET" });
    const third = privateRequest("/api/private/third", { method: "GET" });
    const rejected = expect(first).rejects.toMatchObject(new PrivateAccessError("unavailable"));
    expect(network.fetchImpl).toHaveBeenCalledTimes(2);
    expect((await navigationRead.started).signal).toBe(controller.signal);
    expect((await unscopedRead.started).signal).toBeUndefined();
    navigationRead.response.resolve(Response.json(registryState));
    const unscopedState = { ...registryState, sessionBinding: "unscoped-session" };
    unscopedRead.response.resolve(Response.json(unscopedState));
    const [firstInit, secondInit, thirdInit] = await Promise.all([
      firstResource.started,
      secondResource.started,
      thirdResource.started,
    ]);
    expect(firstInit.signal).toBe(controller.signal);
    expect(secondInit.signal).toBeUndefined();
    expect(thirdInit.signal).toBeUndefined();
    controller.abort();
    await rejected;

    const secondResponse = new Response("second survived");
    const thirdResponse = new Response("third survived");
    secondResource.response.resolve(secondResponse);
    thirdResource.response.resolve(thirdResponse);
    expect(await second).toBe(secondResponse);
    expect(await third).toBe(thirdResponse);
    expect(network.fetchImpl).toHaveBeenCalledTimes(5);
    await verifiedProof(firstInit, device, { ...registryState, method: "GET", url: `${ORIGIN}/api/private/first` });
    await verifiedProof(secondInit, device, { ...unscopedState, method: "GET", url: `${ORIGIN}/api/private/second` });
    await verifiedProof(thirdInit, device, { ...unscopedState, method: "GET", url: `${ORIGIN}/api/private/third` });
  });
});

describe("privateExchange proof-bound identity", () => {
  it("returns the exact refreshed device and Account used to sign, not a later store or Session selection", async () => {
    const firstState = { ...registryState, registryEpoch: 2 };
    const firstRead = network.queue(STATE_PATH);
    const firstResource = network.queue("/api/private/first");
    const first = privateExchange("/api/private/first", { method: "GET" });
    firstRead.response.resolve(Response.json(firstState));
    const firstInit = await firstResource.started;
    const signingDevice = devices.get(device.accountId)!;
    expect(signingDevice.registryEpoch).toBe(2);
    expect(signingDevice).not.toBe(device);
    expect(signingDevice.assertionKeyPair).toBe(device.assertionKeyPair);
    expect(signingDevice.transportKeyPair).toBe(device.transportKeyPair);

    // Change both storage and the active Account while the first response is held.
    devices.set(device.accountId, { ...signingDevice, registryEpoch: 3 });
    const otherDevice = await makeDevice("account-2", "device-2");
    devices.set(otherDevice.accountId, otherDevice);
    const otherState = {
      accountId: otherDevice.accountId,
      deviceId: otherDevice.deviceId,
      registryEpoch: otherDevice.registryEpoch,
      sessionBinding: "other-session",
    };
    const otherRead = network.queue(STATE_PATH);
    const otherResource = network.queue("/api/private/other");
    const other = privateExchange("/api/private/other", { method: "GET" });
    otherRead.response.resolve(Response.json(otherState));
    const otherInit = await otherResource.started;
    const otherResponse = new Response("other Account");
    otherResource.response.resolve(otherResponse);
    const otherExchange = await other;
    expect(otherExchange.response).toBe(otherResponse);
    expect(otherExchange.accountId).toBe("account-2");
    expect(otherExchange.device).toBe(otherDevice);

    const firstResponse = new Response("first Account");
    firstResource.response.resolve(firstResponse);
    const firstExchange = await first;
    expect(firstExchange.response).toBe(firstResponse);
    expect(firstExchange.accountId).toBe("account-1");
    expect(firstExchange.device).toBe(signingDevice);
    expect(network.fetchImpl).toHaveBeenCalledTimes(4);
    await verifiedProof(firstInit, firstExchange.device, {
      ...firstState,
      method: "GET",
      url: `${ORIGIN}/api/private/first`,
    });
    await verifiedProof(otherInit, otherExchange.device, {
      ...otherState,
      method: "GET",
      url: `${ORIGIN}/api/private/other`,
    });
  });
});

/** The verification-time proof denial, the only 403 body ever retried. */
const PROOF_REQUIRED = JSON.stringify({ error: "device_proof_required" });

/** A private response carrying the Worker's next device state. */
function withState(state: unknown, init: ResponseInit & { body?: string } = {}) {
  const { body = "ok", ...rest } = init;
  return new Response(body, {
    ...rest,
    headers: { "X-Mdwn-Device-State": typeof state === "string" ? state : JSON.stringify(state) },
  });
}

/** Settle one private request whose state is read first; returns its proof's request init. */
async function settleWithRead(path: string, state: object, response: Response = new Response("ok")) {
  const read = network.queue(STATE_PATH);
  const resource = network.queue(path);
  read.response.resolve(Response.json(state));
  resource.response.resolve(response);
  await privateRequest(path, { method: "GET" });
  return resource.started;
}

/** Settle one private request expected to need no state read. */
async function settleReused(
  path: string,
  response: Response = new Response("ok"),
  options = { method: "GET" as const },
) {
  const resource = network.queue(path);
  resource.response.resolve(response);
  const result = await privateRequest(path, options);
  return { init: await resource.started, result };
}

describe("privateRequest device-state reuse (ticket 57)", () => {
  it("signs sequential operations inside the reuse window with one state read", async () => {
    await settleWithRead("/api/private/first", registryState);
    vi.mocked(Date.now).mockReturnValue(NOW + REUSE_MS - 1);
    const { init } = await settleReused("/api/private/second");
    expect(network.fetchImpl).toHaveBeenCalledTimes(3);
    expect(network.fetchImpl.mock.calls.filter(([url]) => String(url).includes(STATE_PATH))).toHaveLength(1);
    await verifiedProof(init, device, { ...registryState, method: "GET", url: `${ORIGIN}/api/private/second` });
  });

  it("reads state again for an operation that starts after the window", async () => {
    await settleWithRead("/api/private/first", registryState);
    afterReuseWindow();
    const fresh = { ...registryState, sessionBinding: "later-session" };
    const init = await settleWithRead("/api/private/second", fresh);
    expect(network.fetchImpl).toHaveBeenCalledTimes(4);
    await verifiedProof(init, device, { ...fresh, method: "GET", url: `${ORIGIN}/api/private/second` });
  });

  it("adopts a valid response header as fresh state for the next operation", async () => {
    const next = { ...registryState, registryEpoch: 2, sessionBinding: "next-session" };
    await settleWithRead("/api/private/first", registryState);
    // Inside the read's window, the response returns newer state and restarts the window.
    vi.mocked(Date.now).mockReturnValue(NOW + REUSE_MS - 1_000);
    await settleReused("/api/private/second", withState(next));
    vi.mocked(Date.now).mockReturnValue(NOW + REUSE_MS + 5_000);
    const { init } = await settleReused("/api/private/third");
    expect(network.fetchImpl).toHaveBeenCalledTimes(4);
    expect(deviceStore.updateRegistryEpoch).toHaveBeenCalledWith(device.accountId, 2);
    await verifiedProof(init, device, { ...next, method: "GET", url: `${ORIGIN}/api/private/third` });
  });

  it.each([
    { name: "malformed JSON", header: "{not json" },
    { name: "an empty Session binding", header: { ...registryState, sessionBinding: "" } },
    { name: "a missing registry epoch", header: { ...registryState, registryEpoch: null } },
    { name: "a null device", header: { ...registryState, deviceId: null, sessionBinding: "unbound" } },
  ])("ignores a header with $name", async ({ header }) => {
    await settleWithRead("/api/private/first", registryState, withState(header));
    const { init } = await settleReused("/api/private/second");
    expect(network.fetchImpl).toHaveBeenCalledTimes(3);
    await verifiedProof(init, device, { ...registryState, method: "GET", url: `${ORIGIN}/api/private/second` });
  });

  it("never signs with another Account's header and reads state again", async () => {
    const other = { ...registryState, accountId: "account-2", sessionBinding: "other-session" };
    await settleWithRead("/api/private/first", registryState, withState(other));
    const fresh = { ...registryState, sessionBinding: "re-read-session" };
    const init = await settleWithRead("/api/private/second", fresh);
    expect(network.fetchImpl).toHaveBeenCalledTimes(4);
    await verifiedProof(init, device, { ...fresh, method: "GET", url: `${ORIGIN}/api/private/second` });
  });

  it("retries a stale-state proof denial once with the denial's state and a new proof", async () => {
    await settleWithRead("/api/private/first", registryState);
    const current = { ...registryState, registryEpoch: 2, sessionBinding: "current-session" };
    const path = "/api/private/files";
    const body = '{"ciphertext":"same bytes"}';
    const denied = network.queue(path);
    const retried = network.queue(path);
    denied.response.resolve(withState(current, { status: 403, body: '{"error":"device_proof_required"}' }));
    retried.response.resolve(withState(current, { body: "committed" }));
    const response = await privateRequest(path, { method: "POST", body });
    expect(await response.text()).toBe("committed");
    expect(network.fetchImpl).toHaveBeenCalledTimes(4);
    const [first, second] = await Promise.all([denied.started, retried.started]);
    expect(second.body).toBe(body);
    const stale = await verifiedProof(first, device, {
      ...registryState,
      method: "POST",
      url: `${ORIGIN}${path}`,
      body,
    });
    const fresh = await verifiedProof(second, device, { ...current, method: "POST", url: `${ORIGIN}${path}`, body });
    expect(fresh.proofId).not.toBe(stale.proofId);
  });

  it("retries a reused-state denial without a header after a fresh read that differs", async () => {
    await settleWithRead("/api/private/first", registryState);
    const path = "/api/private/files";
    const denied = network.queue(path);
    const read = network.queue(STATE_PATH);
    const retried = network.queue(path);
    const current = { ...registryState, sessionBinding: "rebound-session" };
    denied.response.resolve(Response.json({ error: "device_proof_required" }, { status: 403 }));
    read.response.resolve(Response.json(current));
    retried.response.resolve(new Response("allowed"));
    expect(await (await privateRequest(path, { method: "GET" })).text()).toBe("allowed");
    expect(network.fetchImpl).toHaveBeenCalledTimes(5);
    await verifiedProof(await retried.started, device, { ...current, method: "GET", url: `${ORIGIN}${path}` });
  });

  it.each([
    { name: "the denial's header", header: true },
    { name: "a fresh read", header: false },
  ])("does not retry a denial when $name shows the signing state is current", async ({ header }) => {
    await settleWithRead("/api/private/first", registryState);
    const path = "/api/private/publications";
    const denied = network.queue(path);
    const read = header ? null : network.queue(STATE_PATH);
    const body = JSON.stringify({ error: "device_proof_required" });
    denied.response.resolve(
      header ? withState(registryState, { status: 403, body }) : new Response(body, { status: 403 }),
    );
    read?.response.resolve(Response.json(registryState));
    await expect(privateRequest(path, { method: "POST", body: "{}" })).rejects.toMatchObject(
      new PrivateAccessError("denied"),
    );
    expect(network.fetchImpl).toHaveBeenCalledTimes(header ? 3 : 4);
    // The confirmed state is still reusable.
    await settleReused("/api/private/after");
    expect(network.fetchImpl).toHaveBeenCalledTimes(header ? 4 : 5);
  });

  it("treats a second denial as final", async () => {
    await settleWithRead("/api/private/first", registryState);
    const path = "/api/private/files";
    const denied = network.queue(path);
    const again = network.queue(path);
    const second = { ...registryState, registryEpoch: 2 };
    const third = { ...registryState, registryEpoch: 3 };
    denied.response.resolve(withState(second, { status: 403, body: PROOF_REQUIRED }));
    again.response.resolve(withState(third, { status: 403, body: PROOF_REQUIRED }));
    await expect(privateRequest(path, { method: "GET" })).rejects.toMatchObject(new PrivateAccessError("denied"));
    expect(network.fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("never retries a named policy denial", async () => {
    await settleWithRead("/api/private/first", registryState);
    const path = "/api/private/comments";
    const denied = network.queue(path);
    denied.response.resolve(
      withState(
        { ...registryState, registryEpoch: 2 },
        { status: 403, body: JSON.stringify({ error: PUBLIC_PARTICIPATION_SUSPENDED, suspendedUntil: NOW + 1 }) },
      ),
    );
    const rejected = await privateRequest(path, { method: "POST", body: "{}" }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(PrivatePolicyError);
    expect(network.fetchImpl).toHaveBeenCalledTimes(3);
  });

  // Defensive: no private route answers 401 today (a lost Session is a 403
  // proof denial, then a 401 from the state read, tested below), but a 401
  // from any private response still signs out and discards reusable state.
  it("discards reusable state on a private-response 401", async () => {
    await settleWithRead("/api/private/first", registryState);
    const signedOut = network.queue("/api/private/second");
    signedOut.response.resolve(new Response(null, { status: 401 }));
    await expect(privateRequest("/api/private/second", { method: "GET" })).rejects.toMatchObject(
      new PrivateAccessError("signed-out"),
    );
    await settleWithRead("/api/private/third", { ...registryState, sessionBinding: "new-session" });
    expect(network.fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("signs out after another tab's sign-out: a headerless proof denial, then a 401 state read", async () => {
    await settleWithRead("/api/private/first", registryState);
    const path = "/api/private/files";
    const denied = network.queue(path);
    const read = network.queue(STATE_PATH);
    // A private route without a live Session answers a plain proof denial, with no state header.
    denied.response.resolve(new Response(PROOF_REQUIRED, { status: 403 }));
    read.response.resolve(Response.json({ error: "authentication_failed" }, { status: 401 }));
    await expect(privateRequest(path, { method: "GET" })).rejects.toMatchObject(new PrivateAccessError("signed-out"));
    expect(network.fetchImpl).toHaveBeenCalledTimes(4);
    // Reusable state was discarded: the next operation reads state first.
    const init = await settleWithRead("/api/private/after", { ...registryState, sessionBinding: "signed-in-again" });
    expect(network.fetchImpl).toHaveBeenCalledTimes(6);
    await verifiedProof(init, device, {
      ...registryState,
      sessionBinding: "signed-in-again",
      method: "GET",
      url: `${ORIGIN}/api/private/after`,
    });
  });

  it.each([
    { error: "device_proof_required", retried: true },
    { error: "device_proof_spent", retried: false },
    { error: "access denied", retried: false },
  ])("retries a 403 with a differing state header only for $error", async ({ error, retried }) => {
    await settleWithRead("/api/private/first", registryState);
    const path = "/api/private/publications/files/f/unpublish";
    const current = { ...registryState, registryEpoch: 2, sessionBinding: "current-session" };
    const denied = network.queue(path);
    const retry = network.queue(path);
    denied.response.resolve(withState(current, { status: 403, body: JSON.stringify({ error }) }));
    retry.response.resolve(withState(current, { body: "retried" }));
    const result = privateRequest(path, { method: "POST", body: "{}" });
    if (retried) expect(await (await result).text()).toBe("retried");
    else await expect(result).rejects.toMatchObject(new PrivateAccessError("denied"));
    expect(network.fetchImpl).toHaveBeenCalledTimes(retried ? 4 : 3);
    // The header is still the Session's current state, adopted either way.
    const { init } = await settleReused("/api/private/after");
    await verifiedProof(init, device, { ...current, method: "GET", url: `${ORIGIN}/api/private/after` });
  });

  it("discards reusable state on demand, for sign-in, sign-out and recovery", async () => {
    await settleWithRead("/api/private/first", registryState);
    discardDeviceState();
    const fresh = { ...registryState, sessionBinding: "signed-in-again" };
    const init = await settleWithRead("/api/private/second", fresh);
    expect(network.fetchImpl).toHaveBeenCalledTimes(4);
    await verifiedProof(init, device, { ...fresh, method: "GET", url: `${ORIGIN}/api/private/second` });
  });

  it("refreshes reused state older than the local device's registry epoch instead of failing stale", async () => {
    await settleWithRead("/api/private/first", registryState);
    devices.set(device.accountId, { ...devices.get(device.accountId)!, registryEpoch: 2 });
    const fresh = { ...registryState, registryEpoch: 2 };
    const init = await settleWithRead("/api/private/second", fresh);
    expect(network.fetchImpl).toHaveBeenCalledTimes(4);
    await verifiedProof(init, device, { ...fresh, method: "GET", url: `${ORIGIN}/api/private/second` });
  });

  it("keeps the stale error for freshly read state older than the local device", async () => {
    devices.set(device.accountId, { ...device, registryEpoch: 2 });
    const read = network.queue(STATE_PATH);
    read.response.resolve(Response.json(registryState));
    await expect(privateRequest("/api/private/files", { method: "GET" })).rejects.toMatchObject(
      new PrivateAccessError("stale"),
    );
    expect(network.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never revives state from a read that settles after a discard", async () => {
    const read = network.queue(STATE_PATH);
    const resource = network.queue("/api/private/first");
    const first = privateRequest("/api/private/first", { method: "GET" });
    await read.started;
    discardDeviceState();
    read.response.resolve(Response.json(registryState));
    resource.response.resolve(new Response("ok"));
    await first;
    await settleWithRead("/api/private/second", registryState);
    expect(network.fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe("private tab memory and device state (ticket 57)", () => {
  it("clears every registered holder when device state is discarded", async () => {
    const holder = vi.fn();
    const unregister = registerPrivateTabMemory(holder);
    try {
      await settleWithRead("/api/private/first", registryState);
      expect(deviceStateScope()).toEqual({ accountId: "account-1", deviceId: "device-1" });
      discardDeviceState();
      expect(holder).toHaveBeenCalledOnce();
      expect(deviceStateScope()).toBeNull();
    } finally {
      unregister();
    }
  });

  it("discards reusable device state when tab memory is cleared", async () => {
    await settleWithRead("/api/private/first", registryState);
    const before = deviceStateGeneration();
    clearPrivateTabMemory();
    expect(deviceStateGeneration()).toBe(before + 1);
    await settleWithRead("/api/private/second", registryState);
    expect(network.fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([
    { name: "registry epoch", next: { ...registryState, registryEpoch: 2 } },
    { name: "Session", next: { ...registryState, sessionBinding: "another-session" } },
  ])("clears tab memory when the adopted $name changes, then signs with the new state", async ({ next }) => {
    const holder = vi.fn();
    const unregister = registerPrivateTabMemory(holder);
    try {
      await settleWithRead("/api/private/first", registryState);
      await settleReused("/api/private/second", withState(registryState));
      expect(holder).not.toHaveBeenCalled();
      await settleReused("/api/private/third", withState(next));
      expect(holder).toHaveBeenCalledOnce();
      const { init } = await settleReused("/api/private/fourth");
      expect(network.fetchImpl).toHaveBeenCalledTimes(5);
      await verifiedProof(init, device, { ...next, method: "GET", url: `${ORIGIN}/api/private/fourth` });
    } finally {
      unregister();
    }
  });
});
