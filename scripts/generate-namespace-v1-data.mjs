#!/usr/bin/env node

/**
 * Generate the immutable runtime tables used by mdwn/namespace-v1.
 *
 * This script intentionally reads only the checked-in Unicode 17.0.0 UCD
 * snapshot.  Runtime code never calls the host's normalize/lowercase APIs.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ucdDirectory = join(root, "vendor/unicode/17.0.0/ucd");
const outputPath = join(root, "app/shared/namespace-v1/generated.ts");
const sourceNames = [
  "CaseFolding.txt",
  "CompositionExclusions.txt",
  "DerivedNormalizationProps.txt",
  "NormalizationTest.txt",
  "PropList.txt",
  "ReadMe.txt",
  "UnicodeData.txt",
];
// This identity is part of namespace-v1. A future Unicode release requires a
// deliberate namespace migration and must not be accepted by regeneration.
const EXPECTED_UCD_SOURCE_SHA256 = "45c409c3cc99efd61f3c6c7b97b5799085707946c1229801a74fc0d5965e5eec";

/** @type {Map<string, Buffer>} */
const sourceBytes = new Map();
for (const name of sourceNames) {
  sourceBytes.set(name, await readFile(join(ucdDirectory, name)));
}

/** @returns {string} */
function hashFiles() {
  const hash = createHash("sha256");
  for (const name of sourceNames) {
    hash.update(name);
    hash.update("\0");
    const bytes = sourceBytes.get(name);
    if (!bytes) throw new Error(`Missing source file: ${name}`);
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** @param {string} name @returns {string[]} */
function dataLines(name) {
  const bytes = sourceBytes.get(name);
  if (!bytes) throw new Error(`Missing source file: ${name}`);
  return bytes
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.split("#", 1)[0].trim())
    .filter(Boolean);
}

/** @param {string} value @returns {[number, number]} */
function parseRange(value) {
  const [first, last = first] = value.trim().split("..");
  return [Number.parseInt(first, 16), Number.parseInt(last, 16)];
}

/** @returns {{ decompositions: Array<[number, number[]]>, combiningClasses: Array<[number, number]> }} */
function parseUnicodeData() {
  /** @type {Array<[number, number[]]>} */
  const decompositions = [];
  /** @type {Array<[number, number]>} */
  const combiningClasses = [];
  for (const line of dataLines("UnicodeData.txt")) {
    const fields = line.split(";");
    if (fields.length < 6) throw new Error(`Malformed UnicodeData line: ${line}`);
    const codePoint = Number.parseInt(fields[0], 16);
    const category = fields[2];
    const ccc = Number.parseInt(fields[3], 10);
    if (ccc !== 0) combiningClasses.push([codePoint, ccc]);
    const decomposition = fields[5].trim();
    if (decomposition && !decomposition.startsWith("<")) {
      decompositions.push(
        /** @type {[number, number[]]} */ ([
          codePoint,
          decomposition.split(/\s+/).map((value) => Number.parseInt(value, 16)),
        ]),
      );
    }
    // Keep the category variable in this parser: it documents that range
    // records and controls are intentionally read from the normative field
    // layout, even though the namespace profile only needs explicit C0/C1
    // checks and the Bidi_Control property below.
    void category;
  }
  return { decompositions, combiningClasses };
}

/** @returns {Array<[number, number[]]>} */
function parseCaseFolding() {
  /** @type {Map<number, number[]>} */
  const mappings = new Map();
  for (const line of dataLines("CaseFolding.txt")) {
    const fields = line.split(";").map((field) => field.trim());
    if (fields.length < 3) throw new Error(`Malformed CaseFolding line: ${line}`);
    const status = fields[1];
    if (status !== "C" && status !== "F") continue;
    const codePoint = Number.parseInt(fields[0], 16);
    const mapping = fields[2].split(/\s+/).map((value) => Number.parseInt(value, 16));
    // Full mappings take precedence over a simple mapping where both are
    // present.  T mappings are deliberately never read.
    if (status === "F" || !mappings.has(codePoint)) mappings.set(codePoint, mapping);
  }
  return [...mappings.entries()].sort(([a], [b]) => a - b);
}

/** @returns {Set<number>} */
function parseCompositionExclusions() {
  const exclusions = new Set();
  // DerivedNormalizationProps is the normative source for the complete
  // Full_Composition_Exclusion property. CompositionExclusions.txt is only
  // the historical explicit subset and intentionally omits U+0344.
  for (const line of dataLines("DerivedNormalizationProps.txt")) {
    const [range, property] = line.split(";").map((part) => part.trim());
    if (property !== "Full_Composition_Exclusion") continue;
    const [first, last] = parseRange(range);
    for (let codePoint = first; codePoint <= last; codePoint++) {
      exclusions.add(codePoint);
    }
  }
  return exclusions;
}

/**
 * @param {Array<[number, number[]]>} decompositions
 * @param {Set<number>} exclusions
 * @returns {Array<[number, number, number]>}
 */
function parseCompositions(decompositions, exclusions) {
  return decompositions
    .filter(([codePoint, mapping]) => mapping.length === 2 && !exclusions.has(codePoint))
    .map(([codePoint, [first, second]]) => /** @type {[number, number, number]} */ ([first, second, codePoint]))
    .sort(([a, b], [c, d]) => a - c || b - d);
}

/** @returns {Array<[number, number]>} */
function parseBidiControls() {
  return dataLines("PropList.txt")
    .filter((line) => line.split(";")[1]?.trim() === "Bidi_Control")
    .map((line) => parseRange(line.split(";")[0]))
    .sort(([a], [b]) => a - b);
}

/** @param {unknown} value @returns {string} */
function ts(value) {
  return JSON.stringify(value);
}

/** @param {Array<readonly unknown[]>} rows @returns {string} */
function tupleRows(rows) {
  return rows.map((row) => `  [${row.map((value) => ts(value)).join(", ")}],`).join("\n");
}

const { decompositions, combiningClasses } = parseUnicodeData();
const exclusions = parseCompositionExclusions();
const compositions = parseCompositions(decompositions, exclusions);
const caseFolding = parseCaseFolding();
const bidiControls = parseBidiControls();
const sourceHash = hashFiles();
if (sourceHash !== EXPECTED_UCD_SOURCE_SHA256) {
  throw new Error(
    `Unicode namespace source identity mismatch: expected ${EXPECTED_UCD_SOURCE_SHA256}, got ${sourceHash}`,
  );
}

const output =
  `// Generated by scripts/generate-namespace-v1-data.mjs. Do not edit.\n// Unicode ${"17.0.0"} UCD source hash: ${sourceHash}\n\n` +
  `export const GENERATED_UNICODE_VERSION = "17.0.0" as const;\n` +
  `export const GENERATED_UCD_SHA256 = ${ts(sourceHash)} as const;\n\n` +
  `export const CANONICAL_DECOMPOSITIONS: readonly (readonly [number, readonly number[]])[] = [\n${tupleRows(decompositions)}\n];\n\n` +
  `export const COMBINING_CLASSES: readonly (readonly [number, number])[] = [\n${tupleRows(combiningClasses)}\n];\n\n` +
  `export const COMPOSITIONS: readonly (readonly [number, number, number])[] = [\n${tupleRows(compositions)}\n];\n\n` +
  `export const FULL_CASE_FOLDINGS: readonly (readonly [number, readonly number[]])[] = [\n${tupleRows(caseFolding)}\n];\n\n` +
  `export const BIDI_CONTROL_RANGES: readonly (readonly [number, number])[] = [\n${tupleRows(bidiControls)}\n];\n`;

const manifestPath = join(root, "app/shared/namespace-v1/data-version.ts");
const manifest =
  `// Generated by scripts/generate-namespace-v1-data.mjs. Do not edit.\n` +
  `export const NAMESPACE_IMPLEMENTATION_VERSION = "mdwn/namespace-v1" as const;\n` +
  `export const UNICODE_VERSION = "17.0.0" as const;\n` +
  `export const EXPECTED_UCD_SOURCE_SHA256 = ${ts(EXPECTED_UCD_SOURCE_SHA256)} as const;\n` +
  `export const UCD_SOURCE_SHA256 = ${ts(EXPECTED_UCD_SOURCE_SHA256)} as const;\n` +
  `export const UCD_SOURCE_FILES = ${ts(sourceNames)} as const;\n`;

if (process.argv.includes("--check")) {
  let drift = false;
  for (const [path, expected] of [
    [outputPath, output],
    [manifestPath, manifest],
  ]) {
    let actual;
    try {
      actual = (await readFile(path)).toString("utf8");
    } catch {
      actual = undefined;
    }
    if (actual !== expected) {
      console.error(`Namespace generated-data drift: ${relative(root, path)}`);
      drift = true;
    }
  }
  if (drift) process.exitCode = 1;
  else console.log(`Namespace generated data matches ${sourceNames.length} Unicode 17.0.0 files`);
} else {
  await writeFile(outputPath, output);
  await writeFile(manifestPath, manifest);
  console.log(`Generated ${relative(root, outputPath)} from ${sourceNames.length} Unicode 17.0.0 files`);
}
