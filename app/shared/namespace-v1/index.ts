import {
  BIDI_CONTROL_RANGES,
  CANONICAL_DECOMPOSITIONS,
  COMBINING_CLASSES,
  COMPOSITIONS,
  FULL_CASE_FOLDINGS,
} from "./generated";
import { NAMESPACE_IMPLEMENTATION_VERSION, UCD_SOURCE_SHA256, UNICODE_VERSION } from "./data-version";

export {
  NAMESPACE_IMPLEMENTATION_VERSION,
  UCD_SOURCE_SHA256,
  UCD_SOURCE_FILES,
  UNICODE_VERSION,
} from "./data-version";

export const NAMESPACE_VERSION = NAMESPACE_IMPLEMENTATION_VERSION;
export const MAX_SEGMENT_BYTES = 255;

export type Bytes = Uint8Array<ArrayBuffer>;

export type NamespaceErrorCode =
  | "not-string"
  | "malformed-scalar"
  | "empty"
  | "dot-segment"
  | "forbidden-character"
  | "trailing-space-or-dot"
  | "bidi-control"
  | "device-name"
  | "too-long"
  | "invalid-source-path"
  | "absolute-source-path"
  | "empty-source-component"
  | "traversing-source-path"
  | "duplicate-source-path"
  | "existing-collision"
  | "generated-name-invalid"
  | "generated-name-exhausted";

export interface NamespaceErrorDetails {
  readonly input?: string;
  readonly candidate?: string;
  readonly reason?: NamespaceErrorCode;
  readonly sourcePath?: string;
}

/** Errors are intentionally code-only at the service boundary. */
export class NamespaceError extends Error {
  constructor(
    readonly code: NamespaceErrorCode,
    readonly details: NamespaceErrorDetails = {},
  ) {
    super(`mdwn/namespace-v1: ${code}`);
    this.name = "NamespaceError";
  }
}

export interface CanonicalSegment {
  /** NFC_17 display spelling. */
  readonly display: string;
  /** UTF-8 bytes of NFC_17(default-full-case-fold_17(NFD_17(display))). */
  readonly comparisonKey: Bytes;
}

export interface SegmentValidationSuccess {
  readonly valid: true;
  readonly segment: CanonicalSegment;
}

export interface SegmentValidationFailure {
  readonly valid: false;
  readonly code: NamespaceErrorCode;
}

export type SegmentValidationResult = SegmentValidationSuccess | SegmentValidationFailure;

export interface NameRequest {
  /** Relative source path used to make allocation order independent of enumeration. */
  readonly sourcePath: string;
  /** Requested leaf display name in this one target Directory. */
  readonly requestedName: string;
}

export interface NameAllocation {
  readonly sourcePath: string;
  readonly requestedName: string;
  readonly display: string;
  readonly comparisonKey: Bytes;
  readonly generated: boolean;
}

export interface NameAllocationOptions {
  /** Decrypted display names of current siblings in this Directory. */
  readonly existingSiblingNames: readonly string[];
  /** Prospective siblings for this one Directory. */
  readonly requests: readonly NameRequest[];
}

const decomposition = new Map<number, readonly number[]>(CANONICAL_DECOMPOSITIONS);
const combiningClass = new Map<number, number>(COMBINING_CLASSES);
const caseFolding = new Map<number, readonly number[]>(FULL_CASE_FOLDINGS);
const composition = new Map<number, number>();
for (const [first, second, composed] of COMPOSITIONS) {
  composition.set(compositionKey(first, second), composed);
}

const S_BASE = 0xac00;
const L_BASE = 0x1100;
const V_BASE = 0x1161;
const T_BASE = 0x11a7;
const L_COUNT = 19;
const V_COUNT = 21;
const T_COUNT = 28;
const N_COUNT = V_COUNT * T_COUNT;
const S_COUNT = L_COUNT * N_COUNT;

const FORBIDDEN_ASCII = new Set([
  0x2f, // /
  0x5c, // \\
  0x3c, // <
  0x3e, // >
  0x3a, // :
  0x22, // "
  0x7c, // |
  0x3f, // ?
  0x2a, // *
]);

