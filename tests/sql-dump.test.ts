import { describe, expect, it } from "vitest";

import {
  chunkOversizedStatements,
  classifyStatement,
  parseInsert,
  splitStatements,
  splitTuples,
  splitValues,
} from "../scripts/lib/sql-dump.mjs";

describe("splitStatements", () => {
  it("splits on top-level semicolons and drops comments", () => {
    const sql = [
      "PRAGMA defer_foreign_keys=TRUE;",
      "-- a comment with ; inside",
      "CREATE TABLE `accounts` (\n  `id` text PRIMARY KEY NOT NULL,\n  `note` text DEFAULT 'a;b'\n);",
      "/* block ; comment */",
      'INSERT INTO "accounts" ("id","note") VALUES(\'1\',\'x\');',
      "",
    ].join("\n");
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toBe("PRAGMA defer_foreign_keys=TRUE");
    expect(statements[1]).toContain("CREATE TABLE `accounts`");
    expect(statements[1]).toContain("'a;b'");
    expect(statements[2]).toContain("INSERT INTO");
  });

  it("keeps a trigger BEGIN...END body whole, including nested CASE", () => {
    const sql = [
      "CREATE TRIGGER tree_new_account_root AFTER INSERT ON account_encryption_identities",
      "BEGIN",
      "  INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at)",
      "    SELECT NEW.root_directory_id, 'directory', NEW.account_id, NULL,",
      "      CASE WHEN NEW.registry_epoch > 1 THEN 2 ELSE 1 END, 0",
      "    FROM accounts WHERE id = NEW.account_id;",
      "  INSERT INTO directories (node_id, owner_id, entries_revision) VALUES (NEW.root_directory_id, NEW.account_id, 1);",
      "END;",
      "SELECT 1;",
    ].join("\n");
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("CASE WHEN");
    expect(statements[0]).toContain("INSERT INTO directories");
    expect(statements[0].endsWith("END")).toBe(true);
    expect(statements[1]).toBe("SELECT 1");
  });

  it("handles doubled quotes, backticks, brackets, and dollar-quoted bodies", () => {
    const sql = [
      "CREATE TABLE `weird` (`name` text DEFAULT 'it''s; fine', [bracket col] text);",
      "SELECT '-- not a comment;';",
    ].join("\n");
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("it''s; fine");
    expect(statements[1]).toBe("SELECT '-- not a comment;'");
  });
});

describe("classifyStatement and parseInsert", () => {
  it("classifies DDL, data, and pragmas", () => {
    expect(classifyStatement("CREATE TABLE IF NOT EXISTS `t` (id text)")).toMatchObject({ kind: "table" });
    expect(classifyStatement("CREATE UNIQUE INDEX `i` ON `t` (`id`)")).toMatchObject({ kind: "index" });
    expect(classifyStatement("CREATE VIEW v AS SELECT 1")).toMatchObject({ kind: "view" });
    expect(classifyStatement("CREATE TRIGGER x BEFORE INSERT ON t BEGIN SELECT 1; END")).toMatchObject({
      kind: "trigger",
    });
    expect(classifyStatement("PRAGMA defer_foreign_keys=TRUE")).toMatchObject({ kind: "pragma" });
    expect(classifyStatement("DELETE FROM sqlite_sequence")).toMatchObject({
      kind: "delete",
      table: "sqlite_sequence",
    });
    expect(classifyStatement("BEGIN")).toMatchObject({ kind: "transaction" });
  });

  it("parses a single-row INSERT with quoted identifiers", () => {
    const parsed = parseInsert(
      'INSERT INTO "file_representations" ("id","ciphertext","ciphertext_size") VALUES(\'r\',X\'0102\',2)',
    );
    expect(parsed).toMatchObject({ table: "file_representations" });
    expect(parsed?.columns).toEqual(["id", "ciphertext", "ciphertext_size"]);
    expect(parsed?.tuples).toHaveLength(1);
    expect(splitValues(parsed!.tuples[0]!)).toEqual(["'r'", "X'0102'", "2"]);
  });

  it("parses multi-row INSERTs and keeps commas inside strings", () => {
    const parsed = parseInsert("INSERT INTO `t` (`a`,`b`) VALUES(1,'x,y'),(2,'z') ON CONFLICT DO NOTHING");
    expect(parsed?.tuples).toHaveLength(2);
    expect(splitValues(parsed!.tuples[1]!)).toEqual(["2", "'z'"]);
    expect(parsed?.suffix).toMatch(/ON CONFLICT/);
  });

  it("returns null for INSERT ... SELECT", () => {
    expect(parseInsert("INSERT INTO t SELECT * FROM other")).toBeNull();
  });
});

describe("splitTuples", () => {
  it("splits tuples without splitting nested parens or strings", () => {
    const tuples = splitTuples("(1,'a,b'),(printf('%s',2),X'00'),(3,'(x)')");
    expect(tuples).toEqual(["(1,'a,b')", "(printf('%s',2),X'00')", "(3,'(x)')"]);
  });
});

