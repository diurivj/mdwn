import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const runner = fileURLToPath(new URL("./support/operational-command-runner.mjs", import.meta.url));
const directories: string[] = [];

function command(
  script: string,
  args: string[] | ((directory: string) => string[]),
  scenario: Record<string, unknown>,
) {
  const directory = mkdtempSync(join(tmpdir(), "mdwn-script-test-"));
  directories.push(directory);
  mkdirSync(join(directory, "temp"));
  symlinkSync(fileURLToPath(new URL("../drizzle", import.meta.url)), join(directory, "drizzle"), "dir");
  const reportPath = join(directory, "runner.test.json");
  const argv = typeof args === "function" ? args(directory) : args;
  const result = spawnSync(
    process.execPath,
    ["--import", runner, fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), ...argv],
    {
      cwd: directory,
      env: {
        ...process.env,
        TMPDIR: join(directory, "temp"),
        MDWN_SCRIPT_SCENARIO: JSON.stringify(scenario),
        MDWN_SCRIPT_REPORT: reportPath,
      },
      encoding: "utf8",
    },
  );
  const report: {
    commands: string[][];
    directories: string[];
    writes: Array<{ path: string; mode: number }>;
    deletions: Array<{ kind: string; name: string; uuid: string }>;
  } = JSON.parse(readFileSync(reportPath, "utf8"));
  return { status: result.status, output: result.stdout + result.stderr, report, directory };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("a borrowed proof database and an uncreated Worker are never deleted on build failure", () => {
  const result = command("import-proof.mjs", ["--db-id", "20000000-0000-4000-8000-000000000001"], {
    failCommand: "^react-router build",
    borrowed: true,
  });
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/react-router build failed/);
  expect(result.report.commands.filter((args) => args.includes("delete"))).toEqual([]);
  expect(result.output).toMatch(/Borrowed resource left untouched: D1 .*20000000-0000-4000-8000-000000000001/);
});

test("a partial rehearsal creation cleans up only the confirmed source and reports the unresolved target", () => {
  const result = command("rehearse-d1-restore.mjs", [], { failCommand: "^d1 create mdwn-restore-rehearsal-target" });
  expect(result.status).toBe(1);
  const deletes = result.report.commands.filter((args) => args[0] === "d1" && args[1] === "delete");
  expect(deletes).toHaveLength(1);
  expect(deletes[0].join(" ")).toContain("source");
  expect(result.output).toMatch(/Unresolved creation: D1 mdwn-restore-rehearsal-target/);
  expect(result.output).toMatch(/identifier unresolved/);
});

test("a successful remote rehearsal deletes target before source by their confirmed UUIDs and removes default artifacts", () => {
  const result = command("rehearse-d1-restore.mjs", ["--max-ciphertext-bytes", "1024"], {});
  expect(result.status, result.output).toBe(0);
  expect(result.report.deletions).toEqual([
    { kind: "D1", name: expect.stringContaining("target"), uuid: "10000000-0000-4000-8000-000000000002" },
    { kind: "D1", name: expect.stringContaining("source"), uuid: "10000000-0000-4000-8000-000000000001" },
  ]);
  expect(result.report.directories.filter(existsSync)).toEqual([]);
  for (const name of [
    "rehearsal-export.sql",
    "rehearsal-prepared.sql",
    "rehearsal-manifest.json",
    "rehearsal-seed.sql",
    "rehearsal-evidence.md",
  ]) {
    const writes = result.report.writes.filter(({ path }) => path.endsWith(name));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every(({ mode }) => mode === 0o600)).toBe(true);
  }
  expect(result.output).not.toMatch(/Retained sensitive artifact|Surviving resource|Cleanup failed/);
});

test("unexpected remote cleanup failure fails an otherwise successful rehearsal and reports the surviving UUID", () => {
  const result = command("rehearse-d1-restore.mjs", ["--max-ciphertext-bytes", "1024"], {
    failCommand: "^d1 delete .*target",
  });
  expect(result.status, result.output).toBe(1);
  expect(result.output).toMatch(/target verified against the manifest/);
  expect(result.output).toMatch(/Surviving resource: D1 .*target.*10000000-0000-4000-8000-000000000002/);
  expect(result.report.deletions.map(({ uuid }) => uuid)).toEqual([
    "10000000-0000-4000-8000-000000000002",
    "10000000-0000-4000-8000-000000000001",
  ]);
  for (const path of result.report.directories) {
    expect(existsSync(path)).toBe(true);
    expect(result.output).toContain(path);
  }
  expect(result.output).not.toContain("SENSITIVE_SUBPROCESS_SENTINEL");
});

