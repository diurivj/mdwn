import type { Page } from "@playwright/test";

import { waitForSharedProvisioning } from "./support/navigation";
import { test, expect } from "./workspace-fixture";

/** Count requests by pathname from now on, including background fetcher reads. */
function countRequests(page: Page) {
  const counts = new Map<string, number>();
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  });
  return (path: string) => counts.get(path) ?? 0;
}

async function openLibrary(page: Page) {
  await page
    .getByRole("complementary", { name: "Files tree", exact: true })
    .getByRole("link", { name: "Library", exact: true })
    .click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
}

async function openDraft(page: Page) {
  await page
    .getByRole("navigation", { name: "Files", exact: true })
    .getByRole("link", { name: "Draft.md", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Draft.md", exact: true })).toBeVisible();
}

// Ticket 57: background reads start on hydration, focus and authentication
// changes, and upkeep at most once a minute, not once per navigation.
test("in-app navigation reuses Session presence, device state and background upkeep", async ({ page, workspace }) => {
  expect(workspace.fileId).toBeTruthy();
  const sent = countRequests(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Draft.md", exact: true })).toBeVisible();
  await waitForSharedProvisioning(page);
  await expect.poll(() => sent("/api/auth/session")).toBe(1);
  expect(sent("/api/private/grant-provisioning/next")).toBe(1);
  const stateReads = sent("/api/device/state");

  for (let round = 0; round < 2; round++) {
    await openLibrary(page);
    await waitForSharedProvisioning(page);
    await openDraft(page);
    await waitForSharedProvisioning(page);
  }

  expect(sent("/api/auth/session")).toBe(1);
  expect(sent("/api/private/grant-provisioning/next")).toBe(1);
  expect(sent("/api/private/recovery-provision/next")).toBe(1);
  // Each private response returns the next device state, so sequential
  // operations seconds apart sign without reading it again.
  expect(sent("/api/device/state")).toBe(stateReads);

  // Returning to the tab re-reads Session presence for another tab's change.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => sent("/api/auth/session")).toBe(2);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => sent("/api/auth/session")).toBe(3);
});
