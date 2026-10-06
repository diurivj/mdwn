import { test, expect } from "./workspace-fixture";

test("the Owner creates, edits and hard-deletes Private Comments in the wide inspector", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  const panel = page.getByRole("region", { name: "Private comments", exact: true });
  await expect(panel.getByText("No comments yet.")).toBeVisible();
  const composer = page.getByLabel("Add a private comment");
  await composer.fill("Plain **text** only <b>bold</b>");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(panel.getByText("Plain **text** only <b>bold</b>")).toBeVisible();
  await expect(panel.getByText("Member Test")).toBeVisible();
  // HTML and Markdown are never interpreted.
  await expect(panel.locator("strong, b")).toHaveCount(0);
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Edit comment").fill("Edited body");
  await page.getByRole("button", { name: "Save comment" }).click();
  await expect(panel.getByText("Edited body")).toBeVisible();
  await panel.getByRole("button", { name: "Delete", exact: true }).click();
  await panel.getByRole("button", { name: "Confirm delete" }).click();
  await expect(panel.getByText("No comments yet.")).toBeVisible();
  // Comment plaintext never enters the document response.
  const document = await page.request.get(`/f/${workspace.fileId}`);
  expect(await document.text()).not.toContain("Edited body");
  expect(await document.text()).not.toContain("Plain");
});

test("keeps an unsent Comment draft across a File rename revalidation", async ({ page, workspace }) => {
  expect(workspace.fileId).toBeTruthy();
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  const panel = page.getByRole("region", { name: "Private comments", exact: true });
  await expect(panel.getByText("No comments yet.")).toBeVisible();
  await page.getByLabel("Add a private comment").fill("Draft survives rename");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Rename", exact: true });
  await dialog.getByLabel("Name").fill("Renamed.md");
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Renamed.md", exact: true })).toBeVisible();
  await expect(page.getByLabel("Add a private comment")).toHaveValue("Draft survives rename");
});

test("narrow layouts switch the Comments content view with the composer at the bottom", async ({ page, workspace }) => {
  expect(workspace.fileId).toBeTruthy();
  await page.setViewportSize({ width: 480, height: 900 });
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await expect(page.getByLabel("Add a private comment")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Markdown source", exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Markdown source", exact: true })).toBeVisible();
});
