/**
 * Ticket 70: iOS zooms the page into a text control under 16px when it gains
 * focus, and stays zoomed. On touch screens every text control is at least
 * 16px, whatever its utility size; with a mouse the compact sizes stay.
 */

import type { Locator, Page } from "@playwright/test";
import { publishToggle } from "./publish-panel";
import { test, expect } from "./workspace-fixture";

/** Each visible text control's computed font size in CSS pixels, by its label. */
function textControlSizes(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const sizes: Record<string, number> = {};
    for (const control of document.querySelectorAll<HTMLInputElement>("input, textarea, select")) {
      if (control.type === "checkbox" || control.type === "radio" || !control.checkVisibility()) continue;
      const name = control.getAttribute("aria-label") ?? control.labels?.[0]?.textContent?.trim() ?? control.id;
      sizes[name] = Number.parseFloat(getComputedStyle(control).fontSize);
    }
    return sizes;
  });
}

async function expectNoZoomingControls(page: Page, names: string[]) {
  const sizes = await textControlSizes(page);
  expect(Object.keys(sizes)).toEqual(expect.arrayContaining(names));
  for (const [name, size] of Object.entries(sizes)) expect(size, name).toBeGreaterThanOrEqual(16);
}

/** Publishes the open File; its Public link field uses the smallest field text, `text-xs`. */
async function publicLinkField(page: Page): Promise<Locator> {
  await publishToggle(page).click();
  const panel = page.getByRole("region", { name: "Publish", exact: true });
  await panel.getByRole("button", { name: "Publish File" }).click();
  const link = panel.getByLabel("Public link");
  await expect(link).toBeVisible();
  return link;
}

const PHONE = { width: 390, height: 844 };

test.describe("on a touch screen", () => {
  // A touch screen at the desktop size first: the workspace fixture opens the File there.
  test.use({ hasTouch: true });

  test("signup fields and every kind of text control are at least 16px", async ({ page, baseURL }) => {
    await page.setViewportSize(PHONE);
    await page.goto(new URL("/sign-up", baseURL!).href);
    await expect(page.getByLabel("Public pseudonym")).toBeVisible();
    // The import select and the share expiry date, at the smallest utility size the app uses.
    await page.evaluate(() =>
      document.body.insertAdjacentHTML(
        "beforeend",
        '<select aria-label="Select" class="text-xs"><option>One</option></select>' +
          '<input aria-label="Date" type="date" class="text-xs">',
      ),
    );
    await expectNoZoomingControls(page, ["Public pseudonym", "Select", "Date"]);
  });

  test("the Markdown editor and the Public link field are at least 16px", async ({ page, workspace }) => {
    await expect(page).toHaveURL(new RegExp(`/f/${workspace.fileId}$`));
    await page.setViewportSize(PHONE);
    await expect(page.getByRole("textbox", { name: "Markdown source", exact: true })).toBeVisible();
    await publicLinkField(page);
    await expectNoZoomingControls(page, ["Markdown source", "Public link"]);
  });
});

test("with a mouse, text controls keep their compact sizes", async ({ page, workspace }) => {
  await expect(page).toHaveURL(new RegExp(`/f/${workspace.fileId}$`));
  await expect(page.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveCSS("font-size", "13.5px");
  await expect(await publicLinkField(page)).toHaveCSS("font-size", "12px");
});
