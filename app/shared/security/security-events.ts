export type SecurityEventActionClass =
  | "registration_challenge"
  | "registration"
  | "sign_in"
  | "recovery"
  | "session_refresh"
  | "device_removal"
  | "public_comment"
  | "public_comment_report"
  | "publication";

export type SecurityEventOutcome = "allow" | "deny";
export type SecurityEventReason =
  | "allowed"
  | "rate_limited"
  | "honeypot-filled"
  | "proof_invalid"
  | "proof_spent"
  | "policy_denied"
  | "capacity_exhausted";
export type SecuritySizeClass = "unknown" | "zero" | "under_1_kib" | "1_to_4_kib" | "4_to_16_kib" | "over_16_kib";
export type SecurityProofState = "not_applicable" | "issued" | "valid" | "invalid" | "spent";
export type SecurityCounterState = "not_checked" | "allowed" | "denied";

export interface NewSecurityEvent {
  readonly actionClass: SecurityEventActionClass;
  readonly outcome: SecurityEventOutcome;
  readonly reason: SecurityEventReason;
  readonly accountId?: string;
  readonly publicationId?: string;
  readonly sizeClass?: SecuritySizeClass;
  readonly proofState: SecurityProofState;
  readonly counterState: SecurityCounterState;
  readonly retryAt?: number;
  /** A purpose-scoped HMAC digest only; never pass an edge IP here. */
  readonly networkBucket?: string;
}
