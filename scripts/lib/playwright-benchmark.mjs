import { createHash } from "node:crypto";

/** @typedef {{status?: string, duration: number, retry: number, parallelIndex: number}} Attempt */
/** @typedef {{projectName: string, expectedStatus: string, status: string, results: Attempt[]}} Case */
/** @typedef {{id: string, file: string, title: string, tests: Case[]}} Spec */
/** @typedef {{title: string, specs: Spec[], suites?: Suite[]}} Suite */
/** @typedef {{config: {workers: number, version: string, fullyParallel: boolean, shard: unknown,
 * projects: {name: string, retries: number, repeatEach: number, timeout: number}[]},
 * suites: Suite[], errors: unknown[], stats: {duration: number, expected: number,
 * unexpected: number, flaky: number, skipped: number}}} SourceReport */
/** @typedef {{source: string, platform: string, architecture: string, cpus: number,
 * availableCpus: number, memoryBytes: number, cpuModel: string, node: string, image: string}} Environment */
/** @typedef {{commit: string, sample: number, exitCode: number, environment: Environment, setupMs: number | null}} Metadata */

/** @param {Suite[]} suites @returns {Spec[]} */
function specsIn(suites) {
  return suites.flatMap((suite) => [...suite.specs, ...specsIn(suite.suites ?? [])]);
}

/** Redact absolute and relative URL fragments before printing browser diagnostics.
 * @param {string} text */
export function redactFragments(text) {
  return text.replace(/(https?:\/\/[^\s"'<>#]+|\/[^\s"'<>#]+)#[^\s"'<>]*/gu, "$1#[redacted]");
}

/** @param {{id: string, expectedStatus: string}[]} tests */
function testSetHash(tests) {
  const sorted = [...tests].sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify(sorted.map((test) => [test.id, test.expectedStatus]))).digest("hex");
}

/** Whitelist performance fields: never carry test stdout, errors, request URLs,
 * attachment bodies, or other fixture secrets into the comparison summary.
 * @param {SourceReport} report @param {Metadata} metadata */
export function summarizeRun(report, metadata) {
  if (!/^[0-9a-f]{40}$/.test(metadata.commit) || !Number.isInteger(metadata.sample) || metadata.sample < 1 ||
      !Number.isInteger(metadata.exitCode) || metadata.exitCode < 0 || ![1, 2].includes(report.config.workers)) {
    throw new Error("Benchmark requires a pinned commit, positive sample, exit code, and one or two workers");
  }
  const tests = specsIn(report.suites).flatMap((spec) => spec.tests.map((test) => ({
    id: `${spec.id}:${test.projectName}`, file: redactFragments(spec.file), title: redactFragments(spec.title),
    project: test.projectName, expectedStatus: test.expectedStatus, outcome: test.status,
    attempts: test.results.length,
    durationMs: test.results.reduce((sum, result) => sum + result.duration, 0),
    clean: test.expectedStatus === "passed" && test.status === "expected" && test.results.length === 1 &&
      test.results[0].status === "passed" && test.results[0].retry === 0,
    slots: [...new Set(test.results.map((result) => result.parallelIndex))],
  }))).sort((a, b) => a.id.localeCompare(b.id));
  if (!tests.length || new Set(tests.map((test) => test.id)).size !== tests.length) {
    throw new Error("Benchmark requires a nonempty, unambiguous test set");
  }
  const projects = new Set(tests.map((test) => test.project));
  const project = report.config.projects.find((project) => project.name === tests[0].project);
  if (projects.size !== 1 || !project || report.config.shard !== null || project.repeatEach !== 1) {
    throw new Error("Benchmark must run exactly one unsharded browser project without repeat-each");
  }
  const counts = report.stats;
  if (![counts.duration, counts.expected, counts.unexpected, counts.flaky, counts.skipped,
    ...tests.map((test) => test.durationMs)].every((n) => Number.isFinite(n) && n >= 0) || counts.duration <= 0 ||
      counts.expected + counts.unexpected + counts.flaky + counts.skipped !== tests.length) {
    throw new Error("Incomplete or invalid Playwright timing/count data");
  }
  const actualWorkers = new Set(tests.flatMap((test) => test.slots)).size;
  return {
    version: 1, ...metadata, project: project.name, playwright: report.config.version,
    policy: { retries: project.retries, repeatEach: project.repeatEach, timeout: project.timeout,
      fullyParallel: report.config.fullyParallel },
    workers: report.config.workers, actualWorkers,
    testSetHash: testSetHash(tests),
    total: tests.length, passed: counts.expected, failed: counts.unexpected, flaky: counts.flaky,
    skipped: counts.skipped, errors: report.errors.length,
    retries: tests.reduce((sum, test) => sum + Math.max(0, test.attempts - 1), 0),
    durationMs: counts.duration,
    clean: metadata.exitCode === 0 && report.errors.length === 0 && tests.every((test) => test.clean) &&
      counts.expected === tests.length && actualWorkers === report.config.workers,
    tests: tests.map(({ slots, clean, ...test }) => test),
  };
}

