import type { Page } from "@playwright/test";

/**
 * Wait for the page's lazy route modules before navigating it again: a navigation that aborts an
 * in-flight module import makes React Router reload the old page and cancel ours (Firefox reports
 * NS_BINDING_ABORTED, WebKit reports "interrupted by another navigation"), which callers retry.
 *
 * The wait is capped rather than unbounded. The Worker harness can leave a response body
 * undelivered — the page receives the status, which is all the app reads for a missing object,
 * but Chromium never reports the document as network-idle, so waiting on it would hang the test
 * forever. A page that settles normally still does so in under a second.
 */
export async function settled(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
}
