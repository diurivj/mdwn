import { RECOVERY_SESSION_MS } from "~/auth/session.server";
import { atomicSqlBatch, sql } from "~/shared/db/client.server";

/** Scheduled maintenance has no device authority. Remove only expired security
 * material, in FK dependency order; never rotate keys or touch current content.
 */
export async function purgeExpiredSecurityMaterial(env: Env, now = Date.now()): Promise<void> {
  const expiredSessions = sql`SELECT id FROM sessions WHERE idle_expires_at <= ${now}
    OR revoked_at IS NOT NULL OR (purpose = 'recovery' AND created_at <= ${now - RECOVERY_SESSION_MS})`;
  // Each Import has at most 40 chunks / 20 MiB / 2,000 records. Drain at
  // most three oldest Imports per event; never turn a backlog into an
  // unbounded ciphertext deletion. Stable selection within one atomic batch.
  const expiredImports = sql`SELECT id FROM import_sessions WHERE expires_at <= ${now}
    OR session_id IN (${expiredSessions}) ORDER BY expires_at, id LIMIT 3`;
  await atomicSqlBatch(env.DB, [
    sql`DELETE FROM webauthn_challenges WHERE expires_at <= ${now} OR session_id IN (${expiredSessions})`,
    sql`DELETE FROM recovery_enrollments WHERE expires_at <= ${now} OR session_id IN (${expiredSessions})`,
    sql`DELETE FROM device_enrollments WHERE expires_at <= ${now} OR candidate_session_id IN (${expiredSessions})`,
    sql`DELETE FROM import_records WHERE import_id IN (${expiredImports})`,
    sql`DELETE FROM import_chunks WHERE import_id IN (${expiredImports})`,
    sql`DELETE FROM import_session_kinds WHERE import_id IN (${expiredImports})`,
    sql`DELETE FROM import_sessions WHERE id IN (${expiredImports})`,
    // import_commits is durable visibility metadata, NOT staging authority.
    sql`DELETE FROM sessions WHERE id IN (${expiredSessions})
      AND NOT EXISTS (SELECT 1 FROM import_sessions i WHERE i.session_id = sessions.id)`,
  ]);
}