const DEVICE_STEMS = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

function compositionKey(first: number, second: number): number {
  return first * 0x110000 + second;
}

function scalarValues(input: string): number[] {
  if (typeof input !== "string") throw new NamespaceError("not-string");
  const values: number[] = [];
  for (let offset = 0; offset < input.length; ) {
    const first = input.charCodeAt(offset);
    if (first >= 0xd800 && first <= 0xdbff) {
      if (offset + 1 >= input.length) throw new NamespaceError("malformed-scalar");
      const second = input.charCodeAt(offset + 1);
      if (second < 0xdc00 || second > 0xdfff) {
        throw new NamespaceError("malformed-scalar");
      }
      values.push(0x10000 + ((first - 0xd800) << 10) + second - 0xdc00);
      offset += 2;
      continue;
    }
    if (first >= 0xdc00 && first <= 0xdfff) {
      throw new NamespaceError("malformed-scalar");
    }
    values.push(first);
    offset += 1;
  }
  return values;
}

function fromScalars(values: readonly number[]): string {
  let result = "";
  for (const value of values) {
    if (value <= 0xffff) {
      result += String.fromCharCode(value);
      continue;
    }
    const adjusted = value - 0x10000;
    result += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
  }
  return result;
}

function canonicalCombiningClass(codePoint: number): number {
  return combiningClass.get(codePoint) ?? 0;
}

function decomposeCodePoint(codePoint: number, output: number[]): void {
  if (codePoint >= S_BASE && codePoint < S_BASE + S_COUNT) {
    const index = codePoint - S_BASE;
    const l = L_BASE + Math.floor(index / N_COUNT);
    const v = V_BASE + Math.floor((index % N_COUNT) / T_COUNT);
    const t = T_BASE + (index % T_COUNT);
    output.push(l, v);
    if (t !== T_BASE) output.push(t);
    return;
  }
  const mapping = decomposition.get(codePoint);
  if (!mapping) {
    output.push(codePoint);
    return;
  }
  for (const child of mapping) decomposeCodePoint(child, output);
}

function reorderCanonical(values: readonly number[]): number[] {
  const result: number[] = [];
  for (const value of values) {
    const ccc = canonicalCombiningClass(value);
    if (ccc === 0 || result.length === 0) {
      result.push(value);
      continue;
    }
    let insertion = result.length;
    while (insertion > 0 && canonicalCombiningClass(result[insertion - 1]) > ccc) {
      insertion -= 1;
    }
    result.splice(insertion, 0, value);
  }
  return result;
}

function nfdScalars(values: readonly number[]): number[] {
  const decomposed: number[] = [];
  for (const value of values) decomposeCodePoint(value, decomposed);
  return reorderCanonical(decomposed);
}

function hangulComposition(starter: number, next: number): number | undefined {
  const starterIndex = starter - L_BASE;
  if (starterIndex >= 0 && starterIndex < L_COUNT) {
    const vowelIndex = next - V_BASE;
    if (vowelIndex >= 0 && vowelIndex < V_COUNT) {
      return S_BASE + (starterIndex * V_COUNT + vowelIndex) * T_COUNT;
    }
  }
  const syllableIndex = starter - S_BASE;
  const trailingIndex = next - T_BASE;
  if (
    syllableIndex >= 0 &&
    syllableIndex < S_COUNT &&
    syllableIndex % T_COUNT === 0 &&
    trailingIndex > 0 &&
    trailingIndex < T_COUNT
  ) {
    return starter + trailingIndex;
  }
  return undefined;
}

function composeCanonical(values: readonly number[]): number[] {
  const result: number[] = [];
  let starterIndex = -1;
  let lastCombiningClass = 0;
  for (const value of values) {
    const ccc = canonicalCombiningClass(value);
    if (ccc === 0) {
      const starter = starterIndex >= 0 ? result[starterIndex] : undefined;
      const composed =
        starter === undefined
          ? undefined
          : (hangulComposition(starter, value) ?? composition.get(compositionKey(starter, value)));
      if (composed !== undefined && lastCombiningClass === 0) {
        result[starterIndex] = composed;
        lastCombiningClass = 0;
        continue;
      }
      result.push(value);
      starterIndex = result.length - 1;
      lastCombiningClass = 0;
      continue;
    }

    const starter = starterIndex >= 0 ? result[starterIndex] : undefined;
    const composed =
      starter === undefined || lastCombiningClass >= ccc
        ? undefined
        : (hangulComposition(starter, value) ?? composition.get(compositionKey(starter, value)));
    if (composed !== undefined) {
      result[starterIndex] = composed;
      continue;
    }
    result.push(value);
    lastCombiningClass = ccc;
  }
  return result;
}

