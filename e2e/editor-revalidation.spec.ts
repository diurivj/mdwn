import { test, expect } from "./fixtures";
import { filePatch, openEditor, warnsOnUnload } from "./editor-workspace.fixture";

test.setTimeout(240_000);

test("a new File route cannot inherit the snapshot retained after another File's failed refresh", async ({ browser, server, baseURL }) => {
  const { context, page, fileId } = await openEditor(browser, server, baseURL!);
  const ancestors = `**/api/private/tree/nodes/${fileId}/ancestors`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const read = new Promise<void>((resolve) => { started = resolve; });
  try {
    await page.getByRole("button", { name: "New File" }).click();
    const create = page.getByRole("dialog", { name: "Create a name" });
    await create.getByRole("textbox", { name: "Name" }).fill("Second.md");
    await create.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Second.md" })).toBeVisible();
    const secondId = new URL(page.url()).pathname.split("/").at(-1)!;
    await page.getByRole("navigation", { name: "Files" }).getByRole("link", { name: "Workspace.md" }).click();
    await expect(page).toHaveURL(new URL(`/f/${fileId}`, baseURL!).href);
    const editor = page.getByRole("textbox", { name: "Markdown source" });
    await editor.fill("first File's private content");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved", { timeout: 20_000 });
    await page.route(ancestors, async (route) => {
      await route.fetch();
      started();
      await gate;
      try { await route.fulfill({ status: 503, contentType: "application/json", body: "{}" }); }
      catch { /* Cleanup may cancel the failed read. */ }
    });
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const rename = page.getByRole("dialog", { name: "Rename" });
    await rename.getByRole("textbox", { name: "Name" }).fill("Renamed.md");
    await rename.getByRole("button", { name: "Rename", exact: true }).click();
    await read;
    release();
    await expect(page.getByRole("button", { name: "Retry Files" })).toBeVisible();
    await page.getByRole("navigation", { name: "Files" }).getByRole("link", { name: "Second.md" }).click();
    await expect(page).toHaveURL(new URL(`/f/${secondId}`, baseURL!).href);
    await expect(page.getByRole("heading", { name: "Second.md" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("");
    await expect(page.getByText("first File's private content")).toHaveCount(0);
  } finally { release(); await page.unroute(ancestors); await context.close(); }
});

test("a failed same-File rename revalidation preserves the editor but freezes edits until retry", async ({ browser, server, baseURL }) => {
  const { context, page, fileId } = await openEditor(browser, server, baseURL!);
  const ancestors = `**/api/private/tree/nodes/${fileId}/ancestors`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const read = new Promise<void>((resolve) => { started = resolve; });
  let releaseRetry: (() => void) | undefined;
  try {
    const editor = page.getByRole("textbox", { name: "Markdown source" });
    const status = page.getByRole("status", { name: "Save status" });
    await editor.fill("saved A before rename");
    await expect(status).toHaveText("Saved", { timeout: 20_000 });
    let patches = 0;
    page.on("request", (request) => { if (filePatch(request, fileId)) patches++; });
    await page.route(ancestors, async (route) => {
      await route.fetch(); // Rename really committed to the migrated D1 Worker.
      started();
      await gate;
      try { await route.fulfill({ status: 503, contentType: "application/json", body: "{}" }); }
      catch { /* Test cleanup may cancel an in-flight route. */ }
    });
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Rename" });
    await dialog.getByRole("textbox", { name: "Name" }).fill("Renamed.md");
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await read;
    await expect(editor).toHaveAttribute("readonly", "");
    await expect(page.getByRole("button", { name: "Rename", exact: true })).toBeDisabled();
    await editor.evaluate((area: HTMLTextAreaElement) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "late C");
      area.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "late C" }));
      area.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "late C" }));
      area.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "late C" }));
    });
    await expect(editor).toHaveValue("saved A before rename");
    const pasteBlocked = await editor.evaluate((area: HTMLTextAreaElement) => {
      const data = new DataTransfer();
      data.setData("text/plain", "unverified paste");
      return !area.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    });
    expect(pasteBlocked).toBe(true);
    release();
    await expect(page.getByRole("alert")).toContainText("could not be verified", { timeout: 20_000 });
    await expect(editor).toHaveValue("saved A before rename");
    await expect(editor).toHaveAttribute("readonly", "");
    await expect(page.getByRole("button", { name: "Retry save" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Reload and discard local draft" })).toBeDisabled();
    await page.getByRole("button", { name: "Copy local draft" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /Local draft copied|Copy unavailable/ })).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download local draft" }).click();
    expect((await download).suggestedFilename()).toBe("draft.md");
    expect(patches).toBe(0);
    expect(await warnsOnUnload(page)).toBe(false); // Saved A is still the current representation.
    await page.unroute(ancestors);
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    let retryStarted!: () => void;
    const retryRead = new Promise<void>((resolve) => { retryStarted = resolve; });
    await page.route(ancestors, async (route) => {
      const response = await route.fetch();
      retryStarted();
      await retryGate;
      try { await route.fulfill({ response }); }
      catch { /* Cleanup may cancel the retry. */ }
    });
    await page.getByRole("button", { name: "Retry Files" }).click();
    await retryRead;
    await expect(page.getByRole("button", { name: "Retrying Files…" })).toBeDisabled();
    await expect(editor).toHaveAttribute("readonly", "");
    releaseRetry!();
    await expect(page.getByRole("heading", { name: "Renamed.md" })).toBeVisible({ timeout: 20_000 });
    await expect(editor).toBeEditable();
    await expect(editor).toHaveValue("saved A before rename");
    await editor.fill("after verified retry");
    await expect(status).toHaveText("Saved", { timeout: 20_000 });
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("after verified retry");
    // A well-formed but missing File identity cannot inherit this tab's old snapshot.
    await page.goto(new URL("/f/00000000-0000-7000-8000-000000000000", baseURL!).href);
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveCount(0);
  } finally { release(); releaseRetry?.(); await page.unroute(ancestors); await context.close(); }
});
