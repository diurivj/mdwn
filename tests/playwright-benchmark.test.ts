import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareRuns, comparisonMarkdown, redactFragments, summarizeRun } from "../scripts/lib/playwright-benchmark.mjs";

type Report = Parameters<typeof summarizeRun>[0];
const metadata = {
  commit: "a".repeat(40), sample: 1, exitCode: 0, setupMs: 30_000,
  environment: { source: "github-actions", platform: "linux", architecture: "x64", cpus: 2,
    availableCpus: 2, memoryBytes: 8 * 1024 ** 3, cpuModel: "fixture-cpu", node: "v24.21.0", image: "fixture-image" },
};
function report(workers = 1, duration = 1000): Report {
  return {
    config: { workers, version: "1.63.0", fullyParallel: false, shard: null,
      projects: [{ name: "webkit", retries: 1, repeatEach: 1, timeout: 30_000 }] },
    suites: [{ title: "fixture.spec.ts", specs: [], suites: [{ title: "nested", specs: [0, 1].map((index) => ({
      id: `case-${index}`, file: "fixture.spec.ts", title: `case ${index}`,
      tests: [{ projectName: "webkit", expectedStatus: "passed", status: "expected",
        results: [{ status: "passed", duration: 100, retry: 0, parallelIndex: index % workers }] }],
    })) }] }],
    errors: [], stats: { duration, expected: 2, unexpected: 0, flaky: 0, skipped: 0 },
  };
}
const cases = (source: Report) => source.suites[0].suites![0].specs;
const run = (workers: number, sample: number, duration = 1000) => summarizeRun(report(workers, duration), { ...metadata, sample });
const paired = () => [run(1, 1, 1200), run(2, 1, 600), run(1, 2, 1400), run(2, 2, 800)];

describe("benchmark measurements", () => {
  it("redacts fragments in absolute/relative URLs without hiding the navigation error", () => {
    const text = 'Navigation to "https://example.test/f/123#private-fragment" interrupted by "/d/456#other-fragment"';
    expect(redactFragments(text)).toBe('Navigation to "https://example.test/f/123#[redacted]" interrupted by "/d/456#[redacted]"');
    expect(redactFragments("https://example.test/path?query=1")).toBe("https://example.test/path?query=1");
    const source = report();
    cases(source)[0].title = text;
    expect(JSON.stringify(summarizeRun(source, metadata))).not.toContain("private-fragment");
  });

  it("captures nested cases and actual worker slots without carrying sensitive diagnostics", () => {
    const source = report(2);
    Object.assign(cases(source)[0].tests[0].results[0], {
      stdout: [{ text: "private-fixture-value" }], error: { message: "private-fixture-value" },
      attachments: [{ body: "private-fixture-value" }],
    });
    const measured = summarizeRun(source, metadata);
    expect(measured).toMatchObject({ workers: 2, actualWorkers: 2, total: 2, passed: 2, retries: 0, clean: true });
    expect(measured.tests.map((test) => test.durationMs)).toEqual([100, 100]);
    expect(JSON.stringify(measured)).not.toContain("private-fixture-value");
    cases(source).reverse();
    expect(summarizeRun(source, metadata).testSetHash).toBe(measured.testSetHash);
  });

  it("retains retry cost and marks a passing-on-retry run unreliable", () => {
    const source = report();
    const test = cases(source)[0].tests[0];
    test.status = "flaky";
    test.results[0].status = "failed";
    test.results.push({ status: "passed", duration: 200, retry: 1, parallelIndex: 0 });
    source.stats.expected = 1;
    source.stats.flaky = 1;
    const measured = summarizeRun(source, metadata);
    expect(measured).toMatchObject({ flaky: 1, retries: 1, clean: false });
    expect(measured.tests[0].durationMs).toBe(300);
  });

  it.each(["failed", "timedOut", "interrupted"])("marks %s attempts unreliable", (status) => {
    const source = report();
    cases(source)[0].tests[0].status = "unexpected";
    cases(source)[0].tests[0].results[0].status = status;
    source.stats.expected = 1;
    source.stats.unexpected = 1;
    expect(summarizeRun(source, { ...metadata, exitCode: 1 }).clean).toBe(false);
  });

  it("does not accept skipped, expected-failure, teardown-error, or underused-worker runs", () => {
    const skipped = report();
    cases(skipped)[0].tests[0].status = "skipped";
    cases(skipped)[0].tests[0].results = [];
    skipped.stats.expected = 1;
    skipped.stats.skipped = 1;
    expect(summarizeRun(skipped, metadata).clean).toBe(false);
    const expectedFailure = report();
    cases(expectedFailure)[0].tests[0].expectedStatus = "failed";
    cases(expectedFailure)[0].tests[0].results[0].status = "failed";
    expect(summarizeRun(expectedFailure, metadata).clean).toBe(false);
    const error = report();
    error.errors.push({ message: "secret teardown details" });
    expect(summarizeRun(error, metadata)).toMatchObject({ errors: 1, clean: false });
    expect(JSON.stringify(summarizeRun(error, metadata))).not.toContain("secret teardown details");
    const underused = report(2);
    cases(underused)[1].tests[0].results[0].parallelIndex = 0;
    expect(summarizeRun(underused, metadata)).toMatchObject({ actualWorkers: 1, clean: false });
  });

  it("rejects empty/duplicate test sets, shards, repeat-each, invalid counts, and multiple engines", () => {
    const empty = report(); empty.suites = [];
    expect(() => summarizeRun(empty, metadata)).toThrow(/nonempty/);
    const duplicate = report(); cases(duplicate)[1].id = cases(duplicate)[0].id;
    expect(() => summarizeRun(duplicate, metadata)).toThrow(/unambiguous/);
    const sharded = report(); sharded.config.shard = { current: 1, total: 2 };
    expect(() => summarizeRun(sharded, metadata)).toThrow(/unsharded/);
    const repeated = report(); repeated.config.projects[0].repeatEach = 2;
    expect(() => summarizeRun(repeated, metadata)).toThrow(/repeat-each/);
    const incomplete = report(); incomplete.stats.expected = 1;
    expect(() => summarizeRun(incomplete, metadata)).toThrow(/Incomplete/);
    const multiple = report(); cases(multiple)[1].tests[0].projectName = "firefox";
    expect(() => summarizeRun(multiple, metadata)).toThrow(/exactly one/);
    expect(() => summarizeRun(report(3), metadata)).toThrow(/one or two workers/);
  });
});

