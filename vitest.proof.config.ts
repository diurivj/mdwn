import { defineConfig } from "vitest/config";

/**
 * Node-only runner for the disposable remote Workers Free + D1 proof
 * (ticket 26/30). It is never part of `npm test`; run it through
 * `node scripts/import-proof.mjs`, which provisions the deployment, seeds a
 * device-bound Session, and passes the connection values in the environment.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/proof/**/*.test.ts"],
    globals: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
    fileParallelism: false,
  },
  resolve: {
    tsconfigPaths: true,
  },
});
