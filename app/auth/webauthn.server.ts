import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { atomicSqlBatch, createDb, passkeys, sessions, sql } from "~/shared/db/client.server";
import { sessionBindingDigest } from "~/shared/device/proof";
import { verifySignInDevice } from "~/device/proof.server";

import type { AssertionStart, PasskeySummary, RegistrationStart } from "./contracts";

import {
  FRESH_ASSERTION_MS,
  assertSessionConfiguration,
  createNormalSession,
  hasFreshAssertion,
  prepareBoundSession,
  signSessionId,
  type ActiveSession,
} from "./session.server";

export const WEBAUTHN_CHALLENGE_MS = 5 * 60 * 1_000;

type ChallengePurpose =
  | "sign_in"
  | "fresh_assertion"
  | "passkey_registration";

type ChallengeRow = {
  challenge: string;
  origin: string;
  rp_id: string;
};

type PasskeyRow = {
  credential_id: string;
  account_id: string;
  public_key: ArrayBuffer;
  counter: number;
  transports: string;
};

type PasskeyCredentialRow = Pick<PasskeyRow, "credential_id" | "transports">;

/** WebAuthn resident credentials bind their user handle to the opaque Account ID. */
export function accountUserHandle(accountId: string): string {
  const bytes = new TextEncoder().encode(accountId);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function relyingParty(request: Request): { origin: string; rpId: string } {
  const url = new URL(request.url);
  return { origin: url.origin, rpId: url.hostname };
}

function parseTransports(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function credentialResponse<T extends { id: string }>(value: unknown): T | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { id?: unknown }).id !== "string"
  ) {
    return null;
  }
  // The ceremony verifier validates the rest of the untrusted response.
  return value as T;
}

async function createChallenge(
  env: Env,
  purpose: ChallengePurpose,
  request: Request,
  challenge: string,
  accountId: string | null,
  sessionId: string | null,
): Promise<string> {
  const { origin, rpId } = relyingParty(request);
  const now = Date.now();
  const id = crypto.randomUUID();
  await createDb(env.DB).run(sql`
    INSERT INTO webauthn_challenges (
      id, challenge, purpose, account_id, session_id, origin, rp_id, expires_at, created_at
    ) VALUES (
      ${id}, ${challenge}, ${purpose}, ${accountId}, ${sessionId}, ${origin}, ${rpId},
      ${now + WEBAUTHN_CHALLENGE_MS}, ${now}
    )
  `);
  return id;
}

async function consumeChallenge(
  env: Env,
  purpose: ChallengePurpose,
  challengeId: string,
  request: Request,
  accountId: string | null,
  sessionId: string | null,
): Promise<ChallengeRow | null> {
  const { origin, rpId } = relyingParty(request);
  const row = await createDb(env.DB).get<ChallengeRow>(sql`
    DELETE FROM webauthn_challenges
     WHERE id = ${challengeId}
       AND purpose = ${purpose}
       AND expires_at > ${Date.now()}
       AND account_id IS ${accountId}
       AND session_id IS ${sessionId}
       AND origin = ${origin}
       AND rp_id = ${rpId}
     RETURNING challenge, origin, rp_id
  `);
  return row ?? null;
}

async function accountPasskeys(
  env: Env,
  accountId: string,
): Promise<PasskeyCredentialRow[]> {
  return createDb(env.DB).all<PasskeyCredentialRow>(sql`
    SELECT credential_id, transports
    FROM passkeys
    WHERE account_id = ${accountId}
    ORDER BY created_at ASC, credential_id ASC
  `);
}

function allowCredentials(passkeys: PasskeyCredentialRow[]) {
  return passkeys.map((passkey) => ({
    id: passkey.credential_id,
    transports: parseTransports(passkey.transports),
  }));
}

function optionalUserHandleMatches(
  response: AuthenticationResponseJSON,
  accountId: string,
): boolean {
  const userHandle = response.response?.userHandle;
  return userHandle === undefined || userHandle === accountUserHandle(accountId);
}

