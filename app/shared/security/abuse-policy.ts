export type RateLimitAction =
  | "registration.challenge"
  | "registration.success"
  | "webauthn.sign_in"
  | "recovery.attempt"
  | "vault_recovery.start"
  | "session.refresh"
  | "public_comment.mutate"
  | "public_comment.report"
  | "publication.mutate";

export type RateLimitScope =
  | "global"
  | "account"
  | "publication"
  | "account_publication"
  | "session"
  | "recovery_identifier"
  | "network";

export interface RateLimitRule {
  readonly scope: RateLimitScope;
  readonly limit: number;
  readonly windowMs: number;
  /** The sign-in Account limit is applied once a Passkey identifies an Account. */
  readonly optional?: true;
}

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/**
 * Normative Workers Free + D1 Free limits from wayfinder 16 / ADR 0005.
 * Keep global rules first: callers must not derive a Network bucket unless
 * every global rule allows the request.
 */
export const RATE_LIMIT_POLICIES = {
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
  "vault_recovery.start": [
    { scope: "global", limit: 30, windowMs: 10 * minute },
    { scope: "network", limit: 3, windowMs: hour },
    { scope: "network", limit: 10, windowMs: day },
    { scope: "account", limit: 3, windowMs: hour },
    { scope: "account", limit: 10, windowMs: day },
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
} as const satisfies Record<RateLimitAction, readonly RateLimitRule[]>;
