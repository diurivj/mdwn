import { freshNormalSessionGuard } from "~/auth/fresh-session.server";
import { hasFreshAssertion, type ActiveSession } from "~/auth/session.server";
import { atomicSqlBatch, createDb, sql } from "~/db/client.server";
import { coarseProofTime, privateReadGuard, type AuthorizedDevice } from "./proof.server";
import { sessionBindingDigest, verifyDeviceProof } from "./proof";
import { decodeBytes, encodeBytes } from "~/signup/protocol";
import { MAX_EVENT_RETENTION_MS } from "~/security/abuse-control.server";

const noStore = { "Cache-Control": "no-store" };
const denied = (status = 403, error = "device_proof_required") =>
  Response.json({ error }, { status, headers: noStore });

type DeviceRow = {
  id: string; label_ciphertext: ArrayBuffer | null; state: string;
  created_at: number; last_proof_at: number | null;
};

/** Read-only, proof-guarded ciphertext inventory; never exposes keys, provenance or fingerprint data. */
export async function deviceInventory(env: Env, authorized: AuthorizedDevice): Promise<Response> {
  const rows = await createDb(env.DB).all<DeviceRow>(sql`
    SELECT d.id, d.label_ciphertext, d.state, d.created_at, d.last_proof_at
    FROM encryption_devices d JOIN account_encryption_identities r ON r.account_id = d.account_id
    WHERE d.account_id = ${authorized.accountId} AND r.registry_epoch = ${authorized.registryEpoch}
      AND ${privateReadGuard(authorized)}
    ORDER BY d.created_at ASC, d.id ASC`);
  // A current, active device must itself be in this inventory.
  if (!rows.some((row) => row.id === authorized.deviceId && row.state === "active")) return denied();
  return Response.json({ accountId: authorized.accountId, registryEpoch: authorized.registryEpoch, currentDeviceId: authorized.deviceId,
    devices: rows.map((row) => ({
      id: row.id, labelCiphertext: row.label_ciphertext ? encodeBytes(new Uint8Array(row.label_ciphertext)) : null,
      state: row.state, createdAt: row.created_at,
      lastUseAt: row.last_proof_at === null ? null : coarseProofTime(row.last_proof_at),
    })) }, { headers: noStore });
}

// The trusted browser checks the typed, decrypted label. The Worker cannot
// verify plaintext it never receives; the signed ciphertext digest pins the
// exact label metadata and target at the expected epoch without leaking it.
type Removal = { targetDeviceId: string; expectedEpoch: number; labelDigest: string; confirmation: string };
function removalBody(value: Record<string, unknown> | null): Removal | null {
  if (!value || Object.keys(value).sort().join(",") !== "confirmation,expectedEpoch,labelDigest,targetDeviceId" ||
      typeof value.targetDeviceId !== "string" || !/^[0-9a-f-]{36}$/.test(value.targetDeviceId) ||
      !Number.isSafeInteger(value.expectedEpoch) || (value.expectedEpoch as number) < 1 ||
      typeof value.labelDigest !== "string" || value.confirmation !== "remove-device") return null;
  try { decodeBytes(value.labelDigest, 32); } catch { return null; }
  return value as Removal;
}

async function labelDigest(label: ArrayBuffer | null): Promise<string> {
  const encoded = label ? encodeBytes(new Uint8Array(label)) : "";
  return encodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded))));
}

