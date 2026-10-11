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
import { PublicOperationalError } from "./script-errors.mjs";

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

/** Avoid unmanaged raw diagnostic artifacts; see
 * docs/operations/d1-scripting.md#resource-identities-and-command-output.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function protectedWranglerEnv(env = process.env) {
  return { ...env, WRANGLER_WRITE_LOGS: "false" };
}

/**
 * Spawn the project's local wrangler. Returns the spawnSync result; stdout
 * and stderr are piped (use runWrangler for inherited progress output).
 * Buffer rationale: docs/operations/d1-scripting.md#node-process-pitfalls.
 * @param {string[]} args
 */
export function spawnWrangler(args) {
  return spawnSync("npx", ["--no-install", "wrangler", ...args], {
    stdio: "pipe",
    encoding: "utf8",
    env: protectedWranglerEnv(),
    // Digest pages need the larger buffer; see the scripting reference above.
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Run Wrangler with inherited stdio (progress visible); throw on failure so
 * the calling command owns cleanup and exit status.
 * @param {string[]} args
 * @param {string} label
 */
export function runWrangler(args, label) {
  const r = spawnSync("npx", ["--no-install", "wrangler", ...args], {
    stdio: "inherit",
    env: protectedWranglerEnv(),
  });
  if (r.status !== 0) {
    throw new PublicOperationalError(`${label} failed (exit ${r.status ?? 1})`, { cause: r.error });
  }
  return r;
}

/**
 * Run Wrangler with `--json` and return the parsed stdout, throwing on a
 * non-zero exit or non-JSON output. Scripted callers get one place that
 * handles the banner-free output and the raised `maxBuffer`.
 * @param {string[]} args @param {string} label @returns {any}
 */
export function runWranglerJson(args, label) {
  const result = spawnWrangler([...args, "--json"]);
  if (result.status !== 0) {
    throw new PublicOperationalError(`${label} failed (exit ${result.status ?? 1})`, { cause: result.error });
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new PublicOperationalError(`${label} returned non-JSON output`);
  }
}
