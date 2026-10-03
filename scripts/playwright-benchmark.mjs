import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { arch, availableParallelism, cpus, platform, release, totalmem } from "node:os";
import { compareRuns, comparisonMarkdown, redactFragments, summarizeRun } from "./lib/playwright-benchmark.mjs";

/** @param {string} path */
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
/** @param {string} path @param {unknown} value */
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
/** @param {string} directory @returns {string[]} */
function reportsIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? reportsIn(path) : entry.name === "run.json" ? [path] : [];
  });
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "record" && args.length === 4) {
    const [source, destination, sample, exitCode] = args;
    const report = readJson(source);
    const setupStart = process.env.BENCHMARK_SETUP_STARTED;
    const setupMs = setupStart === undefined ? null : Date.parse(report.stats.startTime) - Number(setupStart) * 1000;
    if (setupMs !== null && (!Number.isFinite(setupMs) || setupMs < 0)) throw new Error("Invalid setup start time");
    const run = summarizeRun(report, {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      sample: Number(sample), exitCode: Number(exitCode), setupMs,
      environment: {
        source: process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "local",
        platform: platform(), architecture: arch(), cpus: cpus().length,
        availableCpus: availableParallelism(), memoryBytes: totalmem(),
        cpuModel: cpus()[0]?.model ?? "unknown", node: process.version,
        image: `${process.env.ImageOS ?? platform()}/${process.env.ImageVersion ?? release()}`,
      },
    });
    writeJson(destination, run);
    console.log(`Sample ${run.sample}, ${run.workers} worker(s): ${run.total} tests, ${(run.durationMs / 60_000).toFixed(2)} test minutes; clean=${run.clean}.`);
  } else if (command === "compare" && args.length >= 1 && args.length <= 2) {
    const [directory, samples = "2"] = args;
    const result = compareRuns(reportsIn(directory).map(readJson), Number(samples));
    writeJson(join(directory, "comparison.json"), result);
    const markdown = comparisonMarkdown(result);
    writeFileSync(join(directory, "comparison.md"), markdown);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    console.log(markdown);
    if (!result.comparison) process.exitCode = 2;
  } else if (command === "redact" && args.length === 0) {
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) console.log(redactFragments(line));
  } else {
    throw new Error("Usage: playwright-benchmark.mjs record <playwright.json> <run.json> <sample> <exit-code> | compare <artifacts-dir> [samples=2] | redact");
  }
} catch (error) {
  console.error(error instanceof SyntaxError ? "Invalid or incomplete JSON report" : error instanceof Error ? error.message : "Benchmark reporting failed");
  process.exitCode = 1;
}
