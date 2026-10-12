import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

test("CI bounds Node Vitest and Playwright without changing retries or project coverage", async () => {
  vi.stubEnv("CI", "true");
  vi.resetModules();
  const node = (await import("../vitest.config")).default;
  const browser = (await import("../playwright.config")).default;
  expect(node.test?.maxWorkers).toBe(2);
  expect(browser.workers).toBe(1);
  expect(browser.retries).toBe(1);
  expect(browser.fullyParallel).toBe(false);
  expect(browser.projects?.map((project) => project.name)).toEqual(["chromium", "firefox", "webkit"]);
  expect(browser.reporter).toContainEqual(["json", { outputFile: "playwright-results.json" }]);
});

test("local worker defaults and zero retries remain unchanged", async () => {
  vi.stubEnv("CI", undefined);
  vi.resetModules();
  const node = (await import("../vitest.config")).default;
  const browser = (await import("../playwright.config")).default;
  expect(node.test?.maxWorkers).toBeUndefined();
  expect(browser.workers).toBeUndefined();
  expect(browser.retries).toBe(0);
});
