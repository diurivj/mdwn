import { test, expect } from "./fixtures";
import { seedLegacyFile } from "./editor-legacy.fixture";
import { openEditor } from "./editor-workspace.fixture";

test.setTimeout(180_000);

test("a trusted mixed v2 listing upgrades a legacy File on the owned browser's first edit", async ({ browser, server, baseURL }) => {
  const opened = await openEditor(browser, server, baseURL!);
  const { page, context, rootId } = opened;
  const db = (await server.getWorker<{ DB: D1Database }>().getEnv()).DB;
  try {
    const { fileId, entriesRevision } = await seedLegacyFile({ ...opened, server },
      { name: "Old.md", source: "legacy current" });
    expect(await db.prepare("SELECT encoding FROM directory_entries WHERE child_node_id = ?")
      .bind(fileId).first()).toEqual({ encoding: "legacy-file" });
    expect(await db.prepare("SELECT revision FROM file_heads WHERE file_node_id = ?")
      .bind(fileId).first()).toBeNull();
    await page.goto(new URL(`/f/${fileId}`, baseURL!).href);
    await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("legacy current");
    await page.getByRole("textbox", { name: "Markdown source" }).fill("migrated and saved");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved", { timeout: 30_000 });
    expect(await db.prepare("SELECT revision FROM file_heads WHERE file_node_id = ?").bind(fileId).first())
      .toEqual({ revision: 2 });
    expect(await db.prepare("SELECT entries_revision, listing_version FROM directories WHERE node_id = ?")
      .bind(rootId).first()).toEqual({ entries_revision: entriesRevision + 1, listing_version: 2 });
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("migrated and saved");
  } finally { await context.close(); }
});