/** A retry of the same signed, consumed request has no effects, even after the epoch advanced. */
export async function completedRemovalRetry(env: Env, session: ActiveSession, request: Request,
  proof: unknown, raw: string, value: Record<string, unknown> | null): Promise<boolean> {
  const body = removalBody(value);
  const now = Date.now();
  if (!body || !session.deviceId || session.deviceId === body.targetDeviceId ||
      !hasFreshAssertion(session, now)) return false;
  const row = await createDb(env.DB).get<{ assertion_public_key: ArrayBuffer }>(sql`
    SELECT actor.assertion_public_key FROM encryption_devices actor
    JOIN encryption_devices target ON target.account_id = actor.account_id
    JOIN device_proof_uses used ON used.account_id = actor.account_id
    WHERE actor.id = ${session.deviceId} AND actor.account_id = ${session.accountId}
      AND actor.state = 'active' AND target.id = ${body.targetDeviceId}
      AND target.state = 'tombstoned' AND target.revocation_reason = 'device-removal'
      AND used.session_id = ${session.id} AND used.proof_id = ${typeof proof === "object" && proof && "proofId" in proof ? proof.proofId : null}
      AND used.expires_at > ${now} AND ${freshNormalSessionGuard(session, now)}
      AND EXISTS (SELECT 1 FROM account_encryption_identities WHERE account_id = ${session.accountId}
        AND registry_epoch > ${body.expectedEpoch})`);
  return !!row && verifyDeviceProof(proof, new Uint8Array(row.assertion_public_key), {
    sessionBinding: await sessionBindingDigest(session.id), deviceId: session.deviceId,
    registryEpoch: body.expectedEpoch, method: request.method, url: request.url, body: raw,
  });
}

