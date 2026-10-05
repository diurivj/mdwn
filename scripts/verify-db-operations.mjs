#!/usr/bin/env node
/** Read-only deployed verification, or fresh disposable local D1 verification.
 *   npm run db:operations -- --output /tmp/mdwn-query-plans.md
 *   npm run db:operations -- --remote preview --output /tmp/mdwn-preview-plans.md
 * Unlike db:smoke --remote, remote mode NEVER applies a migration.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEnvironment, spawnWrangler, WRANGLER_TARGETS } from "./lib/wrangler-targets.mjs";
import { reviewedQueryPlans, verifyForeignKeys } from "./lib/d1-operations.mjs";

const args = process.argv.slice(2);
const remoteIndex = args.indexOf("--remote");
const target = remoteIndex < 0 ? "local" : args[remoteIndex + 1];
const outputIndex = args.indexOf("--output");
const output = outputIndex < 0 ? "/tmp/mdwn-query-plans.md" : args[outputIndex + 1];
if (!target || !isEnvironment(target) || (remoteIndex >= 0 && target === "local") || !output) {
  throw new Error("Usage: db:operations [--remote preview|production] [--output path]");
}
const temporary = target === "local" ? mkdtempSync(join(tmpdir(), "mdwn-operations-")) : null;
const { envFlag, extra } = WRANGLER_TARGETS[target];
const bindArgs = [...envFlag, ...extra, ...(temporary ? ["--persist-to", temporary] : [])];
if (temporary) {
  const result = spawnWrangler(["d1", "migrations", "apply", "DB", ...bindArgs]);
  if (result.status !== 0) throw new Error(`Disposable local migration failed: ${result.stderr}`);
}
verifyForeignKeys(bindArgs);
writeFileSync(output, `Target: ${target}\n\n${reviewedQueryPlans(bindArgs)}`);
console.log(`✓ Reviewed operational plans written to ${output}`);
// Leave disposable local state available for inspection; no production data
// or credentials are copied. Clean up reversibly with `trash <path>`.
if (temporary) console.log(`Disposable local D1: ${temporary}`);
