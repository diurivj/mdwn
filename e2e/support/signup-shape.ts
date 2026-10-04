import { expect } from "../fixtures";

/** Both real signup and the seed must satisfy this independently specified shape. */
export async function expectSignupShape(db: D1Database, account: {
  accountId: string; deviceId: string; rootDirectoryId: string;
}) {
  const { accountId, deviceId, rootDirectoryId } = account;
  expect(await db.prepare("SELECT count(*) AS n FROM accounts WHERE id = ?")
    .bind(accountId).first()).toEqual({ n: 1 });
  for (const [table, expected] of Object.entries({
    account_profiles: 1, passkeys: 1, account_encryption_identities: 1,
    encryption_devices: 1, key_envelopes: 2, recovery_capsules: 1,
    authentication_recovery_codes: 10, sessions: 1, crypto_jobs: 0,
  })) {
    expect(await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id = ?`)
      .bind(accountId).first(), table).toEqual({ n: expected });
  }
  expect(await db.prepare("SELECT root_directory_id, registry_epoch FROM account_encryption_identities WHERE account_id = ?")
    .bind(accountId).first()).toEqual({ registry_epoch: 1, root_directory_id: rootDirectoryId });
  expect(await db.prepare("SELECT state, approval_provenance, registry_epoch FROM encryption_devices WHERE id = ?")
    .bind(deviceId).first()).toEqual({ state: "active", approval_provenance: "signup", registry_epoch: 1 });
  expect(await db.prepare("SELECT purpose, device_id, authenticated_passkey_id FROM sessions WHERE account_id = ?")
    .bind(accountId).first()).toEqual({ purpose: "normal", device_id: deviceId, authenticated_passkey_id: expect.any(String) });
}
