import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { FRESH_ASSERTION_MS } from "../../app/auth/session.server";
import {
  mutation,
  recoveryCookie,
  seedAccount,
  seedNormalSession,
  sessionState,
} from "./auth-fixtures";

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

describe("passkey management routes", () => {
  it("rejects missing or stale fresh assertions and refuses recovery Sessions", async () => {
    const account = await seedAccount();
    const normal = await seedNormalSession(account);
    await env.DB
      .prepare("UPDATE sessions SET fresh_asserted_at = NULL WHERE id = ?")
      .bind(normal.id)
      .run();

    expect(
      (await mutation("/api/auth/passkeys/registration/options", normal.cookie)).status,
    ).toBe(401);

    await env.DB
      .prepare("UPDATE sessions SET fresh_asserted_at = ? WHERE id = ?")
      .bind(Date.now() - FRESH_ASSERTION_MS - 1, normal.id)
      .run();
    expect(
      (await mutation("/api/auth/passkeys/registration/options", normal.cookie)).status,
    ).toBe(401);
    expect(
      (await mutation("/api/auth/passkeys/remove", normal.cookie, {
        credentialId: account.credentialIds[1],
      })).status,
    ).toBe(401);
    expect(
      await env.DB.prepare("SELECT credential_id FROM passkeys WHERE credential_id = ?")
        .bind(account.credentialIds[1])
        .first(),
    ).toEqual({ credential_id: account.credentialIds[1] });

    const recovery = await recoveryCookie(account.accountId);
    for (const [path, body] of [
      ["/api/auth/passkeys/fresh/options", {}],
      ["/api/auth/passkeys/registration/options", {}],
      ["/api/auth/passkeys/remove", { credentialId: account.credentialIds[0] }],
    ] as const) {
      expect((await mutation(path, recovery, body)).status).toBe(403);
    }
    expect(
      (await SELF.fetch("https://mdwn.test/api/auth/passkeys", {
        headers: { cookie: recovery },
      })).status,
    ).toBe(403);
  });

  it("binds fresh-assertion challenges to the Session and consumes an invalid same-session response", async () => {
    const account = await seedAccount();
    const first = await seedNormalSession(account, account.credentialIds[0]);
    const second = await seedNormalSession(account, account.credentialIds[1]);
    const start = await mutation("/api/auth/passkeys/fresh/options", first.cookie);
    expect(start.status).toBe(200);
    const { challengeId } = await start.json() as { challengeId: string };

    expect(
      (await mutation("/api/auth/passkeys/fresh/verify", second.cookie, {
        challengeId,
        response: {},
      })).status,
    ).toBe(401);
    expect(
      await env.DB
        .prepare("SELECT id FROM webauthn_challenges WHERE id = ?")
        .bind(challengeId)
        .first(),
    ).toEqual({ id: challengeId });

    expect(
      (await mutation("/api/auth/passkeys/fresh/verify", first.cookie, {
        challengeId,
        response: {},
      })).status,
    ).toBe(401);
    expect(
      await env.DB
        .prepare("SELECT id FROM webauthn_challenges WHERE id = ?")
        .bind(challengeId)
        .first(),
    ).toBeNull();
    expect(
      (await mutation("/api/auth/passkeys/fresh/verify", first.cookie, {
        challengeId,
        response: {},
      })).status,
    ).toBe(401);
  });

  it("binds registration challenges to the Account, Session, and origin before consuming them", async () => {
    const account = await seedAccount();
    const normal = await seedNormalSession(account);
    const foreign = await seedAccount();
    const foreignSession = await seedNormalSession(foreign);
    const start = await mutation("/api/auth/passkeys/registration/options", normal.cookie);
    expect(start.status).toBe(200);
    const { challengeId } = await start.json() as { challengeId: string };

    expect(
      (await mutation("/api/auth/passkeys/registration/verify", foreignSession.cookie, {
        challengeId,
        response: {},
      })).status,
    ).toBe(401);
    expect(
      await env.DB
        .prepare("SELECT id FROM webauthn_challenges WHERE id = ?")
        .bind(challengeId)
        .first(),
    ).toEqual({ id: challengeId });

    expect(
      (await mutation("/api/auth/passkeys/registration/verify", normal.cookie, {
        challengeId,
        response: {},
      }, "https://other-mdwn.test")).status,
    ).toBe(401);
    expect(
      await env.DB
        .prepare("SELECT id FROM webauthn_challenges WHERE id = ?")
        .bind(challengeId)
        .first(),
    ).toEqual({ id: challengeId });

    expect(
      (await mutation("/api/auth/passkeys/registration/verify", normal.cookie, {
        challengeId,
        response: {},
      })).status,
    ).toBe(401);
    expect(
      await env.DB
        .prepare("SELECT id FROM webauthn_challenges WHERE id = ?")
        .bind(challengeId)
        .first(),
    ).toBeNull();
    expect(
      (await mutation("/api/auth/passkeys/registration/verify", normal.cookie, {
        challengeId,
        response: {},
      })).status,
    ).toBe(401);
  });

  it("does not remove another Account's Passkey, preserves the last path, and revokes only target Passkey Sessions", async () => {
    const account = await seedAccount();
    const operator = await seedNormalSession(account, account.credentialIds[0]);
    const target = await seedNormalSession(account, account.credentialIds[1]);
    const foreign = await seedAccount(1);

    expect(
      (await mutation("/api/auth/passkeys/remove", operator.cookie, {
        credentialId: foreign.credentialIds[0],
      })).status,
    ).toBe(401);
    expect(
      await env.DB.prepare("SELECT credential_id FROM passkeys WHERE credential_id = ?")
        .bind(foreign.credentialIds[0])
        .first(),
    ).toEqual({ credential_id: foreign.credentialIds[0] });

    expect(
      (await mutation("/api/auth/passkeys/remove", operator.cookie, {
        credentialId: account.credentialIds[1],
      })).status,
    ).toBe(200);
    expect(await sessionState(operator.cookie)).toEqual({ authenticated: true });
    expect(await sessionState(target.cookie)).toEqual({ authenticated: false });
    expect(
      await env.DB.prepare("SELECT credential_id FROM passkeys WHERE credential_id = ?")
        .bind(account.credentialIds[1])
        .first(),
    ).toBeNull();

    expect(
      (await mutation("/api/auth/passkeys/remove", operator.cookie, {
        credentialId: account.credentialIds[0],
      })).status,
    ).toBe(401);
    expect(
      await env.DB.prepare("SELECT credential_id FROM passkeys WHERE credential_id = ?")
        .bind(account.credentialIds[0])
        .first(),
    ).toEqual({ credential_id: account.credentialIds[0] });
  });

  it("reports when removing the authenticating Passkey signs out its Session", async () => {
    const account = await seedAccount();
    const operator = await seedNormalSession(account, account.credentialIds[0]);
    const other = await seedNormalSession(account, account.credentialIds[1]);

    const response = await mutation("/api/auth/passkeys/remove", operator.cookie, {
      credentialId: account.credentialIds[0],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, signedOut: true });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await sessionState(operator.cookie)).toEqual({ authenticated: false });
    expect(await sessionState(other.cookie)).toEqual({ authenticated: true });
  });

  it("serializes competing removals so one Passkey recovery path remains", async () => {
    const account = await seedAccount();
    const first = await seedNormalSession(account, account.credentialIds[0]);
    const second = await seedNormalSession(account, account.credentialIds[1]);

    const [firstResult, secondResult] = await Promise.all([
      mutation("/api/auth/passkeys/remove", first.cookie, {
        credentialId: account.credentialIds[0],
      }),
      mutation("/api/auth/passkeys/remove", second.cookie, {
        credentialId: account.credentialIds[1],
      }),
    ]);
    expect([firstResult.status, secondResult.status].sort()).toEqual([200, 401]);
    const remaining = await env.DB
      .prepare("SELECT credential_id FROM passkeys WHERE account_id = ?")
      .bind(account.accountId)
      .all<{ credential_id: string }>();
    expect(remaining.results).toHaveLength(1);
  });
});
