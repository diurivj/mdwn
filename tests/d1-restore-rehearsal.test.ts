import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  applyStatementsInTransaction,
  compareDigests,
  createSqliteRunner,
  openOfflineDatabase,
  prepareRestore,
  tableDigests,
  verifyRestoreTarget,
} from "../scripts/lib/d1-export-restore.mjs";
import { REHEARSAL_IDS, restoreRehearsalStatements } from "../scripts/lib/restore-rehearsal-data.mjs";

/** Apply the committed migrations exactly as reviewed, plus Wrangler's own
 * migration journal (as any real D1 source database has). */
/** @returns {DatabaseSync} */
function migratedDatabase() {
  const db = new DatabaseSync(":memory:", {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: true,
  });
  const files = readdirSync("drizzle")
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) db.exec(readFileSync(`drizzle/${file}`, "utf8"));
  db.exec(`CREATE TABLE IF NOT EXISTS "d1_migrations"(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  );`);
  const insert = db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, '2026-01-01 00:00:00')");
  for (const file of files) insert.run(file);
  return db;
}

/** @param {string} identifier */
function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Emit a Wrangler `d1 export`-shaped dump: the interleaved per-table
 * CREATE + INSERT order that breaks raw re-import, followed by
 * sqlite_sequence, indexes, triggers, and views.
 * @param {DatabaseSync} db
 */
function dumpAsD1Export(db: DatabaseSync) {
  const objects = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_schema
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`,
    )
    .all();
  const tables = objects.filter((object) => object.type === "table");
  const statements = ["PRAGMA defer_foreign_keys=TRUE;"];
  const emitRows = (name: string) => {
    const columns = db
      .prepare(`PRAGMA table_info(${quoteIdentifier(name)})`)
      .all()
      .map((column) => String(column.name));
    if (columns.length === 0) return [];
    const columnList = columns.map(quoteIdentifier).join(",");
    const values = columns.map((column) => `quote(${quoteIdentifier(column)})`).join(` || ',' || `);
    const prefix = `INSERT INTO "${name}" (${columnList}) VALUES(`.replaceAll("'", "''");
    const select = `SELECT '${prefix}' || ${values} || ');' AS statement FROM ${quoteIdentifier(name)}`;
    return db
      .prepare(select)
      .all()
      .map((row) => String(row.statement));
  };
  const firstTable = tables.find((table) => table.name === "d1_migrations");
  if (firstTable) {
    statements.push(`${String(firstTable.sql)};`, ...emitRows("d1_migrations"));
  }
  for (const table of tables) {
    if (table.name === "d1_migrations") continue;
    statements.push(`${String(table.sql)};`, ...emitRows(String(table.name)));
  }
  statements.push("DELETE FROM sqlite_sequence;", ...emitRows("sqlite_sequence"));
  for (const object of objects.filter((entry) => entry.type === "index")) statements.push(`${String(object.sql)};`);
  for (const object of objects.filter((entry) => entry.type === "trigger")) statements.push(`${String(object.sql)};`);
  for (const object of objects.filter((entry) => entry.type === "view")) statements.push(`${String(object.sql)};`);
  return statements.join("\n") + "\n";
}

function seededSource() {
  const db = migratedDatabase();
  const { statements } = restoreRehearsalStatements();
  applyStatementsInTransaction(db, statements.join("\n") + "\n");
  return db;
}

describe("production-representative restore rehearsal (committed schema)", () => {
  it("seeds the committed schema with circular, trigger-materialized, and max-size data", () => {
    const db = seededSource();
    try {
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      // The root-materialization trigger created both roots exactly once.
      expect(db.prepare("SELECT count(*) AS n FROM vault_nodes WHERE parent_node_id IS NULL").get()).toMatchObject({
        n: 2,
      });
      expect(db.prepare("SELECT count(*) AS n FROM directories").get()).toMatchObject({ n: 2 });
      // The durable Import marker survives its deleted staging.
      expect(db.prepare("SELECT count(*) AS n FROM import_commits").get()).toMatchObject({ n: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM import_sessions").get()).toMatchObject({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM import_chunks").get()).toMatchObject({ n: 0 });
      // Both max-size representations are intact and belong to the expected Files.
      const sizes = db.prepare("SELECT ciphertext_size AS size FROM file_representations ORDER BY id").all();
      expect(sizes).toEqual([{ size: 524_288 }, { size: 524_288 }]);
      expect(db.prepare("SELECT node_id AS id FROM files ORDER BY node_id").all()).toEqual([
        { id: REHEARSAL_IDS.fileA },
        { id: REHEARSAL_IDS.fileB },
      ]);
      expect(db.prepare("SELECT length(ciphertext) AS bytes FROM file_representations LIMIT 1").get()).toMatchObject({
        bytes: 524_288,
      });
    } finally {
      db.close();
    }
  });

  it("fails to re-import the raw export order, then restores it losslessly", () => {
    const source = seededSource();
    let exportSql: string;
    let sourceDigests: ReturnType<typeof tableDigests>;
    try {
      exportSql = dumpAsD1Export(source);
      sourceDigests = tableDigests(source, [
        { name: "accounts", columns: ["id", "share_id", "created_at", "updated_at"] },
      ]);
    } finally {
      source.close();
    }
    // Sanitized failing regression: the raw order inserts a Directory row
    // before the vault_nodes table it references exists.
    expect(() => {
      const raw = openOfflineDatabase();
      try {
        applyStatementsInTransaction(raw, exportSql);
      } finally {
        raw.close();
      }
    }).toThrow(/no such table: (main\.)?vault_nodes/i);

    const prepared = prepareRestore({
      exportSql,
      sourceName: "mdwn-restore-rehearsal-source",
      sourceUuid: "00000000-0000-4000-8000-00000000e001",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(prepared.manifest.stats.chunkedStatements).toBe(2);
    expect(prepared.manifest.schema.head).toMatch(/^\d{4}_.+\.sql$/);
    expect(prepared.probes.every((probe) => probe.ok)).toBe(true);
    expect(prepared.manifest.tables.find((table) => table.name === "file_representations")).toMatchObject({ count: 2 });

    const target = openOfflineDatabase();
    try {
      applyStatementsInTransaction(target, prepared.preparedSql);
      const verification = verifyRestoreTarget(createSqliteRunner(target), prepared.manifest);
      expect(verification.problems).toEqual([]);
      expect(verification.ok).toBe(true);
      // Direct source -> target equality, not only target -> manifest.
      expect(
        compareDigests(
          sourceDigests,
          tableDigests(target, [{ name: "accounts", columns: ["id", "share_id", "created_at", "updated_at"] }]),
        ),
      ).toEqual([]);
    } finally {
      target.close();
    }
  });
});
