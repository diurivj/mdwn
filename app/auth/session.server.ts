import { createCookie, createSessionStorage, type SessionStorage } from "react-router";

export const SESSION_COOKIE_NAME = "__Host-mdwn_session";
export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1_000;
export const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1_000;
export const FRESH_ASSERTION_MS = 5 * 60 * 1_000;

export type SessionPurpose = "normal" | "recovery";

type StoredSessionData = {
  accountId: string;
  purpose: SessionPurpose;
  authenticatedPasskeyId?: string;
  freshAssertedAt?: number;
};

export type ActiveSession = StoredSessionData & {
  id: string;
};

export type SessionSummary = {
  id: string;
  createdAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  refreshedAt: number | null;
  current: boolean;
};

type SessionRow = {
  id: string;
  account_id: string;
  purpose: SessionPurpose;
  authenticated_passkey_id: string | null;
  fresh_asserted_at: number | null;
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

function assertStoredSessionData(
  data: Partial<StoredSessionData>,
): asserts data is StoredSessionData {
  if (
    typeof data.accountId !== "string" ||
    data.accountId.length === 0 ||
    (data.purpose !== "normal" && data.purpose !== "recovery") ||
    (data.authenticatedPasskeyId !== undefined &&
      (typeof data.authenticatedPasskeyId !== "string" ||
        data.authenticatedPasskeyId.length === 0)) ||
    (data.freshAssertedAt !== undefined &&
      (!Number.isFinite(data.freshAssertedAt) || data.freshAssertedAt <= 0)) ||
    (data.purpose === "normal" && !data.authenticatedPasskeyId)
  ) {
    throw new Error("invalid server-side session data");
  }
  // Ticket 10 owns recovery-code ceremonies and their five-minute restricted
  // Session lifetime. Ticket 06 only creates normal Sessions.
  if (data.purpose === "recovery") {
    throw new Error("recovery sessions are not available yet");
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
export function createAccountSessionStorage(
  env: Env,
): SessionStorage<StoredSessionData> {
  return createSessionStorage<StoredSessionData>({
    cookie: sessionCookie(env),
    async createData(data) {
      assertStoredSessionData(data);
      const now = Date.now();
      const id = crypto.randomUUID();
      const absoluteExpiresAt = now + SESSION_ABSOLUTE_MS;
      const idleExpiresAt = Math.min(now + SESSION_IDLE_MS, absoluteExpiresAt);

      const result = await env.DB.prepare(
        `INSERT INTO sessions (
          id, account_id, purpose, authenticated_passkey_id, created_at,
          idle_expires_at, absolute_expires_at, fresh_asserted_at, refreshed_at, revoked_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL
        WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?)
          AND (
            ? IS NULL OR EXISTS (
              SELECT 1 FROM passkeys
              WHERE credential_id = ? AND account_id = ?
            )
          )`,
      )
        .bind(
          id,
          data.accountId,
          data.purpose,
          data.authenticatedPasskeyId ?? null,
          now,
          idleExpiresAt,
          absoluteExpiresAt,
          data.freshAssertedAt ?? null,
          data.accountId,
          data.authenticatedPasskeyId ?? null,
          data.authenticatedPasskeyId ?? null,
          data.accountId,
        )
        .run();

      if (result.meta.changes !== 1) {
        throw new Error("could not create a live session");
      }
      return id;
    },
    async readData(id) {
      const now = Date.now();
      const row = await env.DB.prepare(
        `SELECT id, account_id, purpose, authenticated_passkey_id, fresh_asserted_at
         FROM sessions
         WHERE id = ?
           AND revoked_at IS NULL
           AND idle_expires_at > ?
           AND absolute_expires_at > ?`,
      )
        .bind(id, now, now)
        .first<SessionRow>();

      if (!row) return null;
      return {
        accountId: row.account_id,
        purpose: row.purpose,
        ...(row.authenticated_passkey_id
          ? { authenticatedPasskeyId: row.authenticated_passkey_id }
          : {}),
        ...(row.fresh_asserted_at !== null
          ? { freshAssertedAt: row.fresh_asserted_at }
          : {}),
      };
    },
    async updateData(id, data) {
      assertStoredSessionData(data);
      const now = Date.now();
      const result = await env.DB.prepare(
        `UPDATE sessions
         SET account_id = ?, purpose = ?, authenticated_passkey_id = ?
         WHERE id = ?
           AND revoked_at IS NULL
           AND idle_expires_at > ?
           AND absolute_expires_at > ?`,
      )
        .bind(
          data.accountId,
          data.purpose,
          data.authenticatedPasskeyId ?? null,
          id,
          now,
          now,
        )
        .run();
      if (result.meta.changes !== 1) {
        throw new Error("could not update a live session");
      }
    },
    async deleteData(id) {
      await env.DB.prepare(
        "UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?",
      )
        .bind(Date.now(), id)
        .run();
    },
  });
}

/** Reads D1 only. Session use never extends the idle lifetime implicitly. */
export async function getActiveSession(
  request: Request,
  env: Env,
): Promise<ActiveSession | null> {
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
  return {
    id: session.id,
    accountId,
    purpose,
    ...(typeof authenticatedPasskeyId === "string" ? { authenticatedPasskeyId } : {}),
    ...(typeof freshAssertedAt === "number" ? { freshAssertedAt } : {}),
  };
}

export function hasFreshAssertion(
  session: ActiveSession,
  now = Date.now(),
): boolean {
  return (
    session.purpose === "normal" &&
    typeof session.freshAssertedAt === "number" &&
    session.freshAssertedAt > now - FRESH_ASSERTION_MS &&
    session.freshAssertedAt <= now
  );
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
export async function refreshNormalSession(
  env: Env,
  session: ActiveSession,
  now = Date.now(),
): Promise<boolean> {
  if (session.purpose !== "normal") return false;
  const nextIdleExpiry = now + SESSION_IDLE_MS;
  const result = await env.DB.prepare(
    `UPDATE sessions
     SET idle_expires_at = CASE
       WHEN absolute_expires_at < ? THEN absolute_expires_at
       ELSE ?
     END,
     refreshed_at = ?
     WHERE id = ?
       AND account_id = ?
       AND purpose = 'normal'
       AND revoked_at IS NULL
       AND idle_expires_at > ?
       AND absolute_expires_at > ?`,
  )
    .bind(nextIdleExpiry, nextIdleExpiry, now, session.id, session.accountId, now, now)
    .run();
  return result.meta.changes === 1;
}

export async function revokeSession(
  env: Env,
  accountId: string,
  sessionId: string,
  now = Date.now(),
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE sessions
     SET revoked_at = COALESCE(revoked_at, ?)
     WHERE id = ? AND account_id = ? AND revoked_at IS NULL`,
  )
    .bind(now, sessionId, accountId)
    .run();
  return result.meta.changes === 1;
}

/** Lists only live grants; the cookie's D1 row is marked for the UI. */
export async function listActiveSessions(
  env: Env,
  accountId: string,
  currentSessionId: string,
  now = Date.now(),
): Promise<SessionSummary[]> {
  const rows = await env.DB
    .prepare(
      `SELECT id, created_at, idle_expires_at, absolute_expires_at, refreshed_at
       FROM sessions
       WHERE account_id = ?
         AND revoked_at IS NULL
         AND idle_expires_at > ?
         AND absolute_expires_at > ?
       ORDER BY created_at DESC, id DESC`,
    )
    .bind(accountId, now, now)
    .all<SessionSummaryRow>();
  return rows.results.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    refreshedAt: row.refreshed_at,
    current: row.id === currentSessionId,
  }));
}

export async function revokeAllSessions(
  env: Env,
  accountId: string,
  now = Date.now(),
): Promise<void> {
  await env.DB.prepare(
    "UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL",
  )
    .bind(now, accountId)
    .run();
}

/** Cookie clearing never changes D1 state; revocation has an explicit caller. */
export async function clearSessionCookie(env: Env): Promise<string> {
  return sessionCookie(env).serialize("", { maxAge: 0 });
}
