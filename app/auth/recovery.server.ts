import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { atomicSqlBatch, createDb, sql } from "~/db/client.server";
import {
  enforceRateLimit, MAX_EVENT_RETENTION_MS, rateLimitResponse,
} from "~/security/abuse-control.server";
import { decodeBytes, encodeBytes } from "~/signup/protocol";

import type { RegistrationStart } from "./contracts";
import {
  assertSessionConfiguration, FRESH_ASSERTION_MS, hasFreshAssertion,
  RECOVERY_SESSION_MS, signSessionId, type ActiveSession,
} from "./session.server";
import { WEBAUTHN_CHALLENGE_MS } from "./webauthn.server";

const identifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const codePattern = /^[A-Za-z0-9_-]{32}$/;
const encoder = new TextEncoder();

function failed(): Response {
  return Response.json({ error: "recovery_failed" }, {
    status: 401, headers: { "Cache-Control": "no-store" },
  });
}

function liveRecoverySession(session: ActiveSession, now: number) {
  return sql`EXISTS (
    SELECT 1 FROM sessions WHERE id = ${session.id} AND account_id = ${session.accountId}
      AND purpose = 'recovery' AND authenticated_passkey_id IS NULL AND device_id IS NULL
      AND revoked_at IS NULL AND created_at > ${now - RECOVERY_SESSION_MS}
      AND idle_expires_at > ${now} AND absolute_expires_at > ${now}
  )`;
}

function liveFreshSession(session: ActiveSession, now: number) {
  return sql`EXISTS (
    SELECT 1 FROM sessions WHERE id = ${session.id} AND account_id = ${session.accountId}
      AND purpose = 'normal' AND authenticated_passkey_id IS NOT NULL
      AND revoked_at IS NULL AND fresh_asserted_at > ${now - FRESH_ASSERTION_MS}
      AND fresh_asserted_at <= ${now} AND idle_expires_at > ${now}
      AND absolute_expires_at > ${now}
      AND EXISTS (SELECT 1 FROM passkeys
        WHERE credential_id = sessions.authenticated_passkey_id
          AND account_id = sessions.account_id)
  )`;
}

/** An Account ID is the non-secret recovery identifier, not a handle or share address. */
export async function beginAuthenticationRecovery(
  request: Request, env: Env, identifier: unknown, code: unknown,
): Promise<Response> {
  assertSessionConfiguration(env);
  // Even malformed/nonexistent identifiers spend the same global/network/identifier
  // quota. Never look up an Account or a code before the abuse-control decision.
  const candidate = typeof identifier === "string" && identifier.length <= 256 ? identifier : "invalid";
  const limit = await enforceRateLimit({
    db: env.DB, request, action: "recovery.attempt",
    scopes: { recoveryIdentifier: candidate }, hmacSecret: env.ABUSE_HMAC_SECRET,
  });
  if (!limit.allowed) return rateLimitResponse(limit);

  if (!identifierPattern.test(candidate) || typeof code !== "string" || !codePattern.test(code)) return failed();
  let codeBytes: Uint8Array;
  try { codeBytes = decodeBytes(code, 24); } catch { return failed(); }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(encodeBytes(codeBytes))));
  const now = Date.now();
  const id = crypto.randomUUID();
  const cookie = await signSessionId(env, id);
  const [consumed, created] = await atomicSqlBatch(env.DB, [
    sql`DELETE FROM authentication_recovery_codes
      WHERE account_id = ${candidate} AND code_hash = ${hash}`,
    sql`INSERT INTO sessions
      (id, account_id, purpose, authenticated_passkey_id, device_id, created_at,
       idle_expires_at, absolute_expires_at, fresh_asserted_at, refreshed_at, revoked_at)
      SELECT ${id}, ${candidate}, 'recovery', NULL, NULL, ${now},
        ${now + RECOVERY_SESSION_MS}, ${now + RECOVERY_SESSION_MS}, NULL, NULL, NULL
      WHERE changes() = 1 AND EXISTS (SELECT 1 FROM accounts WHERE id = ${candidate})`,
  ]);
  if (consumed?.meta.changes !== 1 || created?.meta.changes !== 1) return failed();
  return Response.json({ ok: true }, {
    headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" },
  });
}

