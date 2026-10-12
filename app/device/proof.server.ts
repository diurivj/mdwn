import type { SQL } from "drizzle-orm";
import {
  atomicSqlBatch,
  createDb,
  deviceProofUses,
  registrationChallenges,
  webauthnChallenges,
  sql,
} from "~/shared/db/client.server";
import { getActiveSession, sessionCookieId, type ActiveSession } from "~/auth/session.server";
import { sessionBindingDigest, verifyDeviceProof, type DeviceProof } from "../shared/device/proof";

const COARSE_PROOF_MS = 86_400_000;
/** Record successful mutation proofs by UTC day; read proofs never write D1. */
export function coarseProofTime(now: number): number {
  return Math.floor(now / COARSE_PROOF_MS) * COARSE_PROOF_MS;
}

type ActiveDevice = { assertion_public_key: ArrayBuffer; registry_epoch: number };
export type AuthorizedDevice = {
  accountId: string;
  sessionId: string;
  deviceId: string;
  registryEpoch: number;
  assertionPublicKey: Uint8Array;
  proofId: string;
  expiresAt: number;
};

async function activeDevice(env: Env, accountId: string, deviceId: string): Promise<ActiveDevice | null> {
  return (
    (await createDb(env.DB).get<ActiveDevice>(sql`
    SELECT d.assertion_public_key, r.registry_epoch
    FROM encryption_devices d JOIN account_encryption_identities r ON r.account_id = d.account_id
    WHERE d.id = ${deviceId} AND d.account_id = ${accountId} AND d.state = 'active'
  `)) ?? null
  );
}

/**
 * The active device bound to the Session row this signed identifier names,
 * whether or not that Session is still live: the caller decides liveness.
 * A Session's device binding never changes after the Session is created.
 */
async function boundDevice(env: Env, sessionId: string): Promise<ActiveDevice | null> {
  return (
    (await createDb(env.DB).get<ActiveDevice>(sql`
    SELECT d.assertion_public_key, r.registry_epoch
    FROM sessions s
    JOIN encryption_devices d ON d.id = s.device_id AND d.account_id = s.account_id AND d.state = 'active'
    JOIN account_encryption_identities r ON r.account_id = d.account_id
    WHERE s.id = ${sessionId}
  `)) ?? null
  );
}

/**
 * Whether this request carries a live normal Session bound to a still-active
 * Encryption device, so signing in or up again would change nothing. Any other
 * Session can still sign in: a fresh Passkey assertion is how a browser's
 * Session becomes bound.
 */
export async function hasActiveDeviceSession(request: Request, env: Env): Promise<boolean> {
  const sessionId = await sessionCookieId(request, env);
  if (!sessionId) return false;
  const [session, device] = await Promise.all([getActiveSession(request, env), boundDevice(env, sessionId)]);
  return session?.purpose === "normal" && session.deviceId !== undefined && device !== null;
}

/** Prospective Session ID is the sign-in challenge ID; no Session exists until the assertion completes. */
export async function verifySignInDevice(
  env: Env,
  accountId: string,
  candidateSessionId: string,
  proof: unknown,
  request: Request,
  body: string,
): Promise<string | null> {
  if (!proof || typeof proof !== "object" || !("deviceId" in proof) || typeof proof.deviceId !== "string") return null;
  const device = await activeDevice(env, accountId, proof.deviceId);
  if (!device) return null;
  const valid = await verifyDeviceProof(proof, new Uint8Array(device.assertion_public_key), {
    sessionBinding: await sessionBindingDigest(candidateSessionId),
    deviceId: proof.deviceId,
    registryEpoch: device.registry_epoch,
    method: request.method,
    url: request.url,
    body,
  });
  return valid ? proof.deviceId : null;
}

/**
 * No persistent read-proof consumption: identical read requests cannot mutate
 * anything. Every D1 read is a network round trip, so the Session's bound
 * device is read beside the Session itself, keyed by the same signed
 * identifier; it counts only once `getActiveSession` finds that Session live.
 */
export async function authorizePrivateRequest(
  request: Request,
  env: Env,
  proof: unknown,
  body: string | Uint8Array = "",
): Promise<AuthorizedDevice | null> {
  const sessionId = await sessionCookieId(request, env);
  if (!sessionId) return null;
  const [session, device] = await Promise.all([getActiveSession(request, env), boundDevice(env, sessionId)]);
  return session ? verifySessionDevice(session, device, request, proof, body) : null;
}

export async function authorizeDeviceForSession(
  env: Env,
  session: ActiveSession,
  request: Request,
  proof: unknown,
  body: string | Uint8Array = "",
): Promise<AuthorizedDevice | null> {
  if (session.purpose !== "normal" || !session.deviceId) return null;
  return verifySessionDevice(
    session,
    await activeDevice(env, session.accountId, session.deviceId),
    request,
    proof,
    body,
  );
}

