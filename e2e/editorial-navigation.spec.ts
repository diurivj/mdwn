import { test, expect } from "./fixtures";

// Exercise the public shell against the built Worker, including native dialog
// behavior and first-party font loading in each supported browser engine.
test("lands on the editorial page and navigates its sections without document reloads", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Write in Markdown. Keep the key.");
  await expect(page.getByRole("main")).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.getByRole("heading", { level: 1 }).evaluate((node) => getComputedStyle(node).fontFamily)).toContain(
    "Instrument Serif",
  );
  const fonts = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => /\.woff2?(\?|$)/.test(url)),
  );
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.every((font) => new URL(font).origin === new URL(page.url()).origin)).toBe(true);

  const originalDocument = await page.evaluateHandle(() => window.document);
  await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name: "Privacy" }).click();
  await expect(page.locator("#privacy")).toBeInViewport();
  expect(await originalDocument.evaluate((original) => original === window.document)).toBe(true);
  await originalDocument.dispose();

  await page.getByText("Can mdwn read my Files?", { exact: true }).click();
  await expect(page.locator("details[open]")).toContainText("encrypted in your browser");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("landing-desktop.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("mobile menu supports keyboard dismissal, section links and account entry", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Open menu", exact: true });
  const menu = page.getByRole("dialog", { name: "Menu", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await menu.getByRole("link", { name: "Privacy", exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(page.locator("#privacy")).toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("landing-mobile.png"), fullPage: true });
  await trigger.click();
  await menu.getByRole("link", { name: "Create account", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-up$/);
  await expect(menu).toBeHidden();
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("Files entry explains device access instead of leaving a signed-out visitor on a skeleton", async ({ page }) => {
  await page.goto("/files");
  await expect(page).toHaveURL(/\/account\/device-access$/);
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Sign in to access your Files", exact: true })).toBeVisible();
  await expect(page.getByText("Opening Files", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("banner").getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
});
