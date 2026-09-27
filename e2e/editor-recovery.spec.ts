import { test, expect } from "./fixtures";
import { filePatch, openEditor, warnsOnUnload } from "./editor-workspace.fixture";
import { seedLegacyOversizedFile } from "./editor-legacy.fixture";
import { commitConcurrentFileRevision } from "./editor-conflict.fixture";

test.setTimeout(240_000);

test("reload keeps a failed draft safe while verified reads are delayed", async ({ browser, server, baseURL }) => {
  const { context, page, fileId, rootId } = await openEditor(browser, server, baseURL!);
  try {
    const editor = page.getByRole("textbox", { name: "Markdown source" });
    const status = page.getByRole("status", { name: "Save status" });
    await page.route(`**/api/private/tree/files/${fileId}`, (route) => filePatch(route.request(), fileId)
      ? route.abort() : route.continue());
    await editor.fill("# failed local draft");
    await expect(status).toHaveText("Couldn't save", { timeout: 20_000 });
    await page.unroute(`**/api/private/tree/files/${fileId}`);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let readStarted!: () => void;
    const read = new Promise<void>((resolve) => { readStarted = resolve; });
    await page.route(`**/api/private/tree/directories/${rootId}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      readStarted();
      await gate;
      await route.fulfill({ response });
    });
    try {
      await page.getByRole("button", { name: "Reload and discard local draft" }).click();
      await read;
      await expect(editor).toHaveAttribute("readonly", "");
      await expect(page.getByRole("button", { name: "Reload and discard local draft" })).toBeDisabled();
      expect(await warnsOnUnload(page)).toBe(true);
      // Even a synthetic late input must not replace the result of a deliberate reload.
      await editor.evaluate((area: HTMLTextAreaElement) => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "# late typing");
        area.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "# late typing" }));
      });
      release();
      await expect(editor).toHaveValue("");
      await expect(status).toHaveText("Saved");
      expect(await warnsOnUnload(page)).toBe(false);
    } finally { release(); await page.unroute(`**/api/private/tree/directories/${rootId}`); }
  } finally { await context.close(); }
});

test("explicit overwrite serializes a delayed write and saves subsequent typing", async ({ browser, server, baseURL }, testInfo) => {
  const { context, page, fileId, accountId, deviceId } = await openEditor(browser, server, baseURL!);
  try {
    const editor = page.getByRole("textbox", { name: "Markdown source" });
    const status = page.getByRole("status", { name: "Save status" });
    const other = await context.newPage();
    try {
      await other.goto(new URL(`/f/${fileId}`, baseURL!).href);
      let releaseStale!: () => void;
      const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
      await page.route(`**/api/private/tree/files/${fileId}`, async (route) => {
        if (filePatch(route.request(), fileId)) await staleGate;
        await route.continue();
      });
      try {
        const staleRequest = page.waitForRequest((request) => filePatch(request, fileId));
        const staleResponse = page.waitForResponse((response) => filePatch(response.request(), fileId) && response.status() === 409);
        await editor.fill("# overwrite B");
        await staleRequest;
        await commitConcurrentFileRevision({ server, page: other, accountId, deviceId, fileId,
          source: "# committed A by another editor" });
        await other.reload();
        await expect(other.getByRole("textbox", { name: "Markdown source" })).toHaveValue("# committed A by another editor");
        releaseStale();
        await staleResponse;
        await expect(status).toHaveText("Couldn't save", { timeout: 20_000 });
        await expect(editor).toHaveValue("# overwrite B");
        await expect(page.getByRole("button", { name: "Confirm overwrite" })).toBeVisible();
      } finally { releaseStale(); await page.unroute(`**/api/private/tree/files/${fileId}`); }
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let committed!: () => void;
      const firstCommitted = new Promise<void>((resolve) => { committed = resolve; });
      let patches = 0;
      await page.route(`**/api/private/tree/files/${fileId}`, async (route) => {
        if (!filePatch(route.request(), fileId)) return route.continue();
        patches++;
        if (patches !== 1) return route.continue();
        const response = await route.fetch();
        committed();
        await gate;
        await route.fulfill({ response });
      });
      try {
        await page.getByRole("button", { name: "Confirm overwrite" }).click();
        await firstCommitted;
        await editor.fill("# final C");
        await editor.press(testInfo.project.name === "webkit" ? "Meta+s" : "Control+s");
        await other.getByRole("button", { name: "Edit here" }).click();
        const transfer = page.getByRole("dialog", { name: "Transfer editing" });
        await expect(transfer.getByRole("button", { name: "Discard and transfer" })).toBeDisabled();
        expect(await warnsOnUnload(page)).toBe(true);
        expect(patches).toBe(1); // No stale-revision second PATCH before the first has settled.
        await transfer.getByRole("button", { name: "Keep editing" }).click();
        await other.getByRole("button", { name: "Cancel request" }).click();
        release();
        await expect(status).toHaveText("Saved", { timeout: 30_000 });
        await expect.poll(() => patches).toBe(2);
        await page.goto(new URL(`/f/${fileId}`, baseURL!).href);
        await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("# final C");
      } finally { release(); await page.unroute(`**/api/private/tree/files/${fileId}`); }
    } finally { await other.close(); }
  } finally { await context.close(); }
});

test("an encrypted legacy oversized File is readable, exportable and only saves after reduction", async ({ browser, server, baseURL }) => {
  const opened = await openEditor(browser, server, baseURL!);
  const { context, page } = opened;
  const db = (await server.getWorker<{ DB: D1Database }>().getEnv()).DB;
  try {
    const { source, fileId } = await seedLegacyOversizedFile({ ...opened, server });
    expect(await db.prepare("SELECT encoding FROM directory_entries WHERE child_node_id = ?")
      .bind(fileId).first()).toEqual({ encoding: "legacy-file" });
    expect(await db.prepare("SELECT revision FROM file_heads WHERE file_node_id = ?")
      .bind(fileId).first()).toBeNull();
    await page.goto(new URL(`/f/${fileId}`, baseURL!).href);
    const editor = page.getByRole("textbox", { name: "Markdown source" });
    const status = page.getByRole("status", { name: "Save status" });
    await expect(editor).toHaveValue(source);
    await expect(status).toHaveText("Couldn't save");
    await expect(page.getByText("262146 / 262144 bytes — File limit reached")).toBeVisible();
    await expect(page.getByRole("button", { name: "Reduce content" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reload and discard local draft" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm overwrite" })).toHaveCount(0);
    let patches = 0;
    page.on("request", (request) => { if (filePatch(request, fileId)) patches++; });
    await page.getByRole("button", { name: "Copy local draft" }).click();
    await expect(page.getByRole("alert")).toContainText(/Local draft copied|Copy unavailable/);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download local draft" }).click();
    expect((await download).suggestedFilename()).toBe("draft.md");
    expect(await warnsOnUnload(page)).toBe(true);
    await editor.evaluate((area: HTMLTextAreaElement) => area.setSelectionRange(area.value.length, area.value.length));
    await editor.press("b");
    await expect(editor).toHaveValue(source); // Oversized legacy edits must reduce, never grow.
    expect(patches).toBe(0);
    await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Files" }).click();
    await expect(page.getByRole("dialog", { name: "Unsaved File" })).toBeVisible();
    await page.getByRole("button", { name: "Stay" }).click();
    await page.getByRole("button", { name: "Reload and discard local draft" }).click();
    await expect(editor).toBeEditable();
    await expect(editor).toHaveValue(source);
    await expect(status).toHaveText("Couldn't save");
    await editor.evaluate((area: HTMLTextAreaElement) => area.setSelectionRange(area.value.length, area.value.length));
    await editor.press("Backspace");
    await expect(editor).toHaveValue("a".repeat(262_145));
    await expect(status).toHaveText("Couldn't save");
    await page.waitForTimeout(850);
    expect(patches).toBe(0);
    expect(await warnsOnUnload(page)).toBe(true);
    await editor.press("Backspace");
    await expect(editor).toHaveValue("a".repeat(262_144));
    await expect(status).toHaveText("Saved", { timeout: 30_000 });
    expect(patches).toBe(1);
    expect(await db.prepare("SELECT encoding FROM directory_entries WHERE child_node_id = ?")
      .bind(fileId).first()).toEqual({ encoding: "receiving-file" });
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("a".repeat(262_144));
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved");
  } finally { await context.close(); }
});
