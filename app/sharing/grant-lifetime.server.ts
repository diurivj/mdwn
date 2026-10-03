import type { SQL } from "drizzle-orm";
import { sql } from "~/db/client.server";

/** Statement-time D1 clock, with the millisecond component preserved. Keep the
 * replacement storage triggers on the identical expression. No request-time cache.
 */
export const grantClock = sql`(CAST(strftime('%s', 'now') AS INTEGER) * 1000
  + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))`;
export function liveGrant(expiresAt: SQL = sql`s.expires_at`): SQL {
  return sql`(${expiresAt} IS NULL OR ${expiresAt} > ${grantClock})`;
}
export function expiredGrant(expiresAt: SQL = sql`s.expires_at`): SQL {
  return sql`(${expiresAt} IS NOT NULL AND ${expiresAt} <= ${grantClock})`;
}

/** Pure predicate; callers put their own device/session guard in the same CAS. */
export function hasExpiredGrants(auth: { accountId: string }): SQL {
  return sql`EXISTS (SELECT 1 FROM grants expired WHERE expired.owner_id = ${auth.accountId}
    AND ${expiredGrant(sql`expired.expires_at`)})`;
}
