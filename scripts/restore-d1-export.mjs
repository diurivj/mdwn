#!/usr/bin/env node
/**
 * Operator tool for restoring a Wrangler `d1 export` into a fresh disposable
 * D1 (local or remote). It never disables D1 foreign-key enforcement, never
 * silently drops a statement, and refuses protected, unknown, or nonempty
 * targets. Replacement means deleting and recreating the disposable database,
 * never importing over live contents.
 *
 *   # 1. Offline: transform the export and record a manifest (no credentials).
 *   npm run db:restore -- prepare \
 *     --export /secure/pre-change.sql \
 *     --source-name mdwn-db-production --source-uuid 20cbcf9f-... \
 *     --out /secure/restore.sql --manifest /secure/restore.manifest.json
 *
 *   # 2. Restore into a fresh disposable local D1 (default).
 *   npm run db:restore -- restore \
 *     --prepared /secure/restore.sql --manifest /secure/restore.manifest.json
 *
 *   # 3. Restore into a freshly created disposable remote D1.
 *   npm run db:restore -- restore \
 *     --prepared /secure/restore.sql --manifest /secure/restore.manifest.json \
 *     --target remote --target-name mdwn-restore-20261006 --target-uuid <uuid>
 *
 *   # 4. Re-run the read-only verification against an already-restored target.
 *   npm run db:restore -- verify --prepared /secure/restore.sql \
 *     --manifest /secure/restore.manifest.json --target remote ...
 *
 * The prepared SQL and the manifest contain restored data or its digests:
 * keep them local, do not commit or upload them, and delete them after use.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assembleRestoreCommands, prepareRestore, queryRows, verifyRestoreTarget } from "./lib/d1-export-restore.mjs";
import {
  createRestoreTarget,
  createWranglerRunner,
  flag,
  optionalFlag,
  parseFlags,
  readText,
  runWranglerOrThrow,
  SENSITIVE_FILE_MODE,
  sha256,
  writeSensitive,
} from "./lib/restore-cli-support.mjs";
import { runWranglerJson, spawnWrangler } from "./lib/wrangler-targets.mjs";

const LOCAL_TARGET_ID = "00000000-0000-4000-8000-000000000038";
const DISPOSABLE_NAME_PREFIX = "mdwn-restore-";
const INCOMPLETE_TABLE = "_restore_incomplete";

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

/** @param {string} path @param {Record<string, unknown>} status */
function writeStatus(path, status) {
  writeSensitive(path, `${JSON.stringify(status, null, 2)}\n`, SENSITIVE_FILE_MODE);
}

/** @param {Map<string, string | boolean>} flags */
function prepareCommand(flags) {
  const exportPath = flag(flags, "export");
  const sourceName = flag(flags, "source-name");
  const sourceUuid = flag(flags, "source-uuid");
  const out = flag(flags, "out");
  const manifestPath = flag(flags, "manifest");
  const expectedHead = optionalFlag(flags, "source-schema-head");
  const maxStatementBytes = Number(optionalFlag(flags, "max-statement-bytes") ?? 100_000);
  if (!Number.isInteger(maxStatementBytes) || maxStatementBytes < 1024) {
    throw new Error("--max-statement-bytes must be an integer of at least 1024");
  }
  const wranglerVersion = /wrangler\s+([\d.]+)/.exec(spawnWrangler(["--version"]).stdout ?? "")?.[1] ?? null;
  const exportSql = readText(exportPath);
  const prepared = prepareRestore({ exportSql, sourceName, sourceUuid, wranglerVersion, maxStatementBytes });
  if (expectedHead && expectedHead !== prepared.manifest.schema.head) {
    throw new Error(
      `Export schema head ${prepared.manifest.schema.head ?? "unknown"} does not match --source-schema-head ${expectedHead}`,
    );
  }
  writeSensitive(out, prepared.preparedSql);
  writeSensitive(manifestPath, `${JSON.stringify(prepared.manifest, null, 2)}\n`);
  console.log(
    `✓ Prepared ${prepared.manifest.stats.dataStatements} data statements (${prepared.manifest.stats.chunkedStatements} chunked) in ${prepared.manifest.stats.commands} atomic commands`,
  );
  console.log(`✓ Source ${sourceName} (${sourceUuid}); schema head ${prepared.manifest.schema.head ?? "unknown"}`);
  console.log(`✓ Prepared SQL: ${out} (${prepared.manifest.prepared.bytes} bytes, sha256 ${prepared.manifest.prepared.sha256.slice(0, 12)}…)`);
  console.log(`✓ Manifest: ${manifestPath}`);
  console.log(`✓ ${prepared.probes.length} offline behavior/query-plan probes passed`);
  console.log("! Both files contain restored data or its digests. Keep them local, never commit or upload, and trash them after use.");
}

/**
 * Resolve the restore target, refusing anything that is not a fresh disposable
 * database created for this purpose.
 * @param {Map<string, string | boolean>} flags @param {any} manifest
 */