describe("chunkOversizedStatements", () => {
  const primaryKeys = new Map([["t", ["id"]]]);

  it("leaves small statements untouched", () => {
    const statement = "INSERT INTO `t` (`id`,`data`) VALUES('a',X'01')";
    const result = chunkOversizedStatements([statement], { maxBytes: 1000, primaryKeys });
    expect(result.statements).toEqual([statement]);
    expect(result.chunked).toBe(0);
  });

  it("splits a multi-row INSERT into per-row statements", () => {
    const rows = Array.from({ length: 4 }, (_, index) => `(${index},'${"x".repeat(40)}')`).join(",");
    const statement = `INSERT INTO \`t\` (\`id\`,\`data\`) VALUES${rows}`;
    const result = chunkOversizedStatements([statement], { maxBytes: 120, primaryKeys });
    expect(result.statements).toHaveLength(4);
    for (const emitted of result.statements) {
      expect(Buffer.byteLength(emitted, "utf8")).toBeLessThanOrEqual(120);
      expect(emitted.startsWith("INSERT INTO")).toBe(true);
    }
    expect(result.chunked).toBe(1);
  });

  it("replaces an oversized BLOB with a first chunk plus bounded append updates", () => {
    const hex = "ab".repeat(5000);
    const statement = `INSERT INTO \`t\` (\`id\`,\`data\`) VALUES('row-1',X'${hex}')`;
    const result = chunkOversizedStatements([statement], { maxBytes: 400, primaryKeys });
    const first = /^INSERT INTO "t" \("id","data"\) VALUES\('row-1',X'([0-9a-f]+)'\)$/.exec(result.statements[0]!);
    expect(first).not.toBeNull();
    expect(result.statements.length).toBeGreaterThan(2);
    for (const emitted of result.statements.slice(1)) {
      expect(emitted).toMatch(/^UPDATE "t" SET "data" = unhex\(hex\("data"\) \|\| '[0-9a-f]+'\) WHERE "id" = 'row-1'$/);
      expect(Buffer.byteLength(emitted, "utf8")).toBeLessThanOrEqual(400);
    }
    const appended = result.statements
      .slice(1)
      .map((s: string) => /\|\| '([0-9a-f]+)'\)/.exec(s)![1])
      .join("");
    expect(first![1] + appended).toBe(hex);
    expect(result.chunked).toBe(1);
  });

  it("chunks several oversized BLOBs in one row", () => {
    const statement = `INSERT INTO \`t\` (\`id\`,\`data\`,\`meta\`) VALUES('row-2',X'${"11".repeat(600)}',X'${"22".repeat(600)}')`;
    const result = chunkOversizedStatements([statement], { maxBytes: 500, primaryKeys });
    expect(result.statements[0]).toMatch(
      /^INSERT INTO "t" \("id","data","meta"\) VALUES\('row-2',X'[0-9a-f]+',X'[0-9a-f]+'\)$/,
    );
    expect(result.statements.some((s: string) => s.includes('SET "data"'))).toBe(true);
    expect(result.statements.some((s: string) => s.includes('SET "meta"'))).toBe(true);
  });

  it("keeps a length-coupled size column valid at every chunk step", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const ddl = new Map([
      [
        "t",
        'CREATE TABLE `t` (`id` text PRIMARY KEY NOT NULL, `data` blob NOT NULL, `data_size` integer NOT NULL, CONSTRAINT "t_size" CHECK(`data_size` = length(`data`)))',
      ],
    ]);
    const hex = "cd".repeat(5000);
    const statement = `INSERT INTO \`t\` (\`id\`,\`data\`,\`data_size\`) VALUES('row-3',X'${hex}',5000)`;
    const result = chunkOversizedStatements([statement], { maxBytes: 400, primaryKeys, tableDdl: ddl });
    const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    try {
      db.exec(ddl.get("t")!);
      db.exec("BEGIN; PRAGMA defer_foreign_keys=TRUE;");
      for (const emitted of result.statements) db.exec(emitted);
      db.exec("COMMIT;");
      const row = db.prepare("SELECT hex(data) AS hex, data_size AS size, length(data) AS bytes FROM t").get();
      expect(row).toMatchObject({ hex: hex.toUpperCase(), size: 5000, bytes: 5000 });
    } finally {
      db.close();
    }
  });

  it("refuses to silently drop an oversized statement it cannot split", () => {
    const statement = `INSERT INTO \`t\` (\`id\`,\`data\`) VALUES('row-3','${"y".repeat(500)}')`;
    expect(() => chunkOversizedStatements([statement], { maxBytes: 100, primaryKeys })).toThrow(/cannot split/i);
  });

  it("refuses to chunk a BLOB when the primary key is not in the INSERT", () => {
    const statement = `INSERT INTO \`t\` (\`data\`) VALUES(X'${"ab".repeat(5000)}')`;
    expect(() => chunkOversizedStatements([statement], { maxBytes: 400, primaryKeys })).toThrow(/primary key/i);
  });
});
