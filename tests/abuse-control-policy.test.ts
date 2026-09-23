import { describe, expect, it } from "vitest";

import { RATE_LIMIT_POLICIES } from "../app/security/abuse-policy";
import {
  abuseControlUnavailableResponse,
  rateLimitResponse,
} from "../app/security/abuse-control.server";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

describe("locked abuse-control policy", () => {
  it("matches every scope and threshold in the policy table", () => {
    expect(RATE_LIMIT_POLICIES).toEqual({
      "registration.challenge": [
        { scope: "global", limit: 30, windowMs: 10 * minute },
        { scope: "network", limit: 3, windowMs: 15 * minute },
        { scope: "network", limit: 10, windowMs: day },
      ],
      "registration.success": [
        { scope: "global", limit: 100, windowMs: day },
        { scope: "network", limit: 2, windowMs: day },
      ],
      "webauthn.sign_in": [
        { scope: "global", limit: 120, windowMs: 10 * minute },
        { scope: "network", limit: 10, windowMs: 15 * minute },
        { scope: "network", limit: 50, windowMs: day },
        { scope: "account", limit: 10, windowMs: 15 * minute, optional: true },
        { scope: "account", limit: 50, windowMs: day, optional: true },
      ],
      "recovery.attempt": [
        { scope: "global", limit: 30, windowMs: 10 * minute },
        { scope: "network", limit: 3, windowMs: hour },
        { scope: "network", limit: 10, windowMs: day },
        { scope: "recovery_identifier", limit: 3, windowMs: hour },
        { scope: "recovery_identifier", limit: 10, windowMs: day },
      ],
      "session.refresh": [
        { scope: "session", limit: 12, windowMs: hour },
      ],
      "public_comment.mutate": [
        { scope: "global", limit: 30, windowMs: minute },
        { scope: "global", limit: 300, windowMs: day },
        { scope: "network", limit: 10, windowMs: 10 * minute },
        { scope: "network", limit: 50, windowMs: day },
        { scope: "account", limit: 5, windowMs: 10 * minute },
        { scope: "account", limit: 30, windowMs: day },
        { scope: "publication", limit: 10, windowMs: 10 * minute },
        { scope: "publication", limit: 100, windowMs: day },
        { scope: "account_publication", limit: 3, windowMs: 10 * minute },
        { scope: "account_publication", limit: 20, windowMs: day },
      ],
      "public_comment.report": [
        { scope: "account", limit: 3, windowMs: day },
      ],
      "publication.mutate": [
        { scope: "account", limit: 5, windowMs: day },
      ],
    });
  });

  it("returns the same generic 429 envelope with a valid Retry-After", async () => {
    const response = rateLimitResponse({ allowed: false, retryAfterSeconds: 2.2 });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("3");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "rate_limited" });
  });

  it("fails closed with a generic 503 if abuse controls are unavailable", async () => {
    const response = abuseControlUnavailableResponse();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
  });

  it("places all global checks before other scopes and retains only 24-hour windows", () => {
    for (const rules of Object.values(RATE_LIMIT_POLICIES)) {
      const firstNonGlobal = rules.findIndex((rule) => rule.scope !== "global");
      const globalAfterOther = firstNonGlobal >= 0
        && rules.slice(firstNonGlobal).some((rule) => rule.scope === "global");
      expect(globalAfterOther).toBe(false);
      expect(rules.every((rule) => rule.windowMs <= day)).toBe(true);
    }
  });
});
