import { readFile } from "node:fs/promises";

import { test, expect } from "./workspace-fixture";
import { seededAccount, shareWithComments, loadFixture } from "./support/provisioning-fixtures";
import { waitForSharedProvisioning } from "./support/navigation";
import {
  ARCHIVE_COMMENTS_PATH,
  ARCHIVE_MANIFEST_PATH,
  parseArchiveManifest,
  parsePrivateCommentsSidecar,
} from "../app/shared/archive/format";
import { readZip } from "../app/shared/archive/zip";

const source = "---\ntitle: Exported\n---\n\n# Owned 🚀\n\nExact source stays exact.\n";
test.use({ initialSource: source });
test.setTimeout(180_000);

const decoder = new TextDecoder();

async function downloadEntries(download: { path(): Promise<string | null> }): Promise<Map<string, Uint8Array>> {
  const path = await download.path();
  if (!path) throw new Error("download path unavailable");
  const entries = await readZip(new Uint8Array(await readFile(path)));
  return new Map(entries.map((entry) => [entry.path, entry.data]));
}

test("the Owner exports every owned File with exact source and Private Comment history", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  const panel = page.getByRole("region", { name: "Private comments", exact: true });
  const list = panel.getByRole("list", { name: "Private comments" });
  for (const text of ["First **comment** <b>plain</b>", "Second comment"]) {
    await page.getByLabel("Add a private comment").fill(text);
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(list.getByText(text, { exact: true })).toBeVisible();
  }
  // Export must work while a Public-participation suspension is live.
  const now = Date.now();
  await workspace.db
    .prepare(`INSERT INTO public_participation_suspensions
    (account_id, strike_count, reason, started_at, expires_at, updated_at) VALUES (?, 1, 'report_pattern', ?, ?, ?)`)
    .bind(workspace.accountId, now, now + 86_400_000, now)
    .run();

  const exportRequests: { method: string; path: string; body: string | null }[] = [];
  let exporting = false;
  page.on("request", (request) => {
    if (!exporting) return;
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return;
    exportRequests.push({ method: request.method(), path: url.pathname, body: request.postData() });
  });
  exporting = true;
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export my Files" }).click();
  const entries = await downloadEntries(await pending);
  exporting = false;

  // The whole export used bodyless ciphertext-only reads; no plaintext and no
  // upload can reach the service, and no export endpoint exists to call.
  expect(exportRequests.length).toBeGreaterThan(0);
  expect(exportRequests.filter((request) => request.body !== null)).toEqual([]);
  expect(exportRequests.filter((request) => request.path.includes("export"))).toEqual([]);

  const manifest = parseArchiveManifest(decoder.decode(entries.get(ARCHIVE_MANIFEST_PATH)!));
  expect(manifest.format).toBe("mdwn-export");
  expect(manifest.version).toBe(1);
  expect(manifest.roots).toEqual([{ kind: "directory", path: "" }]);
  expect(decoder.decode(entries.get("Draft.md")!)).toBe(source);

  const sidecar = parsePrivateCommentsSidecar(decoder.decode(entries.get(ARCHIVE_COMMENTS_PATH)!));
  expect(sidecar.files).toHaveLength(1);
  expect(sidecar.files[0]!.path).toBe("Draft.md");
  expect(sidecar.files[0]!.comments.map((comment) => comment.text)).toEqual([
    "First **comment** <b>plain</b>",
    "Second comment",
  ]);
  expect(sidecar.files[0]!.comments.map((comment) => comment.sequence)).toEqual([1, 2]);
  for (const comment of sidecar.files[0]!.comments) {
    expect(comment.pseudonym).toBe("Member Test");
    expect(comment.createdAt).toBeGreaterThan(0);
    expect(comment.updatedAt).toBeGreaterThanOrEqual(comment.createdAt);
  }
  // Publication, Grant, capability, and credential material never appears.
  const joined = [...entries.values()].map((data) => decoder.decode(data)).join("\n");
  expect(joined).not.toContain("publication");
  expect(joined).not.toContain("grant");
  expect(joined).not.toContain("capability");

  await expect(page.getByRole("status").filter({ hasText: "Exported 1 File" })).toBeVisible();
  await expect(page.getByText("It cannot remove or recall copies already downloaded elsewhere.")).toBeVisible();
});

