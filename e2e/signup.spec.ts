import type { Browser, Page } from "@playwright/test";
import type { TestHarness } from "wrangler";

import { test, expect } from "./fixtures";
import { completeRecoveryPresentation } from "./signup-recovery";
import { seedAccount, signInAccount } from "./support/seeded-account";
import { expectSignupShape } from "./support/signup-shape";

type Env = { DB: D1Database };
type VerifyPayload = { challengeId: string; transcript: { accountId: string; deviceId: string; rootDirectoryId: string }; [key: string]: unknown };

// The browser solves an 18-bit PoW before opening the passkey prompt.
test.setTimeout(180_000);

async function signupContext(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  // WebKit's virtual authenticator has no native PublicKeyCredential constructor.
  await context.addInitScript(() => {
    if (typeof globalThis.PublicKeyCredential !== "function") {
      Object.defineProperty(globalThis, "PublicKeyCredential", {
        configurable: true, value: class PublicKeyCredential {},
      });
    }
  });
  await context.credentials.install();
  const page = await context.newPage();
  await page.goto(`${new URL(baseURL).origin}/sign-up`, { waitUntil: "commit" });
  return { context, page };
}

async function db(server: TestHarness): Promise<Env> {
  const worker = server.getWorker<Env>();
  await worker.applyD1Migrations("DB");
  return worker.getEnv();
}

