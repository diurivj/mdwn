import { stripVTControlCharacters } from "node:util";

const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORIGINS = {
  preview: "https://mdwn-preview.diurivj.workers.dev",
  production: "https://mdwn.diurivj.workers.dev",
};

/** @param {string} output Wrangler 4.135's deploy output. */
export function deployedVersionId(output) {
  const ids = [
    ...stripVTControlCharacters(output).matchAll(
      /^[ \t]*Current Version ID: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[ \t]*\r?$/gim,
    ),
  ];
  if (ids.length !== 1) throw new Error("Expected exactly one Wrangler Current Version ID");
  return ids[0][1];
}

/** @param {number} ms */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for this deployment, not merely the previous Worker's healthy /healthz.
 * Cloudflare can serve an older Worker briefly after Wrangler reports success.
 *
 * @param {{target: 'preview' | 'production', expectedVersionId: string, token: string,
 *   maxAttempts?: number, delayMs?: number, fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>}} options
 */
export async function waitForDeployment({
  target,
  expectedVersionId,
  token,
  maxAttempts = 12,
  delayMs = 2_000,
  fetchImpl = fetch,
  sleep = pause,
}) {
  const origin = ORIGINS[target];
  if (
    !origin ||
    !VERSION_ID.test(expectedVersionId) ||
    !token ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    !Number.isInteger(delayMs) ||
    delayMs < 0
  ) {
    throw new Error("Worker readiness requires a target, deployed version ID, token, and bounded retries");
  }

  /** @param {string} path @param {RequestInit} [init] */
  const request = (path, init) =>
    fetchImpl(`${origin}${path}`, {
      ...init,
      signal: AbortSignal.timeout(5_000),
    });
  let lastFailure = "no response";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const health = await request("/healthz", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (health.status === 401 || health.status === 403) {
        throw new Error("health probe unauthorized; check the configured token");
      }
      if (!health.ok) {
        lastFailure = `health HTTP ${health.status}`;
      } else {
        const body = await health.json();
        if (body.versionId !== expectedVersionId) {
          lastFailure = `health version ${VERSION_ID.test(body.versionId) ? body.versionId : "missing"} is not the deployed version`;
        } else if (body.ok !== true || body.appEnv !== target || body.db !== "connected") {
          lastFailure = "deployed version reported an unhealthy Worker";
        } else {
          const session = await request("/api/auth/session");
          if (!session.ok) {
            lastFailure = `anonymous Session HTTP ${session.status}`;
          } else if ((await session.json()).authenticated !== false) {
            lastFailure = "anonymous Session did not report unauthenticated";
          } else {
            const shell = await request("/", { method: "HEAD" });
            const csp = shell.headers.get("Content-Security-Policy") ?? "";
            if (shell.ok && /(?:^|;)\s*default-src 'none'(?:;|$)/i.test(csp)) {
              return;
            }
            lastFailure = `shell HTTP ${shell.status} or CSP missing`;
          }
        }
      }
    } catch (error) {
      // Invalid credentials cannot become valid by waiting for rollout.
      if (error instanceof Error && error.message.startsWith("health probe unauthorized")) {
        throw error;
      }
      lastFailure = error instanceof Error ? error.name : "request failed";
    }

    if (attempt < maxAttempts) {
      console.log(`Readiness ${target}: ${lastFailure}; retry ${attempt}/${maxAttempts}`);
      await sleep(delayMs);
    }
  }
  throw new Error(`Readiness ${target} failed after ${maxAttempts} attempts: ${lastFailure}`);
}
