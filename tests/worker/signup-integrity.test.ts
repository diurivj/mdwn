import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { signupRequest, validSignupSubmission } from "./signup-fixtures";

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
// Workerd storage is shared within this file: reset issuance quotas so every
// case reaches verification rather than being rejected by an earlier case's quota.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM rate_limit_counters").run();
});

describe("signup commit integrity", () => {
  it("commits an unaltered software registration with production crypto and a bound Session", async () => {
    const payload = await validSignupSubmission();
    const response = await signupRequest("verify", payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, sessionBinding: expect.any(String) });
    expect(response.headers.get("Set-Cookie")).not.toBeNull();
    const { accountId, deviceId, rootDirectoryId } = payload.transcript;
    expect(await env.DB.prepare("SELECT id FROM accounts").all()).toMatchObject({ results: [{ id: accountId }] });
    for (const [table, n] of Object.entries({
      account_profiles: 1, passkeys: 1, account_encryption_identities: 1, encryption_devices: 1,
      key_envelopes: 2, recovery_capsules: 1, authentication_recovery_codes: 10, sessions: 1,
    })) {
      expect(await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id = ?`)
        .bind(accountId).first(), table).toEqual({ n });
    }
    expect(await env.DB.prepare("SELECT root_directory_id, registry_epoch FROM account_encryption_identities WHERE account_id = ?")
      .bind(accountId).first()).toEqual({ root_directory_id: rootDirectoryId, registry_epoch: 1 });
    expect(await env.DB.prepare("SELECT purpose, device_id, authenticated_passkey_id FROM sessions WHERE account_id = ?")
      .bind(accountId).first()).toEqual({ purpose: "normal", device_id: deviceId, authenticated_passkey_id: payload.response.id });
    expect(await env.DB.prepare("SELECT id FROM webauthn_challenges WHERE id = ?").bind(payload.challengeId).first()).toBeNull();
    expect((await signupRequest("verify", payload)).status).toBe(400);
  }, 120_000);

  for (const scenario of ["candidate key", "capsule digest", "registration challenge", "binding signature", "transport proof", "honeypot"] as const) {
    it(`rejects altered ${scenario} without an Account or Session and consumes the challenge`, async () => {
      const accountsBefore = await env.DB.prepare("SELECT count(*) AS n FROM accounts").first();
      const sessionsBefore = await env.DB.prepare("SELECT count(*) AS n FROM sessions").first();
      const valid = await validSignupSubmission();
      const payload = structuredClone(valid);
      const alter = (value: string) => `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
      if (scenario === "candidate key") payload.transcript.transportPublicKey = alter(payload.transcript.transportPublicKey);
      if (scenario === "capsule digest") payload.transcript.capsuleDigest = alter(payload.transcript.capsuleDigest);
      if (scenario === "registration challenge") payload.transcript.registrationChallenge = alter(payload.transcript.registrationChallenge);
      if (scenario === "binding signature") payload.bindingSignature = "A".repeat(86);
      if (scenario === "transport proof") payload.transportProof = "A".repeat(43);
      if (scenario === "honeypot") payload.honeypot = "trap";

      const assertRejected = async (submission: typeof valid) => {
        const response = await signupRequest("verify", submission);
        expect(response.status).toBe(400);
        expect(response.headers.get("Set-Cookie")).toBeNull();
        expect(await env.DB.prepare("SELECT count(*) AS n FROM accounts").first()).toEqual(accountsBefore);
        expect(await env.DB.prepare("SELECT count(*) AS n FROM sessions").first()).toEqual(sessionsBefore);
        expect(await env.DB.prepare("SELECT id FROM accounts WHERE id = ?")
          .bind(valid.transcript.accountId).first()).toBeNull();
        expect(await env.DB.prepare("SELECT id FROM sessions WHERE account_id = ?")
          .bind(valid.transcript.accountId).first()).toBeNull();
        expect(await env.DB.prepare("SELECT id FROM webauthn_challenges WHERE id = ?")
          .bind(valid.challengeId).first()).toBeNull();
        expect(await env.DB.prepare("SELECT count(*) AS n FROM registration_challenges").first()).toEqual({ n: 0 });
      };
      await assertRejected(payload);
      await assertRejected(payload);
      // Restoring the original valid request must not revive the consumed ceremony.
      await assertRejected(valid);
    }, 120_000);
  }
});
