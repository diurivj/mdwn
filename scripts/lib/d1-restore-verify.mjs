/**
 * D1 export-restore verification: content digests, schema inventory, current
 * pointer invariants, trigger/constraint behavior probes, the reviewed plan
 * gate, and the read-only target verification. Kept separate from planning so
 * each module changes for one reason.
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { QUERY_PLANS, assertQueryPlan, coveringProbeSql } from "./d1-query-plans.mjs";
import { splitStatements } from "./sql-dump.mjs";

/** @param {string} text */
function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** @param {string} identifier */
function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Rows fetched per digest page. Small enough that a page of max-size
 * ciphertext rows stays well inside the process output buffer. */
export const DIGEST_PAGE_ROWS = 20;
const DIGEST_MASK = (1n << 256n) - 1n;

/** Per-table order-independent multiset digest of `quote()`d row values.
 * `quote()` runs inside SQLite, so integers and BLOBs never lose precision
 * through a JSON transport. The digest is a sum of per-row SHA-256 values.
 * @param {DatabaseSync} db @param {{name: string, columns: string[]}[]} tables
 */
export function tableDigests(db, tables) {
  return runnerDigests(createSqliteRunner(db), tables);
}

/** Rows returned by the first statement of a runner call.
 * @param {{ run: (sql: string) => Array<{ results: Record<string, unknown>[] }> }} runner @param {string} sql
 */
export function queryRows(runner, sql) {
  return runner.run(sql)[0]?.results ?? [];
}

/** Paged order-independent digest of every table through a runner, so the
 * offline and target paths share exactly one implementation.
 * @param {{ run: (sql: string) => Array<{ results: Record<string, unknown>[] }> }} runner
 * @param {{ name: string, columns: string[] }[]} tables
 * @returns {Map<string, { count: number, digest: string }>}
 */
export function runnerDigests(runner, tables) {
  /** @type {Map<string, { count: number, digest: string }>} */
  const digests = new Map();
  for (const table of tables) {
    if (table.columns.length === 0) {
      digests.set(table.name, { count: 0, digest: "0".repeat(64) });
      continue;
    }
    const expression = table.columns.map((column) => `quote(${quoteIdentifier(column)})`).join(" || '|' || ");
    let lastRowid = -1;
    let count = 0;
    let sum = 0n;
    for (;;) {
      const rows = queryRows(
        runner,
        `SELECT rowid AS __rowid, ${expression} AS __value FROM ${quoteIdentifier(table.name)}
         WHERE rowid > ${lastRowid} ORDER BY rowid LIMIT ${DIGEST_PAGE_ROWS};`,
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        sum = (sum + BigInt(`0x${createHash("sha256").update(String(row.__value), "utf8").digest("hex")}`)) & DIGEST_MASK;
        count += 1;
      }
      lastRowid = Number(rows[rows.length - 1].__rowid);
      if (rows.length < DIGEST_PAGE_ROWS) break;
    }
    digests.set(table.name, { count, digest: sum.toString(16).padStart(64, "0") });
  }
  return digests;
}

