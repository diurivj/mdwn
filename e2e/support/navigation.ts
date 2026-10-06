import type { Page } from "@playwright/test";
import { expect } from "../fixtures";

/** Call after the ready Files/device-access UI appears, before deliberately
 * replacing its document. A visible heading does not mean the background
 * fetcher's lazy route import has finished; WebKit cancels it on navigation. */
export async function waitForSharedProvisioning(page: Page) {
  await expect(page.getByRole("region", { name: "Shared access provisioning", exact: true })).toHaveAttribute(
    "aria-busy",
    "false",
  );
}
