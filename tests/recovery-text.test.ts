import { describe, expect, it } from "vitest";

import { recoveryCodesText, recoveryPhraseText } from "../app/shared/account/recovery-text";

const created = new Date("2026-10-11T12:00:00Z");
const words = Array.from({ length: 24 }, (_, index) => `word${index + 1}`);
const codes = Array.from({ length: 10 }, (_, index) => `CODE-${index}-XYZ`);

describe("downloadable recovery material", () => {
  it("numbers every phrase word in order, with the date and nothing else secret", () => {
    const text = recoveryPhraseText(words.join(" "), created);
    const listed = text.split("\n").filter((line) => /^ ?\d+\. /.test(line));
    expect(listed).toEqual(words.map((word, index) => `${String(index + 1).padStart(2, " ")}. ${word}`));
    expect(text).toContain("Saved 2026-10-11.");
    expect(text).not.toContain("CODE-");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("lists every code once with the non-secret recovery identifier", () => {
    const text = recoveryCodesText(codes, "019950d7-98c0-7000-8000-000000000001", created);
    for (const code of codes) expect(text.split(code)).toHaveLength(2);
    expect(text).toContain("Recovery identifier (not secret): 019950d7-98c0-7000-8000-000000000001");
    expect(text).toContain("Saved 2026-10-11.");
    expect(recoveryCodesText(codes, undefined, created)).not.toContain("Recovery identifier");
  });
});
