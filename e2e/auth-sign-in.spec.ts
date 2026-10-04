import type { Browser, BrowserContext, Page } from "@playwright/test";
import type { TestHarness } from "wrangler";

import { openAccountProfile, sealAccountProfile } from "../app/crypto/account-profile";
import { test, expect } from "./fixtures";
import { coseP256PublicKey } from "./support/passkey";

const ACCOUNT_ID = "019950d7-98c0-7000-8000-000000000002";
const IDLE_ACCOUNT_ID = "019950d7-98c0-7000-8000-000000000003";
const REVOKED_ACCOUNT_ID = "019950d7-98c0-7000-8000-000000000004";
const ABSOLUTE_ACCOUNT_ID = "019950d7-98c0-7000-8000-000000000005";
const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1_000;
const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1_000;
const SEEDED_PUBLIC_PSEUDONYM = "Cobalt Wren";

type BrowserTestEnv = {
  DB: D1Database;
};

type VerifyPayload = {
  challengeId: string;
  response: unknown;
};

type SignedInFixture = {
  accountId: string;
  context: BrowserContext;
  credentialId: string;
  env: BrowserTestEnv;
  origin: string;
  page: Page;
  profileRootKey: Uint8Array;
  verifyPayload: VerifyPayload;
};

type SessionRow = {
  account_id: string;
  authenticated_passkey_id: string;
  id: string;
  purpose: string;
  revoked_at: number | null;
};

type PasskeyRow = {
  credential_id: string;
};

type AccountProfileRow = {
  ciphertext: ArrayBuffer;
  epoch: number;
  revision: number;
};

function accountUserHandle(accountId: string): string {
  return Buffer.from(accountId, "utf8").toString("base64url");
}

async function sessionsFor(
  env: BrowserTestEnv,
  accountId: string,
): Promise<SessionRow[]> {
  const sessions = await env.DB
    .prepare(
      `SELECT id, account_id, authenticated_passkey_id, purpose, revoked_at
       FROM sessions WHERE account_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .bind(accountId)
    .all<SessionRow>();
  return sessions.results;
}

async function passkeysFor(
  env: BrowserTestEnv,
  accountId: string,
): Promise<PasskeyRow[]> {
  const passkeys = await env.DB
    .prepare(
      "SELECT credential_id FROM passkeys WHERE account_id = ? ORDER BY created_at ASC, credential_id ASC",
    )
    .bind(accountId)
    .all<PasskeyRow>();
  return passkeys.results;
}

async function accountProfileFor(
  env: BrowserTestEnv,
  accountId: string,
): Promise<AccountProfileRow> {
  const profile = await env.DB
    .prepare("SELECT ciphertext, epoch, revision FROM account_profiles WHERE account_id = ?")
    .bind(accountId)
    .first<AccountProfileRow>();
  if (!profile) throw new Error("expected an encrypted Account profile");
  return profile;
}

async function publicSessionState(page: Page): Promise<{
  body: { authenticated: boolean };
  status: number;
}> {
  return page.evaluate(async () => {
    const response = await fetch("/api/auth/session");
    return { status: response.status, body: await response.json() };
  });
}

async function signInSeededAccount(
  browser: Browser,
  server: TestHarness,
  baseURL: string,
  accountId = ACCOUNT_ID,
): Promise<SignedInFixture> {
  const origin = new URL(baseURL).origin;
  const rpId = new URL(baseURL).hostname;
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  // Playwright supplies the virtual WebAuthn calls even when Linux WebKit has
  // no native constructor (Playwright supplies an object placeholder instead).
  // SimpleWebAuthn requires a function before invoking those calls.
  await context.addInitScript(() => {
    if (typeof globalThis.PublicKeyCredential !== "function") {
      Object.defineProperty(globalThis, "PublicKeyCredential", {
        configurable: true,
        value: class PublicKeyCredential {},
      });
    }
  });
  const credential = await context.credentials.create(rpId, {
    userHandle: accountUserHandle(accountId),
  });
  await context.credentials.install();

  const worker = server.getWorker<BrowserTestEnv>();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();
  const now = Date.now();
  const profileRootKey = crypto.getRandomValues(new Uint8Array(32));
  const profile = await sealAccountProfile(
    profileRootKey,
    { publicPseudonym: SEEDED_PUBLIC_PSEUDONYM },
    { accountId, epoch: 1, revision: 1 },
  );
  await env.DB.batch([
    env.DB
      .prepare(
        "INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .bind(accountId, `opaque-browser-test-share-${accountId}`, now, now),
    env.DB
      .prepare(
        `INSERT INTO account_profiles (account_id, ciphertext, revision, epoch, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(accountId, profile.ciphertext, profile.revision, profile.epoch, now, now),
    env.DB
      .prepare(
        `INSERT INTO passkeys (
          credential_id, account_id, public_key, counter, transports,
          device_type, backed_up, created_at, updated_at
        ) VALUES (?, ?, ?, 0, '[]', 'singleDevice', 0, ?, ?)`,
      )
      .bind(credential.id, accountId, coseP256PublicKey(credential.publicKey), now, now),
  ]);

  const page = await context.newPage();
  await page.goto(`${origin}/sign-in`, { waitUntil: "commit" });
  const verificationRequest = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/auth/sign-in/verify" &&
      request.method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  const verifyPayload = (await verificationRequest).postDataJSON() as VerifyPayload;
  await expect(page.getByText("Signed in")).toBeVisible();

  return {
    accountId,
    context,
    credentialId: credential.id,
    env,
    origin,
    page,
    profileRootKey,
    verifyPayload,
  };
}

