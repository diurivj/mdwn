import {
  applyD1Migrations,
  createScheduledController,
  env,
  type D1Migration,
} from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
  enforceRateLimit,
  purgeExpiredAbuseRecords,
  recordSecurityEvent,
} from "../../app/shared/security/abuse-control.server";
import worker from "../../workers/app";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const makeRequest = (ip = "192.0.2.1") => new Request("https://mdwn.test/protected", {
  headers: { "CF-Connecting-IP": ip },
});

const BASE_TIME = 1_700_000_000_000;
const HMAC_SECRET = "worker-test-abuse-hmac-key-not-for-deployment";

describe("D1 abuse-control counters", () => {
  it("rejects raw Session tokens in counter rows at the D1 boundary", async () => {
    await expect(env.DB.prepare(
      `INSERT INTO rate_limit_counters (purpose, scope_type, scope_id, window_ms, time_epoch, count, expires_at)
       VALUES ('session.refresh', 'session', ?, 3600000, ?, 1, ?)`,
    ).bind("raw-session-token", BASE_TIME, BASE_TIME + 3_600_000).run()).rejects.toThrow();
  });

  it("enforces a true rolling boundary and stores no raw Session identifier", async () => {
    const sessionId = "opaque-session-cookie-value-never-persist-this";
    const checkAt = (now: number) => enforceRateLimit({
      db: env.DB,
      request: makeRequest(),
      action: "session.refresh",
      scopes: { sessionId },
      hmacSecret: HMAC_SECRET,
      now,
    });

    for (let attempt = 0; attempt < 12; attempt++) {
      await expect(checkAt(BASE_TIME)).resolves.toEqual({ allowed: true });
    }
    await expect(checkAt(BASE_TIME)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 3_600,
    });
    await expect(checkAt(BASE_TIME + 3_600_000 - 1)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    await expect(checkAt(BASE_TIME + 3_600_000)).resolves.toEqual({ allowed: true });

    const stored = await env.DB.prepare(
      "SELECT scope_id, time_epoch, count, expires_at FROM rate_limit_counters WHERE purpose = 'session.refresh'",
    ).all<{ scope_id: string; time_epoch: number; count: number; expires_at: number }>();
    expect(stored.results).toHaveLength(2);
    expect(stored.results.every((row) => row.scope_id !== sessionId)).toBe(true);
    expect(stored.results.find((row) => row.time_epoch === BASE_TIME)).toMatchObject({
      count: 12,
      expires_at: BASE_TIME + 3_600_000,
    });
  });

  it("enforces the Network 15-minute limit through one millisecond before expiry", async () => {
    const now = BASE_TIME + 600_000;
    const request = makeRequest("203.0.113.77");
    const checkAt = (time: number) => enforceRateLimit({
      db: env.DB,
      request,
      action: "registration.challenge",
      hmacSecret: HMAC_SECRET,
      now: time,
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(checkAt(now)).resolves.toEqual({ allowed: true });
    }
    await expect(checkAt(now)).resolves.toMatchObject({
      allowed: false,
      retryAfterSeconds: 900,
    });
    await expect(checkAt(now + 15 * 60_000 - 1)).resolves.toMatchObject({
      allowed: false,
      retryAfterSeconds: 1,
    });
    await expect(checkAt(now + 15 * 60_000)).resolves.toEqual({ allowed: true });
  });

  it("keeps a 24-hour Network limit across HMAC epoch rollover until its exact expiry", async () => {
    const dayMs = 86_400_000;
    const beforeEpochChange = 200_000 * dayMs - 1;
    const afterEpochChange = beforeEpochChange + 1;
    const beforeExpiry = beforeEpochChange + dayMs - 1;
    const exactExpiry = beforeEpochChange + dayMs;
    const request = makeRequest("203.0.113.9");
    const checkAt = (now: number) => enforceRateLimit({
      db: env.DB,
      request,
      action: "registration.success",
      hmacSecret: HMAC_SECRET,
      now,
    });

    await expect(checkAt(beforeEpochChange)).resolves.toEqual({ allowed: true });
    await expect(checkAt(beforeEpochChange)).resolves.toEqual({ allowed: true });
    await expect(checkAt(beforeEpochChange)).resolves.toMatchObject({
      allowed: false,
      retryAfterSeconds: 86_400,
    });
    await expect(checkAt(beforeExpiry)).resolves.toMatchObject({
      allowed: false,
      retryAfterSeconds: 1,
    });
    await expect(checkAt(exactExpiry)).resolves.toEqual({ allowed: true });
  });

  it("allows a global minute cap again at its exact rolling-window boundary", async () => {
    const now = BASE_TIME + 250_000;
    const checkAt = (attempt: number, time: number) => enforceRateLimit({
      db: env.DB,
      request: makeRequest(`198.51.100.${attempt + 1}`),
      action: "public_comment.mutate",
      scopes: {
        accountId: `00000000-0000-7000-8000-${attempt.toString(16).padStart(12, "0")}`,
        publicationId: `${"P".repeat(41)}${attempt.toString(36).padStart(2, "0")}`,
      },
      hmacSecret: HMAC_SECRET,
      now: time,
    });

    for (let attempt = 0; attempt < 30; attempt++) {
      await expect(checkAt(attempt, now)).resolves.toEqual({ allowed: true });
    }
    await expect(checkAt(30, now)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    await expect(checkAt(31, now + 60_000)).resolves.toEqual({ allowed: true });
  });

  it("allows a registration global cap again at its exact ten-minute boundary", async () => {
    const now = BASE_TIME + 12_000_000;
    const checkAt = (attempt: number, time: number) => enforceRateLimit({
      db: env.DB,
      request: makeRequest(`198.51.100.${attempt + 1}`),
      action: "registration.challenge",
      hmacSecret: HMAC_SECRET,
      now: time,
    });

    for (let attempt = 0; attempt < 30; attempt++) {
      await expect(checkAt(attempt, now)).resolves.toEqual({ allowed: true });
    }
    await expect(checkAt(30, now)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 600,
    });
    await expect(checkAt(31, now + 10 * 60_000)).resolves.toEqual({ allowed: true });
  });

  it("applies Account, Publication, Account+Publication, Network, and global scopes independently", async () => {
    const now = BASE_TIME + 400_000;
    const request = makeRequest("198.51.100.20");
    const scopes = {
      accountId: "018f22c9-7b31-7abc-8def-0123456789ab",
      publicationId: "P".repeat(43),
    };
    const check = (accountId: string, publicationId: string) => enforceRateLimit({
      db: env.DB,
      request,
      action: "public_comment.mutate",
      scopes: { accountId, publicationId },
      hmacSecret: HMAC_SECRET,
      now,
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(check(scopes.accountId, scopes.publicationId)).resolves.toEqual({ allowed: true });
    }
    await expect(check(scopes.accountId, scopes.publicationId)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 600,
    });
    await expect(check(scopes.accountId, "Q".repeat(43))).resolves.toEqual({ allowed: true });
    await expect(check("018f22c9-7b31-7abc-8def-0123456789ac", scopes.publicationId)).resolves.toEqual({ allowed: true });

    const combined = await env.DB.prepare(
      "SELECT SUM(count) AS amount FROM rate_limit_counters WHERE purpose = 'public_comment.mutate' AND scope_type = 'account_publication' AND time_epoch = ?",
    ).bind(now).first<{ amount: number }>();
    // The denied 10-minute rule does not increment, but the independent 24-hour rule still counts the attempt.
    expect(combined?.amount).toBe(11);
  });

  it("keeps concurrent Session refresh attempts within the per-Session cap", async () => {
    const now = BASE_TIME + 150_000;
    const attempts = await Promise.all(Array.from({ length: 20 }, () => enforceRateLimit({
      db: env.DB,
      request: makeRequest(),
      action: "session.refresh",
      scopes: { sessionId: "concurrent-session-identifier" },
      hmacSecret: HMAC_SECRET,
      now,
    })));

    expect(attempts.filter((result) => result.allowed)).toHaveLength(12);
    expect(attempts.filter((result) => !result.allowed)).toHaveLength(8);
  });

  it("persists only allowlisted Security event fields and accepts the honeypot reason code", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(security_events)").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual([
      "id",
      "created_at",
      "expires_at",
      "action_class",
      "outcome",
      "reason",
      "account_id",
      "publication_id",
      "size_class",
      "proof_state",
      "counter_state",
      "retry_at",
      "network_bucket",
      "network_bucket_expires_at",
    ]);

    const eventId = await recordSecurityEvent(env.DB, {
      actionClass: "registration",
      outcome: "deny",
      reason: "honeypot-filled",
      sizeClass: "unknown",
      proofState: "not_applicable",
      counterState: "not_checked",
      networkBucket: `network:${"a".repeat(64)}`,
    }, BASE_TIME + 200_000);
    const event = await env.DB.prepare(
      "SELECT id, created_at, expires_at, action_class, outcome, reason, size_class, proof_state, counter_state, network_bucket, network_bucket_expires_at FROM security_events WHERE id = ?",
    ).bind(eventId).first<Record<string, unknown>>();

    expect(event).toMatchObject({
      id: eventId,
      created_at: BASE_TIME + 200_000,
      expires_at: BASE_TIME + 200_000 + 30 * 24 * 60 * 60 * 1000 - 15 * 60 * 1000,
      action_class: "registration",
      outcome: "deny",
      reason: "honeypot-filled",
      size_class: "unknown",
      proof_state: "not_applicable",
      counter_state: "not_checked",
      network_bucket: `network:${"a".repeat(64)}`,
      network_bucket_expires_at: BASE_TIME + 200_000 + 24 * 60 * 60 * 1000 - 15 * 60 * 1000,
    });
    await expect(recordSecurityEvent(env.DB, {
      actionClass: "registration",
      outcome: "deny",
      reason: "raw-submission-value" as "honeypot-filled",
      proofState: "not_applicable",
      counterState: "not_checked",
    }, BASE_TIME + 200_001)).rejects.toThrow("invalid security event");
    await expect(recordSecurityEvent(env.DB, {
      actionClass: "registration",
      outcome: "deny",
      reason: "policy_denied",
      sizeClass: "unbounded submission text" as "unknown",
      proofState: "not_applicable",
      counterState: "not_checked",
    }, BASE_TIME + 200_002)).rejects.toThrow("invalid security event");
  });

  it("purges only expired counter/event rows and clears expired event Network buckets", async () => {
    const now = BASE_TIME + 120_000;
    const hourMs = 3_600_000;
    const dayMs = 86_400_000;
    const expiredCounterId = `session:${"a".repeat(64)}`;
    const liveCounterId = `session:${"b".repeat(64)}`;
    const expiredEventId = "expired-event";
    const liveEventId = "live-event";
    const networkEventId = "network-event";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO rate_limit_counters (purpose, scope_type, scope_id, window_ms, time_epoch, count, expires_at)
         VALUES ('session.refresh', 'session', ?, ?, ?, 1, ?)`,
      ).bind(expiredCounterId, hourMs, now - hourMs, now),
      env.DB.prepare(
        `INSERT INTO rate_limit_counters (purpose, scope_type, scope_id, window_ms, time_epoch, count, expires_at)
         VALUES ('session.refresh', 'session', ?, ?, ?, 1, ?)`,
      ).bind(liveCounterId, hourMs, now - hourMs + 1, now + 1),
      ...[
        [expiredEventId, now - 30 * dayMs, now],
        [liveEventId, now - 30 * dayMs + 1, now + 1],
        [networkEventId, now - dayMs, now + 1],
      ].map(([id, createdAt, expiresAt]) => env.DB.prepare(
        `INSERT INTO security_events
          (id, created_at, expires_at, action_class, outcome, reason, proof_state, counter_state,
           network_bucket, network_bucket_expires_at)
         VALUES (?, ?, ?, 'registration', 'deny', 'policy_denied', 'not_applicable', 'denied', ?, ?)`
      ).bind(
        id,
        createdAt,
        expiresAt,
        id === networkEventId ? `network:${"a".repeat(64)}` : null,
        id === networkEventId ? now : null,
      )),
    ]);

    await expect(purgeExpiredAbuseRecords(env.DB, now)).resolves.toEqual({
      countersDeleted: 1,
      eventsDeleted: 1,
      networkBucketsCleared: 1,
    });
    await expect(env.DB.prepare(
      "SELECT scope_id FROM rate_limit_counters WHERE scope_id IN (?, ?) ORDER BY scope_id",
    ).bind(expiredCounterId, liveCounterId).all<{ scope_id: string }>()).resolves.toMatchObject({
      results: [{ scope_id: liveCounterId }],
    });
    await expect(env.DB.prepare(
      "SELECT id, network_bucket FROM security_events WHERE id IN (?, ?, ?) ORDER BY id",
    ).bind(expiredEventId, liveEventId, networkEventId).all<{ id: string; network_bucket: string | null }>())
      .resolves.toMatchObject({
        results: [
          { id: liveEventId, network_bucket: null },
          { id: networkEventId, network_bucket: null },
        ],
      });
  });

  it("runs expiry cleanup from the Worker's scheduled handler", async () => {
    const now = Date.now();
    const hourMs = 3_600_000;
    const dayMs = 86_400_000;
    const expiredCounterId = `session:${"c".repeat(64)}`;
    const liveCounterId = `session:${"d".repeat(64)}`;
    const expiredEventId = "scheduled-expired-event";
    const liveEventId = "scheduled-live-event";

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO rate_limit_counters (purpose, scope_type, scope_id, window_ms, time_epoch, count, expires_at)
         VALUES ('session.refresh', 'session', ?, ?, ?, 1, ?)`,
      ).bind(expiredCounterId, hourMs, now - hourMs - 1, now - 1),
      env.DB.prepare(
        `INSERT INTO rate_limit_counters (purpose, scope_type, scope_id, window_ms, time_epoch, count, expires_at)
         VALUES ('session.refresh', 'session', ?, ?, ?, 1, ?)`,
      ).bind(liveCounterId, hourMs, now - hourMs + 60_000, now + 60_000),
      env.DB.prepare(
        `INSERT INTO security_events
          (id, created_at, expires_at, action_class, outcome, reason, proof_state, counter_state)
         VALUES (?, ?, ?, 'registration', 'deny', 'policy_denied', 'not_applicable', 'denied')`,
      ).bind(expiredEventId, now - 30 * dayMs - 1_000, now - 1_000),
      env.DB.prepare(
        `INSERT INTO security_events
          (id, created_at, expires_at, action_class, outcome, reason, proof_state, counter_state)
         VALUES (?, ?, ?, 'registration', 'deny', 'policy_denied', 'not_applicable', 'denied')`,
      ).bind(liveEventId, now - 30 * dayMs + 60_000, now + 60_000),
    ]);

    await expect(worker.scheduled(createScheduledController({ scheduledTime: now }), env))
      .resolves.toBeUndefined();
    await expect(env.DB.prepare(
      "SELECT scope_id FROM rate_limit_counters WHERE scope_id IN (?, ?) ORDER BY scope_id",
    ).bind(expiredCounterId, liveCounterId).all<{ scope_id: string }>()).resolves.toMatchObject({
      results: [{ scope_id: liveCounterId }],
    });
    await expect(env.DB.prepare(
      "SELECT id FROM security_events WHERE id IN (?, ?) ORDER BY id",
    ).bind(expiredEventId, liveEventId).all<{ id: string }>()).resolves.toMatchObject({
      results: [{ id: liveEventId }],
    });
  });

  it("checks the global cap before parsing or persisting a Network bucket", async () => {
    const now = BASE_TIME + 40_000_000;
    for (let attempt = 1; attempt <= 30; attempt++) {
      await expect(enforceRateLimit({
        db: env.DB,
        request: makeRequest(`192.0.2.${attempt}`),
        action: "registration.challenge",
        hmacSecret: HMAC_SECRET,
        now,
      })).resolves.toEqual({ allowed: true });
    }

    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS amount FROM rate_limit_counters WHERE purpose = 'registration.challenge' AND scope_type = 'network' AND time_epoch = ?",
    ).bind(now).first<{ amount: number }>();
    expect(before?.amount).toBe(60);

    await expect(enforceRateLimit({
      db: env.DB,
      request: makeRequest("not-an-edge-address"),
      action: "registration.challenge",
      hmacSecret: HMAC_SECRET,
      now,
    })).resolves.toEqual({ allowed: false, retryAfterSeconds: 600 });

    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS amount FROM rate_limit_counters WHERE purpose = 'registration.challenge' AND scope_type = 'network' AND time_epoch = ?",
    ).bind(now).first<{ amount: number }>();
    expect(after?.amount).toEqual(before?.amount);
  });
});
