import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vitest/config";

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
        },
      },
    })),
  ],
  test: {
    include: ["tests/worker/**/*.test.ts"],
    // Too many parallel workerd instances make unrelated route tests exceed
    // Vitest's five-second timeout on the full suite, even though they pass alone.
    maxWorkers: 2,
    globals: false,
  },
  resolve: {
    tsconfigPaths: true,
  },
});
