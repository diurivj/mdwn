import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";

const source = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
const ci = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")) as {
  concurrency: { group: string };
};

const workflow: {
  permissions?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  defaults?: { run?: { shell?: string } };
  jobs: Record<
    string,
    {
      if?: string;
      env?: Record<string, string>;
      "runs-on": string[];
      "timeout-minutes"?: number;
      steps: Array<{
        name?: string;
        id?: string;
        uses?: string;
        run?: string;
        if?: string;
        with?: Record<string, unknown>;
        env?: Record<string, string>;
      }>;
    }
  >;
} = parse(source);

const job = workflow.jobs.deploy;

function github(expression: string) {
  return ["$", "{{ ", expression, " }}"].join("");
}

const workspaceHome = `${github("github.workspace")}/.deploy-wrangler-home`;
const wranglerHomeEnv = {
  HOME: workspaceHome,
  XDG_CONFIG_HOME: `${workspaceHome}/.config`,
  XDG_CACHE_HOME: `${workspaceHome}/.cache`,
  TMPDIR: `${workspaceHome}/tmp`,
  WRANGLER_LOG_PATH: `${workspaceHome}/wrangler.log`,
  WRANGLER_WRITE_LOGS: "false",
  WRANGLER_SEND_METRICS: "false",
};

function isWranglerStep(step: { run?: string; env?: Record<string, string> }) {
  return step.env?.CLOUDFLARE_API_TOKEN !== undefined || (step.run?.includes("npm run db:") ?? false);
}

test("deploy uses one mini slot and does not share CI's concurrency group", () => {
  expect(job["runs-on"]).toEqual(["self-hosted", "macOS", "ARM64", "mini-m4pro-ci"]);
  expect(job["timeout-minutes"]).toBe(30);
  expect(job.if).toBe("github.ref == 'refs/heads/main'");
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.defaults?.run?.shell).toBe("bash --noprofile --norc -eo pipefail {0}");
  expect(workflow.concurrency).toEqual({
    group: `deploy-${github("github.ref")}`,
    "cancel-in-progress": false,
  });
  expect(workflow.concurrency?.group).not.toBe(ci.concurrency.group);
  expect(source).not.toContain("ubuntu-latest");
  expect(job.env).toBeUndefined();
});

test("npm stays on the persistent host and the workspace is cleaned around the job", () => {
  const setup = job.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
  expect(setup?.with?.["node-version"]).toBe(24);
  expect(setup?.with?.cache).toBeUndefined();
  expect(setup?.with?.["package-manager-cache"]).toBe(false);
  const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  expect(checkout?.with?.["persist-credentials"]).toBe(false);
  expect(job.steps[0]?.run).toContain('find "$GITHUB_WORKSPACE"');
  expect(job.steps[0]?.if).toBeUndefined();
  const cleanup = job.steps.at(-1);
  expect(cleanup?.if).toBe(github("always()"));
  expect(cleanup?.run).toContain('find "$GITHUB_WORKSPACE"');
  expect(cleanup?.env).toBeUndefined();
  const diagnostics = job.steps.findIndex((step) => step.run === "node scripts/ci-runner-diagnostics.mjs");
  const install = job.steps.findIndex((step) => step.run === "npm ci");
  expect(diagnostics).toBeGreaterThan(-1);
  expect(diagnostics).toBeLessThan(install);
});

test("preview still migrates, deploys, and smokes before production", () => {
  const names = job.steps.map((step) => step.name);
  const preview = [
    "Apply migrations to preview D1",
    "Build and deploy preview Worker",
    "Smoke-test preview (schema + healthz + headers)",
  ];
  const production = [
    "Apply migrations to production D1",
    "Build and deploy production Worker",
    "Smoke-test production (schema + healthz + headers)",
  ];
  const indexes = [...preview, ...production].map((name) => names.indexOf(name));
  expect(indexes.every((index) => index >= 0)).toBe(true);
  expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  expect(job.steps.find((step) => step.id === "deploy_preview")?.name).toBe("Build and deploy preview Worker");
  expect(job.steps.find((step) => step.id === "deploy_production")?.name).toBe("Build and deploy production Worker");
  expect(source).not.toContain("/tmp/");
  expect(source).toContain("operational-artifacts/mdwn-preview-query-plans.md");
  expect(source).toContain("operational-artifacts/mdwn-production-query-plans.md");
});

test("Cloudflare secrets are step env on workspace-contained Wrangler steps", () => {
  const wranglerSteps = job.steps.filter((step) => isWranglerStep(step));
  expect(wranglerSteps.map((step) => step.name)).toEqual([
    "Apply migrations to preview D1",
    "Build and deploy preview Worker",
    "Smoke-test preview (schema + healthz + headers)",
    "Apply migrations to production D1",
    "Build and deploy production Worker",
    "Smoke-test production (schema + healthz + headers)",
  ]);
  for (const step of wranglerSteps) {
    expect(step.env).toMatchObject(wranglerHomeEnv);
    expect(step.env?.CLOUDFLARE_API_TOKEN).toBe(github("secrets.CLOUDFLARE_API_TOKEN"));
    expect(step.env?.CLOUDFLARE_ACCOUNT_ID).toBe("82b5863d9c1860c06d7365110eab8366");
    expect(step.run?.trimStart().startsWith("node scripts/check-deploy-workspace-home.mjs\n")).toBe(true);
  }
  const validate = job.steps.find(
    (step) => step.name === "Validate Session and abuse-control secrets before migrations",
  );
  expect(validate?.env?.CLOUDFLARE_API_TOKEN).toBeUndefined();
  expect(validate?.env?.HOME).toBeUndefined();
  expect(validate?.env?.SESSION_COOKIE_SECRET_PREVIEW).toBe(github("secrets.SESSION_COOKIE_SECRET_PREVIEW"));
  expect(validate?.env?.ABUSE_HMAC_SECRET_PRODUCTION).toBe(github("secrets.ABUSE_HMAC_SECRET_PRODUCTION"));
  expect(validate?.run).not.toContain("check-deploy-workspace-home");
  for (const step of job.steps) {
    if (wranglerSteps.includes(step) || step === validate) continue;
    expect(step.env?.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(step.env?.SESSION_COOKIE_SECRET).toBeUndefined();
    expect(step.env?.ABUSE_HMAC_SECRET).toBeUndefined();
    expect(step.env?.HEALTHZ_TOKEN).toBeUndefined();
    expect(JSON.stringify(step.env ?? {})).not.toContain("secrets.");
  }
});
