/**
 * Keep deploy credentials inside the GitHub Actions job workspace.
 *
 * Wrangler 4.135.0 has no WRANGLER_HOME. Path rules:
 * docs/operations/d1-scripting.md#resource-identities-and-command-output.
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, sep } from "node:path";

/** Prefer the job workspace over the runner temp directory.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function deployScratchRoot(env = process.env) {
  if (env.GITHUB_WORKSPACE) return env.GITHUB_WORKSPACE;
  return env.RUNNER_TEMP || tmpdir();
}

/** @param {string} parent @param {string} child */
function isContained(parent, child) {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/** @param {string} path @param {string} label */
function existingDirectory(path, label) {
  if (!path || !isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path inside the job workspace`);
  }
  try {
    return realpathSync(path);
  } catch {
    throw new Error(`${label} must exist inside the job workspace`);
  }
}

/**
 * Fail closed unless this process will keep Wrangler's home, config, cache,
 * temp, and logs inside the job workspace, away from the runner account.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home directory Node and Wrangler resolve as the home
 */
export function assertWorkspaceWranglerHome(env, home) {
  if (env.WRANGLER_WRITE_LOGS !== "false") {
    throw new Error("WRANGLER_WRITE_LOGS must be false");
  }
  const workspace = existingDirectory(env.GITHUB_WORKSPACE ?? "", "Job workspace");
  const accountHome = existingDirectory(env.MDWN_ACCOUNT_HOME ?? "", "Account home");
  if (accountHome === workspace || isContained(workspace, accountHome)) {
    throw new Error("The account home must stay outside the job workspace");
  }
  const resolvedHome = existingDirectory(home, "Wrangler home");
  const envHome = existingDirectory(env.HOME ?? "", "HOME");
  if (resolvedHome !== envHome || resolvedHome === accountHome || !isContained(workspace, resolvedHome)) {
    throw new Error("Wrangler home must stay inside the job workspace");
  }
  for (const [label, path] of [
    ["Wrangler config directory", env.XDG_CONFIG_HOME ?? ""],
    ["Wrangler cache directory", env.XDG_CACHE_HOME ?? ""],
    ["Wrangler temp directory", env.TMPDIR ?? ""],
  ]) {
    if (!isContained(workspace, existingDirectory(path, label))) {
      throw new Error("Wrangler config, cache, temp, and logs must stay inside the job workspace");
    }
  }
  const logPath = env.WRANGLER_LOG_PATH ?? "";
  if (!isAbsolute(logPath)) {
    throw new Error("WRANGLER_LOG_PATH must be an absolute path inside the job workspace");
  }
  const logDir = existingDirectory(dirname(logPath), "Wrangler log directory");
  if (!isContained(workspace, logDir)) {
    throw new Error("Wrangler config, cache, temp, and logs must stay inside the job workspace");
  }
}
