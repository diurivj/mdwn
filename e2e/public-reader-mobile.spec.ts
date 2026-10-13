/**
 * Ticket 67: a published File reads well on a phone, and the shared Markdown
 * renderer keeps the Public-link fragment (the read capability) in place.
 * Real Worker, real publish, every engine.
 */

import type { Browser, Locator, Page } from "@playwright/test";
import { publishToggle } from "./publish-panel";
import { test, expect, type Workspace } from "./workspace-fixture";

const SOURCE = [
  "---",
  "title: Kitchen notes",
  "---",
  "Prices are below[^señal].",
  "",
  "- [ ] An open task that is long enough to wrap onto a second line on a narrow phone screen",
  "",
  "| Provider | Encryption | Monthly price | Notes |",
  "| --- | --- | ---: | --- |",
  "| Cloudflare | AES-256-GCM | $5.00 | Includes Workers Paid and D1 storage |",
  "| Somebody | ChaCha20-Poly1305 | $12.00 | Internationalization concerns |",
  "",
  "| A | B |",
  "| - | - |",
  "| short | table |",
  "",
  "```",
  "export function longFunctionName(parameterOne: string, parameterTwo: number): Promise<void> {}",
  "```",
  "",
  "```",
  "short()",
  "```",
  "",
  "![A bowl of soup](https://images.example/soup.png)",
  "",
  "[![Status badge](https://images.example/badge.svg)](https://example.com/status)",
  "",
  "[An outside page](https://example.com/page)",
  "",
  "[^señal]: Monthly, before tax.",
].join("\n");

test.use({ initialSource: SOURCE });

async function publish(page: Page, workspace: Workspace) {
  await expect(page).toHaveURL(new RegExp(`/f/${workspace.fileId}$`));
  await publishToggle(page).click();
  const panel = page.getByRole("region", { name: "Publish", exact: true });
  await panel.getByRole("button", { name: "Publish File" }).click();
  await expect(panel.getByText("Published.", { exact: false })).toBeVisible();
  return panel.getByLabel("Public link").inputValue();
}

async function openReader(browser: Browser, link: string, width: number) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 760 } });
  const reader = await context.newPage();
  const requested: string[] = [];
  reader.on("request", (request) => requested.push(request.url()));
  await reader.goto(link);
  const article = reader.getByRole("article", { name: "Published File" });
  await expect(article.getByRole("heading", { name: "Kitchen notes", level: 1 })).toBeVisible();
  return { context, reader, article, requested };
}

/** Line boxes of an element's own text (not its controls); one box per rendered line. */
function lineBoxes(locator: Locator) {
  return locator.evaluate((node) => {
    const boxes: { left: number; top: number }[] = [];
    const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const range = node.ownerDocument.createRange();
      range.selectNodeContents(walker.currentNode);
      for (const rect of range.getClientRects())
        if (rect.width > 0) boxes.push({ left: Math.round(rect.left), top: Math.round(rect.top) });
    }
    return boxes;
  });
}

