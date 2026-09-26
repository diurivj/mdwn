import { atomicSqlBatch, createDb, sql } from "~/db/client.server";
import { inspectEnvelope } from "~/crypto/enc-v1";
import { commitPrivateMutation, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { decodeBytes, encodeBytes } from "~/signup/protocol";

const noStore = { "Cache-Control": "no-store" };
const denied = () => Response.json({ error: "device_proof_required" }, { status: 403, headers: noStore });

type NextRow = {
  id: string; kind: "recovery_owned" | "enrollment_owned"; state: "pending" | "complete"; cursor: string | null;
  object_id: string | null; ciphertext: ArrayBuffer | null; key_epoch: number | null;
};

export async function nextOwnedEnvelope(env: Env, authorized: AuthorizedDevice): Promise<Response> {
  const row = await createDb(env.DB).get<NextRow>(sql`
    SELECT j.id, j.kind, j.state, j.cursor, k.object_id, k.ciphertext, k.key_epoch
    FROM crypto_jobs j
    LEFT JOIN key_envelopes k ON k.rowid = (
      SELECT source.rowid FROM key_envelopes source
      WHERE source.account_id = j.account_id AND source.purpose = 'vault-recovery'
        AND source.recipient_id = 'vault-root' AND source.superseded_at IS NULL
        AND (j.cursor IS NULL OR source.object_id > j.cursor)
      ORDER BY source.object_id LIMIT 1
    )
    WHERE j.account_id = ${authorized.accountId} AND j.device_id = ${authorized.deviceId}
      AND j.kind IN ('recovery_owned', 'enrollment_owned') AND ${privateReadGuard(authorized)}
    ORDER BY j.created_at DESC LIMIT 1
  `);
  if (!row) return Response.json({ state: "complete", item: null }, { headers: noStore });
  return Response.json({ state: row.state, kind: row.kind, cursor: row.cursor,
    item: row.state === "pending" && row.object_id && row.ciphertext && row.key_epoch
      ? { objectId: row.object_id, envelope: encodeBytes(new Uint8Array(row.ciphertext)), keyEpoch: row.key_epoch }
      : null,
  }, { headers: noStore });
}

export async function finishOwnedProvisioning(env: Env, authorized: AuthorizedDevice): Promise<Response> {
  const now = Date.now();
  const committed = await commitPrivateMutation(env, authorized, (guard) => sql`
    UPDATE crypto_jobs SET state = 'complete', updated_at = ${now}
    WHERE account_id = ${authorized.accountId} AND device_id = ${authorized.deviceId}
      AND kind IN ('recovery_owned', 'enrollment_owned') AND state = 'pending' AND ${guard}
      AND NOT EXISTS (SELECT 1 FROM key_envelopes source
        WHERE source.account_id = crypto_jobs.account_id AND source.purpose = 'vault-recovery'
          AND source.recipient_id = 'vault-root' AND source.superseded_at IS NULL
          AND (crypto_jobs.cursor IS NULL OR source.object_id > crypto_jobs.cursor))
  `);
  if (committed) return Response.json({ ok: true }, { headers: noStore });
  const alreadyComplete = await createDb(env.DB).get<{ id: string }>(sql`
    SELECT id FROM crypto_jobs WHERE account_id = ${authorized.accountId}
      AND device_id = ${authorized.deviceId} AND kind IN ('recovery_owned', 'enrollment_owned') AND state = 'complete'
      AND ${privateReadGuard(authorized)} LIMIT 1`);
  return alreadyComplete ? Response.json({ ok: true }, { headers: noStore }) : denied();
}

export async function stepOwnedProvisioning(env: Env, authorized: AuthorizedDevice, body: Record<string, unknown>): Promise<Response> {
  if (typeof body.objectId !== "string" || !body.objectId ||
      typeof body.envelope !== "string" ||
      !(body.cursor === null || typeof body.cursor === "string")) return denied();
  let envelope: Uint8Array;
  try { envelope = decodeBytes(body.envelope); } catch { return denied(); }
  const source = await createDb(env.DB).get<{ ciphertext: ArrayBuffer; key_epoch: number }>(sql`
    SELECT ciphertext, key_epoch FROM key_envelopes WHERE account_id = ${authorized.accountId}
      AND purpose = 'vault-recovery' AND object_id = ${body.objectId}
      AND recipient_id = 'vault-root' AND superseded_at IS NULL`);
  if (!source) return denied();
  try {
    const sourceHeader = inspectEnvelope(new Uint8Array(source.ciphertext));
    const header = inspectEnvelope(envelope);
    if (sourceHeader.context.purpose !== "vault-recovery" ||
        sourceHeader.context.vaultId !== authorized.accountId ||
        sourceHeader.context.objectId !== body.objectId ||
        sourceHeader.context.keyEpoch !== source.key_epoch ||
        header.suite !== "HPKE-P256/HKDF-SHA-256/AES-256-GCM" ||
        header.context.purpose !== "owned-device" ||
        header.context.vaultId !== authorized.accountId ||
        header.context.objectId !== body.objectId ||
        header.context.keyId !== sourceHeader.context.keyId ||
        header.context.keyEpoch !== source.key_epoch ||
        header.context.revision !== 1 ||
        header.context.recipientId !== authorized.deviceId) return denied();
  } catch { return denied(); }
  const now = Date.now();
  if (authorized.expiresAt <= now) return denied();
  const cursor = body.cursor;
  const objectId = body.objectId;
  const guard = sql`${privateReadGuard(authorized)} AND NOT EXISTS (
    SELECT 1 FROM device_proof_uses WHERE account_id = ${authorized.accountId}
      AND proof_id = ${authorized.proofId})`;
  const results = await atomicSqlBatch(env.DB, [
    sql`INSERT INTO key_envelopes
      (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch, superseded_at)
      SELECT ${authorized.accountId}, 'owned-device', ${objectId}, ${authorized.deviceId},
        ${envelope}, ${source.key_epoch}, NULL
      FROM crypto_jobs j
      WHERE j.account_id = ${authorized.accountId} AND j.device_id = ${authorized.deviceId}
        AND j.kind IN ('recovery_owned', 'enrollment_owned') AND j.state = 'pending' AND j.cursor IS ${cursor}
        AND EXISTS (SELECT 1 FROM key_envelopes source WHERE source.account_id = j.account_id
          AND source.purpose = 'vault-recovery' AND source.object_id = ${objectId}
          AND source.recipient_id = 'vault-root' AND source.superseded_at IS NULL
          AND source.key_epoch = ${source.key_epoch}
          AND source.ciphertext = ${new Uint8Array(source.ciphertext)})
        AND NOT EXISTS (SELECT 1 FROM key_envelopes earlier WHERE earlier.account_id = j.account_id
          AND earlier.purpose = 'vault-recovery' AND earlier.recipient_id = 'vault-root'
          AND earlier.superseded_at IS NULL AND earlier.object_id < ${objectId}
          AND (j.cursor IS NULL OR earlier.object_id > j.cursor))
        AND ${guard}`,
    sql`UPDATE crypto_jobs SET cursor = ${objectId}, updated_at = ${now}
      WHERE account_id = ${authorized.accountId} AND device_id = ${authorized.deviceId}
        AND kind IN ('recovery_owned', 'enrollment_owned') AND state = 'pending' AND cursor IS ${cursor}
        AND changes() = 1`,
    sql`INSERT INTO device_proof_uses (account_id, proof_id, session_id, expires_at)
      SELECT ${authorized.accountId}, ${authorized.proofId}, ${authorized.sessionId},
        ${authorized.expiresAt} WHERE changes() = 1`,
  ]);
  if (results.every((result) => result.meta.changes === 1)) {
    return Response.json({ ok: true }, { headers: noStore });
  }
  // A completed retry is harmless and must never reset the cursor or rewrite an envelope.
  const duplicate = await createDb(env.DB).get<{ cursor: string }>(sql`
    SELECT j.cursor FROM crypto_jobs j JOIN key_envelopes k
      ON k.account_id = j.account_id AND k.purpose = 'owned-device'
        AND k.object_id = ${objectId} AND k.recipient_id = j.device_id
        AND k.ciphertext = ${envelope} AND k.superseded_at IS NULL
    WHERE j.account_id = ${authorized.accountId} AND j.device_id = ${authorized.deviceId}
      AND j.kind IN ('recovery_owned', 'enrollment_owned') AND j.cursor >= ${objectId}
      AND ${privateReadGuard(authorized)} LIMIT 1`);
  return duplicate ? Response.json({ ok: true }, { headers: noStore }) : denied();
}
