import { test, expect } from "./fixtures";
import { completeRecoveryPresentation } from "./signup-recovery";

test.setTimeout(240_000);

test("edits and previews privately, flushes on shortcut/navigation, enforces bytes, and transfers the editing lease", async ({ browser, server, baseURL }, testInfo) => {
  const worker = server.getWorker<{ DB: D1Database }>();
  await worker.applyD1Migrations("DB");
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1200, height: 850 } });
  await context.addInitScript(() => {
    if (typeof globalThis.PublicKeyCredential !== "function") {
      Object.defineProperty(globalThis, "PublicKeyCredential", { configurable: true,
        value: class PublicKeyCredential {} });
    }
  });
  await context.credentials.install();
  const page = await context.newPage();
  try {
    await page.goto(new URL("/sign-up", baseURL!).href, { waitUntil: "commit" });
    const verify = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/signup/verify" &&
      request.method() === "POST", { timeout: 120_000 });
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await completeRecoveryPresentation(page);
    const signup = (await verify).postDataJSON() as { transcript: { rootDirectoryId: string } };
    await expect(page.getByText("Your account is ready.", { exact: false })).toBeVisible({ timeout: 120_000 });
    await page.goto(new URL(`/d/${signup.transcript.rootDirectoryId}`, baseURL!).href);
    await page.getByRole("button", { name: "New File" }).click();
    const create = page.getByRole("dialog", { name: "Create a name" });
    await create.getByRole("textbox", { name: "Name" }).fill("Workspace.md");
    await create.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Workspace.md" })).toBeVisible();
    const fileId = new URL(page.url()).pathname.split("/").at(-1)!;
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
    const warnsOnUnload = () => page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(await warnsOnUnload()).toBe(true);
    await page.waitForTimeout(250); // Below the specified 750 ms debounce.
    expect(patchCount).toBe(0);
    const save = page.waitForRequest((request) => new URL(request.url()).pathname === `/api/private/tree/files/${fileId}` &&
      request.method() === "PATCH");
    await editor.press(testInfo.project.name === "webkit" ? "Meta+s" : "Control+s");
    const submitted = await save;
    expect(submitted.postData()).not.toContain(source);
    await expect(saveStatus).toHaveText("Saved", { timeout: 20_000 });
    expect(await warnsOnUnload()).toBe(false);
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
    expect(await warnsOnUnload()).toBe(true);
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
    expect(await warnsOnUnload()).toBe(false);

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
        const pendingSave = page.waitForRequest((request) => request.method() === "PATCH" &&
          new URL(request.url()).pathname === `/api/private/tree/files/${fileId}`);
        await page.getByRole("textbox", { name: "Markdown source" }).fill("# preserve this conflict draft");
        await pendingSave;
        await other.getByRole("button", { name: "Rename", exact: true }).click();
        const rename = other.getByRole("dialog", { name: "Rename" });
        await rename.getByRole("textbox", { name: "Name" }).fill("Renamed.md");
        await rename.getByRole("button", { name: "Rename", exact: true }).click();
        await expect(other.getByRole("heading", { name: "Renamed.md" })).toBeVisible();
        releaseSave();
        await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Couldn't save");
        await expect(page.getByText("This File changed elsewhere.", { exact: false })).toBeVisible();
        await page.getByRole("button", { name: "Confirm overwrite" }).click();
        await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved");
        await expect(page.getByRole("textbox", { name: "Markdown source" }))
          .toHaveValue("# preserve this conflict draft");
        await expect(page.getByRole("heading", { name: "Renamed.md" })).toBeVisible();
      } finally { releaseSave(); await page.unroute("**/api/private/tree/files/*"); }
      await other.getByRole("button", { name: "Edit here" }).click();
      await expect(page.getByRole("dialog", { name: "Transfer editing" })).toBeVisible();
      await page.getByRole("dialog", { name: "Transfer editing" }).getByRole("button", { name: "Save and transfer" }).click();
      await expect(other.getByRole("textbox", { name: "Markdown source" })).toBeEditable();
      await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveAttribute("readonly", "");
    } finally { await other.close(); }
  } finally { await context.close(); }
});
