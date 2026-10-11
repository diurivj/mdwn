/** Test-only Node --import boundary. Never runs a real command or connects remotely.
 * MDWN_SCRIPT_SCENARIO accepts failCommand/failRemove/failWrite regex strings,
 * ambiguousCreate, ambiguousDeploy, failExport, failSchema, and borrowed (true or { name, uuid }).
 * MDWN_SCRIPT_REPORT receives commands, mkdtemp directories, path/mode snapshots,
 * and D1 deletion bindings { kind, name, uuid }. Contents/stderr are never printed.
 */
import childProcess from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import timers from "node:timers";
import timerPromises from "node:timers/promises";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

/** @typedef {import("node:sqlite").DatabaseSync} FixtureDatabase */
/** @typedef {{ binding: string, database_name: string, database_id: string, migrations_dir?: string }} D1Binding */
/** @typedef {{ name?: string, d1_databases?: D1Binding[], env?: Record<string, { d1_databases?: D1Binding[] }> }} FixtureConfig */
// A runtime import keeps Node-only planning modules out of the Workers TS project
// that includes tests/support; this still calls the public SQL-runner implementation.
/** @type {{ createSqliteRunner: (db: FixtureDatabase) => { run: (sql: string) => Array<{ results: Record<string, unknown>[] }> }, openOfflineDatabase: () => FixtureDatabase }} */
const { createSqliteRunner, openOfflineDatabase } = await import(
  new URL("../../scripts/lib/d1-export-restore.mjs", import.meta.url).href
);

/** @type {{ failCommand?: string, failRemove?: string, failWrite?: string,
 * ambiguousCreate?: boolean, ambiguousDeploy?: boolean, failExport?: boolean, failSchema?: boolean,
 * borrowed?: boolean | { name: string, uuid: string }, cleanupMessage?: string }} */
const scenario = JSON.parse(process.env.MDWN_SCRIPT_SCENARIO ?? "{}");
/** @type {string[][]} */
const commands = [];
/** @type {string[]} */
const directories = [];
/** @type {Array<{ path: string, mode: number }>} */
const writes = [];
/** @type {Array<{ kind: "D1", name: string, uuid: string }>} */
const deletions = [];
const failCommand = scenario.failCommand ? new RegExp(scenario.failCommand) : null;
const failRemove = scenario.failRemove ? new RegExp(scenario.failRemove) : null;
const failWrite = scenario.failWrite ? new RegExp(scenario.failWrite) : null;
const original = {
  mkdtemp: fs.mkdtempSync,
  mkdir: fs.mkdirSync,
  open: fs.openSync,
  close: fs.closeSync,
  write: fs.writeFileSync,
  read: fs.readFileSync,
  readdir: fs.readdirSync,
  lstat: fs.lstatSync,
  fstat: fs.fstatSync,
  realpath: fs.realpathSync,
  remove: fs.rmSync,
  removeCallback: fs.rm,
  removePromise: fs.promises.rm,
  setImmediate: timers.setImmediate,
  setTimeout: timers.setTimeout,
};
const workingDirectory = original.realpath(process.cwd());
const testRoots = new Set([workingDirectory]);
const committedMigrations = original.realpath(fileURLToPath(new URL("../../drizzle", import.meta.url)));
/** @type {Map<number, string>} */
const openFiles = new Map();
/** @type {Map<string, number>} */
const lastModes = new Map();
/** @type {Map<string, FixtureDatabase>} */
const databases = new Map();
let nextDatabase = 1;
let nextVersion = 1;
// Deliberately permissive: raw producers must rely on the caller's protection.
process.umask(0);

