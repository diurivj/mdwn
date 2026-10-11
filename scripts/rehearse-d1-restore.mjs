#!/usr/bin/env node
/**
 * Round-trip rehearsal for D1 export restoration (ticket 38).
 *
 * Seeds a deterministic production-representative synthetic dataset into a
 * source database, captures a real `wrangler d1 export`, restores it into a
 * fresh target, verifies source/target/manifest equality, and records
 * evidence.
 *
 *   npm run db:restore:local    # two throwaway local D1 state directories
 *   npm run db:restore:rehearsal -- [--keep] [--evidence /tmp/evidence.md]
 *
 * Local mode needs no Cloudflare auth and runs in CI; it is the regression
 * check for the real Wrangler export/restore path. Remote mode creates two
 * disposable remote D1 databases with a unique `mdwn-restore-` prefix, deletes
 * only the databases it created, and consumes the account's shared D1 Free
 * daily row-write quota.
 *
 * No real export, credential, key, or payload is used; the dataset is
 * synthetic and the evidence contains identifiers and digests only.
 */
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  D1_MAX_COMMAND_BYTES,
  D1_MAX_STATEMENT_BYTES,
  assembleRestoreCommands,
  deriveSchema,
  openOfflineDatabase,
  planRestoreCommands,
  prepareRestore,
  queryRows,
  verifyRestoreTarget,
} from "./lib/d1-export-restore.mjs";
import { restoreRehearsalStatements } from "./lib/restore-rehearsal-data.mjs";
import {
  createRestoreTarget,
  createWranglerRunner,
  parseFlags,
  optionalFlag,
  runWranglerOrThrow,
  SENSITIVE_FILE_MODE,
  writeSensitive,
  withSensitiveOutput,
} from "./lib/restore-cli-support.mjs";
import { createScriptLifecycle } from "./lib/script-lifecycle.mjs";
import { PublicOperationalError } from "./lib/script-errors.mjs";
import { createTemporaryDatabase } from "./lib/temporary-d1.mjs";
import { chunkOversizedStatements, splitMultiRowStatements } from "./lib/sql-dump.mjs";
import { runWranglerJson } from "./lib/wrangler-targets.mjs";

const flags = parseFlags(process.argv.slice(2));
const keep = flags.get("keep") === true;
const local = flags.get("local") === true;
const ciphertextBytes = Number(flags.get("max-ciphertext-bytes") ?? 512 * 1024);
const suffix = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
const requestedEvidence = optionalFlag(flags, "evidence");
const lifecycle = createScriptLifecycle({ label: "rehearsal", keep });
const workDirectory = mkdtempSync(join(tmpdir(), "mdwn-restore-rehearsal-"));
lifecycle.artifact(workDirectory);
const evidencePath = requestedEvidence ?? join(workDirectory, "rehearsal-evidence.md");
if (requestedEvidence) lifecycle.artifact(evidencePath, { retain: true });
let failure = null;

/** @param {string} name */
function createDatabase(name) {
  return createTemporaryDatabase({ name, directory: workDirectory, lifecycle }).uuid;
}

/**
 * Keep the seed under the same limits as a restore, with each FK cycle whole.
 * Transport/limits: docs/operations/d1-scripting.md.
 * @param {number} maxCiphertextBytes
 */
function buildSeedPlan(maxCiphertextBytes) {
  const { statements } = restoreRehearsalStatements({ maxCiphertextBytes });
  const seedDatabase = openOfflineDatabase();
  try {
    for (const file of readdirSync("drizzle")
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      seedDatabase.exec(readFileSync(`drizzle/${file}`, "utf8"));
    }
    const tableDdl = seedDatabase
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
      .all()
      .map((row) => String(row.sql));
    const schema = deriveSchema(tableDdl);
    const primaryKeys = new Map(schema.columns.map((table) => [table.name, table.primaryKey]));
    const chunked = chunkOversizedStatements(
      splitMultiRowStatements(statements.map((statement) => statement.replace(/;\s*$/, ""))),
      {
        maxBytes: D1_MAX_STATEMENT_BYTES,
        primaryKeys,
        tableDdl: schema.ddl,
      },
    );
    return planRestoreCommands({
      schemaStatements: [],
      indexStatements: [],
      migrationStatements: [],
      dataUnits: chunked.units,
      triggerStatements: [],
      viewStatements: [],
      foreignKeys: schema.foreignKeys,
      primaryKeys,
      maxCommandBytes: D1_MAX_COMMAND_BYTES,
      // Root Directory rows are materialized by the real trigger during the
      // seed, so they are legitimately absent from the data-only statements.
      allowMissingParents: true,
    });
  } finally {
    seedDatabase.close();
  }
}

