/**
 * Pure SQL-dump tokenizer and transformer used by the D1 export-restoration
 * tool. Wrangler's `d1 export` emits one statement per line for most objects,
 * but a single row can exceed D1's 100 KB statement limit and trigger bodies
 * contain semicolons, so nothing here may assume line or semicolon boundaries.
 *
 * The splitter mirrors the statement-boundary rules Wrangler's own `--file`
 * path applies locally: semicolons split at top level, quotes/comments are
 * opaque, and `BEGIN`/`CASE` ... `END` bodies stay whole.
 */

const TRIGGER_HEAD = /^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i;
const WORD_START = /[A-Za-z_]/;
const WORD = /[A-Za-z_][A-Za-z0-9_$]*/y;

/** Split a SQL script into trimmed, non-empty statements.
 *
 * Semicolons split at top level. A `CREATE TRIGGER ... BEGIN ... END` body is
 * kept whole; inside it, `CASE ... END` expressions are tracked so the body's
 * own `END` is the one that closes the trigger.
 * @param {string} sql @returns {string[]}
 */
export function splitStatements(sql) {
  /** @type {string[]} */
  const statements = [];
  let current = "";
  let inTriggerBody = false;
  let caseDepth = 0;
  const flush = () => {
    const statement = current.trim();
    if (statement.length > 0) statements.push(statement);
    current = "";
  };
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === "'" || char === '"' || char === "`") {
      current += char;
      index += 1;
      while (index < sql.length) {
        current += sql[index];
        if (sql[index] === char) {
          if (sql[index + 1] === char) {
            current += sql[index + 1];
            index += 1;
          } else {
            break;
          }
        }
        index += 1;
      }
      continue;
    }
    if (char === "[") {
      current += char;
      index += 1;
      while (index < sql.length) {
        current += sql[index];
        if (sql[index] === "]") break;
        index += 1;
      }
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") {
        current += sql[index];
        index += 1;
      }
      if (index < sql.length) current += sql[index];
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      current += "/*";
      index += 1;
      while (index < sql.length) {
        current += sql[index];
        if (sql[index] === "*" && sql[index + 1] === "/") {
          current += "/";
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (WORD_START.test(char)) {
      WORD.lastIndex = index;
      const word = WORD.exec(sql)?.[0] ?? char;
      const upper = word.toUpperCase();
      if (inTriggerBody) {
        if (upper === "CASE") caseDepth += 1;
        else if (upper === "END") {
          if (caseDepth > 0) caseDepth -= 1;
          else inTriggerBody = false;
        }
      } else if (upper === "BEGIN" && TRIGGER_HEAD.test(current.trimStart())) {
        inTriggerBody = true;
        caseDepth = 0;
      }
      current += word;
      index += word.length - 1;
      continue;
    }
    if (char === ";") {
      if (inTriggerBody) current += char;
      else flush();
      continue;
    }
    current += char;
  }
  flush();
  return statements;
}

/** Read a possibly quoted identifier at `position` (after leading spaces).
 * @param {string} text @param {number} position
 * @returns {{ name: string, end: number } | null}
 */
function readIdentifier(text, position) {
  let index = position;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  const char = text[index];
  if (char === '"' || char === "`" || char === "'") {
    let name = "";
    index += 1;
    while (index < text.length) {
      if (text[index] === char) {
        if (text[index + 1] === char) {
          name += char;
          index += 2;
          continue;
        }
        return { name, end: index + 1 };
      }
      name += text[index];
      index += 1;
    }
    return null;
  }
  if (char === "[") {
    const end = text.indexOf("]", index + 1);
    if (end < 0) return null;
    return { name: text.slice(index + 1, end), end: end + 1 };
  }
  const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text.slice(index));
  if (!match) return null;
  return { name: match[0], end: index + match[0].length };
}

/** Find the next occurrence of a keyword at top level (outside quotes/parens).
 * @param {string} text @param {string} keyword @param {number} from
 * @returns {number} index or -1
 */
