import type { Browser } from "@playwright/test";
import { test, expect } from "./fixtures";
import { completeRecoveryPresentation } from "./signup-recovery";
import { seedAccount, signInAccount } from "./support/seeded-account";

test.setTimeout(180_000);

async function candidate(browser: Browser, origin: string) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addInitScript(() => {
    if (typeof globalThis.PublicKeyCredential !== "function") {
      Object.defineProperty(globalThis, "PublicKeyCredential", {
        configurable: true,
        value: class PublicKeyCredential {},
      });
    }
  });
  await context.credentials.install();
  const page = await context.newPage();
  await page.goto(`${origin}/sign-up`, { waitUntil: "commit" });
  return { context, page };
}

for (const scenario of ["bad binding proof", "stale registry", "revoked device", "tombstoned device"] as const) {
  test(`sign-in with ${scenario} stays unprovisioned`, async ({ browser, server, baseURL }) => {
    const worker = server.getWorker<{ DB: D1Database }>();
    await worker.applyD1Migrations("DB");
    const env = await worker.getEnv();
    const seeded = await seedAccount(browser, server, baseURL!);
    const { context, page } = seeded;
    try {
      await signInAccount(seeded);
      const account = await env.DB.prepare("SELECT id FROM accounts").first<{ id: string }>();
      expect(account).not.toBeNull();
      const signedOut = await page.evaluate(async () =>
        fetch("/api/auth/sign-out", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }).then((result) => result.status),
      );
      expect(signedOut).toBe(200);
      if (scenario === "stale registry") {
        await env.DB.prepare("UPDATE account_encryption_identities SET registry_epoch=2 WHERE account_id=?")
          .bind(account!.id)
          .run();
      }
      if (scenario === "revoked device" || scenario === "tombstoned device") {
        await env.DB.prepare("UPDATE encryption_devices SET state=? WHERE account_id=?")
          .bind(scenario === "revoked device" ? "revoked" : "tombstoned", account!.id)
          .run();
      }
      await page.goto(`${new URL(baseURL!).origin}/sign-in`, { waitUntil: "commit" });
      let presented = false;
      await page.route("**/api/auth/sign-in/verify", async (route) => {
        const body = route.request().postDataJSON() as { deviceProof?: { signature: string }; [key: string]: unknown };
        expect(body.deviceProof).toBeDefined();
        presented = true;
        if (scenario === "bad binding proof") body.deviceProof!.signature = "A".repeat(86);
        await route.continue({ postData: JSON.stringify(body) });
      });
      await page.getByRole("button", { name: "Sign in with a passkey" }).click();
      if (scenario === "stale registry") {
        await expect(page.getByText("Device registry changed", { exact: false })).toBeVisible();
      } else {
        // An unbound Session opens the library, which hands this browser over to device access.
        await expect(page).toHaveURL(/\/account\/device-access$/);
      }
      expect(presented).toBe(true);
      expect(
        await env.DB.prepare("SELECT count(*) AS n FROM sessions WHERE account_id=? AND device_id IS NULL")
          .bind(account!.id)
          .first(),
      ).toEqual({ n: 1 });
      expect(
        await env.DB.prepare("SELECT registry_epoch FROM account_encryption_identities WHERE account_id=?")
          .bind(account!.id)
          .first(),
      ).toEqual({ registry_epoch: scenario === "bad binding proof" ? 1 : 2 });
      const read = await page.evaluate(async () => (await fetch("/api/private/bootstrap", { method: "POST" })).status);
      expect(read).toBe(403);
      if (scenario === "stale registry") {
        await page.getByRole("button", { name: "Sign in with a passkey" }).click();
        // The refreshed device binds this Session, so the second sign-in opens the library.
        await expect(page).toHaveURL(/\/files$/);
        await page.goto(`${new URL(baseURL!).origin}/account/device-access`, { waitUntil: "commit" });
        await expect(page.getByRole("heading", { name: "Private access ready" })).toBeVisible();
        expect(
          await env.DB.prepare(
            "SELECT count(*) AS n FROM sessions WHERE account_id=? AND device_id IS NOT NULL AND revoked_at IS NULL",
          )
            .bind(account!.id)
            .first(),
        ).toEqual({ n: 1 });
        expect(
          await env.DB.prepare("SELECT registry_epoch FROM account_encryption_identities WHERE account_id=?")
            .bind(account!.id)
            .first(),
        ).toEqual({ registry_epoch: 2 });
      }
    } finally {
      await context.close();
    }
  });
}

test("losing a persisted private key before passkey registration never activates a device", async ({
  browser,
  server,
  baseURL,
}) => {
  const worker = server.getWorker<{ DB: D1Database }>();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();
  const { context, page } = await candidate(browser, new URL(baseURL!).origin);
  try {
    await page.route("**/api/signup/options", async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await page.evaluate(async () => {
        const opening = indexedDB.open("mdwn-device-store");
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          opening.onsuccess = () => resolve(opening.result);
          opening.onerror = () => reject(opening.error);
        });
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("devices", "readwrite");
          const request = tx.objectStore("devices").getAll();
          request.onsuccess = () => {
            for (const record of request.result) {
              record.assertionKeyPair.privateKey = undefined;
              tx.objectStore("devices").put(record);
            }
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      });
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await completeRecoveryPresentation(page);
    await expect(page.getByRole("alert")).toContainText("could not create your account", { timeout: 120_000 });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM accounts").first()).toEqual({ n: 0 });
  } finally {
    await context.close();
  }
});