/**
 * The migrated source's representation-immutability trigger rejects the
 * chunked append updates that a >100 KB ciphertext needs. Capture the exact
 * reviewed trigger, drop it only around the seed, and reinstall it before the
 * export; the later manifest check proves the schema is unchanged.
 * @param {{ run: (sql: string) => Array<{ results: Record<string, unknown>[] }> }} runner
 * @param {ReturnType<typeof buildSeedPlan>} seedPlan
 * @param {string} workDirectory
 */
function seedSource(runner, seedPlan, workDirectory) {
  writeSensitive(
    join(workDirectory, "rehearsal-seed.sql"),
    `PRAGMA defer_foreign_keys=TRUE;\n${seedPlan.orderedStatements.map((statement) => `${statement};`).join("\n")}\n`,
  );
  const immutableTrigger = queryRows(
    runner,
    "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'tree_representation_immutable';",
  )[0]?.sql;
  if (!immutableTrigger) throw new Error("source schema is missing tree_representation_immutable");
  runner.run("DROP TRIGGER tree_representation_immutable;");
  let seedFailure = null;
  try {
    for (const command of seedPlan.commands) runner.run(command);
  } catch (error) {
    seedFailure = error;
  }
  try {
    runner.run(`${immutableTrigger};`);
  } catch (error) {
    const cleanupError = new PublicOperationalError("Could not reinstall the source immutability trigger", {
      cause: error,
    });
    if (seedFailure) {
      throw new AggregateError([seedFailure, cleanupError], "Source seed and trigger restoration failed", {
        cause: seedFailure,
      });
    }
    throw cleanupError;
  }
  if (seedFailure) throw seedFailure;
  console.log(`✓ source seeded through ${seedPlan.commands.length} atomic commands`);
  if (
    Number(queryRows(runner, "PRAGMA foreign_keys;")[0]?.foreign_keys) !== 1 ||
    queryRows(runner, "PRAGMA foreign_key_check;").length !== 0
  ) {
    throw new Error("source rehearsal database has broken foreign keys before export");
  }
  const summary =
    queryRows(
      runner,
      `SELECT (SELECT count(*) FROM accounts) AS accounts,
            (SELECT count(*) FROM vault_nodes WHERE parent_node_id IS NULL) AS roots,
            (SELECT count(*) FROM import_commits) AS markers,
            (SELECT count(*) FROM import_sessions) AS staging_sessions,
            (SELECT max(ciphertext_size) FROM file_representations) AS max_ciphertext;`,
    )[0] ?? {};
  console.log(`✓ source seeded: ${JSON.stringify(summary)}`);
}

