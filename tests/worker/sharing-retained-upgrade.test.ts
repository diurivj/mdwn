import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { expect, it } from "vitest";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }

it("upgrades populated pre-0014 retained material with enforced RESTRICT FKs and intact ciphertext", async () => {
  const migrations = env.TEST_MIGRATIONS;
  await applyD1Migrations(env.DB, migrations.slice(0, 14)); // through 0013
  const [owner, recipient, ownerRoot, recipientRoot, device, grant] = Array.from({ length: 6 }, () => {
    const value = crypto.randomUUID();
    return `${value.slice(0, 14)}7${value.slice(15)}`;
  });
  for (const [accountId, rootId] of [[owner, ownerRoot], [recipient, recipientRoot]]) {
    await env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, 1, 1)")
      .bind(accountId, `share-${accountId}`).run();
    await env.DB.prepare("INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)")
      .bind(accountId, rootId).run();
  }
  await env.DB.prepare(`INSERT INTO encryption_devices (id, account_id, transport_public_key,
    assertion_public_key, state, approval_provenance, registry_epoch, created_at)
    VALUES (?, ?, X'01', X'02', 'active', 'signup', 1, 1)`).bind(device, recipient).run();
  await env.DB.prepare(`INSERT INTO grants (id, owner_id, recipient_id, target_node_id, target_kind,
    permission, generation, created_at, updated_at) VALUES (?, ?, ?, ?, 'directory', 'read_only', 1, 1, 1)`)
    .bind(grant, owner, recipient, ownerRoot).run();
  const ciphertext = new Uint8Array([2, 7, 11, 19]);
  const digest = new Uint8Array(32).fill(0xa5);
  await env.DB.prepare(`INSERT INTO grant_retained_material (grant_id, device_id, registry_epoch,
    content_key_id, content_epoch, revision, ciphertext, digest) VALUES (?, ?, 1, 'legacy-key', 1, 1, ?, ?)`)
    .bind(grant, device, ciphertext, digest).run();
  expect(await env.DB.prepare("PRAGMA foreign_keys").first()).toEqual({ foreign_keys: 1 });
  expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

  await applyD1Migrations(env.DB, migrations.slice(14, 15)); // actual 0014 on populated D1
  expect(await env.DB.prepare("PRAGMA foreign_keys").first()).toEqual({ foreign_keys: 1 });
  expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  const retained = await env.DB.prepare(`SELECT grant_id, device_id, registry_epoch, content_key_id,
    content_epoch, revision, hex(ciphertext) AS ciphertext, hex(digest) AS digest,
    public_key_digest FROM grant_retained_material`).first();
  expect(retained).toEqual({ grant_id: grant, device_id: device, registry_epoch: 1,
    content_key_id: "legacy-key", content_epoch: 1, revision: 1,
    ciphertext: "02070B13", digest: "A5".repeat(32), public_key_digest: null });
  await expect(env.DB.prepare(`INSERT INTO grant_retained_material (grant_id, device_id,
    registry_epoch, content_key_id, content_epoch, revision, ciphertext, digest)
    VALUES ('missing-grant', ?, 1, 'legacy-key', 1, 1, X'01', zeroblob(32))`)
    .bind(device).run()).rejects.toThrow(/FOREIGN KEY constraint failed/i);
  await expect(env.DB.prepare("DELETE FROM grants WHERE id = ?").bind(grant).run())
    .rejects.toThrow(/FOREIGN KEY constraint failed/i);
  expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  await applyD1Migrations(env.DB, migrations.slice(15)); // subsequent migrations still apply
  expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});
