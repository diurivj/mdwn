import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  normalizeNfc,
  normalizeNfd,
} from "../app/namespace-v1";
import {
  GENERATED_UCD_SHA256,
} from "../app/namespace-v1/generated";
import {
  EXPECTED_UCD_SOURCE_SHA256,
  NAMESPACE_IMPLEMENTATION_VERSION,
  UCD_SOURCE_FILES,
  UCD_SOURCE_SHA256,
  UNICODE_VERSION,
} from "../app/namespace-v1/data-version";

const UCD_DIRECTORY = new URL("../vendor/unicode/17.0.0/ucd/", import.meta.url);

function sourceHash(): string {
  const hash = createHash("sha256");
  for (const name of UCD_SOURCE_FILES) {
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(new URL(name, UCD_DIRECTORY)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function parseNormalizationLine(line: string): [string, string, string, string, string] | undefined {
  const withoutComment = line.split("#", 1)[0].trim();
  if (!withoutComment || withoutComment.startsWith("@")) return undefined;
  const fields = withoutComment.split(";").map((field) => field.trim());
  while (fields.at(-1) === "") fields.pop();
  if (fields.length !== 5) throw new Error(`Malformed NormalizationTest line: ${line}`);
  return fields.map((field) => field.split(/\s+/).map((codePoint) => String.fromCodePoint(Number.parseInt(codePoint, 16))).join("")) as [string, string, string, string, string];
}

describe("mdwn/namespace-v1 Unicode data gate", () => {
  it("pins the package, UCD release, and source-data hash", () => {
    expect(NAMESPACE_IMPLEMENTATION_VERSION).toBe("mdwn/namespace-v1");
    expect(UNICODE_VERSION).toBe("17.0.0");
    expect(EXPECTED_UCD_SOURCE_SHA256).toBe("45c409c3cc99efd61f3c6c7b97b5799085707946c1229801a74fc0d5965e5eec");
    expect(UCD_SOURCE_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(UCD_SOURCE_SHA256).toBe(EXPECTED_UCD_SOURCE_SHA256);
    expect(UCD_SOURCE_SHA256).toBe(GENERATED_UCD_SHA256);
    expect(sourceHash()).toBe(UCD_SOURCE_SHA256);
    expect(readFileSync(new URL("UCD-LICENSE.txt", UCD_DIRECTORY), "utf8")).toContain("Unicode");
    expect(() => execFileSync(process.execPath, ["scripts/generate-namespace-v1-data.mjs", "--check"], {
      cwd: new URL("..", import.meta.url),
      stdio: "pipe",
    })).not.toThrow();
  });

  it("rejects a drifted vendored source before regeneration", () => {
    const sourcePath = new URL("ReadMe.txt", UCD_DIRECTORY);
    const original = readFileSync(sourcePath);
    try {
      writeFileSync(sourcePath, Buffer.concat([original, Buffer.from("\n# namespace-v1 drift\n")]));
      expect(() => execFileSync(process.execPath, ["scripts/generate-namespace-v1-data.mjs"], {
        cwd: new URL("..", import.meta.url),
        stdio: "pipe",
      })).toThrow();
    } finally {
      writeFileSync(sourcePath, original);
    }
  });

  it("passes every Unicode 17.0.0 NFC/NFD conformance vector", () => {
    const corpus = readFileSync(new URL("NormalizationTest.txt", UCD_DIRECTORY), "utf8");
    let count = 0;
    for (const line of corpus.split(/\r?\n/)) {
      const vector = parseNormalizationLine(line);
      if (!vector) continue;
      const [source, nfc, nfd, nfkc, nfkd] = vector;
      expect(normalizeNfc(source), `NFC source vector ${count}`).toBe(nfc);
      expect(normalizeNfc(nfc), `NFC closure vector ${count}`).toBe(nfc);
      expect(normalizeNfc(nfd), `NFC from NFD vector ${count}`).toBe(nfc);
      expect(normalizeNfc(nfkc), `NFC from NFKC vector ${count}`).toBe(nfkc);
      expect(normalizeNfc(nfkd), `NFC from NFKD vector ${count}`).toBe(nfkc);
      expect(normalizeNfd(source), `NFD source vector ${count}`).toBe(nfd);
      expect(normalizeNfd(nfc), `NFD from NFC vector ${count}`).toBe(nfd);
      expect(normalizeNfd(nfd), `NFD closure vector ${count}`).toBe(nfd);
      expect(normalizeNfd(nfkc), `NFD from NFKC vector ${count}`).toBe(nfkd);
      expect(normalizeNfd(nfkd), `NFD from NFKD vector ${count}`).toBe(nfkd);
      count += 1;
    }
    expect(count).toBeGreaterThan(10_000);
  });

  it("does not call host String.prototype.normalize", () => {
    const original = String.prototype.normalize;
    Object.defineProperty(String.prototype, "normalize", {
      configurable: true,
      value: () => { throw new Error("host normalize must not be used"); },
    });
    try {
      expect(normalizeNfc("Ame\u0301lie")).toBe("Amélie");
      expect(normalizeNfd("Amélie")).toBe("Ame\u0301lie");
    } finally {
      Object.defineProperty(String.prototype, "normalize", { configurable: true, value: original });
    }
  });
});
