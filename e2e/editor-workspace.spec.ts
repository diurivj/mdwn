import type { Locator } from "@playwright/test";
import { installWorkspaceScript, test, expect } from "./workspace-fixture";

async function pasteText(source: Locator, text: string, start: number, end: number) {
  await source.evaluate(
    (element, selection) => {
      const textarea = element as HTMLTextAreaElement;
      textarea.setSelectionRange(selection.start, selection.end);
      const data = new DataTransfer();
      data.setData("text/plain", selection.text);
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: data });
      textarea.dispatchEvent(event);
    },
    { text, start, end },
  );
}

test("edits a tab-local draft and renders sanitized GFM live in the split workspace", async ({ page, workspace }) => {
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  await source.fill("# Local draft\n\n~~removed~~\n\n<script>alert('unsafe')</script>");
  await expect(
    page.getByRole("region", { name: "Preview", exact: true }).getByRole("heading", { name: "Local draft" }),
  ).toBeVisible();
  await expect(page.locator("del")).toHaveText("removed");
  await expect(page.getByRole("region", { name: "Preview", exact: true }).locator("script")).toHaveCount(0);
  const document = await page.request.get(`/f/${workspace.fileId}`);
  expect(await document.text()).not.toContain("Local draft");
});

test("measures UTF-8 bytes, gives 90% feedback, and rejects a whole over-limit edit", async ({ page, workspace }) => {
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  await source.fill("a".repeat(235_929));
  await expect(page.getByText("235,929 / 262,144", { exact: true })).toHaveCount(0);
  await source.fill("a".repeat(235_930));
  await expect(page.getByText("235,930 / 262,144", { exact: true })).toBeVisible();
  const exact = "🙂".repeat(65_536);
  await source.fill(exact);
  await expect(page.getByText("262,144 / 262,144", { exact: true })).toBeVisible();
  await expect(page.getByText("File limit reached", { exact: true })).toBeVisible();
  await source.press("End");
  await source.press("x");
  await expect(source).toHaveValue(exact);
  await source.fill("a".repeat(262_145));
  await expect(source).toHaveValue(exact);
});

test("debounces autosave for 750 ms and Ctrl/Cmd+S flushes encrypted content immediately", async ({
  page,
  workspace,
}) => {
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  // Advance timers without putting request-bound proofs ahead of the Worker's real clock.
  const time = new Date(Date.now() - 10_000);
  await page.clock.install({ time });
  // Installation starts a running clock; pausing at its initial instant races
  // elapsed wall time. Leave headroom for the following 750 ms timer advance.
  await page.clock.pauseAt(new Date(Date.now() - 5_000));
  const saves: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname.endsWith(`/files/${workspace.fileId}`))
      saves.push(request.postData() ?? "");
  });
  await source.fill("# Autosaved private draft");
  await expect(page.getByText("Unsaved", { exact: true })).toBeVisible();
  await page.clock.runFor(749);
  expect(saves).toHaveLength(0);
  await page.clock.runFor(1);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(saves).toHaveLength(1);
  expect(saves[0]).not.toContain("Autosaved private draft");
  await source.fill("# Shortcut draft");
  await source.press("ControlOrMeta+s");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(saves).toHaveLength(2);
  await page.reload();
  await expect(source).toHaveValue("# Shortcut draft");
});

test("accepted paste cannot override a newer selection or replacement", async ({ page, workspace }) => {
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  // Hold animation frames until after the user has made a newer selection.
  // Keep the clock behind the Worker's real clock for request-bound proofs.
  const time = new Date(Date.now() - 10_000);
  await page.clock.install({ time });
  await page.clock.pauseAt(new Date(time.getTime() + 5_000));
  await source.fill("abc");
  await pasteText(source, "🙂", 1, 2);
  await expect(source).toHaveValue("a🙂c");
  await source.selectText();
  await page.clock.runFor(16);
  expect(
    await source.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      return [textarea.selectionStart, textarea.selectionEnd];
    }),
  ).toEqual([0, 4]);
  const replacement = "a".repeat(262_140);
  await page.keyboard.insertText(replacement);
  await expect(source).toHaveValue(replacement);
});

