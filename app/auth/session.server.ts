import { createCookie, createSessionStorage, type SessionStorage } from "react-router";

import { createDb, sql } from "~/shared/db/client.server";

import type { SessionSummary } from "./contracts";

export const SESSION_COOKIE_NAME = "__Host-mdwn_session";
export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1_000;
export const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1_000;
export const FRESH_ASSERTION_MS = 5 * 60 * 1_000;
export const RECOVERY_SESSION_MS = 5 * 60 * 1_000;

export type SessionPurpose = "normal" | "recovery";

type StoredSessionData = {
  accountId: string;
  purpose: SessionPurpose;
  authenticatedPasskeyId?: string;
  freshAssertedAt?: number;
  deviceId?: string;
};

export type ActiveSession = StoredSessionData & {
  id: string;
};

type SessionRow = {
  id: string;
  account_id: string;
  purpose: SessionPurpose;
  authenticated_passkey_id: string | null;
  fresh_asserted_at: number | null;
  device_id: string | null;
};

type SessionSummaryRow = {
  id: string;
  created_at: number;
  idle_expires_at: number;
  absolute_expires_at: number;
  refreshed_at: number | null;
};

export class SessionConfigurationError extends Error {
  constructor() {
    super("SESSION_COOKIE_SECRET is not configured");
  }
}

function sessionCookieSecret(env: Env): string {
  const secret = env.SESSION_COOKIE_SECRET;
  if (typeof secret !== "string" || secret.length < 32) {
    throw new SessionConfigurationError();
  }
  return secret;
}

/** Fails closed before an auth route creates state it could not complete. */
export function assertSessionConfiguration(env: Env): void {
  sessionCookieSecret(env);
}

function assertStoredSessionData(data: Partial<StoredSessionData>): asserts data is StoredSessionData {
  if (
    typeof data.accountId !== "string" ||
    data.accountId.length === 0 ||
    (data.purpose !== "normal" && data.purpose !== "recovery") ||
    (data.authenticatedPasskeyId !== undefined &&
      (typeof data.authenticatedPasskeyId !== "string" || data.authenticatedPasskeyId.length === 0)) ||
    (data.freshAssertedAt !== undefined && (!Number.isFinite(data.freshAssertedAt) || data.freshAssertedAt <= 0)) ||
    (data.purpose === "normal" && !data.authenticatedPasskeyId)
  ) {
    throw new Error("invalid server-side session data");
  }
  // Restricted Sessions are issued only by atomic recovery-code consumption;
  // never create or refresh them via the normal Session storage path.
  if (data.purpose === "recovery") {
    throw new Error("recovery sessions require code consumption");
  }
}

function sessionCookie(env: Env) {
  return createCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1_000),
    path: "/",
    sameSite: "lax",
    secrets: [sessionCookieSecret(env)],
    secure: true,
  });
}

/**
 * React Router's D1-backed session-storage seam. The cookie only stores the
 * signed opaque D1 key; every authorization decision re-reads the D1 row.
 */
export function createAccountSessionStorage(env: Env): SessionStorage<StoredSessionData> {
  return createSessionStorage<StoredSessionData>({
    cookie: sessionCookie(env),
    async createData(data) {
      assertStoredSessionData(data);
      const now = Date.now();
      const id = crypto.randomUUID();
      const absoluteExpiresAt = now + SESSION_ABSOLUTE_MS;
      const idleExpiresAt = Math.min(now + SESSION_IDLE_MS, absoluteExpiresAt);

      const result = await createDb(env.DB).run(sql`
        INSERT INTO sessions (
          id, account_id, purpose, authenticated_passkey_id, created_at,
          idle_expires_at, absolute_expires_at, fresh_asserted_at, refreshed_at, revoked_at
        )
        SELECT ${id}, ${data.accountId}, ${data.purpose}, ${data.authenticatedPasskeyId ?? null},
          ${now}, ${idleExpiresAt}, ${absoluteExpiresAt}, ${data.freshAssertedAt ?? null}, NULL, NULL
        WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ${data.accountId})
          AND (
            ${data.authenticatedPasskeyId ?? null} IS NULL OR EXISTS (
              SELECT 1 FROM passkeys
              WHERE credential_id = ${data.authenticatedPasskeyId ?? null}
                AND account_id = ${data.accountId}
            )
          )
      `);

      if (result.meta.changes !== 1) {
        throw new Error("could not create a live session");
      }
      return id;
    },
    async readData(id) {
      const now = Date.now();
      const row = await createDb(env.DB).get<SessionRow>(sql`
        SELECT id, account_id, purpose, authenticated_passkey_id, fresh_asserted_at, device_id
         FROM sessions
         WHERE id = ${id}
           AND revoked_at IS NULL
           AND idle_expires_at > ${now}
           AND absolute_expires_at > ${now}
           AND (purpose = 'normal' OR created_at > ${now - RECOVERY_SESSION_MS})
      `);

      if (!row) return null;
      return {
        accountId: row.account_id,
        purpose: row.purpose,
        ...(row.authenticated_passkey_id ? { authenticatedPasskeyId: row.authenticated_passkey_id } : {}),
        ...(row.fresh_asserted_at !== null ? { freshAssertedAt: row.fresh_asserted_at } : {}),
        ...(row.device_id !== null ? { deviceId: row.device_id } : {}),
      };
    },
    async updateData(id, data) {
      assertStoredSessionData(data);
      const now = Date.now();
      const result = await createDb(env.DB).run(sql`
        UPDATE sessions
         SET account_id = ${data.accountId},
             purpose = ${data.purpose},
             authenticated_passkey_id = ${data.authenticatedPasskeyId ?? null}
         WHERE id = ${id}
           AND revoked_at IS NULL
           AND idle_expires_at > ${now}
           AND absolute_expires_at > ${now}
      `);
      if (result.meta.changes !== 1) {
        throw new Error("could not update a live session");
      }
    },
    async deleteData(id) {
      await createDb(env.DB).run(sql`
        UPDATE sessions SET revoked_at = COALESCE(revoked_at, ${Date.now()}) WHERE id = ${id}
      `);
    },
  });
}

