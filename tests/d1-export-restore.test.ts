import { describe, expect, it } from "vitest";

import {
  applyStatementsInTransaction,
  buildRestorePlan,
  compareDigests,
  createSqliteRunner,
  openOfflineDatabase,
  prepareRestore,
  tableDigests,
  verifyRestoreTarget,
} from "../scripts/lib/d1-export-restore.mjs";

/** Sanitized regression export: the ordering hazards of the real schema
 * without any application data. `directories` is created and loaded before
 * `vault_nodes` exists (forward reference), the two tables reference each
 * other (cycle), a trigger materializes rows that also appear in the export,
 * and one BLOB statement exceeds the statement limit. */
function regressionExport({ blobBytes = 200 } = {}) {
  const hex = "ab".repeat(blobBytes);
  return [
    "PRAGMA defer_foreign_keys=TRUE;",
    `CREATE TABLE IF NOT EXISTS "d1_migrations"(\n\t\tid INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n);`,
    `INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(1,'0000_regression.sql','2026-01-01 00:00:00');`,
    "CREATE TABLE `accounts` (`id` text PRIMARY KEY NOT NULL, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);",
    "INSERT INTO \"accounts\" (\"id\",\"created_at\",\"updated_at\") VALUES('acct',1,1);",
    "CREATE TABLE `directories` (`node_id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL,",
    "\tFOREIGN KEY (`node_id`) REFERENCES `vault_nodes`(`id`) ON UPDATE no action ON DELETE restrict,",
    "\tFOREIGN KEY (`owner_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict);",
    "INSERT INTO \"directories\" (\"node_id\",\"owner_id\") VALUES('root','acct');",
    "CREATE TABLE `vault_nodes` (`id` text PRIMARY KEY NOT NULL, `kind` text NOT NULL, `owner_id` text NOT NULL, `parent_node_id` text,",
    "\tFOREIGN KEY (`owner_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,",
    "\tFOREIGN KEY (`owner_id`,`parent_node_id`) REFERENCES `directories`(`owner_id`,`node_id`)",
    "\t  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED);",
    "INSERT INTO \"vault_nodes\" (\"id\",\"kind\",\"owner_id\",\"parent_node_id\") VALUES('root','directory','acct',NULL);",
    "CREATE TABLE `blobs` (`id` text PRIMARY KEY NOT NULL, `payload` blob NOT NULL, `note` text NOT NULL);",
    `INSERT INTO "blobs" ("id","payload","note") VALUES('big',X'${hex}','kept');`,
    "CREATE INDEX `blobs_id_idx` ON `blobs` (`id`);",
    "CREATE UNIQUE INDEX `directories_owner_node_idx` ON `directories` (`owner_id`,`node_id`);",
    "CREATE TRIGGER roots_after_account AFTER INSERT ON accounts",
    "BEGIN",
    "  INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id)",
    "    VALUES (NEW.id || '-root', 'directory', NEW.id, NULL);",
    "  INSERT INTO directories (node_id, owner_id) VALUES (NEW.id || '-root', NEW.id);",
    "END;",
    "CREATE VIEW blob_ids AS SELECT id, note FROM blobs;",
  ].join("\n");
}

