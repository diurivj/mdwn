import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Portable/shared modules live under `app/shared/<feature>/`. The Node tooling
// project (`tsconfig.node.json`) discovers them with `app/shared/**/*.ts`; the
// Workers project (`tsconfig.cloudflare.json`) discovers them with `app/**/*`.
// A new portable SQL module dropped into the area must therefore be typechecked
// by both targets without another per-file tsconfig edit. This regression runs
// the compiler's own config resolution and program construction instead of
// copying the glob strings, so a broken include pattern fails here.
const PROBE = "app/shared/__boundary-probe__/probe.server.ts";
const PROBE_DIR = dirname(PROBE);
const PROBE_ABSOLUTE = resolve(PROBE);

function parseProject(configPath: string): ts.ParsedCommandLine {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  return ts.parseJsonConfigFileContent(read.config, ts.sys, process.cwd());
}

/** Resolve a composite project's own file list through the TypeScript compiler. */
function projectFiles(configPath: string): string[] {
  return parseProject(configPath).fileNames.map((file) => relative(process.cwd(), file).split("\\").join("/"));
}

/** Typecheck one file under a project's own compiler options. */
function fileDiagnostics(configPath: string, file: string): string[] {
  const program = ts.createProgram([file], parseProject(configPath).options);
  return ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === file)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

describe("TypeScript runtime project boundaries", () => {
  beforeAll(() => {
    // Clear a probe left behind by a killed run before writing a fresh one.
    rmSync(PROBE_DIR, { recursive: true, force: true });
    mkdirSync(PROBE_DIR, { recursive: true });
    writeFileSync(PROBE, 'import { sql } from "drizzle-orm";\nexport const boundaryProbe = sql`SELECT 1`;\n');
  });

  afterAll(() => { rmSync(PROBE_DIR, { recursive: true, force: true }); });

  it("discovers and typechecks a new portable SQL module from both projects", () => {
    for (const configPath of ["tsconfig.node.json", "tsconfig.cloudflare.json"]) {
      expect(projectFiles(configPath)).toContain(PROBE);
      expect(fileDiagnostics(configPath, PROBE_ABSOLUTE)).toEqual([]);
    }
  });

  it("keeps Worker-only entrypoints and generated bindings out of the Node tooling project", () => {
    const node = projectFiles("tsconfig.node.json");
    // Rule, not a path list: every application module the Node target compiles
    // must come from the shared layer, so a per-file `files`/`include` entry
    // cannot quietly return.
    expect(node.filter((file) => file.startsWith("app/") && !file.startsWith("app/shared/"))).toEqual([]);
    expect(node).not.toContain("workers/app.ts");
    expect(node).not.toContain("worker-configuration.d.ts");
  });
});
