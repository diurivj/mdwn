import type { Locator, Page } from "@playwright/test";

import { test, expect } from "./fixtures";
import { accountShareId, inviteFromCurrentPage, openEditor } from "./sharing-browser.fixture";

test.setTimeout(360_000);
test.use({ trace: "off", screenshot: "off", video: "off" });

type TestEnv = { DB: D1Database };

async function create(page: Page, kind: "New folder" | "New File", name: string): Promise<string> {
  await page.getByRole("button", { name: kind, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a name" });
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

async function accept(page: Page, origin: string, rootId: string, shareId: string, label: string) {
  await page.goto(`${origin}/d/${rootId}`);
  const acceptance = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/private/sharing/shares/${shareId}/accept`);
  await page.getByText(label, { exact: true }).locator("..").getByRole("button", { name: "Accept", exact: true }).click();
  const accepted = await acceptance;
  expect(accepted.status()).toBe(200);
  return accepted.json() as Promise<{ status: string }>;
}

/** Opens the wide-layout Comment inspector in place of the preview pane. */
async function openComments(page: Page): Promise<Locator> {
  await page.getByRole("group", { name: "Side pane" }).getByRole("button", { name: "Comments", exact: true }).click();
  const region = page.getByRole("region", { name: "Comments" });
  await expect(region).toBeVisible();
  await expect(page.getByRole("region", { name: "Preview" })).toBeHidden();
  await expect(region.getByRole("button", { name: "Private", exact: true })).toHaveAttribute("aria-pressed", "true");
  return region;
}

async function post(region: Locator, text: string) {
  await region.getByRole("textbox", { name: "Private comment" }).fill(text);
  await region.getByRole("button", { name: "Post", exact: true }).click();
  await expect(region.getByRole("textbox", { name: "Private comment" })).toHaveValue("", { timeout: 30_000 });
}

const item = (region: Locator, text: string) =>
  region.getByRole("list", { name: "Private comments" }).getByRole("listitem").filter({ hasText: text });

test("a read-only Directory Collaborator and the Owner share one Private thread under the author rules", async ({
  browser, server, baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const owner = await openEditor(browser, server, baseURL!, "OwnerSeed.md");
  const collaborator = await openEditor(browser, server, baseURL!, "CollaboratorPrivate.md");
  try {
    const env = await server.getWorker<TestEnv>().getEnv();
    await owner.page.goto(`${origin}/d/${owner.rootId}`);
    const folderId = await create(owner.page, "New folder", "Team");
    const fileId = await create(owner.page, "New File", "Plan.md");
    await owner.page.goto(`${origin}/d/${folderId}`);
    const shareId = await inviteFromCurrentPage(owner.page, await accountShareId(server, collaborator.accountId),
      "read_only");
    expect(await accept(collaborator.page, origin, collaborator.rootId, shareId,
      "Invitation to a folder (read-only)")).toMatchObject({ status: "ready" });

    // Read-only Markdown, normal Private composer.
    await collaborator.page.goto(`${origin}/f/${fileId}`);
    await expect(collaborator.page.getByRole("heading", { name: "Plan.md", exact: true })).toBeVisible();
    await expect(collaborator.page.getByText("Read-only — you can comment", { exact: true })).toBeVisible();
    await expect(collaborator.page.getByRole("textbox", { name: "Markdown source" })).toHaveAttribute("readonly", "");
    let comments = await openComments(collaborator.page);
    await expect(comments.getByText("No comments yet.", { exact: true })).toBeVisible();
    const first = "First line\n<b>**not markup**</b>";
    await comments.getByRole("textbox", { name: "Private comment" }).fill(first);
    await expect(comments.getByRole("status", { name: "Comment length" })).toHaveText(`${first.length} / 2000`);
    await comments.getByRole("button", { name: "Post", exact: true }).click();
    const mine = item(comments, "First line");
    await expect(mine).toBeVisible({ timeout: 30_000 });
    await expect(mine).toContainText("<b>**not markup**</b>");
    await expect(mine.locator("b")).toHaveCount(0);
    await expect(mine.getByText("(you)", { exact: false })).toBeVisible();
    await expect(mine.getByText("Unknown author", { exact: false })).toHaveCount(0);
    const collaboratorName = (await mine.getByRole("paragraph").first().innerText()).split(" (you)")[0]!.trim();
    await comments.getByRole("textbox", { name: "Private comment" }).fill("x".repeat(2001));
    await expect(comments.getByRole("button", { name: "Post", exact: true })).toBeDisabled();
    await comments.getByRole("textbox", { name: "Private comment" }).fill("");

    // Ciphertext only at the service boundary.
    const stored = await env.DB.prepare(`SELECT c.ciphertext, a.ciphertext AS attribution FROM comments c
      JOIN thread_attributions a ON a.thread_id = c.thread_id AND a.account_id = c.author_id
      WHERE c.author_id = ?`).bind(collaborator.accountId).first<{ ciphertext: ArrayBuffer; attribution: ArrayBuffer }>();
    expect(Buffer.from(new Uint8Array(stored!.ciphertext)).toString("latin1")).not.toContain("First line");
    expect(Buffer.from(new Uint8Array(stored!.attribution)).toString("latin1")).not.toContain(collaboratorName);

    // The Owner sees the pseudonym, may delete but never edit another author's Comment.
    await owner.page.goto(`${origin}/f/${fileId}`);
    comments = await openComments(owner.page);
    const theirs = item(comments, "First line");
    await expect(theirs).toBeVisible({ timeout: 30_000 });
    await expect(theirs.getByText(collaboratorName, { exact: false })).toBeVisible();
    await expect(theirs.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await expect(theirs.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
    await post(comments, "Owner reply");
    await expect(item(comments, "Owner reply")).toBeVisible();

    // The author edits their own Comment and has no controls on the Owner's.
    await collaborator.page.reload();
    comments = await openComments(collaborator.page);
    await expect(item(comments, "Owner reply")).toBeVisible({ timeout: 30_000 });
    await expect(item(comments, "Owner reply").getByRole("button")).toHaveCount(0);
    await item(comments, "First line").getByRole("button", { name: "Edit", exact: true }).click();
    await comments.getByRole("textbox", { name: "Edit comment" }).fill("Edited by the author");
    await comments.getByRole("button", { name: "Save comment", exact: true }).click();
    await expect(item(comments, "Edited by the author").getByText("edited", { exact: false })).toBeVisible({
      timeout: 30_000 });

    // Narrow layouts use the Comments content view.
    await collaborator.page.setViewportSize({ width: 390, height: 800 });
    await collaborator.page.getByRole("group", { name: "File view" })
      .getByRole("button", { name: "Edit", exact: true }).click();
    await expect(comments).toBeHidden();
    await collaborator.page.getByRole("group", { name: "File view" })
      .getByRole("button", { name: "Comments", exact: true }).click();
    await expect(collaborator.page.getByRole("textbox", { name: "Markdown source" })).toBeHidden();
    await expect(item(comments, "Edited by the author")).toBeVisible();
    await expect(comments.getByRole("textbox", { name: "Private comment" })).toBeVisible();

    // Owner hard-deletes the Collaborator's Comment; there is no restore.
    await owner.page.reload();
    comments = await openComments(owner.page);
    const edited = item(comments, "Edited by the author");
    await edited.getByRole("button", { name: "Delete", exact: true }).click();
    await edited.getByRole("button", { name: "Delete permanently", exact: true }).click();
    await expect(edited).toHaveCount(0, { timeout: 30_000 });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM comments WHERE author_id = ?")
      .bind(collaborator.accountId).first<{ n: number }>()).toEqual({ n: 0 });
    await collaborator.page.reload();
    await collaborator.page.getByRole("group", { name: "File view" })
      .getByRole("button", { name: "Comments", exact: true }).click();
    comments = collaborator.page.getByRole("region", { name: "Comments" });
    await expect(item(comments, "Owner reply")).toBeVisible({ timeout: 30_000 });
    await expect(item(comments, "Edited by the author")).toHaveCount(0);
  } finally {
    await collaborator.context.close();
    await owner.context.close();
  }
});

test("a direct File reader waits for its device envelope, then reads and writes the thread", async ({
  browser, server, baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const owner = await openEditor(browser, server, baseURL!, "Direct.md");
  const reader = await openEditor(browser, server, baseURL!, "ReaderPrivate.md");
  try {
    // The thread exists before the Grant, so the reader's device has no envelope yet.
    let comments = await openComments(owner.page);
    await post(comments, "Before sharing");
    await expect(item(comments, "Before sharing")).toBeVisible();
    const shareId = await inviteFromCurrentPage(owner.page, await accountShareId(server, reader.accountId),
      "read_only");
    expect(await accept(reader.page, origin, reader.rootId, shareId, "Invitation to a File (read-only)"))
      .toMatchObject({ status: "ready" });
    await reader.page.goto(`${origin}/f/${owner.fileId}`);
    await expect(reader.page.getByRole("heading", { name: "Direct.md", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(reader.page.getByText("Read-only — you can comment", { exact: true })).toBeVisible();
    comments = await openComments(reader.page);
    await expect(comments.getByText(/Secure access to these comments is being prepared/)).toBeVisible();
    await expect(comments.getByText("Before sharing", { exact: true })).toHaveCount(0);

    // Any current reader provisions waiting direct devices when it opens the thread.
    await owner.page.reload();
    const provisioned = owner.page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/private/comments/files/${owner.fileId}/thread/devices`);
    await openComments(owner.page);
    expect((await provisioned).status()).toBe(200);

    await comments.getByRole("button", { name: "Check again", exact: true }).click();
    await expect(item(comments, "Before sharing")).toBeVisible({ timeout: 30_000 });
    await post(comments, "Direct reply");
    await expect(item(comments, "Direct reply")).toBeVisible();
    await owner.page.reload();
    comments = await openComments(owner.page);
    await expect(item(comments, "Direct reply")).toBeVisible({ timeout: 30_000 });
  } finally {
    await reader.context.close();
    await owner.context.close();
  }
});
