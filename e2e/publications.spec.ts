import type { Request } from "@playwright/test";
import { test, expect } from "./workspace-fixture";

test.use({ initialSource: "---\ntitle: Diet plan\ndate: 2026-01-02\nprivate: never public\n---\n# Week one\n\nEat **well**." });

/** What a request put on the wire: URL without its fragment (Playwright reports a
 * navigation's fragment, which browsers never transmit), its headers (including
 * any Referer) and body. Provisional headers avoid waiting on cancelled requests. */
function sent(request: Request): string {
  const url = new URL(request.url());
  url.hash = "";
  return [url.href, JSON.stringify(request.headers()), request.postData() ?? ""].join("\n");
}

test("the Owner publishes a File that an anonymous reader decrypts locally, live, without the key reaching the service", async ({
  browser, page, workspace,
}) => {
  const ownerRequests: Request[] = [];
  page.on("request", (request) => ownerRequests.push(request));
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const panel = page.getByRole("region", { name: "Publish", exact: true });
  await panel.getByLabel("Show my Public pseudonym as an author").check();
  await panel.getByRole("button", { name: "Publish File" }).click();
  await expect(panel.getByText("Published.", { exact: false })).toBeVisible();
  const link = await panel.getByLabel("Public link").inputValue();
  const url = new URL(link);
  const fragment = url.hash.slice(1);
  expect(url.pathname).toMatch(/^\/p\/[A-Za-z0-9_-]{43}$/);
  expect(fragment).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/);
  const scalar = fragment.slice(3);
  for (const request of ownerRequests) expect(sent(request)).not.toContain(scalar);

  const readerContext = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const reader = await readerContext.newPage();
    const readerRequests: Request[] = [], consoleMessages: string[] = [];
    reader.on("request", (request) => readerRequests.push(request));
    reader.on("console", (message) => consoleMessages.push(message.text()));
    const documentResponse = await reader.goto(link);
    expect(documentResponse?.status()).toBe(200);
    expect(documentResponse?.headers()["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
    expect(documentResponse?.headers()["set-cookie"]).toBeUndefined();
    const article = reader.getByRole("article", { name: "Published File" });
    await expect(article.getByRole("heading", { name: "Diet plan", level: 1 })).toBeVisible();
    await expect(article.getByRole("heading", { name: "Week one" })).toBeVisible();
    await expect(article.locator("strong")).toHaveText("well");
    await expect(article.getByText("By Member Test")).toBeVisible();
    // No raw front matter, path, breadcrumbs, timestamps or Owner identity.
    await expect(reader.getByText("never public")).toHaveCount(0);
    await expect(reader.getByText("2026-01-02")).toHaveCount(0);
    await expect(reader.getByText("Draft.md")).toHaveCount(0);
    await expect(reader.getByRole("navigation")).toHaveCount(0);
    expect(await reader.locator('meta[name="robots"]').getAttribute("content")).toBe("noindex, nofollow, noarchive");
    expect(await readerContext.cookies()).toEqual([]);
    const html = await (await reader.request.get(url.pathname)).text();
    expect(html).not.toContain("Week one");
    expect(html).not.toContain(workspace.accountId);

    // The live link follows ordinary saves through the paired Public representation.
    const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
    await source.fill("---\ntitle: Diet plan v2\n---\nUpdated for everyone");
    await source.press("ControlOrMeta+s");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await reader.reload();
    await expect(article.getByRole("heading", { name: "Diet plan v2", level: 1 })).toBeVisible();
    await expect(article.getByText("Updated for everyone")).toBeVisible();

    // An incomplete or unknown link reveals nothing and never echoes a key.
    await reader.goto(`${url.origin}${url.pathname}`);
    await expect(reader.getByRole("alert")).toHaveText("This public link is incomplete. Ask for the complete link, including the part after #.");
    // Hash-only navigation does not run RR loaders automatically. Adding,
    // removing and restoring a capability must still replace the reader state.
    await reader.evaluate((hash) => { window.location.hash = hash; }, fragment);
    await expect(article.getByRole("heading", { name: "Diet plan v2", level: 1 })).toBeVisible();
    await reader.evaluate(() => { window.location.hash = ""; });
    await expect(reader.getByRole("alert")).toHaveText("This public link is incomplete. Ask for the complete link, including the part after #.");
    await expect(article).toHaveCount(0);
    await reader.goBack();
    await expect(article.getByText("Updated for everyone")).toBeVisible();
    const unknown = await reader.goto(`${url.origin}/p/${"A".repeat(43)}#${fragment}`);
    expect(unknown?.status()).toBe(404);

    expect(readerRequests.some((request) => new URL(request.url()).pathname.startsWith("/api/public/publications/"))).toBe(true);
    for (const request of [...readerRequests, ...ownerRequests]) {
      const wire = sent(request);
      expect(wire).not.toContain(scalar);
      expect(wire).not.toContain(fragment);
    }
    for (const message of consoleMessages) expect(message).not.toContain(scalar);
  } finally {
    await readerContext.close();
  }

  // No table holds the read capability in any form.
  const tables = (await workspace.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
    .all<{ name: string }>()).results.map((row) => row.name);
  const scalarBytes = Uint8Array.from(Buffer.from(scalar, "base64url"));
  for (const table of tables) {
    for (const row of (await workspace.db.prepare(`SELECT * FROM "${table}"`).all<Record<string, unknown>>()).results) {
      for (const value of Object.values(row)) {
        if (typeof value === "string") expect(value).not.toContain(scalar);
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
          expect(Buffer.from(value as ArrayBuffer).includes(Buffer.from(scalarBytes)), table).toBe(false);
        }
      }
    }
  }
});

