#!/usr/bin/env node
/**
 * Apply committed Drizzle SQL migrations to the D1 database for one
 * environment through Wrangler — the reviewed commit point for schema
 * changes (spec §3.2, ADR-0002). Wrangler tracks applied migrations in its
 * own `d1_migrations` table, so re-running is a no-op.
 *
 * Usage: node scripts/apply-migrations.mjs <local|preview|production>
 *
 * local      -> local simulated D1 (wrangler dev persistence)
 * preview    -> mdwn-db-preview  (remote; the CI preview environment)
 * production -> mdwn-db-production (remote; never used from preview/local)
 */
import { isEnvironment, runWrangler, WRANGLER_TARGETS } from "./lib/wrangler-targets.mjs";

const env = process.argv[2];
if (!isEnvironment(env)) {
  console.error(`Usage: apply-migrations.mjs <local|preview|production>`);
  process.exit(2);
}
const { envFlag, extra } = WRANGLER_TARGETS[env];

runWrangler(["d1", "migrations", "apply", "DB", ...envFlag, ...extra], `${env} migration apply`);
console.log(`✓ migrations applied (${env})`);
