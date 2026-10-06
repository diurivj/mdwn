import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FIRST_SUSPENSION_MS,
  REPORT_CATEGORIES,
  REPORT_CATEGORY_LABELS,
  REPORT_RETENTION_MS,
  REPEAT_SUSPENSION_MS,
  isPublicParticipationSuspensionReason,
  isReportCategory,
  publicParticipationSuspensionNotice,
} from "../app/shared/security/public-participation";

const day = 24 * 60 * 60 * 1000;
const operatorScript = readFileSync(join(process.cwd(), "scripts/public-participation.mjs"), "utf8");

describe("locked public-participation policy", () => {
  it("matches the decided durations and fixed category set", () => {
    expect(FIRST_SUSPENSION_MS).toBe(7 * day);
    expect(REPEAT_SUSPENSION_MS).toBe(30 * day);
    expect(REPORT_RETENTION_MS).toBe(30 * day);
    expect(REPORT_CATEGORIES).toEqual(["spam", "abuse", "other"]);
    expect(Object.keys(REPORT_CATEGORY_LABELS).sort()).toEqual([...REPORT_CATEGORIES].sort());
  });

  it("accepts only the fixed categories and suspension reasons", () => {
    for (const category of REPORT_CATEGORIES) expect(isReportCategory(category)).toBe(true);
    for (const value of ["", "text", "SPAM", null, 1, undefined]) expect(isReportCategory(value)).toBe(false);
    for (const reason of ["repeated_technical_abuse", "report_pattern"]) {
      expect(isPublicParticipationSuspensionReason(reason)).toBe(true);
    }
    expect(isPublicParticipationSuspensionReason("content_violation")).toBe(false);
  });

  it("states the automatic end and never implies an appeal or a permanent ban", () => {
    const notice = publicParticipationSuspensionNotice(1_800_000_000_000);
    expect(notice).toContain("public participation is suspended");
    expect(notice).toContain("ends automatically");
    expect(notice).not.toMatch(/appeal|permanent|content moderation|delete your account/i);
  });

  it("keeps the operator script's durations and reasons in lockstep with the server policy", () => {
    // A drift guard: these two literals are the shipped operator path, and the
    // reviewed server helper must apply exactly the same windows and reason set.
    expect(operatorScript).toContain("const FIRST_SUSPENSION_MS = 604_800_000;");
    expect(operatorScript).toContain("const REPEAT_SUSPENSION_MS = 2_592_000_000;");
    expect(operatorScript).toContain('const REASONS = ["repeated_technical_abuse", "report_pattern"];');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts the operator script's literal template source.
    expect(operatorScript).toContain("expires_at = excluded.started_at + ${REPEAT_SUSPENSION_MS}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts the operator script's literal template source.
    expect(operatorScript).toContain("${NOW_MS} + ${FIRST_SUSPENSION_MS}");
  });
});
