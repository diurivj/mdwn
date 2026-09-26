import type { Browser } from "@playwright/test";

import { test, expect } from "./fixtures";
import { completeRecoveryPresentation } from "./signup-recovery";

test.setTimeout(180_000);

async function newAuthenticator(browser: Browser, origin: string) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  // Linux WebKit supplies a non-constructor placeholder to virtual authenticators.
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

test("a used code adds a replacement Passkey, revokes other Sessions and leaves the new browser unprovisioned", async ({ browser, server, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const worker = server.getWorker<{ DB: D1Database }>();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();
  const original = await newAuthenticator(browser, origin);
  let replacement: Awaited<ReturnType<typeof newAuthenticator>> | undefined;
  try {
    let identifier = "";
    let code = "";
    let unusedCode = "";
    await original.page.getByRole("button", { name: "Create account", exact: true }).click();
    await completeRecoveryPresentation(original.page, {
      beforeConfirm: async () => {
        const text = await original.page.getByText("Save this non-secret recovery identifier", { exact: false }).textContent();
        identifier = text?.match(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/)?.[0] ?? "";
        code = (await original.page.locator("section ol li").first().textContent())?.replace(/^\d+\.\s*/, "").trim() ?? "";
        unusedCode = (await original.page.locator("section ol li").nth(1).textContent())?.replace(/^\d+\.\s*/, "").trim() ?? "";
      },
    });
    expect(identifier).toMatch(/-7[0-9a-f]{3}-/);
    expect(code).toHaveLength(32);
    await expect(original.page.getByText("Your account is ready.", { exact: false })).toBeVisible({ timeout: 120_000 });

    replacement = await newAuthenticator(browser, origin);
    await replacement.page.goto(`${origin}/recover`, { waitUntil: "commit" });
    await replacement.page.getByLabel("Recovery identifier").fill(identifier);
    await replacement.page.getByLabel("Unused recovery code").fill(code);
    await replacement.page.getByRole("button", { name: "Use recovery code" }).click();
    await expect(replacement.page.getByRole("status")).toContainText("Your passkey is ready and you are signed in", { timeout: 120_000 });

    const originalSession = await original.page.evaluate(async () =>
      (await fetch("/api/auth/session")).json() as Promise<{ authenticated: boolean }>);
    const recoveredSession = await replacement.page.evaluate(async () =>
      (await fetch("/api/auth/session")).json() as Promise<{ authenticated: boolean }>);
    expect(originalSession).toEqual({ authenticated: false });
    expect(recoveredSession).toEqual({ authenticated: true });
    const privateState = await replacement.page.evaluate(async ({ identifier, code }) => {
      const device = await fetch("/api/device/state");
      const content = await fetch("/api/private/bootstrap", { method: "POST" });
      const reuse = await fetch("/api/auth/recovery/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, code }),
      });
      return { device: await device.json() as { deviceId: string | null }, content: content.status, reuse: reuse.status };
    }, { identifier, code });
    expect(privateState.device.deviceId).toBeNull();
    expect(privateState.content).toBe(403);
    expect(privateState.reuse).toBe(401);
    const passkeys = await env.DB.prepare("SELECT credential_id FROM passkeys WHERE account_id = ?")
      .bind(identifier).all();
    expect(passkeys.results).toHaveLength(2);
    const sessions = await env.DB.prepare("SELECT purpose, device_id, revoked_at FROM sessions WHERE account_id = ?")
      .bind(identifier).all<{ purpose: string; device_id: string | null; revoked_at: number | null }>();
    expect(sessions.results.filter((session) => session.revoked_at === null)).toEqual([
      { purpose: "normal", device_id: null, revoked_at: null },
    ]);
    const events = await env.DB.prepare("SELECT action_class, reason, created_at, expires_at FROM security_events WHERE account_id = ?")
      .bind(identifier).all<{ action_class: string; reason: string; created_at: number; expires_at: number }>();
    expect(events.results).toHaveLength(1);
    expect(events.results[0]).toMatchObject({ action_class: "recovery", reason: "allowed" });
    expect(events.results[0]!.expires_at - events.results[0]!.created_at).toBeLessThanOrEqual(30 * 24 * 60 * 60_000);

    await replacement.page.goto(`${origin}/account/security`, { waitUntil: "commit" });
    await expect(replacement.page.getByText(identifier)).toBeVisible();
    await replacement.page.getByRole("button", { name: "Replace recovery codes" }).click();
    await expect(replacement.page.getByRole("status")).toContainText("All previous codes are invalid", { timeout: 120_000 });
    const obsolete = await replacement.page.evaluate(async ({ identifier, code }) => {
      const response = await fetch("/api/auth/recovery/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, code }),
      });
      return response.status;
    }, { identifier, code: unusedCode });
    expect(obsolete).toBe(401);
  } finally {
    await replacement?.context.close();
    await original.context.close();
  }
});
