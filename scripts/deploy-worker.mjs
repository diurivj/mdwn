#!/usr/bin/env node
/** Build, scan, and deploy one selected Worker with its runtime secrets. */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { deployedVersionId } from "./lib/deployment-readiness.mjs";
import { deployScratchRoot } from "./lib/deploy-host.mjs";

/** @param {string} command @param {string[]} args @param {boolean} [capture] */
function run(command, args, capture = false) {
  const result = spawnSync(
    command,
    args,
    capture
      ? { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }
      : { stdio: "inherit" },
  );
  if (capture) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
  }
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0]} failed`);
  return capture ? `${result.stdout ?? ""}\n${result.stderr ?? ""}` : "";
}

try {
  const target = process.argv[2];
  const dryRun = process.argv[3] === "--dry-run";
  if ((target !== "preview" && target !== "production") || process.argv.length > (dryRun ? 4 : 3)) {
    throw new Error("Usage: deploy-worker.mjs <preview|production> [--dry-run]");
  }
  const sessionSecret = process.env.SESSION_COOKIE_SECRET;
  const abuseSecret = process.env.ABUSE_HMAC_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error("SESSION_COOKIE_SECRET must contain at least 32 characters");
  }
  if (!abuseSecret || abuseSecret.length < 32) {
    throw new Error("ABUSE_HMAC_SECRET must contain at least 32 characters");
  }
  if (sessionSecret === abuseSecret) {
    throw new Error("SESSION_COOKIE_SECRET and ABUSE_HMAC_SECRET must be distinct");
  }

  run("npm", ["run", `build:${target}`]);
  const config = JSON.parse(readFileSync("build/server/wrangler.json", "utf8"));
  const expectedName = target === "preview" ? "mdwn-preview" : "mdwn";
  if (
    config.name !== expectedName ||
    config.vars?.APP_ENV !== target ||
    config.version_metadata?.binding !== "CF_VERSION_METADATA"
  ) {
    throw new Error("Built Worker does not match the requested deployment environment or version binding");
  }
  // Secret-named environment variables are scanned before anything is uploaded.
  run("npm", ["run", "check:secrets"]);

  // Actions sets RUNNER_TEMP outside the job workspace. Keep the secrets file
  // in the workspace so the persistent runner does not retain it in its temp dir.
  const temporaryDirectory = mkdtempSync(join(deployScratchRoot(), "mdwn-deploy-"));
  const secretFile = join(temporaryDirectory, "secrets.json");
  try {
    writeFileSync(
      secretFile,
      JSON.stringify({
        SESSION_COOKIE_SECRET: sessionSecret,
        ABUSE_HMAC_SECRET: abuseSecret,
      }),
      { mode: 0o600 },
    );
    const output = run(
      "npx",
      [
        "--no-install",
        "wrangler",
        "deploy",
        "--secrets-file",
        secretFile,
        ...(dryRun ? ["--dry-run", "--outdir", join(temporaryDirectory, "worker")] : []),
      ],
      !dryRun,
    );
    if (!dryRun) {
      const versionId = deployedVersionId(output);
      // GitHub Actions reads this value only after Wrangler has deployed it.
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `version_id=${versionId}\n`);
      }
    }
  } finally {
    // Only this invocation's newly created directory is removed.
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Worker deployment failed");
  process.exitCode = 1;
}