/** @typedef {ReturnType<typeof summarizeRun>} Run */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} value @returns {value is string} */
const isText = (value) => typeof value === "string" && value.trim().length > 0;
/** @param {unknown} value @returns {value is number} */
const isCount = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** @param {unknown} value @returns {value is number} */
const isDuration = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
/** @param {unknown} value @returns {value is Run['tests'][number]} */
function isStoredTest(value) {
  return isRecord(value) && ["id", "file", "title", "project"].every((key) => isText(value[key])) &&
    isText(value.expectedStatus) && ["passed", "failed", "timedOut", "skipped", "interrupted"].includes(value.expectedStatus) &&
    isText(value.outcome) && ["expected", "unexpected", "flaky", "skipped"].includes(value.outcome) &&
    isCount(value.attempts) && isDuration(value.durationMs);
}

/** Stored JSON is an input boundary, not a trusted Run merely because clean=true.
 * Validate required fields and cross-check the saved counters/fingerprint.
 * @param {unknown} value @returns {value is Run} */
function isStoredRun(value) {
  if (!isRecord(value) || !isRecord(value.environment) || !isRecord(value.policy) ||
      !Array.isArray(value.tests) || !value.tests.every(isStoredTest) || !value.tests.length) return false;
  const { environment, policy, tests } = value;
  if (value.version !== 1 || !isText(value.commit) || !/^[0-9a-f]{40}$/.test(value.commit) ||
      !isCount(value.sample) || value.sample < 1 || !isCount(value.exitCode) || value.exitCode > 255 ||
      (value.setupMs !== null && !isDuration(value.setupMs)) ||
      !isText(value.project) || !["chromium", "firefox", "webkit"].includes(value.project) ||
      !isText(value.playwright) || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(value.playwright) ||
      !isCount(value.workers) || ![1, 2].includes(value.workers) || !isCount(value.actualWorkers) || value.actualWorkers > value.workers ||
      !isDuration(value.durationMs) || value.durationMs === 0 || typeof value.clean !== "boolean" ||
      !isCount(value.errors) || !isCount(value.retries) || value.total !== tests.length) return false;
  if (!["source", "platform", "architecture", "cpuModel", "node", "image"].every((key) => isText(environment[key])) ||
      !["github-actions", "local"].includes(String(environment.source)) || environment.cpuModel === "unknown" ||
      !/^v\d+\.\d+\.\d+(?:[-+].+)?$/.test(String(environment.node)) ||
      !["cpus", "availableCpus", "memoryBytes"].every((key) => isCount(environment[key]) && environment[key] > 0) ||
      !isCount(policy.retries) || policy.repeatEach !== 1 || !isDuration(policy.timeout) || typeof policy.fullyParallel !== "boolean") return false;
  return new Set(tests.map((test) => test.id)).size === tests.length &&
    tests.every((test) => test.project === value.project) && value.testSetHash === testSetHash(tests) &&
    [["passed", "expected"], ["failed", "unexpected"], ["flaky", "flaky"], ["skipped", "skipped"]].every(
      ([field, outcome]) => value[field] === tests.filter((test) => test.outcome === outcome).length) &&
    value.retries === tests.reduce((sum, test) => sum + Math.max(0, test.attempts - 1), 0);
}

