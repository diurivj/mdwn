#!/usr/bin/env node
/** Scoped operational safeguards, run by npm run lint. */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** @param {string} directory @returns {string[]} */
function helperFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return helperFiles(path);
    return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) ? [path] : [];
  });
}

const files = helperFiles(join(process.cwd(), "scripts/lib"));
// The pinned Biome has no noProcessExit rule. Use the existing TypeScript
// compiler to resolve Node's exit function, including imported/local aliases;
// unrelated objects with an exit method and comments/strings are not calls.
const program = ts.createProgram(files, {
  allowJs: true,
  noEmit: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  typeRoots: [fileURLToPath(new URL("../node_modules/@types", import.meta.url))],
  types: ["node"],
});
const checker = program.getTypeChecker();
let failures = 0;
for (const file of files) {
  const parsed = program.getSourceFile(file);
  if (!parsed) throw new Error(`Cannot parse ${file}`);
  const source = parsed;
  /** @param {import("typescript").Node} node */
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const symbol = checker.getTypeAtLocation(node.expression).getSymbol();
      if (
        symbol?.name === "exit" &&
        symbol.declarations?.some((declaration) =>
          declaration.getSourceFile().fileName.endsWith("/@types/node/process.d.ts"),
        )
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        console.error(`${relative(process.cwd(), file)}:${line + 1}: reusable helpers must not call process.exit`);
        failures += 1;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
// These names are reserved operational outputs, not a content classifier.
// Inspect the index directly: .gitignore cannot protect already-tracked files.
const tracked = spawnSync("git", ["ls-files", "--cached", "-z"], { encoding: "utf8" });
if (tracked.status !== 0) throw new Error("Cannot inspect tracked operational artifacts");
const operationalPatterns = [
  /^operational-artifacts\//,
  /(?:^|\/)wrangler\.proof[^/]*\.jsonc$/,
  /(?:^|\/)(?:mdwn-)?proof-(?:env|secrets)\.json$/,
  /(?:^|\/)proof-seed\.sql$/,
  /(?:^|\/)rehearsal-(?:export|prepared|seed)\.sql$/,
  /(?:^|\/)rehearsal-(?:manifest|status)\.json$/,
  /(?:^|\/)rehearsal-evidence\.md$/,
  /(?:^|\/)lifecycle-diagnostics\.json$/,
  /\.cleanup\.jsonc$/,
  /(?:^|\/)mdwn-restore-(?:local-)?rehearsal-[^/]*\.md$/,
  /\.d1-export\.sql$/,
  /(?:^|[/.])restore\.sql$/,
  /(?:^|[/.])restore\.manifest\.json(?:\.status\.json)?$/,
  /\.restore-status\.json$/,
  /(?:^|\/)\.dev\.vars(?!\.example$)[^/]*$/,
  /(?:^|\/)\.env(?:\.local)?$/,
];
for (const path of tracked.stdout.split("\0").filter(Boolean)) {
  if (operationalPatterns.some((pattern) => pattern.test(path))) {
    console.error(`${path}: tracked operational artifact; untrack it and keep it local`);
    failures += 1;
  }
}
if (failures) process.exitCode = 1;
else console.log("✓ operational safety checks passed");
