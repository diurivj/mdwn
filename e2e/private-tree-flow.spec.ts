import { test, expect } from "./fixtures";
import { completeRecoveryPresentation } from "./signup-recovery";
import { waitForSharedProvisioning } from "./support/navigation";

test.setTimeout(180_000);

test("creates and opens signed private Directories and Files without leaking names into SSR", async ({
  browser,
  server,
  baseURL,
}) => {
  const worker = server.getWorker<{ DB: D1Database }>();
  await worker.applyD1Migrations("DB");
  const db = (await worker.getEnv()).DB;
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addInitScript(() => {
    if (typeof globalThis.PublicKeyCredential !== "function") {
      Object.defineProperty(globalThis, "PublicKeyCredential", {
        configurable: true,
        value: class PublicKeyCredential {},
      });
    }
  });
  await context.credentials.install();
  const page = await context.newPage();
  try {
    await page.goto(new URL("/sign-up", baseURL!).href, { waitUntil: "commit" });
    const signupResponses: string[] = [];
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith("/api/signup/")) signupResponses.push(`${path}: ${response.status()}`);
    });
    const verify = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/signup/verify" && request.method() === "POST",
      { timeout: 120_000 },
    );
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await completeRecoveryPresentation(page);
    const signup = (await verify).postDataJSON() as { transcript: { rootDirectoryId: string } };
    await Promise.race([
      page.getByRole("heading", { name: "Library", exact: true }).waitFor({ timeout: 120_000 }),
      page
        .getByRole("alert")
        .waitFor({ timeout: 120_000 })
        .then(() => {
          throw new Error(`Signup failed before opening Files: ${signupResponses.join(", ")}`);
        }),
    ]);

    await expect(page).toHaveURL(/\/files$/);
    await waitForSharedProvisioning(page);
    // Preserve the root deep-link assertion without cancelling its previous document's lazy import.
    await page.goto(new URL(`/d/${signup.transcript.rootDirectoryId}`, baseURL!).href);
    await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New folder" }).click();
    const folderDialog = page.getByRole("dialog", { name: "Create a name" });
    await folderDialog.getByRole("textbox", { name: "Name" }).fill("Private folder");
    await folderDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Private folder" })).toBeVisible();
    const folderId = new URL(page.url()).pathname.split("/").at(-1)!;

    await page.getByRole("button", { name: "New File" }).click();
    const fileDialog = page.getByRole("dialog", { name: "Create a name" });
    await fileDialog.getByRole("textbox", { name: "Name" }).fill("Draft.md");
    await fileDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Draft.md" })).toBeVisible();
    const fileId = new URL(page.url()).pathname.split("/").at(-1)!;
    await expect(page.getByRole("textbox", { name: "Markdown source", exact: true })).toBeEditable();
    await expect(page.getByRole("navigation", { name: "Files" }).getByRole("link", { name: "Draft.md" })).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Private folder" }),
    ).toHaveAttribute("href", `/d/${folderId}`);

    const document = await page.request.get(`/f/${fileId}`);
    expect(await document.text()).not.toContain("Draft.md");
    await waitForSharedProvisioning(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Draft.md" })).toBeVisible();
    await waitForSharedProvisioning(page);

    // The same-revision head still verifies its old ciphertext; substituting
    // an entry in D1 must fail closed before its name reaches the browser.
    await db.prepare("UPDATE directory_entries SET name_ciphertext = X'01' WHERE child_node_id = ?").bind(fileId).run();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Files unavailable" })).toBeVisible();
    await expect(page.getByText("Draft.md", { exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
