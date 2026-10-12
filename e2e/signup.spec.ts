import type { Browser, Page } from "@playwright/test";
import type { TestHarness } from "wrangler";

import { test, expect } from "./fixtures";
import { completeRecoveryPresentation } from "./signup-recovery";
import { seedAccount, signInAccount } from "./support/seeded-account";
import { expectSignupShape } from "./support/signup-shape";

type Env = { DB: D1Database };
type VerifyPayload = {
  challengeId: string;
  transcript: { accountId: string; deviceId: string; rootDirectoryId: string };
  [key: string]: unknown;
};

// The browser solves an 18-bit PoW before opening the passkey prompt.
test.setTimeout(180_000);

async function signupContext(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  // WebKit's virtual authenticator has no native PublicKeyCredential constructor.
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
      method: "POST",
      headers: value ? { "X-Mdwn-Device-Proof": JSON.stringify(value) } : {},
    });
    return { status: response.status, body: await response.json() };
  }, proof);
}

async function signedProof(page: Page, accountId: string) {
  return page.evaluate(async (id) => {
    const stateResponse = await fetch("/api/device/state");
    if (!stateResponse.ok) throw new Error("No active session");
    const state = (await stateResponse.json()) as {
      sessionBinding: string;
      registryEpoch: number;
      deviceId: string;
    };
    const device = await new Promise<{ assertionKeyPair: CryptoKeyPair; deviceId: string; registryEpoch: number }>(
      (resolve, reject) => {
        const opening = indexedDB.open("mdwn-device-store");
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const database = opening.result;
          const get = database.transaction("devices", "readonly").objectStore("devices").get(id);
          get.onsuccess = () => {
            database.close();
            resolve(get.result);
          };
          get.onerror = () => {
            database.close();
            reject(get.error);
          };
        };
      },
    );
    if (!device || device.deviceId !== state.deviceId || device.registryEpoch !== state.registryEpoch) {
      throw new Error("Persisted device does not match bound session");
    }
    const encode = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array());
    const now = Date.now();
    const unsigned = {
      sessionBinding: state.sessionBinding,
      deviceId: device.deviceId,
      registryEpoch: device.registryEpoch,
      method: "POST",
      path: "/api/private/bootstrap",
      bodyDigest: encode(new Uint8Array(digest)),
      issuedAt: now,
      expiresAt: now + 300_000,
      proofId: crypto.randomUUID(),
    };
    const statement = JSON.stringify([
      "mdwn/device-proof/v1",
      unsigned.sessionBinding,
      unsigned.deviceId,
      unsigned.registryEpoch,
      unsigned.method,
      unsigned.path,
      unsigned.bodyDigest,
      unsigned.issuedAt,
      unsigned.expiresAt,
      unsigned.proofId,
    ]);
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      device.assertionKeyPair.privateKey,
      new TextEncoder().encode(statement),
    );
    return { ...unsigned, signature: encode(new Uint8Array(signature)) };
  }, accountId);
}

/** Clicks a button that saves a file from the browser and returns its name and text. */
async function download(page: Page, button: string): Promise<{ name: string; text: string }> {
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: button, exact: true }).click();
  const file = await event;
  const parts: Buffer[] = [];
  for await (const part of (await file.createReadStream())!) parts.push(Buffer.from(part));
  return { name: file.suggestedFilename(), text: Buffer.concat(parts).toString("utf8") };
}

