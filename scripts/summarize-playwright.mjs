#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { summarizePlaywright } from "./lib/ci-timing.mjs";

const summary = summarizePlaywright(JSON.parse(readFileSync("playwright-results.json", "utf8")));
writeFileSync("playwright-summary.json", `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nBrowser results: ${JSON.stringify(summary)}\n`);
}