function findTopLevelKeyword(text, keyword, from) {
  let depth = 0;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" || char === '"' || char === "`") {
      index = skipQuoted(text, index, char);
      continue;
    }
    if (char === "[") {
      const end = text.indexOf("]", index + 1);
      if (end < 0) return -1;
      index = end;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      continue;
    }
    if (depth === 0 && text.slice(index, index + keyword.length).toUpperCase() === keyword
      && !/[A-Za-z0-9_$]/.test(text[index - 1] ?? "") && !/[A-Za-z0-9_$]/.test(text[index + keyword.length] ?? "")) {
      return index;
    }
  }
  return -1;
}

/** @param {string} text @param {number} index @param {string} quote */
function skipQuoted(text, index, quote) {
  index += 1;
  while (index < text.length) {
    if (text[index] === quote) {
      if (text[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index;
    }
    index += 1;
  }
  return text.length - 1;
}

/** @param {string} statement */
export function classifyStatement(statement) {
  const head = statement.trim();
  if (/^CREATE\s+TABLE\b/i.test(head)) return { kind: "table" };
  if (/^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(head)) return { kind: "index" };
  if (/^CREATE\s+(TEMP\s+|TEMPORARY\s+)?VIEW\b/i.test(head)) return { kind: "view" };
  if (/^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(head)) return { kind: "trigger" };
  if (/^INSERT\s+INTO\b/i.test(head)) return { kind: "insert", table: parseInsert(head)?.table ?? null };
  if (/^DELETE\s+FROM\b/i.test(head)) {
    const identifier = readIdentifier(head, "DELETE FROM".length);
    return { kind: "delete", table: identifier?.name ?? null };
  }
  if (/^PRAGMA\b/i.test(head)) return { kind: "pragma" };
  if (/^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(head)) return { kind: "transaction" };
  return { kind: "other", head: head.slice(0, 60) };
}

/**
 * Parse `INSERT INTO t (cols) VALUES (...), (...)` (D1 export shape).
 * Returns null for INSERT ... SELECT or other unsupported shapes.
 * @param {string} statement
 * @returns {{ table: string, columns: string[] | null, tuples: string[], suffix: string } | null}
 */
export function parseInsert(statement) {
  const head = statement.trim();
  if (!/^INSERT\s+INTO\b/i.test(head)) return null;
  const table = readIdentifier(head, "INSERT INTO".length);
  if (!table) return null;
  let position = table.end;
  while (position < head.length && /\s/.test(head[position])) position += 1;
  /** @type {string[] | null} */
  let columns = null;
  if (head[position] === "(") {
    const end = matchingParen(head, position);
    if (end < 0) return null;
    const body = head.slice(position + 1, end);
    /** @type {string[]} */
    const names = [];
    for (const item of splitTopLevel(body)) {
      const identifier = readIdentifier(item, 0);
      if (!identifier || identifier.end !== item.trim().length) return null;
      names.push(identifier.name);
    }
    columns = names;
    position = end + 1;
  }
  const valuesIndex = findTopLevelKeyword(head, "VALUES", position);
  if (valuesIndex < 0) return null;
  const tuplesStart = valuesIndex + "VALUES".length;
  const tuplesEnd = findTuplesEnd(head, tuplesStart);
  if (tuplesEnd < 0) return null;
  const tuples = splitTuples(head.slice(tuplesStart, tuplesEnd));
  if (tuples.length === 0) return null;
  const suffix = head.slice(tuplesEnd).trim();
  return { table: table.name, columns, tuples, suffix };
}

/** @param {string} text @param {number} open @returns {number} matching `)` index */
function matchingParen(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" || char === '"' || char === "`") {
      index = skipQuoted(text, index, char);
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Index just past the final tuple in a VALUES list. @param {string} text @param {number} from */
function findTuplesEnd(text, from) {
  let index = from;
  let lastEnd = -1;
  while (index < text.length) {
    while (index < text.length && /[\s,]/.test(text[index])) index += 1;
    if (text[index] !== "(") break;
    const end = matchingParen(text, index);
    if (end < 0) return -1;
    lastEnd = end + 1;
    index = end + 1;
  }
  return lastEnd;
}

/** Split a VALUES body into raw `(...)` tuples. @param {string} text @returns {string[]} */
export function splitTuples(text) {
  const tuples = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /[\s,]/.test(text[index])) index += 1;
    if (index >= text.length) break;
    if (text[index] !== "(") break;
    const end = matchingParen(text, index);
    if (end < 0) break;
    tuples.push(text.slice(index, end + 1));
    index = end + 1;
  }
  return tuples;
}

/** Split a raw `(...)` tuple body into raw value texts. @param {string} tuple */
export function splitValues(tuple) {
  const trimmed = tuple.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
    throw new Error(`Not a value tuple: ${tuple.slice(0, 40)}`);
  }
  return splitTopLevel(trimmed.slice(1, -1));
}

