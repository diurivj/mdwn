#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { executionIntervals, lastJobCompletion } from "./lib/ci-timing.mjs";

const [repository, runId, attempt, output] = process.argv.slice(2);
if (
  !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
  !/^\d+$/.test(runId ?? "") ||
  !/^\d+$/.test(attempt ?? "") ||
  !output
) {
  throw new Error("Usage: node scripts/collect-ci-timing.mjs owner/repo run-id attempt evidence-directory");
}
/** @param {string} endpoint */
function api(endpoint) {
  return JSON.parse(execFileSync("gh", ["api", endpoint], { encoding: "utf8" }));
}
const workflow = api(`repos/${repository}/actions/runs/${runId}/attempts/${attempt}`);
if (workflow.status !== "completed")
  throw new Error("Collect a completed attempt, including its terminal job timestamps");
const jobs = [];
for (let page = 1; ; page++) {
  const batch = api(
    `repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
  ).jobs;
  jobs.push(...batch);
  if (batch.length < 100) break;
}
const intervals = executionIntervals(jobs);
const completed = lastJobCompletion(jobs);
const requested = Date.parse(workflow.run_started_at ?? workflow.created_at);
// updated_at can include subsequent metadata changes. Completion is the last
// terminal job timestamp, not the workflow's update timestamp.
const summary = {
  repository,
  runId,
  attempt,
  sha: workflow.head_sha,
  url: workflow.html_url,
  conclusion: workflow.conclusion,
  ...intervals,
  workflowCompleted: completed,
  turnaroundSeconds: completed === null ? null : (completed - requested) / 1000,
  initialDispatchWaitSeconds: intervals.firstStart === null ? null : (intervals.firstStart - requested) / 1000,
  executionSpanSeconds:
    intervals.lastFinish === null || intervals.firstStart === null
      ? null
      : (intervals.lastFinish - intervals.firstStart) / 1000,
  jobs: jobs.map((job) => ({
    id: job.id,
    name: job.name,
    runnerId: job.runner_id,
    runnerName: job.runner_name,
    conclusion: job.conclusion,
    created: job.created_at,
    started: job.runner_id === 0 ? null : job.started_at,
    completed: job.completed_at,
    executionSeconds:
      job.runner_id === 0
        ? 0
        : job.started_at && job.completed_at
          ? (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000
          : null,
    steps: job.steps,
  })),
};
mkdirSync(resolve(output), { recursive: true });
for (const [suffix, data] of [
  ["workflow", workflow],
  ["jobs", jobs],
  ["timing", summary],
]) {
  writeFileSync(resolve(output, `${runId}-${attempt}-${suffix}.json`), `${JSON.stringify(data, null, 2)}\n`);
}
console.log(JSON.stringify(summary, null, 2));
