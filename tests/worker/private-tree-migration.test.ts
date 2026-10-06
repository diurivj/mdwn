import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { expect, it } from "vitest";

it("adds File capabilities without rebuilding populated legacy ciphertext or relaxing pointer/immutability constraints", async () => {
  const split = env.TEST_MIGRATIONS.findIndex((migration) => migration.name.startsWith("0013_"));
  expect(split).toBeGreaterThan(0);
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, split));
  const id = (tail: string) => `019950d7-98c0-7000-8000-000000000${tail}`;
  const account = id("121"),
    root = id("122"),
    file = id("123"),
    representation = id("124"),
    contentKey = id("125");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, 'legacy-share', 1, 1)").bind(
      account,
    ),
    env.DB.prepare(
      "INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)",
    ).bind(account, root),
    env.DB.prepare(
      "INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at) VALUES (?, 'file', ?, ?, 1, 1)",
    ).bind(file, account, root),
    env.DB.prepare(
      "INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id, name_ciphertext, order_ciphertext, key_envelope) VALUES (?, ?, ?, X'0102', X'0304', X'0506')",
    ).bind(file, account, root),
    env.DB.prepare(
      "INSERT INTO files (node_id, owner_id, current_representation_id, current_revision) VALUES (?, ?, ?, 1)",
    ).bind(file, account, representation),
    env.DB.prepare(
      "INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id, key_epoch, ciphertext, ciphertext_size, created_at) VALUES (?, ?, ?, 1, ?, 1, X'070809', 3, 1)",
    ).bind(representation, file, account, contentKey),
  ]);
  const before = await env.DB.prepare(`SELECT f.current_representation_id, f.current_revision,
    hex(r.ciphertext) AS ciphertext, r.content_key_id, r.key_epoch, hex(e.key_envelope) AS parent_wrapper
    FROM files f JOIN file_representations r ON r.id = f.current_representation_id
    JOIN directory_entries e ON e.child_node_id = f.node_id WHERE f.node_id = ?`)
    .bind(file)
    .first();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(split));
  const after = await env.DB.prepare(`SELECT f.current_representation_id, f.current_revision,
    hex(r.ciphertext) AS ciphertext, r.content_key_id, r.key_epoch, hex(e.key_envelope) AS parent_wrapper,
    f.capability_id, f.capability_epoch, r.key_envelope, r.head_digest, r.head_signature, r.head_device_id
    FROM files f JOIN file_representations r ON r.id = f.current_representation_id
    JOIN directory_entries e ON e.child_node_id = f.node_id WHERE f.node_id = ?`)
    .bind(file)
    .first();
  expect(after).toEqual({
    ...before,
    capability_id: null,
    capability_epoch: null,
    key_envelope: null,
    head_digest: null,
    head_signature: null,
    head_device_id: null,
  });
  expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  const pointerConstraint = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'files'",
  ).first<{ sql: string }>();
  expect(pointerConstraint?.sql).toMatch(
    /current_representation_id.*,.*current_revision[\s\S]*REFERENCES[\s\S]*file_representations[\s\S]*DEFERRABLE INITIALLY DEFERRED/,
  );
  await expect(
    env.DB.prepare("UPDATE files SET capability_id = ? WHERE node_id = ?").bind(id("127"), file).run(),
  ).rejects.toThrow();
  await expect(
    env.DB.prepare("UPDATE file_representations SET ciphertext = X'010203' WHERE id = ?").bind(representation).run(),
  ).rejects.toThrow(/immutable/);
  await expect(
    env.DB.prepare("UPDATE file_representations SET key_envelope = X'01' WHERE id = ?").bind(representation).run(),
  ).rejects.toThrow();
});

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

it("backfills the exact hidden roots of Accounts created before the private-tree migration", async () => {
  const migrations = env.TEST_MIGRATIONS;
  const treeMigration = migrations.findIndex((migration) => migration.name.startsWith("0008_"));
  expect(treeMigration).toBeGreaterThan(0);
  await applyD1Migrations(env.DB, migrations.slice(0, treeMigration));
  const accountId = "019950d7-98c0-7000-8000-000000000114";
  const rootId = "019950d7-98c0-7000-8000-000000000115";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, 1, 1)").bind(
      accountId,
      "opaque-share-id",
    ),
    env.DB.prepare(
      "INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)",
    ).bind(accountId, rootId),
  ]);
  await applyD1Migrations(env.DB, migrations.slice(treeMigration));
  const roots = await env.DB.prepare(`SELECT n.id, n.kind, n.parent_node_id, d.entries_revision
    FROM vault_nodes n JOIN directories d ON d.node_id = n.id WHERE n.owner_id = ?`)
    .bind(accountId)
    .all();
  expect(roots.results).toEqual([{ id: rootId, kind: "directory", parent_node_id: null, entries_revision: 1 }]);
});
