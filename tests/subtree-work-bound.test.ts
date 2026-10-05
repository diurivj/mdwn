import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { QUERY_PLANS } from "../scripts/lib/d1-query-plans.mjs";

// Supplemental query-engine measurement at the agreed storage seam. Workerd
// separately executes this exact production SQL against migrated real D1.
// A counted expression observes candidate generation, not merely returned rows.
it("probes only 500 successor children in a migrated 2,000-child tree", () => {
  // D1's SQLite accepts double-quoted string literals in legacy generated DDL.
  const db = new DatabaseSync(":memory:", { enableDoubleQuotedStringLiterals: true });
  try {
    for (const file of readdirSync("drizzle").filter((file) => file.endsWith(".sql")).sort()) {
      db.exec(readFileSync(`drizzle/${file}`, "utf8"));
    }
    db.exec(`PRAGMA foreign_keys = ON; BEGIN; PRAGMA defer_foreign_keys = ON;
      INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES ('account', 'share', 1, 1);
      INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES ('account', 'root', 1);`);
    const node = db.prepare("INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at) VALUES (?, 'file', 'account', 'root', 1, 1)");
    const file = db.prepare("INSERT INTO files (node_id, owner_id, current_representation_id, current_revision) VALUES (?, 'account', ?, 1)");
    const representation = db.prepare(`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id, key_epoch, ciphertext, ciphertext_size, created_at)
      VALUES (?, ?, 'account', 1, 'key', 1, X'01', 1, 1)`);
    const edge = db.prepare("INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id, name_ciphertext, order_ciphertext, key_envelope) VALUES (?, 'account', 'root', X'01', X'02', X'03')");
    for (let index = 0; index < 2000; index++) {
      const id = `child-${String(index).padStart(4, "0")}`;
      node.run(id); file.run(id, `${id}-representation`); representation.run(`${id}-representation`, id); edge.run(id);
    }
    db.exec("COMMIT");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    let successorProbes = 0;
    db.function("counted", (value) => { successorProbes++; return value; });
    const query = QUERY_PLANS.find((query) => query.name === "bounded subtree deletion enumeration")!;
    // Fail loudly if a refactor changes the instrumentation point; never accept
    // a zero-call measurement as proof of bounded work.
    expect(query.sql).toContain("SELECT child.id FROM");
    const measured = query.sql.replace("SELECT child.id FROM", "SELECT counted(child.id) FROM");
    const rows = db.prepare(measured).all();
    expect(successorProbes).toBe(500);
    expect(rows).toHaveLength(501);
    expect(rows[0]).toMatchObject({ visited: 501, steps: 1000, overflow: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM vault_nodes WHERE parent_node_id = 'root'").get())
      .toMatchObject({ n: 2000 });
  } finally { db.close(); }
});
