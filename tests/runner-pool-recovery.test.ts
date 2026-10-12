import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

function controller(
  command: "start" | "stop" | "service",
  busy: boolean,
  dualDomains = false,
  loaded = true,
  firstInstall = false,
) {
  const root = mkdtempSync(join(tmpdir(), "mdwn-pool-recovery-"));
  const directory = join(root, "ci/runners/one");
  mkdirSync(directory, { recursive: true });
  const config = {
    owner: "ci",
    home: root,
    root: join(root, "ci"),
    path: "/usr/bin:/bin",
    label: "mini-m4pro-ci",
    maxActiveSlots: 1,
    activeSlots: ["one"],
    slots: [{ id: "one", repository: "owner/repo", name: "one", directory, state: join(root, "ci/state/one") }],
  };
  writeFileSync(join(root, "pool.json"), JSON.stringify(config));
  writeFileSync(
    join(directory, ".runner"),
    JSON.stringify({ agentId: 1, agentName: "one", gitHubUrl: "https://github.com/owner/repo", workFolder: "_work" }),
  );
  if (!firstInstall) writeFileSync(join(directory, ".service"), "installed");
  mkdirSync(join(directory, "bin"));
  mkdirSync(join(root, "Library/LaunchAgents"), { recursive: true });
  writeFileSync(
    join(directory, "bin/actions.runner.plist.template"),
    "<key>Label</key><string>{{SvcName}}</string><key>ACTIONS_RUNNER_SVC</key><string>1</string><key>RunAtLoad</key><true/><key>SessionCreate</key><true/>",
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        fileURLToPath(new URL("./fixtures/runner-pool-preload.mjs", import.meta.url)),
        fileURLToPath(new URL("../scripts/runner-pool.mjs", import.meta.url)),
        command,
        join(root, "pool.json"),
        "one",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          MDWN_POOL_TEST_ROOT: root,
          MDWN_POOL_TEST_BUSY: String(busy),
          MDWN_POOL_TEST_DUAL_DOMAINS: String(dualDomains),
          MDWN_POOL_TEST_LOADED: String(loaded),
        },
      },
    );
    const commands: { executable: string; args: string[] }[] = readFileSync(join(root, "commands.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return { ...result, commands };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("starting an already-loaded service restores routing without loading it twice", () => {
  const result = controller("start", false);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("routing labels restored");
  expect(
    result.commands.some(
      (command) =>
        command.executable === "gh" && command.args.includes("POST") && command.args.includes("labels[]=mini-m4pro-ci"),
    ),
  ).toBe(true);
  expect(result.commands.some((command) => command.executable === "./svc.sh")).toBe(false);
  expect(result.commands).toContainEqual({
    executable: "launchctl",
    args: ["enable", "gui/501/actions.runner.owner-repo.one"],
  });
});

test("a busy stop leaves the pool routing label intact", () => {
  const result = controller("stop", true);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("still has an executing job");
  expect(result.commands.some((command) => command.args.includes("DELETE"))).toBe(false);
  expect(result.commands.some((command) => command.args.includes("disable"))).toBe(false);
});

test("an idle stop persistently disables the service before unloading it", () => {
  const result = controller("stop", false);
  expect(result.status).toBe(0);
  const disable = result.commands.findIndex(
    (command) => command.executable === "launchctl" && command.args[0] === "disable",
  );
  const unload = result.commands.findIndex(
    (command) => command.executable === "./svc.sh" && command.args[0] === "stop",
  );
  expect(disable).toBeGreaterThanOrEqual(0);
  expect(unload).toBeGreaterThan(disable);
});

test("stopping an already-unloaded service repairs persistent startup state", () => {
  const result = controller("stop", false, false, false);
  expect(result.status).toBe(0);
  expect(result.commands).toContainEqual({
    executable: "launchctl",
    args: ["disable", "gui/501/actions.runner.owner-repo.one"],
  });
  expect(result.commands.some((command) => command.executable === "./svc.sh")).toBe(false);
});

test("preparing an unloaded service persistently disables it until an explicit start", () => {
  const result = controller("service", false, false, false);
  expect(result.status).toBe(0);
  expect(result.commands).toContainEqual({
    executable: "launchctl",
    args: ["disable", "gui/501/actions.runner.owner-repo.one"],
  });
});

test("first installation is persistently disabled before its plist becomes discoverable", () => {
  const result = controller("service", false, false, false, true);
  expect(result.status).toBe(0);
  const disable = result.commands.findIndex(
    (command) => command.executable === "launchctl" && command.args[0] === "disable",
  );
  const install = result.commands.findIndex(
    (command) => command.executable === "./svc.sh" && command.args[0] === "install",
  );
  expect(disable).toBeGreaterThanOrEqual(0);
  expect(install).toBeGreaterThan(disable);
});

test("service preparation cannot change startup state while the service remains loaded", () => {
  const result = controller("service", false);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Stop the idle service");
  expect(result.commands.some((command) => command.args.includes("disable"))).toBe(false);
});

test("equal service labels in user and GUI domains consume separate reservations", () => {
  const result = controller("start", false, true);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("host-wide listener budget");
  expect(result.commands.some((command) => command.args.includes("POST"))).toBe(false);
  expect(result.commands.some((command) => command.executable === "./svc.sh")).toBe(false);
});
