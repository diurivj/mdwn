#!/usr/bin/env node
/** Refuse a deploy step whose Wrangler home can reach the runner account. */
import { homedir } from "node:os";

import { assertWorkspaceWranglerHome } from "./lib/deploy-host.mjs";

try {
  assertWorkspaceWranglerHome(process.env, homedir());
} catch (error) {
  console.error(error instanceof Error ? error.message : "Deploy workspace check failed");
  process.exitCode = 1;
}
