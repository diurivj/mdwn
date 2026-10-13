import { continueSealedTeardown } from "~/publications/publications.server";
import { purgeExpiredSignupProofs } from "~/device/proof.server";
import { purgeExpiredAbuseRecords } from "~/shared/security/abuse-control.server";
import { purgeExpiredPublicCommentReports } from "~/shared/security/public-participation.server";
import { purgeExpiredGrantDependents } from "~/sharing/grant-expiry.server";
import { purgeExpiredSecurityMaterial } from "./retention.server";

/**
 * The 15-minute Cron's duties, in order: security retention first, then the
 * Unpublishing teardown an Owner already sealed. Each duty is isolated, so a
 * failure (or a teardown backlog) never skips the others.
 *
 * D1 budget. Every duty together must fit the per-invocation D1 query limit
 * in the worst reading, where each statement of a `batch()` counts
 * (docs/operations/d1-scripting.md#per-invocation-queries):
 *
 * | duty                   | D1 statements                                   |
 * | ---------------------- | ----------------------------------------------- |
 * | abuse-records          | 3 (one batch)                                   |
 * | public-comment-reports | 1                                               |
 * | signup-proofs          | 3 (one batch)                                   |
 * | security-material      | 8 (one batch)                                   |
 * | grant-dependents       | 1 SELECT + 3 (one batch)                        |
 * | publication-teardown   | 1 SELECT + 1 attempt marker + at most 20 (one   |
 * |                        | batch: deferred-FK pragma and the 19-statement  |
 * |                        | final transaction; a Comment batch is 3)        |
 *
 * Worst case 41 statements in 9 D1 calls, under the Workers Free limit.
 * Raising a duty's bound, or adding a duty, must keep this total within that
 * limit until the Workers Paid subscription is confirmed; the statement-budget
 * test in tests/worker/scheduled-teardown.test.ts counts a real worst case.
 */
const duties: readonly (readonly [name: string, run: (env: Env) => Promise<unknown>])[] = [
  ["abuse-records", (env) => purgeExpiredAbuseRecords(env.DB)],
  ["public-comment-reports", (env) => purgeExpiredPublicCommentReports(env.DB)],
  ["signup-proofs", purgeExpiredSignupProofs],
  ["security-material", purgeExpiredSecurityMaterial],
  ["grant-dependents", purgeExpiredGrantDependents],
  ["publication-teardown", continueSealedTeardown],
];

/**
 * Runs every duty, then fails the invocation if any failed, so the Cron outcome
 * still shows the failure. Reports name only the duty: errors may carry SQL,
 * identifiers or counts, so they are never logged or rethrown.
 */
export async function runScheduledMaintenance(env: Env): Promise<void> {
  const failed: string[] = [];
  for (const [name, run] of duties) {
    try {
      await run(env);
    } catch {
      failed.push(name);
      console.error(`Scheduled maintenance duty failed: ${name}`);
    }
  }
  if (failed.length > 0) throw new Error(`Scheduled maintenance failed: ${failed.join(", ")}`);
}
