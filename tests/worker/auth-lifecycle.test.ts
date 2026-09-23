import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
  getActiveSession,
  revokeAllSessionsForActor,
  revokeSessionForActor,
  SESSION_ABSOLUTE_MS,
} from "../../app/auth/session.server";
import {
  mutation,
  seedAccount,
  seedNormalSession,
  sessionState,
  signedCookie,
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

describe("normal Session lifecycle routes", () => {
  it("refreshes explicitly and revokes individual or all Sessions through public routes", async () => {
    const account = await seedAccount(1);
    const current = await seedNormalSession(account);
    const other = await seedNormalSession(account);

    const refresh = await mutation("/api/auth/session/refresh", current.cookie);
    expect(refresh.status).toBe(200);
    expect(await refresh.json()).toEqual({ ok: true });

    const listed = await SELF.fetch("https://mdwn.test/api/auth/sessions", {
      headers: { cookie: current.cookie },
    });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      sessions: Array<{ id: string; current: boolean; refreshedAt: number | null }>;
    };
    expect(listedBody.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: current.id, current: true, refreshedAt: expect.any(Number) }),
        expect.objectContaining({ id: other.id, current: false }),
      ]),
    );

    const individual = await mutation("/api/auth/sessions/revoke", current.cookie, {
      sessionId: other.id,
    });
    expect(individual.status).toBe(200);
    expect(await individual.json()).toEqual({ ok: true, signedOut: false });
    expect(await sessionState(other.cookie)).toEqual({ authenticated: false });

    const repeated = await mutation("/api/auth/sessions/revoke", current.cookie, {
      sessionId: other.id,
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ ok: true, signedOut: false });
    expect(repeated.headers.get("set-cookie")).toBeNull();
    expect(await sessionState(current.cookie)).toEqual({ authenticated: true });

    const unknown = await mutation("/api/auth/sessions/revoke", current.cookie, {
      sessionId: crypto.randomUUID(),
    });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("set-cookie")).toBeNull();
    expect(await sessionState(current.cookie)).toEqual({ authenticated: true });

    const all = await mutation("/api/auth/sessions/revoke-all", current.cookie);
    expect(all.status).toBe(200);
    expect(all.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await sessionState(current.cookie)).toEqual({ authenticated: false });
  });

  it("clears the cookie only when the current Session itself is revoked", async () => {
    const account = await seedAccount(1);
    const current = await seedNormalSession(account);

    const response = await mutation("/api/auth/sessions/revoke", current.cookie, {
      sessionId: current.id,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, signedOut: true });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await sessionState(current.cookie)).toEqual({ authenticated: false });
  });

  it("rejects idle and absolute expiry through cookie-driven public session state", async () => {
    const account = await seedAccount();
    const idle = await seedNormalSession(account);
    const absolute = await seedNormalSession(account);
    const now = Date.now();

    await env.DB.batch([
      env.DB
        .prepare("UPDATE sessions SET idle_expires_at = ? WHERE id = ?")
        .bind(now - 1, idle.id),
      env.DB
        .prepare(
          `UPDATE sessions
           SET created_at = ?, idle_expires_at = ?, absolute_expires_at = ?
           WHERE id = ?`,
        )
        .bind(now - SESSION_ABSOLUTE_MS - 2, now - 1, now - 1, absolute.id),
    ]);

    expect(await sessionState(idle.cookie)).toEqual({ authenticated: false });
    expect(await sessionState(absolute.cookie)).toEqual({ authenticated: false });
  });

  it("refuses account-security actions from a restricted recovery Session", async () => {
    const account = await seedAccount();
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    await env.DB
      .prepare(
        `INSERT INTO sessions (
          id, account_id, purpose, authenticated_passkey_id, created_at,
          idle_expires_at, absolute_expires_at, fresh_asserted_at, refreshed_at, revoked_at
        ) VALUES (?, ?, 'recovery', NULL, ?, ?, ?, NULL, NULL, NULL)`,
      )
      .bind(sessionId, account.accountId, now, now + SESSION_ABSOLUTE_MS, now + SESSION_ABSOLUTE_MS)
      .run();
    const cookie = await signedCookie(sessionId);

    expect(await sessionState(cookie)).toEqual({ authenticated: true });
    for (const [path, body] of [
      ["/api/auth/session/refresh", {}],
      ["/api/auth/sessions/revoke", { sessionId }],
      ["/api/auth/sessions/revoke-all", {}],
    ] as const) {
      expect((await mutation(path, cookie, body)).status).toBe(403);
    }
    expect(
      (await SELF.fetch("https://mdwn.test/api/auth/sessions", { headers: { cookie } })).status,
    ).toBe(403);

    const row = await env.DB
      .prepare("SELECT revoked_at FROM sessions WHERE id = ?")
      .bind(sessionId)
      .first<{ revoked_at: number | null }>();
    expect(row).toEqual({ revoked_at: null });

    const signOut = await mutation("/api/auth/sign-out", cookie);
    expect(signOut.status).toBe(200);
    expect(await sessionState(cookie)).toEqual({ authenticated: false });
  });

  it("cannot resurrect a Session when its refresh races revocation", async () => {
    const account = await seedAccount();
    const operator = await seedNormalSession(account);
    const target = await seedNormalSession(account);

    const [refresh, revoke] = await Promise.all([
      mutation("/api/auth/session/refresh", target.cookie),
      mutation("/api/auth/sessions/revoke", operator.cookie, { sessionId: target.id }),
    ]);
    expect([200, 401]).toContain(refresh.status);
    expect(revoke.status).toBe(200);
    expect(await sessionState(target.cookie)).toEqual({ authenticated: false });

    const row = await env.DB
      .prepare("SELECT revoked_at FROM sessions WHERE id = ?")
      .bind(target.id)
      .first<{ revoked_at: number | null }>();
    expect(row?.revoked_at).toEqual(expect.any(Number));
  });

  it("does not let a revoked actor revoke peers, while a live actor revokes every Session", async () => {
    const account = await seedAccount();
    const staleActor = await seedNormalSession(account);
    const firstPeer = await seedNormalSession(account);
    const secondPeer = await seedNormalSession(account);
    const capturedActor = await getActiveSession(
      new Request("https://mdwn.test/account/security", { headers: { cookie: staleActor.cookie } }),
      env,
    );
    if (!capturedActor) throw new Error("expected an actor snapshot");

    await env.DB
      .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), staleActor.id)
      .run();

    expect(await revokeSessionForActor(env, capturedActor, firstPeer.id)).toBe("actor_inactive");
    expect(await revokeAllSessionsForActor(env, capturedActor)).toBe(false);
    expect(await sessionState(firstPeer.cookie)).toEqual({ authenticated: true });
    expect(await sessionState(secondPeer.cookie)).toEqual({ authenticated: true });

    const liveActor = await seedNormalSession(account);
    const capturedLiveActor = await getActiveSession(
      new Request("https://mdwn.test/account/security", { headers: { cookie: liveActor.cookie } }),
      env,
    );
    if (!capturedLiveActor) throw new Error("expected a live actor snapshot");

    expect(await revokeAllSessionsForActor(env, capturedLiveActor)).toBe(true);
    await expect(sessionState(liveActor.cookie)).resolves.toEqual({ authenticated: false });
    await expect(sessionState(firstPeer.cookie)).resolves.toEqual({ authenticated: false });
    await expect(sessionState(secondPeer.cookie)).resolves.toEqual({ authenticated: false });
  });
});
