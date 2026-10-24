import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { assertWorkspaceWranglerHome, deployScratchRoot } from "../scripts/lib/deploy-host.mjs";

test("deploy scratch prefers the job workspace over the runner temp directory", () => {
  expect(deployScratchRoot({ GITHUB_WORKSPACE: "/work", RUNNER_TEMP: "/runner-temp" })).toBe("/work");
  expect(deployScratchRoot({ RUNNER_TEMP: "/runner-temp" })).toBe("/runner-temp");
  expect(deployScratchRoot({})).toBe(tmpdir());
});

test("the worker deploy script creates its secrets file from that scratch root", () => {
  const source = readFileSync(new URL("../scripts/deploy-worker.mjs", import.meta.url), "utf8");
  expect(source).toContain("deployScratchRoot()");
  expect(source).not.toContain("RUNNER_TEMP || tmpdir()");
});

function containedLayout() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mdwn-deploy-host-")));
  const account = join(root, "account");
  const workspace = join(account, "work");
  const wrangler = join(workspace, ".deploy-wrangler-home");
  mkdirSync(join(wrangler, ".config"), { recursive: true });
  mkdirSync(join(wrangler, ".cache"), { recursive: true });
  mkdirSync(join(wrangler, "tmp"), { recursive: true });
  const env = {
    GITHUB_WORKSPACE: workspace,
    MDWN_ACCOUNT_HOME: account,
    HOME: wrangler,
    XDG_CONFIG_HOME: join(wrangler, ".config"),
    XDG_CACHE_HOME: join(wrangler, ".cache"),
    TMPDIR: join(wrangler, "tmp"),
    WRANGLER_LOG_PATH: join(wrangler, "wrangler.log"),
    WRANGLER_WRITE_LOGS: "false",
  };
  return { root, account, workspace, wrangler, env };
}

test("a workspace-local Wrangler home passes", () => {
  const { wrangler, env } = containedLayout();
  expect(() => assertWorkspaceWranglerHome(env, wrangler)).not.toThrow();
});

test("the deploy check command resolves the process home", () => {
  const { account, env } = containedLayout();
  const script = fileURLToPath(new URL("../scripts/check-deploy-workspace-home.mjs", import.meta.url));
  const accepted = spawnSync(process.execPath, [script], { env: { ...process.env, ...env }, encoding: "utf8" });
  expect(accepted.status).toBe(0);
  const refused = spawnSync(process.execPath, [script], {
    env: { ...process.env, ...env, HOME: account },
    encoding: "utf8",
  });
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain("Wrangler home must stay inside the job workspace");
});

test("disk logs and an account-home Wrangler directory are refused", () => {
  const { account, wrangler, env } = containedLayout();
  expect(() => assertWorkspaceWranglerHome({ ...env, WRANGLER_WRITE_LOGS: "true" }, wrangler)).toThrow(
    /WRANGLER_WRITE_LOGS must be false/,
  );
  expect(() => assertWorkspaceWranglerHome({ ...env, HOME: account }, account)).toThrow(
    /Wrangler home must stay inside the job workspace/,
  );
});

test("config, temp, and log paths outside the workspace are refused", () => {
  const { root, wrangler, env } = containedLayout();
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  expect(() => assertWorkspaceWranglerHome({ ...env, XDG_CONFIG_HOME: outside }, wrangler)).toThrow(
    /must stay inside the job workspace/,
  );
  expect(() => assertWorkspaceWranglerHome({ ...env, TMPDIR: outside }, wrangler)).toThrow(
    /must stay inside the job workspace/,
  );
  expect(() =>
    assertWorkspaceWranglerHome({ ...env, WRANGLER_LOG_PATH: join(outside, "wrangler.log") }, wrangler),
  ).toThrow(/must stay inside the job workspace/);
});

test("the recorded account home cannot be the workspace", () => {
  const { workspace, wrangler, env } = containedLayout();
  expect(() => assertWorkspaceWranglerHome({ ...env, MDWN_ACCOUNT_HOME: workspace }, wrangler)).toThrow(
    /account home must stay outside the job workspace/,
  );
});
