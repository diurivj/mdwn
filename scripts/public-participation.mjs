#!/usr/bin/env node
/**
 * Operator control for Public-participation suspensions (ticket 26) and the
 * bounded report-pattern read the decision may rely on.
 *
 * Public Comment posting and Publication create/rotate are the only actions a
 * suspension blocks; every private operation, hard deletion, unpublishing,
 * recovery and session revocation stays available, and the suspension expires
 * automatically at its recorded end. Reports and suspensions contain only
 * bounded metadata — never plaintext, a capability, a request identifier or
 * network data — so this script prints opaque identifiers only.
 *
 * Usage:
 *   node scripts/public-participation.mjs apply <local|preview|production> <accountId> <reason>
 *   node scripts/public-participation.mjs clear <local|preview|production> <accountId>
 *   node scripts/public-participation.mjs list  <local|preview|production>
 *   node scripts/public-participation.mjs reports <local|preview|production>
 *
 * reason: repeated_technical_abuse | report_pattern
 *
 * apply  -> seven days for a first offense, 30 days for any later one
 * clear  -> operator correction of an evident metadata-supported mistake
 * reports-> aggregated, unexpired category-only report patterns (last 50)
 *
 * Operator-only: run with the same Cloudflare credentials as migrations.
 */
import { isEnvironment, WRANGLER_TARGETS, spawnWrangler } from "./lib/wrangler-targets.mjs";

const REASONS = ["repeated_technical_abuse", "report_pattern"];
// Mirrors app/shared/security/public-participation.ts / .server.ts; keep in lockstep.
const FIRST_SUSPENSION_MS = 604_800_000;
const REPEAT_SUSPENSION_MS = 2_592_000_000;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const [command, rawEnv, ...args] = process.argv.slice(2);
if (!["apply", "clear", "list", "reports"].includes(command) || !isEnvironment(rawEnv)) {
  console.error("Usage: public-participation.mjs <apply|clear|list|reports> <local|preview|production> [...]");
  process.exit(2);
}

/** @param {string} value @param {string} label */
function requireUuid(value, label) {
  if (typeof value !== "string" || !UUID_V7.test(value)) {
    console.error(`${label} must be a canonical Account UUIDv7`);
    process.exit(2);
  }
  return value;
}

/** Single-quote SQL literal; validated inputs contain no quotes anyway.
 * @param {string} value */
function literal(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

const NOW_MS = "CAST(strftime('%s','now') AS INTEGER) * 1000";
let statement;
if (command === "apply") {
  const [accountId, reason] = args;
  if (!REASONS.includes(reason)) {
    console.error(`reason must be one of: ${REASONS.join(" | ")}`);
    process.exit(2);
  }
  statement = `INSERT INTO public_participation_suspensions
    (account_id, strike_count, reason, started_at, expires_at, updated_at)
    VALUES (${literal(requireUuid(accountId, "accountId"))}, 1, ${literal(reason)}, ${NOW_MS}, ${NOW_MS} + ${FIRST_SUSPENSION_MS}, ${NOW_MS})
    ON CONFLICT (account_id) DO UPDATE SET
      strike_count = public_participation_suspensions.strike_count + 1,
      reason = excluded.reason,
      started_at = excluded.started_at,
      expires_at = excluded.started_at + ${REPEAT_SUSPENSION_MS},
      updated_at = excluded.updated_at
    RETURNING account_id, strike_count, reason, started_at, expires_at`;
} else if (command === "clear") {
  statement = `DELETE FROM public_participation_suspensions
    WHERE account_id = ${literal(requireUuid(args[0], "accountId"))} RETURNING account_id`;
} else if (command === "list") {
  statement = `SELECT account_id, strike_count, reason, started_at, expires_at,
      expires_at > ${NOW_MS} AS active FROM public_participation_suspensions ORDER BY expires_at DESC`;
} else {
  statement = `SELECT comment_id, category, count(*) AS reports, count(DISTINCT reporter_id) AS reporters,
      min(created_at) AS first_reported_at, max(created_at) AS last_reported_at
    FROM public_comment_reports WHERE expires_at > ${NOW_MS}
    GROUP BY comment_id, category ORDER BY reports DESC, last_reported_at DESC LIMIT 50`;
}

const { envFlag, extra } = WRANGLER_TARGETS[rawEnv];
const result = spawnWrangler(["d1", "execute", "DB", ...envFlag, ...extra, "--json", "--command", statement]);
if (result.status !== 0) {
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  console.error(`✘ public-participation ${command} failed (${rawEnv})`);
  process.exit(result.status ?? 1);
}
/** @type {Array<{ results?: unknown[] }>} */
const parsed = JSON.parse(result.stdout);
const rows = parsed.flatMap((entry) => entry.results ?? []);
if (command === "clear" && rows.length === 0) {
  console.log(`no suspension to clear (${rawEnv})`);
} else {
  console.log(JSON.stringify({ environment: rawEnv, command, rows }, null, 2));
}
