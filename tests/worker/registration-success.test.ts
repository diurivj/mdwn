import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { prepareRegistrationSuccess } from "../../app/shared/security/registration-success.server";
import { atomicSqlBatch, sql } from "../../app/shared/db/client.server";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      ABUSE_HMAC_SECRET: string;
    }
  }
}
beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const request = new Request("https://mdwn.test/api/signup/verify", {
  method: "POST",
  headers: { "CF-Connecting-IP": "203.0.113.50" },
});
const count = async () =>
  (
    await env.DB.prepare(
      "SELECT COALESCE(SUM(count), 0) AS n FROM rate_limit_counters WHERE purpose='registration.success'",
    ).first<{ n: number }>()
  )?.n;

async function signup(id: string, invalid = false) {
  const now = Date.now();
  const quota = await prepareRegistrationSuccess(env.DB, request, env.ABUSE_HMAC_SECRET, now);
  if (!quota.initialDecision.allowed) return quota.initialDecision;
  if (!quota.statements) throw new Error("allowed quota must have reservations");
  await atomicSqlBatch(env.DB, [
    ...quota.statements,
    sql`INSERT INTO accounts (id, share_id, created_at, updated_at)
      SELECT ${id}, ${id}, ${now}, ${now} WHERE changes()=1`,
    sql`INSERT INTO account_profiles (account_id, ciphertext, revision, epoch, created_at, updated_at)
      VALUES (${invalid ? "missing-account" : id}, ${new Uint8Array([1])}, 1, 1, ${now}, ${now})`,
  ]);
  return { allowed: true } as const;
}

describe("successful registration quota in the Account transaction", () => {
  it("rolls reservations back with a failed Account and counts only committed signups", async () => {
    expect(await count()).toBe(0);
    await expect(signup(crypto.randomUUID(), true)).rejects.toThrow();
    expect(await count()).toBe(0);
    expect(await signup(crypto.randomUUID())).toEqual({ allowed: true });
    expect(await signup(crypto.randomUUID())).toEqual({ allowed: true });
    expect(await count()).toBe(4); // global and Network reservations for two Accounts
    const denied = await signup(crypto.randomUUID());
    expect(denied).toMatchObject({ allowed: false, retryAfterSeconds: expect.any(Number) });
    expect(await count()).toBe(4);
  });
});
