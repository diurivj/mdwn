import type { SQL } from "drizzle-orm";
import { atomicSqlBatch, createDb, deviceProofUses, registrationChallenges, webauthnChallenges, sql } from "~/db/client.server";
import { getActiveSession, type ActiveSession } from "~/auth/session.server";
import { sessionBindingDigest, verifyDeviceProof, type DeviceProof } from "./proof";

type ActiveDevice = { assertion_public_key: ArrayBuffer; registry_epoch: number };
export type AuthorizedDevice = {
  accountId: string;
  sessionId: string;
  deviceId: string;
  registryEpoch: number;
  proofId: string;
  expiresAt: number;
};

async function activeDevice(env: Env, accountId: string, deviceId: string): Promise<ActiveDevice | null> {
  return (await createDb(env.DB).get<ActiveDevice>(sql`
    SELECT d.assertion_public_key, r.registry_epoch
    FROM encryption_devices d JOIN account_encryption_identities r ON r.account_id = d.account_id
    WHERE d.id = ${deviceId} AND d.account_id = ${accountId} AND d.state = 'active'
  `)) ?? null;
}

/** Prospective Session ID is the sign-in challenge ID; no Session exists until the assertion completes. */
export async function verifySignInDevice(
  env: Env, accountId: string, candidateSessionId: string,
  proof: unknown, request: Request, body: string,
): Promise<string | null> {
  if (!proof || typeof proof !== "object" || !("deviceId" in proof) ||
      typeof proof.deviceId !== "string") return null;
  const device = await activeDevice(env, accountId, proof.deviceId);
  if (!device) return null;
  const valid = await verifyDeviceProof(proof, new Uint8Array(device.assertion_public_key), {
    sessionBinding: await sessionBindingDigest(candidateSessionId), deviceId: proof.deviceId,
    registryEpoch: device.registry_epoch, method: request.method, url: request.url, body,
  });
  return valid ? proof.deviceId : null;
}

/** No persistent read-proof consumption: identical read requests cannot mutate anything. */
export async function authorizePrivateRequest(
  request: Request, env: Env, proof: unknown, body = "",
): Promise<AuthorizedDevice | null> {
  const session = await getActiveSession(request, env);
  return session ? authorizeDeviceForSession(env, session, request, proof, body) : null;
}

export async function authorizeDeviceForSession(
  env: Env, session: ActiveSession, request: Request, proof: unknown, body = "",
): Promise<AuthorizedDevice | null> {
  if (session.purpose !== "normal" || !session.deviceId) return null;
  const device = await activeDevice(env, session.accountId, session.deviceId);
  if (!device || !await verifyDeviceProof(proof, new Uint8Array(device.assertion_public_key), {
    sessionBinding: await sessionBindingDigest(session.id), deviceId: session.deviceId,
    registryEpoch: device.registry_epoch, method: request.method, url: request.url, body,
  })) return null;
  const verified = proof as DeviceProof;
  return {
    accountId: session.accountId, sessionId: session.id, deviceId: session.deviceId,
    registryEpoch: device.registry_epoch, proofId: verified.proofId, expiresAt: verified.expiresAt,
  };
}

/** Recheck the live Session, device membership and epoch in the same SELECT that returns ciphertext. */
export function privateReadGuard(authorization: AuthorizedDevice): SQL {
  const { accountId, sessionId, deviceId, registryEpoch } = authorization;
  const now = Date.now();
  return sql`EXISTS (SELECT 1 FROM sessions s
    JOIN encryption_devices d ON d.id = s.device_id AND d.account_id = s.account_id
    JOIN account_encryption_identities r ON r.account_id = s.account_id
    WHERE s.id = ${sessionId} AND s.account_id = ${accountId}
      AND s.purpose = 'normal' AND s.authenticated_passkey_id IS NOT NULL
      AND s.device_id = ${deviceId} AND s.revoked_at IS NULL
      AND s.idle_expires_at > ${now} AND s.absolute_expires_at > ${now}
      AND d.state = 'active' AND r.registry_epoch = ${registryEpoch})`;
}

/**
 * Atomic mutation boundary. The caller's statement MUST place the provided
 * predicate alongside its expected revision/idempotency condition. The second
 * statement records a spent proof iff the first actually changed one row.
 * Duplicate IDs, Session/device revocation and epoch changes fail closed.
 */
export async function purgeExpiredSignupProofs(env: Env, now = Date.now()): Promise<void> {
  const db = createDb(env.DB);
  await db.batch([
    db.delete(deviceProofUses).where(sql`expires_at <= ${now}`),
    db.delete(registrationChallenges).where(sql`expires_at <= ${now}`),
    db.delete(webauthnChallenges)
      .where(sql`purpose = 'signup' AND expires_at <= ${now}`),
  ]);
}

export async function commitPrivateMutation(
  env: Env,
  authorization: AuthorizedDevice,
  mutation: (guard: SQL) => SQL,
): Promise<boolean> {
  const now = Date.now();
  if (authorization.expiresAt <= now) return false;
  const { accountId, sessionId, deviceId, registryEpoch, proofId, expiresAt } = authorization;
  const guard = sql`
    EXISTS (SELECT 1 FROM sessions s JOIN encryption_devices d ON d.id = s.device_id
      JOIN account_encryption_identities r ON r.account_id = s.account_id
      WHERE s.id = ${sessionId} AND s.account_id = ${accountId} AND s.purpose = 'normal'
        AND s.authenticated_passkey_id IS NOT NULL
        AND s.device_id = ${deviceId} AND s.revoked_at IS NULL
        AND s.idle_expires_at > ${now} AND s.absolute_expires_at > ${now}
        AND d.account_id = s.account_id AND d.state = 'active'
        AND r.registry_epoch = ${registryEpoch})
      AND NOT EXISTS (SELECT 1 FROM device_proof_uses
        WHERE account_id = ${accountId} AND proof_id = ${proofId})
  `;
  const [changed, consumed] = await atomicSqlBatch(env.DB, [
    mutation(guard),
    sql`INSERT INTO device_proof_uses (account_id, proof_id, session_id, expires_at)
      SELECT ${accountId}, ${proofId}, ${sessionId}, ${expiresAt} WHERE changes() = 1`,
    // Coarse successful mutation-proof use only. Read proofs must never write D1.
    sql`UPDATE encryption_devices SET last_proof_at = ${Math.floor(now / 86_400_000) * 86_400_000}
      WHERE id = ${deviceId} AND account_id = ${accountId} AND changes() = 1
        AND (last_proof_at IS NULL OR last_proof_at < ${Math.floor(now / 86_400_000) * 86_400_000})`,
  ]);
  return changed.meta.changes === 1 && consumed.meta.changes === 1;
}
