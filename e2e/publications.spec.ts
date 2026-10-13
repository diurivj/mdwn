import type { Page, Request } from "@playwright/test";
import type { TestHarness } from "wrangler";
import { changeCommentAudience, publishedSummary, publishToggle } from "./publish-panel";
import { objectId, test, expect, type Workspace } from "./workspace-fixture";

test.use({
  initialSource: "---\ntitle: Diet plan\ndate: 2026-01-02\nprivate: never public\n---\n# Week one\n\nEat **well**.",
});

/** What a request put on the wire: URL without its fragment (Playwright reports a
 * navigation's fragment, which browsers never transmit), its headers (including
 * any Referer) and body. Provisional headers avoid waiting on cancelled requests. */
function sent(request: Request): string {
  const url = new URL(request.url());
  url.hash = "";
  return [url.href, JSON.stringify(request.headers()), request.postData() ?? ""].join("\n");
}

test("the Owner publishes a File that an anonymous reader decrypts locally, live, without the key reaching the service", async ({
  browser,
  page,
  workspace,
}) => {
  const ownerRequests: Request[] = [];
  page.on("request", (request) => ownerRequests.push(request));
  await publishToggle(page).click();
  const panel = page.getByRole("region", { name: "Publish", exact: true });
  await panel.getByLabel("Show my Public pseudonym as an author").check();
  await panel.getByRole("button", { name: "Publish File" }).click();
  await expect(panel.getByRole("heading", { name: "Published", exact: true })).toBeVisible();
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
    const readerRequests: Request[] = [],
      consoleMessages: string[] = [];
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
    await expect(reader.getByRole("alert")).toHaveText(
      "This public link is incomplete. Ask for the complete link, including the part after #.",
    );
    // Hash-only navigation does not run RR loaders automatically. Adding,
    // removing and restoring a capability must still replace the reader state.
    await reader.evaluate((hash) => {
      window.location.hash = hash;
    }, fragment);
    await expect(article.getByRole("heading", { name: "Diet plan v2", level: 1 })).toBeVisible();
    await reader.evaluate(() => {
      window.location.hash = "";
    });
    await expect(reader.getByRole("alert")).toHaveText(
      "This public link is incomplete. Ask for the complete link, including the part after #.",
    );
    await expect(article).toHaveCount(0);
    await reader.goBack();
    await expect(article.getByText("Updated for everyone")).toBeVisible();
    const unknown = await reader.goto(`${url.origin}/p/${"A".repeat(43)}#${fragment}`);
    expect(unknown?.status()).toBe(404);
    await expect(reader.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();

    expect(
      readerRequests.some((request) => new URL(request.url()).pathname.startsWith("/api/public/publications/")),
    ).toBe(true);
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
  const tables = (
    await workspace.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      )
      .all<{ name: string }>()
  ).results.map((row) => row.name);
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
  test(
    collapse
      ? "keeps the complete link when Publish is collapsed after the Worker commits"
      : "keeps the complete link when the publication response is lost after commit",
    async ({ browser, page, workspace }) => {
      let release!: () => void;
      let committed!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const saved = new Promise<void>((resolve) => {
        committed = resolve;
      });
      await page.route(`**/api/private/publications/files/${workspace.fileId}`, async (route) => {
        if (route.request().method() !== "PUT") {
          await route.continue();
          return;
        }
        // Real Worker/D1 commit, then a delayed or lost browser response.
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        committed();
        await held;
        await route.abort("failed");
      });
      const toggle = publishToggle(page);
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
      await expect(panel.getByRole("heading", { name: "Published", exact: true })).toBeVisible();
      await expect(panel.getByLabel("Public link")).toBeVisible();
      const link = await panel.getByLabel("Public link").inputValue();
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      try {
        const reader = await context.newPage();
        await reader.goto(link);
        await expect(
          reader
            .getByRole("article", { name: "Published File" })
            .getByRole("heading", { name: "Diet plan", exact: true }),
        ).toBeVisible();
      } finally {
        await context.close();
      }
    },
  );
}

test("reconciles every prepared capability when an earlier request wins a reopened panel's retry", async ({
  browser,
  page,
  workspace,
}) => {
  let firstCaptured!: () => void, releaseFirst!: () => void, firstCommitted!: () => void;
  const captured = new Promise<void>((resolve) => {
    firstCaptured = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const committed = new Promise<void>((resolve) => {
    firstCommitted = resolve;
  });
  let attempts = 0,
    firstLinkId = "";
  await page.route(`**/api/private/publications/files/${workspace.fileId}`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
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
  const toggle = publishToggle(page);
  await toggle.click();
  const panel = page.getByRole("region", { name: "Publish", exact: true });
  await panel.getByRole("button", { name: "Publish File" }).click();
  await captured;
  await toggle.click();
  await expect(panel).toHaveCount(0);
  await toggle.click();
  await panel.getByRole("button", { name: "Publish File" }).click();
  await expect(panel.getByRole("heading", { name: "Published", exact: true })).toBeVisible();
  await expect(panel.getByLabel("Public link")).toBeVisible();
  const link = await panel.getByLabel("Public link").inputValue();
  expect(new URL(link).pathname).toBe(`/p/${firstLinkId}`);
  expect(attempts).toBe(2);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const reader = await context.newPage();
    await reader.goto(link);
    await expect(
      reader.getByRole("article", { name: "Published File" }).getByRole("heading", { name: "Diet plan", exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("saves a within-limit source whose decoded YAML title exceeds the source limit", async ({
  browser,
  page,
  workspace,
}) => {
  await expect(page).toHaveURL(new RegExp(`/f/${workspace.fileId}$`));
  await publishToggle(page).click();
  const panel = page.getByRole("region", { name: "Publish", exact: true });
  await panel.getByRole("button", { name: "Publish File" }).click();
  await expect(panel.getByRole("heading", { name: "Published", exact: true })).toBeVisible();
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
    expect(
      await article
        .locator("h1")
        .first()
        .evaluate((heading) => new TextEncoder().encode(heading.textContent ?? "").length),
    ).toBe(300_000);
  } finally {
    await context.close();
  }
});

for (const scenario of [
  {
    name: "a title-looking line inside a private YAML string",
    source: '---\nprivate: "note\ntitle: SECRET\nend"\n---\n# Public body',
    title: null,
  },
  {
    name: "a folded title with a quoted key and CR-only front matter",
    source: '---\r"title": >-\r  Public\r  title\rprivate: SECRET\r---\r# Public body',
    title: "Public title",
  },
]) {
  test.describe(scenario.name, () => {
    test.use({ initialSource: scenario.source });
    test("publishes only the parsed title and Markdown body", async ({ browser, page, workspace }) => {
      await expect(page).toHaveURL(new RegExp(`/f/${workspace.fileId}$`));
      await publishToggle(page).click();
      const panel = page.getByRole("region", { name: "Publish", exact: true });
      await panel.getByRole("button", { name: "Publish File" }).click();
      await expect(panel.getByRole("heading", { name: "Published", exact: true })).toBeVisible();
      const link = await panel.getByLabel("Public link").inputValue();
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      try {
        const reader = await context.newPage();
        await reader.goto(link);
        const article = reader.getByRole("article", { name: "Published File" });
        await expect(article.getByRole("heading", { name: "Public body" })).toBeVisible();
        if (scenario.title)
          await expect(article.getByRole("heading", { name: scenario.title, exact: true })).toBeVisible();
        else await expect(article.getByRole("heading")).toHaveCount(1);
        await expect(reader.getByText("SECRET", { exact: false })).toHaveCount(0);
      } finally {
        await context.close();
      }
    });
  });
}

test("rotates the Public link, retires the old path, and keeps the Comments", async ({ browser, page, workspace }) => {
  await expect(page).toHaveURL(new RegExp(`/f/${workspace.fileId}$`));
  await publishToggle(page).click();
  const panel = page.getByRole("region", { name: "Publish", exact: true });
  await panel.getByRole("button", { name: "Publish File" }).click();
  await expect(panel.getByRole("heading", { name: "Published", exact: true })).toBeVisible();
  const first = await panel.getByLabel("Public link").inputValue();

  // A Public Comment exists before rotation and must survive it.
  const ownerTab = await page.context().newPage();
  await ownerTab.goto(first);
  const ownerComments = ownerTab.getByRole("region", { name: "Public comments", exact: true });
  await ownerComments.getByLabel("Add a public comment").fill("Survives rotation");
  const posted = ownerTab.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/private/comments/links/") &&
      response.status() === 201,
  );
  await ownerComments.getByRole("button", { name: "Comment", exact: true }).click();
  await posted;
  await expect(ownerComments.getByLabel("Add a public comment")).toHaveValue("");
  await expect(ownerComments.locator("li").filter({ hasText: "Survives rotation" })).toBeVisible();
  await ownerTab.close();

  // Close and reopen the audience so a second, retained public epoch exists:
  // rotation must rewrap every public epoch, not only the current one.
  await changeCommentAudience(panel, "Collaborators only");
  await changeCommentAudience(panel, "Public");
  const secondTab = await page.context().newPage();
  await secondTab.goto(first);
  const secondComments = secondTab.getByRole("region", { name: "Public comments", exact: true });
  await secondComments.getByLabel("Add a public comment").fill("In the second epoch");
  const postedSecond = secondTab.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/private/comments/links/") &&
      response.status() === 201,
  );
  await secondComments.getByRole("button", { name: "Comment", exact: true }).click();
  await postedSecond;
  await expect(secondComments.getByLabel("Add a public comment")).toHaveValue("");
  await secondTab.close();

  // Unchanged settings on a new link: the settings form's link replacement.
  await panel.getByRole("button", { name: "Change settings", exact: true }).click();
  const form = panel.getByRole("form", { name: "Change settings", exact: true });
  await expect(form.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  await form.getByRole("button", { name: "Create new link", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect.poll(() => panel.getByLabel("Public link").inputValue()).not.toBe(first);
  const rotated = await panel.getByLabel("Public link").inputValue();
  expect(new URL(rotated).pathname).toMatch(/^\/p\/[A-Za-z0-9_-]{43}$/);
  expect(new URL(rotated).pathname).not.toBe(new URL(first).pathname);

  // The retired path is indistinguishable from unknown; the new path serves
  // the same document and both public epochs' Comments.
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const reader = await context.newPage();
    const retired = await reader.goto(first);
    expect(retired?.status()).toBe(404);
    await expect(reader.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
    await reader.goto(rotated);
    const article = reader.getByRole("article", { name: "Published File" });
    await expect(article.getByRole("heading", { name: "Diet plan", level: 1 })).toBeVisible();
    const comments = reader.getByRole("region", { name: "Public comments", exact: true });
    await expect(comments.getByText("Survives rotation")).toBeVisible();
    await expect(comments.getByText("In the second epoch")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("shows the File as published and its complete link on any later visit", async ({ page, workspace }) => {
  await expect(page).toHaveURL(new RegExp(`/f/${workspace.fileId}$`));
  const files = page.getByRole("navigation", { name: "Files", exact: true });
  await expect(files.getByRole("link", { name: "Draft.md", exact: true })).toBeVisible();
  await publishToggle(page).click();
  const panel = page.getByRole("region", { name: "Publish", exact: true });
  await expect(panel.getByRole("heading", { name: "Publish", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Publish File" }).click();
  await expect(panel.getByRole("heading", { name: "Published", exact: true })).toBeVisible();
  const link = await panel.getByLabel("Public link").inputValue();
  await expect(page.getByRole("button", { name: "Published", exact: true })).toBeVisible();
  await expect(files.getByRole("link", { name: "Draft.md, published", exact: true })).toBeVisible();
  const summary = publishedSummary(panel);
  await expect(summary.getByText("Public.", { exact: true })).toBeVisible();
  await expect(summary.getByText("None.", { exact: true })).toBeVisible();

  // A fresh page holds no prepared link: the Owner link copy shows it again.
  await page.reload();
  await expect(page.getByRole("button", { name: "Published", exact: true })).toBeVisible();
  await publishToggle(page).click();
  await expect(panel.getByLabel("Public link")).toHaveValue(link);
  await expect(panel.getByText("This link can’t be shown here")).toHaveCount(0);

  // The library marks it too.
  await page
    .getByRole("complementary", { name: "Files tree", exact: true })
    .getByRole("link", { name: "Library", exact: true })
    .click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(
    page.getByRole("list", { name: "Folder contents" }).getByRole("link", { name: "Draft.md, File, published" }),
  ).toBeVisible();
});

test("replaces a link this device can't show with a new one carrying changed settings", async ({
  browser,
  page,
  workspace,
}) => {
  await publishToggle(page).click();
  const panel = page.getByRole("region", { name: "Publish", exact: true });
  await panel.getByRole("button", { name: "Publish File" }).click();
  await expect(panel.getByRole("heading", { name: "Published", exact: true })).toBeVisible();
  const first = await panel.getByLabel("Public link").inputValue();
  // A link published before the Owner link copy existed has none, and a link
  // row never changes in place: this browser reads the state without it.
  const state = `**/api/private/publications/files/${workspace.fileId}`;
  await page.route(state, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as { publication: { ownerLink?: string | null } | null };
    if (body.publication) body.publication.ownerLink = null;
    await route.fulfill({ response, json: body });
  });

  await page.reload();
  await publishToggle(page).click();
  await expect(panel.getByText("This link can’t be shown here")).toBeVisible();
  await expect(panel.getByLabel("Public link")).toHaveCount(0);
  await panel.getByRole("button", { name: "Change settings", exact: true }).click();
  const form = panel.getByRole("form", { name: "Change settings", exact: true });
  await form.getByRole("radio", { name: "Collaborators only", exact: true }).check();
  await form.getByLabel("Show my Public pseudonym as an author").check();
  await form.getByRole("button", { name: "Save and create new link", exact: true }).click();
  await expect(form).toHaveCount(0);
  const next = await panel.getByLabel("Public link").inputValue();
  expect(new URL(next).pathname).not.toBe(new URL(first).pathname);
  const summary = publishedSummary(panel);
  await expect(summary.getByText("Collaborators only.", { exact: true })).toBeVisible();
  await expect(summary.getByText("Your Public pseudonym", { exact: true })).toBeVisible();

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const reader = await context.newPage();
    expect((await reader.goto(first))?.status()).toBe(404);
    await reader.goto(next);
    const article = reader.getByRole("article", { name: "Published File" });
    await expect(article.getByRole("heading", { name: "Diet plan", level: 1 })).toBeVisible();
    await expect(article.getByText("By Member Test")).toBeVisible();
    await expect(
      reader
        .getByRole("region", { name: "Public comments", exact: true })
        .getByText("Sign in to see or add comments if you have access to this file.", { exact: false }),
    ).toBeVisible();
  } finally {
    await context.close();
  }

  // The new link carries an Owner link copy, so later visits show it.
  await page.unroute(state);
  await page.reload();
  await publishToggle(page).click();
  await expect(panel.getByLabel("Public link")).toHaveValue(next);
});

test("unpublishes with a counted confirmation, shows bounded progress, and publishes fresh", async ({
  browser,
  page,
  workspace,
}) => {
  await publishToggle(page).click();
  const panel = page.getByRole("region", { name: "Publish", exact: true });
  await panel.getByRole("button", { name: "Publish File" }).click();
  await expect(panel.getByRole("heading", { name: "Published", exact: true })).toBeVisible();
  const link = await panel.getByLabel("Public link").inputValue();
  const thread = await workspace.db
    .prepare(
      "SELECT id AS threadId, current_epoch_id AS epochId FROM comment_threads WHERE file_id = ? AND purpose = 'public'",
    )
    .bind(workspace.fileId)
    .first<{ threadId: string; epochId: string }>();
  expect(thread).not.toBeNull();
  // 250 opaque Comment rows cross the bounded batch boundary twice.
  for (let sequence = 1; sequence <= 250; sequence++) {
    await workspace.db
      .prepare(`INSERT INTO comments (id, thread_id, epoch_id, author_id, sequence, revision,
        body_ciphertext, body_size, content_key_envelope, content_key_epoch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, X'01', 1, X'01', 1, 1, 1)`)
      .bind(objectId(), thread!.threadId, thread!.epochId, workspace.accountId, sequence)
      .run();
  }
  // Reopen the panel so its state carries the current opaque count.
  const toggle = publishToggle(page);
  await toggle.click();
  await expect(panel).toHaveCount(0);
  await toggle.click();
  await expect(panel.getByRole("button", { name: "Unpublish…" })).toBeVisible();
  // Hold the second batch so the bounded progress state is observable.
  let teardownCalls = 0,
    release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/private/publications/files/${workspace.fileId}/teardown`, async (route) => {
    teardownCalls++;
    if (teardownCalls === 2) await held;
    await route.continue();
  });

  await panel.getByRole("button", { name: "Unpublish…" }).click();
  await expect(panel.getByText(/permanently deletes this Public link/)).toBeVisible();
  await panel.getByRole("button", { name: "Unpublish and permanently delete 250 Public Comments" }).click();
  await expect(panel.getByText("Deleting public material…")).toBeVisible();
  await expect(panel.getByText("200 of 250 Public Comments deleted.", { exact: true })).toBeVisible();
  release();
  await expect(panel.getByRole("button", { name: "Publish File" })).toBeVisible();
  expect(
    await workspace.db
      .prepare("SELECT count(*) AS n FROM publications WHERE file_id = ?")
      .bind(workspace.fileId)
      .first<{ n: number }>(),
  ).toEqual({ n: 0 });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const reader = await context.newPage();
    const removed = await reader.goto(link);
    expect(removed?.status()).toBe(404);
    await expect(reader.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }

  // A later Publication starts entirely fresh.
  await panel.getByRole("button", { name: "Publish File" }).click();
  await expect(panel.getByRole("heading", { name: "Published", exact: true })).toBeVisible();
  const fresh = await panel.getByLabel("Public link").inputValue();
  expect(fresh).not.toBe(link);
  const readerContext = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const reader = await readerContext.newPage();
    await reader.goto(fresh);
    const comments = reader.getByRole("region", { name: "Public comments", exact: true });
    await expect(comments.getByText("No comments yet.")).toBeVisible();
  } finally {
    await readerContext.close();
  }
});

/** Publishes the workspace File from the panel, adds `total` opaque Public
 * Comment rows, and reopens the panel so it carries the current count. */
async function publishWithComments(page: Page, workspace: Workspace, total: number) {
  await publishToggle(page).click();
  const panel = page.getByRole("region", { name: "Publish", exact: true });
  await panel.getByRole("button", { name: "Publish File" }).click();
  await expect(panel.getByRole("heading", { name: "Published", exact: true })).toBeVisible();
  const link = await panel.getByLabel("Public link").inputValue();
  const thread = await workspace.db
    .prepare(
      "SELECT id AS threadId, current_epoch_id AS epochId FROM comment_threads WHERE file_id = ? AND purpose = 'public'",
    )
    .bind(workspace.fileId)
    .first<{ threadId: string; epochId: string }>();
  expect(thread).not.toBeNull();
  for (let sequence = 1; sequence <= total; sequence++) {
    await workspace.db
      .prepare(`INSERT INTO comments (id, thread_id, epoch_id, author_id, sequence, revision,
        body_ciphertext, body_size, content_key_envelope, content_key_epoch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, X'01', 1, X'01', 1, 1, 1)`)
      .bind(objectId(), thread!.threadId, thread!.epochId, workspace.accountId, sequence)
      .run();
  }
  const toggle = publishToggle(page);
  await toggle.click();
  await expect(panel).toHaveCount(0);
  await toggle.click();
  await expect(panel.getByRole("button", { name: "Unpublish…" })).toBeVisible();
  return { panel, toggle, link, threadId: thread!.threadId };
}

/** Runs the Worker's scheduled maintenance until the File has no sealed Publication. */
async function runScheduledUntilDeleted(server: TestHarness, workspace: Workspace) {
  const sealed = async () =>
    (
      await workspace.db
        .prepare("SELECT count(*) AS n FROM publications WHERE file_id = ? AND state = 'deleting'")
        .bind(workspace.fileId)
        .first<{ n: number }>()
    )?.n ?? 0;
  expect(await sealed()).toBe(1);
  const worker = server.getWorker();
  for (let run = 0; run < 10 && (await sealed()) > 0; run++) {
    const result = await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: new Date() });
    expect(result.outcome).toBe("ok");
  }
  expect(await sealed()).toBe(0);
}

test("finishes Unpublishing through scheduled maintenance after the page stops deleting", async ({
  page,
  server,
  workspace,
}) => {
  const { panel, toggle, threadId } = await publishWithComments(page, workspace, 250);
  // The page never manages to drive a teardown batch.
  const teardownPath = `**/api/private/publications/files/${workspace.fileId}/teardown`;
  await page.route(teardownPath, (route) => route.abort());

  await panel.getByRole("button", { name: "Unpublish…" }).click();
  await panel.getByRole("button", { name: "Unpublish and permanently delete 250 Public Comments" }).click();
  await expect(panel.getByText("Deleting public material…")).toBeVisible();
  await expect(
    panel.getByText("Public access has ended. Deletion continues automatically, even after you close this page."),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "Continue deleting" })).toBeVisible();
  await expect(panel.getByText("Public material deleted.", { exact: false })).toHaveCount(0);

  // Scheduled maintenance, not the browser, finishes the sealed teardown.
  await runScheduledUntilDeleted(server, workspace);
  expect(
    await workspace.db
      .prepare("SELECT count(*) AS n FROM comments WHERE thread_id = ?")
      .bind(threadId)
      .first<{ n: number }>(),
  ).toEqual({ n: 0 });

  // This page saw the seal, so it can confirm the completed deletion.
  await page.unroute(teardownPath);
  await toggle.click();
  await expect(panel).toHaveCount(0);
  await toggle.click();
  await expect(
    panel.getByText("Public material deleted. The old Public link and its Public Comments are gone."),
  ).toBeVisible();
  await expect(panel.getByText("Deleting public material…")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Publish File" })).toBeVisible();
});

test("an Owner who leaves after Unpublishing returns to an unpublished File once maintenance finishes", async ({
  browser,
  page,
  server,
  workspace,
}) => {
  const { panel, link } = await publishWithComments(page, workspace, 250);
  await page.route(`**/api/private/publications/files/${workspace.fileId}/teardown`, (route) => route.abort());
  await panel.getByRole("button", { name: "Unpublish…" }).click();
  await panel.getByRole("button", { name: "Unpublish and permanently delete 250 Public Comments" }).click();
  await expect(panel.getByText("Deleting public material…")).toBeVisible();

  // Leave the File entirely; no page drives teardown from here on.
  await page.goto("/");
  await page.unrouteAll();
  await runScheduledUntilDeleted(server, workspace);

  await page.goto(`/f/${workspace.fileId}`);
  await expect(page.getByRole("heading", { name: "Draft.md", exact: true })).toBeVisible();
  await publishToggle(page).click();
  await expect(panel.getByRole("button", { name: "Publish File" })).toBeVisible();
  await expect(panel.getByText("Deleting public material…")).toHaveCount(0);
  // Hard deletion keeps no record, so a returning page has nothing to confirm.
  await expect(panel.getByText("Public material deleted.", { exact: false })).toHaveCount(0);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const reader = await context.newPage();
    const removed = await reader.goto(link);
    expect(removed?.status()).toBe(404);
    await expect(reader.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});
