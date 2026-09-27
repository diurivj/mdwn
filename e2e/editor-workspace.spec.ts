import { test, expect } from "./fixtures";
import { openEditor, warnsOnUnload, filePatch } from "./editor-workspace.fixture";
import { commitConcurrentFileRevision } from "./editor-conflict.fixture";

test.setTimeout(240_000);

test("edits and previews privately, flushes on shortcut/navigation, enforces bytes, and transfers the editing lease", async ({ browser, server, baseURL }, testInfo) => {
  const { context, page, fileId, accountId, deviceId } = await openEditor(browser, server, baseURL!);
  try {
    await expect(page.getByRole("heading", { name: "Workspace.md" })).toBeVisible();
    const editor = page.getByRole("textbox", { name: "Markdown source" });
    await expect(editor).toBeEditable();
    await expect(page.getByRole("region", { name: "Preview" })).toBeVisible();
    const saveStatus = page.getByRole("status", { name: "Save status" });
    let patchCount = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === `/api/private/tree/files/${fileId}` && request.method() === "PATCH") patchCount++;
    });
    await expect(saveStatus).toHaveText("Saved");
    const source = "## Live preview\n- [x] done\n<script>window.privateLeak = true</script>";
    await editor.fill(source);
    await expect(saveStatus).toHaveText("Unsaved");
    expect(await warnsOnUnload(page)).toBe(true);
    await page.waitForTimeout(250); // Below the specified 750 ms debounce.
    expect(patchCount).toBe(0);
    const save = page.waitForRequest((request) => new URL(request.url()).pathname === `/api/private/tree/files/${fileId}` &&
      request.method() === "PATCH");
    await editor.press(testInfo.project.name === "webkit" ? "Meta+s" : "Control+s");
    const submitted = await save;
    expect(submitted.postData()).not.toContain(source);
    await expect(saveStatus).toHaveText("Saved", { timeout: 20_000 });
    expect(await warnsOnUnload(page)).toBe(false);
    await expect(page.getByRole("heading", { name: "Live preview" })).toBeVisible();
    await expect(page.getByRole("checkbox")).toBeChecked();
    expect(await page.locator("script").filter({ hasText: "privateLeak" }).count()).toBe(0);
    const html = await (await page.request.get(`/f/${fileId}`)).text();
    expect(html).not.toContain(source);

    await page.setViewportSize({ width: 390, height: 800 });
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(editor).toBeHidden();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(editor).toHaveValue(source);
    await page.getByRole("button", { name: "Tree", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Files tree" })).toBeVisible();
    await page.getByRole("button", { name: "Close tree" }).click();

    await editor.fill("a".repeat(235_930));
    await expect(page.getByText("235930 / 262144 bytes")).toBeVisible();
    await editor.fill("a".repeat(262_140) + "🙂");
    await expect(page.getByText("262144 / 262144 bytes — File limit reached")).toBeVisible();
    await expect(saveStatus).toHaveText("Saved", { timeout: 20_000 });
    const atLimitSaves = patchCount;
    await editor.press("End");
    await editor.press("b");
    await expect(editor).toHaveValue("a".repeat(262_140) + "🙂");
    await editor.evaluate((area: HTMLTextAreaElement) => {
      area.setSelectionRange(area.value.length, area.value.length);
      const data = new DataTransfer();
      data.setData("text/plain", "🙂");
      area.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    });
    await expect(editor).toHaveValue("a".repeat(262_140) + "🙂");
    await editor.evaluate((area: HTMLTextAreaElement) => {
      area.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "🙂" }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, area.value + "🙂");
      area.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "🙂" }));
      area.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "🙂" }));
    });
    await expect(editor).toHaveValue("a".repeat(262_140) + "🙂");
    await page.waitForTimeout(800); // Rejected typing/paste/composition must not schedule a save.
    expect(patchCount).toBe(atLimitSaves);
    await editor.fill("a".repeat(262_144));
    await expect(saveStatus).toHaveText("Unsaved");
    // A File navigation must flush before leaving; no local draft persistence.
    await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Files" }).click();
    await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();
    await page.getByRole("button", { name: "Tree", exact: true }).click();
    await page.getByRole("navigation", { name: "Files" }).getByRole("link", { name: "Workspace.md" }).click();
    await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("a".repeat(262_144));

    // A failed network save preserves the tab-local draft and blocks in-app navigation.
    await page.route("**/api/private/tree/files/*", (route) => route.request().method() === "PATCH"
      ? route.abort() : route.continue());
    await page.getByRole("textbox", { name: "Markdown source" }).fill("# unsent local draft");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Couldn't save", { timeout: 15_000 });
    expect(await warnsOnUnload(page)).toBe(true);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download local draft" }).click();
    expect((await download).suggestedFilename()).toBe("draft.md");
    await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Files" }).click();
    await expect(page.getByRole("dialog", { name: "Unsaved File" })).toBeVisible();
    await page.getByRole("button", { name: "Stay" }).click();
    await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("# unsent local draft");
    await page.unroute("**/api/private/tree/files/*");
    await page.getByRole("button", { name: "Retry save" }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved", { timeout: 20_000 });
    expect(await warnsOnUnload(page)).toBe(false);

    const other = await context.newPage();
    try {
      await other.goto(new URL(`/f/${fileId}`, baseURL!).href);
      await expect(other.getByRole("textbox", { name: "Markdown source" })).toHaveAttribute("readonly", "");
      let releaseSave!: () => void;
      const pauseSave = new Promise<void>((resolve) => { releaseSave = resolve; });
      await page.route("**/api/private/tree/files/*", async (route) => {
        if (route.request().method() === "PATCH") await pauseSave;
        await route.continue();
      });
      try {
        const pendingSave = page.waitForRequest((request) => filePatch(request, fileId));
        await page.getByRole("textbox", { name: "Markdown source" }).fill("# survives structural rename");
        await pendingSave;
        await other.getByRole("button", { name: "Rename", exact: true }).click();
        const rename = other.getByRole("dialog", { name: "Rename" });
        await rename.getByRole("textbox", { name: "Name" }).fill("Renamed.md");
        await rename.getByRole("button", { name: "Rename", exact: true }).click();
        await expect(other.getByRole("heading", { name: "Renamed.md" })).toBeVisible();
        releaseSave();
        await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved");
        await expect(page.getByRole("button", { name: "Confirm overwrite" })).toHaveCount(0);
        await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("# survives structural rename");
        await expect(page.getByRole("heading", { name: "Renamed.md" })).toBeVisible();
      } finally { releaseSave(); await page.unroute("**/api/private/tree/files/*"); }

      // A real concurrent File revision, not the Directory rename, must reject a
      // PATCH based on the earlier File head. Keep the server request pending while
      // the independently signed representation becomes current in migrated D1.
      let releaseStale!: () => void;
      const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
      await page.route(`**/api/private/tree/files/${fileId}`, async (route) => {
        if (filePatch(route.request(), fileId)) await staleGate;
        await route.continue();
      });
      try {
        const staleRequest = page.waitForRequest((request) => filePatch(request, fileId));
        const staleResponse = page.waitForResponse((response) => filePatch(response.request(), fileId) && response.status() === 409);
        await page.getByRole("textbox", { name: "Markdown source" }).fill("# preserve this conflict draft");
        await staleRequest;
        await commitConcurrentFileRevision({ server, page: other, accountId, deviceId, fileId,
          source: "# committed elsewhere" });
        await other.reload();
        await expect(other.getByRole("textbox", { name: "Markdown source" })).toHaveValue("# committed elsewhere");
        releaseStale();
        await staleResponse;
        await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Couldn't save");
        await expect(page.getByText("This File changed elsewhere.", { exact: false })).toBeVisible();
        await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("# preserve this conflict draft");
        await page.getByRole("button", { name: "Confirm overwrite" }).click();
        await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved");
        await other.reload();
        await expect(other.getByRole("textbox", { name: "Markdown source" }))
          .toHaveValue("# preserve this conflict draft");
      } finally { releaseStale(); await page.unroute(`**/api/private/tree/files/${fileId}`); }
      await other.getByRole("button", { name: "Edit here" }).click();
      await expect(page.getByRole("dialog", { name: "Transfer editing" })).toBeVisible();
      await page.getByRole("dialog", { name: "Transfer editing" }).getByRole("button", { name: "Save and transfer" }).click();
      await expect(other.getByRole("textbox", { name: "Markdown source" })).toBeEditable();
      await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveAttribute("readonly", "");
    } finally { await other.close(); }
  } finally { await context.close(); }
});
