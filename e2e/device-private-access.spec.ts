import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { build } from "vite";
import { test as appTest, expect } from "./fixtures";

// The production browser module runs against a real IndexedDB and WebCrypto;
// only the network boundary (authenticated registry and private resource) is supplied here.
type AccessResult = { status: number; proof?: { registryEpoch: number; deviceId: string; proofId: string } };
declare global {
  interface Window {
    deviceAccess: typeof import("../app/shared/device/private-client") & typeof import("../app/shared/device/store");
  }
}

const test = appTest.extend<{}, { accessScript: string }>({
  accessScript: [async ({}, use) => {
    const result = await build({
      configFile: false, publicDir: false, logLevel: "error",
      build: { write: false, minify: false, lib: {
        entry: "e2e/support/device-access-entry.ts", name: "deviceAccess", formats: ["iife"],
      } },
    });
    const output = (Array.isArray(result) ? result : [result]).flatMap((item) => "output" in item ? item.output : []);
    const script = output.find((item) => item.type === "chunk");
    if (script?.type !== "chunk") throw new Error("Missing device access bundle");
    await use(script.code);
  }, { scope: "worker" }],
});

async function install(page: Page, script: string, baseURL: string) {
  await page.route("**/__test__/device-access.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: script }));
  await page.goto(baseURL, { waitUntil: "commit" });
  await page.addScriptTag({ url: new URL("/__test__/device-access.js", page.url()).href });
}

async function attempt(page: Page): Promise<{ state: string; status?: number }> {
  return page.evaluate(async () => {
    try {
      const response = await window.deviceAccess.privateRequest("/api/private/bootstrap?b=2&a=1", { method: "POST" });
      return { state: "ready", status: response.status };
    } catch (error) {
      return { state: error instanceof window.deviceAccess.PrivateAccessError ? error.state : "unexpected" };
    }
  });
}

const accountId = "local-account";
const deviceId = "local-device";

test("a private operation refreshes only cached authority, binds the actual request and never sends on device loss", async ({ page, baseURL, accessScript }) => {
  let boundDevice: string | null = deviceId;
  let epoch = 2;
  const seen: AccessResult[] = [];
  await page.route("**/api/device/state", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    accountId, deviceId: boundDevice, registryEpoch: epoch, sessionBinding: "session-digest",
  }) }));
  await page.route("**/api/private/bootstrap?*", async (route) => {
    const proof = JSON.parse(route.request().headers()["x-mdwn-device-proof"] ?? "null") as AccessResult["proof"];
    seen.push({ status: 200, proof });
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await install(page, accessScript, baseURL!);
  expect(await attempt(page)).toEqual({ state: "device-lost" });
  expect(seen).toHaveLength(0);
  await page.evaluate(async ({ accountId, deviceId }) => {
    await window.deviceAccess.createDevice(accountId, deviceId);
    await window.deviceAccess.updateRegistryEpoch(accountId, 1);
  }, { accountId, deviceId });
  expect(await attempt(page)).toEqual({ state: "ready", status: 200 });
  expect(await attempt(page)).toEqual({ state: "ready", status: 200 });
  expect(seen).toHaveLength(2);
  expect(seen[0]?.proof).toMatchObject({ registryEpoch: 2, deviceId });
  expect(seen[0]?.proof?.proofId).not.toBe(seen[1]?.proof?.proofId);
  const persisted = await page.evaluate(async (id) => {
    const device = await window.deviceAccess.getDevice(id);
    return device && {
      epoch: device.registryEpoch,
      assertionExtractable: device.assertionKeyPair.privateKey.extractable,
      transportExtractable: device.transportKeyPair.privateKey.extractable,
    };
  }, accountId);
  expect(persisted).toEqual({ epoch: 2, assertionExtractable: false, transportExtractable: false });
  // A bound but replaced, missing, or unprovisioned device never reaches the private resource.
  boundDevice = "different-device";
  expect(await attempt(page)).toEqual({ state: "device-lost" });
  boundDevice = null;
  expect(await attempt(page)).toEqual({ state: "unprovisioned" });
  boundDevice = deviceId;
  epoch = 1; // Never roll back cached authority after a server/DB regression.
  expect(await attempt(page)).toEqual({ state: "stale" });
  epoch = 2;
  await page.evaluate(async () => {
    const open = indexedDB.open("mdwn-device-store");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("devices", "readwrite");
      const records = tx.objectStore("devices");
      const get = records.get("local-account");
      get.onsuccess = () => {
        const record = get.result;
        record.assertionKeyPair.privateKey = undefined;
        records.put(record);
      };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  expect(await attempt(page)).toEqual({ state: "device-lost" }); // Unreadable key handle.
  expect(seen).toHaveLength(2);
  await page.goto(new URL("/account/device-access", baseURL!).href);
  await expect(page.getByRole("heading", { name: "Restore private access" })).toBeVisible();
  await expect(page.getByText("recovery phrase", { exact: false })).toBeVisible();
  expect(seen).toHaveLength(2);
});

test("a full browser restart retains proof possession at the refreshed epoch", async ({ playwright, browserName, baseURL, accessScript }) => {
  const profile = await mkdtemp(join(tmpdir(), "mdwn-device-access-"));
  const type = playwright[browserName];
  try {
    const first = await type.launchPersistentContext(profile, { headless: true, ignoreHTTPSErrors: true });
    try {
      const page = await first.newPage();
      await install(page, accessScript, baseURL!);
      await page.evaluate(async () => {
        await window.deviceAccess.createDevice("local-account", "local-device");
        await window.deviceAccess.updateRegistryEpoch("local-account", 1);
      });
    } finally { await first.close(); }

    const restarted = await type.launchPersistentContext(profile, { headless: true, ignoreHTTPSErrors: true });
    try {
      const page = await restarted.newPage();
      await page.route("**/api/device/state", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        accountId, deviceId, registryEpoch: 2, sessionBinding: "session-digest",
      }) }));
      let validProof = false;
      await page.route("**/api/private/bootstrap?*", async (route) => {
        const proof = JSON.parse(route.request().headers()["x-mdwn-device-proof"] ?? "null") as {
          sessionBinding: string; deviceId: string; registryEpoch: number; method: string;
          path: string; bodyDigest: string; issuedAt: number; expiresAt: number; proofId: string; signature: string;
        };
        validProof = await page.evaluate(async (value) => {
          const device = await window.deviceAccess.getDevice("local-account");
          if (!device) return false;
          const signed = ["mdwn/device-proof/v1", value.sessionBinding, value.deviceId, value.registryEpoch,
            value.method, value.path, value.bodyDigest, value.issuedAt, value.expiresAt, value.proofId];
          const decode = (input: string) => Uint8Array.from(atob(input.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
          return value.registryEpoch === 2 && value.path === "/api/private/bootstrap?a=1&b=2" &&
            value.bodyDigest === "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU" &&
            value.method === "POST" && value.deviceId === device.deviceId &&
            value.sessionBinding === "session-digest" &&
            crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, device.assertionKeyPair.publicKey,
              decode(value.signature), new TextEncoder().encode(JSON.stringify(signed)));
        }, proof);
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      });
      await install(page, accessScript, baseURL!);
      expect(await attempt(page)).toEqual({ state: "ready", status: 200 });
      expect(validProof).toBe(true);
      expect((await page.evaluate(async () => window.deviceAccess.getDevice("local-account")))?.registryEpoch).toBe(2);
    } finally { await restarted.close(); }
  } finally { await rm(profile, { recursive: true, force: true }); }
});
