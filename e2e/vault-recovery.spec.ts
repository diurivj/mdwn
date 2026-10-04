import type { Browser } from "@playwright/test";

import { openRecoveryCapsule, sealVaultRecoveryEnvelope } from "../app/crypto/vault";
import { test, expect } from "./fixtures";
import { seedAccount, signInAccount } from "./support/seeded-account";

test.setTimeout(240_000);

function newObjectId(): string {
  const id = crypto.randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}

async function authenticator(browser: Browser, origin: string) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addInitScript(() => {
    if (typeof globalThis.PublicKeyCredential !== "function") {
      Object.defineProperty(globalThis, "PublicKeyCredential", {
        configurable: true, value: class PublicKeyCredential {},
      });
    }
  });
  await context.credentials.install();
  const page = await context.newPage();
  await page.goto(`${origin}/sign-up`, { waitUntil: "commit" });
  return { context, page };
}

test("a recovery code, replacement Passkey, fresh assertion and phrase restore owned Files on a new device", async ({ browser, browserName, server, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const worker = server.getWorker<{ DB: D1Database }>();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();
  const original = await seedAccount(browser, server, origin);
  let replacement: Awaited<ReturnType<typeof authenticator>> | undefined;
  try {
    const identifier = original.accountId;
    const code = original.recoveryCodes[0]!;
    const phrase = original.phrase;
    await signInAccount(original);
    const firstDevice = await env.DB.prepare("SELECT id FROM encryption_devices WHERE account_id = ?")
      .bind(identifier).first<{ id: string }>();
    expect(firstDevice?.id).toBeTruthy();
    const ownedEnvelopeCount = browserName === "chromium" ? 22 : 1;
    if (ownedEnvelopeCount > 1) {
      const row = await env.DB.prepare("SELECT generation, recovery_salt, ciphertext, verification_public_key FROM recovery_capsules WHERE account_id = ?")
        .bind(identifier).first<{ generation: number; recovery_salt: ArrayBuffer; ciphertext: ArrayBuffer; verification_public_key: ArrayBuffer }>();
      expect(row).toBeTruthy();
      const recoverySalt = new Uint8Array(row!.recovery_salt);
      const opened = await openRecoveryCapsule({ accountId: identifier, generation: row!.generation,
        recoverySalt, capsule: new Uint8Array(row!.ciphertext),
        recoveryVerificationPublicKey: new Uint8Array(row!.verification_public_key),
      }, phrase, { accountId: identifier, generation: row!.generation, recoverySalt });
      for (let index = 1; index < ownedEnvelopeCount; index++) {
        const objectId = newObjectId();
        const envelope = await sealVaultRecoveryEnvelope(opened.vaultRootKey, {
          key: crypto.getRandomValues(new Uint8Array(32)), objectId, keyId: objectId, scope: "owned",
        }, { purpose: "vault-recovery", vaultId: identifier, objectId, keyId: objectId,
          keyEpoch: 1, revision: 1 });
        await env.DB.prepare("INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'vault-recovery', ?, 'vault-root', ?, 1)")
          .bind(identifier, objectId, envelope).run();
      }
    }

    replacement = await authenticator(browser, origin);
    await replacement.page.goto(`${origin}/recover`, { waitUntil: "commit" });
    await replacement.page.getByLabel("Recovery identifier").fill(identifier);
    await replacement.page.getByLabel("Unused recovery code").fill(code);
    await replacement.page.getByRole("button", { name: "Use recovery code" }).click();
    await expect(replacement.page.getByRole("status")).toContainText("Your passkey is ready and you are signed in", { timeout: 120_000 });
    await replacement.page.goto(`${origin}/account/device-access`, { waitUntil: "commit" });
    await expect(replacement.page.getByRole("heading", { name: "Restore private access" })).toBeVisible();

    // Authentication recovery revokes the old Session. Reauthenticate the old device so
    // the Vault-recovery cutover itself proves global Session and device revocation.
    await original.page.goto(`${origin}/sign-in`, { waitUntil: "commit" });
    await original.page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect(original.page.getByText("Signed in.", { exact: false })).toBeVisible();
    expect((await original.page.evaluate(async () =>
      (await fetch("/api/device/state")).json() as Promise<{ deviceId: string | null }>)).deviceId).toBe(firstDevice!.id);

    const vaultRequests: string[] = [];
    const provisionResponses: string[] = [];
    replacement.page.on("response", (response) => {
      if (new URL(response.url()).pathname.startsWith("/api/private/recovery-provision/")) {
        provisionResponses.push(`${new URL(response.url()).pathname}:${response.status()}`);
      }
    });
    replacement.page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/files-recovery/")) {
        vaultRequests.push(request.postData() ?? "");
      }
    });
    await replacement.page.goto(`${origin}/recover-files`, { waitUntil: "commit" });
    await replacement.page.route("**/api/files-recovery/commit", (route) => route.abort("failed"));
    await replacement.page.getByLabel("Current recovery phrase").fill(phrase);
    await replacement.page.getByRole("button", { name: "Recover Files" }).click();
    await expect(replacement.page.getByRole("alert")).toContainText("could not confirm the result", { timeout: 120_000 });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE account_id = ?")
      .bind(identifier).first()).toEqual({ n: 1 });
    expect((await original.page.evaluate(async () =>
      (await fetch("/api/auth/session")).json() as Promise<{ authenticated: boolean }>)).authenticated).toBe(true);
    await replacement.page.unroute("**/api/files-recovery/commit");
    await replacement.page.reload({ waitUntil: "commit" });
    await replacement.page.route("**/api/files-recovery/commit", async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
    });
    await replacement.page.route("**/api/private/recovery-provision/step", (route) => route.abort("failed"));
    await replacement.page.getByLabel("Current recovery phrase").fill(phrase);
    await replacement.page.getByRole("button", { name: "Recover Files" }).click();
    await expect(replacement.page.getByRole("alert")).toContainText("could not confirm the result", { timeout: 120_000 });
    expect(await env.DB.prepare("SELECT state, cursor FROM crypto_jobs WHERE account_id = ?")
      .bind(identifier).first()).toEqual({ state: "pending", cursor: null });
    await replacement.page.unroute("**/api/files-recovery/commit");
    await replacement.page.unroute("**/api/private/recovery-provision/step");
    const stillAuthenticated = await replacement.page.evaluate(async () =>
      (await fetch("/api/auth/session")).json() as Promise<{ authenticated: boolean }>);
    if (!stillAuthenticated.authenticated) {
      await replacement.page.goto(`${origin}/sign-in`, { waitUntil: "commit" });
      await replacement.page.getByRole("button", { name: "Sign in with a passkey" }).click();
      await expect(replacement.page.getByText("Signed in.", { exact: false })).toBeVisible();
    }
    await replacement.page.goto(`${origin}/recover-files`, { waitUntil: "commit" });
    await expect(replacement.page.getByRole("heading", { name: "Save your new recovery phrase" })).toBeVisible({ timeout: 120_000 });
    const newPhrase = await replacement.page.locator("section[role=status] p.font-mono").textContent();
    expect(newPhrase?.trim().split(/\s+/)).toHaveLength(24);
    expect(newPhrase).not.toBe(phrase);
    expect(vaultRequests).toHaveLength(6);
    expect(vaultRequests.every((body) => !body.includes(phrase))).toBe(true);
    expect(vaultRequests.every((body) => !body.includes(newPhrase!.trim()))).toBe(true);
    await replacement.page.goto(`${origin}/account/device-access`, { waitUntil: "commit" });
    await expect(replacement.page.getByRole("heading", { name: "Private access ready" })).toBeVisible();
    await expect.poll(async () => env.DB.prepare("SELECT state, cursor FROM crypto_jobs WHERE account_id = ?")
      .bind(identifier).first(), { timeout: 120_000, message: provisionResponses.join(", ") })
      .toEqual({ state: "complete", cursor: expect.any(String) });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM key_envelopes WHERE account_id = ? AND purpose = 'owned-device'")
      .bind(identifier).first<{ n: number }>())?.n).toBe(ownedEnvelopeCount);
    expect((await original.page.evaluate(async () =>
      (await fetch("/api/auth/session")).json() as Promise<{ authenticated: boolean }>)).authenticated).toBe(false);
    const devices = await env.DB.prepare("SELECT id, state, revocation_reason FROM encryption_devices WHERE account_id = ? ORDER BY created_at")
      .bind(identifier).all<{ id: string; state: string; revocation_reason: string | null }>();
    expect(devices.results).toHaveLength(2);
    expect(devices.results.find((device) => device.id === firstDevice!.id)).toMatchObject({ state: "tombstoned", revocation_reason: "recovery" });
    expect(devices.results.filter((device) => device.state === "active")).toHaveLength(1);
    expect(await env.DB.prepare("SELECT generation FROM recovery_capsules WHERE account_id = ?")
      .bind(identifier).first()).toEqual({ generation: 2 });
    expect(await env.DB.prepare("SELECT state FROM crypto_jobs WHERE account_id = ?")
      .bind(identifier).first()).toEqual({ state: "complete" });
    const sessions = await env.DB.prepare("SELECT device_id, revoked_at FROM sessions WHERE account_id = ?")
      .bind(identifier).all<{ device_id: string | null; revoked_at: number | null }>();
    expect(sessions.results.filter((session) => session.revoked_at === null)).toEqual([
      { device_id: devices.results.find((device) => device.state === "active")!.id, revoked_at: null },
    ]);
  } finally {
    await replacement?.context.close();
    await original.context.close();
  }
});
