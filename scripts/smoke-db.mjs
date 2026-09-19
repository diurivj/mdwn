#!/usr/bin/env node
/**
 * Smoke test: prove a FRESH EMPTY D1 reaches the committed schema.
 *
 * Default (local): applies every migration in ./drizzle through Wrangler into
 * a throwaway local D1 state directory (fresh = empty), asserts the resulting
 * schema (tables, columns, unique indexes), asserts re-applying is a no-op,
 * then cleans up. No Cloudflare auth required; runs in every pull request.
 *
 *   node scripts/smoke-db.mjs
 *
 * Remote verification (used by the deploy workflow against real databases):
 *   node scripts/smoke-db.mjs --remote preview
 *   node scripts/smoke-db.mjs --remote production
 * Applies any pending migrations with the wrangler environment of that
 * target, then asserts the remote schema matches the committed migration set.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isEnvironment,
  spawnWrangler,
  WRANGLER_TARGETS,
} from "./lib/wrangler-targets.mjs";

const isRemoteCli = process.argv.includes("--remote");
const remoteTarget = isRemoteCli
  ? process.argv[process.argv.indexOf("--remote") + 1]
  : "";
if (isRemoteCli && !(typeof remoteTarget === "string" && isEnvironment(remoteTarget))) {
  console.error("--remote must be one of: preview | production");
  process.exit(2);
}

// The D1 binding name in wrangler.jsonc (single binding per environment).
const BINDING = "DB";

const EXPECTED_COLUMNS = [
  "id",
  "share_id",
  "share_handle_lookup_token",
  "created_at",
  "updated_at",
];
const EXPECTED_UNIQUE_INDEXES = [
  "accounts_share_id_unique",
  "accounts_share_handle_lookup_token_unique",
];

/**
 * Run a wrangler command; on failure print its output and exit non-zero.
 * @param {string[]} args
 * @param {string} label
 */
function runCmd(args, label) {
  const r = spawnWrangler(args);
  if (r.status !== 0) {
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    console.error(`✘ ${label} failed`);
    process.exit(1);
  }
  return r;
}

/**
 * Fetch one column (`name`) of query results as strings.
 * @param {string[]} bindArgs
 * @param {string} sql
 * @returns {string[]}
 */
function queryResults(bindArgs, sql) {
  const r = runCmd(
    ["d1", "execute", BINDING, ...bindArgs, "--json", "--command", sql],
    "d1 query",
  );
  /** @type {Array<{ results?: Array<{ name: string }> }>} */
  const parsed = JSON.parse(r.stdout);
  return parsed.flatMap((row) => row.results ?? []).map((row) => row.name);
}

/**
 * Assert the schema matches the committed migration set.
 * @param {string[]} bindArgs
 * @param {string} label
 */
function verifySchema(bindArgs, label) {
  const tables = queryResults(
    bindArgs,
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('accounts','d1_migrations');`,
  );
  for (const t of ["accounts", "d1_migrations"]) {
    if (!tables.includes(t)) failNow(`${label}: missing table ${t}`);
  }
  const columns = queryResults(
    bindArgs,
    `SELECT name FROM pragma_table_info('accounts');`,
  );
  for (const c of EXPECTED_COLUMNS) {
    if (!columns.includes(c)) failNow(`${label}: accounts missing column ${c}`);
  }
  const indexes = queryResults(
    bindArgs,
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='accounts';`,
  );
  for (const ix of EXPECTED_UNIQUE_INDEXES) {
    if (!indexes.includes(ix)) failNow(`${label}: missing unique index ${ix}`);
  }
  console.log(`✓ ${label}: schema matches the committed migration set`);
}

/** @param {string} message */
function failNow(message) {
  console.error(`✘ smoke test failed: ${message}`);
  process.exit(1);
}

function localSmoke() {
  const persistDir = mkdtempSync(join(tmpdir(), "mdwn-dm-smoke-"));
  try {
    // A brand-new persist directory means the local D1 starts empty.
    const localArgs = ["--local", "--persist-to", persistDir];
    runCmd(["d1", "migrations", "apply", BINDING, ...localArgs], "local migration apply");
    console.log("✓ migrations applied to a fresh empty local D1");
    verifySchema(localArgs, "local");

    runCmd(["d1", "migrations", "apply", BINDING, ...localArgs], "local re-apply");
    console.log("✓ re-applying migrations is a no-op (idempotent)");
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
}

if (isRemoteCli) {
  const { envFlag, extra } = WRANGLER_TARGETS[remoteTarget];
  runCmd(
    ["d1", "migrations", "apply", BINDING, ...envFlag, ...extra],
    `${remoteTarget} migration apply`,
  );
  verifySchema([...envFlag, ...extra], remoteTarget);
} else {
  localSmoke();
}

console.log("✓ D1 smoke test passed");
process.exit(0);