async function count(env: Env, table: string, accountId?: string): Promise<number> {
  const query = accountId
    ? env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id = ?`).bind(accountId)
    : env.DB.prepare(`SELECT count(*) AS n FROM ${table}`);
  const row = await query.first<{ n: number }>();
  return row?.n ?? 0;
}

async function privateRead(page: Page, proof?: unknown) {
  return page.evaluate(async (value) => {
    const response = await fetch("/api/private/bootstrap", {
      method: "POST", headers: value ? { "X-Mdwn-Device-Proof": JSON.stringify(value) } : {},
    });
    return { status: response.status, body: await response.json() };
  }, proof);
}

async function signedProof(page: Page, accountId: string) {
  return page.evaluate(async (id) => {
    const stateResponse = await fetch("/api/device/state");
    if (!stateResponse.ok) throw new Error("No active session");
    const state = await stateResponse.json() as {
      sessionBinding: string; registryEpoch: number; deviceId: string;
    };
    const device = await new Promise<{ assertionKeyPair: CryptoKeyPair; deviceId: string; registryEpoch: number }>((resolve, reject) => {
      const opening = indexedDB.open("mdwn-device-store");
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result;
        const get = database.transaction("devices", "readonly").objectStore("devices").get(id);
        get.onsuccess = () => { database.close(); resolve(get.result); };
        get.onerror = () => { database.close(); reject(get.error); };
      };
    });
    if (!device || device.deviceId !== state.deviceId || device.registryEpoch !== state.registryEpoch) {
      throw new Error("Persisted device does not match bound session");
    }
    const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array());
    const now = Date.now();
    const unsigned = {
      sessionBinding: state.sessionBinding, deviceId: device.deviceId,
      registryEpoch: device.registryEpoch, method: "POST", path: "/api/private/bootstrap",
      bodyDigest: encode(new Uint8Array(digest)), issuedAt: now,
      expiresAt: now + 300_000, proofId: crypto.randomUUID(),
    };
    const statement = JSON.stringify([
      "mdwn/device-proof/v1", unsigned.sessionBinding, unsigned.deviceId,
      unsigned.registryEpoch, unsigned.method, unsigned.path, unsigned.bodyDigest,
      unsigned.issuedAt, unsigned.expiresAt, unsigned.proofId,
    ]);
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, device.assertionKeyPair.privateKey,
      new TextEncoder().encode(statement),
    );
    return { ...unsigned, signature: encode(new Uint8Array(signature)) };
  }, accountId);
}

test("signs up atomically with a bound device and gates recovery material before private access", async ({ browser, server, baseURL }) => {
  const env = await db(server);
  const { context, page } = await signupContext(browser, baseURL!);
  try {
    const signupRequests: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/signup/")) signupRequests.push(path);
    });
    const verify = page.waitForRequest((request) =>
      new URL(request.url()).pathname === "/api/signup/verify" && request.method() === "POST", { timeout: 120_000 });
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Save your recovery phrase" })).toBeVisible({ timeout: 120_000 });
    expect(await page.evaluate(() => localStorage.getItem("mdwn:signup:recovery-confirmation-pending"))).toEqual(expect.any(String));
    expect(signupRequests).toEqual([]);
    expect(await count(env, "registration_challenges")).toBe(0);
    expect(await count(env, "accounts")).toBe(0);
    await completeRecoveryPresentation(page, {
      checkIncorrectWord: true,
      beforeConfirm: async () => {
        await expect(page.getByText("Creating your account…")).toHaveCount(0);
        await expect(page.getByText("Setting up your Files securely…")).toHaveCount(0);
        await expect(page.getByText("Shared content is being securely provisioned")).toHaveCount(0);
        expect(await page.evaluate(() => localStorage.getItem("mdwn:signup:recovery-confirmation-pending"))).toEqual(expect.any(String));
        expect(signupRequests).toEqual([]);
        expect(await count(env, "registration_challenges")).toBe(0);
        expect(await count(env, "accounts")).toBe(0);
        expect(await count(env, "sessions")).toBe(0);
      },
    });
    const payload = (await verify).postDataJSON() as VerifyPayload;
    const { accountId, rootDirectoryId } = payload.transcript;
    await expect(page.getByText("Your account is ready.", { exact: false })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("mdwn:signup:recovery-confirmation-pending"))).toBeNull();
    expect(await count(env, "accounts")).toBe(1);
    await expectSignupShape(env.DB, payload.transcript);
    expect((await page.evaluate(async () => await (await fetch("/api/auth/session")).json() as { authenticated: boolean })).authenticated).toBe(true);
    expect((await privateRead(page)).status).toBe(403);
    const proof = await signedProof(page, accountId);
    const firstRead = await privateRead(page, proof);
    expect(firstRead.status).toBe(200);
    expect(firstRead.body).toMatchObject({ rootDirectoryId, capsule: expect.any(String), enrollmentEnvelope: expect.any(String) });
    expect((await privateRead(page, { ...proof, deviceId: crypto.randomUUID() })).status).toBe(403);
    expect((await privateRead(page, proof)).status).toBe(200); // read proofs are not consumed
    expect(await count(env, "device_proof_uses", accountId)).toBe(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Save your recovery phrase" })).toHaveCount(0);
  } finally { await context.close(); }
});

test("sign-out preserves the device keys for a later private-capable sign-in", async ({ browser, server, baseURL }) => {
  const env = await db(server);
  const seeded = await seedAccount(browser, server, baseURL!);
  const { context, page, accountId, deviceId } = seeded;
  try {
    await signInAccount(seeded);
    // Guard fixture drift using the very same contract as atomic signup above.
    await expectSignupShape(env.DB, seeded);
    const response = await page.evaluate(async () => fetch("/api/auth/sign-out", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }).then((result) => result.status));
    expect(response).toBe(200);
    await page.goto(`${new URL(baseURL!).origin}/sign-in`, { waitUntil: "commit" });
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect(page.getByText("Signed in.", { exact: false })).toBeVisible();
    await expect(page.getByText("This browser has no active Encryption device", { exact: false })).toHaveCount(0);
    expect((await privateRead(page, await signedProof(page, accountId))).status).toBe(200);
    const sessions = await env.DB.prepare("SELECT device_id FROM sessions WHERE account_id = ?")
      .bind(accountId).all<{device_id:string|null}>();
    expect(sessions.results).toHaveLength(2);
    expect(sessions.results.every((session) => session.device_id === deviceId)).toBe(true);
  } finally { await context.close(); }
});

test("a lost signup commit response signs in with the persisted device without another Account", async ({ browser, server, baseURL }) => {
  const env = await db(server);
  const { context, page } = await signupContext(browser, baseURL!);
  try {
    let committed!: () => void;
    const committedResponse = new Promise<void>((resolve) => { committed = resolve; });
    let payload: VerifyPayload | undefined;
    await page.route("**/api/signup/verify", async (route) => {
      payload = route.request().postDataJSON() as VerifyPayload;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed();
      // Simulate response loss AFTER D1 commit; the UI receives only retry guidance.
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await completeRecoveryPresentation(page, {
      beforeConfirm: async () => {
        expect(await count(env, "accounts")).toBe(0);
        expect(await count(env, "registration_challenges")).toBe(0);
        expect(await page.evaluate(() => localStorage.getItem("mdwn:signup:recovery-confirmation-pending"))).toEqual(expect.any(String));
      },
    });
    await committedResponse;
    await expect(page.getByRole("alert")).toContainText("sign in if your passkey was saved");
    expect(await page.evaluate(() => localStorage.getItem("mdwn:signup:recovery-confirmation-pending"))).toBeNull();
    expect(payload).toBeDefined();
    expect(await count(env, "accounts")).toBe(1);
    const accountId = payload!.transcript.accountId;
    const deviceId = payload!.transcript.deviceId;
    await page.reload();
    expect(await page.evaluate(() => localStorage.getItem("mdwn:signup:recovery-confirmation-pending"))).toBeNull();
    await page.goto(`${new URL(baseURL!).origin}/sign-in`, { waitUntil: "commit" });
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect(page.getByText("Signed in.", { exact: false })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("mdwn:signup:recovery-confirmation-pending"))).toBeNull();
    await expect(page.getByText("This browser has no active Encryption device", { exact: false })).toHaveCount(0);
    const sessions = await env.DB.prepare("SELECT device_id FROM sessions WHERE account_id = ? ORDER BY created_at")
      .bind(accountId).all<{ device_id: string | null }>();
    expect(sessions.results).toHaveLength(2);
    expect(sessions.results.map((row) => row.device_id)).toEqual([deviceId, deviceId]);
    expect(await count(env, "accounts")).toBe(1);
    expect((await privateRead(page)).status).toBe(403);
    expect((await privateRead(page, await signedProof(page, accountId))).status).toBe(200);
  } finally { await context.close(); }
});
