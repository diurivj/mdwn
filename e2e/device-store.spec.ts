import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { build } from "vite";
import { test as appTest, expect } from "./fixtures";

type StoredDevice = {
  accountId: string;
  deviceId: string;
  registryEpoch: number;
  transportKeyPair: CryptoKeyPair;
  assertionKeyPair: CryptoKeyPair;
};

declare global {
  interface Window {
    mdwnDeviceStore: {
      createDevice(accountId: string, deviceId: string): Promise<StoredDevice>;
      getDevice(accountId: string): Promise<StoredDevice | null>;
      getAnyDevice(): Promise<StoredDevice | null>;
      saveDevice(device: StoredDevice): Promise<void>;
      updateRegistryEpoch(accountId: string, epoch: number): Promise<void>;
    };
  }
}

// Serve only in this browser test: no production test route or extra application export.
const test = appTest.extend<{}, { deviceScript: string }>({
  deviceScript: [async ({}, use) => {
    const result = await build({
      configFile: false, publicDir: false, logLevel: "error",
      build: {
        write: false, minify: false,
        lib: { entry: "app/shared/device/store.ts", name: "mdwnDeviceStore", formats: ["iife"] },
      },
    });
    for (const output of Array.isArray(result) ? result : [result]) {
      if (!("output" in output)) continue;
      const script = output.output.find((item) => item.type === "chunk");
      if (script?.type === "chunk") {
        await use(script.code);
        return;
      }
    }
    throw new Error("Missing device store bundle");
  }, { scope: "worker" }],
});

async function installStore(page: Page, script: string, url = "/") {
  await page.route("**/__test__/device-store.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: script }));
  await page.goto(url, { waitUntil: "commit" });
  await page.addScriptTag({ url: new URL("/__test__/device-store.js", page.url()).href });
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
}

async function proveKeys(page: Page, accountId: string) {
  return page.evaluate(async (id) => {
    const device = await window.mdwnDeviceStore.getDevice(id);
    if (!device) return null;
    const message = new TextEncoder().encode("device possession after reload");
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, device.assertionKeyPair.privateKey, message,
    );
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, device.assertionKeyPair.publicKey, signature, message,
    );
    const peer = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const secret = await crypto.subtle.deriveBits(
      { name: "ECDH", public: peer.publicKey }, device.transportKeyPair.privateKey, 256,
    );
    return {
      deviceId: device.deviceId, epoch: device.registryEpoch, verified,
      derivedBits: secret.byteLength * 8,
      privateKeysNonExtractable: !device.transportKeyPair.privateKey.extractable &&
        !device.assertionKeyPair.privateKey.extractable,
    };
  }, accountId);
}

const expected = {
  deviceId: "first-device", epoch: 1, verified: true,
  derivedBits: 256, privateKeysNonExtractable: true,
};

test("persists both private key handles through tab close and sign-out-equivalent reload", async ({ context, deviceScript, baseURL }) => {
  const first = await context.newPage();
  await installStore(first, deviceScript, baseURL!);
  await first.evaluate(async () => {
    const device = await window.mdwnDeviceStore.createDevice("first-account", "first-device");
    if (device.registryEpoch !== 0) throw new Error("Unexpected initial epoch");
    await window.mdwnDeviceStore.updateRegistryEpoch("first-account", 1);
  });
  await first.close();
  const second = await context.newPage();
  await installStore(second, deviceScript, baseURL!);
  expect(await proveKeys(second, "first-account")).toEqual(expected);
  // A sign-out clears session credentials, not the origin's IndexedDB keys.
  await second.reload({ waitUntil: "commit" });
  await second.addScriptTag({ url: new URL("/__test__/device-store.js", second.url()).href });
  expect(await proveKeys(second, "first-account")).toEqual(expected);
  expect(await second.evaluate(async () => (await window.mdwnDeviceStore.getAnyDevice())?.accountId))
    .toBe("first-account");
});

test("persists keys across full browser profile restart", async ({ playwright, browserName, baseURL, deviceScript }) => {
  // storageState does not include IndexedDB CryptoKey handles on all engines.
  const profile = await mkdtemp(join(tmpdir(), "mdwn-device-store-"));
  const type = playwright[browserName];
  try {
    const first = await type.launchPersistentContext(profile, { headless: true, ignoreHTTPSErrors: true });
    try {
      const page = await first.newPage();
      await installStore(page, deviceScript, baseURL!);
      await page.evaluate(async () => {
        await window.mdwnDeviceStore.createDevice("first-account", "first-device");
        await window.mdwnDeviceStore.updateRegistryEpoch("first-account", 1);
      });
    } finally {
      await first.close();
    }
    const restarted = await type.launchPersistentContext(profile, { headless: true, ignoreHTTPSErrors: true });
    try {
      const page = await restarted.newPage();
      await installStore(page, deviceScript, baseURL!);
      expect(await proveKeys(page, "first-account")).toEqual(expected);
    } finally {
      await restarted.close();
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("missing, swapped, and mismatched handles fail closed without regenerating keys", async ({ page, deviceScript }) => {
  await installStore(page, deviceScript);
  await page.evaluate(async () => {
    const store = window.mdwnDeviceStore;
    await store.createDevice("first-account", "first-device");
    await store.createDevice("other-account", "other-device");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("mdwn-device-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const mutate = async (id: string, change: (record: StoredDevice) => void) => {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("devices", "readwrite");
        const objects = tx.objectStore("devices");
        const request = objects.get(id);
        request.onsuccess = () => {
          const record = request.result as StoredDevice;
          change(record);
          objects.put(record);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    };
    const other = await store.getDevice("other-account");
    const original = await store.getDevice("first-account");
    if (!other || !original) throw new Error("Missing device");
    await store.saveDevice({ ...original, registryEpoch: 1 });
    try {
      await store.saveDevice({ ...original, transportKeyPair: other.transportKeyPair });
      throw new Error("Device keys were silently replaced");
    } catch (error) {
      if (error instanceof Error && error.message === "Device keys were silently replaced") throw error;
    }
    await mutate("first-account", (record) => {
      record.assertionKeyPair.publicKey = other.assertionKeyPair.publicKey;
    });
    if (await store.getDevice("first-account")) throw new Error("Mismatched assertion pair accepted");
    await mutate("first-account", (record) => {
      record.assertionKeyPair = other.assertionKeyPair;
      record.transportKeyPair.publicKey = other.transportKeyPair.publicKey;
    });
    if (await store.getDevice("first-account")) throw new Error("Mismatched transport pair accepted");
    await mutate("first-account", (record) => {
      record.transportKeyPair.privateKey = undefined as unknown as CryptoKey;
    });
    if (await store.getDevice("first-account")) throw new Error("Missing private key accepted");
    if (await store.getDevice("unknown-account")) throw new Error("Missing device accepted");
    if ((await store.getAnyDevice())?.accountId !== "other-account") throw new Error("Valid second device unavailable");
    try {
      await store.createDevice("first-account", "replacement-device");
      throw new Error("Unreadable record was silently replaced");
    } catch (error) {
      if (error instanceof Error && error.message === "Unreadable record was silently replaced") throw error;
    }
    try {
      await store.updateRegistryEpoch("first-account", 2);
      throw new Error("Unreadable record was updated");
    } catch (error) {
      if (error instanceof Error && error.message === "Unreadable record was updated") throw error;
    }
    db.close();
  });
});