async function verifyAssertion(
  response: AuthenticationResponseJSON,
  passkey: PasskeyRow,
  challenge: ChallengeRow,
): Promise<Awaited<ReturnType<typeof verifyAuthenticationResponse>> | null> {
  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rp_id,
      credential: {
        id: passkey.credential_id,
        publicKey: new Uint8Array(passkey.public_key),
        counter: passkey.counter,
        transports: parseTransports(passkey.transports),
      },
      requireUserVerification: true,
    });
    return verification.verified ? verification : null;
  } catch {
    return null;
  }
}

async function verifyAccountAssertion(
  env: Env,
  accountId: string,
  response: AuthenticationResponseJSON,
  challenge: ChallengeRow,
): Promise<{
  passkey: PasskeyRow;
  verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
} | null> {
  const passkey = await createDb(env.DB).get<PasskeyRow>(sql`
    SELECT credential_id, account_id, public_key, counter, transports
    FROM passkeys
    WHERE credential_id = ${response.id} AND account_id = ${accountId}
  `);
  if (!passkey || !optionalUserHandleMatches(response, accountId)) return null;

  const verification = await verifyAssertion(response, passkey, challenge);
  return verification ? { passkey, verification } : null;
}

function updatePasskeyCounter(
  passkey: PasskeyRow,
  verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>,
  now: number,
) {
  if (!verification.verified) throw new Error("expected a verified assertion");
  return sql`
    UPDATE passkeys
    SET counter = ${verification.authenticationInfo.newCounter},
        device_type = ${verification.authenticationInfo.credentialDeviceType},
        backed_up = ${verification.authenticationInfo.credentialBackedUp ? 1 : 0},
        updated_at = ${now}
    WHERE credential_id = ${passkey.credential_id}
      AND account_id = ${passkey.account_id}
      AND counter = ${passkey.counter}
  `;
}

/** Starts a usernameless passkey assertion and persists its one-use challenge. */
export async function beginSignIn(request: Request, env: Env): Promise<AssertionStart> {
  assertSessionConfiguration(env);
  const { rpId } = relyingParty(request);
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    userVerification: "required",
  });
  const challengeId = await createChallenge(
    env,
    "sign_in",
    request,
    options.challenge,
    null,
    null,
  );
  return { challengeId, options, sessionBinding: await sessionBindingDigest(challengeId) };
}

/**
 * Verifies a passkey assertion and creates the normal Session only while its
 * credential is still present. Usernameless sign-in requires the credential's
 * resident user handle to match the Account it authenticates.
 */
export async function completeSignIn(
  request: Request,
  env: Env,
  challengeId: string,
  payload: unknown,
  deviceProof?: unknown,
): Promise<{ setCookie: string; bound: boolean } | null> {
  const challenge = await consumeChallenge(
    env,
    "sign_in",
    challengeId,
    request,
    null,
    null,
  );
  if (!challenge) return null;

  const response = credentialResponse<AuthenticationResponseJSON>(payload);
  if (!response) return null;

  const passkey = await createDb(env.DB).get<PasskeyRow>(sql`
    SELECT credential_id, account_id, public_key, counter, transports
    FROM passkeys
    WHERE credential_id = ${response.id}
  `);
  if (!passkey || response.response?.userHandle !== accountUserHandle(passkey.account_id)) {
    return null;
  }

  const verification = await verifyAssertion(response, passkey, challenge);
  if (!verification) return null;

  const deviceId = await verifySignInDevice(
    env, passkey.account_id, challengeId, deviceProof, request,
    JSON.stringify({ challengeId, response }),
  );
  const now = Date.now();
  const counterUpdated = await createDb(env.DB).run(
    updatePasskeyCounter(passkey, verification, now),
  );
  if (counterUpdated.meta.changes !== 1) return null;

  if (deviceId) {
    const result = await atomicSqlBatch(env.DB, [
      prepareBoundSession(env, challengeId, passkey.account_id, passkey.credential_id, deviceId, now),
    ]);
    if (result[0]?.meta.changes === 1) {
      return { setCookie: await signSessionId(env, challengeId), bound: true };
    }
  }
  // No active key/proof at creation: a genuinely unprovisioned normal Session.
  return { setCookie: await createNormalSession(env, passkey.account_id, passkey.credential_id), bound: false };
}

