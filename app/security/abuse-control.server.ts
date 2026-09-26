import { and, isNotNull, lte, sql } from "drizzle-orm";
import {
  createDb,
  rateLimitCounters,
  securityEvents,
} from "../db/client.server";
import {
  RATE_LIMIT_POLICIES,
  type RateLimitAction,
  type RateLimitRule,
} from "./abuse-policy";
import {
  deriveNetworkBucket,
  deriveOpaqueScopeBucket,
  normalizeEdgeIp,
} from "./network-bucket";
import type {
  NewSecurityEvent,
  SecurityCounterState,
  SecurityEventActionClass,
  SecurityEventReason,
  SecurityProofState,
  SecuritySizeClass,
} from "./security-events";

export type {
  NewSecurityEvent,
  SecurityEventActionClass,
  SecurityCounterState,
  SecurityEventOutcome,
  SecurityEventReason,
  SecurityProofState,
  SecuritySizeClass,
} from "./security-events";

const DAY_MS = 24 * 60 * 60 * 1000;
const ABUSE_PURGE_INTERVAL_MS = 15 * 60 * 1000;
// Leave one cron period for cleanup to run before the policy retention maxima.
export const MAX_EVENT_RETENTION_MS = 30 * DAY_MS - ABUSE_PURGE_INTERVAL_MS;
const MAX_EVENT_NETWORK_BUCKET_MS = DAY_MS - ABUSE_PURGE_INTERVAL_MS;

const SECURITY_ACTIONS = new Set<SecurityEventActionClass>([
  "registration_challenge",
  "registration",
  "sign_in",
  "recovery",
  "session_refresh",
  "public_comment",
  "public_comment_report",
  "publication",
]);
const SECURITY_REASONS = new Set<SecurityEventReason>([
  "allowed",
  "rate_limited",
  "honeypot-filled",
  "proof_invalid",
  "proof_spent",
  "policy_denied",
  "capacity_exhausted",
]);
const SECURITY_SIZE_CLASSES = new Set<SecuritySizeClass>([
  "unknown",
  "zero",
  "under_1_kib",
  "1_to_4_kib",
  "4_to_16_kib",
  "over_16_kib",
]);
const SECURITY_PROOF_STATES = new Set<SecurityProofState>([
  "not_applicable",
  "issued",
  "valid",
  "invalid",
  "spent",
]);
const SECURITY_COUNTER_STATES = new Set<SecurityCounterState>([
  "not_checked",
  "allowed",
  "denied",
]);

export interface RateLimitScopes {
  readonly accountId?: string;
  readonly publicationId?: string;
  readonly sessionId?: string;
  readonly recoveryIdentifier?: string;
}

export interface EnforceRateLimitOptions {
  readonly db: D1Database;
  readonly request: Request;
  readonly action: RateLimitAction;
  readonly scopes?: RateLimitScopes;
  /** Cloudflare Secret; rotate through the reviewed deploy workflow. */
  readonly hmacSecret?: string;
  /** Injectable server time for deterministic tests. */
  readonly now?: number;
}

export type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export class AbuseControlUnavailableError extends Error {
  constructor() {
    super("abuse controls unavailable");
    this.name = "AbuseControlUnavailableError";
  }
}

interface CounterResult {
  readonly allowed: boolean;
  readonly retryAfterSeconds?: number;
}

function counterPurpose(action: RateLimitAction): string {
  return action;
}

function currentAndPreviousDailyHmacEpochs(now: number): number[] {
  const current = Math.floor(now / DAY_MS);
  return current > 0 ? [current, current - 1] : [current];
}

async function currentAndPreviousDailyBuckets(
  now: number,
  deriveAtEpoch: (epoch: number) => Promise<string>,
): Promise<string[]> {
  const bucketIds = await Promise.all(
    currentAndPreviousDailyHmacEpochs(now).map(deriveAtEpoch),
  );
  return [...new Set(bucketIds)];
}

