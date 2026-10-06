#!/usr/bin/env node
/**
 * Build-time secret-leak check (spec §3.5): after `npm run build`, scan every
 * file under build/client and fail if any candidate secret value appears.
 *
 * Candidate secrets come from:
 *   - every value in .dev.vars (local development secrets)
 *   - the MDWN_CHECK_SECRETS env var (comma-separated; CI feeds it the
 *     production HEALTHZ_TOKEN so its real value is checked without storing
 *     it in the repository)
 *   - any process.env entry whose name matches /(SECRET|TOKEN|KEY|PASSWORD)/
 *
 * Also always fails on private-key PEM blocks, which must never ship.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const CLIENT_DIR = resolve("build/client");
const SECRET_NAME_RE = /(SECRET|TOKEN|KEY|PASSWORD)/i;

if (!existsSync(CLIENT_DIR)) {
  console.error("✘ build/client not found — run `npm run build` before check:secrets");
  process.exit(1);
}

/** @type {Set<string>} */
const candidateValues = new Set();

const devVarsPath = resolve(".dev.vars");
if (existsSync(devVarsPath)) {
  for (const line of readFileSync(devVarsPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/);
    if (m && m[2].length > 0) candidateValues.add(m[2]);
  }
}

for (const value of (process.env.MDWN_CHECK_SECRETS ?? "").split(",")) {
  const v = value.trim();
  if (v.length > 0) candidateValues.add(v);
}

for (const [name, value] of Object.entries(process.env)) {
  if (SECRET_NAME_RE.test(name) && value && value.length >= 8) candidateValues.add(value);
}

// Ignore unreasonably short values to avoid false positives.
/** @type {string[]} */
const secrets = [...candidateValues].filter((v) => v.length >= 8);

/**
 * Recursively list files. Avoids implicit-any by framing the accumulator.
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = walk(CLIENT_DIR);
const violations = [];
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** @param {string} secret @returns {string} */
function sourceOf(secret) {
  if (existsSync(devVarsPath) && readFileSync(devVarsPath, "utf8").includes(secret)) {
    return ".dev.vars";
  }
  if (
    (process.env.MDWN_CHECK_SECRETS ?? "")
      .split(",")
      .map((s) => s.trim())
      .includes(secret)
  ) {
    return "MDWN_CHECK_SECRETS";
  }
  return "environment";
}

for (const file of files) {
  const rel = file.slice(CLIENT_DIR.length + 1);
  const content = readFileSync(file, "utf8");
  if (PEM.test(content)) violations.push(`${rel}: contains a private-key PEM block`);
  for (const secret of secrets) {
    if (content.includes(secret)) violations.push(`${rel}: contains a value from ${sourceOf(secret)}`);
  }
}

if (violations.length) {
  console.error(`✘ secret check failed — ${violations.length} violation(s) in build/client:`);
  for (const v of violations) console.error(`   - ${v}`);
  process.exit(1);
}

console.log(`✓ no candidate secrets found in ${files.length} client bundle files`);
process.exit(0);
