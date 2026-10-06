import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { createCookie } from "react-router";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createNormalSession,
  getActiveSession,
  revokeSession,
  SESSION_COOKIE_NAME,
} from "../../app/auth/session.server";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      SESSION_COOKIE_SECRET: string;
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("D1-backed Account Sessions", () => {
  it("stores only a signed opaque ID in the cookie and rejects it after revocation", async () => {
    const accountId = "019950d7-98c0-7000-8000-000000000001";
    const credentialId = "session-test-passkey";
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(
        accountId,
        "independent-session-test-share-id",
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO passkeys (credential_id, account_id, public_key, counter,
          transports, device_type, backed_up, created_at, updated_at)
         VALUES (?, ?, ?, 0, '[]', 'singleDevice', 0, ?, ?)`,
      ).bind(credentialId, accountId, Uint8Array.of(1).buffer, now, now),
    ]);

    const setCookie = await createNormalSession(env, accountId, credentialId);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    const cookie = setCookie.split(";")[0];
    const request = new Request("https://mdwn.test/account", {
      headers: { cookie },
    });
    const session = await getActiveSession(request, env);
    expect(session).toEqual({
      id: expect.any(String),
      accountId,
      purpose: "normal",
      authenticatedPasskeyId: credentialId,
      freshAssertedAt: expect.any(Number),
    });
    if (!session) throw new Error("expected a live Session");

    const parsedCookie = await createCookie(SESSION_COOKIE_NAME, {
      secrets: [env.SESSION_COOKIE_SECRET],
    }).parse(cookie);
    expect(parsedCookie).toBe(session.id);
    expect(parsedCookie).not.toBe(accountId);

    expect(await revokeSession(env, accountId, session.id)).toBe(true);
    expect(await getActiveSession(request, env)).toBeNull();
  });
});
