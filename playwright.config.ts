import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  outputDir: "test-results",
  use: {
    // Wrangler generates a local development certificate for the test Worker.
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        // Playwright 1.63's Firefox can lose the commit of a page's first navigation to a COOP
        // document and hang `goto` (microsoft/playwright#42731). Only this test browser stops
        // applying COOP; the Worker still sends it, and Chromium and WebKit still enforce it.
        // Remove with the Playwright 1.64 upgrade (ticket 59, docs/testing.md).
        launchOptions: { firefoxUserPrefs: { "browser.tabs.remote.useCrossOriginOpenerPolicy": false } },
      },
    },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
