import type { SQL } from "drizzle-orm";
import { atomicSqlBatch, createDb, sql } from "~/shared/db/client.server";
import { commitPrivateBatch, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { expiredGrant, hasExpiredGrants } from "./grant-lifetime.server";
import {
  pendingRotationJob,
  planRotation,
  rotationSnapshot,
  startRotation,
  type RotationTarget,
} from "./rotation.server";

export { expiredGrant, hasExpiredGrants, liveGrant } from "./grant-lifetime.server";
const headers = { "Cache-Control": "no-store" };
const changed = () => Response.json({ error: "sharing_changed" }, { status: 409, headers });

function hasDependents(id: string | SQL): SQL {
  return sql`(EXISTS (SELECT 1 FROM provisioning_needs WHERE grant_id = ${id})
    OR EXISTS (SELECT 1 FROM grant_key_envelopes WHERE relationship_id = ${id})
    OR EXISTS (SELECT 1 FROM grant_comment_key_envelopes WHERE relationship_id = ${id}))`;
}

/** Bound rows, not just relationships: a Grant can retain arbitrarily many
 * independent Comment envelopes. No caller removes the implicit Grant seal here.
 */
function drainDependents(id: string, marker: SQL): SQL[] {
  return [
    sql`DELETE FROM provisioning_needs WHERE rowid IN (SELECT rowid FROM provisioning_needs
      WHERE grant_id = ${id} ORDER BY device_id LIMIT 20) AND ${marker}`,
    sql`DELETE FROM grant_key_envelopes WHERE rowid IN (SELECT rowid FROM grant_key_envelopes
      WHERE relationship_id = ${id} ORDER BY device_id LIMIT 20) AND ${marker}`,
    sql`DELETE FROM grant_comment_key_envelopes WHERE rowid IN (SELECT rowid FROM grant_comment_key_envelopes
      WHERE relationship_id = ${id} ORDER BY object_id, device_id LIMIT 20) AND ${marker}`,
  ];
}

function hasRotationDependents(targetId: string | SQL): SQL {
  const jobs = pendingRotationJob(targetId);
  return sql`(EXISTS (SELECT 1 FROM key_rotation_entries WHERE job_id IN (${jobs}))
    OR EXISTS (SELECT 1 FROM key_rotation_comment_items WHERE job_id IN (${jobs}))
    OR EXISTS (SELECT 1 FROM key_rotation_items WHERE job_id IN (${jobs}))
    OR EXISTS (SELECT 1 FROM key_rotation_receipts WHERE job_id IN (${jobs})))`;
}

/** Expiry pauses the old job. Drain its staging before supersession rather than
 * letting startRotation delete an unbounded job in the final handoff. */
function drainRotationDependents(targetId: string, marker: SQL): SQL[] {
  const jobs = pendingRotationJob(targetId);
  return [
    sql`DELETE FROM key_rotation_entries WHERE rowid IN (SELECT rowid FROM key_rotation_entries
      WHERE job_id IN (${jobs}) ORDER BY job_id, directory_id, child_id LIMIT 20) AND ${marker}`,
    sql`DELETE FROM key_rotation_comment_items WHERE rowid IN (SELECT rowid FROM key_rotation_comment_items
      WHERE job_id IN (${jobs}) ORDER BY job_id, thread_id, kind, record_id LIMIT 20) AND ${marker}`,
    sql`DELETE FROM key_rotation_items WHERE rowid IN (SELECT i.rowid FROM key_rotation_items i
      WHERE i.job_id IN (${jobs}) AND NOT EXISTS (SELECT 1 FROM key_rotation_entries e
        WHERE e.job_id = i.job_id AND e.directory_id = i.object_id)
        AND NOT EXISTS (SELECT 1 FROM key_rotation_comment_items c
          WHERE c.job_id = i.job_id AND c.thread_id = i.object_id)
      ORDER BY i.job_id, i.object_id LIMIT 20) AND ${marker}`,
    sql`DELETE FROM key_rotation_receipts WHERE rowid IN (SELECT rowid FROM key_rotation_receipts
      WHERE job_id IN (${jobs}) ORDER BY job_id, operation_id LIMIT 20) AND ${marker}`,
  ];
}

/** One fresh proof per pass. Draining and rotation handoff are separate bounded
 * passes, so the handoff's first CAS can pin empty dependencies and the fence.
 * The durable fence/job replaces the implicit seal in the same transaction.
 */
export async function expireGrantBatch(env: Env, auth: AuthorizedDevice): Promise<Response> {
  try {
    const db = createDb(env.DB);
    const target = await db.get<RotationTarget & { id: string; dependents: number }>(sql`
      SELECT s.id, s.owner_id, s.target_id, s.target_kind,
        (${hasDependents(sql`s.id`)} OR ${hasRotationDependents(sql`s.target_id`)}) AS dependents
      FROM grants s WHERE s.owner_id = ${auth.accountId} AND ${expiredGrant()} AND ${privateReadGuard(auth)}
      ORDER BY s.expires_at, s.id LIMIT 1`);
    if (!target) return Response.json({ pending: false }, { headers });
    let committed: boolean;
    if (target.dependents) {
      committed = await commitPrivateBatch(
        env,
        auth,
        (guard) => sql`UPDATE grants SET updated_at = updated_at
        WHERE id = ${target.id} AND owner_id = ${auth.accountId} AND ${expiredGrant(sql`expires_at`)} AND ${guard}`,
        (marker) => [...drainDependents(target.id, marker), ...drainRotationDependents(target.target_id, marker)],
      );
    } else {
      const rotation = await planRotation(env, auth, target);
      if (!rotation) return changed();
      committed = await commitPrivateBatch(
        env,
        auth,
        (guard) => sql`DELETE FROM grants
        WHERE id = ${target.id} AND owner_id = ${auth.accountId} AND ${expiredGrant(sql`expires_at`)}
          AND NOT ${hasDependents(target.id)} AND NOT ${hasRotationDependents(target.target_id)}
          AND ${rotationSnapshot(target, rotation)} AND ${guard}`,
        (marker) => startRotation(auth, target, rotation, marker),
      );
    }
    if (!committed) return changed();
    const pending = !!(await db.get(sql`SELECT 1 WHERE ${hasExpiredGrants(auth)} AND ${privateReadGuard(auth)}`));
    return Response.json({ pending }, { headers });
  } catch {
    return changed();
  }
}

/** Maintenance has no device authority: it deletes ciphertext/opaque work only,
 * never the Grant seal and never creates or advances a cryptographic job.
 * Skip already-drained Grants so an offline Owner cannot starve later cleanup.
 */
export async function purgeExpiredGrantDependents(env: Env): Promise<void> {
  const target = await createDb(env.DB).get<{ id: string }>(sql`SELECT s.id FROM grants s
    WHERE ${expiredGrant()} AND ${hasDependents(sql`s.id`)} ORDER BY s.expires_at, s.id LIMIT 1`);
  if (!target) return;
  const stillExpired = sql`EXISTS (SELECT 1 FROM grants s WHERE s.id = ${target.id} AND ${expiredGrant()})`;
  await atomicSqlBatch(env.DB, drainDependents(target.id, stillExpired));
}
