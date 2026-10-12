import type { Page } from "@playwright/test";

import { waitForSharedProvisioning } from "./support/navigation";
import { test, expect } from "./workspace-fixture";

// Ticket 57: verified listings and keys stay in the tab's memory. A revisit
// renders from it at once and revalidates in the background; other tabs hear
// id-only invalidations, and sign-out anywhere clears it.

const tree = (page: Page) => page.getByRole("navigation", { name: "Files", exact: true });

async function openLibrary(page: Page) {
  await page
    .getByRole("complementary", { name: "Files tree", exact: true })
    .getByRole("link", { name: "Library", exact: true })
    .click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
}

async function create(page: Page, name: string, kind: "File" | "folder") {
  await page.getByRole("button", { name: `New ${kind}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a name" });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

/** Another tab of the same browser: same Session, device keys and listing checkpoints. */
async function renameInAnotherTab(page: Page, fileId: string, name: string) {
  const other = await page.context().newPage();
  await other.goto(`/f/${fileId}`);
  await expect(other.getByRole("heading", { name: "Draft.md", exact: true })).toBeVisible();
  await waitForSharedProvisioning(other);
  await other.getByRole("button", { name: "Rename", exact: true }).click();
  const dialog = other.getByRole("dialog", { name: "Rename", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(other.getByRole("heading", { name, exact: true })).toBeVisible();
  return other;
}

test("a revisited library renders from memory before any tree or bootstrap response", async ({ page, workspace }) => {
  expect(workspace.fileId).toBeTruthy();
  await create(page, "Notes", "folder");
  await openLibrary(page);
  await tree(page).getByRole("link", { name: "Notes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Notes", exact: true })).toBeVisible();
  await waitForSharedProvisioning(page);

  let held = 0;
  let answered = 0;
  await page.route(/\/api\/private\/(tree\/|bootstrap$)/, async (route) => {
    held++;
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    answered++;
    await route.fulfill({ response }).catch(() => {
      /* The page may have moved on. */
    });
  });
  try {
    await openLibrary(page);
    await expect(tree(page).getByRole("link", { name: "Draft.md", exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "Folder contents" }).getByRole("link")).toHaveText([
      "Notes",
      "Draft.md",
    ]);
    expect(answered).toBe(0);
    // The background revalidation has asked for the root listing; its answer has not arrived yet.
    await expect.poll(() => held).toBeGreaterThan(0);
    expect(answered).toBe(0);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("another tab's rename arrives through an id-only broadcast", async ({ page, workspace }) => {
  await page.addInitScript(() => {
    const heard: unknown[] = [];
    Object.assign(window, { heardTreeMessages: heard });
    new BroadcastChannel("mdwn-tree").addEventListener("message", (event) => heard.push(event.data));
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Draft.md", exact: true })).toBeVisible();
  await openLibrary(page);

  const other = await renameInAnotherTab(page, workspace.fileId, "Renamed.md");
  await expect(tree(page).getByRole("link", { name: "Renamed.md", exact: true })).toBeVisible();
  await expect(tree(page).getByRole("link", { name: "Draft.md", exact: true })).toHaveCount(0);

  const heard = (await page.evaluate(
    () => (window as unknown as { heardTreeMessages: unknown[] }).heardTreeMessages,
  )) as {
    type: string;
    directoryIds?: string[];
  }[];
  expect(heard).toContainEqual({
    type: "invalidate",
    accountId: workspace.accountId,
    directoryIds: [workspace.rootId],
  });
  for (const message of heard) {
    expect(Object.keys(message).sort()).toEqual(
      message.type === "clear" ? ["type"] : ["accountId", "directoryIds", "type"],
    );
    expect(JSON.stringify(message)).not.toMatch(/Draft|Renamed|\.md/);
  }
  await other.close();
});

test("a change from another device appears when the tab regains focus", async ({ page, workspace }) => {
  // Without a channel this tab hears nothing, as with another device or Collaborator.
  await page.addInitScript(() => {
    class SilentChannel extends EventTarget {
      onmessage = null;
      postMessage() {}
      close() {}
    }
    Object.assign(window, { BroadcastChannel: SilentChannel });
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Draft.md", exact: true })).toBeVisible();
  await openLibrary(page);

  const other = await renameInAnotherTab(page, workspace.fileId, "Elsewhere.md");
  await expect(tree(page).getByRole("link", { name: "Draft.md", exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(tree(page).getByRole("link", { name: "Elsewhere.md", exact: true })).toBeVisible();
  await expect(tree(page).getByRole("link", { name: "Draft.md", exact: true })).toHaveCount(0);
  await other.close();
});

test("signing out in another tab clears this tab's remembered names", async ({ page, workspace }) => {
  expect(workspace.fileId).toBeTruthy();
  await openLibrary(page);
  await waitForSharedProvisioning(page);
  const other = await page.context().newPage();
  await other.goto("/files");
  await expect(other.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  await waitForSharedProvisioning(other);
  await other.getByRole("button", { name: "Account menu", exact: true }).click();
  await other.locator("#account-menu").getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(other).toHaveURL(/\/sign-in$/);

  // The next navigation here walks the tree again and finds no Session.
  await tree(page).getByRole("link", { name: "Draft.md", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Files unavailable", exact: true })).toBeVisible();
  await expect(page.getByText("Draft.md")).toHaveCount(0);
  await other.close();
});

test("a background merge never replaces an open File's unsaved draft", async ({ page, workspace }) => {
  await page.route(`**/api/private/tree/files/${workspace.fileId}`, (route) =>
    route.request().method() === "PATCH" ? route.abort("failed") : route.continue(),
  );
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  await source.fill("# Draft kept in memory");
  await source.press("ControlOrMeta+s");
  await expect(page.getByText("Couldn't save", { exact: true })).toBeVisible();

  const other = await page.context().newPage();
  await other.goto("/files");
  await expect(other.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  await waitForSharedProvisioning(other);
  await create(other, "Other.md", "File");

  await expect(tree(page).getByRole("link", { name: "Other.md", exact: true })).toBeVisible();
  await expect(source).toHaveValue("# Draft kept in memory");
  await expect(page.getByRole("heading", { name: "Draft.md", exact: true })).toBeVisible();
  await expect(page.getByText("Couldn't save", { exact: true })).toBeVisible();
  await other.close();
});