describe("paired comparison", () => {
  it("cannot claim a speedup from four equally incomplete reports", () => {
    const incomplete = paired().map(({ version, sample, workers, durationMs, clean }) => ({
      version, sample, workers, durationMs, clean, environment: { source: "github-actions" },
    }));
    const result = compareRuns(incomplete);
    expect(result.comparison).toBeNull();
    expect(comparisonMarkdown(result)).toContain("Inconclusive");
  });

  it("requires every stored metadata and test-evidence field, even when all samples omit it", () => {
    const required = [
      "version", "commit", "sample", "exitCode", "setupMs", "project", "playwright", "workers", "actualWorkers",
      "testSetHash", "total", "passed", "failed", "flaky", "skipped", "errors", "retries", "durationMs", "clean", "tests",
      "policy", "policy.retries", "policy.repeatEach", "policy.timeout", "policy.fullyParallel",
      "environment", "environment.source", "environment.platform", "environment.architecture", "environment.cpus",
      "environment.availableCpus", "environment.memoryBytes", "environment.cpuModel", "environment.node", "environment.image",
      "tests.0.id", "tests.0.file", "tests.0.title", "tests.0.project", "tests.0.expectedStatus",
      "tests.0.outcome", "tests.0.attempts", "tests.0.durationMs",
    ];
    for (const path of required) {
      const runs = structuredClone(paired());
      const parts = path.split(".");
      for (const run of runs) {
        let parent: object = run;
        for (const part of parts.slice(0, -1)) parent = Reflect.get(parent, part);
        Reflect.deleteProperty(parent, parts.at(-1)!);
      }
      expect(compareRuns(runs).comparison, path).toBeNull();
    }
    expect(compareRuns([null, "not a report", {}, []]).comparison).toBeNull();
  });

  it("validates counts, fingerprints, types, and cleanliness instead of trusting stored clean flags", () => {
    const badCount = paired(); badCount[0].passed = 0;
    expect(compareRuns(badCount).comparison).toBeNull();
    const badHash = paired(); badHash.forEach((run) => { run.testSetHash = "b".repeat(64); });
    expect(compareRuns(badHash).comparison).toBeNull();
    const exitFailure = paired(); exitFailure[0].exitCode = 7;
    expect(compareRuns(exitFailure).comparison).toBeNull();
    const wrongType = structuredClone(paired()); Reflect.set(wrongType[0].environment, "cpus", "2");
    expect(compareRuns(wrongType).comparison).toBeNull();
    const badDuration = paired(); badDuration[0].tests[0].durationMs = -1;
    expect(compareRuns(badDuration).comparison).toBeNull();
  });

  it("reports all samples and medians without turning a pilot into an adoption decision", () => {
    const result = compareRuns(paired());
    expect(result.issues).toEqual([]);
    expect(result.comparison).toMatchObject({ oneMedianMs: 1300, twoMedianMs: 700 });
    expect(result.comparison?.reductionPercent).toBeCloseTo(46.1538);
    expect(result.pairs).toHaveLength(2);
    expect(comparisonMarkdown(result)).toContain("Clean pilot only");
  });

  it("refuses missing/duplicate samples and never drops an unreliable result", () => {
    expect(compareRuns(paired().slice(0, 3)).comparison).toBeNull();
    const duplicate = paired(); duplicate[3] = duplicate[1];
    expect(compareRuns(duplicate).comparison).toBeNull();
    const failed = paired(); failed[3].clean = false;
    const result = compareRuns(failed);
    expect(result.runs).toHaveLength(4);
    expect(result.comparison).toBeNull();
    expect(comparisonMarkdown(result)).toContain("Inconclusive");
    expect(() => compareRuns(paired().slice(0, 2), 1)).toThrow(/at least two/);
  });

  it.each(["commit", "project", "playwright", "testSetHash"] as const)("rejects mismatched %s", (key) => {
    const runs = paired(); runs[3][key] = "different";
    expect(compareRuns(runs).comparison).toBeNull();
  });

  it("rejects different coverage, retry policy, hardware, and local-only timing evidence", () => {
    const coverage = paired(); coverage[3].total++;
    expect(compareRuns(coverage).comparison).toBeNull();
    const policy = paired(); policy[3].policy.retries = 0;
    expect(compareRuns(policy).comparison).toBeNull();
    const hardware = paired(); hardware[3].environment = { ...metadata.environment, cpus: 4 };
    expect(compareRuns(hardware).comparison).toBeNull();
    const local = paired(); local[3].environment = { ...metadata.environment, source: "local" };
    expect(compareRuns(local).comparison).toBeNull();
  });
});