/** @param {string} exportSql */
function applyRaw(exportSql: string) {
  const db = openOfflineDatabase();
  try {
    applyStatementsInTransaction(db, exportSql);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

describe("raw D1 export regression", () => {
  it("fails when a table's rows load before a table they reference exists", () => {
    expect(() => applyRaw(regressionExport())).toThrow(/no such table: (main\.)?vault_nodes/i);
  });
});

describe("buildRestorePlan", () => {
  it("orders tables before data and objects, and keeps foreign keys enabled", () => {
    const plan = buildRestorePlan(regressionExport());
    expect(plan.preparedSql.startsWith("PRAGMA defer_foreign_keys=TRUE;")).toBe(true);
    expect(plan.preparedSql).toMatch(/PRAGMA foreign_keys\s*=\s*OFF/i.test(plan.preparedSql) ? /never/ : /./);
    const tableIndex = plan.preparedSql.indexOf("CREATE TABLE `vault_nodes`");
    const indexIndex = plan.preparedSql.indexOf("CREATE UNIQUE INDEX `directories_owner_node_idx`");
    const directoryInsert = plan.preparedSql.indexOf('INSERT INTO "directories"');
    const triggerIndex = plan.preparedSql.indexOf("CREATE TRIGGER roots_after_account");
    expect(tableIndex).toBeLessThan(indexIndex);
    expect(indexIndex).toBeLessThan(directoryInsert);
    expect(directoryInsert).toBeLessThan(triggerIndex);
    expect(plan.preparedSql).not.toMatch(/foreign_keys\s*=\s*(OFF|0)/i);
  });

  it("restores the sanitized regression with no duplicate trigger-materialized rows", () => {
    const plan = buildRestorePlan(regressionExport());
    const db = openOfflineDatabase();
    try {
      applyStatementsInTransaction(db, plan.preparedSql);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("SELECT count(*) AS n FROM vault_nodes").get()).toMatchObject({ n: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM directories").get()).toMatchObject({ n: 1 });
      // The trigger is present after data and materializes a new root once.
      db.exec("INSERT INTO accounts (id, created_at, updated_at) VALUES ('acct-2', 2, 2);");
      expect(db.prepare("SELECT count(*) AS n FROM vault_nodes WHERE owner_id = 'acct-2'").get()).toMatchObject({ n: 1 });
    } finally {
      db.close();
    }
  });

  it("chunks an oversized BLOB into bounded statements without changing content", () => {
    const exportSql = regressionExport({ blobBytes: 5000 });
    const plan = buildRestorePlan(exportSql, { maxStatementBytes: 500 });
    expect(plan.stats.chunkedStatements).toBe(1);
    for (const statement of plan.preparedSql.split("\n").filter((line) => line.startsWith("INSERT") || line.startsWith("UPDATE"))) {
      expect(Buffer.byteLength(statement, "utf8")).toBeLessThanOrEqual(500);
    }
    const db = openOfflineDatabase();
    try {
      applyStatementsInTransaction(db, plan.preparedSql);
      const row = db.prepare("SELECT length(payload) AS bytes, hex(payload) AS hex, note FROM blobs WHERE id = 'big'").get() as
        | { bytes: number; hex: string; note: string }
        | undefined;
      expect(row).toMatchObject({ bytes: 5000, note: "kept" });
      expect(row!.hex).toBe("AB".repeat(5000));
    } finally {
      db.close();
    }
  });
});

describe("prepareRestore", () => {
  it("records a lossless manifest and verifies a restored target", () => {
    const prepared = prepareRestore({
      exportSql: regressionExport({ blobBytes: 5000 }),
      sourceName: "mdwn-restore-source",
      sourceUuid: "00000000-0000-4000-8000-000000000001",
      maxStatementBytes: 500,
      fullProbes: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(prepared.manifest.schema.head).toBe("0000_regression.sql");
    expect(prepared.manifest.stats.chunkedStatements).toBe(1);
    expect(prepared.manifest.export.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.manifest.tables.find((table) => table.name === "blobs")).toMatchObject({ count: 1 });
    expect(prepared.probes.every((probe) => probe.ok)).toBe(true);

    const db = openOfflineDatabase();
    try {
      applyStatementsInTransaction(db, prepared.preparedSql);
      const verification = verifyRestoreTarget(createSqliteRunner(db), prepared.manifest, { checkQueryPlans: false });
      expect(verification.problems).toEqual([]);
      expect(verification.ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("detects a tampered target", () => {
    const prepared = prepareRestore({
      exportSql: regressionExport(),
      sourceName: "mdwn-restore-source",
      sourceUuid: "00000000-0000-4000-8000-000000000001",
      fullProbes: false,
    });
    const db = openOfflineDatabase();
    try {
      applyStatementsInTransaction(db, prepared.preparedSql);
      db.exec("UPDATE blobs SET note = 'tampered' WHERE id = 'big';");
      const verification = verifyRestoreTarget(createSqliteRunner(db), prepared.manifest, { checkQueryPlans: false });
      expect(verification.ok).toBe(false);
      expect(verification.problems.join(" ")).toMatch(/digest differs/);
    } finally {
      db.close();
    }
  });

  it("refuses an export whose oversized statement cannot be split", () => {
    const exportSql = [
      "CREATE TABLE `notes` (`id` text PRIMARY KEY NOT NULL, `body` text NOT NULL);",
      `INSERT INTO "notes" ("id","body") VALUES('n', '${"x".repeat(400)}');`,
    ].join("\n");
    expect(() => prepareRestore({
      exportSql,
      sourceName: "source",
      sourceUuid: "00000000-0000-4000-8000-000000000001",
      maxStatementBytes: 100,
      fullProbes: false,
    })).toThrow(/cannot split/i);
  });
});

describe("compareDigests and tableDigests", () => {
  it("is order-independent and detects changes", () => {
    const db = openOfflineDatabase();
    try {
      db.exec("CREATE TABLE t (id text PRIMARY KEY, value text); INSERT INTO t VALUES ('a','1'),('b','2');");
      const before = tableDigests(db, [{ name: "t", columns: ["id", "value"] }]);
      db.exec("DELETE FROM t; INSERT INTO t VALUES ('b','2'),('a','1');");
      const after = tableDigests(db, [{ name: "t", columns: ["id", "value"] }]);
      expect(compareDigests(before, after)).toEqual([]);
      db.exec("UPDATE t SET value = '3' WHERE id = 'a';");
      const changed = tableDigests(db, [{ name: "t", columns: ["id", "value"] }]);
      expect(compareDigests(before, changed).join(" ")).toMatch(/digest differs/);
    } finally {
      db.close();
    }
  });
});