test("mirrors a nested Directory hierarchy with UTF-8 .md files and uninterpreted front matter", async ({
  page,
  workspace,
}) => {
  expect(workspace.fileId).toBeTruthy();
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a name" });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("notes");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "notes", exact: true })).toBeVisible();
  const folderDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export this folder" }).click();
  const folderDownloaded = await folderDownload;
  expect(folderDownloaded.suggestedFilename()).toMatch(/^mdwn-notes-\d{4}-\d{2}-\d{2}\.zip$/);
  const folderEntries = await downloadEntries(folderDownloaded);
  expect([...folderEntries.keys()].sort()).toEqual([".mdwn", ARCHIVE_MANIFEST_PATH, "notes"]);
  expect(parseArchiveManifest(decoder.decode(folderEntries.get(ARCHIVE_MANIFEST_PATH)!)).roots).toEqual([
    { kind: "directory", path: "notes" },
  ]);
  await page.getByRole("button", { name: "New File", exact: true }).click();
  const fileDialog = page.getByRole("dialog", { name: "Create a name" });
  await fileDialog.getByRole("textbox", { name: "Name", exact: true }).fill("child");
  await fileDialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "child", exact: true })).toBeVisible();
  const nested = "---\ntags:\n  - one\n---\n\nNested body.\n";
  await page.getByRole("textbox", { name: "Markdown source", exact: true }).fill(nested);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export my Files" }).click();
  const entries = await downloadEntries(await pending);
  expect([...entries.keys()].sort()).toEqual([".mdwn", ARCHIVE_MANIFEST_PATH, "Draft.md", "notes", "notes/child.md"]);
  expect(decoder.decode(entries.get("notes/child.md")!)).toBe(nested);
  expect(parseArchiveManifest(decoder.decode(entries.get(ARCHIVE_MANIFEST_PATH)!)).roots).toEqual([
    { kind: "directory", path: "" },
  ]);
});

test("a selected owned File exports at the archive root without its folder", async ({ page, workspace }) => {
  expect(workspace.fileId).toBeTruthy();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export this File", exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/^mdwn-Draft\.md-\d{4}-\d{2}-\d{2}\.zip$/);
  const entries = await downloadEntries(download);
  expect([...entries.keys()].sort()).toEqual([".mdwn", ARCHIVE_MANIFEST_PATH, "Draft.md"]);
  const manifest = parseArchiveManifest(decoder.decode(entries.get(ARCHIVE_MANIFEST_PATH)!));
  expect(manifest.roots).toEqual([{ kind: "file", path: "Draft.md" }]);
  expect(decoder.decode(entries.get("Draft.md")!)).toBe(source);
});

test("a Collaborator cannot export shared-only content and is never offered export for it", async ({
  browser,
  page,
  workspace,
  workspaceScript,
  baseURL,
  server,
}) => {
  const origin = new URL(baseURL!).origin;
  const recipient = await seededAccount(browser, server, origin, workspaceScript);
  try {
    await shareWithComments(page, recipient, workspace);
    await recipient.page.goto(`${origin}/f/${workspace.fileId}`);
    await expect(recipient.page.getByRole("heading", { name: "Shared File", exact: true })).toBeVisible();
    await expect(recipient.page.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveValue(source);
    await expect(recipient.page.getByRole("button", { name: /^Export/ })).toHaveCount(0);
    await loadFixture(recipient.page);

    // The Collaborator's own export contains only their owned content.
    const rootId = await recipient.page.evaluate(async () => (await window.workspaceFixture.openRoot()).rootId);
    await waitForSharedProvisioning(recipient.page);
    await recipient.page.goto(`${origin}/d/${rootId}`);
    const pending = recipient.page.waitForEvent("download");
    await recipient.page.getByRole("button", { name: "Export my Files" }).click();
    const entries = await downloadEntries(await pending);
    expect([...entries.keys()].sort()).toEqual([".mdwn", ARCHIVE_MANIFEST_PATH]);
    const manifest = parseArchiveManifest(decoder.decode(entries.get(ARCHIVE_MANIFEST_PATH)!));
    expect(manifest.roots).toEqual([{ kind: "directory", path: "" }]);
    const joined = [...entries.values()].map((data) => decoder.decode(data)).join("\n");
    expect(joined).not.toContain("Draft.md");
    expect(joined).not.toContain("Only the target File.");
  } finally {
    await recipient.context.close();
  }
});
