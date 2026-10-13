import type { Locator, Page } from "@playwright/test";
import { expect } from "./workspace-fixture";

/** The File header's Publish panel toggle: "Publish" until the File is published, then "Published". */
export function publishToggle(page: Page): Locator {
  return page.getByRole("button", { name: /^Publish(ed)?$/ });
}

/** The Publish panel's summary of how the File is published right now. */
export function publishedSummary(panel: Locator): Locator {
  return panel.getByRole("region", { name: "How it’s published", exact: true });
}

/**
 * Changes the Comment audience on the current link from the panel's settings
 * form, and waits for the refreshed summary to show it.
 */
export async function changeCommentAudience(panel: Locator, audience: "Public" | "Collaborators only") {
  await panel.getByRole("button", { name: "Change settings", exact: true }).click();
  const form = panel.getByRole("form", { name: "Change settings", exact: true });
  await form.getByRole("radio", { name: audience, exact: true }).check();
  await form.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(publishedSummary(panel).getByText(`${audience}.`, { exact: true })).toBeVisible();
}