/** Only a live restricted Session may obtain a replacement-Passkey challenge. */
export async function beginRecoveryRegistration(
  request: Request, env: Env, session: ActiveSession,
): Promise<RegistrationStart | null> {
  if (session.purpose !== "recovery") return null;
  const now = Date.now();
  const existing = await createDb(env.DB).all<{ credential_id: string }>(sql`
    SELECT credential_id FROM passkeys WHERE account_id = ${session.accountId}
  `);
  const options = await generateRegistrationOptions({
    rpName: "mdwn", rpID: new URL(request.url).hostname,
    userID: encoder.encode(session.accountId), userName: "mdwn Account", userDisplayName: "mdwn",
    attestationType: "none", authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials: existing.map((passkey) => ({ id: passkey.credential_id })),
  });
  const challengeId = crypto.randomUUID();
  const origin = new URL(request.url).origin;
  const rpId = new URL(request.url).hostname;
  const inserted = await createDb(env.DB).run(sql`
    INSERT INTO webauthn_challenges
      (id, challenge, purpose, account_id, session_id, origin, rp_id, expires_at, created_at)
    SELECT ${challengeId}, ${options.challenge}, 'passkey_registration', ${session.accountId},
      ${session.id}, ${origin}, ${rpId}, ${now + WEBAUTHN_CHALLENGE_MS}, ${now}
    WHERE ${liveRecoverySession(session, now)}
  `);
  return inserted.meta.changes === 1 ? { challengeId, options } : null;
}

/** The replacement credential, global revocation and bounded event commit together. */
export async function completeRecoveryRegistration(
  request: Request, env: Env, session: ActiveSession, challengeId: string, payload: unknown,
): Promise<boolean> {
  if (session.purpose !== "recovery") return false;
  const now = Date.now();
  const origin = new URL(request.url).origin;
  const rpId = new URL(request.url).hostname;
  const challenge = await createDb(env.DB).get<{ challenge: string }>(sql`
    DELETE FROM webauthn_challenges
    WHERE id = ${challengeId} AND purpose = 'passkey_registration'
      AND account_id = ${session.accountId} AND session_id = ${session.id}
      AND origin = ${origin} AND rp_id = ${rpId} AND expires_at > ${now}
      AND ${liveRecoverySession(session, now)}
    RETURNING challenge
  `);
  if (!challenge || !payload || typeof payload !== "object" || Array.isArray(payload) ||
      typeof (payload as { id?: unknown }).id !== "string") return false;

  const response = payload as RegistrationResponseJSON;
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response, expectedChallenge: challenge.challenge, expectedOrigin: origin,
      expectedRPID: rpId, requireUserVerification: true,
    });
  } catch { return false; }
  if (!verification.verified || verification.registrationInfo.credential.id !== response.id) return false;

  const credential = verification.registrationInfo.credential;
  const committedAt = Date.now();
  const eventId = crypto.randomUUID();
  const [inserted, revoked, event] = await atomicSqlBatch(env.DB, [
    sql`INSERT OR IGNORE INTO passkeys
      (credential_id, account_id, public_key, counter, transports, device_type,
       backed_up, created_at, updated_at)
      SELECT ${credential.id}, ${session.accountId}, ${credential.publicKey}, ${credential.counter},
        ${JSON.stringify(credential.transports ?? [])}, ${verification.registrationInfo.credentialDeviceType},
        ${verification.registrationInfo.credentialBackedUp ? 1 : 0}, ${committedAt}, ${committedAt}
      WHERE ${liveRecoverySession(session, committedAt)}
        AND NOT EXISTS (SELECT 1 FROM passkeys WHERE credential_id = ${credential.id})`,
    sql`UPDATE sessions SET revoked_at = ${committedAt}
      WHERE account_id = ${session.accountId} AND revoked_at IS NULL AND changes() = 1`,
    sql`INSERT INTO security_events
      (id, created_at, expires_at, action_class, outcome, reason, account_id,
       publication_id, size_class, proof_state, counter_state, retry_at,
       network_bucket, network_bucket_expires_at)
      SELECT ${eventId}, ${committedAt}, ${committedAt + MAX_EVENT_RETENTION_MS},
        'recovery', 'allow', 'allowed', ${session.accountId}, NULL, NULL,
        'valid', 'allowed', NULL, NULL, NULL
      WHERE changes() > 0`,
  ]);
  return inserted?.meta.changes === 1 && (revoked?.meta.changes ?? 0) > 0 && event?.meta.changes === 1;
}

/** A recently asserted normal Session may replace all remaining codes at once. */
export async function replaceAuthenticationRecoveryCodes(
  env: Env, session: ActiveSession, hashes: unknown,
): Promise<boolean> {
  if (!hasFreshAssertion(session) || !Array.isArray(hashes) || hashes.length !== 10) return false;
  let decoded: Uint8Array[];
  try {
    decoded = hashes.map((hash: unknown) => decodeBytes(hash as string, 32));
  } catch { return false; }
  if (new Set(hashes as string[]).size !== 10) return false;
  const now = Date.now();
  const results = await atomicSqlBatch(env.DB, [
    sql`DELETE FROM authentication_recovery_codes
      WHERE account_id = ${session.accountId} AND ${liveFreshSession(session, now)}`,
    ...decoded.map((hash, ordinal) => sql`INSERT INTO authentication_recovery_codes
      (account_id, ordinal, code_hash)
      SELECT ${session.accountId}, ${ordinal}, ${hash}
      WHERE ${liveFreshSession(session, now)}`),
  ]);
  return results.slice(1).every((result) => result.meta.changes === 1);
}
