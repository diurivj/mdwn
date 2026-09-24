import type { SQL } from "drizzle-orm";
import { createDb, sql } from "../db/client.server";

import { AbuseControlUnavailableError, type RateLimitDecision } from "./abuse-control.server";
import { deriveNetworkBucket, normalizeEdgeIp } from "./network-bucket";

const DAY = 86_400_000;
const PURPOSE = "registration.success";
const GLOBAL_LIMIT = 100;
const NETWORK_LIMIT = 2;

type Scope = { type: "global" | "network"; ids: string[]; limit: number };
type CounterStatement = SQL;

async function countScope(db: D1Database, scope: Scope, now: number): Promise<{ n: number; next: number | null }> {
  const ids = sql.join(scope.ids.map((id) => sql`${id}`), sql`, `);
  const row = await createDb(db).get<{ n: number; next: number | null }>(sql`
    SELECT COALESCE(SUM(count), 0) AS n, MIN(expires_at) AS next
    FROM rate_limit_counters WHERE purpose = ${PURPOSE} AND scope_type = ${scope.type}
      AND scope_id IN (${ids}) AND window_ms = ${DAY}
      AND time_epoch > ${now - DAY} AND expires_at > ${now}
  `);
  if (!row) throw new AbuseControlUnavailableError();
  return row;
}

function denied(next: number | null, now: number): RateLimitDecision {
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(((next ?? now + 1000) - now) / 1000)) };
}

/**
 * Reserve *successful* registration counters inside the Account-create batch,
 * never before it. A failed/denied insert rolls the whole batch back. Global
 * reservation comes first, before deriving or writing the Network bucket.
 */
export async function prepareRegistrationSuccess(
  db: D1Database, request: Request, secret: string | undefined, now: number,
): Promise<{
  statements?: [CounterStatement, CounterStatement];
  decision: () => Promise<RateLimitDecision>;
  initialDecision: RateLimitDecision;
}> {
  try {
    const global: Scope = { type: "global", ids: ["*"], limit: GLOBAL_LIMIT };
    const globalCount = await countScope(db, global, now);
    if (globalCount.n >= GLOBAL_LIMIT) {
      return {
        decision: async () => denied((await countScope(db, global, now)).next, now),
        initialDecision: denied(globalCount.next, now),
      };
    }
    const edgeIp = request.headers.get("CF-Connecting-IP");
    if (!edgeIp || !secret) throw new AbuseControlUnavailableError();
    const normalized = normalizeEdgeIp(edgeIp);
    const epoch = Math.floor(now / DAY);
    const purpose = `${PURPOSE}:${DAY}`;
    const current = await deriveNetworkBucket(normalized, purpose, epoch, secret);
    const previous = epoch > 0 ? await deriveNetworkBucket(normalized, purpose, epoch - 1, secret) : current;
    const network: Scope = { type: "network", ids: [...new Set([current, previous])], limit: NETWORK_LIMIT };
    const evaluate = async (): Promise<RateLimitDecision> => {
      const globalResult = await countScope(db, global, now);
      if (globalResult.n >= GLOBAL_LIMIT) return denied(globalResult.next, now);
      const networkResult = await countScope(db, network, now);
      return networkResult.n >= NETWORK_LIMIT ? denied(networkResult.next, now) : { allowed: true };
    };
    const initialDecision = await evaluate();
    if (!initialDecision.allowed) return { decision: evaluate, initialDecision };
    const statementFor = (scope: Scope, previousRequired: boolean): CounterStatement => {
      const ids = sql.join(scope.ids.map((id) => sql`${id}`), sql`, `);
      return sql`
        INSERT INTO rate_limit_counters
          (purpose, scope_type, scope_id, window_ms, time_epoch, count, expires_at)
        SELECT ${PURPOSE}, ${scope.type}, ${scope.ids[0]!}, ${DAY}, ${now}, 1, ${now + DAY}
        WHERE ${previousRequired ? sql`changes() = 1 AND` : sql``}
          COALESCE((SELECT SUM(count) FROM rate_limit_counters
            WHERE purpose = ${PURPOSE} AND scope_type = ${scope.type} AND scope_id IN (${ids})
              AND window_ms = ${DAY} AND time_epoch > ${now - DAY} AND expires_at > ${now}), 0) < ${scope.limit}
        ON CONFLICT(purpose, scope_type, scope_id, window_ms, time_epoch)
          DO UPDATE SET count = rate_limit_counters.count + 1
      `;
    };
    return {
      statements: [statementFor(global, false), statementFor(network, true)],
      decision: evaluate,
      initialDecision,
    };
  } catch {
    throw new AbuseControlUnavailableError();
  }
}
