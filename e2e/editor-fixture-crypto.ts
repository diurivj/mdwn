import type { Page } from "@playwright/test";

/** Sign protocol bytes with the real, non-extractable Encryption device key in the test browser. */
export async function signDeviceBytes(page: Page, accountId: string, message: Uint8Array): Promise<Uint8Array> {
  const signature = await page.evaluate(async ({ accountId, message }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("mdwn-device-store", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const device = await new Promise<{ assertionKeyPair: CryptoKeyPair }>((resolve, reject) => {
        const request = db.transaction("devices", "readonly").objectStore("devices").get(accountId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (!device) throw new Error("missing device signing key");
      return Array.from(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" },
        device.assertionKeyPair.privateKey, new Uint8Array(message))));
    } finally { db.close(); }
  }, { accountId, message: Array.from(message) });
  return new Uint8Array(signature);
}