test("signs a seeded Account into a normal Session and rejects assertion replay", async ({
  browser,
  server,
  baseURL,
}) => {
  const fixture = await signInSeededAccount(browser, server, baseURL!);
  try {
    const profile = await accountProfileFor(fixture.env, fixture.accountId);
    expect(profile).toMatchObject({ epoch: 1, revision: 1 });
    await expect(openAccountProfile(
      new Uint8Array(profile.ciphertext),
      fixture.profileRootKey,
      { accountId: fixture.accountId, epoch: profile.epoch, revision: profile.revision },
    )).resolves.toEqual({ publicPseudonym: SEEDED_PUBLIC_PSEUDONYM });
    await expect(openAccountProfile(
      new Uint8Array(profile.ciphertext),
      fixture.profileRootKey,
      { accountId: fixture.accountId, epoch: profile.epoch, revision: profile.revision + 1 },
    )).rejects.toMatchObject({ code: "context-mismatch" });

    expect(await publicSessionState(fixture.page)).toEqual({
      status: 200,
      body: { authenticated: true },
    });

    const replay = await fixture.page.evaluate(async (payload) => {
      const response = await fetch("/api/auth/sign-in/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: response.status, body: await response.json() };
    }, fixture.verifyPayload);
    expect(replay).toEqual({ status: 401, body: { error: "authentication_failed" } });

    const invalid = await fixture.page.evaluate(async () => {
      const response = await fetch("/api/auth/sign-in/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: "not-a-live-challenge", response: {} }),
      });
      return response.status;
    });
    expect(invalid).toBe(401);
    expect(await sessionsFor(fixture.env, fixture.accountId)).toEqual([
      {
        account_id: fixture.accountId,
        authenticated_passkey_id: fixture.credentialId,
        id: expect.any(String),
        purpose: "normal",
        revoked_at: null,
      },
    ]);
  } finally {
    await fixture.context.close();
  }
});

test("adds and removes an attestation-none resident Passkey after fresh assertions", async ({
  browser,
  server,
  baseURL,
}) => {
  const fixture = await signInSeededAccount(browser, server, baseURL!);
  try {
    let freshAssertions = 0;
    fixture.page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/auth/passkeys/fresh/options") {
        freshAssertions += 1;
      }
    });

    await fixture.page.goto(`${fixture.origin}/account/security`, { waitUntil: "commit" });
    await expect(fixture.page.getByRole("heading", { name: "Passkey management" })).toBeVisible();

    // The fresh assertion uses the seeded authenticator. Switch the virtual
    // authenticator before registration so excludeCredentials models adding a
    // passkey on another device, where the original credential is absent.
    let switchedAuthenticator = false;
    await fixture.page.route("**/api/auth/passkeys/registration/options", async (route) => {
      await fixture.context.credentials.delete(fixture.credentialId);
      switchedAuthenticator = true;
      await route.continue();
    });

    const registrationOptions = fixture.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/auth/passkeys/registration/options" &&
        response.request().method() === "POST",
    );
    await fixture.page.getByRole("button", { name: "Add passkey" }).click();
    const registration = await registrationOptions;
    expect(registration.status()).toBe(200);
    const registrationBody = await registration.json() as {
      options: {
        attestation: string;
        authenticatorSelection: {
          requireResidentKey: boolean;
          residentKey: string;
          userVerification: string;
        };
        user: { id: string };
      };
    };
    expect(registrationBody.options.attestation).toBe("none");
    expect(registrationBody.options.authenticatorSelection).toEqual({
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    });
    expect(Buffer.from(registrationBody.options.user.id, "base64url").toString("utf8")).toBe(
      fixture.accountId,
    );
    await expect(fixture.page.getByRole("status")).toHaveText("Passkey added.");
    expect(await passkeysFor(fixture.env, fixture.accountId)).toHaveLength(2);
    expect(switchedAuthenticator).toBe(true);

    await fixture.page.getByRole("button", { name: "Remove passkey", exact: true }).click();
    await expect(fixture.page.getByRole("status")).toHaveText("Passkey removed.");
    expect(await passkeysFor(fixture.env, fixture.accountId)).toEqual([
      { credential_id: fixture.credentialId },
    ]);
    expect(freshAssertions).toBe(2);
    expect(await publicSessionState(fixture.page)).toEqual({
      status: 200,
      body: { authenticated: true },
    });
  } finally {
    await fixture.context.close();
  }
});

