import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vitest/config";

import { supportAddressBindings } from "./tests/support/donation-fixtures.ts";

export default defineConfig({
  plugins: [
    reactRouter(),
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./drizzle"),
          HEALTHZ_TOKEN: "mdwn-worker-test-health-probe-not-a-deployment-secret",
          SESSION_COOKIE_SECRET: "mdwn-worker-tests-only-not-a-deployment-secret",
          ABUSE_HMAC_SECRET: "mdwn-worker-abuse-tests-only-not-a-deployment-secret",
          ...supportAddressBindings(),
        },
      },
    })),
  ],
  test: {
    include: ["tests/worker/**/*.test.ts"],
    // Real crypto, D1 migrations, and route startup vary across CI runners;
    // bound workerd concurrency and allow integration tests enough time to finish.
    maxWorkers: 2,
    testTimeout: 15_000,
    globals: false,
  },
  resolve: {
    tsconfigPaths: true,
  },
});