test("paste commits its caret before the next frame, including an unchanged draft", async ({ page, workspace }) => {
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  const time = new Date(Date.now() - 10_000);
  await page.clock.install({ time });
  await page.clock.pauseAt(new Date(time.getTime() + 5_000));
  for (const example of [
    { text: "🙂", value: "a🙂c", caret: 3 },
    { text: "b", value: "abc", caret: 2 },
  ]) {
    await source.fill("abc");
    await pasteText(source, example.text, 1, 2);
    await expect(source).toHaveValue(example.value);
    expect(
      await source.evaluate((element) => {
        const textarea = element as HTMLTextAreaElement;
        return [textarea.selectionStart, textarea.selectionEnd];
      }),
    ).toEqual([example.caret, example.caret]);
    await source.selectText();
    await page.clock.runFor(16);
    expect(
      await source.evaluate((element) => {
        const textarea = element as HTMLTextAreaElement;
        return [textarea.selectionStart, textarea.selectionEnd];
      }),
    ).toEqual([0, example.value.length]);
    await page.keyboard.insertText("# Newer edit");
    await expect(source).toHaveValue("# Newer edit");
    await expect(
      page
        .getByRole("region", { name: "Preview", exact: true })
        .getByRole("heading", { name: "Newer edit", exact: true }),
    ).toBeVisible();
  }
});

