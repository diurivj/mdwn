import { test, expect } from "./fixtures";
import { filePatch, openEditor, warnsOnUnload } from "./editor-workspace.fixture";

test.setTimeout(240_000);

function lateInput(area: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, value);
  area.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
}

test("clean outgoing navigation freezes editing until a cancelled navigation restores it", async ({ browser, server, baseURL }) => {
  const { context, page, fileId, rootId } = await openEditor(browser, server, baseURL!);
  const path = `**/api/private/tree/nodes/${rootId}/ancestors`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const read = new Promise<void>((resolve) => { started = resolve; });
  try {
    const editor = page.getByRole("textbox", { name: "Markdown source" });
    const status = page.getByRole("status", { name: "Save status" });
    await editor.fill("saved A");
    await expect(status).toHaveText("Saved", { timeout: 20_000 });
    let patches = 0;
    page.on("request", (request) => { if (filePatch(request, fileId)) patches++; });
    await page.route(path, async (route) => {
      const response = await route.fetch();
      started();
      await gate;
      try { await route.fulfill({ response }); }
      catch { /* RR cancelled the destination read after another navigation. */ }
    });
    await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Files" }).click();
    await read;
    await expect(editor).toHaveAttribute("readonly", "");
    await editor.evaluate(lateInput, "late B");
    await expect(editor).toHaveValue("saved A");
    // A second native navigation cancels the pending destination read.
    await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Workspace.md" }).click();
    release();
    await expect(page).toHaveURL(new URL(`/f/${fileId}`, baseURL!).href);
    await expect(editor).toBeEditable();
    expect(patches).toBe(0);
    await editor.fill("after cancellation");
    await expect(status).toHaveText("Saved", { timeout: 20_000 });
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("after cancellation");
  } finally { release(); await page.unroute(path); await context.close(); }
});

test("cancelling a proceeded blocker restores editability and protects a fresh draft", async ({ browser, server, baseURL }) => {
  const { context, page, fileId, rootId } = await openEditor(browser, server, baseURL!);
  const path = `**/api/private/tree/nodes/${rootId}/ancestors`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const read = new Promise<void>((resolve) => { started = resolve; });
  try {
    const editor = page.getByRole("textbox", { name: "Markdown source" });
    const status = page.getByRole("status", { name: "Save status" });
    await page.route(path, async (route) => {
      const response = await route.fetch();
      started();
      await gate;
      try { await route.fulfill({ response }); }
      catch { /* RR cancelled the destination read. */ }
    });
    await editor.fill("flushed before cancellation");
    await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Files" }).click();
    await read;
    await expect(editor).toHaveAttribute("readonly", "");
    await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Workspace.md" }).click();
    release();
    await expect(page).toHaveURL(new URL(`/f/${fileId}`, baseURL!).href);
    await expect(editor).toBeEditable();
    await expect(editor).toHaveValue("flushed before cancellation");
    await editor.fill("new draft after cancellation");
    await expect(status).toHaveText("Unsaved");
    expect(await warnsOnUnload(page)).toBe(true);
    await page.unroute(path);
    await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Files" }).click();
    await expect(page).toHaveURL(new URL(`/d/${rootId}`, baseURL!).href);
    await page.goto(new URL(`/f/${fileId}`, baseURL!).href);
    await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("new draft after cancellation");
  } finally { release(); await page.unroute(path); await context.close(); }
});

test("a blocked navigation freezes editing after its draft flush succeeds", async ({ browser, server, baseURL }) => {
  const { context, page, fileId, rootId } = await openEditor(browser, server, baseURL!);
  const path = `**/api/private/tree/nodes/${rootId}/ancestors`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const read = new Promise<void>((resolve) => { started = resolve; });
  try {
    const editor = page.getByRole("textbox", { name: "Markdown source" });
    await editor.fill("saved A");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved", { timeout: 20_000 });
    let patches = 0;
    page.on("request", (request) => { if (filePatch(request, fileId)) patches++; });
    await page.route(path, async (route) => {
      const response = await route.fetch();
      started();
      await gate;
      try { await route.fulfill({ response }); }
      catch { /* RR cancelled the destination read after another navigation. */ }
    });
    await editor.fill("pending B");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Unsaved");
    await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Files" }).click();
    await read; // blocker flush and proceed have run, but the destination has not mounted.
    await expect(editor).toHaveAttribute("readonly", "");
    await editor.evaluate(lateInput, "late C");
    await expect(editor).toHaveValue("pending B");
    expect(patches).toBe(1);
    release();
    await expect(page).toHaveURL(new URL(`/d/${rootId}`, baseURL!).href);
    await page.goto(new URL(`/f/${fileId}`, baseURL!).href);
    await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("pending B");
  } finally { release(); await page.unroute(path); await context.close(); }
});
