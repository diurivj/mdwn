import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";

const workflow: {
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  jobs: Record<
    string,
    {
      env?: Record<string, string>;
      "runs-on": string | string[];
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

test("CI can save its npm cache and still limits contents to read", () => {
  expect(workflow.permissions).toEqual({ contents: "read", actions: "write" });
});

test.each(["verify", "browser"])("%s runs independently on a GitHub-hosted Ubuntu runner", (job) => {
  expect(workflow.jobs[job]["runs-on"]).toBe("ubuntu-latest");
  expect(workflow.jobs[job].needs).toBeUndefined();
  expect(workflow.jobs[job].steps.some((step) => step.run === "node scripts/ci-runner-diagnostics.mjs")).toBe(false);
});

test("WebKit checks CryptoKey storage after installation and before the browser suite", () => {
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

test.each(["verify", "browser"])("%s caches npm through setup-node", (job) => {
  const setup = workflow.jobs[job].steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
  expect(setup).toBeDefined();
  expect(setup?.with?.cache).toBe("npm");
  expect(setup?.with?.["package-manager-cache"]).not.toBe(false);
});

test("browser installation includes the Linux libraries for that engine", () => {
  const install = workflow.jobs.browser.steps.find((step) => step.run?.startsWith("npx playwright install "));
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression inside the workflow-file string.
  expect(install?.run).toBe("npx playwright install --with-deps ${{ matrix.browser }}");
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
