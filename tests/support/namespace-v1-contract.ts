import {
  allocateKeepBothNames,
  canonicalizeSegment,
  keepBothCandidate,
  NamespaceError,
  splitSourcePath,
  sameComparisonKey,
} from "../../app/shared/namespace-v1";

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertEqual<T>(actual: T, expected: T): void {
  if (actual !== expected) throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
}

function assertDeepEqual(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
}

function expectNamespaceError(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    if (error instanceof NamespaceError && error.code === code) return;
    throw new Error(`Expected namespace error ${code}, got ${String(error)}`);
  }
  throw new Error(`Expected namespace error ${code}`);
}

function segmentVector(input: string, display: string, key: string): void {
  const result = canonicalizeSegment(input);
  assertEqual(result.display, display);
  assertEqual(hex(result.comparisonKey), key);
}

export const cases = [
  {
    name: "uses Unicode 17 NFC display and default full-fold comparison bytes",
    run() {
      segmentVector("Am\u0065\u0301lie", "Amélie", "616dc3a96c6965");
      assertEqual(sameComparisonKey("Amélie", "Ame\u0301lie"), true);

      segmentVector("Straße", "Straße", "73747261737365");
      assertEqual(sameComparisonKey("Straße", "STRASSE"), true);

      assertEqual(sameComparisonKey("Σ", "σ"), true);
      assertEqual(sameComparisonKey("Σ", "ς"), true);
      assertEqual(sameComparisonKey("I", "i"), true);
      assertEqual(sameComparisonKey("İ", "i"), false);
      assertEqual(hex(canonicalizeSegment("İ").comparisonKey), "69cc87");

      segmentVector("Ａ", "Ａ", "efbd81");
      segmentVector("A", "A", "61");
      assertEqual(sameComparisonKey("Ａ", "A"), false);
    },
  },
  {
    name: "keeps ordinary whitespace, combining marks, emoji, variation selectors, joiners, and unassigned scalars",
    run() {
      for (const input of ["two words", "e\u0301", "🙂", "emoji\uFE0F", "क\u200Dष", "\u0378"]) {
        canonicalizeSegment(input);
      }
    },
  },
  {
    name: "rejects the locked segment profile boundaries",
    run() {
      for (const input of [
        "", ".", "..", "a\u0000b", "a/b", "a\\b", "a<b", "a>b", "a:b", "a\"b",
        "a|b", "a?b", "a*b", "trailing ", "trailing.", "a\u202Eb", "CON", "con.txt",
        "CON .txt", "PRN.md", "AUX", "NUL", "COM1", "com9.log", "LPT1", "lpt9.txt",
        "\u007f", "\u0085", "\u009f", "a".repeat(256),
      ]) {
        const expected = input.length > 255 && !input.includes("\u0000") ? "too-long" : undefined;
        if (expected) expectNamespaceError(() => canonicalizeSegment(input), expected);
        else expectNamespaceError(() => canonicalizeSegment(input),
          input === "" ? "empty" :
          input === "." || input === ".." ? "dot-segment" :
          input.endsWith(" ") || input.endsWith(".") ? "trailing-space-or-dot" :
          input.includes("\u202E") ? "bidi-control" :
          ["CON", "con.txt", "CON .txt", "PRN.md", "AUX", "NUL", "COM1", "com9.log", "LPT1", "lpt9.txt"].includes(input)
            ? "device-name" : "forbidden-character");
      }
      for (const input of [
        "\u061C", "\u200E", "\u200F", "\u202A", "\u202B", "\u202C", "\u202D", "\u202E",
        "\u2066", "\u2067", "\u2068", "\u2069",
      ]) {
        expectNamespaceError(() => canonicalizeSegment(input), "bidi-control");
      }
      expectNamespaceError(() => canonicalizeSegment("\uD800"), "malformed-scalar");
      expectNamespaceError(() => canonicalizeSegment("\uDC00"), "malformed-scalar");
      expectNamespaceError(() => canonicalizeSegment("\uD800a"), "malformed-scalar");
      canonicalizeSegment("\uD800\uDC00");
    },
  },
  {
    name: "measures the NFC display byte limit after normalization",
    run() {
      canonicalizeSegment("é".repeat(127) + "a");
      expectNamespaceError(() => canonicalizeSegment("é".repeat(128)), "too-long");
      // Each decomposed e + acute is three UTF-8 bytes, but its NFC display
      // form is two bytes. The profile measures the canonical display form.
      canonicalizeSegment("e\u0301".repeat(127) + "a");
    },
  },
  {
    name: "splits source paths before validation and refuses absolute, empty, and traversing paths",
    run() {
      assertDeepEqual(splitSourcePath("folder/Ame\u0301lie.md"), ["folder", "Amélie.md"]);
      assertDeepEqual(splitSourcePath("folder\\nested\\file.md"), ["folder", "nested", "file.md"]);
      expectNamespaceError(() => splitSourcePath("/absolute.md"), "absolute-source-path");
      expectNamespaceError(() => splitSourcePath("C:\\absolute.md"), "absolute-source-path");
      expectNamespaceError(() => splitSourcePath("folder//file.md"), "empty-source-component");
      expectNamespaceError(() => splitSourcePath("folder/../file.md"), "traversing-source-path");
      expectNamespaceError(() => splitSourcePath("folder/./file.md"), "traversing-source-path");
    },
  },
  {
    name: "applies the locked Keep-both split and starts at two",
    run() {
      const vectors: Array<[string, string]> = [
        ["draft.md", "draft (2).md"],
        ["archive.tar.gz", "archive.tar (2).gz"],
        [".env", ".env (2)"],
        ["draft.", "draft. (2)"],
        ["a..b", "a. (2).b"],
        ["draft (2).md", "draft (2) (2).md"],
      ];
      for (const [requested, expected] of vectors) {
        assertEqual(keepBothCandidate(requested, 2).display, expected);
      }
      expectNamespaceError(() => keepBothCandidate("draft.md", 1), "generated-name-exhausted");
    },
  },
  {
    name: "reserves direct source names before deterministic generated names",
    run() {
      const allocated = allocateKeepBothNames({
        existingSiblingNames: ["draft.md", "archive.tar.gz", ".env", "report.md", "report (3).md"],
        requests: [
          { sourcePath: "z/archive.tar.gz", requestedName: "archive.tar.gz" },
          { sourcePath: "b/report-explicit", requestedName: "report (2).md" },
          { sourcePath: "a/report-source", requestedName: "report.md" },
          { sourcePath: "c/draft-source", requestedName: "draft.md" },
          { sourcePath: "d/env-source", requestedName: ".env" },
        ],
      });
      assertDeepEqual(allocated.map(({ display, generated }) => ({ display, generated })), [
        { display: "archive.tar (2).gz", generated: true },
        { display: "report (2).md", generated: false },
        { display: "report (4).md", generated: true },
        { display: "draft (2).md", generated: true },
        { display: ".env (2)", generated: true },
      ]);
    },
  },
  {
    name: "orders generated candidates by source path and rejects duplicate normalized sources",
    run() {
      const requests = [
        { sourcePath: "z/draft", requestedName: "draft.md" },
        { sourcePath: "a/draft", requestedName: "draft.md" },
      ];
      const first = allocateKeepBothNames(["draft.md"], requests);
      assertDeepEqual(first.map((item) => item.display), ["draft (3).md", "draft (2).md"]);
      expectNamespaceError(() => allocateKeepBothNames(["existing"], [
        { sourcePath: "A/file", requestedName: "one" },
        { sourcePath: "a/FILE", requestedName: "two" },
      ]), "duplicate-source-path");

      const forward = allocateKeepBothNames([], [
        { sourcePath: "z/file.md", requestedName: "draft.md" },
        { sourcePath: "a/file.md", requestedName: "draft.md" },
      ]);
      const reversed = allocateKeepBothNames([], [
        { sourcePath: "a/file.md", requestedName: "draft.md" },
        { sourcePath: "z/file.md", requestedName: "draft.md" },
      ]);
      const byPath = (items: readonly { sourcePath: string; display: string }[]) =>
        items.slice().sort((a, b) => a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0)
          .map(({ sourcePath, display }) => ({ sourcePath, display }));
      assertDeepEqual(byPath(forward), byPath(reversed));
      assertDeepEqual(byPath(forward), [
        { sourcePath: "a/file.md", display: "draft.md" },
        { sourcePath: "z/file.md", display: "draft (2).md" },
      ]);
    },
  },
  {
    name: "reports a generated candidate that exceeds the segment profile",
    run() {
      const long = "a".repeat(255);
      expectNamespaceError(() => allocateKeepBothNames([long], [{ sourcePath: "long", requestedName: long }]), "generated-name-invalid");
    },
  },
] satisfies Array<{ name: string; run: () => void }>;

export type NamespaceContractCase = (typeof cases)[number];
