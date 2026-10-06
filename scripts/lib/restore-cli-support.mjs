/**
 * Shared support for the D1 export-restoration CLI and its remote rehearsal:
 * argument parsing, sensitive-file writes, Wrangler runners, and disposable
 * target configs. Kept separate so the operator tool and the rehearsal cannot
 * drift in how they parse flags, bind a target, or spawn Wrangler.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnWrangler } from "./wrangler-targets.mjs";

/** Prepared SQL, manifests, status files, and evidence are sensitive. */
export const SENSITIVE_FILE_MODE = 0o600;
export const COMPATIBILITY_DATE = "2026-09-18";

/** @param {string[]} argv */
export function parseFlags(argv) {
  /** @type {Map<string, string | boolean>} */
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const [name, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) flags.set(name, inline);
    else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) flags.set(name, argv[++index]);
    else flags.set(name, true);
  }
  return flags;
}

/** @param {Map<string, string | boolean>} flags @param {string} name @returns {string} */
export function flag(flags, name) {
  const value = flags.get(name);
  if (value === true) throw new Error(`--${name} requires a value`);
  if (value === undefined) throw new Error(`Missing required --${name}`);
  return String(value);
}

/** @param {Map<string, string | boolean>} flags @param {string} name @returns {string | null} */
export function optionalFlag(flags, name) {
  const value = flags.get(name);
  if (value === true) throw new Error(`--${name} requires a value`);
  return value === undefined ? null : String(value);
}

/** @param {string} path */
export function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** @param {string} path @param {string} contents @param {number} [mode] */
export function writeSensitive(path, contents, mode = SENSITIVE_FILE_MODE) {
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
}

/** @param {string} text */
export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Spawn Wrangler and throw on failure, so callers keep their cleanup paths.
 * @param {string[]} args @param {string} label
 */
export function runWranglerOrThrow(args, label) {
  const result = spawnWrangler(args);
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result;
}

/**
 * A synchronous D1 runner. Both modes use the query endpoint's `--command`
 * path: a multi-statement command is one atomic transaction there, unlike the
 * `--file` import endpoint, which commits internal batches.
 * @param {{ mode: "local" | "remote", configPath: string }} options
 */
export function createWranglerRunner({ mode, configPath }) {
  return {
    /** @param {string} sql */
    run(sql) {
      const result = spawnWrangler([
        "d1",
        "execute",
        "DB",
        mode === "local" ? "--local" : "--remote",
        "--config",
        configPath,
        "--json",
        "--command",
        sql,
      ]);
      if (result.status !== 0) {
        throw new Error(`D1 query failed: ${(result.stderr || result.stdout || "").trim()}`);
      }
      /** @type {Array<{ results?: Array<Record<string, unknown>> }>} */
      let parsed;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        throw new Error(`D1 query returned non-JSON output: ${result.stdout.slice(0, 200)}`);
      }
      return parsed.map((entry) => ({ results: entry.results ?? [] }));
    },
  };
}

/**
 * Create a private temporary Wrangler config that binds DB to exactly one
 * target. Local mode keeps its state inside the same temporary directory, so
 * it can never touch the repository's development state.
 * @param {{ mode: "local" | "remote", databaseName: string, databaseId: string }} options
 */
export function createRestoreTarget({ mode, databaseName, databaseId }) {
  const directory = mkdtempSync(join(tmpdir(), "mdwn-restore-"));
  const configPath = join(directory, "wrangler.jsonc");
  writeSensitive(
    configPath,
    `${JSON.stringify(
      {
        name: "mdwn-restore-rehearsal",
        compatibility_date: COMPATIBILITY_DATE,
        d1_databases: [
          {
            binding: "DB",
            database_name: databaseName,
            database_id: databaseId,
            migrations_dir: join(process.cwd(), "drizzle"),
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return {
    mode,
    directory,
    configPath,
    databaseName,
    databaseId,
    /** Local state is config-relative; remote has no local state. */
    statePath: join(directory, ".wrangler", "state"),
  };
}