/** @param {string} mode @param {string} sourceConfig @param {string} sourceName @param {string} sourceUuid */
function exportAndPrepare(mode, sourceConfig, sourceName, sourceUuid) {
  const exportPath = join(workDirectory, "rehearsal-export.sql");
  withSensitiveOutput(exportPath, () =>
    runWranglerOrThrow(
      [
        "d1",
        "export",
        "DB",
        mode === "local" ? "--local" : "--remote",
        "--config",
        sourceConfig,
        "--output",
        exportPath,
        "-y",
      ],
      "source export",
    ),
  );
  const bookmark = (() => {
    if (mode === "local") return null;
    try {
      const info = runWranglerJson(["d1", "time-travel", "info", "DB", "--config", sourceConfig], "time-travel info");
      return info.bookmark ?? info.current_bookmark ?? null;
    } catch {
      return null;
    }
  })();
  const exportSql = readFileSync(exportPath, "utf8");
  console.log(`✓ export captured: ${Buffer.byteLength(exportSql)} bytes${bookmark ? `, bookmark ${bookmark}` : ""}`);
  const prepared = prepareRestore({
    exportSql,
    sourceName,
    sourceUuid,
    wranglerVersion:
      /wrangler\s+([\d.]+)/.exec(runWranglerOrThrow(["--version"], "wrangler version").stdout)?.[1] ?? null,
  });
  writeSensitive(join(workDirectory, "rehearsal-prepared.sql"), prepared.preparedSql);
  writeSensitive(join(workDirectory, "rehearsal-manifest.json"), `${JSON.stringify(prepared.manifest, null, 2)}\n`);
  console.log(
    `✓ prepared ${prepared.manifest.stats.dataStatements} data statements (${prepared.manifest.stats.chunkedStatements} chunked), head ${prepared.manifest.schema.head}`,
  );
  return { exportSql, prepared, bookmark };
}

/**
 * @param {{ run: (sql: string) => Array<{ results: Record<string, unknown>[] }> }} targetRunner
 * @param {{ run: (sql: string) => Array<{ results: Record<string, unknown>[] }> }} sourceRunner
 * @param {ReturnType<typeof prepareRestore>} prepared
 */
function restoreAndVerify(targetRunner, sourceRunner, prepared) {
  const commands = assembleRestoreCommands(prepared.preparedSql, prepared.manifest);
  for (const command of commands) targetRunner.run(command);
  console.log(`✓ target restored through ${commands.length} atomic commands`);
  const targetCheck = verifyRestoreTarget(targetRunner, prepared.manifest);
  if (!targetCheck.ok) throw new Error(`target verification failed: ${targetCheck.problems.join("; ")}`);
  console.log("✓ target verified against the manifest");
  // The source must satisfy the same manifest: this proves source == target,
  // not merely target == the locally prepared file.
  const sourceCheck = verifyRestoreTarget(sourceRunner, prepared.manifest);
  if (!sourceCheck.ok) throw new Error(`source verification failed: ${sourceCheck.problems.join("; ")}`);
  console.log("✓ source verified against the same manifest (source == target)");
  return targetCheck;
}

/**
 * @param {{ mode: "local" | "remote", sourceLabel: string, targetLabel: string, exportSql: string, bookmark: string | null, prepared: ReturnType<typeof prepareRestore>, targetCheck: { checks: { ok: boolean, name: string, detail: string }[] } }} options
 */
function writeEvidence({ mode, sourceLabel, targetLabel, exportSql, bookmark, prepared, targetCheck }) {
  const tableLines = prepared.manifest.tables
    .filter((table) => table.count > 0)
    .map((table) => `| ${table.name} | ${table.count} | ${table.digest.slice(0, 16)}… |`)
    .join("\n");
  const evidence = [
    `# D1 export-restoration ${mode} rehearsal evidence`,
    ``,
    `- Date: ${new Date().toISOString()}`,
    `- Wrangler: ${prepared.manifest.wranglerVersion ?? "unknown"}`,
    `- Source: ${sourceLabel}${bookmark ? ` (bookmark ${bookmark})` : ""}`,
    `- Target: ${targetLabel}`,
    `- Export: ${Buffer.byteLength(exportSql)} bytes, sha256 ${prepared.manifest.export.sha256}`,
    `- Prepared: ${prepared.manifest.prepared.bytes} bytes, sha256 ${prepared.manifest.prepared.sha256}, ${prepared.manifest.prepared.chunkedStatements} chunked statement(s)`,
    `- Schema head: ${prepared.manifest.schema.head}; ${prepared.manifest.schema.objects.length} schema objects; ${prepared.manifest.schema.migrations.length} migration records`,
    ``,
    `## Verification checks`,
    ``,
    ...targetCheck.checks.map((check) => `- ${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`),
    ``,
    `## Restored row counts and content digests (source == target)`,
    ``,
    `| Table | Rows | Digest (first 16) |`,
    `| --- | ---: | --- |`,
    tableLines,
    ``,
  ].join("\n");
  writeSensitive(evidencePath, evidence, SENSITIVE_FILE_MODE);
  console.log(`✓ evidence written to ${evidencePath}`);
}