/** Begins a known-Account assertion that can renew a normal Session's freshness. */
export async function beginFreshAssertion(
  request: Request,
  env: Env,
  session: ActiveSession,
): Promise<AssertionStart> {
  const { rpId } = relyingParty(request);
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: allowCredentials(await accountPasskeys(env, session.accountId)),
    userVerification: "required",
  });
  const challengeId = await createChallenge(
    env,
    "fresh_assertion",
    request,
    options.challenge,
    session.accountId,
    session.id,
  );
  return { challengeId, options };
}

/**
 * Consumes a Session-bound assertion and only marks that same live normal
 * Session fresh if its asserted Account credential's counter also advanced.
 */
export async function completeFreshAssertion(
  request: Request,
  env: Env,
  session: ActiveSession,
  challengeId: string,
  payload: unknown,
): Promise<boolean> {
  const challenge = await consumeChallenge(
    env,
    "fresh_assertion",
    challengeId,
    request,
    session.accountId,
    session.id,
  );
  if (!challenge) return false;

  const response = credentialResponse<AuthenticationResponseJSON>(payload);
  if (!response) return false;
  const asserted = await verifyAccountAssertion(env, session.accountId, response, challenge);
  if (!asserted || !asserted.verification.verified) return false;

  const now = Date.now();
  const db = createDb(env.DB);
  const counterStatement = db
    .update(passkeys)
    .set({
      counter: asserted.verification.authenticationInfo.newCounter,
      deviceType: asserted.verification.authenticationInfo.credentialDeviceType,
      backedUp: asserted.verification.authenticationInfo.credentialBackedUp,
      updatedAt: now,
    })
    .where(sql`
      credential_id = ${asserted.passkey.credential_id}
      AND account_id = ${asserted.passkey.account_id}
      AND counter = ${asserted.passkey.counter}
    `);
  const sessionStatement = db
    .update(sessions)
    .set({ freshAssertedAt: now })
    .where(sql`
     id = ${session.id}
       AND account_id = ${session.accountId}
       AND purpose = 'normal'
       AND revoked_at IS NULL
       AND idle_expires_at > ${now}
       AND absolute_expires_at > ${now}
       AND authenticated_passkey_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM passkeys
         WHERE credential_id = ${asserted.passkey.credential_id}
           AND account_id = ${session.accountId}
           AND counter = ${asserted.verification.authenticationInfo.newCounter}
       )
       AND EXISTS (
         SELECT 1 FROM passkeys AS authenticated_passkey
         WHERE authenticated_passkey.credential_id = sessions.authenticated_passkey_id
           AND authenticated_passkey.account_id = sessions.account_id
       )
       AND changes() = 1
    `);
  const [counterUpdated, sessionUpdated] = await db.batch([
    counterStatement,
    sessionStatement,
  ]);
  return counterUpdated.meta.changes === 1 && sessionUpdated.meta.changes === 1;
}