/** @param {number[]} values */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Never silently drop failed or missing samples to manufacture a speedup.
 * Two samples per configuration are a pilot, not proof sufficient for adoption.
 * @param {unknown[]} reports @param {number} [samples] */
export function compareRuns(reports, samples = 2) {
  if (!Number.isInteger(samples) || samples < 2) throw new Error("Compare at least two samples per worker count");
  const issues = [];
  /** @type {Run[]} */
  const runs = [];
  for (const [index, report] of reports.entries()) {
    if (isStoredRun(report)) runs.push(report);
    else issues.push(`Report ${index + 1} has incomplete or inconsistent metadata/evidence; excluded from the table, not from the verdict.`);
  }
  const baseline = runs[0];
  if (reports.length !== samples * 2) issues.push(`Expected ${samples * 2} reports; received ${reports.length}.`);
  for (let sample = 1; sample <= samples; sample++) {
    for (const workers of [1, 2]) {
      if (runs.filter((run) => run.sample === sample && run.workers === workers).length !== 1) {
        issues.push(`Need exactly one sample ${sample} with ${workers} worker(s).`);
      }
    }
  }
  for (const run of runs) {
    if (!run.clean || run.exitCode !== 0 || run.errors !== 0 || run.passed !== run.total || run.actualWorkers !== run.workers ||
        !run.tests.every((test) => test.expectedStatus === "passed" && test.attempts === 1)) {
      issues.push(`Sample ${run.sample}/${run.workers} is not a complete, clean run; inspect its diagnostics.`);
    }
    if (run.environment.source !== "github-actions") issues.push("Local runs are smoke checks, not GitHub performance evidence.");
    if (baseline && ["commit", "project", "playwright", "testSetHash", "total"].some((key) =>
      Reflect.get(run, key) !== Reflect.get(baseline, key))) issues.push("Commit, browser/version, or test coverage differs.");
    if (baseline && JSON.stringify(run.policy) !== JSON.stringify(baseline.policy)) issues.push("Test execution policy differs.");
    if (baseline && JSON.stringify(run.environment) !== JSON.stringify(baseline.environment)) issues.push("Runner environment differs; compare like-for-like hardware/runtime.");
  }
  const pairs = Array.from({ length: samples }, (_, index) => {
    const one = runs.find((run) => run.sample === index + 1 && run.workers === 1);
    const two = runs.find((run) => run.sample === index + 1 && run.workers === 2);
    return { sample: index + 1, oneMs: one?.durationMs ?? null, twoMs: two?.durationMs ?? null };
  });
  const one = runs.filter((run) => run.workers === 1).map((run) => run.durationMs);
  const two = runs.filter((run) => run.workers === 2).map((run) => run.durationMs);
  return { runs, pairs, issues: [...new Set(issues)], comparison: issues.length ? null : {
    oneMedianMs: median(one), twoMedianMs: median(two),
    reductionPercent: (1 - median(two) / median(one)) * 100,
  } };
}

/** @param {ReturnType<typeof compareRuns>} result */
export function comparisonMarkdown(result) {
  const lines = ["# Playwright worker-count pilot", "",
    "| Sample | Workers | Tests | Failed | Flaky | Skipped | Retries | Test minutes | Setup minutes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const run of [...result.runs].sort((a, b) => a.sample - b.sample || a.workers - b.workers)) {
    lines.push(`| ${run.sample} | ${run.workers} | ${run.total} | ${run.failed} | ${run.flaky} | ${run.skipped} | ${run.retries} | ${(run.durationMs / 60_000).toFixed(2)} | ${run.setupMs === null ? "n/a" : (run.setupMs / 60_000).toFixed(2)} |`);
  }
  lines.push("");
  if (!result.comparison) lines.push("**Inconclusive:**", ...result.issues.map((issue) => `- ${issue}`));
  else lines.push(`Two-worker median test-time reduction: **${result.comparison.reductionPercent.toFixed(1)}%** (negative means slower).`,
    "", "Clean pilot only: review individual samples/resource reports, then validate other engines before proposing adoption.");
  lines.push("", "Per-test/spec timings and runner metadata are in each run.json. GNU time diagnostics are in resources.txt; max RSS is not the sum of simultaneous child-process memory.");
  return `${lines.join("\n")}\n`;
}
