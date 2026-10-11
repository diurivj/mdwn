import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const check = fileURLToPath(new URL("../scripts/check-operational-safety.mjs", import.meta.url));
const directories: string[] = [];

function repository() {
  const directory = mkdtempSync(join(tmpdir(), "mdwn-safety-test-"));
  directories.push(directory);
  mkdirSync(join(directory, "scripts/lib"), { recursive: true });
  const result = spawnSync("git", ["init", "--quiet", directory], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return directory;
}

function runCheck(directory: string) {
  const result = spawnSync(process.execPath, [check], { cwd: directory, encoding: "utf8" });
  return { status: result.status, output: result.stdout + result.stderr };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test.each([
  "process.exit(1)",
  'process["exit"](1)',
  "globalThis.process.exit(1)",
  'import { exit as stop } from "node:process"; stop(1)',
  'import runtime from "node:process"; runtime.exit(1)',
  'import * as runtime from "node:process"; runtime.exit(1)',
  "const stop = process.exit; stop(1)",
  "const { exit: stop } = process; stop(1)",
])("the repository check rejects process-exit calls in helpers: %s", (source) => {
  const directory = repository();
  writeFileSync(join(directory, "scripts/lib/unsafe.mjs"), `${source};\n`);
  expect(runCheck(directory)).toMatchObject({ status: 1, output: expect.stringMatching(/unsafe\.mjs.*process\.exit/) });
});

test.each(["cjs", "jsx", "ts", "tsx", "mts", "cts"])("the helper check covers .%s modules too", (extension) => {
  const directory = repository();
  writeFileSync(join(directory, `scripts/lib/unsafe.${extension}`), "process.exit(1);\n");
  expect(runCheck(directory)).toMatchObject({
    status: 1,
    output: expect.stringContaining("must not call process.exit"),
  });
});

test("entrypoints may exit and unrelated exit methods, comments and strings are not process-exit calls", () => {
  const directory = repository();
  writeFileSync(join(directory, "scripts/command.mjs"), "process.exit(2);\n");
  writeFileSync(
    join(directory, "scripts/lib/safe.mjs"),
    'const other = { exit() {} }; other.exit(); // process.exit(1)\nconst message = "process.exit(1)";\n',
  );
  expect(runCheck(directory).status).toBe(0);
});

test("all reserved artifact paths are ignored and rejected when force-added, while synthetic fixtures remain allowed", () => {
  const directory = repository();
  writeFileSync(join(directory, ".gitignore"), readFileSync(new URL("../.gitignore", import.meta.url)));
  const artifacts = [
    "operational-artifacts/custom-output.bin",
    "operational-artifacts/output.example",
    "incident.d1-export.sql",
    "incident.restore.sql",
    "incident.restore.manifest.json",
    "incident.restore.manifest.json.status.json",
    "incident.restore-status.json",
    "rehearsal-export.sql",
    "rehearsal-prepared.sql",
    "rehearsal-seed.sql",
    "rehearsal-manifest.json",
    "rehearsal-status.json",
    "rehearsal-evidence.md",
    "lifecycle-diagnostics.json",
    "mdwn-restore-local-rehearsal-synthetic.md",
    "mdwn-restore-rehearsal-synthetic.md",
    "mdwn-restore-synthetic.cleanup.jsonc",
    "wrangler.proof.jsonc",
    "wrangler.proof-synthetic.jsonc",
    "mdwn-proof-env.json",
    "proof-env.json",
    "proof-secrets.json",
    "proof-seed.sql",
    ".dev.vars.synthetic",
    ".env",
    ".env.local",
  ];
  for (const path of artifacts) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), "synthetic operational-output test bytes\n");
  }
  const ignored = spawnSync("git", ["check-ignore", ...artifacts], { cwd: directory, encoding: "utf8" });
  expect(ignored.stdout.trim().split("\n")).toEqual(artifacts);
  const add = spawnSync("git", ["add", "--force", ...artifacts], { cwd: directory, encoding: "utf8" });
  if (add.status !== 0) throw new Error(add.stderr);
  const result = runCheck(directory);
  expect(result.status).toBe(1);
  for (const path of artifacts) expect(result.output).toContain(`${path}: tracked operational artifact`);
  expect(result.output).not.toContain("synthetic operational-output test bytes");

  const untrack = spawnSync("git", ["rm", "--cached", "--quiet", ...artifacts], { cwd: directory, encoding: "utf8" });
  if (untrack.status !== 0) throw new Error(untrack.stderr);
  mkdirSync(join(directory, "tests/fixtures"), { recursive: true });
  writeFileSync(join(directory, "tests/fixtures/synthetic-export.sql"), "SELECT 1;\n");
  writeFileSync(join(directory, "tests/fixtures/synthetic-manifest.json"), "{}\n");
  writeFileSync(join(directory, ".dev.vars.example"), "SYNTHETIC=example\n");
  const fixtures = spawnSync("git", ["add", "tests/fixtures", ".dev.vars.example"], {
    cwd: directory,
    encoding: "utf8",
  });
  if (fixtures.status !== 0) throw new Error(fixtures.stderr);
  expect(runCheck(directory).status).toBe(0);
});

test.each([
  { pattern: "wrangler.proof*.jsonc", path: "wrangler.proofbackup.jsonc" },
  { pattern: ".dev.vars*", path: ".dev.varsbackup" },
  { pattern: "mdwn-restore-rehearsal-*.md", path: "mdwn-restore-rehearsal-.md" },
  { pattern: "mdwn-restore-local-rehearsal-*.md", path: "mdwn-restore-local-rehearsal-.md" },
])("tracked wildcard output $path fails despite its ignore rule", ({ pattern, path }) => {
  const directory = repository();
  writeFileSync(join(directory, ".gitignore"), `${pattern}\n`);
  writeFileSync(join(directory, path), "synthetic operational-output test bytes\n");
  expect(spawnSync("git", ["check-ignore", path], { cwd: directory }).status).toBe(0);
  const add = spawnSync("git", ["add", "--force", path], { cwd: directory, encoding: "utf8" });
  if (add.status !== 0) throw new Error(add.stderr);
  expect(runCheck(directory)).toMatchObject({
    status: 1,
    output: expect.stringContaining(`${path}: tracked operational artifact`),
  });
});

test("a tracked operational export fails even when an ignore rule exists", () => {
  const directory = repository();
  writeFileSync(join(directory, ".gitignore"), "*.d1-export.sql\n");
  writeFileSync(join(directory, "incident.d1-export.sql"), "deliberately synthetic test bytes\n");
  const add = spawnSync("git", ["add", "--force", "incident.d1-export.sql"], { cwd: directory, encoding: "utf8" });
  if (add.status !== 0) throw new Error(add.stderr);
  expect(runCheck(directory)).toMatchObject({
    status: 1,
    output: expect.stringMatching(/incident\.d1-export\.sql.*tracked operational artifact/),
  });
});
