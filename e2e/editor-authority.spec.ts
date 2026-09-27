import { test, expect } from "./fixtures";
import { filePatch, openEditor, warnsOnUnload } from "./editor-workspace.fixture";

test.setTimeout(240_000);

test("a retained draft cannot be shortcut-saved while same-File authority is unverified", async ({ browser, server, baseURL }, testInfo) => {
  const { context, page, fileId } = await openEditor(browser, server, baseURL!);
  const fileRoute = `**/api/private/tree/files/${fileId}`;
  const ancestors = `**/api/private/tree/nodes/${fileId}/ancestors`;
  const shortcut = testInfo.project.name === "webkit" ? "Meta+s" : "Control+s";
  let releaseRetry: (() => void) | undefined;
  try {
    const editor = page.getByRole("textbox", { name: "Markdown source" });
    const status = page.getByRole("status", { name: "Save status" });
    await editor.fill("saved A");
    await expect(status).toHaveText("Saved", { timeout: 20_000 });

    await page.route(fileRoute, (route) => filePatch(route.request(), fileId) ? route.abort() : route.continue());
    await editor.fill("local B while verification fails");
    await expect(status).toHaveText("Couldn't save", { timeout: 20_000 });
    await page.route(ancestors, (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
    await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Workspace.md" }).click();
    await expect(page.getByRole("dialog", { name: "Unsaved File" })).toBeVisible();
    await page.getByRole("button", { name: "Discard and leave" }).click();
    await expect(page.getByRole("button", { name: "Retry Files", exact: true })).toBeVisible();
    await expect(editor).toHaveAttribute("readonly", "");
    await expect(page.getByRole("button", { name: "Retry save" })).toBeDisabled();
    await expect(editor).toHaveValue("local B while verification fails");
    expect(await warnsOnUnload(page)).toBe(true);

    await page.unroute(fileRoute); // Connectivity returns, but verification has not succeeded.
    let patches = 0;
    page.on("request", (request) => { if (filePatch(request, fileId)) patches++; });
    await page.keyboard.press(shortcut);
    await page.waitForTimeout(900); // Catch a stray debounce or queued shortcut save, not just an immediate write.
    expect(patches).toBe(0);
    await expect(status).toHaveText("Couldn't save");
    await expect(editor).toHaveValue("local B while verification fails");

    const reader = await context.newPage();
    try {
      await reader.goto(new URL(`/f/${fileId}`, baseURL!).href);
      await expect(reader.getByRole("textbox", { name: "Markdown source" })).toHaveValue("saved A");
    } finally { await reader.close(); }

    await page.unroute(ancestors);
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    let retryStarted!: () => void;
    const retryRead = new Promise<void>((resolve) => { retryStarted = resolve; });
    await page.route(ancestors, async (route) => {
      const response = await route.fetch(); // A real Worker read, with its response delayed to the page.
      retryStarted();
      await retryGate;
      try { await route.fulfill({ response }); }
      catch { /* Closing a failed test may cancel the read. */ }
    });
    await page.getByRole("button", { name: "Retry Files" }).click();
    await retryRead;
    await expect(editor).toHaveAttribute("readonly", "");
    await page.keyboard.press(shortcut);
    await page.waitForTimeout(900);
    expect(patches).toBe(0);
    await expect(status).toHaveText("Couldn't save");
    await expect(editor).toHaveValue("local B while verification fails");

    releaseRetry!();
    await expect(editor).toBeEditable({ timeout: 20_000 });
    await expect(editor).toHaveValue("local B while verification fails");
    const save = page.waitForRequest((request) => filePatch(request, fileId));
    await page.keyboard.press(shortcut);
    await save;
    await expect(status).toHaveText("Saved", { timeout: 20_000 });
    expect(patches).toBe(1);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("local B while verification fails");
  } finally { releaseRetry?.(); await page.unroute(ancestors); await context.close(); }
});