async function resolveScopeIds(
  rule: RateLimitRule,
  action: RateLimitAction,
  request: Request,
  scopes: RateLimitScopes,
  secret: string | undefined,
  now: number,
): Promise<string[] | null> {
  const getRequired = (value: string | undefined): string => {
    if (!value || value.length > 256) throw new AbuseControlUnavailableError();
    return value;
  };
  const getAccountId = (value: string | undefined): string => {
    const id = getRequired(value);
    if (!isUuidV7(id)) throw new AbuseControlUnavailableError();
    return id;
  };
  const getPublicationId = (value: string | undefined): string => {
    const id = getRequired(value);
    if (!isOpaquePublicationId(id)) throw new AbuseControlUnavailableError();
    return id;
  };

  switch (rule.scope) {
    case "global":
      return ["*"];
    case "account": {
      if (!scopes.accountId && rule.optional) return null;
      return [getAccountId(scopes.accountId)];
    }
    case "publication":
      return [getPublicationId(scopes.publicationId)];
    case "account_publication": {
      const accountId = getAccountId(scopes.accountId);
      const publicationId = getPublicationId(scopes.publicationId);
      if (!secret) throw new AbuseControlUnavailableError();
      const purpose = `${action}:${rule.windowMs}`;
      return currentAndPreviousDailyBuckets(now, (epoch) =>
        deriveOpaqueScopeBucket(
          "account_publication",
          `${accountId}\u0000${publicationId}`,
          purpose,
          epoch,
          secret,
        ),
      );
    }
    case "session": {
      if (!secret) throw new AbuseControlUnavailableError();
      const value = getRequired(scopes.sessionId);
      const purpose = `${action}:${rule.windowMs}`;
      return currentAndPreviousDailyBuckets(now, (epoch) =>
        deriveOpaqueScopeBucket("session", value, purpose, epoch, secret),
      );
    }
    case "recovery_identifier": {
      if (!secret) throw new AbuseControlUnavailableError();
      const value = getRequired(scopes.recoveryIdentifier);
      const purpose = `${action}:${rule.windowMs}`;
      return currentAndPreviousDailyBuckets(now, (epoch) =>
        deriveOpaqueScopeBucket("recovery_identifier", value, purpose, epoch, secret),
      );
    }
    case "network": {
      if (!secret) throw new AbuseControlUnavailableError();
      const edgeAddress = request.headers.get("CF-Connecting-IP");
      if (!edgeAddress) throw new AbuseControlUnavailableError();
      let normalizedAddress: string;
      try {
        normalizedAddress = normalizeEdgeIp(edgeAddress);
      } catch {
        throw new AbuseControlUnavailableError();
      }
      const purpose = `${action}:${rule.windowMs}`;
      return currentAndPreviousDailyBuckets(now, (epoch) =>
        deriveNetworkBucket(normalizedAddress, purpose, epoch, secret),
      );
    }
  }
}

async function incrementRollingCounter(
  db: ReturnType<typeof createDb>,
  action: RateLimitAction,
  rule: RateLimitRule,
  scopeIds: readonly string[],
  now: number,
): Promise<CounterResult> {
  if (scopeIds.length === 0) throw new AbuseControlUnavailableError();

  const purpose = counterPurpose(action);
  const scopeId = scopeIds[0];
  const activePredicate = sql`
    purpose = ${purpose}
    AND scope_type = ${rule.scope}
    AND scope_id IN (${sql.join(scopeIds.map((id) => sql`${id}`), sql`, `)})
    AND window_ms = ${rule.windowMs}
    AND time_epoch > ${now - rule.windowMs}
    AND expires_at > ${now}
  `;

  // This one SQL statement sums the exact rolling interval and conditionally
  // increments the current millisecond bucket. SQLite serializes the write, so
  // concurrent requests cannot pass a stale SELECT-then-UPDATE check.
  const result = await db.all<{ count: number }>(sql`
    INSERT INTO rate_limit_counters
      (purpose, scope_type, scope_id, window_ms, time_epoch, count, expires_at)
    SELECT ${purpose}, ${rule.scope}, ${scopeId}, ${rule.windowMs}, ${now}, 1, ${now + rule.windowMs}
    WHERE COALESCE((SELECT SUM(count) FROM rate_limit_counters WHERE ${activePredicate}), 0) < ${rule.limit}
    ON CONFLICT (purpose, scope_type, scope_id, window_ms, time_epoch)
    DO UPDATE SET count = rate_limit_counters.count + 1
    RETURNING count
  `);
  if (result.length > 0) return { allowed: true };

  const retry = await db.get<{ retry_at: number | null }>(sql`
    SELECT MIN(expires_at) AS retry_at FROM rate_limit_counters WHERE ${activePredicate}
  `);
  const retryAt = retry?.retry_at;
  return {
    allowed: false,
    retryAfterSeconds: typeof retryAt === "number"
      ? Math.max(1, Math.ceil((retryAt - now) / 1000))
      : 1,
  };
}

/**
 * Consume the exact rolling-window counters for one protected operation.
 * Global counters are reserved first; an exhausted global limit returns before
 * CF-Connecting-IP is parsed or a Network bucket is derived. A request that
 * passes global but fails a later scope still counts against its global cap.
 */
export async function enforceRateLimit({
  db,
  request,
  action,
  scopes = {},
  hmacSecret,
  now = Date.now(),
}: EnforceRateLimitOptions): Promise<RateLimitDecision> {
  try {
    if (!Number.isSafeInteger(now) || now < 0) throw new AbuseControlUnavailableError();
    const rules = RATE_LIMIT_POLICIES[action];
    if (!rules) throw new AbuseControlUnavailableError();
    const database = createDb(db);

    const globalRules = rules.filter((rule) => rule.scope === "global");
    const otherRules = rules.filter((rule) => rule.scope !== "global");
    for (const rule of globalRules) {
      const result = await incrementRollingCounter(database, action, rule, ["*"], now);
      if (!result.allowed) {
        return { allowed: false, retryAfterSeconds: result.retryAfterSeconds ?? 1 };
      }
    }

    const denials: number[] = [];
    for (const rule of otherRules) {
      const scopeIds = await resolveScopeIds(
        rule,
        action,
        request,
        scopes,
        hmacSecret,
        now,
      );
      if (scopeIds === null) continue;
      const result = await incrementRollingCounter(database, action, rule, scopeIds, now);
      if (!result.allowed) denials.push(result.retryAfterSeconds ?? 1);
    }

    return denials.length > 0
      ? { allowed: false, retryAfterSeconds: Math.max(...denials) }
      : { allowed: true };
  } catch (error) {
    if (error instanceof AbuseControlUnavailableError) throw error;
    throw new AbuseControlUnavailableError();
  }
}