/**
 * The signed Session identifier the request's cookie carries, verified but not
 * yet looked up: callers may read rows keyed by it alongside `getActiveSession`,
 * which alone decides whether that Session is live.
 */
export async function sessionCookieId(request: Request, env: Env): Promise<string | null> {
  const id: unknown = await sessionCookie(env).parse(request.headers.get("cookie"));
  return typeof id === "string" && id ? id : null;
}

/** Reads D1 only. Session use never extends the idle lifetime implicitly. */
export async function getActiveSession(request: Request, env: Env): Promise<ActiveSession | null> {
  const storage = createAccountSessionStorage(env);
  const session = await storage.getSession(request.headers.get("cookie"));
  const accountId = session.get("accountId");
  const purpose = session.get("purpose");
  const authenticatedPasskeyId = session.get("authenticatedPasskeyId");

  if (
    !session.id ||
    typeof accountId !== "string" ||
    (purpose !== "normal" && purpose !== "recovery") ||
    (purpose === "normal" && typeof authenticatedPasskeyId !== "string")
  ) {
    return null;
  }

  const freshAssertedAt = session.get("freshAssertedAt");
  const deviceId = session.get("deviceId");
  return {
    id: session.id,
    accountId,
    purpose,
    ...(typeof authenticatedPasskeyId === "string" ? { authenticatedPasskeyId } : {}),
    ...(typeof freshAssertedAt === "number" ? { freshAssertedAt } : {}),
    ...(typeof deviceId === "string" ? { deviceId } : {}),
  };
}

/**
 * Whether this request already carries a normal Session bound to an Encryption
 * device, so signing in or up again would change nothing. An unbound Session
 * is not: a fresh Passkey assertion is how a browser's Session becomes bound.
 * Removing or replacing a device revokes the Sessions bound to it.
 */
export async function hasDeviceBoundSession(request: Request, env: Env): Promise<boolean> {
  const session = await getActiveSession(request, env);
  return session?.purpose === "normal" && typeof session.deviceId === "string";
}

export function hasFreshAssertion(session: ActiveSession, now = Date.now()): boolean {
  return (
    session.purpose === "normal" &&
    typeof session.freshAssertedAt === "number" &&
    session.freshAssertedAt > now - FRESH_ASSERTION_MS &&
    session.freshAssertedAt <= now
  );
}

export async function signSessionId(env: Env, id: string): Promise<string> {
  return sessionCookie(env).serialize(id);
}

/** Prepared alongside the rest of signup: the cookie is signed before the atomic batch. */
export function prepareBoundSession(
  env: Env,
  id: string,
  accountId: string,
  credentialId: string,
  deviceId: string,
  now: number,
) {
  assertSessionConfiguration(env);
  return sql`
    INSERT INTO sessions (
      id, account_id, purpose, authenticated_passkey_id, device_id, created_at,
      idle_expires_at, absolute_expires_at, fresh_asserted_at, refreshed_at, revoked_at
    ) SELECT ${id}, ${accountId}, 'normal', ${credentialId}, ${deviceId}, ${now},
      ${now + SESSION_IDLE_MS}, ${now + SESSION_ABSOLUTE_MS}, ${now}, NULL, NULL
    WHERE EXISTS (SELECT 1 FROM passkeys WHERE credential_id = ${credentialId} AND account_id = ${accountId})
      AND EXISTS (SELECT 1 FROM encryption_devices WHERE id = ${deviceId} AND account_id = ${accountId} AND state = 'active')
  `;
}

export async function createNormalSession(
  env: Env,
  accountId: string,
  authenticatedPasskeyId: string,
): Promise<string> {
  const storage = createAccountSessionStorage(env);
  const session = await storage.getSession();
  const now = Date.now();
  session.set("accountId", accountId);
  session.set("purpose", "normal");
  session.set("authenticatedPasskeyId", authenticatedPasskeyId);
  // A completed sign-in assertion is recent enough for follow-on
  // account-security actions until the explicit five-minute window closes.
  session.set("freshAssertedAt", now);
  return storage.commitSession(session);
}