test("paste leaves no caret work after the editor is unmounted", async ({ page, workspace }) => {
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  await source.fill("abc");
  // Hold only animation frames: navigation's readiness timers must keep running.
  const frames = await page.evaluateHandle(() => {
    const request = window.requestAnimationFrame,
      cancel = window.cancelAnimationFrame;
    const pending = new Map<number, FrameRequestCallback>();
    window.requestAnimationFrame = (callback) => {
      const id = request.call(window, () => {});
      cancel.call(window, id);
      pending.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      pending.delete(id);
      cancel.call(window, id);
    };
    return () => {
      window.requestAnimationFrame = request;
      window.cancelAnimationFrame = cancel;
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(performance.now());
    };
  });
  try {
    await pasteText(source, "🙂", 1, 2);
    await expect(source).toHaveValue("a🙂c");
    const detached = await source.elementHandle();
    await source.press("ControlOrMeta+s");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page
      .getByRole("navigation", { name: "Breadcrumbs" })
      .getByRole("link", { name: "Files", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/d/${workspace.rootId}$`));
    await detached!.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(0, 0));
    await frames.evaluate((release) => release());
    expect(
      await detached!.evaluate((element) => {
        const textarea = element as HTMLTextAreaElement;
        return { connected: textarea.isConnected, selection: [textarea.selectionStart, textarea.selectionEnd] };
      }),
    ).toEqual({ connected: false, selection: [0, 0] });
  } finally {
    await frames.evaluate((release) => release());
    await frames.dispose();
  }
});

test("rejects paste and an entire composition result without draft loss or another save", async ({
  page,
  workspace,
}) => {
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  await source.fill("abc");
  await pasteText(source, "🙂", 1, 2);
  await expect(source).toHaveValue("a🙂c");
  const valid = "a".repeat(262_140);
  await source.fill(valid);
  await expect(source).toHaveValue(valid);
  await source.press("ControlOrMeta+s");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  let attempts = 0;
  page.on("request", (request) => {
    if (request.method() === "PATCH") attempts++;
  });
  await pasteText(source, "🙂x", valid.length, valid.length);
  await expect(source).toHaveValue(valid);
  await source.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, `${textarea.value}a`);
    textarea.dispatchEvent(
      new InputEvent("input", { bubbles: true, isComposing: true, inputType: "insertCompositionText" }),
    );
  });
  // A composition's intermediate value must not become an autosaved draft.
  await expect.poll(() => attempts, { timeout: 1_000 }).toBe(0);
  await source.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, `${textarea.value}🙂`);
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await expect(source).toHaveValue(valid);
  await expect(page.getByText("File limit reached", { exact: true })).toBeVisible();
  await page.waitForTimeout(900); // Prove a rejected proposal did not schedule the debounce.
  expect(attempts).toBe(0);
});

test("resumes autosave of a valid pending draft after rejecting a composition result", async ({ page, workspace }) => {
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  const time = new Date(Date.now() - 10_000);
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  const valid = "a".repeat(262_140);
  let attempts = 0;
  page.on("request", (request) => {
    if (request.method() === "PATCH") attempts++;
  });
  await source.fill(valid);
  await source.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      `${textarea.value}🙂x`,
    );
    textarea.dispatchEvent(
      new InputEvent("input", { bubbles: true, isComposing: true, inputType: "insertCompositionText" }),
    );
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });
  await expect(source).toHaveValue(valid);
  await expect(page.getByText("Unsaved", { exact: true })).toBeVisible();
  expect(attempts).toBe(0);
  await page.clock.runFor(750);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(attempts).toBe(1);
  await page.reload();
  await expect(source).toHaveValue(valid);
});

test("flushes before navigation and warns only while pending or failed, with explicit discard", async ({
  page,
  workspace,
}) => {
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  const warns = () =>
    page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
  expect(await warns()).toBe(false);
  await source.fill("# Saved before leaving");
  expect(await warns()).toBe(true);
  await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Files", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/d/${workspace.rootId}$`));
  await page.getByRole("navigation", { name: "Files", exact: true }).getByRole("link", { name: "Draft.md" }).click();
  await expect(source).toHaveValue("# Saved before leaving");
  expect(await warns()).toBe(false);
  await page.route(`**/api/private/tree/files/${workspace.fileId}`, (route) =>
    route.request().method() === "PATCH" ? route.abort("failed") : route.continue(),
  );
  await source.fill("# Failed but retained");
  await source.press("ControlOrMeta+s");
  await expect(page.getByText("Couldn't save", { exact: true })).toBeVisible();
  expect(await warns()).toBe(true);
  await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Files", exact: true }).click();
  const warning = page.getByRole("dialog", { name: "Unsaved File" });
  await expect(warning).toBeVisible();
  await warning.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(source).toHaveValue("# Failed but retained");
  await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Files", exact: true }).click();
  await warning.getByRole("button", { name: "Discard draft and leave", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/d/${workspace.rootId}$`));
  expect(await warns()).toBe(false);
});

test("a stale save preserves the draft, stops autosave, and overwrites only after explicit confirmation", async ({
  page,
  context,
  baseURL,
  workspace,
  workspaceScript,
}) => {
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  const other = await context.newPage();
  await installWorkspaceScript(other, workspaceScript, baseURL!);
  try {
    const response = await other.evaluate(
      async ({ fileId }) => {
        const api = window.workspaceFixture;
        const access = await api.openRoot();
        const document = await api.loadFile(access, fileId, access.rootKey);
        const listing = await api.loadDirectory(access, access.rootId, access.rootKey);
        const prepared = await api.prepareFileSave(
          access,
          fileId,
          access.rootKey,
          document,
          "# Remote winner",
          listing,
        );
        return (
          await api.privateRequest(`/api/private/tree/files/${fileId}`, {
            method: "PATCH",
            body: JSON.stringify(prepared.payload),
          })
        ).status;
      },
      { fileId: workspace.fileId },
    );
    expect(response).toBe(200);
    await source.fill("# Local conflict draft");
    await source.press("ControlOrMeta+s");
    await expect(page.getByText("Couldn't save", { exact: true })).toBeVisible();
    await expect(
      page.getByText("This File changed on another device. Your local draft is intact.", { exact: true }),
    ).toBeVisible();
    await expect(source).toHaveValue("# Local conflict draft");
    const current = await other.evaluate(
      async ({ fileId }) => {
        const api = window.workspaceFixture,
          access = await api.openRoot();
        return (await api.loadFile(access, fileId, access.rootKey)).markdown;
      },
      { fileId: workspace.fileId },
    );
    expect(current).toBe("# Remote winner");
    let attempts = 0;
    page.on("request", (request) => {
      if (request.method() === "PATCH") attempts++;
    });
    await source.fill("# Reduced local conflict draft");
    await source.press("ControlOrMeta+s");
    await page.waitForTimeout(900);
    expect(attempts).toBe(0);
    await page.getByRole("button", { name: "Overwrite…", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Confirm overwrite" });
    await expect(confirm).toBeVisible();
    expect(attempts).toBe(0);
    await confirm.getByRole("button", { name: "Overwrite File", exact: true }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    expect(attempts).toBe(1);
    await page.reload();
    await expect(source).toHaveValue("# Reduced local conflict draft");
  } finally {
    await other.close();
  }
});

test("serializes in-flight edits and keeps parent operations current after a save", async ({ page, workspace }) => {
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  let release: (() => void) | undefined;
  await page.route(`**/api/private/tree/files/${workspace.fileId}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    if (!release)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.continue();
  });
  await source.fill("# First captured draft");
  await source.press("Control+s");
  await expect(page.getByText("Saving", { exact: true })).toBeVisible();
  await expect.poll(() => Boolean(release)).toBe(true);
  await source.fill("# Newer in-flight draft");
  await source.press("Meta+s");
  release!();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(source).toHaveValue("# Newer in-flight draft");
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a name" });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("After save");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "After save", exact: true })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Files", exact: true })
    .getByRole("link", { name: "Draft.md", exact: true })
    .click();
  await expect(source).toHaveValue("# Newer in-flight draft");
});

