import { gunzipSync } from "node:zlib";
import type { Browser, Page } from "@playwright/test";
import type { TestHarness } from "wrangler";

import { test, expect } from "./fixtures";
import { completeRecoveryPresentation } from "./signup-recovery";
import { seedAccount, signInAccount } from "./support/seeded-account";
import { expectSignupShape } from "./support/signup-shape";
import { waitForSharedProvisioning } from "./support/navigation";

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

/** Clicks a button that saves a file from the browser and returns its name and bytes. */
async function download(page: Page, button: string): Promise<{ name: string; bytes: Buffer }> {
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: button, exact: true }).click();
  const file = await event;
  const parts: Buffer[] = [];
  for await (const part of (await file.createReadStream())!) parts.push(Buffer.from(part));
  return { name: file.suggestedFilename(), bytes: Buffer.concat(parts) };
}

/** Saves both forms of one recovery file: the gzip download and its plain text carry the same text. */
async function recoveryFile(page: Page, label: string, name: string): Promise<string> {
  const compressed = await download(page, `${label} (.txt.gz)`);
  expect(compressed.name).toBe(`${name}.txt.gz`);
  const text = gunzipSync(compressed.bytes).toString("utf8");
  const plain = await download(page, `${label} as plain text (.txt)`);
  expect(plain.name).toBe(`${name}.txt`);
  expect(plain.bytes.toString("utf8")).toBe(text);
  return text;
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
    const phraseFile = await recoveryFile(page, "Download phrase", "mdwn-recovery-phrase");
    expect(phraseFile.match(/^ ?\d+\. \S+$/gm)?.map((line) => line.replace(/^ ?\d+\. /, ""))).toEqual(words);
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
        const codesFile = await recoveryFile(page, "Download codes", "mdwn-recovery-codes");
        for (const code of codes) expect(codesFile).toContain(code);
        for (const word of words) expect(codesFile).not.toContain(` ${word}\n`);
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
    await waitForSharedProvisioning(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Save your recovery phrase" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Account menu", exact: true }).click();
    await page.locator("#account-menu").getByRole("link", { name: "Public pseudonym", exact: true }).click();
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
      // route.fetch() applies Set-Cookie to the shared jar even if we abort the response.
      // Lose that header before any reload, otherwise signup redirects this bound Session to /files.
      await context.clearCookies({ name: "__Host-mdwn_session" });
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
    // The outcome is unknown and a passkey exists: never a retry with this material, only sign-in or a new start.
    const notice = page.getByRole("alert");
    await expect(notice).toContainText("We could not confirm that your account was created");
    await expect(notice.getByRole("link", { name: "Sign in", exact: true })).toBeFocused();
    await expect(notice.getByRole("button", { name: "Start over", exact: true })).toBeVisible();
    await expect(notice.getByRole("button", { name: /Try again|Create passkey/ })).toHaveCount(0);
    // Lost response headers must not leave a browser Session before the reload.
    expect((await context.cookies()).some((cookie) => cookie.name === "__Host-mdwn_session")).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem("mdwn:signup:recovery-confirmation-pending"))).toBeNull();
    expect(payload).toBeDefined();
    expect(await count(env, "accounts")).toBe(1);
    const accountId = payload!.transcript.accountId;
    const deviceId = payload!.transcript.deviceId;
    await page.reload();
    await expect(page).toHaveURL(/\/sign-up$/);
    expect(await page.evaluate(() => localStorage.getItem("mdwn:signup:recovery-confirmation-pending"))).toBeNull();
    await page.getByRole("banner").getByRole("link", { name: "Sign in", exact: true }).click();
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

/** Records which signup resource each request names, in order. */
function signupRequests(page: Page): string[] {
  const paths: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/signup/")) paths.push(path.slice("/api/signup/".length));
  });
  return paths;
}

