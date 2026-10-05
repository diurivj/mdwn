import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { test, expect } from "./workspace-fixture";
import { createArchiveManifest, serializeArchiveManifest, ARCHIVE_MANIFEST_PATH } from "../app/archive/format";
import { createZip } from "../app/archive/zip";

const encoder = new TextEncoder();
const markdown = { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Notes\n") };

function trackedWrites(page: Page) {
  const writes: { method: string; path: string; body: string | null }[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return;
    if (request.method() === "GET") return;
    writes.push({ method: request.method(), path: url.pathname, body: request.postData() });
  });
  return writes;
}

test.describe("Import preflight and review", () => {
  test("loose Markdown files open a review with deterministic Keep-both names and measure a plan", async ({ page, workspace }) => {
    expect(workspace.fileId).toBeTruthy();
    const writes = trackedWrites(page);
    await expect(page.getByTestId("import-control")).toBeVisible();
    await page.getByTestId("import-files-input").setInputFiles([
      { name: "Draft.md", mimeType: "text/markdown", buffer: Buffer.from("# Collides\n") },
      { name: "Draft (2).md", mimeType: "text/markdown", buffer: Buffer.from("# Explicit suffix\n") },
      markdown,
    ]);

    const dialog = page.getByRole("dialog", { name: "Import review" });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("import-summary-sources")).toHaveText("3");
    await expect(page.getByTestId("import-summary-create")).toHaveText("3 Files, 0 folders");
    await expect(page.getByTestId("import-summary-replace")).toHaveText("0");
    await expect(page.getByTestId("import-summary-skip")).toHaveText("0");
    await expect(page.getByTestId("import-target")).toContainText("Target: Files — owned by you.");
    // The explicit `Draft (2).md` keeps its name; the colliding `Draft.md` gets (3).
    await expect(page.getByTestId("import-generated-names")).toContainText("Draft (3).md");
    await expect(page.getByTestId("import-generated-names")).not.toContainText("Draft (2).md");
    await expect(page.getByTestId("import-no-upload")).toBeVisible();
    // Preflight and review are browser-local: no request left the page yet.
    expect(writes).toEqual([]);

    await page.getByTestId("import-confirm").click();
    await expect(page.getByTestId("import-complete")).toContainText("Added 3 items", { timeout: 30_000 });
    // Confirmation staged the encrypted chunks and committed them atomically.
    expect(writes.some((write) => write.method === "POST" && write.path === "/api/private/imports")).toBe(true);
    expect(writes.some((write) => write.method === "PUT" && /\/chunks\/\d+$/.test(write.path))).toBe(true);
    await page.getByTestId("import-done").click();
  });

  test("a valid drop opens the same review flow", async ({ page, workspace, browserName }) => {
    // WebKit's synthetic DataTransfer FileSystemEntry cannot produce a File, so
    // the constructed drag cannot exercise the real OS drop path there.
    test.skip(browserName === "webkit", "synthetic WebKit entries expose no File");
    expect(workspace.fileId).toBeTruthy();
    const section = page.locator("section").filter({ has: page.getByTestId("import-control") });
    await section.evaluate((element) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(["# Dropped\n"], "dropped.md", { type: "text/markdown" }));
      element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    });
    await expect(page.getByRole("dialog", { name: "Import review" })).toBeVisible();
    await expect(page.getByTestId("import-summary-sources")).toHaveText("1");
    await expect(page.getByTestId("import-summary-create")).toHaveText("1 File, 0 folders");
  });

  test("a chosen folder becomes a child Directory and preserves its hierarchy", async ({ page, workspace }) => {
    expect(workspace.fileId).toBeTruthy();
    const temporary = await mkdtemp(join(tmpdir(), "mdwn-import-"));
    const folder = join(temporary, "vault");
    try {
      await mkdir(join(folder, "notes"), { recursive: true });
      await writeFile(join(folder, "notes", "draft.md"), "# Draft\n");
      await writeFile(join(folder, "README.md"), "# Readme\n");
      await page.getByTestId("import-folder-input").setInputFiles(folder);
      await expect(page.getByRole("dialog", { name: "Import review" })).toBeVisible();
      await expect(page.getByTestId("import-summary-sources")).toHaveText("4");
      await expect(page.getByTestId("import-summary-create")).toHaveText("2 Files, 2 folders");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("a recognized mdwn archive reveals its folder hierarchy in the review", async ({ page, workspace }) => {
    expect(workspace.fileId).toBeTruthy();
    const archive = await createZip([
      { path: ARCHIVE_MANIFEST_PATH, data: encoder.encode(serializeArchiveManifest(
        createArchiveManifest([{ kind: "directory", path: "" }], "2026-10-05T12:00:00.000Z"))) },
      { path: "notes", directory: true },
      { path: "notes/draft.md", data: encoder.encode("# Draft\n") },
      { path: "README.md", data: encoder.encode("# Readme\n") },
    ], { at: new Date("2026-10-05T12:00:00.000Z") });
    await page.getByTestId("import-files-input").setInputFiles({ name: "vault.zip", mimeType: "application/zip", buffer: Buffer.from(archive) });
    const dialog = page.getByRole("dialog", { name: "Import review" });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("import-summary-sources")).toHaveText("3");
    await expect(page.getByTestId("import-summary-create")).toHaveText("2 Files, 1 folder");
    await page.getByTestId("import-confirm").click();
    await expect(page.getByTestId("import-complete")).toContainText("Added 3 items", { timeout: 30_000 });
  });

  test("unsupported input fails before review and uploads nothing", async ({ page, workspace }) => {
    expect(workspace.fileId).toBeTruthy();
    const writes = trackedWrites(page);
    await page.getByTestId("import-files-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("plain") });
    await expect(page.getByTestId("import-error")).toContainText("notes.txt");
    await expect(page.getByTestId("import-error")).toContainText("is not supported");
    await expect(page.getByTestId("import-error")).toContainText(".md/.markdown");
    expect(writes).toEqual([]);
  });
});
