import { describe, expect, it } from "vitest";

import {
  normalizePseudonym,
  PSEUDONYM_MAX_CHARACTERS,
  pseudonymProblem,
  suggestPseudonym,
} from "../app/shared/account/pseudonym";

describe("Public pseudonyms a person chooses", () => {
  it("stores NFC text, trimmed, with each run of whitespace as one space", () => {
    expect(normalizePseudonym("  Quiet \t  Heron  27 ")).toBe("Quiet Heron 27");
    expect(normalizePseudonym("Café")).toBe("Café");
    // A line or paragraph separator is whitespace: it collapses rather than breaking the label.
    expect(normalizePseudonym("Line Break")).toBe("Line Break");
  });

  it("accepts 2 to 32 characters, counted as code points after normalization", () => {
    expect(pseudonymProblem("")).toBe("empty");
    expect(pseudonymProblem("   ")).toBe("empty");
    expect(pseudonymProblem("Q")).toBe("short");
    expect(pseudonymProblem(" Q ")).toBe("short");
    expect(pseudonymProblem("Qi")).toBeNull();
    expect(pseudonymProblem("a".repeat(PSEUDONYM_MAX_CHARACTERS))).toBeNull();
    expect(pseudonymProblem("a".repeat(PSEUDONYM_MAX_CHARACTERS + 1))).toBe("long");
    // Astral characters count once each, not as two UTF-16 units.
    expect(pseudonymProblem("🦉".repeat(PSEUDONYM_MAX_CHARACTERS))).toBeNull();
  });

  it("keeps other scripts, emoji and joiner sequences", () => {
    for (const pseudonym of ["Søren K", "山田 花子", "Ада Л.", "मेरा नाम", "👩\u200d💻 writes", "میرزا"]) {
      expect(pseudonymProblem(pseudonym), pseudonym).toBeNull();
    }
  });

  it("refuses control, format, private-use and unassigned characters", () => {
    for (const pseudonym of [
      "Bell\u0007",
      "Zero​width",
      "Right‮to left",
      "Isolate⁦d⁩",
      "Soft­hyphen",
      "Mark‏er",
      "Private",
      "Unassigned\u{e0080}",
      "Lone\ud800",
    ]) {
      expect(pseudonymProblem(pseudonym), JSON.stringify(pseudonym)).toBe("characters");
    }
  });

  it("suggests friendly pseudonyms that pass the same checks", () => {
    for (let index = 0; index < 200; index++) {
      const suggestion = suggestPseudonym();
      expect(suggestion).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ [1-9]\d$/);
      expect(pseudonymProblem(suggestion)).toBeNull();
      expect(normalizePseudonym(suggestion)).toBe(suggestion);
    }
  });
});
