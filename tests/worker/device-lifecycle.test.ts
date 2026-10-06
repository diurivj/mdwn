import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { signDeviceProof, sessionBindingDigest } from "../../app/shared/device/proof";
import { seedAccount, seedNormalSession, recoveryCookie, signedCookie } from "./auth-fixtures";

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

async function fixture() {
  const account = await seedAccount(1);
  const bound = await seedNormalSession(account);
  const unbound = await seedNormalSession(account);
  const assertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const deviceId = crypto.randomUUID();
  const rootId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)",
    ).bind(account.accountId, rootId),
    env.DB.prepare(
      "INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, ?, ?, 'active', 'signup', 1, ?)",
    ).bind(
      deviceId,
      account.accountId,
      new Uint8Array(65),
      new Uint8Array(await crypto.subtle.exportKey("raw", assertion.publicKey)),
      now,
    ),
    env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(deviceId, bound.id),
    env.DB.prepare(
      "INSERT INTO account_profiles (account_id, ciphertext, revision, epoch, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)",
    ).bind(account.accountId, Uint8Array.of(7), now, now),
    env.DB.prepare(
      "INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'vault-recovery', ?, ?, ?, 1)",
    ).bind(account.accountId, rootId, account.accountId, Uint8Array.of(1)),
    env.DB.prepare(
      "INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'device-enrollment', ?, ?, ?, 1)",
    ).bind(account.accountId, deviceId, deviceId, Uint8Array.of(2)),
    env.DB.prepare(
      "INSERT INTO recovery_capsules (account_id, generation, recovery_salt, ciphertext, verification_public_key) VALUES (?, 1, ?, ?, ?)",
    ).bind(account.accountId, Uint8Array.of(3), Uint8Array.of(4), Uint8Array.of(5)),
  ]);
  const url = "https://mdwn.test/api/private/bootstrap?b=2&a=1";
  async function sign(
    sessionId = bound.id,
    options: { epoch?: number; url?: string; method?: string; body?: string; now?: number } = {},
  ) {
    return signDeviceProof(assertion.privateKey, {
      sessionBinding: await sessionBindingDigest(sessionId),
      deviceId,
      registryEpoch: options.epoch ?? 1,
      method: options.method ?? "POST",
      url: options.url ?? url,
      body: options.body,
      now: options.now,
    });
  }
  const read = (cookie: string, candidate?: unknown, path = url, body?: string) =>
    SELF.fetch(path, {
      method: "POST",
      headers: {
        cookie,
        origin: "https://mdwn.test",
        ...(candidate === undefined ? {} : { "X-Mdwn-Device-Proof": JSON.stringify(candidate) }),
      },
      ...(body === undefined ? {} : { body }),
    });
  return { account, bound, unbound, deviceId, sign, read, url };
}