/** Inventory of every non-internal schema object, keyed by type/name. */
/** @param {DatabaseSync} db @returns {{ type: string, name: string, sha256: string }[]} */
export function schemaInventory(db) {
  const rows = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_schema
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
       ORDER BY type, name`,
    )
    .all();
  return rows.map((row) => ({ type: String(row.type), name: String(row.name), sha256: sha256Hex(String(row.sql)) }));
}

/** Data-dependent current-pointer invariants that must hold after a restore. */
export const CURRENT_POINTER_CHECKS = [
  {
    name: "files.current_representation_id",
    requires: ["files", "file_representations"],
    sql: `SELECT count(*) AS broken FROM files f WHERE NOT EXISTS (
      SELECT 1 FROM file_representations r WHERE r.id = f.current_representation_id
        AND r.file_node_id = f.node_id AND r.owner_id = f.owner_id)`,
  },
  {
    name: "account_encryption_identities.root_directory_id",
    requires: ["account_encryption_identities", "vault_nodes"],
    sql: `SELECT count(*) AS broken FROM account_encryption_identities i WHERE NOT EXISTS (
      SELECT 1 FROM vault_nodes n WHERE n.id = i.root_directory_id
        AND n.owner_id = i.account_id AND n.parent_node_id IS NULL AND n.kind = 'directory')`,
  },
  {
    name: "directories.listing_device_id",
    requires: ["directories", "encryption_devices"],
    sql: `SELECT count(*) AS broken FROM directories d WHERE d.listing_device_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM encryption_devices e WHERE e.id = d.listing_device_id AND e.account_id = d.owner_id)`,
  },
  {
    name: "publications.current_link_id",
    requires: ["publications", "publication_links"],
    sql: `SELECT count(*) AS broken FROM publications p WHERE p.current_link_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM publication_links l WHERE l.id = p.current_link_id AND l.publication_id = p.id)`,
  },
  {
    name: "comment_threads.current_epoch_id",
    requires: ["comment_threads", "comment_thread_epochs"],
    sql: `SELECT count(*) AS broken FROM comment_threads t WHERE t.current_epoch_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM comment_thread_epochs e WHERE e.id = t.current_epoch_id AND e.thread_id = t.id)`,
  },
  {
    name: "import_commits.account_id",
    requires: ["import_commits", "accounts"],
    sql: `SELECT count(*) AS broken FROM import_commits c WHERE NOT EXISTS (
      SELECT 1 FROM accounts a WHERE a.id = c.account_id)`,
  },
];

/** Trigger and constraint behavior probes, run against a throwaway offline
 * restore so the target itself is never mutated by a probe. */
/** @param {DatabaseSync} db @param {{ full?: boolean }} [options] */
export function behaviorProbes(db, { full = true } = {}) {
  /** @type {{ name: string, ok: boolean, detail: string }[]} */
  const probes = [];
  if (!full) {
    const enabled = db.prepare("PRAGMA foreign_keys").get();
    probes.push({ name: "PRAGMA foreign_keys", ok: Number(enabled?.foreign_keys) === 1, detail: JSON.stringify(enabled) });
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    probes.push({ name: "PRAGMA foreign_key_check", ok: violations.length === 0, detail: `${violations.length} violations` });
    return probes;
  }
  /** @param {string} name @param {string} sql @param {RegExp} pattern */
  const expectFailure = (name, sql, pattern) => {
    try {
      db.exec(sql);
      probes.push({ name, ok: false, detail: "statement unexpectedly succeeded" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      probes.push({ name, ok: pattern.test(message), detail: message });
    }
  };
  /** @param {string} name @param {string} sql @param {(rows: Record<string, unknown>[]) => boolean} verify */
  const expectRows = (name, sql, verify) => {
    try {
      const rows = /** @type {Record<string, unknown>[]} */ (db.prepare(sql).all());
      const detail = JSON.stringify(rows);
      probes.push({ name, ok: verify(rows), detail });
    } catch (error) {
      probes.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  const representation = db.prepare("SELECT id FROM file_representations LIMIT 1").get();
  if (representation) {
    expectFailure(
      "file representation immutability trigger",
      `UPDATE file_representations SET ciphertext = X'00', ciphertext_size = 1 WHERE id = '${representation.id}'`,
      /immutable/,
    );
  } else {
    probes.push({ name: "file representation immutability trigger", ok: false, detail: "no restored representation to probe" });
  }

  expectFailure(
    "challenge lifetime guard trigger",
    `INSERT INTO webauthn_challenges (id, challenge, purpose, origin, rp_id, created_at, expires_at)
     VALUES ('restore-probe-challenge', 'restore-probe', 'sign_in', 'https://probe.invalid', 'probe.invalid', 1, 600002)`,
    /lifetime/,
  );

  const account = db.prepare("SELECT id FROM accounts LIMIT 1").get();
  const targetDirectory = db.prepare("SELECT id FROM vault_nodes WHERE parent_node_id IS NULL LIMIT 1").get();
  if (account && targetDirectory) {
    expectFailure(
      "import commit session guard trigger",
      `INSERT INTO import_commits (import_id, account_id, target_directory_id, committed_at)
       VALUES ('${"P".repeat(43)}', '${account.id}', '${targetDirectory.id}', 1)`,
      /session required/,
    );
    expectFailure(
      "foreign-key enforcement",
      `INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at)
       VALUES ('restore-probe-node', 'file', 'restore-probe-missing-owner', '${targetDirectory.id}', 1, 1)`,
      /FOREIGN KEY|constraint/i,
    );
    db.exec(`INSERT INTO accounts (id, share_id, created_at, updated_at)
      VALUES ('restore-probe-account', 'restore-probe-share', 1, 1);
      INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch)
      VALUES ('restore-probe-account', 'restore-probe-root', 1);`);
    expectRows(
      "root materialization trigger",
      `SELECT (SELECT count(*) FROM vault_nodes WHERE id = 'restore-probe-root' AND parent_node_id IS NULL) AS nodes,
              (SELECT count(*) FROM directories WHERE node_id = 'restore-probe-root') AS directories`,
      (rows) => rows.length === 1 && Number(rows[0].nodes) === 1 && Number(rows[0].directories) === 1,
    );
  } else {
    probes.push({ name: "trigger probes", ok: false, detail: "no restored account/root to probe" });
  }

  const enabled = db.prepare("PRAGMA foreign_keys").get();
  probes.push({
    name: "PRAGMA foreign_keys",
    ok: Number(enabled?.foreign_keys) === 1,
    detail: JSON.stringify(enabled),
  });
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  probes.push({ name: "PRAGMA foreign_key_check", ok: violations.length === 0, detail: `${violations.length} violations` });
  return probes;
}

/** Representative application reads: the reviewed hot-path plans must still
 * resolve to their persistent indexes on the restored schema. The selected
 * plan is asserted without a covering requirement and the explicitly labelled
 * `INDEXED BY` companion probe carries the covering assertion, exactly like
 * the reviewed operational gate. */
/** @param {DatabaseSync} db @returns {{ name: string, ok: boolean, detail: string }[]} */
export function queryPlanProbes(db) {
  return reviewedPlanChecks(createSqliteRunner(db));
}

/** The reviewed plan gate, shared by the offline probes and target
 * verification: the selected plan is asserted without a covering requirement
 * and the labelled `INDEXED BY` companion probe carries the covering
 * assertion. One EXPLAIN per runner call: Wrangler's local splitter can merge
 * a batched recursive query containing CASE ... END, and a merged result would
 * silently misalign every later assertion.
 * @param {{ run: (sql: string) => Array<{ results: Record<string, unknown>[] }> }} runner
 * @returns {{ name: string, ok: boolean, detail: string }[]}
 */
export function reviewedPlanChecks(runner) {
  /** @type {{ name: string, ok: boolean, detail: string }[]} */
  const checks = [];
  for (const query of QUERY_PLANS) {
    try {
      /** @param {Record<string, unknown>[]} rows */
      const detail = (rows) => rows.map((row) => String(row.detail)).join("; ");
      const selected = queryRows(runner, `EXPLAIN QUERY PLAN ${query.sql};`);
      assertQueryPlan(query, selected.map((row) => ({ detail: String(row.detail) })), false);
      if (query.probeFrom) {
        const probe = queryRows(runner, `EXPLAIN QUERY PLAN ${coveringProbeSql(query)};`);
        assertQueryPlan(query, probe.map((row) => ({ detail: String(row.detail) })));
      } else {
        assertQueryPlan(query, selected.map((row) => ({ detail: String(row.detail) })));
      }
      checks.push({ name: query.name, ok: true, detail: detail(selected) });
    } catch (error) {
      checks.push({ name: query.name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return checks;
}

/** Compare two digest maps; returns human-readable differences. */
/** @param {Map<string, { count: number, digest: string }>} expected @param {Map<string, { count: number, digest: string }>} actual @returns {string[]} */
export function compareDigests(expected, actual) {
  /** @type {string[]} */
  const problems = [];
  for (const [name, value] of expected) {
    const other = actual.get(name);
    if (!other) problems.push(`${name}: missing from comparison`);
    else if (other.count !== value.count) problems.push(`${name}: count ${other.count} != ${value.count}`);
    else if (other.digest !== value.digest) problems.push(`${name}: content digest differs`);
  }
  return problems;
}

/** A synchronous SQL runner over an offline node:sqlite database. */
/** @param {DatabaseSync} db */
export function createSqliteRunner(db) {
  return {
    /** @param {string} sql */
    run(sql) {
      return splitStatements(sql).map((statement) => ({ results: db.prepare(statement).all() }));
    },
  };
}

/**
 * @typedef {{
 *   source: { name: string, uuid: string },
 *   prepared: { sha256: string, commands: Array<[number, number]> },
 *   schema: {
 *     head: string | null,
 *     migrations: { id: number, name: string }[],
 *     objects: { type: string, name: string, sha256: string }[],
 *   },
 *   tables: { name: string, columns: string[], primaryKey: string[], count: number, digest: string }[],
 * }} RestoreManifest
 */

/**
 * Verify an applied target against a prepared manifest: schema inventory,
 * migration head, row counts, content digests, foreign keys, current pointers,
 * and the reviewed query plans. Read-only.
 * @param {{ run: (sql: string) => Array<{ results: Record<string, unknown>[] }> }} runner
 * @param {RestoreManifest} manifest
 * @param {{ checkQueryPlans?: boolean }} [options]
 */
export function verifyRestoreTarget(runner, manifest, { checkQueryPlans = true } = {}) {
  /** @type {{ name: string, ok: boolean, detail: string }[]} */
  const checks = [];
  /** @param {string} name @param {boolean} ok @param {string} detail */
  const record = (name, ok, detail) => checks.push({ name, ok, detail });

  const basic = runner.run(
    `PRAGMA foreign_keys;\nPRAGMA foreign_key_check;\nSELECT type, name, sql FROM sqlite_schema
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name;\nSELECT id, name FROM d1_migrations ORDER BY id;`,
  );
  const foreignKeys = basic[0]?.results?.[0]?.foreign_keys;
  record("PRAGMA foreign_keys = 1", Number(foreignKeys) === 1, String(foreignKeys));
  const violations = basic[1]?.results ?? [];
  record("PRAGMA foreign_key_check", violations.length === 0, `${violations.length} violations`);

  const expectedObjects = new Map(manifest.schema.objects.map((/** @type {{type: string, name: string, sha256: string}} */ object) => [`${object.type}:${object.name}`, object.sha256]));
  const actualObjects = new Map(
    (basic[2]?.results ?? []).map((row) => [`${row.type}:${row.name}`, sha256Hex(String(row.sql))]),
  );
  const objectProblems = [];
  for (const [key, hash] of expectedObjects) {
    if (!actualObjects.has(key)) objectProblems.push(`${key} missing`);
    else if (actualObjects.get(key) !== hash) objectProblems.push(`${key} differs`);
  }
  for (const key of actualObjects.keys()) if (!expectedObjects.has(key)) objectProblems.push(`${key} unexpected`);
  record("schema objects (tables/indexes/triggers/views)", objectProblems.length === 0, objectProblems.join("; ") || `${expectedObjects.size} objects match`);

  const expectedMigrations = manifest.schema.migrations.map((migration) => `${migration.id}:${migration.name}`).join(",");
  const actualMigrations = (basic[3]?.results ?? []).map((row) => `${row.id}:${row.name}`).join(",");
  record("migration records", expectedMigrations === actualMigrations, `head ${manifest.schema.head ?? "none"}`);

  const countStatements = manifest.tables
    .map((table) => `SELECT '${table.name}' AS t, count(*) AS n FROM ${quoteIdentifier(table.name)};`)
    .join("\n");
  const countResults = runner.run(countStatements);
  /** @type {string[]} */
  const countProblems = [];
  manifest.tables.forEach((table, index) => {
    const actual = Number(countResults[index]?.results?.[0]?.n);
    if (actual !== table.count) countProblems.push(`${table.name}: ${actual} != ${table.count}`);
  });
  record("table row counts", countProblems.length === 0, countProblems.join("; ") || `${manifest.tables.length} tables match`);

  /** @type {string[]} */
  /** @type {string[]} */
  const digestProblems = [];
  const actualDigests = runnerDigests(runner, manifest.tables);
  for (const table of manifest.tables) {
    if (table.count === 0) continue;
    const digest = actualDigests.get(table.name);
    if (!digest) digestProblems.push(`${table.name}: no digest returned`);
    else if (digest.count !== table.count) digestProblems.push(`${table.name}: count ${digest.count} != ${table.count}`);
    else if (digest.digest !== table.digest) digestProblems.push(`${table.name}: content digest differs`);
  }
  record("table content digests", digestProblems.length === 0, digestProblems.join("; ") || "all digests match");

  const restoredTables = new Set((basic[2]?.results ?? []).filter((row) => row.type === "table").map((row) => row.name));
  const applicablePointerChecks = CURRENT_POINTER_CHECKS.filter((check) => check.requires.every((table) => restoredTables.has(table)));
  /** @type {string[]} */
  const pointerProblems = [];
  for (const check of applicablePointerChecks) {
    const broken = Number(runner.run(`${check.sql};`)[0]?.results?.[0]?.broken);
    if (broken !== 0) pointerProblems.push(`${check.name}: ${broken} broken`);
  }
  record(
    "current/authority pointers",
    pointerProblems.length === 0,
    pointerProblems.join("; ") || `${applicablePointerChecks.length} invariants hold`,
  );

  if (checkQueryPlans) {
    const planChecks = reviewedPlanChecks(runner);
    const planProblems = planChecks.filter((check) => !check.ok).map((check) => check.detail);
    record("reviewed query plans", planProblems.length === 0, planProblems.join("; ") || `${QUERY_PLANS.length} plans match`);
  }

  const problems = checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`);
  return { ok: problems.length === 0, checks, problems };
}
