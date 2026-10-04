/**
 * Public-participation policy constants (ticket 26). Pure and client-safe:
 * the browser renders the same fixed categories the Worker validates, and the
 * shared notice names only the automatic end of a suspension — never an
 * appeal, a strike history, or any private material.
 */

/** Category-only report choices. The fixed set is the only free-form-free
 * signal a report may carry; no report ever carries plaintext. */
export const REPORT_CATEGORIES = ["spam", "abuse", "other"] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  spam: "Spam or advertising",
  abuse: "Abuse, harassment, or a threat",
  other: "Something else",
};

/** How long a report is retained as operator-only pattern metadata. */
export const REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** First Public-participation suspension: seven days. */
export const FIRST_SUSPENSION_MS = 7 * 24 * 60 * 60 * 1000;
/** Any later suspension: 30 days. */
export const REPEAT_SUSPENSION_MS = 30 * 24 * 60 * 60 * 1000;

export type PublicParticipationSuspensionReason =
  | "repeated_technical_abuse"
  | "report_pattern";

const SUSPENSION_REASONS: readonly string[] = ["repeated_technical_abuse", "report_pattern"];

export function isReportCategory(value: unknown): value is ReportCategory {
  return typeof value === "string" && (REPORT_CATEGORIES as readonly string[]).includes(value);
}

export function isPublicParticipationSuspensionReason(
  value: unknown,
): value is PublicParticipationSuspensionReason {
  return typeof value === "string" && SUSPENSION_REASONS.includes(value);
}

/**
 * The one notice shown wherever a suspended Account's blocked action failed.
 * It states the automatic end and the operations that keep working; it never
 * implies an appeal, a permanent ban, or a private-vault lockout.
 */
export function publicParticipationSuspensionNotice(suspendedUntil: number | null): string {
  const ends = suspendedUntil === null
    ? "It ends automatically."
    : `It ends automatically on ${new Date(suspendedUntil).toLocaleDateString(undefined, { dateStyle: "medium" })}.`;
  return `Your account can’t post public comments or publish right now because public participation is suspended. ${ends} Private Files, sharing, export, recovery, and deletion still work.`;
}
