import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { SessionConfigurationError } from "../../app/auth/session.server";
import { accountUserHandle, beginSignIn, completeSignIn } from "../../app/auth/webauthn.server";

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

describe("WebAuthn sign-in challenges", () => {
  it("binds a challenge to the request origin and consumes invalid same-origin attempts", async () => {
    const origin = "https://mdwn.test";
    const start = await beginSignIn(new Request(`${origin}/api/auth/sign-in/options`), env);

    await expect(
      completeSignIn(new Request("https://another-mdwn.test/api/auth/sign-in/verify"), env, start.challengeId, {}),
    ).resolves.toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM webauthn_challenges WHERE id = ?").bind(start.challengeId).first(),
    ).toEqual({ id: start.challengeId });

    await expect(
      completeSignIn(new Request(`${origin}/api/auth/sign-in/verify`), env, start.challengeId, {}),
    ).resolves.toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM webauthn_challenges WHERE id = ?").bind(start.challengeId).first(),
    ).toBeNull();
    await expect(
      completeSignIn(new Request(`${origin}/api/auth/sign-in/verify`), env, start.challengeId, {}),
    ).resolves.toBeNull();
  });

  it("fails before issuing challenge state when cookie signing is unavailable", async () => {
    const withoutSecret = {
      APP_ENV: "local",
      DB: env.DB,
      SESSION_COOKIE_SECRET: "",
    } as Env;
    await expect(
      beginSignIn(new Request("https://mdwn.test/api/auth/sign-in/options"), withoutSecret),
    ).rejects.toBeInstanceOf(SessionConfigurationError);
  });

  it("rejects an assertion whose user handle is not the passkey Account", async () => {
    const accountId = crypto.randomUUID();
    const credentialId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(
        accountId,
        crypto.randomUUID(),
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO passkeys (credential_id, account_id, public_key, counter,
            transports, device_type, backed_up, created_at, updated_at)
           VALUES (?, ?, ?, 0, '[]', 'singleDevice', 0, ?, ?)`,
      ).bind(credentialId, accountId, Uint8Array.of(1).buffer, now, now),
    ]);
    const request = new Request("https://mdwn.test/api/auth/sign-in/verify");
    const start = await beginSignIn(request, env);

    expect(accountUserHandle(accountId)).not.toBe("wrong-account-handle");
    await expect(
      completeSignIn(request, env, start.challengeId, {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: { userHandle: "wrong-account-handle" },
      }),
    ).resolves.toBeNull();
    expect(await env.DB.prepare("SELECT id FROM sessions WHERE account_id = ?").bind(accountId).first()).toBeNull();
  });
});