function resolveTarget(flags, manifest) {
  const targetMode = optionalFlag(flags, "target") ?? "local";
  if (targetMode !== "local" && targetMode !== "remote") throw new Error("--target must be local or remote");
  if (targetMode === "local") {
    return createRestoreTarget({ mode: "local", databaseName: "mdwn-restore-local", databaseId: LOCAL_TARGET_ID });
  }
  const targetName = flag(flags, "target-name");
  const targetUuid = flag(flags, "target-uuid");
  const protectedSet = protectedTargets();
  if (protectedSet.names.has(targetName) || protectedSet.uuids.has(targetUuid)) {
    throw new Error(`Refusing protected target ${targetName} (${targetUuid}); use a newly created disposable database`);
  }
  if (targetUuid === manifest.source?.uuid) throw new Error("Refusing to restore into the source database itself");
  if (!targetName.startsWith(DISPOSABLE_NAME_PREFIX)) {
    throw new Error(
      `Refusing unknown target name ${targetName}; create the disposable database with a ${DISPOSABLE_NAME_PREFIX} prefix`,
    );
  }
  const target = createRestoreTarget({ mode: "remote", databaseName: targetName, databaseId: targetUuid });
  /** @type {{ uuid?: string, database_id?: string, id?: string }} */
  let resolved;
  try {
    resolved = runWranglerJson(["d1", "info", "DB", "--config", target.configPath], "d1 info");
  } catch (error) {
    throw new Error(
      `Target database ${targetName} is not resolvable by this account: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const resolvedUuid = resolved.uuid ?? resolved.database_id ?? resolved.id;
  if (resolvedUuid !== targetUuid) {
    throw new Error(`Target UUID mismatch: wrangler resolved ${resolvedUuid}, expected ${targetUuid}`);
  }
  return target;
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
  const statusPath = optionalFlag(flags, "status") ?? `${manifestPath}.status.json`;
  const target = resolveTarget(flags, manifest);
  const runner = createWranglerRunner({ mode: target.mode, configPath: target.configPath });

  /** @param {string} state @param {Record<string, unknown>} [extra] */
  const statusPayload = (state, extra = {}) => ({
    state,
    updatedAt: new Date().toISOString(),
    target: { mode: target.mode, name: target.databaseName, uuid: target.databaseId },
    manifest: manifestPath,
    prepared: { path: preparedPath, sha256: manifest.prepared.sha256 },
    source: manifest.source,
    ...extra,
  });

  const existingTables = queryRows(
    runner,
    `SELECT name FROM sqlite_schema WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name;`,
  ).map((row) => String(row.name));
  if (existingTables.length > 0) {
    throw new Error(
      `Target ${target.databaseName} (${target.databaseId}) is not empty: ${existingTables.join(", ")}. ` +
        "Replacement means deleting and recreating the disposable database, then restoring into the fresh one.",
    );
  }

  writeStatus(statusPath, statusPayload(verifyOnly ? "verifying" : "applying"));
  try {
    if (!verifyOnly) {
      // The marker makes an interrupted restore visibly incomplete: it is
      // created before the first command and dropped by the last one, so a
      // failure leaves it (and the nonempty target) behind. The target is
      // disposable and bound to no Worker, so it serves no application traffic.
      runner.run(
        `CREATE TABLE IF NOT EXISTS "${INCOMPLETE_TABLE}" (
          restore_started_at TEXT NOT NULL, source_name TEXT NOT NULL, source_uuid TEXT NOT NULL);
         INSERT INTO "${INCOMPLETE_TABLE}" (restore_started_at, source_name, source_uuid)
           VALUES ('${new Date().toISOString()}', '${String(manifest.source?.name ?? "").replaceAll("'", "''")}',
                   '${String(manifest.source?.uuid ?? "").replaceAll("'", "''")}');`,
      );
      const commands = assembleRestoreCommands(preparedSql, manifest);
      commands.forEach((command, index) => {
        runner.run(command);
        if (index === commands.length - 1 || (index + 1) % 10 === 0) {
          console.log(`  applied ${index + 1}/${commands.length} atomic commands`);
        }
      });
      runner.run(`DROP TABLE "${INCOMPLETE_TABLE}";`);
      writeStatus(statusPath, statusPayload("applied-unverified"));
    }
    const verification = verifyRestoreTarget(runner, manifest);
    writeStatus(statusPath, statusPayload(verification.ok ? "verified" : "verification-failed", { checks: verification.checks }));
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
    const message = error instanceof Error ? error.message : String(error);
    let remaining = null;
    try {
      remaining = queryRows(
        runner,
        `SELECT name FROM sqlite_schema WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name;`,
      ).map((row) => String(row.name));
    } catch {
      remaining = null;
    }
    writeStatus(statusPath, statusPayload("failed", { error: message, remainingTables: remaining }));
    console.error(`✘ Restore failed: ${message}`);
    console.error(
      `✘ ${target.databaseName} is not a verified restore${remaining ? ` (${remaining.length} tables present, including any ${INCOMPLETE_TABLE} marker)` : ""}; status: ${statusPath}`,
    );
    if (target.mode === "local") {
      console.error(`  Inspect it, then discard the incomplete local state with: trash ${target.directory}`);
    } else {
      console.error(`  Delete and recreate the disposable database, then restore again: npx wrangler d1 delete ${target.databaseName}`);
    }
    process.exitCode = 1;
  }
}

const [, , command, ...rest] = process.argv;
try {
  const flags = parseFlags(rest);
  if (command === "prepare") prepareCommand(flags);
  else if (command === "restore") restoreCommand(flags, false);
  else if (command === "verify") restoreCommand(flags, true);
  else {
    console.error("Usage: restore-d1-export.mjs <prepare|restore|verify> [flags]");
    console.error("  prepare  --export <path> --source-name <name> --source-uuid <uuid> --out <path> --manifest <path>");
    console.error("  restore  --prepared <path> --manifest <path> [--target local|remote --target-name <name> --target-uuid <uuid>]");
    console.error("  verify   --prepared <path> --manifest <path> [--target local|remote --target-name <name> --target-uuid <uuid>]");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`✘ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
