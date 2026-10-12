import { test, expect } from "./workspace-fixture";
import { waitForSharedProvisioning } from "./support/navigation";

test("opens Files from site navigation, retains account navigation and fits a narrow screen", async ({
  page,
  workspace,
}, testInfo) => {
  const mainNav = page.getByRole("navigation", { name: "Main", exact: true });
  await mainNav.getByRole("link", { name: "Files", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/d/${workspace.rootId}$`));
  await expect(page.getByRole("heading", { name: "Files", exact: true })).toBeVisible();
  await expect(mainNav.getByRole("link")).toHaveText(["Files", "Account", "Devices", "Support"]);
  const fileLink = page.getByRole("list", { name: "Folder contents" }).getByRole("link", { name: "Draft.md, File" });
  await expect(fileLink).toHaveText(/^Draft\.md\s*Markdown File$/);
  await expect(mainNav.getByRole("link", { name: "Files", exact: true })).toHaveAttribute("aria-current", "page");
  await mainNav.getByRole("link", { name: "Account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Account security", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Account", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.getByRole("heading", { level: 1 }).evaluate((node) => getComputedStyle(node).fontFamily)).toContain(
    "Inter Tight Variable",
  );
  await page.screenshot({ path: testInfo.outputPath("account-desktop.png"), fullPage: true, animations: "disabled" });
  await mainNav.getByRole("link", { name: "Files", exact: true }).click();
  await page.getByRole("navigation", { name: "Files", exact: true }).getByRole("link", { name: "Draft.md" }).click();
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  await expect(source).toBeEditable();
  await page.evaluate(() => document.fonts.ready);
  expect(await source.evaluate((node) => getComputedStyle(node).fontFamily)).toContain("Courier Prime");
  await expect(source).toHaveCSS("border-radius", "0px");
  await page.screenshot({ path: testInfo.outputPath("workspace-desktop.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("workspace-mobile.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Menu", exact: true })
      .getByRole("navigation", { name: "Main", exact: true })
      .locator("ul")
      .first()
      .getByRole("link"),
  ).toHaveText(["Files", "Account", "Devices", "Support"]);
  await page
    .getByRole("dialog", { name: "Menu", exact: true })
    .getByRole("link", { name: "Account", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Account security", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Menu", exact: true })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("account-mobile.png"), fullPage: true, animations: "disabled" });
});

test("fetches the File while the verified parent listing is still in flight", async ({ page, workspace }) => {
  await page.evaluate(() => localStorage.clear());
  let listingRequested = false;
  let fileRequested = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pattern = `**/api/private/tree/directories/${workspace.rootId}`;
  // Hold a real listing response: the File request must not wait for it.
  await page.route(pattern, async (route) => {
    listingRequested = true;
    await held;
    await route.continue();
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/private/tree/files/${workspace.fileId}`) fileRequested = true;
  });
  try {
    await page.reload({ waitUntil: "commit" });
    await expect.poll(() => listingRequested && fileRequested).toBe(true);
    // Fetching ciphertext early must not expose an unverified File.
    await expect(page.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveCount(0);
    const placeholder = page.getByRole("main").locator(".skeleton").first();
    await expect(placeholder).toBeVisible();
    const colors = await placeholder.evaluate((node) => ({
      fill: getComputedStyle(node).backgroundColor,
      surface: getComputedStyle(node.parentElement!).backgroundColor,
    }));
    expect(colors.fill).not.toBe(colors.surface);
    release();
    await expect(page.getByRole("heading", { name: "Draft.md", exact: true })).toBeVisible();
    await expect(page.getByRole("main")).toHaveCount(1);
    await waitForSharedProvisioning(page);
  } finally {
    release();
    await page.unroute(pattern);
  }
});

test("an older Session presence read cannot restore signed-in navigation after sign-out", async ({
  page,
  workspace,
}) => {
  expect(workspace.fileId).toBeTruthy();
  let captured!: () => void;
  let release!: () => void;
  const requested = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/auth/session", async (route) => {
    const response = await route.fetch();
    captured();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.reload();
    await requested;
    await expect(page.getByRole("heading", { name: "Draft.md", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Account menu", exact: true }).click();
    await page.locator("#account-menu").getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    const response = page.waitForResponse((result) => new URL(result.url()).pathname === "/api/auth/session");
    release();
    await response;
    await page.getByRole("banner").getByRole("link", { name: "Support", exact: true }).click();
    await expect(page).toHaveURL(/\/support$/);
    await expect(page.getByRole("button", { name: "Account menu", exact: true })).toHaveCount(0);
    await expect(page.getByRole("banner").getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  } finally {
    release();
    await page.unroute("**/api/auth/session");
  }
});

test("signing out from the header does not discard a failed File draft without consent", async ({
  page,
  workspace,
}) => {
  await page.route(`**/api/private/tree/files/${workspace.fileId}`, (route) =>
    route.request().method() === "PATCH" ? route.abort("failed") : route.continue(),
  );
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  await source.fill("# Keep this unsaved draft");
  await source.press("ControlOrMeta+s");
  await expect(page.getByText("Couldn't save", { exact: true })).toBeVisible();
  let signedOut = false;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/sign-out") signedOut = true;
  });
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.locator("#account-menu").getByRole("button", { name: "Sign out", exact: true }).click();
  const warning = page.getByRole("dialog", { name: "Unsaved File", exact: true });
  await expect(warning).toBeVisible();
  expect(signedOut).toBe(false);
  await warning.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(source).toHaveValue("# Keep this unsaved draft");
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.locator("#account-menu").getByRole("button", { name: "Sign out", exact: true }).click();
  await warning.getByRole("button", { name: "Discard draft and leave", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(signedOut).toBe(true);
  await expect(page.getByRole("button", { name: "Account menu", exact: true })).toHaveCount(0);
});
