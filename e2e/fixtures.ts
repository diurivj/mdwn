import { readFileSync } from "node:fs";

import { createTestHarness, type TestHarness } from "wrangler";
import { test as base, expect } from "@playwright/test";

export const TEST_SESSION_COOKIE_SECRET =
  "mdwn-browser-tests-only-not-a-deployment-secret";

type TestFixtures = {
  reset: void;
};

type WorkerFixtures = {
  server: TestHarness;
};

function localHttpsWorkerConfig() {
  const config = JSON.parse(
    readFileSync(new URL("../build/server/wrangler.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  const dev = (config.dev ?? {}) as Record<string, unknown>;
  const vars = (config.vars ?? {}) as Record<string, unknown>;

  return {
    ...config,
    dev: {
      ...dev,
      local_protocol: "https",
      upstream_protocol: "https",
    },
    vars: {
      ...vars, SESSION_COOKIE_SECRET: TEST_SESSION_COOKIE_SECRET,
      ABUSE_HMAC_SECRET: "mdwn-browser-abuse-tests-only-not-a-deployment-secret",
    },
  };
}

/**
 * Runs the browser suite against the production-shaped Worker build, not a
 * Node HTTP mock. The server fixture is shared by the tests in one Playwright
 * worker; reset recreates its local bindings after every test.
 */
export const test = base.extend<TestFixtures, WorkerFixtures>({
  server: [
    async ({}, use) => {
      const server = createTestHarness({
        // WebKit honors the production CSP's upgrade-insecure-requests. Serve
        // the built Worker over local TLS so its assets remain reachable and
        // WebAuthn runs in an actual secure context in every engine.
        root: "./build/server",
        workers: [
          {
            config: localHttpsWorkerConfig(),
          },
        ],
      });

      await server.listen();
      try {
        await use(server);
      } finally {
        await server.close();
      }
    },
    { scope: "worker" },
  ],

  baseURL: async ({ server }, use) => {
    const { url } = await server.listen();
    await use(url.href);
  },

  reset: [
    async ({ server }, use, testInfo) => {
      await use();

      if (testInfo.status !== testInfo.expectedStatus) {
        server.debug();
      }
      await server.reset();
    },
    { auto: true },
  ],
});

export { expect };
