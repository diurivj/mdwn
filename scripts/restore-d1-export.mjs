#!/usr/bin/env node
/**
 * Operator tool for restoring a Wrangler `d1 export` into a fresh disposable
 * D1 (local or remote). It never disables D1 foreign-key enforcement, never
 * silently drops a statement, and refuses production, preview, and existing
 * nonempty targets unless an explicit reviewed replacement plan is given.
 *
 *   # 1. Offline: transform the export and record a manifest (no credentials).
 *   node scripts/restore-d1-export.mjs prepare \
 *     --export /secure/pre-change.sql \
 *     --source-name mdwn-db-production --source-uuid 20cbcf9f-... \
 *     --out /secure/restore.sql --manifest /secure/restore.manifest.json
 *
 *   # 2. Restore into a fresh disposable local D1 (default).
 *   node scripts/restore-d1-export.mjs restore \
 *     --prepared /secure/restore.sql --manifest /secure/restore.manifest.json
 *
 *   # 3. Restore into a freshly created disposable remote D1.
 *   node scripts/restore-d1-export.mjs restore \
 *     --prepared /secure/restore.sql --manifest /secure/restore.manifest.json \
 *     --target remote --target-name mdwn-restore-20261006 --target-uuid <uuid>
 *
 * The prepared SQL and the manifest contain restored data or its digests:
 * keep them local, do not commit or upload them, and delete them after use.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assembleRestoreCommands, prepareRestore, verifyRestoreTarget } from "./lib/d1-export-restore.mjs";
import { spawnWrangler } from "./lib/wrangler-targets.mjs";

const PREPARED_MODE = 0o600;
const LOCAL_TARGET_ID = "00000000-0000-4000-8000-000000000038";
const DISPOSABLE_NAME_PREFIX = "mdwn-restore-";

/** @param {string[]} argv */
function parseArguments(argv) {
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
function flag(flags, name) {
  const value = flags.get(name);
  if (value === true) throw new Error(`--${name} requires a value`);
  if (value === undefined) throw new Error(`Missing required --${name}`);
  return String(value);
}

/** @param {Map<string, string | boolean>} flags @param {string} name @returns {string | null} */
function optionalFlag(flags, name) {
  const value = flags.get(name);
  if (value === true) throw new Error(`--${name} requires a value`);
  return value === undefined ? null : String(value);
}

/** @param {string} path */
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** @param {string} path @param {string} contents @param {number} mode */
function writeSensitive(path, contents, mode) {
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
}

/** @param {string} text */
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Names and UUIDs that this tool must never target: the committed local dev,
 * preview, and production bindings in wrangler.jsonc.
 * @returns {{ names: Set<string>, uuids: Set<string> }}
 */
function protectedTargets() {
  const config = readText(join(process.cwd(), "wrangler.jsonc"));
  const names = new Set([...config.matchAll(/"database_name"\s*:\s*"([^"]+)"/g)].map((match) => match[1]));
  const uuids = new Set([...config.matchAll(/"database_id"\s*:\s*"([^"]+)"/g)].map((match) => match[1]));
  return { names, uuids };
}

/**
 * @param {{ mode: "local" | "remote", configPath: string }} options
 */
function createWranglerRunner({ mode, configPath }) {
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
 * Create the temporary Wrangler config that binds DB to exactly one target.
 * Local targets get a private state directory under the same temp directory.
 * @param {{ mode: "local" | "remote", databaseName: string, databaseId: string }} options
 */
function createTarget({ mode, databaseName, databaseId }) {
  const directory = mkdtempSync(join(tmpdir(), "mdwn-restore-"));
  const configPath = join(directory, "wrangler.jsonc");
  const config = {
    name: "mdwn-restore-rehearsal",
    compatibility_date: "2026-09-18",
    d1_databases: [
      {
        binding: "DB",
        database_name: databaseName,
        database_id: databaseId,
        migrations_dir: join(process.cwd(), "drizzle"),
      },
    ],
  };
  writeSensitive(configPath, `${JSON.stringify(config, null, 2)}\n`, PREPARED_MODE);
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

/** @param {ReturnType<typeof createWranglerRunner>} runner */
function listUserTables(runner) {
  const rows = runner.run(
    `SELECT name FROM sqlite_schema WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name;`,
  )[0]?.results ?? [];
  return rows.map((row) => String(row.name));
}

/** @param {string} path @param {Record<string, unknown>} status */
function writeStatus(path, status) {
  writeSensitive(path, `${JSON.stringify(status, null, 2)}\n`, PREPARED_MODE);
}

/** @param {Map<string, string | boolean>} flags */
function prepareCommand(flags) {
  const exportPath = flag(flags, "export");
  const sourceName = flag(flags, "source-name");
  const sourceUuid = flag(flags, "source-uuid");
  const out = flag(flags, "out");
  const manifestPath = flag(flags, "manifest");
  const maxStatementBytes = Number(optionalFlag(flags, "max-statement-bytes") ?? 100_000);
  if (!Number.isInteger(maxStatementBytes) || maxStatementBytes < 1024) {
    throw new Error("--max-statement-bytes must be an integer of at least 1024");
  }
  const exportSql = readText(exportPath);
  const prepared = prepareRestore({ exportSql, sourceName, sourceUuid, maxStatementBytes });
  writeSensitive(out, prepared.preparedSql, PREPARED_MODE);
  writeSensitive(manifestPath, `${JSON.stringify(prepared.manifest, null, 2)}\n`, PREPARED_MODE);
  console.log(
    `✓ Prepared ${prepared.manifest.stats.dataStatements} data statements (${prepared.manifest.stats.chunkedStatements} chunked) in ${prepared.manifest.stats.commands} atomic commands`,
  );
  console.log(`✓ Source ${sourceName} (${sourceUuid}); schema head ${prepared.manifest.schema.head ?? "unknown"}`);
  console.log(`✓ Prepared SQL: ${out} (${prepared.manifest.prepared.bytes} bytes, sha256 ${prepared.manifest.prepared.sha256.slice(0, 12)}…)`);
  console.log(`✓ Manifest: ${manifestPath}`);
  console.log(`✓ ${prepared.probes.length} offline behavior/query-plan probes passed`);
  console.log("! Both files contain restored data or its digests. Keep them local, never commit or upload, and trash them after use.");
}

/** @param {Map<string, string | boolean>} flags @param {boolean} verifyOnly */
function restoreCommand(flags, verifyOnly) {
  const preparedPath = flag(flags, "prepared");
  const manifestPath = flag(flags, "manifest");
  const preparedSql = readText(preparedPath);
  const manifest = JSON.parse(readText(manifestPath));
  if (manifest.tool !== "restore-d1-export") throw new Error(`Unexpected manifest tool: ${manifest.tool}`);
  if (sha256(preparedSql) !== manifest.prepared?.sha256) {
    throw new Error("Prepared SQL does not match the manifest digest; refusing to restore a modified file");
  }
  const targetMode = optionalFlag(flags, "target") ?? "local";
  if (targetMode !== "local" && targetMode !== "remote") throw new Error("--target must be local or remote");
  const statusPath = optionalFlag(flags, "status") ?? `${manifestPath}.status.json`;
  const protectedSet = protectedTargets();

  /** @type {ReturnType<typeof createTarget>} */
  let target;
  if (targetMode === "local") {
    target = createTarget({ mode: "local", databaseName: "mdwn-restore-local", databaseId: LOCAL_TARGET_ID });
  } else {
    const targetName = flag(flags, "target-name");
    const targetUuid = flag(flags, "target-uuid");
    if (protectedSet.names.has(targetName) || protectedSet.uuids.has(targetUuid)) {
      throw new Error(`Refusing protected target ${targetName} (${targetUuid}); use a newly created disposable database`);
    }
    if (targetUuid === manifest.source?.uuid) throw new Error("Refusing to restore into the source database itself");
    if (!targetName.startsWith(DISPOSABLE_NAME_PREFIX)) {
      console.warn(`⚠ Target name ${targetName} does not start with ${DISPOSABLE_NAME_PREFIX}; continuing because it was named explicitly`);
    }
    target = createTarget({ mode: "remote", databaseName: targetName, databaseId: targetUuid });
    const info = spawnWrangler(["d1", "info", "DB", "--config", target.configPath, "--json"]);
    if (info.status !== 0) {
      throw new Error(`Target database ${targetName} is not resolvable by this account: ${(info.stderr || info.stdout).trim()}`);
    }
    const resolved = JSON.parse(info.stdout);
    const resolvedUuid = resolved.uuid ?? resolved.database_id ?? resolved.id;
    if (resolvedUuid !== targetUuid) {
      throw new Error(`Target UUID mismatch: wrangler resolved ${resolvedUuid}, expected ${targetUuid}`);
    }
  }

  const runner = createWranglerRunner({ mode: target.mode, configPath: target.configPath });
  const existingTables = listUserTables(runner);
  if (existingTables.length > 0) {
    const replace = flags.get("replace-nonempty") === true;
    const confirmed = optionalFlag(flags, "confirm-replace");
    if (!replace || confirmed !== target.databaseId) {
      throw new Error(
        `Target ${target.databaseName} (${target.databaseId}) is not empty: ${existingTables.join(", ")}. ` +
          `An explicit reviewed replacement plan requires --replace-nonempty --confirm-replace ${target.databaseId}`,
      );
    }
    console.warn(`⚠ Replacing ${existingTables.length} existing tables in ${target.databaseName} (${target.databaseId})`);
  }

  writeStatus(statusPath, {
    state: verifyOnly ? "verifying" : "applying",
    updatedAt: new Date().toISOString(),
    target: { mode: target.mode, name: target.databaseName, uuid: target.databaseId },
    manifest: manifestPath,
    prepared: { path: preparedPath, sha256: manifest.prepared.sha256 },
    source: manifest.source,
  });

  try {
    if (!verifyOnly) {
      // Apply the recorded atomic commands through the D1 query endpoint. Each
      // command is one transaction, and every foreign-key cycle is contained
      // in a single command, so no deferred check crosses a transaction.
      const commands = assembleRestoreCommands(preparedSql, manifest);
      commands.forEach((command, index) => {
        runner.run(command);
        if (index === commands.length - 1 || (index + 1) % 10 === 0) {
          console.log(`  applied ${index + 1}/${commands.length} atomic commands`);
        }
      });
      writeStatus(statusPath, {
        state: "applied-unverified",
        updatedAt: new Date().toISOString(),
        target: { mode: target.mode, name: target.databaseName, uuid: target.databaseId },
        manifest: manifestPath,
        prepared: { path: preparedPath, sha256: manifest.prepared.sha256 },
        source: manifest.source,
      });
    }
    const verification = verifyRestoreTarget(runner, manifest);
    const status = {
      state: verification.ok ? "verified" : "verification-failed",
      updatedAt: new Date().toISOString(),
      target: { mode: target.mode, name: target.databaseName, uuid: target.databaseId },
      manifest: manifestPath,
      prepared: { path: preparedPath, sha256: manifest.prepared.sha256 },
      source: manifest.source,
      checks: verification.checks,
    };
    writeStatus(statusPath, status);
    for (const check of verification.checks) {
      console.log(`${check.ok ? "✓" : "✘"} ${check.name}: ${check.detail}`);
    }
    if (!verification.ok) {
      throw new Error(`Restore verification failed: ${verification.problems.join("; ")}`);
    }
    console.log(`✓ Restored and verified ${manifest.source?.name ?? "source"} into ${target.databaseName} (${target.databaseId})`);
    console.log(`✓ Status: ${statusPath}`);
    if (target.mode === "local") {
      console.log(`✓ Disposable local D1 state: ${target.statePath}`);
      console.log(`  Inspect it, then clean up reversibly with: trash ${target.directory}`);
    } else {
      console.log(`  Delete the disposable database when finished: npx wrangler d1 delete ${target.databaseName}`);
    }
  } catch (error) {
    // A failed import is atomic: a fresh target stays empty and a replaced
    // target keeps its previous contents. Record that, never claim success.
    const remaining = (() => {
      try {
        return listUserTables(runner);
      } catch {
        return null;
      }
    })();
    writeStatus(statusPath, {
      state: "failed",
      updatedAt: new Date().toISOString(),
      target: { mode: target.mode, name: target.databaseName, uuid: target.databaseId },
      manifest: manifestPath,
      prepared: { path: preparedPath, sha256: manifest.prepared.sha256 },
      source: manifest.source,
      error: error instanceof Error ? error.message : String(error),
      remainingTables: remaining,
    });
    console.error(`✘ Restore failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`✘ ${target.databaseName} is not a verified restore${remaining ? ` (${remaining.length} tables present)` : ""}; status: ${statusPath}`);
    if (target.mode === "local") console.error(`  Discard the incomplete local state with: trash ${target.directory}`);
    else console.error(`  Retry against a fresh disposable D1, or delete this one: npx wrangler d1 delete ${target.databaseName}`);
    process.exitCode = 1;
  }
}

const [, , command, ...rest] = process.argv;
try {
  const flags = parseArguments(rest);
  if (command === "prepare") prepareCommand(flags);
  else if (command === "restore") restoreCommand(flags, false);
  else if (command === "verify") restoreCommand(flags, true);
  else {
    console.error("Usage: restore-d1-export.mjs <prepare|restore|verify> [flags]");
    console.error("Run with --help for the documented flags.");
    if (command === "--help" || command === undefined) process.exitCode = 2;
    else process.exitCode = 2;
  }
} catch (error) {
  console.error(`✘ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
