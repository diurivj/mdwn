import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";

const workflow: {
  jobs: Record<string, {
    steps: Array<{ uses?: string; with?: Record<string, unknown> }>;
  }>;
} = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));

test.each(["verify", "browser"])("%s keeps the persistent runner's npm cache local", (job) => {
  const setup = workflow.jobs[job].steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
  expect(setup).toBeDefined();
  // Disabling automatic caching alone does not override an explicit `cache: npm`.
  expect(setup?.with?.cache).toBeUndefined();
  expect(setup?.with?.["package-manager-cache"]).toBe(false);
});