test("signs up atomically with a bound device and gates recovery material before private access", async ({
  browser,
  server,
  baseURL,
}) => {
  const env = await db(server);
  const { context, page } = await signupContext(browser, baseURL!);
  try {
    const signupRequests: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/signup/")) signupRequests.push(path);
    });
    const verify = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/signup/verify" && request.method() === "POST",
      { timeout: 120_000 },
    );
    // The Public pseudonym is the person's own; a suggestion fills the field until they write one.
    const pseudonym = page.getByRole("textbox", { name: "Public pseudonym", exact: true });
    await expect(pseudonym).toHaveValue(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{2}$/);
    await pseudonym.fill("  Quiet   Heron ");
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Save your recovery phrase" })).toBeVisible({ timeout: 120_000 });
    const words = (await page.locator("section ol li").allTextContents()).map((word) =>
      word.replace(/^\d+\.\s*/, "").trim(),
    );
    const phraseFile = await download(page, "Download phrase (.txt)");
    expect(phraseFile.name).toBe("mdwn-recovery-phrase.txt");
    expect(phraseFile.text.match(/^ ?\d+\. \S+$/gm)?.map((line) => line.replace(/^ ?\d+\. /, ""))).toEqual(words);
    expect(await page.evaluate(() => localStorage.getItem("mdwn:signup:recovery-confirmation-pending"))).toEqual(
      expect.any(String),
    );
    expect(signupRequests).toEqual([]);
    expect(await count(env, "registration_challenges")).toBe(0);
    expect(await count(env, "accounts")).toBe(0);
    await completeRecoveryPresentation(page, {
      checkIncorrectWord: true,
      beforeConfirm: async () => {
        await expect(page.getByText("Creating your account…")).toHaveCount(0);
        await expect(page.getByText("Setting up your Files securely…")).toHaveCount(0);
        await expect(page.getByText("Shared content is being securely provisioned")).toHaveCount(0);
        expect(await page.evaluate(() => localStorage.getItem("mdwn:signup:recovery-confirmation-pending"))).toEqual(
          expect.any(String),
        );
        expect(signupRequests).toEqual([]);
        expect(await count(env, "registration_challenges")).toBe(0);
        expect(await count(env, "accounts")).toBe(0);
        expect(await count(env, "sessions")).toBe(0);
        const codes = (await page.locator("section ol li").allTextContents()).map((code) =>
          code.replace(/^\d+\.\s*/, "").trim(),
        );
        const codesFile = await download(page, "Download codes (.txt)");
        expect(codesFile.name).toBe("mdwn-recovery-codes.txt");
        for (const code of codes) expect(codesFile.text).toContain(code);
        for (const word of words) expect(codesFile.text).not.toContain(` ${word}\n`);
        // Saving a file is local: it starts no signup request.
        expect(signupRequests).toEqual([]);
      },
    });
    const payload = (await verify).postDataJSON() as VerifyPayload;
    const { accountId, rootDirectoryId } = payload.transcript;
    // Creating the account signs this browser in: its new library is home.
    await expect(page).toHaveURL(/\/files$/);
    await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("mdwn:signup:recovery-confirmation-pending"))).toBeNull();
    expect(await count(env, "accounts")).toBe(1);
    await expectSignupShape(env.DB, payload.transcript);
    expect(
      (await page.evaluate(async () => (await (await fetch("/api/auth/session")).json()) as { authenticated: boolean }))
        .authenticated,
    ).toBe(true);
    expect((await privateRead(page)).status).toBe(403);
    const proof = await signedProof(page, accountId);
    const firstRead = await privateRead(page, proof);
    expect(firstRead.status).toBe(200);
    expect(firstRead.body).toMatchObject({
      rootDirectoryId,
      capsule: expect.any(String),
      enrollmentEnvelope: expect.any(String),
    });
    expect((await privateRead(page, { ...proof, deviceId: crypto.randomUUID() })).status).toBe(403);
    expect((await privateRead(page, proof)).status).toBe(200); // read proofs are not consumed
    expect(await count(env, "device_proof_uses", accountId)).toBe(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Save your recovery phrase" })).toHaveCount(0);
    await page.goto("/account/pseudonym");
    await expect(page.getByLabel("Current Public pseudonym")).toHaveText("Quiet Heron");
  } finally {
    await context.close();
  }
});

test("sign-out preserves the device keys for a later private-capable sign-in", async ({ browser, server, baseURL }) => {
  const env = await db(server);
  const seeded = await seedAccount(browser, server, baseURL!);
  const { context, page, accountId, deviceId } = seeded;
  try {
    await signInAccount(seeded);
    // Guard fixture drift using the very same contract as atomic signup above.
    await expectSignupShape(env.DB, seeded);
    const response = await page.evaluate(async () =>
      fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).then((result) => result.status),
    );
    expect(response).toBe(200);
    await page.goto(`${new URL(baseURL!).origin}/sign-in`, { waitUntil: "commit" });
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    // The kept device binds the new Session, so sign-in opens the library rather than device access.
    await expect(page).toHaveURL(/\/files$/);
    await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
    expect((await privateRead(page, await signedProof(page, accountId))).status).toBe(200);
    const sessions = await env.DB.prepare("SELECT device_id FROM sessions WHERE account_id = ?")
      .bind(accountId)
      .all<{ device_id: string | null }>();
    expect(sessions.results).toHaveLength(2);
    expect(sessions.results.every((session) => session.device_id === deviceId)).toBe(true);
  } finally {
    await context.close();
  }
});

test("a lost signup commit response signs in with the persisted device without another Account", async ({
  browser,
  server,
  baseURL,
}) => {
  const env = await db(server);
  const { context, page } = await signupContext(browser, baseURL!);
  try {
    let committed!: () => void;
    const committedResponse = new Promise<void>((resolve) => {
      committed = resolve;
    });
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
        expect(await page.evaluate(() => localStorage.getItem("mdwn:signup:recovery-confirmation-pending"))).toEqual(
          expect.any(String),
        );
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
    // route.fetch() stored the commit's Session cookie in this context; a response
    // lost on the network never reaches the browser, so its cookie is dropped too.
    await context.clearCookies();
    await page.goto(`${new URL(baseURL!).origin}/sign-in`, { waitUntil: "commit" });
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    // The persisted device binds the new Session, so sign-in opens the library rather than device access.
    await expect(page).toHaveURL(/\/files$/);
    await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("mdwn:signup:recovery-confirmation-pending"))).toBeNull();
    const sessions = await env.DB.prepare("SELECT device_id FROM sessions WHERE account_id = ? ORDER BY created_at")
      .bind(accountId)
      .all<{ device_id: string | null }>();
    expect(sessions.results).toHaveLength(2);
    expect(sessions.results.map((row) => row.device_id)).toEqual([deviceId, deviceId]);
    expect(await count(env, "accounts")).toBe(1);
    expect((await privateRead(page)).status).toBe(403);
    expect((await privateRead(page, await signedProof(page, accountId))).status).toBe(200);
  } finally {
    await context.close();
  }
});