function normalizeNfcFromScalars(values: readonly number[]): string {
  return fromScalars(composeCanonical(nfdScalars(values)));
}

/** NFC_17, including strict rejection of malformed UTF-16 input. */
export function normalizeNfc(input: string): string {
  return normalizeNfcFromScalars(scalarValues(input));
}

/** NFD_17, exposed for conformance tests and the comparison-key contract. */
export function normalizeNfd(input: string): string {
  return fromScalars(nfdScalars(scalarValues(input)));
}

/** Unicode 17.0.0 default full case folding (C and F mappings, never T). */
export function defaultFullCaseFold(input: string): string {
  const values = scalarValues(input);
  const folded: number[] = [];
  for (const value of values) {
    const mapping = caseFolding.get(value);
    if (mapping) folded.push(...mapping);
    else folded.push(value);
  }
  return fromScalars(folded);
}

function isBidiControl(codePoint: number): boolean {
  let low = 0;
  let high = BIDI_CONTROL_RANGES.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [first, last] = BIDI_CONTROL_RANGES[middle];
    if (codePoint < first) high = middle - 1;
    else if (codePoint > last) low = middle + 1;
    else return true;
  }
  return false;
}

function encodeUtf8Scalars(values: readonly number[]): Bytes {
  const bytes: number[] = [];
  for (const value of values) {
    if (value <= 0x7f) bytes.push(value);
    else if (value <= 0x7ff) {
      bytes.push(0xc0 | (value >> 6), 0x80 | (value & 0x3f));
    } else if (value <= 0xffff) {
      bytes.push(0xe0 | (value >> 12), 0x80 | ((value >> 6) & 0x3f), 0x80 | (value & 0x3f));
    } else {
      bytes.push(
        0xf0 | (value >> 18),
        0x80 | ((value >> 12) & 0x3f),
        0x80 | ((value >> 6) & 0x3f),
        0x80 | (value & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes) as Bytes;
}

/** UTF-8 encoding with strict scalar handling and no replacement characters. */
export function utf8Bytes(input: string): Bytes {
  return encodeUtf8Scalars(scalarValues(input));
}

function validateDisplay(display: string): NamespaceErrorCode | undefined {
  const values = scalarValues(display);
  if (values.length === 0) return "empty";
  if (display === "." || display === "..") return "dot-segment";
  if (values.some((value) => value <= 0x1f || (value >= 0x7f && value <= 0x9f))) {
    return "forbidden-character";
  }
  if (values.some((value) => FORBIDDEN_ASCII.has(value))) return "forbidden-character";
  if (display.endsWith(" ") || display.endsWith(".")) return "trailing-space-or-dot";
  if (values.some(isBidiControl)) return "bidi-control";

  const firstDot = display.indexOf(".");
  const stem = display.slice(0, firstDot < 0 ? display.length : firstDot).replace(/[ .]+$/g, "");
  if (DEVICE_STEMS.has(asciiUppercase(stem))) return "device-name";

  const byteLength = encodeUtf8Scalars(values).byteLength;
  if (byteLength < 1 || byteLength > MAX_SEGMENT_BYTES) return "too-long";
  return undefined;
}

function asciiUppercase(value: string): string {
  let result = "";
  for (let offset = 0; offset < value.length; offset++) {
    const code = value.charCodeAt(offset);
    result += code >= 0x61 && code <= 0x7a ? String.fromCharCode(code - 0x20) : value[offset];
  }
  return result;
}

function throwValidation(code: NamespaceErrorCode, input: string): never {
  throw new NamespaceError(code, { input });
}

/**
 * Canonicalize and validate one private display segment. The returned key is
 * derived from display NFC, so callers can compare keys without exposing a
 * name to the service.
 */
export function canonicalizeSegment(input: string): CanonicalSegment {
  const display = normalizeNfc(input);
  const invalid = validateDisplay(display);
  if (invalid) throwValidation(invalid, input);
  const keyText = normalizeNfc(defaultFullCaseFold(normalizeNfd(display)));
  return { display, comparisonKey: utf8Bytes(keyText) };
}

export const canonicalizeName = canonicalizeSegment;

export function validateSegment(input: string): SegmentValidationResult {
  try {
    return { valid: true, segment: canonicalizeSegment(input) };
  } catch (error) {
    if (error instanceof NamespaceError) return { valid: false, code: error.code };
    throw error;
  }
}

export function comparisonKey(input: string | CanonicalSegment): Bytes {
  return input && typeof input === "object"
    ? (new Uint8Array(input.comparisonKey) as Bytes)
    : canonicalizeSegment(input).comparisonKey;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function pathKey(segments: readonly CanonicalSegment[]): Bytes {
  const length =
    segments.reduce((total, segment) => total + segment.comparisonKey.length, 0) + Math.max(0, segments.length - 1);
  const bytes = new Uint8Array(length);
  let offset = 0;
  segments.forEach((segment, index) => {
    bytes.set(segment.comparisonKey, offset);
    offset += segment.comparisonKey.length;
    if (index + 1 < segments.length) bytes[offset++] = 0x2f;
  });
  return bytes as Bytes;
}

/** Split a relative source path before validating each component. */
export function splitSourcePath(sourcePath: string): readonly string[] {
  if (typeof sourcePath !== "string") throw new NamespaceError("invalid-source-path");
  if (!sourcePath.length) throw new NamespaceError("empty-source-component", { sourcePath });
  if (sourcePath.startsWith("/") || sourcePath.startsWith("\\") || /^[A-Za-z]:/.test(sourcePath)) {
    throw new NamespaceError("absolute-source-path", { sourcePath });
  }
  const components = sourcePath.split(/[\\/]/);
  if (components.some((component) => component.length === 0)) {
    throw new NamespaceError("empty-source-component", { sourcePath });
  }
  if (components.some((component) => component === "." || component === "..")) {
    throw new NamespaceError("traversing-source-path", { sourcePath });
  }
  return components.map((component) => canonicalizeSegment(component).display);
}

export const canonicalizeSourcePath = splitSourcePath;

function candidateName(requestedName: string, number: number): string {
  const dot = requestedName.lastIndexOf(".");
  const splitExtension = dot > 0 && dot < requestedName.length - 1;
  const base = splitExtension ? requestedName.slice(0, dot) : requestedName;
  const extension = splitExtension ? requestedName.slice(dot) : "";
  return `${base} (${number})${extension}`;
}

/** Build and validate one Keep-both candidate using the locked extension rule. */
export function keepBothCandidate(requestedName: string, number: number): CanonicalSegment {
  if (!Number.isSafeInteger(number) || number < 2) {
    throw new NamespaceError("generated-name-exhausted");
  }
  const candidate = candidateName(requestedName, number);
  try {
    return canonicalizeSegment(candidate);
  } catch (error) {
    if (error instanceof NamespaceError) {
      throw new NamespaceError("generated-name-invalid", {
        candidate,
        reason: error.code,
      });
    }
    throw error;
  }
}

function allocationOptions(
  optionsOrExisting: NameAllocationOptions | readonly string[],
  requests?: readonly NameRequest[],
): NameAllocationOptions {
  if (Array.isArray(optionsOrExisting)) {
    return { existingSiblingNames: optionsOrExisting, requests: requests ?? [] };
  }
  return optionsOrExisting as NameAllocationOptions;
}

/**
 * Allocate deterministic Keep-both names for one target Directory. Direct
 * source reservations are made before generated candidates, and generated
 * requests are processed by NFC source path then NFC requested display bytes.
 */
export function allocateKeepBothNames(options: NameAllocationOptions): readonly NameAllocation[];
export function allocateKeepBothNames(
  existingSiblingNames: readonly string[],
  requests: readonly NameRequest[],
): readonly NameAllocation[];
export function allocateKeepBothNames(
  optionsOrExisting: NameAllocationOptions | readonly string[],
  requests?: readonly NameRequest[],
): readonly NameAllocation[] {
  const options = allocationOptions(optionsOrExisting, requests);
  const existing = options.existingSiblingNames.map((name) => canonicalizeSegment(name));
  const existingKeys = new Map<string, Bytes>();
  for (const segment of existing) {
    const token = bytesToken(segment.comparisonKey);
    if (existingKeys.has(token)) throw new NamespaceError("existing-collision");
    existingKeys.set(token, segment.comparisonKey);
  }

  const prepared = options.requests.map((request, index) => {
    const pathSegments = splitSourcePath(request.sourcePath);
    const pathCanonical = pathSegments.map((segment) => canonicalizeSegment(segment));
    const requested = canonicalizeSegment(request.requestedName);
    return {
      index,
      sourcePath: pathSegments.join("/"),
      sourcePathBytes: utf8Bytes(pathSegments.join("/")),
      sourcePathKey: pathKey(pathCanonical),
      requested,
      requestedBytes: utf8Bytes(requested.display),
      requestedName: request.requestedName,
    };
  });

  const sourcePaths = new Map<string, number>();
  for (const item of prepared) {
    const token = bytesToken(item.sourcePathKey);
    if (sourcePaths.has(token)) throw new NamespaceError("duplicate-source-path", { sourcePath: item.sourcePath });
    sourcePaths.set(token, item.index);
  }

  const ordered = prepared
    .slice()
    .sort(
      (a, b) => compareBytes(a.sourcePathBytes, b.sourcePathBytes) || compareBytes(a.requestedBytes, b.requestedBytes),
    );
  const used = new Set(existingKeys.keys());
  const directReservations = new Set<string>();
  const directWinners = new Map<string, number>();
  for (const item of ordered) {
    const token = bytesToken(item.requested.comparisonKey);
    if (!used.has(token) && !directWinners.has(token)) {
      directWinners.set(token, item.index);
      directReservations.add(token);
    }
  }
  for (const token of directReservations) used.add(token);

  const allocations: Array<NameAllocation | undefined> = Array.from({ length: prepared.length });
  for (const item of prepared) {
    const token = bytesToken(item.requested.comparisonKey);
    if (directWinners.get(token) === item.index) {
      allocations[item.index] = {
        sourcePath: item.sourcePath,
        requestedName: item.requestedName,
        display: item.requested.display,
        comparisonKey: new Uint8Array(item.requested.comparisonKey) as Bytes,
        generated: false,
      };
    }
  }

  const generated = ordered.filter((item) => allocations[item.index] === undefined);
  for (const item of generated) {
    let number = 2;
    while (number <= Number.MAX_SAFE_INTEGER) {
      const candidate = keepBothCandidate(item.requested.display, number);
      const token = bytesToken(candidate.comparisonKey);
      if (!used.has(token)) {
        used.add(token);
        allocations[item.index] = {
          sourcePath: item.sourcePath,
          requestedName: item.requestedName,
          display: candidate.display,
          comparisonKey: new Uint8Array(candidate.comparisonKey) as Bytes,
          generated: true,
        };
        break;
      }
      number += 1;
    }
    if (!allocations[item.index]) throw new NamespaceError("generated-name-exhausted");
  }
  return allocations as readonly NameAllocation[];
}

export const allocateNames = allocateKeepBothNames;

function bytesToken(bytes: Uint8Array): string {
  let token = "";
  for (const byte of bytes) token += byte.toString(16).padStart(2, "0");
  return token;
}

export function sameComparisonKey(a: string | CanonicalSegment, b: string | CanonicalSegment): boolean {
  return equalBytes(comparisonKey(a), comparisonKey(b));
}

// Keep the version imports live so a generated/data-version mismatch is
// visible to both TypeScript and the runtime tests that consume this module.
void UCD_SOURCE_SHA256;
void UNICODE_VERSION;