/** Split on commas at top level, keeping quotes and nested parens opaque.
 * @param {string} text @returns {string[]}
 */
export function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" || char === '"' || char === "`") {
      index = skipQuoted(text, index, char);
      continue;
    }
    if (char === "[") {
      const end = text.indexOf("]", index + 1);
      index = end < 0 ? text.length : end;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/** Recognize an `X'hex'` literal. @param {string} value @returns {string | null} hex body */
export function blobLiteralHex(value) {
  const match = /^[xX]'([0-9a-fA-F]*)'$/.exec(value.trim());
  return match ? match[1] : null;
}

/** Escape a string for a regular expression. @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Columns whose CHECK constraint derives them from a BLOB's byte length, e.g.
 * `` `ciphertext_size` = length(`ciphertext`) ``. A chunked insert must keep
 * these in lockstep with the appended bytes or the CHECK rejects each step.
 * @param {string | undefined} ddl @param {string} blobColumn @param {string[]} columns
 * @param {string[]} values @param {number} blobLength
 */
function lengthCoupledColumns(ddl, blobColumn, columns, values, blobLength) {
  // SQLite exposes no pragma for CHECK expressions, so this reads the stored
  // DDL text (the same text SQLite itself keeps in sqlite_schema). It is a
  // deliberate best-effort: a value that disagrees with the BLOB length is
  // left untouched and the target surfaces any real violation.
  if (!ddl) return [];
  // The committed Drizzle DDL qualifies names, e.g.
  // `"table"."size" = length("table"."blob")`; Wrangler's export preserves it.
  const quoted = "[`\"\\[]?";
  const quotedEnd = "[`\"\\]]?";
  const identifier = `${quoted}([A-Za-z_][A-Za-z0-9_]*)${quotedEnd}`;
  const qualifier = `(?:${quoted}[A-Za-z_][A-Za-z0-9_]*${quotedEnd}\\s*\\.\\s*)?`;
  const blob = `${quoted}${escapeRegExp(blobColumn)}${quotedEnd}`;
  const pattern = new RegExp(`${identifier}\\s*=\\s*length\\s*\\(\\s*${qualifier}${blob}\\s*\\)`, "i");
  const coupled = pattern.exec(ddl)?.[1];
  if (!coupled || coupled === blobColumn) return [];
  const index = columns.indexOf(coupled);
  if (index < 0) return [];
  // Only trust the coupling when the exported value actually equals the
  // BLOB's byte length; otherwise leave the column untouched and let the
  // target surface any real violation.
  return Number(values[index]) === blobLength ? [coupled] : [];
}

/** @param {string} identifier */
function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** @param {string} value */
function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

/** Build a single INSERT statement from parsed parts.
 * @param {string} table @param {string[] | null} columns @param {string[]} tuples @param {string} suffix
 */
function buildInsert(table, columns, tuples, suffix) {
  const columnList = columns ? ` (${columns.map(quoteIdentifier).join(",")})` : "";
  return `INSERT INTO ${quoteIdentifier(table)}${columnList} VALUES${tuples.join(",")}${suffix ? ` ${suffix}` : ""}`;
}

/** Normalize multi-row INSERTs into one statement per row so every row is
 * addressable in the restore dependency graph.
 * @param {string[]} statements @returns {string[]}
 */
export function splitMultiRowStatements(statements) {
  return statements.flatMap((statement) => {
    const parsed = parseInsert(statement);
    if (!parsed || parsed.tuples.length <= 1) return [statement];
    return parsed.tuples.map((tuple) => buildInsert(parsed.table, parsed.columns, [tuple], parsed.suffix));
  });
}

/**
 * Ensure every emitted statement fits D1's statement-length limit.
 *
 * - Multi-row INSERTs are split into one statement per row.
 * - A single row whose only oversized value is a hex BLOB literal is inserted
 *   with an empty BLOB and completed with chunked `unhex(hex(..) || '..')`
 *   appends addressed by the row's primary key.
 * - Anything else that is too large fails loudly; nothing is silently dropped.
 *
 * @param {string[]} statements
 * @param {{ maxBytes: number, primaryKeys: Map<string, string[]>, tableDdl?: Map<string, string>, maxBlobBytes?: number }} options
 * @returns {{ statements: string[], units: Array<{ statements: string[] }>, chunked: number }}
 */
export function chunkOversizedStatements(statements, { maxBytes, primaryKeys, tableDdl = new Map(), maxBlobBytes = Number.MAX_SAFE_INTEGER }) {
  /** @type {Array<{ statements: string[] }>} */
  const units = [];
  let chunked = 0;
  for (const statement of statements) {
    if (byteLength(statement) <= maxBytes) {
      units.push({ statements: [statement] });
      continue;
    }
    chunked += 1;
    units.push({ statements: chunkStatement(statement, { maxBytes, primaryKeys, tableDdl, maxBlobBytes }) });
  }
  return { statements: units.flatMap((unit) => unit.statements), units, chunked };
}

/** @param {string} statement @param {{ maxBytes: number, primaryKeys: Map<string, string[]>, tableDdl: Map<string, string>, maxBlobBytes: number }} options
 * @returns {string[]}
 */
function chunkStatement(statement, { maxBytes, primaryKeys, tableDdl, maxBlobBytes }) {
  const parsed = parseInsert(statement);
  if (!parsed) {
    throw new Error(
      `Statement of ${byteLength(statement)} bytes exceeds the ${maxBytes}-byte limit and cannot split: not an INSERT: ${statement.slice(0, 80)}...`,
    );
  }
  if (parsed.tuples.length > 1) {
    const singleRow = parsed.tuples.map((tuple) => buildInsert(parsed.table, parsed.columns, [tuple], parsed.suffix));
    if (singleRow.every((row) => byteLength(row) <= maxBytes)) return singleRow;
    return singleRow.flatMap((row) => chunkStatement(row, { maxBytes, primaryKeys, tableDdl, maxBlobBytes }));
  }

  const parsedColumns = parsed.columns;
  if (!parsedColumns) {
    throw new Error(`Cannot chunk a BLOB without an explicit column list in ${parsed.table}`);
  }
  const values = splitValues(parsed.tuples[0]);
  const oversizedBlobs = values.flatMap((value, index) => {
    const hex = blobLiteralHex(value);
    if (hex === null || byteLength(value) <= maxBytes) return [];
    const totalBytes = hex.length / 2;
    if (totalBytes > maxBlobBytes) {
      throw new Error(`BLOB of ${totalBytes} bytes in ${parsed.table} exceeds D1's ${maxBlobBytes}-byte row limit`);
    }
    return [{
      index,
      hex,
      column: parsedColumns[index],
      totalBytes,
      coupled: lengthCoupledColumns(tableDdl.get(parsed.table), parsedColumns[index], parsedColumns, values, totalBytes),
    }];
  });
  if (oversizedBlobs.length === 0) {
    throw new Error(
      `Statement of ${byteLength(statement)} bytes exceeds the ${maxBytes}-byte limit and cannot split: no oversized BLOB literal: ${statement.slice(0, 80)}...`,
    );
  }
  const primaryKey = primaryKeys.get(parsed.table);
  if (!primaryKey || primaryKey.length === 0) {
    throw new Error(`Cannot chunk a BLOB in ${parsed.table}: no primary key is known`);
  }
  const where = primaryKey.map((column) => {
    const index = parsedColumns.indexOf(column);
    if (index < 0) {
      throw new Error(`Cannot chunk ${parsed.table}: primary key column ${column} is absent from the INSERT`);
    }
    return `${quoteIdentifier(column)} = ${values[index]}`;
  }).join(" AND ");

  // The INSERT carries a first chunk for every oversized BLOB so NOT NULL and
  // `size = length(blob)` CHECK constraints hold from the first statement.
  const placeholder = values.map((value, index) => {
    const blob = oversizedBlobs.find((entry) => entry.index === index);
    if (blob) return "X''";
    return value;
  });
  const coupledIndexes = new Set(
    oversizedBlobs.flatMap((blob) => blob.coupled.map((column) => parsedColumns.indexOf(column))),
  );
  for (const index of coupledIndexes) placeholder[index] = "0";
  const placeholderBytes = byteLength(buildInsert(parsed.table, parsedColumns, [`(${placeholder.join(",")})`], parsed.suffix));
  const budget = maxBytes - placeholderBytes - 64;
  const firstChunkBytes = Math.floor(budget / (2 * oversizedBlobs.length));
  if (firstChunkBytes < 64) {
    throw new Error(`No room to chunk ${parsed.table} BLOBs within ${maxBytes} bytes`);
  }

  const firstChunks = oversizedBlobs.map((blob) => {
    const bytes = Math.min(firstChunkBytes, blob.totalBytes);
    return { hex: blob.hex.slice(0, bytes * 2), bytes };
  });
  const firstValues = values.map((value, index) => {
    const position = oversizedBlobs.findIndex((entry) => entry.index === index);
    if (position >= 0) return `X'${firstChunks[position].hex}'`;
    return value;
  });
  oversizedBlobs.forEach((blob, position) => {
    for (const column of blob.coupled) firstValues[parsedColumns.indexOf(column)] = String(firstChunks[position].bytes);
  });
  const output = [buildInsert(parsed.table, parsedColumns, [`(${firstValues.join(",")})`], parsed.suffix)];

  for (const [position, blob] of oversizedBlobs.entries()) {
    const column = blob.column;
    // SQLite's `||` converts BLOBs to TEXT and mangles invalid UTF-8, so append
    // through hex text and `unhex()` (SQLite 3.43+, available in D1) to keep the
    // exact bytes and the BLOB type.
    const coupledSample = blob.coupled.map((coupled) => `, ${quoteIdentifier(coupled)} = ${blob.totalBytes}`).join("");
    const sample = `UPDATE ${quoteIdentifier(parsed.table)} SET ${quoteIdentifier(column)} = unhex(hex(${quoteIdentifier(column)}) || '')${coupledSample} WHERE ${where}`;
    const chunkBytes = Math.floor((maxBytes - byteLength(sample) - 16) / 2);
    if (chunkBytes < 64) {
      throw new Error(`No room to chunk ${parsed.table}.${column} within ${maxBytes} bytes`);
    }
    let running = firstChunks[position].bytes;
    for (let offset = firstChunks[position].hex.length; offset < blob.hex.length; offset += chunkBytes * 2) {
      const chunk = blob.hex.slice(offset, offset + chunkBytes * 2);
      running += chunk.length / 2;
      const assignments = [`${quoteIdentifier(column)} = unhex(hex(${quoteIdentifier(column)}) || '${chunk}')`];
      for (const coupled of blob.coupled) assignments.push(`${quoteIdentifier(coupled)} = ${running}`);
      output.push(`UPDATE ${quoteIdentifier(parsed.table)} SET ${assignments.join(", ")} WHERE ${where}`);
    }
  }
  return output;
}
