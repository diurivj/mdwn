import type { SQL } from "drizzle-orm";

import { sql } from "~/db/client.server";

import { FRESH_ASSERTION_MS, type ActiveSession } from "./session.server";

/** Recheck the exact live normal Session and Passkey inside a D1 mutation. */
export function freshNormalSessionGuard(session: ActiveSession, now: number): SQL {
  return sql`EXISTS (SELECT 1 FROM sessions WHERE id = ${session.id}
    AND account_id = ${session.accountId} AND purpose = 'normal'
    AND authenticated_passkey_id IS NOT NULL
    AND authenticated_passkey_id = ${session.authenticatedPasskeyId ?? null}
    AND revoked_at IS NULL AND idle_expires_at > ${now} AND absolute_expires_at > ${now}
    AND fresh_asserted_at > ${now - FRESH_ASSERTION_MS} AND fresh_asserted_at <= ${now}
    AND EXISTS (SELECT 1 FROM passkeys WHERE credential_id = sessions.authenticated_passkey_id
      AND account_id = sessions.account_id))`;
}
