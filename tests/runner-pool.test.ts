import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  assertStartCapacity,
  parseLaunchdRunners,
  serviceTemplate,
  serviceName,
  snapshotOriginalService,
  slotEnvironment,
  validatePool,
} from "../scripts/lib/runner-pool.mjs";

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

test("service snapshots preserve both original contents and original absence across reconfiguration", () => {
  const pool = fixture();
  const slot = pool.slots[0];
  mkdirSync(slot.directory, { recursive: true });
  writeFileSync(join(slot.directory, ".path"), "original-path");
  const backup = snapshotOriginalService(pool, slot);
  const snapshot = readFileSync(join(backup, "snapshot.json"), "utf8");
  expect(JSON.parse(snapshot).files).toEqual({
    ".path": true,
    ".env": false,
    ".service": false,
    "service.plist": false,
  });
  writeFileSync(join(slot.directory, ".path"), "updated-path");
  writeFileSync(join(slot.directory, ".service"), "new-service");
  const agents = join(pool.home, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, `${serviceName(slot)}.plist`), "generated-plist");
  expect(snapshotOriginalService(pool, slot)).toBe(backup);
  expect(readFileSync(join(backup, ".path"), "utf8")).toBe("original-path");
  expect(readFileSync(join(backup, "snapshot.json"), "utf8")).toBe(snapshot);
  expect(existsSync(join(backup, ".service"))).toBe(false);
  expect(existsSync(join(backup, "service.plist"))).toBe(false);
});

test("legacy backups without presence metadata require an explicit inventoried migration", () => {
  const pool = fixture();
  const slot = pool.slots[0];
  const backup = join(pool.root, "config", `${slot.id}-original`);
  mkdirSync(backup, { recursive: true });
  writeFileSync(join(backup, ".path"), "preserve-this");
  expect(() => snapshotOriginalService(pool, slot)).toThrow("inventoried snapshot.json");
  expect(readFileSync(join(backup, ".path"), "utf8")).toBe("preserve-this");
  expect(existsSync(join(backup, "snapshot.json"))).toBe(false);
});

test("a preexisting service remains the original snapshot after later template changes", () => {
  const pool = fixture();
  const slot = pool.slots[0];
  mkdirSync(slot.directory, { recursive: true });
  writeFileSync(join(slot.directory, ".service"), "original-service-name");
  const agents = join(pool.home, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  const plist = join(agents, `${serviceName(slot)}.plist`);
  writeFileSync(plist, "original-plist");
  const backup = snapshotOriginalService(pool, slot);
  writeFileSync(plist, "new-plist");
  snapshotOriginalService(pool, slot);
  expect(JSON.parse(readFileSync(join(backup, "snapshot.json"), "utf8")).files["service.plist"]).toBe(true);
  expect(readFileSync(join(backup, "service.plist"), "utf8")).toBe("original-plist");
});

test("an incomplete or changed original snapshot fails closed rather than recapturing current files", () => {
  const pool = fixture();
  const slot = pool.slots[0];
  mkdirSync(slot.directory, { recursive: true });
  writeFileSync(join(slot.directory, ".path"), "original-path");
  const backup = snapshotOriginalService(pool, slot);
  unlinkSync(join(backup, ".path"));
  expect(() => snapshotOriginalService(pool, slot)).toThrow("file-presence record");
  expect(existsSync(join(backup, ".path"))).toBe(false);
  writeFileSync(
    join(backup, "snapshot.json"),
    JSON.stringify({ version: 1, slot: slot.id, directory: slot.directory }),
  );
  expect(() => snapshotOriginalService(pool, slot)).toThrow("file-presence record");
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

test("child caches and tool workspaces cannot escape through symlinks", () => {
  const pool = fixture();
  mkdirSync(join(pool.slots[0].state, "npm-cache"), { recursive: true });
  mkdirSync(pool.slots[1].state, { recursive: true });
  symlinkSync(join(pool.slots[0].state, "npm-cache"), join(pool.slots[1].state, "npm-cache"));
  expect(() => validatePool(pool)).toThrow("resource symlink");
  const work = fixture();
  mkdirSync(work.slots[0].directory, { recursive: true });
  mkdirSync(work.slots[1].directory, { recursive: true });
  symlinkSync(work.slots[0].directory, join(work.slots[1].directory, "_work"));
  expect(() => validatePool(work)).toThrow("Workspace symlink");
});

test("different repository spellings cannot collide on a launchd service name", () => {
  const pool = fixture();
  pool.slots[0].repository = "a-b/c";
  pool.slots[1].repository = "a/b-c";
  pool.slots[1].name = pool.slots[0].name;
  expect(() => validatePool(pool)).toThrow("service names must be unique");
});

test("launchd reservations include loaded zero-PID services and omit disabled entries", () => {
  expect(
    parseLaunchdRunners(
      'services = {\n  100 - actions.runner.one\n  0 (pe) actions.runner.two\n}\ndisabled services = {\n  "actions.runner.off" => disabled\n}',
    ),
  ).toEqual(["actions.runner.one", "actions.runner.two"]);
});

test("the official service entry point is preserved with slot environment and restart throttling", () => {
  const pool = fixture();
  const template =
    "<key>ProgramArguments</key><array><string>{{RunnerRoot}}/runsvc.sh</string></array><key>RunAtLoad</key><true/><key>EnvironmentVariables</key><dict><key>ACTIONS_RUNNER_SVC</key><string>1</string></dict><key>SessionCreate</key><true/>";
  const result = serviceTemplate(template, pool, pool.slots[0]);
  expect(result).toContain("{{RunnerRoot}}/runsvc.sh");
  expect(result).toContain("<key>ThrottleInterval</key>");
  expect(result).toContain("<integer>30</integer>");
  expect(result).toContain("<key>NPM_CONFIG_CACHE</key>");
  expect(result).toContain("<key>PLAYWRIGHT_BROWSERS_PATH</key>");
  expect(result).not.toContain("<key>HOME</key>");
  expect(result).toMatch(/<key>SessionCreate<\/key>\s*<false\/>/);
});

test("an unrecognized security-session setting cannot silently break browser key storage", () => {
  const pool = fixture();
  const template = "<key>ACTIONS_RUNNER_SVC</key><string>1</string><key>RunAtLoad</key><true/>";
  expect(() => serviceTemplate(template, pool, pool.slots[0])).toThrow("security-session setting");
  expect(() =>
    serviceTemplate(`${template}<key>SessionCreate</key><true/><key>SessionCreate</key><true/>`, pool, pool.slots[0]),
  ).toThrow("security-session setting");
});
