#!/usr/bin/env node
/**
 * Remote round-trip rehearsal for D1 export restoration (ticket 38).
 *
 * Creates two disposable remote D1 databases, seeds a deterministic
 * production-representative synthetic dataset into the source, captures a real
 * `wrangler d1 export`, restores it into the fresh target with
 * `scripts/restore-d1-export.mjs`, verifies source/target/manifest equality,
 * records evidence, and deletes only the two databases it created.
 *
 *   node scripts/rehearse-d1-restore.mjs [--keep] [--evidence /tmp/evidence.md]
 *
 * The source and target names are generated with a unique suffix and are never
 * the committed local, preview, or production bindings. No real export,
 * credential, key, or payload is used; the dataset is synthetic and the
 * evidence contains identifiers and digests only.
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
  runWranglerOrThrow,
  SENSITIVE_FILE_MODE,
  writeSensitive,
} from "./lib/restore-cli-support.mjs";
import { chunkOversizedStatements, splitMultiRowStatements } from "./lib/sql-dump.mjs";
import { spawnWrangler } from "./lib/wrangler-targets.mjs";

/** @param {string} output @returns {string} */
function parseCreatedDatabaseId(output) {
  const match = /"database_id"\s*:\s*"([0-9a-f-]{36})"/.exec(output);
  if (!match) throw new Error(`Could not parse database_id from wrangler output:\n${output}`);
  return match[1];
}

const flags = parseFlags(process.argv.slice(2));
const keep = flags.get("keep") === true;
const ciphertextBytes = Number(flags.get("max-ciphertext-bytes") ?? 512 * 1024);
const suffix = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
const sourceName = `mdwn-restore-rehearsal-source-${suffix}`;
const targetName = `mdwn-restore-rehearsal-target-${suffix}`;
const evidencePath = String(flags.get("evidence") ?? join(tmpdir(), `mdwn-restore-rehearsal-${suffix}.md`));
const workDirectory = mkdtempSync(join(tmpdir(), "mdwn-restore-rehearsal-"));
/** @type {string[]} */
const temporaryDirectories = [workDirectory];
/** @type {{ name: string, uuid: string }[]} */
const created = [];
let failure = null;

/** @param {string} name */
function createDatabase(name) {
  const output = runWranglerOrThrow(["d1", "create", name], `create ${name}`).stdout;
  const uuid = parseCreatedDatabaseId(output);
  created.push({ name, uuid });
  console.log(`✓ created ${name} (${uuid})`);
  return uuid;
}

/** @param {{ name: string, uuid: string }} database */
function deleteDatabase(database) {
  const result = spawnWrangler(["d1", "delete", database.name, "-y"]);
  if (result.status !== 0) {
    console.error(`✘ could not delete ${database.name}: ${(result.stderr || result.stdout).trim()}`);
    return false;
  }
  console.log(`✓ deleted ${database.name}`);
  return true;
}