/** Fulfills the first request to `path` with `response`; later ones reach the Worker. */
async function failOnce(page: Page, path: string, response: { status: number; headers?: Record<string, string> }) {
  let failed = false;
  await page.route(`**${path}`, async (route) => {
    if (failed) return route.fallback();
    failed = true;
    await route.fulfill({ ...response, json: { error: "request_failed" } });
  });
}

test("rate-limited, failed and dismissed attempts retry with the recovery material already saved", async ({
  browser,
  server,
  baseURL,
}) => {
  const env = await db(server);
  const { context, page } = await signupContext(browser, baseURL!);
  try {
    const requests = signupRequests(page);
    await failOnce(page, "/api/signup/challenge", { status: 429, headers: { "Retry-After": "540" } });
    // The second start fails after its proof of work, before any passkey prompt.
    await failOnce(page, "/api/signup/options", { status: 503 });
    const verify = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/signup/verify" && request.method() === "POST",
    );
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    let identifier = "";
    await completeRecoveryPresentation(page, {
      beforeConfirm: async () => {
        identifier = await page
          .getByText(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
          .innerText();
        // The person then dismisses the first passkey prompt.
        await page.evaluate(() => {
          const create = navigator.credentials.create.bind(navigator.credentials);
          let dismissed = false;
          navigator.credentials.create = (options) => {
            if (dismissed) return create(options);
            dismissed = true;
            return Promise.reject(
              new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"),
            );
          };
        });
      },
    });
    await expect(page.getByText("Step 3 of 3", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Create your passkey" })).toBeVisible();
    const notice = page.getByRole("alert");
    await expect(notice).toContainText("Too many signups have started recently. Try again in about 9 minutes");
    await expect(notice).toContainText("recovery phrase and codes you saved still apply");
    await expect(notice.getByRole("button", { name: "Try again", exact: true })).toBeFocused();
    expect(requests).toEqual(["challenge"]);

    // Each retry is a fresh rate-limited start for the same Account material.
    await notice.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(notice).toContainText("Signup stopped before your passkey was created");
    await expect(notice).toContainText("recovery phrase and codes you saved still apply");
    expect(requests).toEqual(["challenge", "challenge", "options"]);

    await notice.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(notice).toContainText("Your passkey wasn’t created");
    await expect(notice.getByRole("button", { name: "Create passkey", exact: true })).toBeFocused();
    const progress = page.locator("section ol li");
    await expect(progress.filter({ hasText: "Signup check" })).toContainText("(done)");
    await expect(progress.filter({ hasText: "Passkey" })).not.toContainText("(done)");
    expect(requests).toEqual(["challenge", "challenge", "options", "challenge", "options"]);
    expect(await count(env, "accounts")).toBe(0);

    // The prompt reopens with the same registration: no further start.
    await notice.getByRole("button", { name: "Create passkey", exact: true }).click();
    const payload = (await verify).postDataJSON() as VerifyPayload;
    await expect(page).toHaveURL(/\/files$/);
    await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
    expect(requests).toEqual(["challenge", "challenge", "options", "challenge", "options", "verify"]);
    expect(payload.transcript.accountId).toBe(identifier);
    await expectSignupShape(env.DB, payload.transcript);
    expect(await context.credentials.get()).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("a refused commit never retries the material its passkey was made for", async ({ browser, server, baseURL }) => {
  const env = await db(server);
  const { context, page } = await signupContext(browser, baseURL!);
  try {
    const requests = signupRequests(page);
    await failOnce(page, "/api/signup/verify", { status: 429, headers: { "Retry-After": "30000" } });
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await completeRecoveryPresentation(page);
    const notice = page.getByRole("alert");
    await expect(notice).toContainText("your account wasn’t created. Come back in about 8 hours to start over");
    await expect(notice.getByRole("button")).toHaveCount(0);
    expect(requests).toEqual(["challenge", "options", "verify"]);
    expect(await count(env, "accounts")).toBe(0);
    expect(await context.credentials.get()).toHaveLength(1);
  } finally {
    await context.close();
  }
});
