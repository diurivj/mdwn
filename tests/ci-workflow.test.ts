import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";

const workflow: {
  env?: Record<string, string>;
  jobs: Record<
    string,
    {
      env?: Record<string, string>;
      "runs-on": string[];
      needs?: unknown;
      strategy?: { "fail-fast": boolean; "max-parallel"?: number; matrix: { browser: string[] } };
      steps: Array<{
        uses?: string;
        run?: string;
        if?: string;
        with?: Record<string, unknown>;
        env?: Record<string, string>;
      }>;
    }
  >;
} = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));

test.each(["verify", "browser"])("%s routes independent jobs to the bounded ARM64 pool", (job) => {
  expect(workflow.jobs[job]["runs-on"]).toEqual(["self-hosted", "macOS", "ARM64", "mini-m4pro-ci"]);
  expect(workflow.jobs[job].needs).toBeUndefined();
  const diagnostics = workflow.jobs[job].steps.findIndex(
    (step) => step.run === "node scripts/ci-runner-diagnostics.mjs",
  );
  const install = workflow.jobs[job].steps.findIndex((step) => step.run === "npm ci");
  expect(diagnostics).toBeGreaterThan(-1);
  expect(diagnostics).toBeLessThan(install);
});

test("WebKit checks service CryptoKey storage after installation and before the unchanged browser suite", () => {
  const steps = workflow.jobs.browser.steps;
  const check = steps.findIndex((step) => step.run === "node scripts/probe-ci-webkit-storage.mjs");
  const install = steps.findIndex((step) => step.run?.startsWith("npx playwright install "));
  const suite = steps.findIndex((step) => step.run?.startsWith("npm run test:e2e "));
  expect(check).toBeGreaterThan(install);
  expect(check).toBeLessThan(suite);
  expect(steps[check].if).toBe("matrix.browser == 'webkit'");
});

test("all three browsers remain independent with failure and retry diagnostics on each attempt", () => {
  expect(workflow.jobs.browser.strategy).toEqual({
    "fail-fast": false,
    matrix: { browser: ["chromium", "firefox", "webkit"] },
  });
  const artifact = workflow.jobs.browser.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Actions expressions distinguish rerun artifacts.
  expect(artifact?.with?.name).toBe("playwright-${{ matrix.browser }}-${{ github.run_id }}-${{ github.run_attempt }}");
  expect(artifact?.with?.path).toContain("playwright-results.json");
  expect(artifact?.with?.path).toContain("playwright-summary.json");
});

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