try {
  const whoami = runWranglerOrThrow(["whoami"], "wrangler whoami").stdout;
  const account = /Account ID\s*│\s*([0-9a-f]{32})/.exec(whoami)?.[1] ?? "unknown";
  console.log(`Account ${account}; rehearsal suffix ${suffix}`);

  const sourceUuid = createDatabase(sourceName);
  const targetUuid = createDatabase(targetName);
  const source = createRestoreTarget({ mode: "remote", databaseName: sourceName, databaseId: sourceUuid });
  const target = createRestoreTarget({ mode: "remote", databaseName: targetName, databaseId: targetUuid });
  temporaryDirectories.push(source.directory, target.directory);
  const sourceConfig = source.configPath;
  const targetConfig = target.configPath;

  runWranglerOrThrow(["d1", "migrations", "apply", "DB", "--remote", "--config", sourceConfig], "source migrations");
  const { statements } = restoreRehearsalStatements({ maxCiphertextBytes: ciphertextBytes });
  // The seed reaches the source through the same 100 KB statement limit and
  // atomic-command transport as a restore, so chunk its max-size BLOBs and
  // keep each foreign-key cycle inside one command.
  const seedDatabase = openOfflineDatabase();
  let seedPlan;
  try {
    for (const file of readdirSync("drizzle").filter((name) => name.endsWith(".sql")).sort()) {
      seedDatabase.exec(readFileSync(`drizzle/${file}`, "utf8"));
    }
    const tableDdl = seedDatabase
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
      .all()
      .map((row) => String(row.sql));
    const schema = deriveSchema(tableDdl);
    const primaryKeys = new Map(schema.columns.map((table) => [table.name, table.primaryKey]));
    const chunked = chunkOversizedStatements(splitMultiRowStatements(statements.map((statement) => statement.replace(/;\s*$/, ""))), {
      maxBytes: D1_MAX_STATEMENT_BYTES,
      primaryKeys,
      tableDdl: schema.ddl,
    });
    seedPlan = planRestoreCommands({
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
  const seedPath = join(workDirectory, "rehearsal-seed.sql");
  writeSensitive(seedPath, `PRAGMA defer_foreign_keys=TRUE;\n${seedPlan.orderedStatements.map((statement) => `${statement};`).join("\n")}\n`);

  const sourceRunner = createWranglerRunner({ mode: "remote", configPath: sourceConfig });
  // The migrated source's representation-immutability trigger rejects the
  // chunked append updates that a >100 KB ciphertext needs. Capture the exact
  // reviewed trigger, drop it only around the seed, and reinstall it before
  // the export; the later manifest check proves the schema is unchanged.
  const immutableTrigger = sourceRunner.run(
    "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'tree_representation_immutable';",
  )[0]?.results?.[0]?.sql;
  if (!immutableTrigger) throw new Error("source schema is missing tree_representation_immutable");
  sourceRunner.run("DROP TRIGGER tree_representation_immutable;");
  try {
    for (const command of seedPlan.commands) sourceRunner.run(command);
  } finally {
    sourceRunner.run(`${immutableTrigger};`);
  }
  console.log(`✓ source seeded through ${seedPlan.commands.length} atomic commands`);
  if (Number(queryRows(sourceRunner, "PRAGMA foreign_keys;")[0]?.foreign_keys) !== 1
    || queryRows(sourceRunner, "PRAGMA foreign_key_check;").length !== 0) {
    throw new Error("source rehearsal database has broken foreign keys before export");
  }
  const sourceSummary = queryRows(
    sourceRunner,
    `SELECT (SELECT count(*) FROM accounts) AS accounts,
            (SELECT count(*) FROM vault_nodes WHERE parent_node_id IS NULL) AS roots,
            (SELECT count(*) FROM import_commits) AS markers,
            (SELECT count(*) FROM import_sessions) AS staging_sessions,
            (SELECT max(ciphertext_size) FROM file_representations) AS max_ciphertext;`,
  )[0] ?? {};
  console.log(`✓ source seeded: ${JSON.stringify(sourceSummary)}`);

  const exportPath = join(workDirectory, "rehearsal-export.sql");
  runWranglerOrThrow(["d1", "export", "DB", "--remote", "--config", sourceConfig, "--output", exportPath, "-y"], "source export");
  const bookmark = (() => {
    const result = spawnWrangler(["d1", "time-travel", "info", "DB", "--config", sourceConfig, "--json"]);
    if (result.status !== 0) return null;
    try {
      const info = JSON.parse(result.stdout);
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
    wranglerVersion: /wrangler\s+([\d.]+)/.exec(runWranglerOrThrow(["--version"], "wrangler version").stdout)?.[1] ?? null,
  });
  const preparedPath = join(workDirectory, "rehearsal-prepared.sql");
  const manifestPath = join(workDirectory, "rehearsal-manifest.json");
  writeSensitive(preparedPath, prepared.preparedSql);
  writeSensitive(manifestPath, `${JSON.stringify(prepared.manifest, null, 2)}\n`);
  console.log(
    `✓ prepared ${prepared.manifest.stats.dataStatements} data statements (${prepared.manifest.stats.chunkedStatements} chunked), head ${prepared.manifest.schema.head}`,
  );

  const targetRunner = createWranglerRunner({ mode: "remote", configPath: targetConfig });
  const restoreCommands = assembleRestoreCommands(prepared.preparedSql, prepared.manifest);
  for (const command of restoreCommands) targetRunner.run(command);
  console.log(`✓ target restored through ${restoreCommands.length} atomic commands`);
  const targetCheck = verifyRestoreTarget(targetRunner, prepared.manifest);
  if (!targetCheck.ok) throw new Error(`target verification failed: ${targetCheck.problems.join("; ")}`);
  console.log("✓ target verified against the manifest");

  // The source must satisfy the same manifest: this proves source == target,
  // not merely target == the locally prepared file.
  const sourceManifestCheck = verifyRestoreTarget(sourceRunner, prepared.manifest);
  if (!sourceManifestCheck.ok) throw new Error(`source verification failed: ${sourceManifestCheck.problems.join("; ")}`);
  console.log("✓ source verified against the same manifest (source == target)");

  const tableLines = prepared.manifest.tables
    .filter((table) => table.count > 0)
    .map((table) => `| ${table.name} | ${table.count} | ${table.digest.slice(0, 16)}… |`)
    .join("\n");
  const evidence = [
    `# D1 export-restoration rehearsal evidence`,
    ``,
    `- Date: ${new Date().toISOString()}`,
    `- Wrangler: ${prepared.manifest.wranglerVersion ?? "unknown"}`,
    `- Source: ${sourceName} / ${sourceUuid}${bookmark ? ` (bookmark ${bookmark})` : ""}`,
    `- Target: ${targetName} / ${targetUuid}`,
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
    `## Cleanup`,
    ``,
    keep
      ? `Databases kept for inspection: ${sourceName} (${sourceUuid}), ${targetName} (${targetUuid}).`
      : `Both disposable databases were deleted after verification.`,
    ``,
  ].join("\n");
  writeSensitive(evidencePath, evidence, SENSITIVE_FILE_MODE);
  console.log(`✓ evidence written to ${evidencePath}`);
} catch (error) {
  failure = error;
  console.error(`✘ rehearsal failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (!keep) {
    for (const database of created.reverse()) deleteDatabase(database);
  } else {
    for (const database of created) console.log(`Kept ${database.name} (${database.uuid}); delete with: npx wrangler d1 delete ${database.name} -y`);
  }
  console.log(`Local rehearsal artifacts (sensitive, trash when done): ${temporaryDirectories.join(" ")}`);
  if (failure) process.exitCode = 1;
}