test("consumes registration after freshness expires before its completion", async ({
  browser,
  server,
  baseURL,
}) => {
  const fixture = await signInSeededAccount(browser, server, baseURL!);
  try {
    await fixture.page.goto(`${fixture.origin}/account/security`, { waitUntil: "commit" });
    await expect(fixture.page.getByRole("heading", { name: "Passkey management" })).toBeVisible();

    await fixture.page.route("**/api/auth/passkeys/registration/options", async (route) => {
      await fixture.context.credentials.delete(fixture.credentialId);
      await route.continue();
    });

    let releaseVerify!: () => void;
    const verificationReleased = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    let markVerifyReached!: (payload: { challengeId: string }) => void;
    const verifyReached = new Promise<{ challengeId: string }>((resolve) => {
      markVerifyReached = resolve;
    });
    await fixture.page.route("**/api/auth/passkeys/registration/verify", async (route) => {
      const payload = route.request().postDataJSON() as { challengeId: string };
      markVerifyReached(payload);
      await verificationReleased;
      await route.continue();
    });

    await fixture.page.getByRole("button", { name: "Add passkey" }).click();
    const payload = await verifyReached;
    const [current] = await sessionsFor(fixture.env, fixture.accountId);
    if (!current) throw new Error("expected a current Session");
    await fixture.env.DB
      .prepare("UPDATE sessions SET fresh_asserted_at = ? WHERE id = ?")
      .bind(Date.now() - 5 * 60 * 1_000 - 1, current.id)
      .run();

    const response = fixture.page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === "/api/auth/passkeys/registration/verify" &&
        candidate.request().method() === "POST",
    );
    releaseVerify();
    expect((await response).status()).toBe(401);
    await expect(fixture.page.getByRole("status")).toHaveText(
      "We could not update your Passkeys. Try again.",
    );
    expect(await passkeysFor(fixture.env, fixture.accountId)).toEqual([
      { credential_id: fixture.credentialId },
    ]);
    expect(
      await fixture.env.DB
        .prepare("SELECT id FROM webauthn_challenges WHERE id = ?")
        .bind(payload.challengeId)
        .first(),
    ).toBeNull();
  } finally {
    await fixture.context.close();
  }
});

