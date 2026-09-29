import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { settled } from "./support/settle";
import { openEditor } from "./editor-workspace.fixture";

test.setTimeout(180_000);

async function createFolder(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog", { name: "Create a name" });
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

/**
 * Leave only once the page's lazy route modules have loaded, then one retry covers an import
 * that starts after the settle.
 */
async function open(page: Page, url: string) {
  await settled(page);
  try { await page.goto(url); }
  catch (error) {
    if (!/NS_BINDING_ABORTED|interrupted by another navigation/.test(String(error))) throw error;
    await page.goto(url);
  }
}

function treeNames(page: Page) {
  return page.getByRole("navigation", { name: "Files" }).getByRole("link").allTextContents();
}

test("moves, reorders and hard-deletes Files and folders through the built Worker", async ({ browser, server, baseURL }) => {
  const { context, page, fileId, rootId } = await openEditor(browser, server, baseURL!, "Moving.md");
  const db = (await server.getWorker<{ DB: D1Database }>().getEnv()).DB;
  try {
    const source = page.getByRole("textbox", { name: "Markdown source" });
    await source.fill("# carried along");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();

    await open(page, new URL(`/d/${rootId}`, baseURL).href);
    const archive = await createFolder(page, "Archive");
    await open(page, new URL(`/d/${rootId}`, baseURL).href);
    await createFolder(page, "Beta");

    // Move the open File into Archive: content and File identity are unchanged.
    await open(page, new URL(`/f/${fileId}`, baseURL).href);
    await expect(source).toHaveValue("# carried along");
    await page.getByRole("button", { name: "Move to…" }).click();
    const move = page.getByRole("dialog", { name: "Move" });
    await move.getByRole("combobox", { name: "Destination folder" }).selectOption({ label: "Files / Archive" });
    await move.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Archive" }))
      .toHaveAttribute("href", `/d/${archive}`);
    await expect(page.getByRole("heading", { name: "Moving.md" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("# carried along");

    // Reorder root siblings: Beta moves above Archive.
    await open(page, new URL(`/d/${rootId}`, baseURL).href);
    await expect.poll(() => treeNames(page)).toEqual(["Archive", "Beta"]);
    const beta = page.getByRole("navigation", { name: "Files" }).getByRole("link", { name: "Beta" });
    await beta.click();
    await expect(page.getByRole("heading", { name: "Beta" })).toBeVisible();
    await page.getByRole("button", { name: "Move up" }).click();
    await expect.poll(() => treeNames(page)).toEqual(["Beta", "Archive"]);
    await expect(page.getByRole("button", { name: "Move up" })).toBeDisabled();

    // Deleting a File leaves its parent open and the File unavailable.
    await open(page, new URL(`/f/${fileId}`, baseURL).href);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Delete" });
    await expect(confirm).toContainText("There is no trash or restore");
    await confirm.getByRole("button", { name: "Delete permanently" }).click();
    await expect(page).toHaveURL(new RegExp(`/d/${archive}$`));
    await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
    await open(page, new URL(`/f/${fileId}`, baseURL).href);
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();

    // A Directory over the 500-node bound is refused without any change.
    await open(page, new URL(`/d/${rootId}`, baseURL).href);
    const big = await createFolder(page, "Big");
    const owner = await db.prepare("SELECT owner_id FROM vault_nodes WHERE id = ?").bind(big).first<{ owner_id: string }>();
    await db.batch([
      db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 500)
        INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at)
        SELECT printf('%s-%04d', ?1, n), 'directory', ?2, ?1, 1, 1 FROM seq`).bind(big, owner!.owner_id),
      db.prepare(`INSERT INTO directories (node_id, owner_id, entries_revision)
        SELECT id, owner_id, 1 FROM vault_nodes WHERE parent_node_id = ?`).bind(big),
      db.prepare(`INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id, name_ciphertext,
        order_ciphertext, key_envelope, encoding) SELECT id, owner_id, parent_node_id, X'01', X'01', X'01', 'directory'
        FROM vault_nodes WHERE parent_node_id = ?`).bind(big),
    ]);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog", { name: "Delete" }).getByRole("button", { name: "Delete permanently" }).click();
    await expect(page.getByRole("dialog", { name: "Delete" }).getByRole("alert"))
      .toContainText("more than 500 items");
    expect((await db.prepare("SELECT count(*) AS n FROM vault_nodes WHERE id = ?1 OR parent_node_id = ?1")
      .bind(big).first<{ n: number }>())!.n).toBe(501);

    // A folder with content is deleted as a whole.
    await open(page, new URL(`/d/${archive}`, baseURL).href);
    await page.getByRole("button", { name: "New File" }).click();
    const fileDialog = page.getByRole("dialog", { name: "Create a name" });
    await fileDialog.getByRole("textbox", { name: "Name" }).fill("inside.md");
    await fileDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("heading", { name: "inside.md" })).toBeVisible();
    await open(page, new URL(`/d/${archive}`, baseURL).href);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Delete" })).toContainText("everything inside it");
    await page.getByRole("dialog", { name: "Delete" }).getByRole("button", { name: "Delete permanently" }).click();
    await expect(page).toHaveURL(new RegExp(`/d/${rootId}$`));
    await expect.poll(() => treeNames(page)).toEqual(["Beta", "Big"]);
    expect((await db.prepare("SELECT count(*) AS n FROM vault_nodes WHERE id = ?1 OR parent_node_id = ?1")
      .bind(archive).first<{ n: number }>())!.n).toBe(0);
  } finally { await context.close(); }
});

test("a finished structure write never overrides a newer navigation", async ({ browser, server, baseURL }) => {
  const { context, page, fileId, rootId } = await openEditor(browser, server, baseURL!, "Hijack.md");
  const path = `**/api/private/tree/nodes/${fileId}`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const write = new Promise<void>((resolve) => { started = resolve; });
  try {
    await open(page, new URL(`/d/${rootId}`, baseURL).href);
    const elsewhere = await createFolder(page, "Elsewhere");
    await open(page, new URL(`/f/${fileId}`, baseURL).href);
    // Hold the hard-delete response so the tree link is chosen while the write is in flight.
    await page.route(path, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      const response = await route.fetch();
      started();
      await gate;
      try { await route.fulfill({ response }); } catch { /* the page has moved on */ }
    });
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog", { name: "Delete" }).getByRole("button", { name: "Delete permanently" }).click();
    await write;
    // The write is still pending; the user picks a different destination than the delete's own parent.
    const files = page.getByRole("navigation", { name: "Files" }).getByRole("link", { name: "Elsewhere" });
    await files.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Elsewhere" })).toBeVisible();
    release();
    await page.waitForTimeout(250);
    // The finished delete must not navigate back to the File's parent over the user's choice.
    await expect(page).toHaveURL(new URL(`/d/${elsewhere}`, baseURL).href);
    await expect(page.getByRole("heading", { name: "Elsewhere" })).toBeVisible();
  } finally { release(); await page.unroute(path); await context.close(); }
});
