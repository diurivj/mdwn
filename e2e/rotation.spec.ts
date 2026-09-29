import type { Page } from "@playwright/test";

import { test, expect } from "./fixtures";
import { accountShareId, inviteFromCurrentPage, openEditor } from "./sharing-browser.fixture";

test.setTimeout(360_000);
test.use({ trace: "off", screenshot: "off", video: "off" });

type TestEnv = { DB: D1Database };

async function create(page: Page, kind: "New folder" | "New File", name: string): Promise<string> {
  await page.getByRole("button", { name: kind, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a name" });
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

async function accept(page: Page, origin: string, rootId: string, shareId: string, label: string) {
  await page.goto(`${origin}/d/${rootId}`);
  const acceptance = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/private/sharing/shares/${shareId}/accept`);
  await page.getByText(label, { exact: true }).locator("..").getByRole("button", { name: "Accept", exact: true }).click();
  expect((await acceptance).status()).toBe(200);
}

test("revoking a folder Share replaces its keys in the Owner's browser while the remaining reader keeps access", async ({
  browser, server, baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const owner = await openEditor(browser, server, baseURL!, "OwnerSeed.md");
  const kept = await openEditor(browser, server, baseURL!, "KeptPrivate.md");
  // A third Account from the same test network: clear only the per-network registration counter.
  const env = await server.getWorker<TestEnv>().getEnv();
  await env.DB.prepare("DELETE FROM rate_limit_counters WHERE purpose = ? AND scope_type = 'network'")
    .bind("registration.success").run();
  const removed = await openEditor(browser, server, baseURL!, "RemovedPrivate.md");
  try {
    await owner.page.goto(`${origin}/d/${owner.rootId}`);
    const folderId = await create(owner.page, "New folder", "Team");
    const fileId = await create(owner.page, "New File", "Plan.md");
    const editor = owner.page.getByRole("textbox", { name: "Markdown source" });
    await editor.fill("PLAN BEFORE ROTATION");
    await expect(owner.page.getByRole("status", { name: "Save status" })).toHaveText("Saved", { timeout: 30_000 });
    await owner.page.goto(`${origin}/d/${folderId}`);
    const keptShare = await inviteFromCurrentPage(owner.page, await accountShareId(server, kept.accountId), "read_write");
    // The Share panel stays open after an invite; the helper opens it from a fresh page.
    await owner.page.goto(`${origin}/d/${folderId}`);
    const removedShare = await inviteFromCurrentPage(owner.page, await accountShareId(server, removed.accountId),
      "read_only");
    await accept(kept.page, origin, kept.rootId, keptShare, "Invitation to a folder (read/write)");
    await accept(removed.page, origin, removed.rootId, removedShare, "Invitation to a folder (read-only)");
    for (const reader of [kept, removed]) {
      await reader.page.goto(`${origin}/f/${fileId}`);
      await expect(reader.page.getByRole("textbox", { name: "Markdown source" }))
        .toHaveValue("PLAN BEFORE ROTATION", { timeout: 30_000 });
    }

    // Revoke the read-only Share from the folder's Share panel.
    await owner.page.goto(`${origin}/d/${folderId}`);
    await owner.page.getByRole("button", { name: "Share", exact: true }).click();
    const panel = owner.page.getByRole("region", { name: "Share this content" });
    await panel.locator("div.text-sm").filter({ hasText: "read_only" })
      .getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(panel.getByText(/copies already downloaded can't be recalled/)).toBeVisible({ timeout: 30_000 });
    // Server access ended at once.
    await removed.page.reload();
    await expect(removed.page.getByRole("heading", { name: "Not found", exact: true })).toBeVisible({ timeout: 30_000 });

    // The Owner's open page runs the rotation to completion on its own.
    await expect.poll(async () => (await env.DB.prepare(
      "SELECT count(*) AS n FROM sharing_rotation_jobs WHERE target_node_id = ?").bind(folderId).first<{ n: number }>())!.n,
    { timeout: 120_000 }).toBe(0);
    expect(await env.DB.prepare("SELECT capability_epoch FROM directories WHERE node_id = ?")
      .bind(folderId).first()).toEqual({ capability_epoch: 2 });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM rotation_barriers WHERE target_node_id = ?")
      .bind(folderId).first()).toEqual({ n: 0 });

    // The remaining reader regains the folder through its re-sealed capability.
    await kept.page.goto(`${origin}/f/${fileId}`);
    await expect(kept.page.getByRole("textbox", { name: "Markdown source" }))
      .toHaveValue("PLAN BEFORE ROTATION", { timeout: 30_000 });
    // The Owner edits again once the barrier is gone, and the kept reader sees the new text.
    await owner.page.goto(`${origin}/f/${fileId}`);
    await owner.page.getByRole("textbox", { name: "Markdown source" }).fill("PLAN AFTER ROTATION");
    await expect(owner.page.getByRole("status", { name: "Save status" })).toHaveText("Saved", { timeout: 30_000 });
    await kept.page.reload();
    await expect(kept.page.getByRole("textbox", { name: "Markdown source" }))
      .toHaveValue("PLAN AFTER ROTATION", { timeout: 30_000 });
    await removed.page.goto(`${origin}/f/${fileId}`);
    await expect(removed.page.getByRole("heading", { name: "Not found", exact: true })).toBeVisible();
  } finally {
    await removed.context.close();
    await kept.context.close();
    await owner.context.close();
  }
});
