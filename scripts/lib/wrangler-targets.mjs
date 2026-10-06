/**
 * Shared operational helpers for the wrangler-based scripts.
 *
 * The environment triad below is the single source of truth for how each
 * environment resolves in Wrangler:
 *   - `local`      -> the default (top-level) wrangler environment, --local
 *   - `preview`    -> wrangler env "preview"   (worker mdwn-preview,   D1 mdwn-db-preview)
 *   - `production` -> wrangler env "production" (worker mdwn,           D1 mdwn-db-production)
 * It must stay in lockstep with the `env` block in wrangler.jsonc and the
 * `deploy:*`/`db:*` script names in package.json.
 */
import { spawnSync } from "node:child_process";

export const ENVIRONMENTS = ["local", "preview", "production"];

/** @type {Record<string, { envFlag: string[]; extra: string[] }>} */
export const WRANGLER_TARGETS = {
  local: { envFlag: [], extra: ["--local"] },
  preview: { envFlag: ["--env=preview"], extra: ["--remote"] },
  production: { envFlag: ["--env=production"], extra: ["--remote"] },
};

/** @param {string} name */
export function isEnvironment(name) {
  return ENVIRONMENTS.includes(name);
}

/**
 * Spawn the project's local wrangler. Returns the spawnSync result; stdout
 * and stderr are piped (use stdio:"inherit" via runWranglerInherit for CI UX).
 * @param {string[]} args
 */
export function spawnWrangler(args) {
  return spawnSync("npx", ["--no-install", "wrangler", ...args], {
    stdio: "pipe",
    encoding: "utf8",
    // Digest verification pages can legitimately return tens of MB of quoted
    // ciphertext; the 1 MB spawnSync default truncates them into invalid JSON.
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Run wrangler with inherited stdio (progress visible); exit non-zero on
 * failure.
 * @param {string[]} args
 * @param {string} label
 */
export function runWrangler(args, label) {
  const r = spawnSync("npx", ["--no-install", "wrangler", ...args], {
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error(`✘ ${label} failed`);
    process.exit(r.status ?? 1);
  }
  return r;
}