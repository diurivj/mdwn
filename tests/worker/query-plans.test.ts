import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { QUERY_PLANS, assertQueryPlan, coveringProbeSql } from "../../scripts/lib/d1-query-plans.mjs";
import { createDb, sql } from "../../app/db/client.server";
import { accountAccessQuery } from "../../app/sharing/access.server";
import { seedAccount } from "./auth-fixtures";

declare global {
  namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[]; } }
}

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

describe("migrated D1 operational access paths", () => {
  it("uses reviewed covering indexes for every representative authority and current-state hot path", async () => {
    const failures: string[] = [];
    for (const query of QUERY_PLANS) {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all<{ detail: string }>();
      try {
        assertQueryPlan(query, plan.results, false);
        const probe = query.probeFrom
          ? await env.DB.prepare(`EXPLAIN QUERY PLAN ${coveringProbeSql(query)}`).all<{ detail: string }>()
          : plan;
        assertQueryPlan(query, probe.results);
      } catch (error) { failures.push(String(error)); }
    }
    expect(failures).toEqual([]);
    // Also compile the production access builder itself, not just its reviewed
    // representative SQL, so a recursive-query regression cannot hide here.
    const actual = await createDb(env.DB).all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${accountAccessQuery("recipient", "file")}`);
    expect(actual.some((row) => row.detail.includes("SEARCH g USING COVERING INDEX grants_recipient_target_idx"))).toBe(true);
  });

  it("limits a 2,000-child tree to 501 candidate visits and refuses partial deletion", async () => {
    const account = await seedAccount();
    const root = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)")
      .bind(account.accountId, root).run();
    const children = JSON.stringify(Array.from({ length: 2000 }, () => crypto.randomUUID()));
    await env.DB.batch([
      env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
      env.DB.prepare(`INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at)
        SELECT value, 'file', ?, ?, 1700000000000, 1700000000000 FROM json_each(?)`).bind(account.accountId, root, children),
      env.DB.prepare(`INSERT INTO files (node_id, owner_id, current_representation_id, current_revision)
        SELECT value, ?, value || '-representation', 1 FROM json_each(?)`).bind(account.accountId, children),
      env.DB.prepare(`INSERT INTO file_representations
        (id, file_node_id, owner_id, revision, content_key_id, key_epoch, ciphertext, ciphertext_size, created_at)
        SELECT value || '-representation', value, ?, 1, 'key', 1, X'01', 1, 1700000000000 FROM json_each(?)`).bind(account.accountId, children),
      env.DB.prepare(`INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id, name_ciphertext, order_ciphertext, key_envelope)
        SELECT value, ?, ?, X'01', X'02', X'03' FROM json_each(?)`).bind(account.accountId, root, children),
    ]);
    const query = QUERY_PLANS.find((query) => query.name === "bounded subtree deletion enumeration")!;
    const rows = await env.DB.prepare(query.sql.replaceAll("'root'", `'${root}'`))
      .all<{ id: string; visited: number; steps: number; overflow: number }>();
    expect(rows.results).toHaveLength(501);
    expect(rows.results[0]).toMatchObject({ visited: 501, steps: 1000, overflow: 1 });
    const eligible = await env.DB.prepare(`SELECT count(*) AS n FROM (${query.sql.replaceAll("'root'", `'${root}'`)}) WHERE overflow = 0`)
      .first<{ n: number }>();
    expect(eligible?.n).toBe(0);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM vault_nodes WHERE parent_node_id = ?").bind(root).first<{ n: number }>())?.n).toBe(2000);
  });

  it("starts child-traversal indexes with parent_node_id and covers bounded subtree enumeration", async () => {
    for (const index of ["vault_nodes_parent_idx", "directory_entries_parent_idx"]) {
      const columns = await env.DB.prepare(`PRAGMA index_info(${index})`).all<{ name: string }>();
      expect(columns.results[0]?.name).toBe("parent_node_id");
    }
    const query = QUERY_PLANS.find((query) => query.name === "bounded subtree deletion enumeration")!;
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes("SEARCH child USING COVERING INDEX vault_nodes_parent_idx"))).toBe(true);
  });
});