/** @param {string} root @param {string} path */
function within(root, path) {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

/** @param {string} path */
function inTestDirectories(path) {
  return [...testRoots].some((root) => within(root, path));
}

/** @param {import("node:fs").PathLike} path */
function absolutePath(path) {
  return resolve(path instanceof URL ? fileURLToPath(path) : String(path));
}

/** Only fixture configs/outputs inside the sandbox may be opened. No auth files.
 * @param {string} path
 */
function fixturePath(path) {
  const absolute = resolve(path);
  // Resolve existing ancestors so macOS /var and /private/var aliases agree.
  let ancestor = absolute;
  for (;;) {
    try {
      if (!inTestDirectories(original.realpath(ancestor))) {
        throw new Error("Controlled fixture path escapes through a symlink");
      }
      return absolute;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
}

/** Record actual inode permissions, also when a failed write leaves a partial file.
 * @param {import("node:fs").PathOrFileDescriptor} target
 * @param {boolean} [onlyChanged]
 */
function snapshot(target, onlyChanged = false) {
  const path = typeof target === "number" ? openFiles.get(target) : absolutePath(target);
  if (!path) return null;
  try {
    const canonical = original.realpath(path);
    if (!inTestDirectories(canonical)) return null;
    const stat = typeof target === "number" ? original.fstat(target) : original.lstat(path);
    if (!stat.isFile()) return null;
    const mode = stat.mode & 0o777;
    if (!onlyChanged || lastModes.get(canonical) !== mode) writes.push({ path: canonical, mode });
    lastModes.set(canonical, mode);
    return canonical;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
    return null;
  }
}

/** @param {string | null} path */
function failWriteAfterTouch(path) {
  if (path && failWrite?.test(path)) throw new Error("injected artifact write failure after touching the file");
}

fs.mkdtempSync = (...args) => {
  const path = Reflect.apply(original.mkdtemp, fs, args);
  directories.push(String(path));
  testRoots.add(original.realpath(path));
  return path;
};
fs.openSync = (path, flags, ...args) => {
  const fd = original.open(path, flags, ...args);
  const writable =
    typeof flags === "number"
      ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR))
      : /^[wa]/.test(flags) || flags.includes("+");
  if (writable) openFiles.set(fd, absolutePath(path));
  return fd;
};
fs.closeSync = (fd) => {
  try {
    if (openFiles.has(fd)) snapshot(fd, true);
  } finally {
    openFiles.delete(fd);
    original.close(fd);
  }
};
fs.writeFileSync = (target, ...args) => {
  let path;
  try {
    original.write(target, ...args);
  } finally {
    path = snapshot(target);
  }
  failWriteAfterTouch(path);
};
fs.rmSync = (path, options) => {
  if (failRemove?.test(String(path))) throw new Error(scenario.cleanupMessage ?? "injected artifact cleanup failure");
  return original.remove(path, options);
};
/** @param {import("node:fs").PathLike} path
 * @param {import("node:fs").RmOptions | import("node:fs").NoParamCallback} options
 * @param {import("node:fs").NoParamCallback} [callback]
 */
function removeCallback(path, options, callback) {
  const done = typeof options === "function" ? options : callback;
  if (!done) throw new TypeError("Controlled fs.rm requires a callback");
  if (failRemove?.test(String(path))) {
    original.setImmediate(done, new Error(scenario.cleanupMessage ?? "injected artifact cleanup failure"));
    return;
  }
  original.removeCallback(path, typeof options === "function" ? {} : options, done);
}
fs.rm = /** @type {typeof fs.rm} */ (removeCallback);
fs.promises.rm = async (path, options) => {
  if (failRemove?.test(String(path))) throw new Error(scenario.cleanupMessage ?? "injected artifact cleanup failure");
  return original.removePromise(path, options);
};

/** Fixture writes bypass the patched writer but still report actual permissions.
 * Do not pass a protective mode: export/build emulate a default-mode producer.
 * @param {string} path @param {string} contents
 */
function writeFixture(path, contents) {
  const target = fixturePath(path);
  original.mkdir(dirname(target), { recursive: true });
  let touched;
  try {
    original.write(target, contents);
  } finally {
    touched = snapshot(target);
  }
  failWriteAfterTouch(touched);
}

/** @param {string[]} tokens @param {string} name */
function option(tokens, name) {
  const inline = tokens.find((token) => token.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const index = tokens.indexOf(name);
  return index < 0 ? undefined : tokens[index + 1];
}

/** @param {string} path @returns {FixtureConfig} */
function readConfig(path) {
  return JSON.parse(original.read(fixturePath(path), "utf8"));
}

/** Per-config state (or smoke's persist directory/environment), never real D1 state.
 * @param {string[]} tokens @param {string} cwd
 */
function databaseFor(tokens, cwd) {
  const config = option(tokens, "--config");
  const persist = option(tokens, "--persist-to");
  const environment = option(tokens, "--env") ?? "";
  const key = JSON.stringify([
    resolve(cwd, config ?? "wrangler.jsonc"),
    persist ? resolve(cwd, persist) : null,
    environment,
    tokens.includes("--local") ? "local" : "remote",
    tokens[tokens[1] === "migrations" ? 3 : 2],
  ]);
  let db = databases.get(key);
  if (!db) {
    db = openOfflineDatabase();
    databases.set(key, db);
  }
  return db;
}

/** @param {FixtureDatabase} db @param {() => T} run
 * @template T
 */
function atomic(db, run) {
  db.exec("BEGIN;");
  try {
    const result = run();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

/** Apply the committed SQL, with Wrangler's real migration-journal shape and no-op reapply.
 * @param {FixtureDatabase} db @param {string[]} tokens @param {string} cwd
 */
function applyMigrations(db, tokens, cwd) {
  const configPath = option(tokens, "--config");
  /** @type {FixtureConfig} */
  const config = configPath ? readConfig(resolve(cwd, configPath)) : {};
  const environment = option(tokens, "--env");
  const binding = (environment ? config.env?.[environment] : config)?.d1_databases?.find(
    (entry) => entry.binding === tokens[3],
  );
  const migrationDirectory = original.realpath(
    resolve(configPath ? dirname(resolve(cwd, configPath)) : cwd, binding?.migrations_dir ?? "drizzle"),
  );
  if (migrationDirectory !== committedMigrations)
    throw new Error("Controlled migrations must use committed drizzle SQL");
  db.exec(`CREATE TABLE IF NOT EXISTS "d1_migrations"(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  );`);
  const applied = new Set(
    db
      .prepare("SELECT name FROM d1_migrations")
      .all()
      .map((row) => row.name),
  );
  for (const file of original
    .readdir(migrationDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    if (applied.has(file)) continue;
    atomic(db, () => {
      db.exec(original.read(join(migrationDirectory, file), "utf8"));
      db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, '2026-01-01 00:00:00')").run(file);
    });
  }
}

/** @param {string} identifier */
function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Emulate docs/operations/d1-scripting.md#export-shape.
 * SQLite quote() preserves fixture values without JS coercion.
 * @param {FixtureDatabase} db
 */
function exportDatabase(db) {
  const objects = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid",
    )
    .all();
  const statements = ["PRAGMA defer_foreign_keys=TRUE;"];
  /** @param {string} name */
  const rows = (name) => {
    const columns = db
      .prepare(`PRAGMA table_info(${quoteIdentifier(name)})`)
      .all()
      .map((column) => String(column.name));
    if (!columns.length) return [];
    const values = columns.map((column) => `quote(${quoteIdentifier(column)})`).join(" || ',' || ");
    const prefix = `INSERT INTO ${quoteIdentifier(name)} (${columns.map(quoteIdentifier).join(",")}) VALUES(`;
    return db
      .prepare(
        `SELECT '${prefix.replaceAll("'", "''")}' || ${values} || ');' AS statement FROM ${quoteIdentifier(name)}`,
      )
      .all()
      .map((row) => String(row.statement));
  };
  for (const table of objects.filter((object) => object.type === "table")) {
    statements.push(`${table.sql};`, ...rows(String(table.name)));
  }
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'").get()) {
    statements.push("DELETE FROM sqlite_sequence;", ...rows("sqlite_sequence"));
  }
  for (const type of ["index", "trigger", "view"]) {
    for (const object of objects.filter((entry) => entry.type === type)) statements.push(`${object.sql};`);
  }
  return `${statements.join("\n")}\n`;
}

/** @param {number} status @param {string} [stdout] @param {string} [stderr]
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function result(status, stdout = "", stderr = "") {
  return { status, stdout, stderr, pid: 1, signal: null, output: [null, stdout, stderr] };
}

/** The scripts request UTF-8 output, not the builtin's Buffer overloads.
 * @param {string} command @param {string[]} [args]
 * @param {import("node:child_process").SpawnSyncOptions} [options]
 */
function controlledSpawnSync(command, args = [], options = {}) {
  const tokens =
    command === "npx" ? args.filter((arg) => arg !== "--no-install" && arg !== "wrangler") : [command, ...args];
  commands.push(tokens);
  const supported =
    (command === "npx" || command === tokens[0]) &&
    (tokens[0] === "whoami" ||
      tokens[0] === "--version" ||
      (tokens[0] === "d1" && ["create", "list", "delete", "execute", "export"].includes(tokens[1])) ||
      (tokens[0] === "d1" && tokens[1] === "migrations" && tokens[2] === "apply") ||
      (tokens[0] === "d1" && tokens[1] === "time-travel" && tokens[2] === "info") ||
      tokens[0] === "delete" ||
      tokens[0] === "deploy" ||
      (tokens[0] === "react-router" && tokens[1] === "build") ||
      (tokens[0] === "vitest" && tokens[1] === "run"));
  if (!supported) throw new Error("Unexpected controlled command (no real subprocess is permitted)");
  const cwd = options.cwd ? absolutePath(options.cwd) : process.cwd();
  // Persistence contract: docs/operations/d1-scripting.md#resource-identities-and-command-output.
  // Keep the emulated diagnostic side effect in the sandbox, never the user's home.
  if (args.includes("wrangler") && options.env?.WRANGLER_WRITE_LOGS !== "false") {
    writeFixture(join(cwd, "wrangler-raw.test.log"), "SENSITIVE_SUBPROCESS_SENTINEL");
  }
  if (tokens[0] === "d1" && tokens[1] === "delete") {
    const configPath = option(tokens, "--config");
    if (!configPath) throw new Error("Controlled D1 deletion requires a UUID-bound --config");
    const binding = readConfig(resolve(cwd, configPath)).d1_databases?.find((entry) => entry.binding === tokens[2]);
    if (typeof binding?.database_name !== "string" || typeof binding?.database_id !== "string") {
      throw new Error("Controlled D1 deletion requires a named database and confirmed UUID");
    }
    deletions.push({ kind: "D1", name: binding.database_name, uuid: binding.database_id });
  }
  if (failCommand?.test(tokens.join(" "))) return result(9, "", "SENSITIVE_SUBPROCESS_SENTINEL");
  if (tokens[0] === "whoami") return result(0, "Account ID │ aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  if (tokens[0] === "--version") return result(0, "wrangler 4.135.0\n");
  if (tokens[0] === "d1" && tokens[1] === "create") {
    const uuid = `10000000-0000-4000-8000-${String(nextDatabase++).padStart(12, "0")}`;
    return result(
      0,
      scenario.ambiguousCreate ? "created without a binding identifier" : JSON.stringify({ database_id: uuid }),
    );
  }
  if (tokens[0] === "d1" && tokens[1] === "list") {
    const borrowed =
      scenario.borrowed === true
        ? { name: "mdwn-import-proof-db-borrowed", uuid: "20000000-0000-4000-8000-000000000001" }
        : scenario.borrowed;
    return result(0, JSON.stringify(borrowed ? [borrowed] : []));
  }
  if (tokens[0] === "delete" || (tokens[0] === "d1" && tokens[1] === "delete")) return result(0);
  if (tokens[0] === "react-router") {
    const configPath = options.env?.WRANGLER_CONFIG;
    if (!configPath) throw new Error("Controlled build requires WRANGLER_CONFIG in its command environment");
    writeFixture(join(cwd, "build/server/wrangler.json"), `${JSON.stringify(readConfig(resolve(cwd, configPath)))}\n`);
    return result(0);
  }
  if (tokens[0] === "deploy") {
    const configPath = option(tokens, "--config") ?? "build/server/wrangler.json";
    const { name } = readConfig(resolve(cwd, configPath));
    if (typeof name !== "string" || !/^[a-z0-9-]+$/.test(name))
      throw new Error("Controlled deploy requires a Worker name");
    const version = `30000000-0000-4000-8000-${String(nextVersion++).padStart(12, "0")}`;
    return result(
      0,
      `https://${name}.operational-fixture.workers.dev\n${scenario.ambiguousDeploy ? "" : `Current Version ID: ${version}\n`}`,
    );
  }
  if (tokens[0] === "vitest") return result(0);
  if (tokens[1] === "time-travel")
    return result(0, JSON.stringify({ bookmark: "00000000-00000000-00000000-00000001" }));
  const db = databaseFor(tokens, cwd);
  if (tokens[1] === "migrations") {
    applyMigrations(db, tokens, cwd);
    return result(0);
  }
  if (tokens[1] === "export") {
    const output = option(tokens, "--output");
    if (!output) throw new Error("Controlled export requires --output");
    writeFixture(
      resolve(cwd, output),
      scenario.failExport ? "PRAGMA defer_foreign_keys=TRUE;\n-- partial controlled export\n" : exportDatabase(db),
    );
    return scenario.failExport ? result(9, "", "SENSITIVE_SUBPROCESS_SENTINEL") : result(0);
  }
  if (option(tokens, "--file")) return result(0, JSON.stringify([{ success: true, results: [] }]));
  const sql = option(tokens, "--command");
  if (!sql) throw new Error("Controlled D1 execute requires --command or --file");
  if (scenario.failSchema && /^\s*SELECT\s+'table:'\s*\|\|/.test(sql)) {
    return result(0, JSON.stringify([{ results: [] }]));
  }
  try {
    const entries = atomic(db, () => createSqliteRunner(db).run(sql));
    return result(
      0,
      JSON.stringify(
        entries.map((entry) => ({ ...entry, success: true })),
        (_key, value) => (value instanceof Uint8Array ? Array.from(value) : value),
      ),
    );
  } catch {
    return result(1, "", "Controlled D1 SQL execution failed");
  }
}
childProcess.spawnSync = /** @type {typeof childProcess.spawnSync} */ (controlledSpawnSync);

// Reject alternate external APIs as well: no fallback subprocess or socket may escape.
const blocked = () => {
  throw new Error("Unexpected external API in controlled operational command");
};
Object.assign(childProcess, {
  spawn: blocked,
  exec: blocked,
  execSync: blocked,
  execFile: blocked,
  execFileSync: blocked,
  fork: blocked,
});
http.request = http.get = https.request = https.get = blocked;
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = dgram.createSocket = blocked;
globalThis.fetch = async () => new Response("User-agent: *\nDisallow: /\n", { status: 200 });
// Keep real cancellable timer handles, but never wait on readiness delays.
/** @template {unknown[]} T
 * @param {(...args: T) => void} callback @param {number} [_delay] @param {T} args
 */
function immediateTimeout(callback, _delay, ...args) {
  return original.setTimeout(callback, 0, ...args);
}
/** @template [T=void]
 * @param {number} [_delay] @param {T} [value] @param {import("node:timers").TimerOptions} [options]
 * @returns {Promise<T>}
 */
async function immediateDelay(_delay, value, options) {
  if (options?.signal?.aborted) throw options.signal.reason;
  return /** @type {T} */ (value);
}
timers.setTimeout = /** @type {typeof timers.setTimeout} */ (immediateTimeout);
globalThis.setTimeout = timers.setTimeout;
timerPromises.setTimeout = immediateDelay;
syncBuiltinESMExports();

/** Do not follow symlinks (notably drizzle/node_modules) out of the test sandbox.
 * Only metadata is collected, never file contents.
 * @param {string} path @param {Set<string>} visited
 */
function snapshotSurvivors(path, visited) {
  if (visited.has(path)) return;
  visited.add(path);
  try {
    const stat = original.lstat(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) snapshot(path, true);
    else if (stat.isDirectory()) {
      for (const name of original.readdir(path).sort()) snapshotSurvivors(join(path, name), visited);
    }
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
  }
}

process.on("exit", () => {
  const visited = new Set();
  for (const root of [workingDirectory, ...directories]) snapshotSurvivors(root, visited);
  for (const db of databases.values()) db.close();
  if (process.env.MDWN_SCRIPT_REPORT) {
    original.write(process.env.MDWN_SCRIPT_REPORT, JSON.stringify({ commands, directories, writes, deletions }), {
      mode: 0o600,
    });
  }
});
