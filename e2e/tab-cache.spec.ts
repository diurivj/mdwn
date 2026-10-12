import type { Page } from "@playwright/test";

import { waitForSharedProvisioning } from "./support/navigation";
import { withoutTabMessages } from "./support/tab-memory";
import { test, expect } from "./workspace-fixture";

// Ticket 57: verified listings and keys stay in the tab's memory. A revisit
// renders from it at once and revalidates in the background; other tabs hear
// id-only invalidations, and sign-out anywhere clears it.

const tree = (page: Page) => page.getByRole("navigation", { name: "Files", exact: true });

async function openLibraryLink(page: Page) {
  await page
    .getByRole("complementary", { name: "Files tree", exact: true })
    .getByRole("link", { name: "Library", exact: true })
    .click();
  await expect(page).toHaveURL(/\/files$/);
}

async function openLibrary(page: Page) {
  await openLibraryLink(page);
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
  await withoutTabMessages(page);
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

/** Sign out from a second tab of the same browser. */
async function signOutInAnotherTab(page: Page) {
  const other = await page.context().newPage();
  await other.goto("/account/security");
  await other.getByRole("button", { name: "Account menu", exact: true }).click();
  await other.locator("#account-menu").getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(other).toHaveURL(/\/sign-in$/);
  return other;
}

/** Notes, holding Inside.md, both verified and remembered; returns on the library root, rendered from memory. */
async function rememberNotes(page: Page) {
  await create(page, "Notes", "folder");
  await create(page, "Inside.md", "File");
  await expect(tree(page).getByRole("link", { name: "Inside.md", exact: true })).toBeVisible();
  await waitForSharedProvisioning(page);
  await openLibrary(page);
  // Notes is collapsed in the tree: only memory could show what it holds.
  await expect(page.getByText("Inside.md", { exact: true })).toHaveCount(0);
}

/** Hold private tree, bootstrap and device-state responses until released. */
async function holdPrivateResponses(page: Page) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/(private\/(tree\/|bootstrap$)|device\/state$)/, async (route) => {
    await held;
    await route.continue().catch(() => {
      /* The page may have moved on. */
    });
  });
  return release;
}

test("signing out in another tab clears names this tab remembers before its next navigation", async ({
  page,
  workspace,
}) => {
  expect(workspace.fileId).toBeTruthy();
  await rememberNotes(page);
  const release = await holdPrivateResponses(page);
  try {
    const other = await signOutInAnotherTab(page);
    await page
      .getByRole("list", { name: "Folder contents" })
      .getByRole("link", { name: "Notes, folder", exact: true })
      .click();
    // The destination waits on the network instead of rendering remembered contents.
    await expect(page.getByRole("status").filter({ hasText: "Opening Notes…" })).toBeAttached();
    await expect(page.getByText("Inside.md", { exact: true })).toHaveCount(0);
    release();
    await expect(page.getByRole("heading", { name: "Files unavailable", exact: true })).toBeVisible();
    await expect(page.getByText("Inside.md", { exact: true })).toHaveCount(0);
    await other.close();
  } finally {
    release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("another tab's sign-out reloads an open folder once, so its names leave the screen", async ({
  page,
  workspace,
}) => {
  expect(workspace.fileId).toBeTruthy();
  await rememberNotes(page);
  await tree(page).getByRole("link", { name: "Notes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Notes", exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Folder contents" }).getByRole("link")).toHaveText(["Inside.md"]);
  const other = await signOutInAnotherTab(page);
  // No navigation here: the page reloads through the cold walk and finds no Session.
  await expect(page.getByRole("heading", { name: "Files unavailable", exact: true })).toBeVisible();
  await expect(page.getByText("Inside.md", { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/d\/[^/]+$/);
  await other.close();
});

/** Move this browser's rollback checkpoint for the library root past what the server holds, as a newer head seen in another tab would. */
async function advanceRootCheckpoint(page: Page, accountId: string, rootId: string) {
  await page.evaluate(
    ({ key }) => {
      const [revision] = JSON.parse(localStorage.getItem(key) ?? "[1]") as [number, string];
      localStorage.setItem(key, JSON.stringify([revision + 1, "a-newer-head"]));
    },
    { key: `mdwn:files-listing:${accountId}:${rootId}` },
  );
}

test("background revalidation rejects a remembered head behind the rollback checkpoint", async ({
  page,
  workspace,
}) => {
  await openLibrary(page);
  await expect(tree(page).getByRole("link", { name: "Draft.md", exact: true })).toBeVisible();
  await advanceRootCheckpoint(page, workspace.accountId, workspace.rootId);
  // The server still answers the remembered head; the checkpoint makes it a replay.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("heading", { name: "Files unavailable", exact: true })).toBeVisible();
});

test("memory never renders a listing behind the rollback checkpoint", async ({ page, workspace }) => {
  // A cold-loaded folder: nothing revalidates here in the background to meet the checkpoint first.
  await create(page, "Notes", "folder");
  await advanceRootCheckpoint(page, workspace.accountId, workspace.rootId);
  await openLibraryLink(page);
  // The cold walk then meets the same rollback check.
  await expect(page.getByRole("heading", { name: "Files unavailable", exact: true })).toBeVisible();
  await expect(tree(page).getByRole("link", { name: "Draft.md", exact: true })).toHaveCount(0);
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
