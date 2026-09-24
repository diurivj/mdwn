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
        },
      },
    })),
  ],
  test: {
    include: ["tests/worker/**/*.test.ts"],
    globals: false,
  },
  resolve: {
    tsconfigPaths: true,
  },
});
