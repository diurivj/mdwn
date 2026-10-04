import { createDb, sql } from "~/db/client.server";
import {
  FIRST_SUSPENSION_MS,
  PUBLIC_PARTICIPATION_SUSPENDED,
  REPEAT_SUSPENSION_MS,
  isPublicParticipationSuspensionReason,
  type PublicParticipationSuspensionReason,
} from "./public-participation";

/**
 * Public-participation suspensions and report retention (ticket 26).
 *
 * A suspension is operator-applied, bounded Account metadata: strike count,
 * fixed reason, start and expiry. Enforcement reads it live and compares
 * `expires_at` with the current time, so it stops applying automatically at
 * the recorded end even before any cleanup. It blocks only Public Comment
 * posting and Publication create/rotate; every private operation, hard
 * deletion, unpublishing, recovery and session revocation is untouched.
 */

export interface PublicParticipationSuspension {
  readonly accountId: string;
  readonly strikeCount: number;
  readonly reason: PublicParticipationSuspensionReason;
  readonly startedAt: number;
  readonly expiresAt: number;
}

const SUSPENSION_COLUMNS = sql`account_id AS accountId, strike_count AS strikeCount, reason,
  started_at AS startedAt, expires_at AS expiresAt`;

function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function boundedTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** The live suspension for one Account, or null when absent or already expired. */
export async function activePublicParticipationSuspension(
  db: D1Database,
  accountId: string,
  now = Date.now(),
): Promise<PublicParticipationSuspension | null> {
  if (!isUuidV7(accountId) || !boundedTime(now)) return null;
  const row = await createDb(db).get<PublicParticipationSuspension>(sql`
    SELECT ${SUSPENSION_COLUMNS} FROM public_participation_suspensions
    WHERE account_id = ${accountId} AND expires_at > ${now}`);
  return row ?? null;
}

/** The fixed public-participation denial: an error code and the automatic end. */
export function publicParticipationSuspendedResponse(
  suspension: Pick<PublicParticipationSuspension, "expiresAt">,
): Response {
  return Response.json(
    { error: PUBLIC_PARTICIPATION_SUSPENDED, suspendedUntil: suspension.expiresAt },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Operator action for repeated technical abuse or a metadata-supported report
 * pattern: one atomic upsert applies seven days for a first offense and 30
 * days for any later one, whether or not the prior suspension has expired.
 */
export async function applyPublicParticipationSuspension(
  db: D1Database,
  accountId: string,
  reason: PublicParticipationSuspensionReason,
  now = Date.now(),
): Promise<PublicParticipationSuspension> {
  if (!isUuidV7(accountId) || !isPublicParticipationSuspensionReason(reason) || !boundedTime(now)) {
    throw new Error("invalid public-participation suspension");
  }
  const rows = await createDb(db).all<PublicParticipationSuspension>(sql`
    INSERT INTO public_participation_suspensions (account_id, strike_count, reason, started_at, expires_at, updated_at)
    VALUES (${accountId}, 1, ${reason}, ${now}, ${now + FIRST_SUSPENSION_MS}, ${now})
    ON CONFLICT (account_id) DO UPDATE SET
      strike_count = public_participation_suspensions.strike_count + 1,
      reason = excluded.reason,
      started_at = excluded.started_at,
      expires_at = excluded.started_at + ${REPEAT_SUSPENSION_MS},
      updated_at = excluded.updated_at
    RETURNING ${SUSPENSION_COLUMNS}`);
  const row = rows[0];
  if (!row) throw new Error("public-participation suspension was not recorded");
  return row;
}

/** Operator correction of an evident metadata-supported mistake: the row and
 * its strike history are removed, so enforcement stops immediately. */
export async function clearPublicParticipationSuspension(
  db: D1Database,
  accountId: string,
): Promise<boolean> {
  if (!isUuidV7(accountId)) throw new Error("invalid Account identifier");
  const result = await createDb(db).run(sql`
    DELETE FROM public_participation_suspensions WHERE account_id = ${accountId}`);
  return result.meta.changes > 0;
}

/** Bounded-report retention: category-only reports expire after 30 days. */
export async function purgeExpiredPublicCommentReports(
  db: D1Database,
  now = Date.now(),
): Promise<number> {
  if (!boundedTime(now)) throw new Error("invalid purge time");
  const result = await createDb(db).run(sql`
    DELETE FROM public_comment_reports WHERE expires_at <= ${now}`);
  return result.meta.changes;
}