test("a successful proof cleans up its Worker before its owned database and removes sensitive files", () => {
  const result = command("import-proof.mjs", [], {});
  expect(result.status, result.output).toBe(0);
  const deletions = result.report.commands.filter((args) => args.includes("delete"));
  expect(deletions.map((args) => args[0])).toEqual(["delete", "d1"]);
  expect(result.report.deletions).toEqual([
    { kind: "D1", name: expect.stringMatching(/^mdwn-import-proof-db-/), uuid: "10000000-0000-4000-8000-000000000001" },
  ]);
  expect(result.report.directories.filter(existsSync)).toEqual([]);
  for (const basename of ["proof-env.json", "proof-secrets.json", "proof-seed.sql"]) {
    const writes = result.report.writes.filter(({ path }) => path.endsWith(basename));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every(({ mode }) => mode === 0o600)).toBe(true);
    expect(writes.every(({ path }) => !existsSync(path))).toBe(true);
  }
  expect(result.output).not.toMatch(/Retained sensitive artifact|Surviving resource|Cleanup failed/);
});

test("partial target-config creation retains and reports every allocated directory on failure", () => {
  const result = command("rehearse-d1-restore.mjs", ["--local"], { failWrite: "/mdwn-restore-[^/]+/wrangler.jsonc$" });
  expect(result.status, result.output).toBe(1);
  expect(result.report.directories.filter((path) => basename(path).startsWith("mdwn-restore-"))).toHaveLength(2);
  for (const path of result.report.directories) {
    expect(existsSync(path)).toBe(true);
    expect(result.output).toContain(path);
  }
});

test("proof failure retains protected credentials by path without printing their contents", () => {
  const result = command("import-proof.mjs", [], { failCommand: "^vitest run" });
  expect(result.status, result.output).toBe(1);
  const path = result.report.writes.find(({ path }) => path.endsWith("proof-env.json"))?.path;
  if (!path) throw new Error("the command did not create its proof environment");
  const environment = JSON.parse(readFileSync(path, "utf8"));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(result.output).toContain(result.report.directories[0]);
  expect(result.output).toContain("trash ");
  expect(result.output).not.toContain(environment.PROOF_SESSION_COOKIE);
  expect(result.output).not.toContain(JSON.parse(environment.PROOF_DEVICE_JWK).d);
  expect(result.output).not.toContain("SENSITIVE_SUBPROCESS_SENTINEL");
  expect(result.report.commands.filter((args) => args.includes("delete")).map((args) => args[0])).toEqual([
    "delete",
    "d1",
  ]);
});

test("proof cleanup failure continues to remove local artifacts and fails an otherwise successful command", () => {
  const result = command("import-proof.mjs", [], { failRemove: "wrangler\\.proof-" });
  expect(result.status, result.output).toBe(1);
  expect(
    result.report.directories.filter((path) => basename(path).startsWith("mdwn-import-proof-")).filter(existsSync),
  ).toEqual([]);
  expect(result.output).toMatch(/Cleanup failed: wrangler\.proof-/);
  expect(result.output).toMatch(/Retained sensitive artifact: wrangler\.proof-/);
  expect(result.output).not.toMatch(/release proof passed/);
});

test("a failed Worker deletion still attempts the owned database and reports the Worker version survivor", () => {
  const result = command("import-proof.mjs", [], { failCommand: "^delete " });
  expect(result.status, result.output).toBe(1);
  expect(result.report.deletions).toHaveLength(1);
  expect(result.output).toMatch(/Surviving resource: Worker mdwn-import-proof-.*30000000-0000-4000-8000-000000000001/);
  expect(result.output).toMatch(/Deleted D1 mdwn-import-proof-db-/);
  expect(result.output).not.toMatch(/proof deployment deleted|release proof passed/);
});

test("an ambiguous Worker deployment is unresolved, not deletion authority", () => {
  const result = command("import-proof.mjs", [], { ambiguousDeploy: true });
  expect(result.status, result.output).toBe(1);
  expect(result.report.commands.filter((args) => args[0] === "delete")).toEqual([]);
  expect(result.report.deletions).toHaveLength(1);
  expect(result.output).toMatch(/Unresolved creation: Worker mdwn-import-proof-.*identifier unresolved/);
});

