import { test, expect } from "./fixtures";

// Exercise the public shell against the built Worker, including native dialog
// behavior and first-party font loading in each supported browser engine.
test("lands on the Laboratorio page and navigates its sections without document reloads", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Write in Markdown. Keep the key.");
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link")).toHaveText([
    "How it works",
    "Privacy",
    "Publishing",
    "Support",
  ]);
  await page.evaluate(() => document.fonts.ready);
  const heading = page.getByRole("heading", { level: 1 });
  expect(await heading.evaluate((node) => getComputedStyle(node).fontFamily)).toContain("Inter Tight Variable");
  await expect(heading).toHaveCSS("font-weight", "300");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(238, 236, 230)");
  const label = page.getByText("Private Markdown", { exact: true });
  expect(await label.evaluate((node) => getComputedStyle(node).fontFamily)).toContain("Courier Prime");
  await expect(page.getByRole("main").getByRole("link", { name: "Create your account" }).first()).toHaveCSS(
    "border-radius",
    "0px",
  );
  expect(await page.evaluate(() => document.fonts.check('300 16px "Inter Tight Variable"'))).toBe(true);
  expect(await page.evaluate(() => document.fonts.check('400 12px "Courier Prime"'))).toBe(true);
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

test("uses plain labels for unordered content and keeps meaningful numbers", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".eyebrow").filter({ hasText: /^\d+\s*—|^Specimen \d+|^Q\.\d+$/ })).toHaveCount(0);
  await expect(page.getByRole("contentinfo").locator(".eyebrow")).toHaveText(["Product", "Access", "Independent"]);

  const features = page.getByRole("region", { name: "A quiet place for serious writing", exact: true });
  await expect(features.getByRole("list")).toHaveJSProperty("tagName", "UL");
  await expect(features.getByRole("listitem")).toHaveCount(6);
  await expect(features.locator(".eyebrow").filter({ hasText: /^\d+$/ })).toHaveCount(0);
  await expect(features.getByText(".md / 256 KiB", { exact: true })).toBeVisible();

  const privacy = page.getByRole("region", { name: "Your words never reach us readable", exact: true });
  await expect(privacy.locator("dt")).toHaveText([
    "Keys live on your devices",
    "Even names are encrypted",
    "Nothing to sell",
  ]);
  await expect(page.locator("summary").first()).toHaveText("Can mdwn read my Files?");
  await expect(page.locator("summary").filter({ hasText: /^Q\.\d+/ })).toHaveCount(0);
  await expect(page.getByText("What is the 24-word recovery phrase for?", { exact: true })).toBeVisible();

  for (const id of ["how-it-works", "publishing"]) {
    await expect(page.locator(`#${id} ol li > span`)).toHaveText(["01", "02", "03"]);
  }
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
  await expect(menu.getByRole("navigation", { name: "Main", exact: true }).getByRole("link")).toHaveText([
    "How it works",
    "Privacy",
    "Publishing",
    "Support",
  ]);
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

test("Laboratorio landing and navigation fit mobile, tablet and desktop widths", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  for (const width of [320, 375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const element of [page.getByRole("banner"), page.getByRole("heading", { level: 1 })]) {
      const bounds = await element.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    const call = page.getByRole("main").getByRole("link", { name: "Create your account" }).first();
    expect(await call.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  }
});

test("Files entry explains device access instead of leaving a signed-out visitor on a skeleton", async ({ page }) => {
  await page.goto("/files");
  await expect(page).toHaveURL(/\/account\/device-access$/);
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Sign in to access your Files", exact: true })).toBeVisible();
  await expect(page.getByText("Opening Files", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("banner").getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
});