/** The proof must come from this Session's active device, at its current registry epoch. */
async function verifySessionDevice(
  session: ActiveSession,
  device: ActiveDevice | null,
  request: Request,
  proof: unknown,
  body: string | Uint8Array,
): Promise<AuthorizedDevice | null> {
  if (session.purpose !== "normal" || !session.deviceId) return null;
  if (
    !device ||
    !(await verifyDeviceProof(proof, new Uint8Array(device.assertion_public_key), {
      sessionBinding: await sessionBindingDigest(session.id),
      deviceId: session.deviceId,
      registryEpoch: device.registry_epoch,
      method: request.method,
      url: request.url,
      body,
    }))
  )
    return null;
  const verified = proof as DeviceProof;
  return {
    accountId: session.accountId,
    sessionId: session.id,
    deviceId: session.deviceId,
    registryEpoch: device.registry_epoch,
    assertionPublicKey: new Uint8Array(device.assertion_public_key),
    proofId: verified.proofId,
    expiresAt: verified.expiresAt,
  };
}

/** Recheck the live Session, device membership and epoch in the same SELECT that returns ciphertext. */
export function privateReadGuard(authorization: AuthorizedDevice): SQL {
  const { accountId, sessionId, deviceId, registryEpoch } = authorization;
  const now = Date.now();
  return sql`${authorization.expiresAt} > ${now} AND EXISTS (SELECT 1 FROM sessions s
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
    db.delete(webauthnChallenges).where(sql`purpose = 'signup' AND expires_at <= ${now}`),
  ]);
}

function privateMutationGuard(authorization: AuthorizedDevice, now: number): SQL {
  const { accountId, sessionId, deviceId, registryEpoch, proofId } = authorization;
  return sql`EXISTS (SELECT 1 FROM sessions s JOIN encryption_devices d ON d.id = s.device_id
    JOIN account_encryption_identities r ON r.account_id = s.account_id
    WHERE s.id = ${sessionId} AND s.account_id = ${accountId} AND s.purpose = 'normal'
      AND s.authenticated_passkey_id IS NOT NULL AND s.device_id = ${deviceId}
      AND s.revoked_at IS NULL AND s.idle_expires_at > ${now} AND s.absolute_expires_at > ${now}
      AND d.account_id = s.account_id AND d.state = 'active' AND r.registry_epoch = ${registryEpoch})
    AND NOT EXISTS (SELECT 1 FROM device_proof_uses
      WHERE account_id = ${accountId} AND proof_id = ${proofId})`;
}

export async function commitPrivateMutation(
  env: Env,
  authorization: AuthorizedDevice,
  mutation: (guard: SQL) => SQL,
): Promise<boolean> {
  const now = Date.now();
  if (authorization.expiresAt <= now) return false;
  const proofDay = coarseProofTime(now);
  const { accountId, sessionId, deviceId, proofId, expiresAt } = authorization;
  const guard = privateMutationGuard(authorization, now);
  const [changed, consumed] = await atomicSqlBatch(env.DB, [
    mutation(guard),
    sql`INSERT INTO device_proof_uses (account_id, proof_id, session_id, expires_at)
      SELECT ${accountId}, ${proofId}, ${sessionId}, ${expiresAt} WHERE changes() = 1`,
    // Coarse successful mutation-proof use only. Read proofs must never write D1.
    sql`UPDATE encryption_devices SET last_proof_at = ${proofDay}
      WHERE id = ${deviceId} AND account_id = ${accountId} AND changes() = 1
        AND (last_proof_at IS NULL OR last_proof_at < ${proofDay})`,
  ]);
  return changed.meta.changes === 1 && consumed.meta.changes === 1;
}

function mutationProofStatements(
  authorization: AuthorizedDevice,
  now: number,
): {
  committed: SQL;
  consume: SQL;
  recordActivity: SQL;
} {
  const { accountId, sessionId, deviceId, proofId, expiresAt } = authorization;
  const token = crypto.randomUUID();
  const proofDay = coarseProofTime(now);
  const committed = sql`EXISTS (SELECT 1 FROM device_proof_uses WHERE account_id = ${accountId}
    AND proof_id = ${proofId} AND commit_token = ${token})`;
  return {
    committed,
    consume: sql`INSERT INTO device_proof_uses (account_id, proof_id, session_id, expires_at, commit_token)
      SELECT ${accountId}, ${proofId}, ${sessionId}, ${expiresAt}, ${token} WHERE changes() = 1`,
    recordActivity: sql`UPDATE encryption_devices SET last_proof_at = ${proofDay}
      WHERE id = ${deviceId} AND account_id = ${accountId} AND ${committed}
        AND (last_proof_at IS NULL OR last_proof_at < ${proofDay})`,
  };
}

/** One conditional anchor and zero/many dependent writes under the same proof.
 * A fresh invocation token, not changes() or a reusable proof ID, gates dependents.
 */
export async function commitPrivateBatch(
  env: Env,
  authorization: AuthorizedDevice,
  anchor: (guard: SQL) => SQL,
  statements: (committed: SQL) => readonly SQL[],
  options: { deferForeignKeys?: boolean } = {},
): Promise<boolean> {
  const now = Date.now();
  if (authorization.expiresAt <= now) return false;
  const { committed, consume, recordActivity } = mutationProofStatements(authorization, now);
  const results = await atomicSqlBatch(env.DB, [
    ...(options.deferForeignKeys ? [sql`PRAGMA defer_foreign_keys = ON`] : []),
    anchor(privateMutationGuard(authorization, now)),
    consume,
    ...statements(committed),
    recordActivity,
  ]);
  const offset = options.deferForeignKeys ? 1 : 0;
  return results[offset]!.meta.changes === 1 && results[offset + 1]!.meta.changes === 1;
}

export type DirectoryChange = {
  directoryId: string;
  expectedRevision: number;
  head: { ciphertext: Uint8Array; digest: Uint8Array; signature: Uint8Array };
};

/** Multi-namespace/bulk tree boundary. Every revision and live authority is
 * checked before the first CAS. A fresh server-only marker (not the client proof
 * ID alone) gates all subsequent writes, including zero/many-row deletions.
 * D1 defers the reciprocal RESTRICT FKs only within this atomic batch; they must
 * agree again at commit. A reused proof can never authorize these dependents.
 */
export async function commitTreeMutation(
  env: Env,
  authorization: AuthorizedDevice,
  changes: readonly [DirectoryChange, ...DirectoryChange[]],
  eligible: SQL,
  statements: (committed: SQL) => readonly SQL[],
  contentOwnerId = authorization.accountId,
): Promise<boolean> {
  const now = Date.now();
  if (authorization.expiresAt <= now || new Set(changes.map((change) => change.directoryId)).size !== changes.length)
    return false;
  const { deviceId } = authorization;
  const { committed, consume, recordActivity } = mutationProofStatements(authorization, now);
  const revisions = sql.join(
    changes.map(
      (change) => sql`EXISTS (SELECT 1 FROM directories
    WHERE node_id = ${change.directoryId} AND owner_id = ${contentOwnerId} AND entries_revision = ${change.expectedRevision})`,
    ),
    sql` AND `,
  );
  const update = (change: DirectoryChange, guard: SQL) => sql`UPDATE directories
    SET entries_revision = entries_revision + 1, listing_ciphertext = ${change.head.ciphertext},
      listing_digest = ${change.head.digest}, listing_signature = ${change.head.signature}, listing_device_id = ${deviceId}
    WHERE node_id = ${change.directoryId} AND owner_id = ${contentOwnerId}
      AND entries_revision = ${change.expectedRevision} AND ${guard}`;
  const [, changed, consumed] = await atomicSqlBatch(env.DB, [
    sql`PRAGMA defer_foreign_keys = ON`,
    update(changes[0], sql`${privateMutationGuard(authorization, now)} AND ${revisions} AND ${eligible}`),
    consume,
    ...changes.slice(1).map((change) => update(change, committed)),
    ...statements(committed),
    recordActivity,
  ]);
  return changed!.meta.changes === 1 && consumed!.meta.changes === 1;
}

/** One proof, one parent namespace CAS and its dependent writes in a D1 transaction.
 * No dependent statement may mutate without the freshly consumed proof row.
 * If the CAS loses, the batch commits zero changes, including zero proof uses.
 */
export async function commitDirectoryMutation(
  env: Env,
  authorization: AuthorizedDevice,
  parentId: string,
  expectedRevision: number,
  listingHead: { ciphertext: Uint8Array; digest: Uint8Array; signature: Uint8Array },
  eligible: SQL,
  statements: (committed: SQL) => readonly SQL[],
  contentOwnerId = authorization.accountId,
): Promise<boolean> {
  const now = Date.now();
  if (authorization.expiresAt <= now) return false;
  const { accountId, sessionId, deviceId, proofId, expiresAt } = authorization;
  const guard = privateMutationGuard(authorization, now);
  // changes() is the preceding statement's *direct* row count. Chaining it
  // prevents a previously spent proof from authorizing dependent statements.
  const committed = sql`changes() = 1`;
  const [changed, consumed] = await atomicSqlBatch(env.DB, [
    sql`UPDATE directories SET entries_revision = entries_revision + 1,
        listing_ciphertext = ${listingHead.ciphertext}, listing_digest = ${listingHead.digest},
        listing_signature = ${listingHead.signature}, listing_device_id = ${deviceId}
      WHERE node_id = ${parentId} AND owner_id = ${contentOwnerId}
        AND entries_revision = ${expectedRevision} AND ${eligible} AND ${guard}`,
    sql`INSERT INTO device_proof_uses (account_id, proof_id, session_id, expires_at)
      SELECT ${accountId}, ${proofId}, ${sessionId}, ${expiresAt} WHERE changes() = 1`,
    ...statements(committed),
    sql`UPDATE encryption_devices SET last_proof_at = ${coarseProofTime(now)}
      WHERE id = ${deviceId} AND account_id = ${accountId} AND ${committed}
        AND (last_proof_at IS NULL OR last_proof_at < ${coarseProofTime(now)})`,
  ]);
  return changed.meta.changes === 1 && consumed.meta.changes === 1;
}