test("a successful proof using a borrowed database deletes only its newly created Worker", () => {
  const result = command("import-proof.mjs", ["--db-id", "20000000-0000-4000-8000-000000000001"], { borrowed: true });
  expect(result.status, result.output).toBe(0);
  expect(result.report.commands.filter((args) => args.includes("delete")).map((args) => args[0])).toEqual(["delete"]);
  expect(result.report.deletions).toEqual([]);
  expect(result.output).toMatch(/Borrowed resource left untouched/);
});

test.each([
  { script: "import-proof.mjs", args: ["--keep"] },
  { script: "rehearse-d1-restore.mjs", args: ["--keep", "--max-ciphertext-bytes", "1024"] },
])("intentional retention does not fail successful $script checks", ({ script, args }) => {
  const result = command(script, args, {});
  expect(result.status, result.output).toBe(0);
  expect(result.report.commands.filter((args) => args.includes("delete"))).toEqual([]);
  expect(result.output).toMatch(/Kept resource by explicit request/);
  expect(result.output).toMatch(/Retained sensitive artifact: .*explicit request/);
  expect(result.output).not.toMatch(/Cleanup failed|Surviving resource/);
  for (const path of result.report.directories) {
    expect(existsSync(path)).toBe(true);
    expect(result.output).toContain(path);
  }
});

test("partial raw exports remain protected and their paths are reported without export contents", () => {
  const result = command("rehearse-d1-restore.mjs", ["--local", "--max-ciphertext-bytes", "1024"], {
    failExport: true,
  });
  expect(result.status, result.output).toBe(1);
  const path = result.report.writes.find(({ path }) => path.endsWith("rehearsal-export.sql"))?.path;
  if (!path) throw new Error("the command did not create its raw export");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path, "utf8")).toContain("partial controlled export");
  expect(result.output).toContain(result.report.directories[0]);
  expect(result.output).not.toContain("partial controlled export");
  expect(result.output).not.toContain("SENSITIVE_SUBPROCESS_SENTINEL");
});

test("explicit evidence is protected on overwrite and retained after other success artifacts are cleaned", () => {
  let evidencePath = "";
  const result = command(
    "rehearse-d1-restore.mjs",
    (directory) => {
      evidencePath = join(directory, "rehearsal-evidence.md");
      writeFileSync(evidencePath, "old synthetic evidence", { mode: 0o666 });
      return ["--local", "--max-ciphertext-bytes", "1024", "--evidence", evidencePath];
    },
    {},
  );
  expect(result.status, result.output).toBe(0);
  expect(result.report.directories.filter(existsSync)).toEqual([]);
  expect(statSync(evidencePath).mode & 0o777).toBe(0o600);
  expect(result.output).toContain(`Retained sensitive artifact: ${evidencePath} (operator output)`);
  expect(result.output).not.toContain(readFileSync(evidencePath, "utf8"));
});

test.each([false, true])(
  "the restore CLI protects overwritten SQL, manifests and status on command failure=%s",
  (fail) => {
    const source = command("rehearse-d1-restore.mjs", ["--local", "--keep", "--max-ciphertext-bytes", "1024"], {});
    expect(source.status, source.output).toBe(0);
    const exportPath = source.report.writes.find(({ path }) => path.endsWith("rehearsal-export.sql"))?.path;
    if (!exportPath) throw new Error("missing synthetic source export");
    let preparedPath = "";
    let manifestPath = "";
    const preparation = command(
      "restore-d1-export.mjs",
      (directory) => {
        const input = join(directory, "synthetic-input.sql");
        preparedPath = join(directory, "restore.sql");
        manifestPath = join(directory, "restore.manifest.json");
        writeFileSync(input, readFileSync(exportPath), { mode: 0o600 });
        for (const path of [preparedPath, manifestPath]) writeFileSync(path, "old synthetic artifact", { mode: 0o666 });
        return [
          "prepare",
          "--export",
          input,
          "--source-name",
          "synthetic-source",
          "--source-uuid",
          "10000000-0000-4000-8000-000000000001",
          "--out",
          preparedPath,
          "--manifest",
          manifestPath,
        ];
      },
      {},
    );
    expect(preparation.status, preparation.output).toBe(0);
    for (const path of [preparedPath, manifestPath]) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(preparation.output).toContain(path);
      expect(preparation.output).not.toContain(readFileSync(path, "utf8"));
    }
    let statusPath = "";
    const restoration = command(
      "restore-d1-export.mjs",
      (directory) => {
        const sql = join(directory, "restore.sql");
        const manifest = join(directory, "restore.manifest.json");
        statusPath = `${manifest}.status.json`;
        writeFileSync(sql, readFileSync(preparedPath), { mode: 0o600 });
        writeFileSync(manifest, readFileSync(manifestPath), { mode: 0o600 });
        writeFileSync(statusPath, "old synthetic status", { mode: 0o666 });
        return ["restore", "--prepared", sql, "--manifest", manifest];
      },
      fail ? { failCommand: "^d1 execute .*CREATE TABLE" } : {},
    );
    expect(restoration.status, restoration.output).toBe(fail ? 1 : 0);
    expect(statSync(statusPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(statusPath, "utf8")).state).toBe(fail ? "failed" : "verified");
    expect(restoration.output).toContain(statusPath);
    expect(restoration.output).toContain("trash ");
    expect(restoration.output).not.toContain("SENSITIVE_SUBPROCESS_SENTINEL");
    expect(restoration.output).not.toContain(readFileSync(statusPath, "utf8"));
  },
);

