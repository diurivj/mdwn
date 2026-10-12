import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

function controller(command: "start" | "stop", busy: boolean) {
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
  writeFileSync(join(directory, ".service"), "installed");
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
      { encoding: "utf8", env: { ...process.env, MDWN_POOL_TEST_ROOT: root, MDWN_POOL_TEST_BUSY: String(busy) } },
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
});

test("a busy stop leaves the pool routing label intact", () => {
  const result = controller("stop", true);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("still has an executing job");
  expect(result.commands.some((command) => command.args.includes("DELETE"))).toBe(false);
});
