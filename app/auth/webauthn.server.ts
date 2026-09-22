import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

import {
  FRESH_ASSERTION_MS,
  assertSessionConfiguration,
  createNormalSession,
  hasFreshAssertion,
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

export type SignInOptions = {
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
};

export type FreshAssertionOptions = SignInOptions;

export type PasskeyRegistrationOptions = {
  challengeId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
};

export type PasskeySummary = {
  id: string;
  createdAt: number;
  current: boolean;
};

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

function asAuthenticationResponse(value: unknown): AuthenticationResponseJSON | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { id?: unknown }).id !== "string"
  ) {
    return null;
  }
  return value as AuthenticationResponseJSON;
}

function asRegistrationResponse(value: unknown): RegistrationResponseJSON | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { id?: unknown }).id !== "string"
  ) {
    return null;
  }
  return value as RegistrationResponseJSON;
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
  await env.DB.prepare(
    `INSERT INTO webauthn_challenges (
      id, challenge, purpose, account_id, session_id, origin, rp_id, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      challenge,
      purpose,
      accountId,
      sessionId,
      origin,
      rpId,
      now + WEBAUTHN_CHALLENGE_MS,
      now,
    )
    .run();
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
  const row = await env.DB.prepare(
    `DELETE FROM webauthn_challenges
     WHERE id = ?
       AND purpose = ?
       AND expires_at > ?
       AND account_id IS ?
       AND session_id IS ?
       AND origin = ?
       AND rp_id = ?
     RETURNING challenge, origin, rp_id`,
  )
    .bind(challengeId, purpose, Date.now(), accountId, sessionId, origin, rpId)
    .first<ChallengeRow>();
  return row ?? null;
}

async function accountPasskeys(
  env: Env,
  accountId: string,
): Promise<PasskeyCredentialRow[]> {
  const result = await env.DB
    .prepare(
      "SELECT credential_id, transports FROM passkeys WHERE account_id = ? ORDER BY created_at ASC, credential_id ASC",
    )
    .bind(accountId)
    .all<PasskeyCredentialRow>();
  return result.results;
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

async function verifyAccountAssertion(
  env: Env,
  accountId: string,
  response: AuthenticationResponseJSON,
  challenge: ChallengeRow,
): Promise<{
  passkey: PasskeyRow;
  verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
} | null> {
  const passkey = await env.DB.prepare(
    `SELECT credential_id, account_id, public_key, counter, transports
     FROM passkeys WHERE credential_id = ? AND account_id = ?`,
  )
    .bind(response.id, accountId)
    .first<PasskeyRow>();
  if (!passkey || !optionalUserHandleMatches(response, accountId)) return null;

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
    return verification.verified ? { passkey, verification } : null;
  } catch {
    return null;
  }
}

function updatePasskeyCounter(
  env: Env,
  passkey: PasskeyRow,
  verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>,
  now: number,
) {
  if (!verification.verified) throw new Error("expected a verified assertion");
  return env.DB.prepare(
    `UPDATE passkeys
     SET counter = ?, device_type = ?, backed_up = ?, updated_at = ?
     WHERE credential_id = ? AND account_id = ? AND counter = ?`,
  )
    .bind(
      verification.authenticationInfo.newCounter,
      verification.authenticationInfo.credentialDeviceType,
      verification.authenticationInfo.credentialBackedUp ? 1 : 0,
      now,
      passkey.credential_id,
      passkey.account_id,
      passkey.counter,
    );
}

/** Starts a usernameless passkey assertion and persists its one-use challenge. */
export async function beginSignIn(request: Request, env: Env): Promise<SignInOptions> {
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
  return { challengeId, options };
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
): Promise<{ setCookie: string } | null> {
  const challenge = await consumeChallenge(
    env,
    "sign_in",
    challengeId,
    request,
    null,
    null,
  );
  if (!challenge) return null;

  const response = asAuthenticationResponse(payload);
  if (!response) return null;

  const passkey = await env.DB.prepare(
    `SELECT credential_id, account_id, public_key, counter, transports
     FROM passkeys WHERE credential_id = ?`,
  )
    .bind(response.id)
    .first<PasskeyRow>();
  if (!passkey || response.response?.userHandle !== accountUserHandle(passkey.account_id)) {
    return null;
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
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
  } catch {
    return null;
  }
  if (!verification.verified) return null;

  const now = Date.now();
  const counterUpdated = await updatePasskeyCounter(env, passkey, verification, now).run();
  if (counterUpdated.meta.changes !== 1) return null;

  // Intentionally outside the verifier catch: a missing cookie-signing
  // secret is a predictable deployment failure, not a bad passkey response.
  return {
    setCookie: await createNormalSession(env, passkey.account_id, passkey.credential_id),
  };
}

/** Begins a known-Account assertion that can renew a normal Session's freshness. */
export async function beginFreshAssertion(
  request: Request,
  env: Env,
  session: ActiveSession,
): Promise<FreshAssertionOptions> {
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

  const response = asAuthenticationResponse(payload);
  if (!response) return false;
  const asserted = await verifyAccountAssertion(env, session.accountId, response, challenge);
  if (!asserted || !asserted.verification.verified) return false;

  const now = Date.now();
  const counterStatement = updatePasskeyCounter(
    env,
    asserted.passkey,
    asserted.verification,
    now,
  );
  const sessionStatement = env.DB.prepare(
    `UPDATE sessions
     SET fresh_asserted_at = ?
     WHERE id = ?
       AND account_id = ?
       AND purpose = 'normal'
       AND revoked_at IS NULL
       AND idle_expires_at > ?
       AND absolute_expires_at > ?
       AND authenticated_passkey_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM passkeys
         WHERE credential_id = ?
           AND account_id = ?
           AND counter = ?
       )
       AND EXISTS (
         SELECT 1 FROM passkeys AS authenticated_passkey
         WHERE authenticated_passkey.credential_id = sessions.authenticated_passkey_id
           AND authenticated_passkey.account_id = sessions.account_id
       )
       AND changes() = 1`,
  ).bind(
    now,
    session.id,
    session.accountId,
    now,
    now,
    asserted.passkey.credential_id,
    session.accountId,
    asserted.verification.authenticationInfo.newCounter,
  );
  const [counterUpdated, sessionUpdated] = await env.DB.batch([
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
): Promise<PasskeyRegistrationOptions | null> {
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

  const response = asRegistrationResponse(payload);
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
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO passkeys (
      credential_id, account_id, public_key, counter, transports,
      device_type, backed_up, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM sessions
      WHERE id = ?
        AND account_id = ?
        AND purpose = 'normal'
        AND revoked_at IS NULL
        AND idle_expires_at > ?
        AND absolute_expires_at > ?
        AND fresh_asserted_at > ?
        AND fresh_asserted_at <= ?
        AND authenticated_passkey_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM passkeys AS authenticated_passkey
          WHERE authenticated_passkey.credential_id = sessions.authenticated_passkey_id
            AND authenticated_passkey.account_id = sessions.account_id
        )
    )
      AND NOT EXISTS (SELECT 1 FROM passkeys WHERE credential_id = ?)`,
  )
    .bind(
      credential.id,
      session.accountId,
      credential.publicKey,
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      verification.registrationInfo.credentialDeviceType,
      verification.registrationInfo.credentialBackedUp ? 1 : 0,
      now,
      now,
      session.id,
      session.accountId,
      now,
      now,
      now - FRESH_ASSERTION_MS,
      now,
      credential.id,
    )
    .run();
  return result.meta.changes === 1;
}

