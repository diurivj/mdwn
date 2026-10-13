#!/usr/bin/env node
import { accessSync, constants, realpathSync } from "node:fs";
import { arch } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

const workspace = realpathSync(process.cwd());
const work = realpathSync(resolve(workspace, "../.."));
const paths = {
  workspace,
  toolCache: process.env.RUNNER_TOOL_CACHE,
  runnerTemp: process.env.RUNNER_TEMP,
  npmCache: process.env.NPM_CONFIG_CACHE,
  browsers: process.env.PLAYWRIGHT_BROWSERS_PATH,
  temp: process.env.TMPDIR,
};
console.log(
  JSON.stringify(
    {
      runner: process.env.RUNNER_NAME,
      run: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      sha: process.env.GITHUB_SHA,
      arch: arch(),
      node: process.version,
      paths,
      workers: { playwright: 1, nodeVitest: 2, workersVitest: 2 },
    },
    null,
    2,
  ),
);

if (process.env.GITHUB_ACTIONS === "true") {
  if (arch() !== "arm64") throw new Error("CI must execute natively on ARM64");
  for (const [name, path] of Object.entries(paths)) {
    if (!path || !isAbsolute(path)) throw new Error(`${name} must be an absolute slot path`);
    accessSync(path, constants.W_OK);
  }
  for (const [name, path] of [
    ["toolCache", paths.toolCache],
    ["runnerTemp", paths.runnerTemp],
  ]) {
    const child = relative(work, realpathSync(path ?? ""));
    if (!child || child.startsWith("..") || isAbsolute(child)) {
      throw new Error(`${name} must resolve inside the slot workspace root`);
    }
  }
  // These values come from the nonsecret service configuration, never a job-wide
  // HOME override. Registration directories remain independent host resources.
  const state = process.env.MDWN_CI_SLOT_STATE;
  if (!state || !isAbsolute(state)) throw new Error("MDWN_CI_SLOT_STATE must identify this slot's state directory");
  for (const [name, path] of [
    ["npmCache", paths.npmCache],
    ["browsers", paths.browsers],
    ["temp", paths.temp],
  ]) {
    const child = relative(realpathSync(state), realpathSync(path ?? ""));
    if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error(`${name} escapes the slot state`);
  }
}
