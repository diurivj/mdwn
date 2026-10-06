import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { prepareRecoveryCodeSet } from "../../app/shared/auth/recovery-codes";
import { decodeBytes } from "../../app/shared/signup/protocol";
import { mutation, seedNormalSession, sessionState } from "./auth-fixtures";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      SESSION_COOKIE_SECRET: string;
      ABUSE_HMAC_SECRET: string;
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

function recoveryIdentifier(): string {
  const randomId = crypto.randomUUID();
  return `${randomId.slice(0, 14)}7${randomId.slice(15)}`;
}

async function recoveryAccount() {
  const identifier = recoveryIdentifier();
  const credentialId = crypto.randomUUID();
  const { codes, hashes } = await prepareRecoveryCodeSet();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(
      identifier,
      crypto.randomUUID(),
      now,
      now,
    ),
    env.DB.prepare(`INSERT INTO passkeys
      (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at)
      VALUES (?, ?, ?, 0, '[]', 'singleDevice', 0, ?, ?)`).bind(credentialId, identifier, Uint8Array.of(1), now, now),
    ...hashes.map((hash, ordinal) =>
      env.DB.prepare(
        "INSERT INTO authentication_recovery_codes (account_id, ordinal, code_hash) VALUES (?, ?, ?)",
      ).bind(identifier, ordinal, decodeBytes(hash, 32)),
    ),
  ]);
  return { identifier, accountId: identifier, credentialIds: [credentialId], codes, hashes };
}

function attempt(identifier: unknown, code: unknown, ip: string, cookie = "") {
  return SELF.fetch("https://mdwn.test/api/auth/recovery/start", {
    method: "POST",
    headers: { origin: "https://mdwn.test", "Content-Type": "application/json", "CF-Connecting-IP": ip, cookie },
    body: JSON.stringify({ identifier, code }),
  });
}

function recoveryRequest(path: string, cookie: string, body: object = {}) {
  return mutation(`/api/auth/recovery/${path}`, cookie, body);
}

function cookie(response: Response): string {
  return response.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";
}