describe("workflow failure propagation", () => {
  it.each([
    [7, 0, 1, 7], [143, 0, 1, 143], [7, 8, 9, 7], [7, 0, 0, 7],
    [0, 8, 1, 8], [0, 0, 9, 9], [0, 0, 0, 0],
  ])("test=%i redactor=%i recorder=%i exits %i", (testCode, redactorCode, recorderCode, expectedCode) => {
    const workflow = readFileSync(new URL("../.github/workflows/playwright-workers-benchmark.yml", import.meta.url), "utf8");
    const start = workflow.indexOf('          statuses=("${PIPESTATUS[@]}")');
    const end = workflow.indexOf("      - name: Upload measurements and diagnostics", start);
    if (start < 0 || end < 0) throw new Error("Cannot locate the workflow's exit-handling block");
    const block = workflow.slice(start, end).replace(/^          /gm, "");
    const directory = mkdtempSync(join(tmpdir(), "mdwn-benchmark-exit-"));
    try {
      mkdirSync(join(directory, "scripts"));
      writeFileSync(join(directory, "scripts/playwright-benchmark.mjs"), `process.exit(${recorderCode});\n`);
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c",
        `set +e\n(exit ${testCode}) | (exit ${redactorCode})\n${block}`], {
        cwd: directory, env: { ...process.env, BENCHMARK_SAMPLE: "1" }, encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(expectedCode);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
