import { createPublicKey } from "node:crypto";

import { cose, isoCBOR } from "@simplewebauthn/server/helpers";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import type { TestHarness } from "wrangler";

import { test, expect } from "./fixtures";

const ACCOUNT_ID = "019950d7-98c0-7000-8000-000000000002";
const IDLE_ACCOUNT_ID = "019950d7-98c0-7000-8000-000000000003";
const REVOKED_ACCOUNT_ID = "019950d7-98c0-7000-8000-000000000004";
const ABSOLUTE_ACCOUNT_ID = "019950d7-98c0-7000-8000-000000000005";
const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1_000;
const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1_000;

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

function accountUserHandle(accountId: string): string {
  return Buffer.from(accountId, "utf8").toString("base64url");
}

function coseP256PublicKey(spki: string): Uint8Array {
  const key = createPublicKey({
    key: Buffer.from(spki, "base64url"),
    format: "der",
    type: "spki",
  }).export({ format: "jwk" });
  if (!key.x || !key.y) throw new Error("expected a P-256 public key");

  const x = Buffer.from(key.x, "base64url");
  const y = Buffer.from(key.y, "base64url");
  if (x.byteLength !== 32 || y.byteLength !== 32) {
    throw new Error("expected P-256 coordinates");
  }

  // COSE_Key: {1: EC2, 3: ES256, -1: P-256, -2: x, -3: y}.
  return isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [cose.COSEKEYS.kty, cose.COSEKTY.EC2],
      [cose.COSEKEYS.alg, cose.COSEALG.ES256],
      [cose.COSEKEYS.crv, cose.COSECRV.P256],
      [cose.COSEKEYS.x, x],
      [cose.COSEKEYS.y, y],
    ]),
  );
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
  const credential = await context.credentials.create(rpId, {
    userHandle: accountUserHandle(accountId),
  });
  await context.credentials.install();

  const worker = server.getWorker<BrowserTestEnv>();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();
  const now = Date.now();
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
      .bind(accountId, Uint8Array.of(0), 1, 1, now, now),
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