describe("authentication recovery routes", () => {
  it("spends one code for a five-minute restricted Session, leaving other codes available", async () => {
    const account = await recoveryAccount();
    const existing = await seedNormalSession(account);
    const first = await attempt(account.identifier, account.codes[0], "203.0.113.81");
    expect(first.status).toBe(200);
    const restricted = cookie(first);
    expect(restricted).toContain("__Host-mdwn_session=");
    const status = await SELF.fetch("https://mdwn.test/api/auth/recovery/status", {
      headers: { cookie: restricted },
    });
    expect(await status.json()).toEqual({ restricted: true });
    expect(await sessionState(restricted)).toEqual({ authenticated: true });
    expect((await recoveryRequest("options", restricted)).status).toBe(200);
    expect(
      (
        await SELF.fetch("https://mdwn.test/api/auth/sessions", {
          headers: { cookie: restricted },
        })
      ).status,
    ).toBe(403);
    expect((await recoveryRequest("rotate", restricted, { hashes: account.hashes })).status).toBe(403);
    expect(
      (await mutation("/api/auth/passkeys/remove", restricted, { credentialId: account.credentialIds[0] })).status,
    ).toBe(403);
    expect(await sessionState(existing.cookie)).toEqual({ authenticated: true });
    expect((await attempt(account.identifier, account.codes[0], "203.0.113.82")).status).toBe(401);
    const second = await attempt(account.identifier, account.codes[1], "203.0.113.83");
    expect(second.status).toBe(200);
    expect(await sessionState(cookie(second))).toEqual({ authenticated: true });
  });

  it("consumes a code only once when two recovery starts race", async () => {
    const account = await recoveryAccount();
    const results = await Promise.all([
      attempt(account.identifier, account.codes[0], "203.0.113.84"),
      attempt(account.identifier, account.codes[0], "203.0.113.85"),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 401]);
    const granted = results.find((response) => response.status === 200)!;
    expect(await sessionState(cookie(granted))).toEqual({ authenticated: true });
    expect(results.find((response) => response.status === 401)!.headers.get("Set-Cookie")).toBeNull();
  });

  it("makes unknown Accounts, wrong and spent codes indistinguishable and applies recovery quotas", async () => {
    const account = await recoveryAccount();
    const unknown = recoveryIdentifier();
    const wrong = await attempt(account.identifier, account.codes[1], "203.0.113.91");
    // The code belongs to this Account: it should succeed, then be spent.
    expect(wrong.status).toBe(200);
    const spent = await attempt(account.identifier, account.codes[1], "203.0.113.92");
    const missing = await attempt(unknown, account.codes[1], "203.0.113.93");
    const incorrect = await attempt(account.identifier, account.codes[2].slice(1) + "A", "203.0.113.94");
    for (const response of [spent, missing, incorrect]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "recovery_failed" });
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    // An identifier cap is enforced even when requests come from new networks.
    const limited = await attempt(account.identifier, account.codes[0], "203.0.113.95");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(limited.headers.get("Set-Cookie")).toBeNull();
    expect((await attempt(unknown, account.codes[0], "203.0.113.96")).status).toBe(401);
    expect((await attempt(unknown, account.codes[0], "203.0.113.97")).status).toBe(401);
    const unknownLimited = await attempt(unknown, account.codes[0], "203.0.113.98");
    expect(unknownLimited.status).toBe(429);
    expect(await unknownLimited.json()).toEqual({ error: "rate_limited" });
    for (let n = 0; n < 3; n++) {
      expect((await attempt(recoveryIdentifier(), account.codes[0], "203.0.113.99")).status).toBe(401);
    }
    const networkLimited = await attempt(recoveryIdentifier(), account.codes[0], "203.0.113.99");
    expect(networkLimited.status).toBe(429);
    expect(await networkLimited.json()).toEqual({ error: "rate_limited" });
  });

  it("replaces the whole code set only after a fresh normal Passkey assertion", async () => {
    const account = await recoveryAccount();
    const actor = await seedNormalSession(account);
    const replacement = await prepareRecoveryCodeSet();
    expect((await recoveryRequest("rotate", "", { hashes: replacement.hashes })).status).toBe(403);
    await env.DB.prepare("UPDATE sessions SET fresh_asserted_at = NULL WHERE id = ?").bind(actor.id).run();
    expect((await recoveryRequest("rotate", actor.cookie, { hashes: replacement.hashes })).status).toBe(401);
    await env.DB.prepare("UPDATE sessions SET fresh_asserted_at = ? WHERE id = ?").bind(Date.now(), actor.id).run();
    expect((await recoveryRequest("rotate", actor.cookie, { hashes: replacement.hashes })).status).toBe(200);
    for (const [index, ip] of ["203.0.113.111", "203.0.113.112"].entries()) {
      expect((await attempt(account.identifier, account.codes[index], ip)).status).toBe(401);
    }
    const fresh = await attempt(account.identifier, replacement.codes[0], "203.0.113.113");
    expect(fresh.status).toBe(200);
    expect(await sessionState(cookie(fresh))).toEqual({ authenticated: true });
  });

  it("expires restricted Sessions independently of the cookie and offers no credential-free bypass", async () => {
    const account = await recoveryAccount();
    const start = await attempt(account.identifier, account.codes[0], "203.0.113.121");
    expect(start.status).toBe(200);
    const restricted = cookie(start);
    expect((await recoveryRequest("verify", restricted, { challengeId: "guess", response: {} })).status).toBe(401);
    const otherAccount = recoveryIdentifier();
    expect((await attempt(otherAccount, account.codes[0], "203.0.113.122")).status).toBe(401);
    const sessionId = (
      await env.DB.prepare("SELECT id FROM sessions WHERE account_id = ? AND purpose = 'recovery'")
        .bind(account.identifier)
        .first<{ id: string }>()
    )?.id;
    expect(sessionId).toBeDefined();
    await env.DB.prepare("UPDATE sessions SET created_at = ?, idle_expires_at = ? WHERE id = ?")
      .bind(Date.now() - 5 * 60_000 - 1, Date.now() + 60_000, sessionId)
      .run();
    expect(await sessionState(restricted)).toEqual({ authenticated: false });
    expect((await recoveryRequest("options", restricted)).status).toBe(403);
    expect((await recoveryRequest("verify", restricted, { challengeId: "guess", response: {} })).status).toBe(403);
    expect((await recoveryRequest("rotate", restricted, { hashes: account.hashes })).status).toBe(403);
    expect(
      (await SELF.fetch("https://mdwn.test/api/private/bootstrap", { method: "POST", headers: { cookie: restricted } }))
        .status,
    ).toBe(403);
  });

  it("has no recovery route when every Passkey and code is lost", async () => {
    const account = await recoveryAccount();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM authentication_recovery_codes WHERE account_id = ?").bind(account.identifier),
      env.DB.prepare("DELETE FROM passkeys WHERE account_id = ?").bind(account.identifier),
    ]);
    const denied = await attempt(account.identifier, account.codes[0], "203.0.113.131");
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "recovery_failed" });
    expect(denied.headers.get("Set-Cookie")).toBeNull();
    expect((await recoveryRequest("options", "")).status).toBe(403);
    expect((await recoveryRequest("verify", "", { challengeId: "guess", response: {} })).status).toBe(403);
    expect((await mutation("/api/auth/passkeys/registration/options", "")).status).toBe(401);
    expect((await SELF.fetch("https://mdwn.test/api/auth/recovery/identifier")).status).toBe(401);
  });
});
