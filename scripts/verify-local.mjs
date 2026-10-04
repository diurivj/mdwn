#!/usr/bin/env node
/**
 * Local merge gate while the GitHub `ci` workflow is paused (AGENTS.md,
 * "Merge discipline"). Runs every check from .github/workflows/ci.yml, in the
 * same order, against the checked-out commit, and stops at the first failure:
 *
 *   typecheck → namespace drift → Node + Workers tests → production build →
 *   fresh-D1 migration smoke → bundle secret check → Chromium/Firefox/WebKit
 *
 * The non-browser steps run with CI=true, as on GitHub, so Vitest refuses
 * `.only`. The browser suite keeps Playwright's local worker default but
 * passes --forbid-only, and has no retry, so a flake fails here instead of
 * passing on a second attempt.
 *
 * The result only counts for a merge when the tree is clean and HEAD contains
 * origin/main: GitHub tested the PR merged with main, so a branch behind main
 * is not what would land. Both are checked before anything runs.
 *
 *   npm run verify           # the merge gate
 *   npm run verify -- --wip  # same checks on a dirty or stale tree; not a gate
 */
import { spawnSync } from "node:child_process";

const CI_NODE_MAJOR = 24; // actions/setup-node in ci.yml
const wip = process.argv.includes("--wip");

const STEPS = [
  ["Typecheck", "npm", ["run", "typecheck"]],
  ["Unicode namespace data drift check", "npm", ["run", "check:namespace"]],
  ["Unit and Workers tests", "npm", ["test"]],
  ["Production build", "npm", ["run", "build"]],
  ["D1 migration smoke test (fresh local D1)", "npm", ["run", "db:smoke"]],
  ["Secret-leak check on client bundle", "npm", ["run", "check:secrets"]],
  ["Browser tests (chromium, firefox, webkit)", "npx", ["playwright", "test", "--forbid-only"], { browser: true }],
];

/** @param {string[]} args */
function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
}

function treeProblems() {
  const problems = [];
  if (git(["status", "--porcelain"]).out !== "") problems.push("the working tree has uncommitted or untracked changes");
  if (!git(["fetch", "--quiet", "origin", "main"]).ok) {
    problems.push("could not fetch origin/main");
  } else if (!git(["merge-base", "--is-ancestor", "origin/main", "HEAD"]).ok) {
    problems.push("HEAD does not contain origin/main; merge or rebase main first");
  }
  return problems;
}

/** @param {number} ms */
function duration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

const head = git(["rev-parse", "HEAD"]).out;
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).out;

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor !== CI_NODE_MAJOR) {
  console.warn(`⚠ Node ${process.versions.node}; CI uses Node ${CI_NODE_MAJOR}`);
}

const before = treeProblems();
if (before.length > 0 && !wip) {
  console.error("✘ Not a gate run:");
  for (const problem of before) console.error(`  - ${problem}`);
  console.error("Fix the above, or pass --wip to run the checks anyway without a gate result.");
  process.exit(1);
}

/** @type {Array<[string, number]>} */
const timings = [];
for (const [name, command, args, options] of STEPS) {
  console.log(`\n▶ ${name}`);
  const env = { ...process.env, CI: "true" };
  if (options?.browser) delete env.CI;
  const started = Date.now();
  const result = spawnSync(command, args, { stdio: "inherit", env });
  timings.push([name, Date.now() - started]);
  if (result.status !== 0) {
    console.error(`\n✘ ${name} failed at ${head} (${branch})`);
    process.exit(result.status ?? 1);
  }
}

console.log("\nSummary");
for (const [name, ms] of timings) console.log(`  ✔ ${name} (${duration(ms)})`);

const unchanged = git(["rev-parse", "HEAD"]).out === head && git(["status", "--porcelain"]).out === "";
if (wip) {
  console.log(`\n✔ Checks passed at ${head} (${branch}) — --wip run, not a merge gate result`);
} else if (!unchanged) {
  console.error(`\n✘ Checks passed, but HEAD or the working tree changed during the run; re-run the gate`);
  process.exit(1);
} else {
  console.log(`\n✔ Local verification gate passed at ${head} (${branch})`);
}
