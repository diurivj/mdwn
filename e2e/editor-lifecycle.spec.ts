import { test, expect } from "./fixtures";
import { compose, filePatch, openEditor, warnsOnUnload } from "./editor-workspace.fixture";
import { seedLegacyOversizedFile } from "./editor-legacy.fixture";

test.setTimeout(240_000);

test("accepts a valid IME composition as one draft and rejects an over-limit result", async ({ browser, server, baseURL }) => {
  const { context, page, fileId } = await openEditor(browser, server, baseURL!);
  try {
    const editor = page.getByRole("textbox", { name: "Markdown source" });
    const status = page.getByRole("status", { name: "Save status" });
    let patches = 0;
    page.on("request", (request) => { if (filePatch(request, fileId)) patches++; });
    await editor.fill("abc");
    await expect(status).toHaveText("Saved", { timeout: 20_000 });
    await compose(page, "abcあ", "あ");
    await expect(editor).toHaveValue("abcあ");
    await expect(status).toHaveText("Saved", { timeout: 20_000 });
    const accepted = patches;
    await editor.fill("a".repeat(262_144));
    await expect(status).toHaveText("Saved", { timeout: 20_000 });
    await compose(page, "a".repeat(262_144) + "あ", "あ");
    await expect(editor).toHaveValue("a".repeat(262_144));
    await page.waitForTimeout(850);
    expect(patches).toBe(accepted + 1);
  } finally { await context.close(); }
});

test("a pending older save cannot clear warnings or allow a lease handoff when the draft reverts", async ({ browser, server, baseURL }) => {
  const { context, page, fileId, rootId } = await openEditor(browser, server, baseURL!);
  try {
    const editor = page.getByRole("textbox", { name: "Markdown source" });
    const status = page.getByRole("status", { name: "Save status" });
    await editor.fill("A");
    await expect(status).toHaveText("Saved", { timeout: 20_000 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let patches = 0;
    let committed!: () => void;
    const firstCommitted = new Promise<void>((resolve) => { committed = resolve; });
    await page.route(`**/api/private/tree/files/${fileId}`, async (route) => {
      if (!filePatch(route.request(), fileId)) return route.continue();
      patches++;
      if (patches !== 1) return route.continue();
      const response = await route.fetch(); // The Worker has committed; only its reply is withheld.
      committed();
      await gate;
      await route.fulfill({ response });
    });
    try {
      await editor.fill("B");
      await firstCommitted;
      await editor.fill("A");
      expect(await warnsOnUnload(page)).toBe(true);
      await expect(status).not.toHaveText("Saved");
      const other = await context.newPage();
      try {
        await other.goto(new URL(`/f/${fileId}`, baseURL!).href);
        await other.getByRole("button", { name: "Edit here" }).click();
        const transfer = page.getByRole("dialog", { name: "Transfer editing" });
        await expect(transfer).toBeVisible();
        await expect(transfer.getByRole("button", { name: "Discard and transfer" })).toBeDisabled();
        await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Files" }).click();
        await expect(page).toHaveURL(new RegExp(`/f/${fileId}$`));
        expect(await warnsOnUnload(page)).toBe(true);
        release();
        await expect.poll(() => patches).toBe(2);
        // The blocked navigation flush may now leave immediately, before Saved can be painted.
        await expect(page).toHaveURL(new URL(`/d/${rootId}`, baseURL!).href, { timeout: 30_000 });
        // Returning to the File must show A, never B.
        await page.goto(new URL(`/f/${fileId}`, baseURL!).href);
        await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("A");
        await expect(other.getByRole("textbox", { name: "Markdown source" })).toBeEditable({ timeout: 20_000 });
      } finally { await other.close(); }
    } finally { release(); await page.unroute(`**/api/private/tree/files/${fileId}`); }
  } finally { await context.close(); }
});

test("editing after a same-tab rename saves against its refreshed parent listing", async ({ browser, server, baseURL }) => {
  const { context, page, fileId } = await openEditor(browser, server, baseURL!);
  try {
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Rename" });
    await dialog.getByRole("textbox", { name: "Name" }).fill("Renamed.md");
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Renamed.md" })).toBeVisible();
    await page.getByRole("textbox", { name: "Markdown source" }).fill("# after rename");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved", { timeout: 20_000 });
    await page.goto(new URL(`/f/${fileId}`, baseURL!).href);
    await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("# after rename");
  } finally { await context.close(); }
});