/** Explicit refresh is the only operation that extends the idle deadline. */
export async function refreshNormalSession(env: Env, session: ActiveSession, now = Date.now()): Promise<boolean> {
  if (session.purpose !== "normal") return false;
  const nextIdleExpiry = now + SESSION_IDLE_MS;
  const result = await createDb(env.DB).run(sql`
    UPDATE sessions
     SET idle_expires_at = CASE
       WHEN absolute_expires_at < ${nextIdleExpiry} THEN absolute_expires_at
       ELSE ${nextIdleExpiry}
     END,
     refreshed_at = ${now}
     WHERE id = ${session.id}
       AND account_id = ${session.accountId}
       AND purpose = 'normal'
       AND revoked_at IS NULL
       AND idle_expires_at > ${now}
       AND absolute_expires_at > ${now}
  `);
  return result.meta.changes === 1;
}

/** Idempotent self-sign-out only; account-security revocations use actor guards below. */
export async function revokeSession(
  env: Env,
  accountId: string,
  sessionId: string,
  now = Date.now(),
): Promise<boolean> {
  const result = await createDb(env.DB).run(sql`
    UPDATE sessions
     SET revoked_at = COALESCE(revoked_at, ${now})
     WHERE id = ${sessionId} AND account_id = ${accountId} AND revoked_at IS NULL
  `);
  return result.meta.changes === 1;
}

/**
 * Atomically rechecks the actor's live normal Session before revoking one
 * peer. The materialized predicate is evaluated before this UPDATE changes an
 * actor row, so the check cannot be invalidated partway through a mutation.
 */
export async function revokeSessionForActor(
  env: Env,
  actor: ActiveSession,
  sessionId: string,
  now = Date.now(),
): Promise<"revoked" | "already_revoked" | "actor_inactive" | "target_not_found"> {
  if (actor.purpose !== "normal") return "actor_inactive";
  const db = createDb(env.DB);
  const result = await db.run(sql`
    WITH authorized AS MATERIALIZED (
      SELECT 1
      FROM sessions
      WHERE id = ${actor.id}
        AND account_id = ${actor.accountId}
        AND purpose = 'normal'
        AND authenticated_passkey_id IS NOT NULL
        AND revoked_at IS NULL
        AND idle_expires_at > ${now}
        AND absolute_expires_at > ${now}
    )
    UPDATE sessions
    SET revoked_at = COALESCE(revoked_at, ${now})
    WHERE id = ${sessionId}
      AND account_id = ${actor.accountId}
      AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM authorized)
  `);
  if (result.meta.changes === 1) return "revoked";

  // A failed conditional update can mean either the actor lost authority or a
  // peer was revoked concurrently. Only the former invalidates this cookie.
  const checkedAt = Date.now();
  const actorStillLive = await db.get<{ id: string }>(sql`
    SELECT id FROM sessions
    WHERE id = ${actor.id}
      AND account_id = ${actor.accountId}
      AND purpose = 'normal'
      AND authenticated_passkey_id IS NOT NULL
      AND revoked_at IS NULL
      AND idle_expires_at > ${checkedAt}
      AND absolute_expires_at > ${checkedAt}
  `);
  if (!actorStillLive) return "actor_inactive";

  const target = await db.get<{ revoked_at: number | null }>(sql`
    SELECT revoked_at FROM sessions
    WHERE id = ${sessionId} AND account_id = ${actor.accountId}
  `);
  return target?.revoked_at != null ? "already_revoked" : "target_not_found";
}

/** Lists only live grants; the cookie's D1 row is marked for the UI. */
export async function listActiveSessions(
  env: Env,
  accountId: string,
  currentSessionId: string,
  now = Date.now(),
): Promise<SessionSummary[]> {
  const rows = await createDb(env.DB).all<SessionSummaryRow>(sql`
      SELECT id, created_at, idle_expires_at, absolute_expires_at, refreshed_at
       FROM sessions
       WHERE account_id = ${accountId}
         AND revoked_at IS NULL
         AND idle_expires_at > ${now}
         AND absolute_expires_at > ${now}
       ORDER BY created_at DESC, id DESC
  `);
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    refreshedAt: row.refreshed_at,
    current: row.id === currentSessionId,
  }));
}

export async function revokeAllSessionsForActor(env: Env, actor: ActiveSession, now = Date.now()): Promise<boolean> {
  if (actor.purpose !== "normal") return false;
  const result = await createDb(env.DB).run(sql`
    WITH authorized AS MATERIALIZED (
      SELECT 1
      FROM sessions
      WHERE id = ${actor.id}
        AND account_id = ${actor.accountId}
        AND purpose = 'normal'
        AND authenticated_passkey_id IS NOT NULL
        AND revoked_at IS NULL
        AND idle_expires_at > ${now}
        AND absolute_expires_at > ${now}
    )
    UPDATE sessions
    SET revoked_at = ${now}
    WHERE account_id = ${actor.accountId}
      AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM authorized)
  `);
  return result.meta.changes > 0;
}

/** Cookie clearing never changes D1 state; revocation has an explicit caller. */
export async function clearSessionCookie(env: Env): Promise<string> {
  return sessionCookie(env).serialize("", { maxAge: 0 });
}
