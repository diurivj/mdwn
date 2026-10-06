import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect } from "./fixtures";
import { CROSS_ENGINE_ROUTE, CROSS_ENGINE_VECTOR } from "../tests/support/cross-engine-vector";

async function gotoApp(page: import("@playwright/test").Page, url = "/") {
  // React Router streams the document. WebKit can keep the load event open
  // while the stream is live, so commit is the portable navigation boundary;
  // locator/evaluate calls below still wait for the document to be usable.
  return page.goto(url, { waitUntil: "commit" });
}

async function runAesGcmVector(page: import("@playwright/test").Page) {
  return page.evaluate(async (vector) => {
    if (!window.isSecureContext) {
      throw new Error("WebCrypto test is not running in a secure context");
    }

    const key = await crypto.subtle.importKey("raw", new Uint8Array(vector.key), { name: "AES-GCM" }, false, [
      "encrypt",
    ]);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: new Uint8Array(vector.iv) },
      key,
      new TextEncoder().encode(vector.plaintext),
    );

    return {
      secureContext: window.isSecureContext,
      ciphertext: Array.from(new Uint8Array(ciphertext), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    };
  }, CROSS_ENGINE_VECTOR);
}

async function putDeviceRecord(
  page: import("@playwright/test").Page,
  record: { id: string; accountId: string; deviceId: string },
) {
  await page.evaluate(async (value) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("mdwn-cross-engine-harness", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("devices", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("devices", "readwrite");
      transaction.objectStore("devices").put(value);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, record);
}

async function readDeviceRecord(page: import("@playwright/test").Page, id: string) {
  return page.evaluate(async (deviceId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("mdwn-cross-engine-harness", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const record = await new Promise<unknown>((resolve, reject) => {
      const transaction = db.transaction("devices", "readonly");
      const request = transaction.objectStore("devices").get(deviceId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return record;
  }, id);
}

test.describe("cross-engine application contract", () => {
  test("serves the app route and runs the shared WebCrypto vector", async ({ page }) => {
    const response = await gotoApp(page);

    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(CROSS_ENGINE_ROUTE.title);
    await expect(page.getByRole("heading", { name: CROSS_ENGINE_ROUTE.heading })).toBeVisible();

    expect(await runAesGcmVector(page)).toEqual({
      secureContext: true,
      ciphertext: CROSS_ENGINE_VECTOR.ciphertext,
    });
  });

  test("persists a non-extractable CryptoKey through a full browser restart", async ({
    playwright,
    browserName,
    baseURL,
  }) => {
    const browserType = playwright[browserName];
    const userDataDir = await mkdtemp(join(tmpdir(), "mdwn-e2e-profile-"));

    try {
      const firstBrowser = await browserType.launchPersistentContext(userDataDir, {
        headless: true,
        ignoreHTTPSErrors: true,
      });
      const firstPage = await firstBrowser.newPage();

      try {
        await gotoApp(firstPage, baseURL!);
        const secureContext = await firstPage.evaluate(() => window.isSecureContext);
        expect(secureContext).toBe(true);

        await firstPage.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("mdwn-cross-engine-harness", 1);
            request.onupgradeneeded = () => {
              request.result.createObjectStore("devices", { keyPath: "id" });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);

          await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction("devices", "readwrite");
            transaction.objectStore("devices").put({ id: "persisted-key", key });
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
          });
          db.close();
        });
      } finally {
        await firstBrowser.close();
      }

      const restartedBrowser = await browserType.launchPersistentContext(userDataDir, {
        headless: true,
        ignoreHTTPSErrors: true,
      });
      const restartedPage = await restartedBrowser.newPage();
      try {
        await gotoApp(restartedPage, baseURL!);
        const restored = await restartedPage.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("mdwn-cross-engine-harness", 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const key = await new Promise<CryptoKey>((resolve, reject) => {
            const transaction = db.transaction("devices", "readonly");
            const request = transaction.objectStore("devices").get("persisted-key");
            request.onsuccess = () => resolve(request.result?.key);
            request.onerror = () => reject(request.error);
          });
          const ciphertext = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: new Uint8Array(12) },
            key,
            new TextEncoder().encode("after-restart"),
          );
          db.close();

          return {
            secureContext: window.isSecureContext,
            ciphertextLength: new Uint8Array(ciphertext).byteLength,
          };
        });

        expect(restored).toEqual({ secureContext: true, ciphertextLength: 29 });
      } finally {
        await restartedBrowser.close();
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("supports two independent device contexts for the same Account", async ({
    playwright,
    browserName,
    baseURL,
  }) => {
    const browserType = playwright[browserName];
    const [deviceBrowserA, deviceBrowserB] = await Promise.all([browserType.launch(), browserType.launch()]);
    const deviceContextA = await deviceBrowserA.newContext({ ignoreHTTPSErrors: true });
    const deviceContextB = await deviceBrowserB.newContext({ ignoreHTTPSErrors: true });
    const [deviceA, deviceB] = await Promise.all([deviceContextA.newPage(), deviceContextB.newPage()]);

    try {
      await Promise.all([gotoApp(deviceA, baseURL!), gotoApp(deviceB, baseURL!)]);
      await Promise.all([
        putDeviceRecord(deviceA, {
          id: "account-device-a",
          accountId: "same-test-account",
          deviceId: "device-a",
        }),
        putDeviceRecord(deviceB, {
          id: "account-device-b",
          accountId: "same-test-account",
          deviceId: "device-b",
        }),
      ]);

      await expect(readDeviceRecord(deviceA, "account-device-a")).resolves.toEqual({
        id: "account-device-a",
        accountId: "same-test-account",
        deviceId: "device-a",
      });
      await expect(readDeviceRecord(deviceB, "account-device-b")).resolves.toEqual({
        id: "account-device-b",
        accountId: "same-test-account",
        deviceId: "device-b",
      });
      await expect(readDeviceRecord(deviceA, "account-device-b")).resolves.toBeUndefined();
      await expect(readDeviceRecord(deviceB, "account-device-a")).resolves.toBeUndefined();
    } finally {
      await Promise.all([deviceContextA.close(), deviceContextB.close()]);
      await Promise.all([deviceBrowserA.close(), deviceBrowserB.close()]);
    }
  });
});
