/**
 * D1 export restoration: turn a Wrangler `d1 export` dump into a statement
 * order that D1 can import as one atomic transaction, and verify the result.
 *
 * A raw export interleaves each table's CREATE with its rows and emits indexes,
 * triggers, and views last. D1 always enforces foreign keys, so a row inserted
 * before its referenced table exists fails ("no such table"), and root
 * materialization triggers installed before the data would duplicate roots.
 * This module reorders statements (tables, then data, then indexes/triggers/
 * views), keeps D1 foreign keys enforced, and defers checks only inside the
 * single import transaction with `PRAGMA defer_foreign_keys=TRUE`.
 *
 * It also splits any statement that exceeds D1's 100 KB SQL statement limit:
 * oversized hex BLOBs are inserted empty and appended in bounded chunks.
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { QUERY_PLANS, assertQueryPlan, coveringProbeSql } from "./d1-query-plans.mjs";
import {
  blobLiteralHex,
  chunkOversizedStatements,
  classifyStatement,
  parseInsert,
  splitMultiRowStatements,
  splitStatements,
  splitValues,
} from "./sql-dump.mjs";

/** D1 rejects an individual SQL statement longer than this (platform limit). */
export const D1_MAX_STATEMENT_BYTES = 100_000;
/** Command size bound: one D1 query-endpoint call is atomic, but each call is
 * still one HTTP request plus CLI argument, so keep groups well bounded. */
export const D1_MAX_COMMAND_BYTES = 128 * 1024;
/** D1 rejects a string, BLOB, or row larger than this (platform limit). */
export const D1_MAX_BLOB_BYTES = 2_000_000;
/** Rows fetched per digest page. Small enough that a page of max-size
 * ciphertext rows stays well inside the process output buffer. */
export const DIGEST_PAGE_ROWS = 20;
const DIGEST_MASK = (1n << 256n) - 1n;
const DEFER_PRAGMA = "PRAGMA defer_foreign_keys=TRUE;";

/** @param {string} text */
function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** @param {string} identifier */
function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Group export statements by object kind without losing relative order.
 * @param {string} exportSql
 * @returns {{ tables: string[], data: string[], indexes: string[], triggers: string[], views: string[], migrations: string[] }}
 */
export function groupExportStatements(exportSql) {
  /** @type {{ tables: string[], data: string[], indexes: string[], triggers: string[], views: string[], migrations: string[] }} */
  const groups = { tables: [], data: [], indexes: [], triggers: [], views: [], migrations: [] };
  for (const statement of splitStatements(exportSql)) {
    const { kind, table } = classifyStatement(statement);
    if (kind === "table") groups.tables.push(statement);
    else if (kind === "insert") {
      if (table === "d1_migrations") groups.migrations.push(statement);
      else groups.data.push(statement);
    } else if (kind === "delete") {
      if (table !== "sqlite_sequence") throw new Error(`Unsupported DELETE in export: ${statement.slice(0, 80)}`);
      groups.data.push(statement);
    } else if (kind === "index") groups.indexes.push(statement);
    else if (kind === "trigger") groups.triggers.push(statement);
    else if (kind === "view") groups.views.push(statement);
    else if (kind === "pragma") {
      if (!/^PRAGMA\s+defer_foreign_keys\s*=\s*(TRUE|ON|1)\s*$/i.test(statement.trim())) {
        throw new Error(`Unsupported PRAGMA in export: ${statement.slice(0, 80)}`);
      }
    } else if (kind === "transaction") {
      throw new Error(`Export must not contain transactions: ${statement.slice(0, 80)}`);
    } else {
      throw new Error(`Unsupported statement in export (${kind}): ${statement.slice(0, 80)}`);
    }
  }
  if (groups.tables.length === 0) throw new Error("Export contains no CREATE TABLE statements");
  return groups;
}

/** Open the in-memory SQLite engine used for offline planning and probes. */
export function openOfflineDatabase() {
  return new DatabaseSync(":memory:", {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: true,
  });
}

/** Apply a statement list inside one transaction with deferred foreign keys.
 * @param {DatabaseSync} db @param {string} sql
 */