test("coordinates one editing lease per File and requires save or explicit discard before transfer", async ({
  page,
  context,
  workspace,
}) => {
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  const other = await context.newPage();
  try {
    await other.goto(`/f/${workspace.fileId}`);
    const otherSource = other.getByRole("textbox", { name: "Markdown source", exact: true });
    await expect(otherSource).toHaveAttribute("readonly", "");
    await source.fill("# Transferred safely");
    await other.getByRole("button", { name: "Edit here", exact: true }).click();
    await expect(source).toHaveAttribute("readonly", "");
    await expect(otherSource).not.toHaveAttribute("readonly", "");
    await expect(otherSource).toHaveValue("# Transferred safely");
    await other.route(`**/api/private/tree/files/${workspace.fileId}`, (route) =>
      route.request().method() === "PATCH" ? route.abort("failed") : route.continue(),
    );
    await otherSource.fill("# Must not lose this draft");
    await otherSource.press("ControlOrMeta+s");
    await expect(other.getByText("Couldn't save", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Edit here", exact: true }).click();
    const transfer = other.getByRole("dialog", { name: "Transfer editing" });
    await expect(transfer).toBeVisible();
    await expect(source).toHaveAttribute("readonly", "");
    await expect(otherSource).toHaveValue("# Must not lose this draft");
    await transfer.getByRole("button", { name: "Discard draft and transfer", exact: true }).click();
    await expect(source).not.toHaveAttribute("readonly", "");
    await expect(source).toHaveValue("# Transferred safely");
    await expect(otherSource).toHaveAttribute("readonly", "");
  } finally {
    await other.close();
  }
});

test("narrow Edit/Preview views and the tree drawer preserve the same in-memory draft", async ({ page, workspace }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  await expect(source).toBeVisible();
  await expect(page.getByRole("region", { name: "Preview", exact: true })).toBeHidden();
  await source.fill("# Narrow draft");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(source).toBeHidden();
  await expect(
    page.getByRole("region", { name: "Preview", exact: true }).getByRole("heading", { name: "Narrow draft" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(source).toHaveValue("# Narrow draft");
  await expect(page.getByRole("complementary", { name: "Files tree" })).toBeHidden();
  await page.getByRole("button", { name: "Tree", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Files tree" })).toBeVisible();
  await page.getByRole("button", { name: "Close tree", exact: true }).click();
  await expect(source).toHaveValue("# Narrow draft");
});

test.describe("legacy Files", () => {
  test.use({ initialSource: "a".repeat(262_146), legacySource: true });
  test("keeps oversized legacy source readable/exportable and unsavable until reduced within the bound", async ({
    page,
    workspace,
  }) => {
    const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
    await expect(source).toHaveValue("a".repeat(262_146));
    await expect(page.getByText("Couldn't save", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reduce content", exact: true })).toBeVisible();
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download local draft", exact: true }).click();
    const stream = await (await downloadEvent).createReadStream();
    const parts: Buffer[] = [];
    for await (const part of stream!) parts.push(Buffer.from(part));
    expect(Buffer.concat(parts).toString("utf8")).toBe("a".repeat(262_146));
    expect(
      await page.evaluate(() => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      }),
    ).toBe(true);
    let attempts = 0;
    page.on("request", (request) => {
      if (request.method() === "PATCH") attempts++;
    });
    await source.press("ControlOrMeta+s");
    expect(attempts).toBe(0);
    await source.fill("a".repeat(262_145));
    await expect(source).toHaveValue("a".repeat(262_145));
    await expect(page.getByText("Couldn't save", { exact: true })).toBeVisible();
    await source.press("ControlOrMeta+s");
    expect(attempts).toBe(0);
    await source.fill("é".repeat(131_072));
    await source.press("ControlOrMeta+s");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    expect(attempts).toBe(1);
    await page.reload();
    await expect(source).toHaveValue("é".repeat(131_072));
  });
});