test("holds mutations pending through revalidation instead of racing older lists", async ({
  browser,
  server,
  baseURL,
}) => {
  const fixture = await signInSeededAccount(browser, server, baseURL!);
  try {
    const now = Date.now();
    const otherId = `peer-${fixture.accountId}`;
    await fixture.env.DB
      .prepare(
        `INSERT INTO sessions (
          id, account_id, purpose, authenticated_passkey_id, created_at,
          idle_expires_at, absolute_expires_at, fresh_asserted_at, refreshed_at, revoked_at
        ) VALUES (?, ?, 'normal', ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .bind(
        otherId,
        fixture.accountId,
        fixture.credentialId,
        now,
        now + SESSION_IDLE_MS,
        now + SESSION_ABSOLUTE_MS,
        now,
      )
      .run();
    await fixture.page.goto(`${fixture.origin}/account/security`, { waitUntil: "commit" });
    const revoke = fixture.page.getByRole("button", { name: "Revoke other session" });
    await expect(revoke).toBeVisible();

    let releaseRevalidation!: () => void;
    const revalidationReleased = new Promise<void>((resolve) => {
      releaseRevalidation = resolve;
    });
    let markRevalidationReached!: () => void;
    const revalidationReached = new Promise<void>((resolve) => {
      markRevalidationReached = resolve;
    });
    await fixture.page.route("**/api/auth/sessions", async (route) => {
      const response = await route.fetch();
      markRevalidationReached();
      await revalidationReleased;
      await route.fulfill({ response });
    });

    try {
      await fixture.page.getByRole("button", { name: "Refresh session" }).click();
      await revalidationReached;
      await expect(revoke).toBeDisabled();
    } finally {
      releaseRevalidation();
    }

    await expect(revoke).toBeEnabled();
    await revoke.click();
    await expect(revoke).toHaveCount(0);
    await expect(fixture.page.getByRole("status")).toHaveText("Session revoked.");
    expect(await sessionsFor(fixture.env, fixture.accountId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: otherId, revoked_at: expect.any(Number) })]),
    );
  } finally {
    await fixture.context.close();
  }
});

test("refreshes and revokes Sessions from the account-security UI", async ({
  browser,
  server,
  baseURL,
}) => {
  const fixture = await signInSeededAccount(browser, server, baseURL!);
  try {
    await fixture.page.goto(`${fixture.origin}/account/security`, { waitUntil: "commit" });
    await expect(fixture.page.getByRole("heading", { name: "Account security" })).toBeVisible();
    await expect(fixture.page.getByText("Current session")).toBeVisible();

    await fixture.page.getByRole("button", { name: "Refresh session" }).click();
    await expect(fixture.page.getByRole("status")).toHaveText("Session refreshed.");

    const now = Date.now();
    const otherId = `other-session-${fixture.accountId}`;
    await fixture.env.DB
      .prepare(
        `INSERT INTO sessions (
          id, account_id, purpose, authenticated_passkey_id, created_at,
          idle_expires_at, absolute_expires_at, fresh_asserted_at, refreshed_at, revoked_at
        ) VALUES (?, ?, 'normal', ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .bind(
        otherId,
        fixture.accountId,
        fixture.credentialId,
        now,
        now + SESSION_IDLE_MS,
        now + SESSION_ABSOLUTE_MS,
        now,
      )
      .run();
    await fixture.page.reload({ waitUntil: "commit" });
    await expect(fixture.page.getByRole("button", { name: "Revoke other session" })).toBeVisible();
    await fixture.page.getByRole("button", { name: "Revoke other session" }).click();
    await expect(fixture.page.getByRole("status")).toHaveText("Session revoked.");
    expect(
      (await fixture.env.DB
        .prepare("SELECT revoked_at FROM sessions WHERE id = ?")
        .bind(otherId)
        .first<{ revoked_at: number | null }>())?.revoked_at,
    ).toEqual(expect.any(Number));

    await Promise.all([
      fixture.page.waitForURL(`${fixture.origin}/sign-in`),
      fixture.page.getByRole("button", { name: "Sign out all sessions" }).click(),
    ]);
    expect(await publicSessionState(fixture.page)).toEqual({
      status: 200,
      body: { authenticated: false },
    });
  } finally {
    await fixture.context.close();
  }
});

test("signs out through the UI and rejects revoked, idle, and absolute cookies", async ({
  browser,
  server,
  baseURL,
}) => {
  const signedOut = await signInSeededAccount(browser, server, baseURL!);
  try {
    await signedOut.page.goto(`${signedOut.origin}/account/security`, { waitUntil: "commit" });
    await expect(signedOut.page.getByText("Current session")).toBeVisible();
    await Promise.all([
      signedOut.page.waitForURL(`${signedOut.origin}/sign-in`),
      signedOut.page.getByRole("button", { name: "Sign out", exact: true }).click(),
    ]);
    expect(await publicSessionState(signedOut.page)).toEqual({
      status: 200,
      body: { authenticated: false },
    });
  } finally {
    await signedOut.context.close();
  }

  const idle = await signInSeededAccount(browser, server, baseURL!, IDLE_ACCOUNT_ID);
  try {
    const [session] = await sessionsFor(idle.env, idle.accountId);
    await idle.env.DB
      .prepare("UPDATE sessions SET idle_expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, session!.id)
      .run();
    expect(await publicSessionState(idle.page)).toEqual({
      status: 200,
      body: { authenticated: false },
    });
  } finally {
    await idle.context.close();
  }

  const absolute = await signInSeededAccount(browser, server, baseURL!, ABSOLUTE_ACCOUNT_ID);
  try {
    const [session] = await sessionsFor(absolute.env, absolute.accountId);
    const now = Date.now();
    await absolute.env.DB
      .prepare(
        `UPDATE sessions
         SET created_at = ?, idle_expires_at = ?, absolute_expires_at = ?
         WHERE id = ?`,
      )
      .bind(now - SESSION_ABSOLUTE_MS - 2, now - 1, now - 1, session!.id)
      .run();
    expect(await publicSessionState(absolute.page)).toEqual({
      status: 200,
      body: { authenticated: false },
    });
  } finally {
    await absolute.context.close();
  }

  const revoked = await signInSeededAccount(browser, server, baseURL!, REVOKED_ACCOUNT_ID);
  try {
    const [session] = await sessionsFor(revoked.env, revoked.accountId);
    await revoked.env.DB
      .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), session!.id)
      .run();
    expect(await publicSessionState(revoked.page)).toEqual({
      status: 200,
      body: { authenticated: false },
    });
  } finally {
    await revoked.context.close();
  }
});
