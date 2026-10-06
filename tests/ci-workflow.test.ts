import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";

const workflow: {
  env?: Record<string, string>;
  jobs: Record<
    string,
    {
      env?: Record<string, string>;
      steps: Array<{ uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> }>;
    }
  >;
} = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));

test.each(["verify", "browser"])("%s keeps the persistent runner's npm cache local", (job) => {
  const setup = workflow.jobs[job].steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
  expect(setup).toBeDefined();
  // Disabling automatic caching alone does not override an explicit `cache: npm`.
  expect(setup?.with?.cache).toBeUndefined();
  expect(setup?.with?.["package-manager-cache"]).toBe(false);
});

test("the Playwright network preload is scoped to browser installation", () => {
  const install = workflow.jobs.browser.steps.find((step) => step.run?.startsWith("npx playwright install "));
  expect(install?.env).toEqual({
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression inside the workflow-file string.
    NODE_OPTIONS: '--import="${{ github.workspace }}/scripts/playwright-download-network.mjs"',
  });
  expect(workflow.env?.NODE_OPTIONS ?? "").not.toContain("playwright-download-network.mjs");
  for (const job of Object.values(workflow.jobs)) {
    expect(job.env?.NODE_OPTIONS ?? "").not.toContain("playwright-download-network.mjs");
    for (const step of job.steps.filter((step) => step !== install)) {
      expect(step.env?.NODE_OPTIONS ?? "").not.toContain("playwright-download-network.mjs");
    }
  }
});