/** Lists opaque credential identifiers for the authenticated Account only. */
export async function listPasskeys(
  env: Env,
  accountId: string,
  currentCredentialId: string,
): Promise<PasskeySummary[]> {
  const rows = await env.DB
    .prepare(
      `SELECT credential_id, created_at FROM passkeys
       WHERE account_id = ? ORDER BY created_at ASC, credential_id ASC`,
    )
    .bind(accountId)
    .all<{ credential_id: string; created_at: number }>();
  return rows.results.map((row) => ({
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
  const deletePasskey = env.DB.prepare(
    `DELETE FROM passkeys
     WHERE credential_id = ?
       AND account_id = ?
       AND (SELECT COUNT(*) FROM passkeys WHERE account_id = ?) > 1
       AND EXISTS (
         SELECT 1 FROM sessions
         WHERE id = ?
           AND account_id = ?
           AND purpose = 'normal'
           AND revoked_at IS NULL
           AND idle_expires_at > ?
           AND absolute_expires_at > ?
           AND fresh_asserted_at > ?
           AND fresh_asserted_at <= ?
           AND authenticated_passkey_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM passkeys AS authenticated_passkey
             WHERE authenticated_passkey.credential_id = sessions.authenticated_passkey_id
               AND authenticated_passkey.account_id = sessions.account_id
           )
       )`,
  ).bind(
    credentialId,
    session.accountId,
    session.accountId,
    session.id,
    session.accountId,
    now,
    now,
    now - FRESH_ASSERTION_MS,
    now,
  );
  const revokeCredentialSessions = env.DB.prepare(
    `UPDATE sessions
     SET revoked_at = ?
     WHERE account_id = ?
       AND authenticated_passkey_id = ?
       AND revoked_at IS NULL
       AND changes() = 1
       AND NOT EXISTS (
         SELECT 1 FROM passkeys
         WHERE credential_id = ? AND account_id = ?
       )`,
  ).bind(now, session.accountId, credentialId, credentialId, session.accountId);
  const [deleted] = await env.DB.batch([deletePasskey, revokeCredentialSessions]);
  return deleted.meta.changes === 1;
}
