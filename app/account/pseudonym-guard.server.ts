import type { SQL } from "drizzle-orm";
import { sql } from "~/db/client.server";

/**
 * Public-pseudonym change policy shared by the profile read, the exclusive
 * Pseudonym-update job and every mutation that would mint a new attribution
 * context while a job is pending. No plaintext pseudonym is involved.
 */

/** A Public pseudonym may be changed at most once every 30 days. */
export const PSEUDONYM_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** When the Account may next change its pseudonym; null until the first change. */
export function nextPseudonymChangeAt(changedAt: number | null): number | null {
  return changedAt === null ? null : changedAt + PSEUDONYM_COOLDOWN_MS;
}

/** True while the Account's one exclusive Pseudonym-update job is pending. */
export function pseudonymUpdatePending(accountId: string | SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM crypto_jobs j WHERE j.account_id = ${accountId}
    AND j.kind = 'pseudonym_update' AND j.state = 'pending')`;
}
