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

/** @type {Record<string, Record<string, string>>} */
const EXPECTED_COLUMNS = {
  accounts: { id: "TEXT", share_id: "TEXT", share_handle_lookup_token: "TEXT", created_at: "INTEGER", updated_at: "INTEGER" },
  account_profiles: { account_id: "TEXT", ciphertext: "BLOB", revision: "INTEGER", epoch: "INTEGER", created_at: "INTEGER", updated_at: "INTEGER" },
  passkeys: { credential_id: "TEXT", account_id: "TEXT", public_key: "BLOB", counter: "INTEGER", transports: "TEXT", device_type: "TEXT", backed_up: "INTEGER", created_at: "INTEGER", updated_at: "INTEGER" },
  sessions: { id: "TEXT", account_id: "TEXT", purpose: "TEXT", authenticated_passkey_id: "TEXT", created_at: "INTEGER", idle_expires_at: "INTEGER", absolute_expires_at: "INTEGER", fresh_asserted_at: "INTEGER", refreshed_at: "INTEGER", revoked_at: "INTEGER" },
  webauthn_challenges: { id: "TEXT", challenge: "TEXT", purpose: "TEXT", account_id: "TEXT", session_id: "TEXT", origin: "TEXT", rp_id: "TEXT", expires_at: "INTEGER", created_at: "INTEGER" },
};
const EXPECTED_INDEXES = [
  ["accounts", "accounts_share_id_unique", 1],
  ["accounts", "accounts_share_handle_lookup_token_unique", 1],
  ["passkeys", "passkeys_account_id_idx", 0],
  ["sessions", "sessions_account_live_idx", 0],
  ["sessions", "sessions_authenticated_passkey_idx", 0],
  ["webauthn_challenges", "webauthn_challenges_challenge_unique", 1],
  ["webauthn_challenges", "webauthn_challenges_expiry_idx", 0],
  ["webauthn_challenges", "webauthn_challenges_session_idx", 0],
];
const EXPECTED_FOREIGN_KEYS = [
  "account_profiles:account_id:accounts:id:RESTRICT",
  "passkeys:account_id:accounts:id:RESTRICT",
  "sessions:account_id:accounts:id:RESTRICT",
  "webauthn_challenges:account_id:accounts:id:RESTRICT",
  "webauthn_challenges:session_id:sessions:id:RESTRICT",
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
  // One schema snapshot keeps local and remote verification inexpensive.
  // Table names below are source-controlled constants, never request input.
  const names = Object.keys(EXPECTED_COLUMNS).map((name) => `'${name}'`).join(", ");
  const facts = new Set(queryResults(bindArgs, `
    SELECT 'table:' || name AS name FROM sqlite_master
      WHERE type = 'table' AND name IN (${names}, 'd1_migrations')
    UNION ALL
    SELECT 'column:' || m.name || ':' || p.name || ':' || upper(p.type)
      FROM sqlite_master AS m, pragma_table_info(m.name) AS p
      WHERE m.type = 'table' AND m.name IN (${names})
    UNION ALL
    SELECT 'index:' || m.name || ':' || i.name || ':' || i."unique"
      FROM sqlite_master AS m, pragma_index_list(m.name) AS i
      WHERE m.type = 'table' AND m.name IN (${names})
    UNION ALL
    SELECT 'fk:' || m.name || ':' || f."from" || ':' || f."table" || ':' || f."to" || ':' || f.on_delete
      FROM sqlite_master AS m, pragma_foreign_key_list(m.name) AS f
      WHERE m.type = 'table' AND m.name IN (${names});
  `));
  const required = [
    "table:d1_migrations",
    ...Object.entries(EXPECTED_COLUMNS).flatMap(([table, columns]) => [
      `table:${table}`,
      ...Object.entries(columns).map(([column, type]) => `column:${table}:${column}:${type}`),
    ]),
    ...EXPECTED_INDEXES.map(([table, name, unique]) => `index:${table}:${name}:${unique}`),
    ...EXPECTED_FOREIGN_KEYS.map((key) => `fk:${key}`),
  ];
  for (const fact of required) {
    if (!facts.has(fact)) failNow(`${label}: missing schema fact ${fact}`);
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