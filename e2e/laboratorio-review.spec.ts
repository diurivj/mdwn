import { test as appTest, expect } from "./fixtures";
import { seedAccount } from "./support/seeded-account";
import { test as workspaceTest } from "./workspace-fixture";

appTest("reconciles navigation after another tab signs in or signs out", async ({ browser, server, baseURL }) => {
  const account = await seedAccount(browser, server, baseURL!);
  const original = account.page;
  try {
    await original.getByRole("banner").getByRole("link", { name: "Support", exact: true }).click();
    await expect(original.getByRole("banner").getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
    const other = await account.context.newPage();
    // Establish the new tab's document once; its hydrated button, not a load notification, is readiness.
    await other.goto("/sign-in", { waitUntil: "commit" });
    const signIn = other.getByRole("button", { name: "Sign in with a passkey", exact: true });
    await expect(signIn).toBeEnabled();
    await signIn.click();
    await expect(other).toHaveURL(/\/files$/);
    // Navigate without replacing the first tab's document or its in-memory store.
    await original
      .getByRole("navigation", { name: "Access", exact: true })
      .getByRole("link", { name: "Open your library" })
      .click();
    await expect(original).toHaveURL(/\/files$/);
    await expect(original.getByRole("button", { name: "Account menu", exact: true })).toBeVisible();
    await other.getByRole("button", { name: "Account menu", exact: true }).click();
    await other.locator("#account-menu").getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(other).toHaveURL(/\/sign-in$/);
    // The sign-out lands on /sign-in, but the header must also stop showing the Account menu.
    await expect(other.getByRole("button", { name: "Account menu", exact: true })).toHaveCount(0);
    await original.bringToFront();
    // Headless engines differ in native tab focus delivery; exercise the actual
    // browser subscription deterministically after the real Session mutation.
    await original.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(original.getByRole("banner").getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  } finally {
    await account.context.close();
  }
});

workspaceTest(
  "a new location supersedes a Session read captured before another tab signs out",
  async ({ page, context, workspace }) => {
    expect(workspace.fileId).toBeTruthy();
    const other = await context.newPage();
    await other.goto("/support");
    await expect(other.getByRole("heading", { name: "Support mdwn", exact: true })).toBeVisible();
    await page.bringToFront();
    let captured!: () => void;
    let release!: () => void;
    let reads = 0;
    const requested = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/auth/session", async (route) => {
      reads++;
      if (reads > 1) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      captured();
      await held;
      await route.fulfill({ response });
    });
    try {
      await page.reload();
      await requested;
      // A real same-origin mutation in the other tab, without moving focus away
      // from the original. The next location must reconcile independently.
      expect(
        await other.evaluate(
          async () =>
            (
              await fetch("/api/auth/sign-out", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              })
            ).status,
        ),
      ).toBe(200);
      await page.getByRole("banner").getByRole("link", { name: "Support", exact: true }).click();
      await expect(page).toHaveURL(/\/support$/);
      await expect(page.getByRole("banner").getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
      await expect.poll(() => reads).toBeGreaterThan(1);
      const response = page.waitForResponse((result) => new URL(result.url()).pathname === "/api/auth/session");
      release();
      await (await response).finished();
      await expect(page.getByRole("button", { name: "Account menu", exact: true })).toHaveCount(0);
    } finally {
      release();
      await page.unroute("**/api/auth/session");
      await other.close();
    }
  },
);

workspaceTest("shows a failed header sign-out even after an earlier Account action", async ({ page, workspace }) => {
  expect(workspace.fileId).toBeTruthy();
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.locator("#account-menu").getByRole("link", { name: "Account security", exact: true }).click();
  await page.getByRole("button", { name: "Refresh session", exact: true }).click();
  await expect(page.getByText("Session refreshed.", { exact: true })).toBeVisible();
  await page.route("**/api/auth/sign-out", (route) => route.abort("failed"));
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.locator("#account-menu").getByRole("button", { name: "Sign out", exact: true }).click();
  const failure = page.getByText("We could not update your Sessions. Try again.", { exact: true });
  await expect(failure).toBeVisible();
  await page.getByRole("button", { name: "Refresh session", exact: true }).click();
  await expect(page.getByText("Session refreshed.", { exact: true })).toBeVisible();
  await expect(failure).toBeHidden();
});

workspaceTest(
  "keeps the full irreversible Unpublish confirmation inside a narrow viewport",
  async ({ page, workspace }) => {
    expect(workspace.fileId).toBeTruthy();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const panel = page.getByRole("region", { name: "Publish", exact: true });
    await panel.getByRole("button", { name: "Publish File", exact: true }).click();
    await expect(panel.getByText("Published.", { exact: false })).toBeVisible();
    expect(
      await panel
        .getByRole("textbox", { name: "Public link", exact: true })
        .evaluate((node) => getComputedStyle(node).fontFamily),
    ).toContain("Courier Prime");
    await panel.getByRole("button", { name: "Unpublish…", exact: true }).click();
    const confirmation = panel.getByRole("button", {
      name: "Unpublish and permanently delete 0 Public Comments",
      exact: true,
    });
    await expect(confirmation).toBeVisible();
    const bounds = await confirmation.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
    const fits = await confirmation.evaluate(
      (node) => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight,
    );
    expect(fits).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await confirmation.click();
    await expect(panel.getByRole("button", { name: "Publish File", exact: true })).toBeVisible();
  },
);