test("unclassified cleanup errors retain private details and do not interrupt remaining cleanup", () => {
  const sentinel = "SYNTHETIC_PRIVATE_CLEANUP_SENTINEL";
  const result = command("import-proof.mjs", [], { failRemove: "wrangler\\.proof-", cleanupMessage: sentinel });
  expect(result.status, result.output).toBe(1);
  expect(
    result.report.directories.filter((path) => basename(path).startsWith("mdwn-import-proof-")).filter(existsSync),
  ).toEqual([]);
  expect(result.output).not.toContain(sentinel);
  const diagnostics = result.report.writes.find(({ path }) => path.endsWith("lifecycle-diagnostics.json"))?.path;
  if (!diagnostics) throw new Error("private cleanup diagnostics were not written");
  expect(statSync(diagnostics).mode & 0o777).toBe(0o600);
  expect(readFileSync(diagnostics, "utf8")).toContain(sentinel);
});

test.each([
  { name: "successful", scenario: {} },
  { name: "failed", scenario: { failWrite: "lifecycle-diagnostics.json" } },
])("offline preparation failures stay private with $name diagnostic writing", ({ scenario }) => {
  const sentinel = "SYNTHETIC_PRIVATE_SENTINEL";
  const result = command(
    "restore-d1-export.mjs",
    (directory) => {
      const input = join(directory, "input.d1-export.sql");
      writeFileSync(
        input,
        `CREATE TABLE t(id INTEGER PRIMARY KEY, secret TEXT);\nINSERT INTO t(id,secret) VALUES(1,'${sentinel}${"x".repeat(100_001)}');\n`,
        { mode: 0o600 },
      );
      return [
        "prepare",
        "--export",
        input,
        "--source-name",
        "synthetic-source",
        "--source-uuid",
        "10000000-0000-4000-8000-000000000001",
        "--out",
        join(directory, "restore.sql"),
        "--manifest",
        join(directory, "restore.manifest.json"),
      ];
    },
    scenario,
  );
  expect(result.status, result.output).toBe(1);
  expect(result.output).not.toContain(sentinel);
  const diagnostics = result.report.writes.find(({ path }) => path.endsWith("lifecycle-diagnostics.json"))?.path;
  if (!diagnostics) throw new Error("private diagnostic artifact was not written");
  expect(statSync(diagnostics).mode & 0o777).toBe(0o600);
  expect(readFileSync(diagnostics, "utf8")).toContain(sentinel);
  const reportedPath = /Retained sensitive artifact: ([^;\n(]+)/.exec(result.output)?.[1]?.trim();
  if (!reportedPath) throw new Error("diagnostic path was not reported");
  expect(realpathSync(reportedPath)).toBe(realpathSync(scenario.failWrite ? dirname(diagnostics) : diagnostics));
  if (scenario.failWrite)
    expect(result.output).toMatch(/Cleanup\/reporting failed: could not write private failure diagnostics/);
  expect(result.output).toContain("trash ");
});

test("operational commands do not leave unmanaged raw Wrangler diagnostic logs", () => {
  const result = command("import-proof.mjs", [], {});
  expect(result.status, result.output).toBe(0);
  expect(existsSync(join(result.directory, "wrangler-raw.test.log"))).toBe(false);
});

test("foreign-key subprocess failures preserve the command error without leaking raw output", () => {
  const result = command("smoke-db.mjs", [], { failCommand: "^d1 execute .*PRAGMA foreign_keys" });
  expect(result.status, result.output).toBe(1);
  expect(result.report.directories.filter(existsSync)).toEqual([]);
  expect(result.output).toMatch(/D1 operational query failed/);
  expect(result.output).not.toContain("SENSITIVE_SUBPROCESS_SENTINEL");
});

test("smoke-db schema assertion failures also clean up before failing", () => {
  const result = command("smoke-db.mjs", [], { failSchema: true });
  expect(result.status, result.output).toBe(1);
  expect(result.output).toMatch(/missing schema fact/);
  expect(result.report.directories.filter(existsSync)).toEqual([]);
});

test("an ambiguous creation is reported without guessing an id or deleting by name", () => {
  const result = command("rehearse-d1-restore.mjs", [], { ambiguousCreate: true });
  expect(result.status).toBe(1);
  expect(result.report.commands.filter((args) => args.includes("delete"))).toEqual([]);
  expect(result.output).toMatch(/Unresolved creation: D1 .*identifier unresolved/);
  expect(result.output).not.toContain("created without a binding identifier");
});

test("rehearsal preserves the operational error and continues reverse-order cleanup after deletion failure", () => {
  const result = command("rehearse-d1-restore.mjs", [], {
    failCommand: "^d1 migrations apply|^d1 delete .*target",
  });
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/rehearsal failed: source migrations failed/);
  expect(result.output).toMatch(/Cleanup failed: D1 mdwn-restore-rehearsal-target/);
  expect(result.output).toMatch(/Surviving resource: D1 .*target.*10000000-0000-4000-8000-000000000002/);
  expect(result.output).toMatch(/Deleted D1 .*source.*10000000-0000-4000-8000-000000000001/);
  const deletes = result.report.commands.filter((args) => args[1] === "delete");
  expect(deletes.map((args) => args.join(" "))).toEqual([
    expect.stringContaining("target"),
    expect.stringContaining("source"),
  ]);
  expect(result.output).not.toContain("SENSITIVE_SUBPROCESS_SENTINEL");
});

