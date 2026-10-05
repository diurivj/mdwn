import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { QUERY_PLANS, assertQueryPlan, coveringProbeSql } from "../../scripts/lib/d1-query-plans.mjs";
import { createDb, sql } from "../../app/db/client.server";
import { accountAccessQuery } from "../../app/sharing/access.server";

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

  it("starts child-traversal indexes with parent_node_id and covers bounded subtree enumeration", async () => {
    for (const index of ["vault_nodes_parent_idx", "directory_entries_parent_idx"]) {
      const columns = await env.DB.prepare(`PRAGMA index_info(${index})`).all<{ name: string }>();
      expect(columns.results[0]?.name).toBe("parent_node_id");
    }
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN WITH RECURSIVE subtree(id) AS (
      SELECT ? UNION SELECT n.id FROM vault_nodes n JOIN subtree parent ON n.parent_node_id = parent.id
      WHERE n.import_id IS NULL OR EXISTS (SELECT 1 FROM import_commits c WHERE c.import_id = n.import_id)
      LIMIT 501) SELECT id FROM subtree`).bind("root").all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes("SEARCH n USING COVERING INDEX vault_nodes_parent_idx"))).toBe(true);
  });
});
