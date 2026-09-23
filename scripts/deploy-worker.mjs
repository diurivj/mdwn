#!/usr/bin/env node
/** Build, scan, and deploy one selected Worker with its signing secret. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** @param {string} command @param {string[]} args */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0]} failed`);
}

try {
  const target = process.argv[2];
  const dryRun = process.argv[3] === "--dry-run";
  if ((target !== "preview" && target !== "production") ||
      process.argv.length > (dryRun ? 4 : 3)) {
    throw new Error("Usage: deploy-worker.mjs <preview|production> [--dry-run]");
  }
  const secret = process.env.SESSION_COOKIE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_COOKIE_SECRET must contain at least 32 characters");
  }

  run("npm", ["run", `build:${target}`]);
  const config = JSON.parse(readFileSync("build/server/wrangler.json", "utf8"));
  const expectedName = target === "preview" ? "mdwn-preview" : "mdwn";
  if (config.name !== expectedName || config.vars?.APP_ENV !== target) {
    throw new Error("Built Worker does not match the requested deployment environment");
  }
  // Secret-named environment variables are scanned before anything is uploaded.
  run("npm", ["run", "check:secrets"]);

  const temporaryDirectory = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "mdwn-deploy-"));
  const secretFile = join(temporaryDirectory, "secrets.json");
  try {
    writeFileSync(secretFile, JSON.stringify({ SESSION_COOKIE_SECRET: secret }), { mode: 0o600 });
    run("npx", ["--no-install", "wrangler", "deploy", "--secrets-file", secretFile,
      ...(dryRun ? ["--dry-run", "--outdir", join(temporaryDirectory, "worker")] : [])]);
  } finally {
    // Only this invocation's newly created directory is removed.
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Worker deployment failed");
  process.exitCode = 1;
}