test("failed trigger restoration is reported separately from a failed seed and does not stop remote teardown", () => {
  const result = command("rehearse-d1-restore.mjs", ["--max-ciphertext-bytes", "1024"], {
    failCommand:
      '^d1 execute [\\s\\S]*INSERT INTO "?accounts|^d1 execute [\\s\\S]*CREATE TRIGGER tree_representation_immutable',
  });
  expect(result.status, result.output).toBe(1);
  expect(result.output).toMatch(/rehearsal failed: D1 query failed/);
  expect(result.output).toMatch(/Cleanup\/reporting failed: .*source.*trigger/);
  expect(result.report.deletions).toHaveLength(2);
  expect(result.output).not.toContain("SENSITIVE_SUBPROCESS_SENTINEL");
});

test("explicit remote retention reports both confirmed identifiers without deleting them", () => {
  const result = command("rehearse-d1-restore.mjs", ["--keep"], { failCommand: "^d1 migrations apply" });
  expect(result.status).toBe(1); // The operation failed, not the intentional retention.
  expect(result.report.commands.filter((args) => args.includes("delete"))).toEqual([]);
  expect(result.output).toMatch(/Kept resource by explicit request: D1 .*target.*10000000-0000-4000-8000-000000000002/);
  expect(result.output).toMatch(/Kept resource by explicit request: D1 .*source.*10000000-0000-4000-8000-000000000001/);
  expect(result.output).not.toMatch(/Cleanup failed|Surviving resource/);
  for (const path of result.report.directories) expect(result.output).toContain(path);
});

test("smoke-db preserves an operational error while reporting failed local cleanup separately", () => {
  const result = command("smoke-db.mjs", [], { failCommand: "^d1 migrations apply", failRemove: "mdwn-dm-smoke-" });
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/smoke test failed: local migration apply failed/);
  expect(result.output).toMatch(/Cleanup failed: .*mdwn-dm-smoke-/);
  expect(result.output).toMatch(/Retained sensitive artifact: .*mdwn-dm-smoke-/);
  expect(result.output).toContain("trash ");
});

test("smoke-db exits nonzero only after removing its local state when migration subprocesses fail", () => {
  const result = command("smoke-db.mjs", [], { failCommand: "^d1 migrations apply" });
  expect(result.status).toBe(1);
  expect(result.output).toMatch(/local migration apply failed/);
  expect(result.report.directories).toHaveLength(1);
  expect(result.report.directories.filter(existsSync)).toEqual([]);
});
