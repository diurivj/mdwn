/**
 * Shared support for the D1 export-restoration CLI and its remote rehearsal:
 * argument parsing, sensitive-file writes, Wrangler runners, and disposable
 * target configs. Kept separate so the operator tool and the rehearsal cannot
 * drift in how they parse flags, bind a target, or spawn Wrangler.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWranglerJson, spawnWrangler } from "./wrangler-targets.mjs";
import { PublicOperationalError } from "./script-errors.mjs";

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

/** @param {string} path @returns {number} */
function openSensitiveFile(path) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, SENSITIVE_FILE_MODE);
  try {
    // Protect the opened inode before truncating or writing existing contents.
    fchmodSync(fd, SENSITIVE_FILE_MODE);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** @param {string} path @param {string} contents @param {number} [mode] */
export function writeSensitive(path, contents, mode = SENSITIVE_FILE_MODE) {
  if (mode !== SENSITIVE_FILE_MODE) throw new Error("Sensitive artifacts require mode 0600");
  const fd = openSensitiveFile(path);
  try {
    ftruncateSync(fd, 0);
    writeFileSync(fd, contents, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Protect raw output before and after a synchronous producer, even on failure.
 * Only synchronous producers are supported: the restrictive umask is process-global.
 * @template T
 * @param {string} path
 * @param {() => T} produce
 * @returns {T}
 */
export function withSensitiveOutput(path, produce) {
  const originalUmask = process.umask(0o077);
  try {
    closeSync(openSensitiveFile(path));
    /** @type {{ ok: true, value: T } | { ok: false, error: unknown }} */
    let production;
    try {
      production = { ok: true, value: produce() };
    } catch (error) {
      production = { ok: false, error };
    }
    try {
      closeSync(openSensitiveFile(path));
    } catch (error) {
      if (!production.ok) {
        throw new AggregateError(
          [production.error, error],
          "Sensitive output production and permission cleanup failed",
          { cause: production.error },
        );
      }
      throw error;
    }
    if (!production.ok) throw production.error;
    return production.value;
  } finally {
    process.umask(originalUmask);
  }
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
    throw new PublicOperationalError(`${label} failed (exit ${result.status ?? 1})`, { cause: result.error });
  }
  return result;
}

/**
 * A synchronous D1 runner using `--command` for restoration transaction boundaries.
 * See docs/operations/d1-scripting.md#transport-which-command-path-is-atomic
 * for the verified transport semantics.
 * @param {{ mode: "local" | "remote", configPath: string }} options
 */
export function createWranglerRunner({ mode, configPath }) {
  return {
    /** @param {string} sql */
    run(sql) {
      /** @type {Array<{ results?: Array<Record<string, unknown>> }>} */
      const parsed = runWranglerJson(
        ["d1", "execute", "DB", mode === "local" ? "--local" : "--remote", "--config", configPath, "--command", sql],
        "D1 query",
      );
      return parsed.map((entry) => ({ results: entry.results ?? [] }));
    },
  };
}

/**
 * Create a private temporary Wrangler config that binds DB to exactly one
 * target. Local mode keeps its state inside the same temporary directory, so
 * it can never touch the repository's development state.
 * The command registers ownership before any config write can fail.
 * @param {{ mode: "local" | "remote", databaseName: string, databaseId: string, onDirectory: (directory: string) => void }} options
 */
export function createRestoreTarget({ mode, databaseName, databaseId, onDirectory }) {
  const directory = mkdtempSync(join(tmpdir(), "mdwn-restore-"));
  onDirectory(directory);
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
