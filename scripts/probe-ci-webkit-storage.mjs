#!/usr/bin/env node
import { createServer } from "node:http";
import { webkit } from "playwright";

// Reproduce the service-only failure before the full suite: WebKit must store
// nonextractable browser device keys, not export them to bypass IndexedDB.
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>Disposable CI CryptoKey storage probe</title>");
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(undefined));
});
let browser;
let deadline;
const started = Date.now();
try {
  browser = await webkit.launch({ headless: true, timeout: 15_000 });
  const page = await browser.newPage();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local probe address");
  await page.goto(`http://127.0.0.1:${address.port}/`, { timeout: 10_000 });
  const result = await Promise.race([
    page.evaluate(async () => {
      const stages = [];
      /** @type {IDBDatabase | undefined} */
      let db;
      try {
        if (!window.isSecureContext) throw new Error("Probe needs a secure context");
        const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
        stages.push("generated-nonextractable-private-key");
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open("disposable-ci-crypto-probe", 1);
          request.onupgradeneeded = () => request.result.createObjectStore("keys");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        if (!(database instanceof IDBDatabase)) throw new Error("Missing disposable probe database");
        db = database;
        stages.push("opened-indexeddb");
        await new Promise((resolve, reject) => {
          const transaction = database.transaction("keys", "readwrite");
          transaction.oncomplete = resolve;
          transaction.onabort = () => reject(transaction.error);
          transaction.onerror = () => reject(transaction.error);
          transaction.objectStore("keys").put(pair, "device");
        });
        stages.push("stored-key-pair");
        const restored = await new Promise((resolve, reject) => {
          const request = database.transaction("keys").objectStore("keys").get("device");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        if (
          !restored ||
          typeof restored !== "object" ||
          !("privateKey" in restored) ||
          !(restored.privateKey instanceof CryptoKey) ||
          restored.privateKey.extractable
        )
          throw new Error("Nonextractable CryptoKey round-trip failed");
        stages.push("restored-nonextractable-private-key");
        return { passed: true, stages };
      } catch (error) {
        const detail = error instanceof Error || error instanceof DOMException ? error : new Error(String(error));
        return { passed: false, stages, error: { name: detail.name, message: detail.message } };
      } finally {
        db?.close();
      }
    }),
    new Promise((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error("WebKit key-storage check exceeded 10 seconds")), 10_000);
    }),
  ]);
  console.log(JSON.stringify({ check: "webkit-cryptokey-storage", seconds: (Date.now() - started) / 1000, ...result }));
  if (!result.passed) process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