for (const collapse of [true, false]) {
  test(collapse ? "keeps the complete link when Publish is collapsed after the Worker commits" :
    "keeps the complete link when the publication response is lost after commit", async ({ browser, page, workspace }) => {
    let release!: () => void;
    let committed!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const saved = new Promise<void>((resolve) => { committed = resolve; });
    await page.route(`**/api/private/publications/files/${workspace.fileId}`, async (route) => {
      if (route.request().method() !== "PUT") { await route.continue(); return; }
      // Real Worker/D1 commit, then a delayed or lost browser response.
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      committed();
      await held;
      await route.abort("failed");
    });
    const toggle = page.getByRole("button", { name: "Publish", exact: true });
    await toggle.click();
    const panel = page.getByRole("region", { name: "Publish", exact: true });
    await panel.getByRole("button", { name: "Publish File" }).click();
    await saved;
    if (collapse) {
      await toggle.click();
      await expect(panel).toHaveCount(0);
    }
    release();
    if (collapse) await toggle.click();
    await expect(panel.getByText(/^Published\./)).toBeVisible();
    await expect(panel.getByLabel("Public link")).toBeVisible();
    const link = await panel.getByLabel("Public link").inputValue();
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const reader = await context.newPage();
      await reader.goto(link);
      await expect(reader.getByRole("article", { name: "Published File" })
        .getByRole("heading", { name: "Diet plan", exact: true })).toBeVisible();
    } finally { await context.close(); }
  });
}

test("reconciles every prepared capability when an earlier request wins a reopened panel's retry", async ({ browser, page, workspace }) => {
  let firstCaptured!: () => void, releaseFirst!: () => void, firstCommitted!: () => void;
  const captured = new Promise<void>((resolve) => { firstCaptured = resolve; });
  const released = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const committed = new Promise<void>((resolve) => { firstCommitted = resolve; });
  let attempts = 0, firstLinkId = "";
  await page.route(`**/api/private/publications/files/${workspace.fileId}`, async (route) => {
    if (route.request().method() !== "PUT") { await route.continue(); return; }
    attempts++;
    if (attempts === 1) {
      firstLinkId = (route.request().postDataJSON() as { linkId: string }).linkId;
      firstCaptured();
      await released;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      firstCommitted();
      await route.abort("failed");
    } else {
      releaseFirst();
      await committed;
      const response = await route.fetch();
      expect(response.status()).toBe(409);
      await route.fulfill({ response });
    }
  });
  const toggle = page.getByRole("button", { name: "Publish", exact: true });
  await toggle.click();
  const panel = page.getByRole("region", { name: "Publish", exact: true });
  await panel.getByRole("button", { name: "Publish File" }).click();
  await captured;
  await toggle.click();
  await expect(panel).toHaveCount(0);
  await toggle.click();
  await panel.getByRole("button", { name: "Publish File" }).click();
  await expect(panel.getByText(/^Published\./)).toBeVisible();
  await expect(panel.getByLabel("Public link")).toBeVisible();
  const link = await panel.getByLabel("Public link").inputValue();
  expect(new URL(link).pathname).toBe(`/p/${firstLinkId}`);
  expect(attempts).toBe(2);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const reader = await context.newPage();
    await reader.goto(link);
    await expect(reader.getByRole("article", { name: "Published File" })
      .getByRole("heading", { name: "Diet plan", exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test("saves a within-limit source whose decoded YAML title exceeds the source limit", async ({ browser, page, workspace }) => {
  await expect(page).toHaveURL(new RegExp(`/f/${workspace.fileId}$`));
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const panel = page.getByRole("region", { name: "Publish", exact: true });
  await panel.getByRole("button", { name: "Publish File" }).click();
  await expect(panel.getByText(/^Published\./)).toBeVisible();
  const link = await panel.getByLabel("Public link").inputValue();
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  await source.fill(`---\ntitle: "${"\\L".repeat(100_000)}"\n---\n# Expanded title`);
  await source.press("ControlOrMeta+s");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const reader = await context.newPage();
    await reader.goto(link);
    const article = reader.getByRole("article", { name: "Published File" });
    await expect(article.getByRole("heading", { name: "Expanded title", exact: true })).toBeVisible();
    expect(await article.locator("h1").first().evaluate((heading) => new TextEncoder().encode(heading.textContent ?? "").length))
      .toBe(300_000);
  } finally { await context.close(); }
});

for (const scenario of [
  { name: "a title-looking line inside a private YAML string", source: '---\nprivate: "note\ntitle: SECRET\nend"\n---\n# Public body', title: null },
  { name: "a folded title with a quoted key and CR-only front matter", source: '---\r"title": >-\r  Public\r  title\rprivate: SECRET\r---\r# Public body', title: "Public title" },
]) {
  test.describe(scenario.name, () => {
    test.use({ initialSource: scenario.source });
    test("publishes only the parsed title and Markdown body", async ({ browser, page, workspace }) => {
      await expect(page).toHaveURL(new RegExp(`/f/${workspace.fileId}$`));
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      const panel = page.getByRole("region", { name: "Publish", exact: true });
      await panel.getByRole("button", { name: "Publish File" }).click();
      await expect(panel.getByText("Published.", { exact: false })).toBeVisible();
      const link = await panel.getByLabel("Public link").inputValue();
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      try {
        const reader = await context.newPage();
        await reader.goto(link);
        const article = reader.getByRole("article", { name: "Published File" });
        await expect(article.getByRole("heading", { name: "Public body" })).toBeVisible();
        if (scenario.title) await expect(article.getByRole("heading", { name: scenario.title, exact: true })).toBeVisible();
        else await expect(article.getByRole("heading")).toHaveCount(1);
        await expect(reader.getByText("SECRET", { exact: false })).toHaveCount(0);
      } finally { await context.close(); }
    });
  });
}