/** Conditional, serialized D1 batch; only the first guarded update can authorize side effects. */
export async function removeEncryptionDevice(env: Env, session: ActiveSession,
  authorized: AuthorizedDevice, value: Record<string, unknown> | null): Promise<Response> {
  const body = removalBody(value);
  const now = Date.now();
  if (!body || body.targetDeviceId === authorized.deviceId) return denied(400, "cannot_remove_device");
  if (body.expectedEpoch !== authorized.registryEpoch) return denied(409, "registry_changed");
  if (!hasFreshAssertion(session, now) || session.id !== authorized.sessionId ||
      authorized.expiresAt <= now) return denied(403);
  const proofDay = coarseProofTime(now);
  const target = await createDb(env.DB).get<{
    label_ciphertext: ArrayBuffer | null; state: string; revocation_reason: string | null;
  }>(sql`
    SELECT label_ciphertext, state, revocation_reason FROM encryption_devices WHERE id = ${body.targetDeviceId}
      AND account_id = ${authorized.accountId}`);
  if (!target || body.labelDigest !== await labelDigest(target.label_ciphertext)) {
    return denied(409, "registry_changed");
  }
  if (target.state === "tombstoned" && target.revocation_reason === "device-removal") {
    // After a lost response and expired proof, a new proof/confirmation at the
    // refreshed epoch can safely retry the same already-completed removal.
    const current = await createDb(env.DB).get<{ id: string }>(sql`
      SELECT id FROM encryption_devices WHERE id = ${body.targetDeviceId}
        AND account_id = ${authorized.accountId} AND state = 'tombstoned'
        AND revocation_reason = 'device-removal'
        AND label_ciphertext IS ${target.label_ciphertext === null ? null : new Uint8Array(target.label_ciphertext)}
        AND ${privateReadGuard(authorized)} AND ${freshNormalSessionGuard(session, now)}`);
    return current ? Response.json({ ok: true, alreadyRemoved: true }, { headers: noStore })
      : denied(409, "registry_changed");
  }
  if (target.state !== "active") return denied(409, "registry_changed");
  const markerId = crypto.randomUUID();
  const label = target.label_ciphertext === null ? null : new Uint8Array(target.label_ciphertext);
  const marker = sql`EXISTS (SELECT 1 FROM security_events WHERE id = ${markerId}
    AND account_id = ${authorized.accountId} AND action_class = 'device_removal')`;
  const guard = sql`EXISTS (SELECT 1 FROM sessions s
    JOIN encryption_devices actor ON actor.id = s.device_id AND actor.account_id = s.account_id
    JOIN account_encryption_identities registry ON registry.account_id = s.account_id
    WHERE s.id = ${authorized.sessionId} AND s.account_id = ${authorized.accountId}
      AND s.device_id = ${authorized.deviceId} AND actor.state = 'active'
      AND registry.registry_epoch = ${body.expectedEpoch})
    AND ${authorized.expiresAt} > ${now}
    AND ${freshNormalSessionGuard(session, now)}
    AND NOT EXISTS (SELECT 1 FROM device_proof_uses WHERE account_id = ${authorized.accountId}
      AND proof_id = ${authorized.proofId})`;
  try {
    const results = await atomicSqlBatch(env.DB, [
      sql`UPDATE encryption_devices SET state = 'tombstoned', revocation_reason = 'device-removal'
        WHERE id = ${body.targetDeviceId} AND account_id = ${authorized.accountId}
          AND state = 'active' AND label_ciphertext IS ${label}
          AND (SELECT count(*) FROM encryption_devices WHERE account_id = ${authorized.accountId}
            AND state = 'active') > 1 AND ${guard}`,
      sql`INSERT INTO device_proof_uses (account_id, proof_id, session_id, expires_at)
        SELECT ${authorized.accountId}, ${authorized.proofId}, ${authorized.sessionId}, ${authorized.expiresAt}
        WHERE changes() = 1`,
      sql`INSERT INTO security_events (id, created_at, expires_at, action_class,
        outcome, reason, account_id, proof_state, counter_state)
        SELECT ${markerId}, ${now}, ${now + MAX_EVENT_RETENTION_MS}, 'device_removal',
          'allow', 'allowed', ${authorized.accountId}, 'valid', 'allowed'
        WHERE changes() = 1`,
      sql`UPDATE sessions SET revoked_at = ${now}
        WHERE account_id = ${authorized.accountId} AND device_id = ${body.targetDeviceId}
          AND revoked_at IS NULL AND ${marker}`,
      sql`UPDATE key_envelopes SET superseded_at = ${now}
        WHERE account_id = ${authorized.accountId} AND recipient_id = ${body.targetDeviceId}
          AND superseded_at IS NULL AND ${marker}`,
      sql`UPDATE device_enrollments SET state = 'consumed', challenge_ciphertext = NULL,
        challenge_hash = NULL
        WHERE account_id = ${authorized.accountId} AND state IN ('pending', 'challenged')
          AND (approving_device_id = ${body.targetDeviceId}
            OR candidate_session_id IN (SELECT id FROM sessions WHERE account_id = ${authorized.accountId}
              AND device_id = ${body.targetDeviceId})) AND ${marker}`,
      sql`DELETE FROM recovery_enrollments WHERE account_id = ${authorized.accountId}
        AND session_id IN (SELECT id FROM sessions WHERE account_id = ${authorized.accountId}
          AND device_id = ${body.targetDeviceId}) AND ${marker}`,
      sql`DELETE FROM webauthn_challenges WHERE account_id = ${authorized.accountId}
        AND session_id IN (SELECT id FROM sessions WHERE account_id = ${authorized.accountId}
          AND device_id = ${body.targetDeviceId}) AND ${marker}`,
      sql`DELETE FROM share_comment_key_envelopes WHERE device_id = ${body.targetDeviceId} AND ${marker}`,
      sql`DELETE FROM grant_comment_key_envelopes WHERE device_id = ${body.targetDeviceId} AND ${marker}`,
      sql`DELETE FROM provisioning_needs WHERE device_id = ${body.targetDeviceId} AND ${marker}`,
      sql`DELETE FROM share_key_envelopes WHERE device_id = ${body.targetDeviceId} AND ${marker}`,
      sql`DELETE FROM grant_key_envelopes WHERE device_id = ${body.targetDeviceId} AND ${marker}`,
      sql`UPDATE crypto_jobs SET state = 'complete', updated_at = ${now}
        WHERE account_id = ${authorized.accountId} AND device_id = ${body.targetDeviceId}
          AND state = 'pending' AND ${marker}`,
      sql`UPDATE encryption_devices SET last_proof_at = ${proofDay}
        WHERE account_id = ${authorized.accountId} AND id = ${authorized.deviceId}
          AND ${marker} AND (last_proof_at IS NULL OR last_proof_at < ${proofDay})`,
    ]);
    // The membership trigger advances the epoch in the same statement, so D1
    // reports both writes in meta.changes. A failed guard still reports zero.
    if (!results[0]?.meta.changes) return denied(409, "registry_changed");
    if (results[1]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) throw new Error("Removal not committed");
    return Response.json({ ok: true, registryEpoch: body.expectedEpoch + 1 }, { headers: noStore });
  } catch { return denied(503, "temporarily_unavailable"); }
}
