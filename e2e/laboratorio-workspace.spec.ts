import { test, expect } from "./workspace-fixture";
import { waitForSharedProvisioning } from "./support/navigation";

test("opens the library from the header, keeps Account pages in the Account menu and fits a narrow screen", async ({
  page,
  workspace,
}, testInfo) => {
  const banner = page.getByRole("banner");
  const mainNav = page.getByRole("navigation", { name: "Main", exact: true });
  const accountMenu = page.locator("#account-menu");
  // Signed in, the header keeps only Support in view; the library and Account pages are actions.
  await expect(mainNav.getByRole("link")).toHaveText(["Support"]);
  // The header retains both control shapes, even inside the workspace.
  await expect(banner.getByRole("link", { name: "Open library", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await expect(accountMenu.getByRole("link", { name: "Files access", exact: true })).toBeVisible();
  await expect(accountMenu.getByRole("link", { name: "Library", exact: true })).toHaveAttribute("aria-current", "page");
  await accountMenu.getByRole("link", { name: "Library", exact: true }).click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  // A lone root crumb would only repeat the title.
  await expect(page.getByRole("navigation", { name: "Breadcrumbs", exact: true })).toHaveCount(0);
  const fileLink = page.getByRole("list", { name: "Folder contents" }).getByRole("link", { name: "Draft.md, File" });
  await expect(fileLink).toHaveText("Draft.md");
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await accountMenu.getByRole("link", { name: "Account security", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Account security", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Account", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.getByRole("heading", { level: 1 }).evaluate((node) => getComputedStyle(node).fontFamily)).toContain(
    "Inter Tight Variable",
  );
  await page.screenshot({ path: testInfo.outputPath("account-desktop.png"), fullPage: true, animations: "disabled" });
  // Outside the library, the header's primary action opens it.
  await banner.getByRole("link", { name: "Open library", exact: true }).click();
  await page.getByRole("navigation", { name: "Files", exact: true }).getByRole("link", { name: "Draft.md" }).click();
  await expect(page).toHaveURL(new RegExp(`/f/${workspace.fileId}$`));
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  await expect(source).toBeEditable();
  await page.evaluate(() => document.fonts.ready);
  expect(await source.evaluate((node) => getComputedStyle(node).fontFamily)).toContain("Courier Prime");
  await expect(source).toHaveCSS("border-radius", "0px");
  // Instructions lead the editor's status row; the save status closes it.
  const status = page.getByRole("status", { name: "File save status", exact: true });
  const instructions = page.getByText("Saves automatically", { exact: false });
  expect((await instructions.boundingBox())!.x).toBeLessThan((await status.boundingBox())!.x);
  await page.screenshot({ path: testInfo.outputPath("workspace-desktop.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(banner.getByRole("link", { name: "Support", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("workspace-mobile.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  const menu = page.getByRole("dialog", { name: "Menu", exact: true });
  await expect(
    menu.getByRole("navigation", { name: "Main", exact: true }).locator("ul").first().getByRole("link"),
  ).toHaveText(["Library", "Support"]);
  await expect(menu.getByRole("link", { name: "Files access", exact: true })).toBeVisible();
  await menu.getByRole("link", { name: "Account security", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Account security", exact: true })).toBeVisible();
  await expect(menu).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("account-mobile.png"), fullPage: true, animations: "disabled" });
});

test("shows the destination's own frame while a navigation loads, with no progress bar", async ({
  page,
  workspace,
}) => {
  const hold = async (pattern: string) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = false;
    await page.route(pattern, async (route) => {
      reached = true;
      await held;
      await route.continue().catch(() => {
        /* A newer navigation may cancel this request. */
      });
    });
    return { release, reached: () => reached };
  };
  const main = page.getByRole("main");
  await page
    .getByRole("complementary", { name: "Files tree", exact: true })
    .getByRole("link", { name: "Library" })
    .click();
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();

  // Inside the library, the clicked File's name and an editor skeleton replace the folder at once.
  const ancestors = `**/api/private/tree/nodes/${workspace.fileId}/ancestors`;
  const file = await hold(ancestors);
  try {
    await page.getByRole("navigation", { name: "Files", exact: true }).getByRole("link", { name: "Draft.md" }).click();
    await expect.poll(file.reached).toBe(true);
    await expect(page.getByRole("status").filter({ hasText: "Opening Draft.md…" })).toBeAttached();
    await expect(main).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeHidden();
    await expect(page.getByRole("progressbar")).toHaveCount(0);
  } finally {
    file.release();
    await page.unroute(ancestors);
  }
  await expect(page.getByRole("heading", { name: "Draft.md", exact: true })).toBeVisible();
  await expect(main).not.toHaveAttribute("aria-busy", "true");

  // Entering the library from an Account page shows the library's frame, not the page being left.
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.locator("#account-menu").getByRole("link", { name: "Public pseudonym", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Public pseudonym", exact: true })).toBeVisible();
  // The destination placeholder also has this heading; wait for its decrypted content before leaving it.
  await expect(page.getByLabel("Current Public pseudonym")).toBeVisible();
  const bootstrap = await hold("**/api/private/bootstrap");
  try {
    await page.getByRole("banner").getByRole("link", { name: "Open library", exact: true }).click();
    await expect.poll(bootstrap.reached).toBe(true);
    await expect(page.getByRole("status").filter({ hasText: "Opening your library…" })).toBeVisible();
    await expect(page.getByRole("banner")).toHaveAttribute("data-chrome", "workspace");
    await expect(page.getByRole("heading", { name: "Public pseudonym", exact: true })).toBeHidden();
  } finally {
    bootstrap.release();
    await page.unroute("**/api/private/bootstrap");
  }
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  await expect(page.getByRole("main")).toHaveCount(1);
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
