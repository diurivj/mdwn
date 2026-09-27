import { test, expect } from "./fixtures";
import { openEditor } from "./editor-workspace.fixture";

test.setTimeout(180_000);

test("creates a v2 File, saves without changing its Directory head, and opens the current bytes after reload", async ({ browser, server, baseURL }) => {
  const opened = await openEditor(browser, server, baseURL!);
  const { context, page, fileId, rootId, accountId } = opened;
  const db = (await server.getWorker<{ DB: D1Database }>().getEnv()).DB;
  try {
    const listingBefore = await db.prepare("SELECT entries_revision, hex(listing_digest) AS digest, listing_version FROM directories WHERE node_id = ?")
      .bind(rootId).first<{ entries_revision: number; digest: string; listing_version: number }>();
    expect(listingBefore?.listing_version).toBe(2);
    expect(await db.prepare("SELECT revision, receiving_epoch FROM file_heads WHERE file_node_id = ?")
      .bind(fileId).first()).toEqual({ revision: 1, receiving_epoch: 1 });
    await page.getByRole("textbox", { name: "Markdown source" }).fill("# A fresh File-scoped key");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved", { timeout: 30_000 });
    const listingAfter = await db.prepare("SELECT entries_revision, hex(listing_digest) AS digest, listing_version FROM directories WHERE node_id = ?")
      .bind(rootId).first();
    expect(listingAfter).toEqual(listingBefore);
    expect(await db.prepare("SELECT revision, receiving_epoch FROM file_heads WHERE file_node_id = ?")
      .bind(fileId).first()).toEqual({ revision: 2, receiving_epoch: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM file_representations WHERE file_node_id = ?")
      .bind(fileId).first()).toEqual({ count: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM key_envelopes WHERE account_id = ? AND purpose = 'vault-recovery'")
      .bind(accountId).first()).toEqual({ count: 1 });
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("# A fresh File-scoped key");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved");
  } finally { await context.close(); }
});
