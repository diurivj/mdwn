import { createTestHarness, type TestHarness } from "wrangler";
import { test as base, expect } from "@playwright/test";

type TestFixtures = {
  reset: void;
};

type WorkerFixtures = {
  server: TestHarness;
};

/**
 * Runs the browser suite against the production-shaped Worker build, not a
 * Node HTTP mock. The server fixture is shared by the tests in one Playwright
 * worker; reset recreates its local bindings after every test.
 */
export const test = base.extend<TestFixtures, WorkerFixtures>({
  server: [
    async ({}, use) => {
      const server = createTestHarness({
        workers: [{ configPath: "./build/server/wrangler.json" }],
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
