import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { assertStartCapacity, serviceTemplate, slotEnvironment, validatePool } from "../scripts/lib/runner-pool.mjs";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mdwn-pool-test-"));
  directories.push(root);
  return {
    owner: "ci",
    home: root,
    root: join(root, "ci"),
    path: "/usr/bin:/bin",
    label: "mini-m4pro-ci",
    maxActiveSlots: 2,
    activeSlots: ["mdwn-01", "mdwn-02"],
    slots: [1, 2].map((number) => ({
      id: `mdwn-0${number}`,
      repository: "owner/repo",
      name: `mini-0${number}`,
      directory: join(root, "ci", "runners", `mdwn-0${number}`),
      state: join(root, "ci", "state", `mdwn-0${number}`),
    })),
  };
}

test("separate registrations keep every writable resource in its own slot", () => {
  const pool = validatePool(fixture());
  const first = slotEnvironment(pool, pool.slots[0]);
  const second = slotEnvironment(pool, pool.slots[1]);
  for (const key of [
    "NPM_CONFIG_CACHE",
    "PLAYWRIGHT_BROWSERS_PATH",
    "TMPDIR",
    "AGENT_TOOLSDIRECTORY",
    "MDWN_CI_SLOT_STATE",
  ] as const) {
    expect(first[key]).not.toBe(second[key]);
    expect(first[key]).toMatch(/^\//);
  }
  expect(first).not.toHaveProperty("HOME");
});

test("a listener from another repository or account consumes the same host budget", () => {
  const pool = fixture();
  const first = join(pool.slots[0].directory, "bin", "Runner.Listener");
  expect(() => assertStartCapacity(pool, [first, "/other-user/runner/bin/Runner.Listener"], [], pool.slots[1])).toThrow(
    "host-wide",
  );
  expect(() => assertStartCapacity(pool, [first], [], pool.slots[1])).not.toThrow();
});

test("a loaded service reserves capacity before its listener starts", () => {
  const pool = fixture();
  expect(() =>
    assertStartCapacity(pool, ["/another/bin/Runner.Listener"], ["actions.runner.owner-repo.mini-01"], pool.slots[1]),
  ).toThrow("host-wide");
  expect(() =>
    assertStartCapacity(
      pool,
      [join(pool.slots[0].directory, "bin", "Runner.Listener")],
      ["actions.runner.owner-repo.mini-01"],
      pool.slots[1],
    ),
  ).not.toThrow();
});

test("inactive slots cannot be started even with free host capacity", () => {
  const pool = fixture();
  pool.activeSlots = ["mdwn-01"];
  expect(() => assertStartCapacity(pool, [], [], pool.slots[1])).toThrow("configured active pool");
});

test("overlapping paths and symlinked state are rejected", () => {
  const pool = fixture();
  pool.slots[1].state = join(pool.slots[0].state, "nested");
  expect(() => validatePool(pool)).toThrow("disjoint");
  const aliased = fixture();
  mkdirSync(aliased.slots[0].state, { recursive: true });
  symlinkSync(aliased.slots[0].state, aliased.slots[1].state);
  expect(() => validatePool(aliased)).toThrow("disjoint");
});

test("expanded paths, distinct roots, and a bounded configured pool are required", () => {
  const pool = fixture();
  pool.slots[0].state = "~/ci/state";
  expect(() => validatePool(pool)).toThrow("absolute");
  expect(() => validatePool({ ...fixture(), maxActiveSlots: 5 })).toThrow("between one and four");
  expect(() => validatePool({ ...fixture(), maxActiveSlots: 1 })).toThrow("exceeds");
});

test("the official service entry point is preserved with slot environment and restart throttling", () => {
  const pool = fixture();
  const template =
    "<key>ProgramArguments</key><array><string>{{RunnerRoot}}/runsvc.sh</string></array><key>RunAtLoad</key><true/><key>EnvironmentVariables</key><dict><key>ACTIONS_RUNNER_SVC</key><string>1</string></dict>";
  const result = serviceTemplate(template, pool, pool.slots[0]);
  expect(result).toContain("{{RunnerRoot}}/runsvc.sh");
  expect(result).toContain("<key>ThrottleInterval</key>");
  expect(result).toContain("<integer>30</integer>");
  expect(result).toContain("<key>NPM_CONFIG_CACHE</key>");
  expect(result).toContain("<key>PLAYWRIGHT_BROWSERS_PATH</key>");
  expect(result).not.toContain("<key>HOME</key>");
});