describe("private endpoint device lifecycle", () => {
  it("refuses every unprovisioned and recovery Session but leaves account-security accessible", async () => {
    const { account, unbound, deviceId, read, sign } = await fixture();
    const recovery = await recoveryCookie(account.accountId);
    expect((await read(unbound.cookie, await sign(unbound.id))).status).toBe(403);
    expect((await read(recovery, await sign())).status).toBe(403);
    expect((await read(await signedCookie(crypto.randomUUID()), await sign())).status).toBe(403);
    expect(
      (await SELF.fetch("https://mdwn.test/api/auth/sessions", { headers: { cookie: unbound.cookie } })).status,
    ).toBe(200);
    const state = await SELF.fetch("https://mdwn.test/api/device/state", { headers: { cookie: unbound.cookie } });
    expect(await state.json()).toMatchObject({ accountId: account.accountId, deviceId: null, registryEpoch: 1 });
    const candidate = await SELF.fetch(`https://mdwn.test/api/device/state?candidateDeviceId=${deviceId}`, {
      headers: { cookie: unbound.cookie },
    });
    expect(await candidate.json()).toMatchObject({ deviceId: null, candidateActive: true });
  });

  it("binds the entire request, never consumes a read proof, and exposes no ciphertext on invalid proof", async () => {
    const { account, bound, read, sign, url } = await fixture();
    const good = await sign();
    const bad: unknown[] = [
      undefined,
      { ...good, signature: "invalid" },
      { ...good, deviceId: crypto.randomUUID() },
      await sign(bound.id, { url: `${url}&changed=1` }),
      await sign(bound.id, { method: "GET" }),
      await sign(bound.id, { body: "changed" }),
      await sign(bound.id, { now: Date.now() - 300_001 }),
      await sign(crypto.randomUUID()),
    ];
    for (const candidate of bad) {
      const response = await read(bound.cookie, candidate);
      expect(response.status).toBe(403);
      expect(JSON.stringify(await response.json())).not.toContain("capsule");
    }
    const first = await read(bound.cookie, good);
    const second = await read(bound.cookie, good);
    expect(first.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM device_proof_uses WHERE account_id = ?")
        .bind(account.accountId)
        .first(),
    ).toEqual({ n: 0 });
    // The read endpoint has no request body; it must not silently ignore one.
    expect((await read(bound.cookie, good, url, "changed")).status).not.toBe(200);
  });

  it("advances the registry epoch on membership changes without invalidating non-target Sessions", async () => {
    const { account, bound, deviceId, sign, read } = await fixture();
    const otherId = crypto.randomUUID();
    const second = await seedNormalSession(account);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, ?, ?, 'active', 'routine', 2, ?)",
      ).bind(otherId, account.accountId, new Uint8Array(65), new Uint8Array(65), Date.now()),
      env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(otherId, second.id),
    ]);
    const epoch = async () =>
      (
        await env.DB.prepare("SELECT registry_epoch FROM account_encryption_identities WHERE account_id = ?")
          .bind(account.accountId)
          .first<{ registry_epoch: number }>()
      )?.registry_epoch;
    expect(await epoch()).toBe(2);
    expect((await read(bound.cookie, await sign())).status).toBe(403);
    expect((await read(bound.cookie, await sign(bound.id, { epoch: 2 }))).status).toBe(200);
    await env.DB.prepare("UPDATE encryption_devices SET state = 'tombstoned' WHERE id = ?").bind(otherId).run();
    expect(await epoch()).toBe(3);
    expect((await read(second.cookie)).status).toBe(403);
    expect((await read(bound.cookie, await sign(bound.id, { epoch: 2 }))).status).toBe(403);
    expect((await read(bound.cookie, await sign(bound.id, { epoch: 3 }))).status).toBe(200);
    expect(await env.DB.prepare("SELECT state FROM encryption_devices WHERE id = ?").bind(deviceId).first()).toEqual({
      state: "active",
    });
    await expect(
      env.DB.prepare("UPDATE encryption_devices SET state = 'active' WHERE id = ?").bind(otherId).run(),
    ).rejects.toThrow();
    await expect(env.DB.prepare("DELETE FROM encryption_devices WHERE id = ?").bind(otherId).run()).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE account_encryption_identities SET registry_epoch = 2 WHERE account_id = ?")
        .bind(account.accountId)
        .run(),
    ).rejects.toThrow();
  });

  it("rejects old epochs and inactive devices; another active Session works after epoch refresh", async () => {
    const { account, bound, deviceId, sign, read } = await fixture();
    const second = await seedNormalSession(account);
    await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(deviceId, second.id).run();
    const oldProof = await sign();
    await env.DB.prepare("UPDATE account_encryption_identities SET registry_epoch = 2 WHERE account_id = ?")
      .bind(account.accountId)
      .run(); // Simulates an atomic membership transition in later enrollment/removal tickets.
    expect((await read(bound.cookie, oldProof)).status).toBe(403);
    expect((await read(second.cookie, await sign(second.id))).status).toBe(403);
    const state = await SELF.fetch("https://mdwn.test/api/device/state", { headers: { cookie: second.cookie } });
    expect(await state.json()).toMatchObject({ accountId: account.accountId, deviceId, registryEpoch: 2 });
    expect((await read(second.cookie, await sign(second.id, { epoch: 2 }))).status).toBe(200);
    await env.DB.prepare("UPDATE encryption_devices SET state = 'tombstoned' WHERE id = ?").bind(deviceId).run();
    expect((await read(second.cookie, await sign(second.id, { epoch: 2 }))).status).toBe(403);
    const inactive = await SELF.fetch(`https://mdwn.test/api/device/state?candidateDeviceId=${deviceId}`, {
      headers: { cookie: second.cookie },
    });
    expect(await inactive.json()).toMatchObject({ deviceId: null, registryEpoch: 3, candidateActive: false });
  });
});