function runLocalRehearsal() {
  const source = createRestoreTarget({
    mode: "local",
    databaseName: "mdwn-restore-local-source",
    databaseId: "00000000-0000-4000-8000-0000000000a1",
    onDirectory: (directory) => lifecycle.artifact(directory),
  });
  const target = createRestoreTarget({
    mode: "local",
    databaseName: "mdwn-restore-local-target",
    databaseId: "00000000-0000-4000-8000-0000000000a2",
    onDirectory: (directory) => lifecycle.artifact(directory),
  });
  console.log(`Local rehearsal ${suffix} (no Cloudflare auth, no remote resources)`);
  runWranglerOrThrow(
    ["d1", "migrations", "apply", "DB", "--local", "--config", source.configPath],
    "source migrations",
  );
  const sourceRunner = createWranglerRunner({ mode: "local", configPath: source.configPath });
  seedSource(sourceRunner, buildSeedPlan(ciphertextBytes), workDirectory);
  const { exportSql, prepared, bookmark } = exportAndPrepare(
    "local",
    source.configPath,
    "mdwn-restore-local-source",
    source.databaseId,
  );
  const targetRunner = createWranglerRunner({ mode: "local", configPath: target.configPath });
  const targetCheck = restoreAndVerify(targetRunner, sourceRunner, prepared);
  writeEvidence({
    mode: "local",
    sourceLabel: `disposable local state ${source.statePath}`,
    targetLabel: `disposable local state ${target.statePath}`,
    exportSql,
    bookmark,
    prepared,
    targetCheck,
  });
}

function runRemoteRehearsal() {
  const whoami = runWranglerOrThrow(["whoami"], "wrangler whoami").stdout;
  const account = /Account ID\s*│\s*([0-9a-f]{32})/.exec(whoami)?.[1] ?? "unknown";
  const sourceName = `mdwn-restore-rehearsal-source-${suffix}`;
  const targetName = `mdwn-restore-rehearsal-target-${suffix}`;
  console.log(`Account ${account}; remote rehearsal suffix ${suffix}`);
  const sourceUuid = createDatabase(sourceName);
  const targetUuid = createDatabase(targetName);
  const source = createRestoreTarget({
    mode: "remote",
    databaseName: sourceName,
    databaseId: sourceUuid,
    onDirectory: (directory) => lifecycle.artifact(directory),
  });
  const target = createRestoreTarget({
    mode: "remote",
    databaseName: targetName,
    databaseId: targetUuid,
    onDirectory: (directory) => lifecycle.artifact(directory),
  });
  runWranglerOrThrow(
    ["d1", "migrations", "apply", "DB", "--remote", "--config", source.configPath],
    "source migrations",
  );
  const sourceRunner = createWranglerRunner({ mode: "remote", configPath: source.configPath });
  seedSource(sourceRunner, buildSeedPlan(ciphertextBytes), workDirectory);
  const { exportSql, prepared, bookmark } = exportAndPrepare("remote", source.configPath, sourceName, sourceUuid);
  const targetRunner = createWranglerRunner({ mode: "remote", configPath: target.configPath });
  const targetCheck = restoreAndVerify(targetRunner, sourceRunner, prepared);
  writeEvidence({
    mode: "remote",
    sourceLabel: `${sourceName} / ${sourceUuid}`,
    targetLabel: `${targetName} / ${targetUuid}`,
    exportSql,
    bookmark,
    prepared,
    targetCheck,
  });
}

try {
  if (local) runLocalRehearsal();
  else runRemoteRehearsal();
} catch (error) {
  failure = error;
} finally {
  if (!lifecycle.finish(failure).ok) process.exitCode = 1;
}
