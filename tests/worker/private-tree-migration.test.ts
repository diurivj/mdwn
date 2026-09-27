import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { expect, it } from "vitest";

declare global {
  namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } }
}

it("backfills the exact hidden roots of Accounts created before the private-tree migration", async () => {
  const migrations = env.TEST_MIGRATIONS;
  await applyD1Migrations(env.DB, migrations.slice(0, -1));
  const accountId = "019950d7-98c0-7000-8000-000000000114";
  const rootId = "019950d7-98c0-7000-8000-000000000115";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, 1, 1)")
      .bind(accountId, "opaque-share-id"),
    env.DB.prepare("INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)")
      .bind(accountId, rootId),
  ]);
  await applyD1Migrations(env.DB, migrations.slice(-1));
  const roots = await env.DB.prepare(`SELECT n.id, n.kind, n.parent_node_id, d.entries_revision
    FROM vault_nodes n JOIN directories d ON d.node_id = n.id WHERE n.owner_id = ?`)
    .bind(accountId).all();
  expect(roots.results).toEqual([{ id: rootId, kind: "directory", parent_node_id: null, entries_revision: 1 }]);
});
