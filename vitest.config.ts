import { defineConfig } from "vitest/config";

// Tests run in the Node environment against pure, renderer-free modules
// (security headers, migration manifest, bundle hygiene). The Worker test
// target that ticket 02 adds runs through the project's normal `npm test`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/worker/**/*.test.ts"],
    globals: false,
  },
  resolve: {
    tsconfigPaths: true,
  },
});