/** Generates a resident, user-verified, none-attestation Passkey registration ceremony. */
export async function beginPasskeyRegistration(
  request: Request,
  env: Env,
  session: ActiveSession,
): Promise<RegistrationStart | null> {
  if (!hasFreshAssertion(session)) return null;
  const { rpId } = relyingParty(request);
  const options = await generateRegistrationOptions({
    rpName: "mdwn",
    rpID: rpId,
    userID: new TextEncoder().encode(session.accountId),
    userName: "mdwn Account",
    userDisplayName: "mdwn",
    attestationType: "none",
    excludeCredentials: allowCredentials(await accountPasskeys(env, session.accountId)),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
  const challengeId = await createChallenge(
    env,
    "passkey_registration",
    request,
    options.challenge,
    session.accountId,
    session.id,
  );
  return { challengeId, options };
}

/**
 * Inserts a newly verified resident Passkey only when the original Session is
 * still live, normal, freshly asserted, and backed by an Account credential.
 */
export async function completePasskeyRegistration(
  request: Request,
  env: Env,
  session: ActiveSession,
  challengeId: string,
  payload: unknown,
): Promise<boolean> {
  const challenge = await consumeChallenge(
    env,
    "passkey_registration",
    challengeId,
    request,
    session.accountId,
    session.id,
  );
  if (!challenge) return false;

  const response = credentialResponse<RegistrationResponseJSON>(payload);
  if (!response) return false;

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rp_id,
      requireUserVerification: true,
    });
  } catch {
    return false;
  }
  if (!verification.verified) return false;

  const credential = verification.registrationInfo.credential;
  if (credential.id !== response.id) return false;
  const now = Date.now();
  const result = await createDb(env.DB).run(sql`
    INSERT OR IGNORE INTO passkeys (
      credential_id, account_id, public_key, counter, transports,
      device_type, backed_up, created_at, updated_at
    )
    SELECT ${credential.id}, ${session.accountId}, ${credential.publicKey}, ${credential.counter},
      ${JSON.stringify(credential.transports ?? [])},
      ${verification.registrationInfo.credentialDeviceType},
      ${verification.registrationInfo.credentialBackedUp ? 1 : 0}, ${now}, ${now}
    WHERE EXISTS (
      SELECT 1 FROM sessions
      WHERE id = ${session.id}
        AND account_id = ${session.accountId}
        AND purpose = 'normal'
        AND revoked_at IS NULL
        AND idle_expires_at > ${now}
        AND absolute_expires_at > ${now}
        AND fresh_asserted_at > ${now - FRESH_ASSERTION_MS}
        AND fresh_asserted_at <= ${now}
        AND authenticated_passkey_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM passkeys AS authenticated_passkey
          WHERE authenticated_passkey.credential_id = sessions.authenticated_passkey_id
            AND authenticated_passkey.account_id = sessions.account_id
        )
    )
      AND NOT EXISTS (SELECT 1 FROM passkeys WHERE credential_id = ${credential.id})
  `);
  return result.meta.changes === 1;
}

/** Lists opaque credential identifiers for the authenticated Account only. */
export async function listPasskeys(
  env: Env,
  accountId: string,
  currentCredentialId: string,
): Promise<PasskeySummary[]> {
  const rows = await createDb(env.DB).all<{ credential_id: string; created_at: number }>(sql`
    SELECT credential_id, created_at FROM passkeys
    WHERE account_id = ${accountId}
    ORDER BY created_at ASC, credential_id ASC
  `);
  return rows.map((row) => ({
    id: row.credential_id,
    createdAt: row.created_at,
    current: row.credential_id === currentCredentialId,
  }));
}

/**
 * Deletes only a non-last Account Passkey and revokes every Session that it
 * authenticated. The D1 batch is transactional; its second statement is
 * explicitly gated on a successful conditional delete.
 */
export async function removePasskey(
  env: Env,
  session: ActiveSession,
  credentialId: string,
): Promise<boolean> {
  const now = Date.now();
  const db = createDb(env.DB);
  const deletePasskey = db.delete(passkeys).where(sql`
     credential_id = ${credentialId}
       AND account_id = ${session.accountId}
       AND (SELECT COUNT(*) FROM passkeys WHERE account_id = ${session.accountId}) > 1
       AND EXISTS (
         SELECT 1 FROM sessions
         WHERE id = ${session.id}
           AND account_id = ${session.accountId}
           AND purpose = 'normal'
           AND revoked_at IS NULL
           AND idle_expires_at > ${now}
           AND absolute_expires_at > ${now}
           AND fresh_asserted_at > ${now - FRESH_ASSERTION_MS}
           AND fresh_asserted_at <= ${now}
           AND authenticated_passkey_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM passkeys AS authenticated_passkey
             WHERE authenticated_passkey.credential_id = sessions.authenticated_passkey_id
               AND authenticated_passkey.account_id = sessions.account_id
           )
       )
  `);
  const revokeCredentialSessions = db
    .update(sessions)
    .set({ revokedAt: now })
    .where(sql`
     account_id = ${session.accountId}
       AND authenticated_passkey_id = ${credentialId}
       AND revoked_at IS NULL
       AND changes() = 1
       AND NOT EXISTS (
         SELECT 1 FROM passkeys
         WHERE credential_id = ${credentialId} AND account_id = ${session.accountId}
       )
    `);
  const [deleted] = await db.batch([deletePasskey, revokeCredentialSessions]);
  return deleted.meta.changes === 1;
}