export function applyStatementsInTransaction(db, sql) {
  db.exec("BEGIN;");
  try {
    db.exec(sql);
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // The original error is the useful one.
    }
    throw error;
  }
}

/** Derive table columns, primary keys, DDL text, and FK pairs from the export's own DDL.
 * @param {string[]} tables
 * @returns {{
 *   schema: { type: string, name: string, sql: string, sha256: string }[],
 *   columns: { name: string, columns: string[], primaryKey: string[] }[],
 *   ddl: Map<string, string>,
 *   foreignKeys: Map<string, { columns: string[], parentTable: string, parentColumns: string[] }[]>,
 * }}
 */
export function deriveSchema(tables) {
  const db = openOfflineDatabase();
  try {
    for (const statement of tables) db.exec(statement);
    const rows = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_schema
         WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
         ORDER BY type, name`,
      )
      .all();
    const schema = rows.map((row) => ({
      type: String(row.type),
      name: String(row.name),
      sql: String(row.sql),
      sha256: sha256Hex(String(row.sql)),
    }));
    const ddl = new Map(rows.filter((row) => row.type === "table").map((row) => [String(row.name), String(row.sql)]));
    const tableNames = rows.filter((row) => row.type === "table").map((row) => String(row.name));
    const columns = tableNames.map((name) => {
      const info = db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all();
      return {
        name,
        columns: info.map((column) => String(column.name)),
        primaryKey: info
          .filter((column) => Number(column.pk) > 0)
          .sort((left, right) => Number(left.pk) - Number(right.pk))
          .map((column) => String(column.name)),
      };
    });
    // SQLite itself reports the exact FK column pairs, including column-level
    // REFERENCES clauses that a text parser would have to reimplement.
    const foreignKeys = new Map(
      tableNames.map((name) => {
        /** @type {Map<number, { columns: string[], parentTable: string, parentColumns: string[] }>} */
        const grouped = new Map();
        for (const row of db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all()) {
          const id = Number(row.id);
          if (!grouped.has(id)) grouped.set(id, { columns: [], parentTable: String(row.table), parentColumns: [] });
          const entry = grouped.get(id);
          if (!entry) continue;
          entry.columns[Number(row.seq)] = String(row.from);
          entry.parentColumns[Number(row.seq)] = String(row.to);
        }
        return [name, [...grouped.values()]];
      }),
    );
    return { schema, columns, ddl, foreignKeys };
  } finally {
    db.close();
  }
}

/** Normalize a raw SQL value literal so parent and child FK values compare equal.
 * @param {string} value @returns {string}
 */
function normalizeKeyValue(value) {
  const trimmed = value.trim();
  const blob = blobLiteralHex(trimmed);
  if (blob !== null) return `x'${blob.toLowerCase()}'`;
  return trimmed;
}

/** @param {string} value */
function isNullLiteral(value) {
  return value.trim().toUpperCase() === "NULL";
}

/** Iterative Tarjan SCC; avoids call-stack limits on deep parent/child chains.
 * @param {number[][]} adjacency @returns {number[][]} components in reverse topological order
 */
function stronglyConnectedComponents(adjacency) {
  const count = adjacency.length;
  const index = new Array(count).fill(-1);
  const low = new Array(count).fill(0);
  const onStack = new Array(count).fill(false);
  /** @type {number[]} */
  const stack = [];
  /** @type {number[][]} */
  const components = [];
  let nextIndex = 0;
  for (let start = 0; start < count; start += 1) {
    if (index[start] !== -1) continue;
    const frames = [{ node: start, edge: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const node = frame.node;
      if (frame.edge === 0) {
        index[node] = nextIndex;
        low[node] = nextIndex;
        nextIndex += 1;
        stack.push(node);
        onStack[node] = true;
      }
      let descended = false;
      const edges = adjacency[node];
      while (frame.edge < edges.length) {
        const target = edges[frame.edge];
        frame.edge += 1;
        if (index[target] === -1) {
          frames.push({ node: target, edge: 0 });
          descended = true;
          break;
        }
        if (onStack[target]) low[node] = Math.min(low[node], index[target]);
      }
      if (descended) continue;
      if (low[node] === index[node]) {
        /** @type {number[]} */
        const component = [];
        for (;;) {
          const member = stack.pop();
          if (member === undefined) break;
          onStack[member] = false;
          component.push(member);
          if (member === node) break;
        }
        components.push(component);
      }
      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1].node;
        low[parent] = Math.min(low[parent], low[node]);
      }
    }
  }
  return components;
}

/**
 * Order data units so every row's parents precede it, keeping each strongly
 * connected cycle group together. The D1 query endpoint commits a multi-
 * statement command atomically, but the `--file` import endpoint does not
 * guarantee one transaction, so a cycle must never span two commands.
 * @param {Array<{ statements: string[] }>} dataUnits
 * @param {{ foreignKeys: Map<string, Array<{columns: string[], parentTable: string, parentColumns: string[]}>>, primaryKeys: Map<string, string[]>, allowMissingParents?: boolean }} options
 * @returns {Array<{ atomic: string[], followups: string[] }>} one entry per SCC
 */
function orderDataUnits(dataUnits, { foreignKeys, primaryKeys, allowMissingParents = false }) {
  /** @type {Array<{ table: string, columns: string[], values: string[], key: string }>} */
  const rows = [];
  /** @type {Array<{ statements: string[] }>} */
  const rowUnits = [];
  /** @type {Array<{ statements: string[] }>} */
  const standaloneUnits = [];
  for (const unit of dataUnits) {
    const parsed = parseInsert(unit.statements[0]);
    const primaryKey = parsed?.table ? primaryKeys.get(parsed.table) : null;
    const parsedColumns = parsed?.columns ?? null;
    if (!parsed || !parsedColumns || parsed.tuples.length !== 1 || !primaryKey?.length) {
      standaloneUnits.push({ statements: unit.statements });
      continue;
    }
    const values = splitValues(parsed.tuples[0]);
    const key = primaryKey.map((column) => {
      const index = parsedColumns.indexOf(column);
      return index < 0 ? null : normalizeKeyValue(values[index]);
    });
    if (key.some((value) => value === null)) {
      standaloneUnits.push({ statements: unit.statements });
      continue;
    }
    rows.push({ table: parsed.table, columns: parsedColumns, values, key: key.join("\u0000") });
    rowUnits.push({ statements: unit.statements });
  }

  /** @type {Map<string, { table: string, columns: string[], map: Map<string, number> }>} */
  const specs = new Map();
  for (const fks of foreignKeys.values()) {
    for (const fk of fks) {
      const key = `${fk.parentTable}\u0000${fk.parentColumns.join(",")}`;
      if (!specs.has(key)) specs.set(key, { table: fk.parentTable, columns: fk.parentColumns, map: new Map() });
    }
  }
  rows.forEach((row, index) => {
    for (const spec of specs.values()) {
      if (spec.table !== row.table) continue;
      const tuple = spec.columns.map((column) => {
        const columnIndex = row.columns.indexOf(column);
        return columnIndex < 0 ? null : normalizeKeyValue(row.values[columnIndex]);
      });
      if (tuple.some((value) => value === null)) continue;
      spec.map.set(tuple.join("\u0000"), index);
    }
  });

  /** @type {number[][]} */
  const adjacency = rows.map(() => []);
  rows.forEach((row, index) => {
    for (const fk of foreignKeys.get(row.table) ?? []) {
      const childValues = fk.columns.map((column) => {
        const columnIndex = row.columns.indexOf(column);
        return columnIndex < 0 ? "NULL" : row.values[columnIndex];
      });
      if (childValues.some((value) => isNullLiteral(value))) continue;
      const spec = specs.get(`${fk.parentTable}\u0000${fk.parentColumns.join(",")}`);
      const parentIndex = spec?.map.get(childValues.map(normalizeKeyValue).join("\u0000"));
      if (parentIndex === undefined) {
        // A trigger-created parent (for example a root Directory materialized
        // by an identity insert) is not part of a data-only seed. Its row is
        // still emitted first by the stable ordering.
        if (allowMissingParents) continue;
        throw new Error(
          `Export is missing the ${fk.parentTable}(${fk.parentColumns.join(",")}) parent row referenced by ${row.table}(${fk.columns.join(",")})`,
        );
      }
      if (parentIndex !== index) adjacency[parentIndex].push(index);
    }
  });

  const components = stronglyConnectedComponents(adjacency);
  const componentOf = new Array(rows.length);
  components.forEach((component, index) => {
    for (const row of component) componentOf[row] = index;
  });
  const dependents = components.map(() => new Set());
  const indegree = new Array(components.length).fill(0);
  for (let parent = 0; parent < adjacency.length; parent += 1) {
    for (const child of adjacency[parent]) {
      const parentComponent = componentOf[parent];
      const childComponent = componentOf[child];
      if (parentComponent === childComponent || dependents[parentComponent].has(childComponent)) continue;
      dependents[parentComponent].add(childComponent);
      indegree[childComponent] += 1;
    }
  }
  // Kahn with the earliest original row as the tie-break: independent rows keep
  // their export order, so trigger-only dependencies (which the FK graph cannot
  // see) still run in the order the export wrote them.
  const earliest = components.map((component) => Math.min(...component));
  const ready = new MinHeap();
  components.forEach((_, index) => {
    if (indegree[index] === 0) ready.push(index, earliest[index]);
  });
  const orderedComponents = [];
  while (ready.size > 0) {
    const component = ready.pop();
    orderedComponents.push(component);
    for (const dependent of dependents[component]) {
      indegree[dependent] -= 1;
      if (indegree[dependent] === 0) ready.push(dependent, earliest[dependent]);
    }
  }
  if (orderedComponents.length !== components.length) {
    throw new Error("Restore dependency graph has an unresolvable cycle in its condensation");
  }
  const ordered = [];
  for (const component of orderedComponents) {
    const atomic = [];
    const followups = [];
    for (const index of components[component].slice().sort((left, right) => left - right)) {
      atomic.push(rowUnits[index].statements[0]);
      followups.push(...rowUnits[index].statements.slice(1));
    }
    ordered.push({ atomic, followups });
  }
  return [...ordered, ...standaloneUnits.map((unit) => ({ atomic: unit.statements, followups: [] }))];
}

/** Minimal binary heap keyed by a numeric priority. */
class MinHeap {
  constructor() {
    /** @type {Array<{ value: number, priority: number }>} */
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  /** @param {number} value @param {number} priority */
  push(value, priority) {
    this.items.push({ value, priority });
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent].priority <= this.items[index].priority) break;
      [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
      index = parent;
    }
  }
  /** @returns {number} */
  pop() {
    const top = this.items[0];
    if (!top) throw new Error("MinHeap underflow");
    const last = this.items.pop();
    if (this.items.length > 0 && last) {
      this.items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.items.length && this.items[left].priority < this.items[smallest].priority) smallest = left;
        if (right < this.items.length && this.items[right].priority < this.items[smallest].priority) smallest = right;
        if (smallest === index) break;
        [this.items[smallest], this.items[index]] = [this.items[index], this.items[smallest]];
        index = smallest;
      }
    }
    return top.value;
  }
}

/** @param {string} statement */
function isSequenceStatement(statement) {
  const { kind, table } = classifyStatement(statement);
  return table === "sqlite_sequence" && (kind === "insert" || kind === "delete");
}

/**
 * Pack statements into atomic commands. Each command is applied as one D1
 * batch/transaction; cycles never span a command boundary.
 * @param {{ schemaStatements: string[], indexStatements: string[], migrationStatements: string[], dataUnits: Array<{ statements: string[] }>, triggerStatements: string[], viewStatements: string[], foreignKeys: Map<string, any[]>, primaryKeys: Map<string, string[]>, maxCommandBytes: number, allowMissingParents?: boolean }} options
 */
export function planRestoreCommands({
  schemaStatements,
  indexStatements,
  migrationStatements,
  dataUnits,
  triggerStatements,
  viewStatements,
  foreignKeys,
  primaryKeys,
  maxCommandBytes,
  allowMissingParents = false,
}) {
  /** @type {Array<{ statements: string[] }>} */
  const commands = [];
  /** @type {{ statements: string[], bytes: number }} */
  let current = { statements: [], bytes: 0 };
  const flush = () => {
    if (current.statements.length > 0) commands.push({ statements: current.statements });
    current = { statements: [], bytes: 0 };
  };
  /** @param {string} statement */
  const byteSize = (statement) => Buffer.byteLength(statement, "utf8") + 2;
  /** @param {{ statements: string[] }} unit @param {{ atomic?: boolean }} [options] */
  const addUnit = (unit, { atomic = false } = {}) => {
    const unitBytes = unit.statements.reduce((sum, statement) => sum + byteSize(statement), 0);
    if (atomic && unitBytes > maxCommandBytes) {
      throw new Error(`One atomic restore unit of ${unitBytes} bytes exceeds the ${maxCommandBytes}-byte command limit`);
    }
    if (current.bytes + unitBytes > maxCommandBytes && current.statements.length > 0) flush();
    current.statements.push(...unit.statements);
    current.bytes += unitBytes;
  };

  for (const statement of schemaStatements) addUnit({ statements: [statement] });
  for (const statement of indexStatements) addUnit({ statements: [statement] });
  flush();

  for (const statement of migrationStatements) addUnit({ statements: [statement] });
  const sequenceUnits = [];
  const rowUnits = [];
  for (const unit of dataUnits) {
    if (isSequenceStatement(unit.statements[0])) sequenceUnits.push(unit);
    else rowUnits.push(unit);
  }
  for (const group of orderDataUnits(rowUnits, { foreignKeys, primaryKeys, allowMissingParents })) {
    addUnit({ statements: group.atomic }, { atomic: true });
    for (const followup of group.followups) addUnit({ statements: [followup] });
  }
  for (const unit of sequenceUnits) addUnit(unit);
  flush();

  for (const statement of triggerStatements) addUnit({ statements: [statement] });
  for (const statement of viewStatements) addUnit({ statements: [statement] });
  flush();

  const orderedStatements = commands.flatMap((command) => command.statements);
  /** @type {Array<[number, number]>} */
  const ranges = [];
  let position = 0;
  const commandSqls = commands.map((command) => {
    const start = position;
    position += command.statements.length;
    ranges.push([start, position]);
    return `${DEFER_PRAGMA}\n${command.statements.map((statement) => `${statement.trimEnd().replace(/;+$/, "")};`).join("\n")}`;
  });
  return { commands: commandSqls, ranges, orderedStatements };
}

/**
 * Build the importable statement order, atomic command groups, and the
 * reorder-only reference order.
 * @param {string} exportSql
 * @param {{ maxStatementBytes?: number, maxCommandBytes?: number }} [options]
 */
export function buildRestorePlan(exportSql, { maxStatementBytes = D1_MAX_STATEMENT_BYTES, maxCommandBytes = D1_MAX_COMMAND_BYTES } = {}) {
  const groups = groupExportStatements(exportSql);
  const { schema, columns, ddl, foreignKeys } = deriveSchema(groups.tables);
  const primaryKeys = new Map(columns.map((table) => [table.name, table.primaryKey]));
  // One row per statement keeps every row addressable in the FK graph; D1
  // exports single-row INSERTs, and hand-built dumps are normalized here.
  const singleRowData = splitMultiRowStatements(groups.data);
  const { units, chunked } = chunkOversizedStatements(singleRowData, {
    maxBytes: maxStatementBytes,
    primaryKeys,
    tableDdl: ddl,
  });

  /** @param {Array<{ statements: string[] }>} dataUnits @param {number} [commandBytes] */
  const planFor = (dataUnits, commandBytes = maxCommandBytes) => planRestoreCommands({
    schemaStatements: groups.tables,
    indexStatements: groups.indexes,
    migrationStatements: groups.migrations,
    dataUnits,
    triggerStatements: groups.triggers,
    viewStatements: groups.views,
    foreignKeys,
    primaryKeys,
    maxCommandBytes: commandBytes,
  });
  const plan = planFor(units);
  const preparedSql = `${DEFER_PRAGMA}\n${plan.orderedStatements.map((statement) => `${statement.trimEnd().replace(/;+$/, "")};`).join("\n")}\n`;
  for (const statement of plan.orderedStatements) {
    const bytes = Buffer.byteLength(statement, "utf8");
    if (bytes > maxStatementBytes) {
      throw new Error(
        `Prepared statement of ${bytes} bytes still exceeds the ${maxStatementBytes}-byte limit: ${statement.slice(0, 80)}...`,
      );
    }
  }
  // Reorder-only companion: identical rows and objects without chunking.
  // Applying both offline proves the BLOB chunking is byte-lossless.
  const referenceSql = chunked > 0
    ? `${DEFER_PRAGMA}\n${planFor(
      singleRowData.map((statement) => ({ statements: [statement] })),
      Number.MAX_SAFE_INTEGER,
    ).orderedStatements
      .map((statement) => `${statement.trimEnd().replace(/;+$/, "")};`)
      .join("\n")}\n`
    : preparedSql;
  return {
    preparedSql,
    referenceSql,
    commands: plan.commands,
    commandRanges: plan.ranges,
    schema,
    columns,
    migrations: readMigrations(groups.migrations),
    stats: {
      tableStatements: groups.tables.length,
      dataStatements: groups.data.length,
      emittedDataStatements: plan.orderedStatements.length,
      indexStatements: groups.indexes.length,
      triggerStatements: groups.triggers.length,
      viewStatements: groups.views.length,
      chunkedStatements: chunked,
      commands: plan.commands.length,
      maxStatementBytes,
      maxCommandBytes,
    },
  };
}

/** @param {string[]} insertStatements */
function readMigrations(insertStatements) {
  const migrations = [];
  for (const statement of insertStatements) {
    const parsed = parseInsert(statement);
    if (!parsed || !parsed.columns) continue;
    const idIndex = parsed.columns.indexOf("id");
    const nameIndex = parsed.columns.indexOf("name");
    for (const tuple of parsed.tuples) {
      const values = splitValues(tuple);
      migrations.push({ id: Number(values[idIndex]), name: String(values[nameIndex]).replace(/^'|'$/g, "") });
    }
  }
  return migrations.sort((left, right) => left.id - right.id);
}

/** Per-table order-independent multiset digest of `quote()`d row values.
 * `quote()` runs inside SQLite, so integers and BLOBs never lose precision
 * through a JSON transport. The digest is a sum of per-row SHA-256 values.
 * @param {DatabaseSync} db @param {{name: string, columns: string[]}[]} tables
 */
export function tableDigests(db, tables) {
  /** @type {Map<string, { count: number, digest: string }>} */
  const digests = new Map();
  for (const table of tables) {
    if (table.columns.length === 0) {
      digests.set(table.name, { count: 0, digest: "0".repeat(64) });
      continue;
    }
    const expression = table.columns.map((column) => `quote(${quoteIdentifier(column)})`).join(" || '|' || ");
    const statement = db.prepare(
      `SELECT rowid AS __rowid, ${expression} AS __value FROM ${quoteIdentifier(table.name)}
       WHERE rowid > ? ORDER BY rowid LIMIT ${DIGEST_PAGE_ROWS}`,
    );
    let lastRowid = -1;
    let count = 0;
    let sum = 0n;
    for (;;) {
      const rows = statement.all(lastRowid);
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
  const probes = [];
  for (const query of QUERY_PLANS) {
    try {
      const selected = /** @type {{ detail: string }[]} */ (db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all());
      assertQueryPlan(query, selected, false);
      const probe = /** @type {{ detail: string }[]} */ (db.prepare(`EXPLAIN QUERY PLAN ${coveringProbeSql(query)}`).all());
      assertQueryPlan(query, probe);
      probes.push({ name: query.name, ok: true, detail: selected.map((row) => row.detail).join("; ") });
    } catch (error) {
      probes.push({ name: query.name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return probes;
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

/**
 * Offline preparation: transform the export, prove the transform is
 * byte-lossless against the reorder-only companion, and record the schema,
 * migration head, row counts, and content digests in a manifest.
 * @param {{ exportSql: string, sourceName: string, sourceUuid: string, wranglerVersion?: string | null, maxStatementBytes?: number, maxCommandBytes?: number, createdAt?: string, fullProbes?: boolean }} options
 */
export function prepareRestore({
  exportSql,
  sourceName,
  sourceUuid,
  wranglerVersion = null,
  maxStatementBytes = D1_MAX_STATEMENT_BYTES,
  maxCommandBytes = D1_MAX_COMMAND_BYTES,
  createdAt = new Date().toISOString(),
  fullProbes = true,
}) {
  if (!sourceName || !sourceUuid) throw new Error("Source database name and UUID are required for the manifest");
  const plan = buildRestorePlan(exportSql, { maxStatementBytes, maxCommandBytes });
  const preparedDb = openOfflineDatabase();
  const referenceDb = plan.stats.chunkedStatements > 0 ? openOfflineDatabase() : preparedDb;
  // A third database applies the same statements command by command, each in
  // its own transaction. This is the transport the remote restore uses; it
  // fails if any cycle group spans a command boundary.
  const commandDb = plan.commands.length > 1 ? openOfflineDatabase() : preparedDb;
  try {
    applyStatementsInTransaction(preparedDb, plan.preparedSql);
    if (referenceDb !== preparedDb) applyStatementsInTransaction(referenceDb, plan.referenceSql);
    if (commandDb !== preparedDb) {
      for (const command of plan.commands) applyStatementsInTransaction(commandDb, command);
    }

    const digests = tableDigests(preparedDb, plan.columns);
    if (referenceDb !== preparedDb) {
      const problems = compareDigests(tableDigests(referenceDb, plan.columns), digests);
      if (problems.length > 0) throw new Error(`BLOB chunking changed restored content: ${problems.join("; ")}`);
    }
    if (commandDb !== preparedDb) {
      const problems = compareDigests(digests, tableDigests(commandDb, plan.columns));
      if (problems.length > 0) {
        throw new Error(`Command-batched restore differs from the single transaction: ${problems.join("; ")}`);
      }
    }
    const inventory = schemaInventory(preparedDb);
    if (referenceDb !== preparedDb) {
      const referenceInventory = schemaInventory(referenceDb);
      /** @param {{ type: string, name: string, sha256: string }} object */
      const key = (object) => `${object.type}:${object.name}:${object.sha256}`;
      if (referenceInventory.map(key).join("\n") !== inventory.map(key).join("\n")) {
        throw new Error("BLOB chunking changed the restored schema inventory");
      }
    }

    const probes = [
      ...behaviorProbes(preparedDb, { full: fullProbes }),
      ...(fullProbes ? queryPlanProbes(preparedDb) : []),
    ];
    const failedProbes = probes.filter((probe) => !probe.ok);
    if (failedProbes.length > 0) {
      throw new Error(`Offline restore behavior probes failed: ${failedProbes.map((probe) => `${probe.name} (${probe.detail})`).join("; ")}`);
    }

    const migrations = plan.migrations;
    const manifest = {
      tool: "restore-d1-export",
      toolVersion: 1,
      createdAt,
      wranglerVersion,
      source: { name: sourceName, uuid: sourceUuid },
      export: { bytes: Buffer.byteLength(exportSql, "utf8"), sha256: sha256Hex(exportSql) },
      prepared: {
        bytes: Buffer.byteLength(plan.preparedSql, "utf8"),
        sha256: sha256Hex(plan.preparedSql),
        maxStatementBytes,
        maxCommandBytes,
        chunkedStatements: plan.stats.chunkedStatements,
        // Contiguous statement ranges into preparedSql (after the leading
        // PRAGMA). Each range is applied as one atomic D1 command.
        commands: plan.commandRanges,
      },
      schema: {
        head: migrations.at(-1)?.name ?? null,
        migrations,
        objects: inventory,
      },
      tables: plan.columns.map((table) => ({
        name: table.name,
        columns: table.columns,
        primaryKey: table.primaryKey,
        count: digests.get(table.name)?.count ?? 0,
        digest: digests.get(table.name)?.digest ?? "0".repeat(64),
      })),
      stats: plan.stats,
    };
    return { preparedSql: plan.preparedSql, manifest, probes, stats: plan.stats };
  } finally {
    preparedDb.close();
    if (referenceDb !== preparedDb) referenceDb.close();
    if (commandDb !== preparedDb && commandDb !== referenceDb) commandDb.close();
  }
}

/**
 * Assemble the atomic commands recorded in a manifest from the prepared SQL.
 * @param {string} preparedSql @param {ReturnType<typeof prepareRestore>["manifest"]} manifest
 * @returns {string[]}
 */
/** @param {string} preparedSql @param {any} manifest */
export function assembleRestoreCommands(preparedSql, manifest) {
  const statements = splitStatements(preparedSql);
  const pragma = statements[0]?.trim().toUpperCase() === "PRAGMA DEFER_FOREIGN_KEYS=TRUE" ? statements.shift() : null;
  const ranges = manifest.prepared?.commands;
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new Error("Manifest has no command grouping; re-run prepare with this tool version");
  }
  return ranges.map(([start, end]) => {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > statements.length || start >= end) {
      throw new Error(`Invalid command range ${start}-${end} for ${statements.length} prepared statements`);
    }
    const body = statements.slice(start, end).map((statement) => `${statement.trimEnd().replace(/;+$/, "")};`).join("\n");
    return `${DEFER_PRAGMA}\n${body}`;
  });
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
 * Verify an applied target against a prepared manifest: schema inventory,
 * migration head, row counts, content digests, foreign keys, current pointers,
 * and the reviewed query plans. Read-only.
 * @param {{ run: (sql: string) => Array<{ results: Record<string, unknown>[] }> }} runner
 * @param {ReturnType<typeof prepareRestore>["manifest"]} manifest
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
  const digestProblems = [];
  for (const table of manifest.tables) {
    if (table.count === 0) continue;
    const digest = runnerTableDigest(runner, table);
    if (digest.count !== table.count) digestProblems.push(`${table.name}: count ${digest.count} != ${table.count}`);
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
    // One EXPLAIN per runner call: Wrangler's local statement splitter can
    // merge a batched recursive query containing CASE ... END, and a merged
    // result would silently misalign every later plan assertion.
    /** @type {string[]} */
    const planProblems = [];
    for (const query of QUERY_PLANS) {
      try {
        const selected = runner.run(`EXPLAIN QUERY PLAN ${query.sql};`)[0]?.results ?? [];
        assertQueryPlan(query, selected.map((row) => ({ detail: String(row.detail) })), false);
        if (query.probeFrom) {
          const probe = runner.run(`EXPLAIN QUERY PLAN ${coveringProbeSql(query)};`)[0]?.results ?? [];
          assertQueryPlan(query, probe.map((row) => ({ detail: String(row.detail) })));
        } else {
          assertQueryPlan(query, selected.map((row) => ({ detail: String(row.detail) })));
        }
      } catch (error) {
        planProblems.push(error instanceof Error ? error.message : String(error));
      }
    }
    record("reviewed query plans", planProblems.length === 0, planProblems.join("; ") || `${QUERY_PLANS.length} plans match`);
  }

  const problems = checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`);
  return { ok: problems.length === 0, checks, problems };
}

/** @param {{ run: (sql: string) => Array<{ results: Record<string, unknown>[] }> }} runner @param {{ name: string, columns: string[] }} table */
function runnerTableDigest(runner, table) {
  const expression = table.columns.map((column) => `quote(${quoteIdentifier(column)})`).join(" || '|' || ");
  let lastRowid = -1;
  let count = 0;
  let sum = 0n;
  for (;;) {
    const rows = runner.run(
      `SELECT rowid AS __rowid, ${expression} AS __value FROM ${quoteIdentifier(table.name)}
       WHERE rowid > ${lastRowid} ORDER BY rowid LIMIT ${DIGEST_PAGE_ROWS};`,
    )[0]?.results ?? [];
    if (rows.length === 0) break;
    for (const row of rows) {
      sum = (sum + BigInt(`0x${createHash("sha256").update(String(row.__value), "utf8").digest("hex")}`)) & DIGEST_MASK;
      count += 1;
    }
    lastRowid = Number(rows[rows.length - 1].__rowid);
    if (rows.length < DIGEST_PAGE_ROWS) break;
  }
  return { count, digest: sum.toString(16).padStart(64, "0") };
}
