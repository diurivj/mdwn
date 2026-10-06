import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function account(): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, 1, 1)")
    .bind(id, crypto.randomUUID())
    .run();
  return id;
}

describe("migrated authentication schema", () => {
  it("stores profile ciphertext as a BLOB, rejects invalid versions/orphans, and restricts Account deletion", async () => {
    const id = await account();
    const insert = (owner: string, revision: number, epoch: number) =>
      env.DB.prepare(
        "INSERT INTO account_profiles (account_id, ciphertext, revision, epoch, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)",
      )
        .bind(owner, Uint8Array.of(1, 2, 3).buffer, revision, epoch)
        .run();
    await expect(insert(crypto.randomUUID(), 1, 1)).rejects.toThrow(/FOREIGN KEY/);
    await expect(insert(id, 0, 1)).rejects.toThrow(/CHECK constraint/);
    await expect(insert(id, 1, 0)).rejects.toThrow(/CHECK constraint/);
    await insert(id, 1, 1);
    expect(
      await env.DB.prepare(
        "SELECT typeof(ciphertext) AS storage_type, revision, epoch FROM account_profiles WHERE account_id = ?",
      )
        .bind(id)
        .first(),
    ).toEqual({ storage_type: "blob", revision: 1, epoch: 1 });
    await expect(env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(id).run()).rejects.toThrow(/FOREIGN KEY/);
  });

  it("rejects invalid passkey and Session state at the database boundary", async () => {
    const id = await account();
    const passkey = (counter: number, deviceType: string) =>
      env.DB.prepare(
        `INSERT INTO passkeys (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', ?, 0, 1, 1)`,
      )
        .bind(crypto.randomUUID(), id, Uint8Array.of(1).buffer, counter, deviceType)
        .run();
    await expect(passkey(-1, "singleDevice")).rejects.toThrow(/CHECK constraint/);
    await expect(passkey(0, "unknown")).rejects.toThrow(/CHECK constraint/);
    await passkey(0, "multiDevice");

    const session = (purpose: string, idle: number, absolute: number) =>
      env.DB.prepare(
        `INSERT INTO sessions (id, account_id, purpose, created_at, idle_expires_at, absolute_expires_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
      )
        .bind(crypto.randomUUID(), id, purpose, idle, absolute)
        .run();
    await expect(session("unknown", 2, 3)).rejects.toThrow(/CHECK constraint/);
    await expect(session("normal", 1, 1)).rejects.toThrow(/CHECK constraint/);
    await expect(session("normal", 4, 3)).rejects.toThrow(/CHECK constraint/);
    await session("recovery", 2, 3);
    await expect(env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(id).run()).rejects.toThrow(/FOREIGN KEY/);
  });

  it("enforces challenge uniqueness, purpose, expiry, and Session foreign keys", async () => {
    const id = await account();
    const sessionId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO sessions (id, account_id, purpose, created_at, idle_expires_at, absolute_expires_at)
       VALUES (?, ?, 'normal', 1, 2, 3)`,
    )
      .bind(sessionId, id)
      .run();
    const challenge = (value: string, purpose: string, expiry: number, session: string | null) =>
      env.DB.prepare(
        `INSERT INTO webauthn_challenges (id, challenge, purpose, account_id, session_id, origin, rp_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'https://mdwn.test', 'mdwn.test', ?, 1)`,
      )
        .bind(crypto.randomUUID(), value, purpose, id, session, expiry)
        .run();
    await expect(challenge(crypto.randomUUID(), "unknown", 2, null)).rejects.toThrow(/CHECK constraint/);
    // The lifetime trigger now rejects this before the table's expiry CHECK.
    await expect(challenge(crypto.randomUUID(), "sign_in", 1, null)).rejects.toThrow(/SQLITE_CONSTRAINT/);
    await expect(challenge(crypto.randomUUID(), "fresh_assertion", 2, crypto.randomUUID())).rejects.toThrow(
      /FOREIGN KEY/,
    );
    const value = crypto.randomUUID();
    await challenge(value, "fresh_assertion", 2, sessionId);
    await expect(challenge(value, "fresh_assertion", 2, sessionId)).rejects.toThrow(/UNIQUE constraint/);
    await expect(env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run()).rejects.toThrow(
      /FOREIGN KEY/,
    );
  });
});
