#!/usr/bin/env node
/** Wait until the exact newly deployed Worker answers all smoke probes. */
import { waitForDeployment } from "./lib/deployment-readiness.mjs";

try {
  const target = process.argv[2];
  if ((target !== "preview" && target !== "production") || process.argv.length !== 3) {
    throw new Error("Usage: check-worker-ready.mjs <preview|production>");
  }
  await waitForDeployment({
    target,
    expectedVersionId: process.env.DEPLOYED_VERSION_ID ?? "",
    token: process.env.HEALTHZ_TOKEN ?? "",
  });
  console.log(`✓ ${target}: deployed Worker version passed health, Session, and CSP probes`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Worker readiness failed");
  process.exitCode = 1;
}