/** Generic fail-closed response when D1 or the abuse-control key is unavailable. */
export function abuseControlUnavailableResponse(): Response {
  return Response.json(
    { error: "temporarily_unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

/** Identical public response for every rate-limited scope and operation. */
export function rateLimitResponse(decision: Extract<RateLimitDecision, { allowed: false }>): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterSeconds));
  return Response.json(
    { error: "rate_limited" },
    {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(retryAfterSeconds),
      },
    },
  );
}

function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function isOpaquePublicationId(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validSecurityEvent(event: NewSecurityEvent): boolean {
  if (!SECURITY_ACTIONS.has(event.actionClass) || !SECURITY_REASONS.has(event.reason)) return false;
  if (event.reason === "honeypot-filled" && !["registration", "public_comment"].includes(event.actionClass)) {
    return false;
  }
  if (event.reason === "allowed" && event.outcome !== "allow") return false;
  if (event.reason !== "allowed" && event.outcome !== "deny") return false;
  if (!SECURITY_PROOF_STATES.has(event.proofState) || !SECURITY_COUNTER_STATES.has(event.counterState)) return false;
  if (event.sizeClass !== undefined && !SECURITY_SIZE_CLASSES.has(event.sizeClass)) return false;
  if (event.accountId !== undefined && !isUuidV7(event.accountId)) return false;
  if (event.publicationId !== undefined && !isOpaquePublicationId(event.publicationId)) return false;
  if (event.retryAt !== undefined && (!Number.isSafeInteger(event.retryAt) || event.retryAt < 0)) return false;
  if (event.networkBucket !== undefined && !/^network:[a-f0-9]{64}$/.test(event.networkBucket)) return false;
  return true;
}

/** Persist only the explicitly allowlisted Security event metadata. */
export async function recordSecurityEvent(
  db: D1Database,
  event: NewSecurityEvent,
  now = Date.now(),
): Promise<string> {
  if (!Number.isSafeInteger(now) || now < 0 || !validSecurityEvent(event)) {
    throw new Error("invalid security event");
  }

  const eventId = crypto.randomUUID();
  const expiresAt = now + MAX_EVENT_RETENTION_MS;
  const networkBucketExpiresAt = event.networkBucket === undefined
    ? null
    : now + MAX_EVENT_NETWORK_BUCKET_MS;
  await createDb(db).run(sql`
    INSERT INTO security_events
      (id, created_at, expires_at, action_class, outcome, reason, account_id, publication_id,
       size_class, proof_state, counter_state, retry_at, network_bucket, network_bucket_expires_at)
    VALUES (
      ${eventId}, ${now}, ${expiresAt}, ${event.actionClass}, ${event.outcome}, ${event.reason},
      ${event.accountId ?? null}, ${event.publicationId ?? null}, ${event.sizeClass ?? null},
      ${event.proofState}, ${event.counterState}, ${event.retryAt ?? null},
      ${event.networkBucket ?? null}, ${networkBucketExpiresAt}
    )
  `);
  return eventId;
}

export interface AbusePurgeResult {
  readonly countersDeleted: number;
  readonly eventsDeleted: number;
  readonly networkBucketsCleared: number;
}

/** Delete expired abuse rows and scrub expired Network digests on live events. */
export async function purgeExpiredAbuseRecords(
  db: D1Database,
  now = Date.now(),
): Promise<AbusePurgeResult> {
  if (!Number.isSafeInteger(now) || now < 0) throw new AbuseControlUnavailableError();
  const database = createDb(db);
  const [buckets, counters, events] = await database.batch([
    database
      .update(securityEvents)
      .set({ networkBucket: null, networkBucketExpiresAt: null })
      .where(
        and(
          isNotNull(securityEvents.networkBucket),
          lte(securityEvents.networkBucketExpiresAt, now),
        ),
      ),
    database
      .delete(rateLimitCounters)
      .where(lte(rateLimitCounters.expiresAt, now)),
    database
      .delete(securityEvents)
      .where(lte(securityEvents.expiresAt, now)),
  ]);
  return {
    countersDeleted: counters.meta.changes,
    eventsDeleted: events.meta.changes,
    networkBucketsCleared: buckets.meta.changes,
  };
}