test("a published File fits a phone: tables and code scroll in place, by keyboard too", async ({
  browser,
  page,
  workspace,
}) => {
  const link = await publish(page, workspace);
  // 320 CSS px is the WCAG 1.4.10 reflow width; only the table and code may scroll sideways.
  const { context, reader, article, requested } = await openReader(browser, link, 320);
  try {
    expect(await reader.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // The wide table scrolls inside its own named region instead of squeezing its columns.
    const wide = article.getByRole("region", { name: "Scrollable table", exact: true });
    await expect(wide).toHaveCount(1);
    await expect(wide).toHaveAttribute("data-overflow", "right");
    expect(await wide.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    for (const word of ["Provider", "Encryption", "Cloudflare", "Somebody"]) {
      expect(await lineBoxes(wide.getByText(word, { exact: true })), word).toHaveLength(1);
    }
    // Tab reaches it from the preceding footnote reference (WebKit skips links, not the region).
    await article.locator("[data-footnote-ref]").focus();
    await reader.keyboard.press("Tab");
    await expect(wide).toBeFocused();
    await expect(wide).toHaveAttribute("tabindex", "0");
    // Playwright's WebKit ignores the first arrow press on any focused scroller, so keep pressing.
    await expect
      .poll(async () => {
        await reader.keyboard.press("ArrowRight");
        return wide.evaluate((node) => node.scrollLeft);
      })
      .toBeGreaterThan(0);
    await expect(wide).toHaveAttribute("data-overflow", /^(left|both)$/);

    // Code scrolls the same way; a table or code block that fits adds no region and no tab stop.
    await expect(article.getByRole("region", { name: "Scrollable code", exact: true })).toHaveAttribute(
      "tabindex",
      "0",
    );
    const narrow = article.getByRole("table").filter({ hasText: "short" });
    await expect(narrow).toBeVisible();
    await expect(narrow.locator("xpath=..")).not.toHaveAttribute("tabindex");
    await expect(narrow.locator("xpath=..")).not.toHaveAttribute("role");
    const shortCode = article.locator("pre").filter({ hasText: "short()" });
    await expect(shortCode).toBeVisible();
    await expect(shortCode).not.toHaveAttribute("tabindex");

    // A wrapped task keeps its indent instead of running under the checkbox.
    const task = article.getByRole("listitem").filter({ hasText: "An open task" });
    const lines = await lineBoxes(task);
    expect(lines.length).toBeGreaterThan(1);
    expect(new Set(lines.map((line) => line.left)).size).toBe(1);
    const checkbox = (await task.getByRole("checkbox").boundingBox())!;
    expect(checkbox.x + checkbox.width).toBeLessThanOrEqual(lines[0]!.left);

    // An image can never load under the CSP; its description and address stay readable as text.
    await expect(article.locator("img")).toHaveCount(0);
    await expect(article.getByText("Image not shown", { exact: true })).toHaveCount(2);
    await expect(article.getByText("A bowl of soup", { exact: true })).toBeVisible();
    const openImage = article.getByRole("link", { name: "Open image", exact: true });
    await expect(openImage).toHaveCount(1);
    await expect(openImage).toHaveAttribute("href", "https://images.example/soup.png");
    await expect(openImage).toHaveAttribute("target", "_blank");
    // An image that is itself a link keeps only that link; links never nest.
    await expect(article.getByRole("link").filter({ hasText: "Status badge" })).toHaveAttribute(
      "href",
      "https://example.com/status",
    );
    await expect(article.locator("a a")).toHaveCount(0);
    expect(requested.filter((url) => new URL(url).hostname === "images.example")).toEqual([]);
  } finally {
    await context.close();
  }
});

test("in-page links move focus without replacing the read capability", async ({ browser, page, workspace }) => {
  const link = await publish(page, workspace);
  const fragment = new URL(link).hash;
  const { context, reader, article } = await openReader(browser, link, 390);
  const popups: Page[] = [];
  context.on("page", (opened) => popups.push(opened));
  try {
    await article.locator("[data-footnote-ref]").click();
    const note = article.locator("[data-footnotes] li").filter({ hasText: "Monthly, before tax." });
    await expect(note).toBeFocused();
    await expect(note).toBeInViewport();
    const back = article.getByRole("link", { name: "Back to reference 1", exact: true });
    await back.press("Enter");
    await expect(article.locator("[data-footnote-ref]")).toBeFocused();
    expect(await reader.evaluate(() => window.location.hash)).toBe(fragment);
    await expect(article.getByText("Prices are below")).toBeVisible();
    // Outside links still open apart from the reader, without a referrer.
    const outside = article.getByRole("link", { name: "An outside page", exact: true });
    await expect(outside).toHaveAttribute("target", "_blank");
    await expect(outside).toHaveAttribute("rel", "noopener noreferrer");
    expect(popups).toHaveLength(0);
  } finally {
    await context.close();
  }

  // The editor Preview renders the same way and stays on the File.
  const preview = page.getByRole("region", { name: "Preview", exact: true });
  const fileUrl = page.url();
  page.context().on("page", (opened) => popups.push(opened));
  await preview.locator("[data-footnote-ref]").click();
  await expect(preview.locator("[data-footnotes] li")).toBeFocused();
  expect(page.url()).toBe(fileUrl);
  expect(popups).toHaveLength(0);
});

test("the Preview's scroll regions follow edits", async ({ page, workspace }) => {
  await expect(page).toHaveURL(new RegExp(`/f/${workspace.fileId}$`));
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  const preview = page.getByRole("region", { name: "Preview", exact: true });
  const region = preview.getByRole("region", { name: "Scrollable table", exact: true });
  const narrow = "| A | B |\n| - | - |\n| short | table |";
  const columns = Array.from({ length: 12 }, (_, index) => `Column${index + 1}`);
  const wide = [columns, columns.map(() => "-"), columns].map((row) => `| ${row.join(" | ")} |`).join("\n");

  await source.fill(narrow);
  await expect(preview.getByRole("table")).toBeVisible();
  await expect(region).toHaveCount(0);
  // The same table element grows past the pane, then fits again.
  await source.fill(wide);
  await expect(region).toHaveAttribute("tabindex", "0");
  await source.fill(narrow);
  await expect(preview.getByRole("cell", { name: "short", exact: true })).toBeVisible();
  await expect(region).toHaveCount(0);
});
