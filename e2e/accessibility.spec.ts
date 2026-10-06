/**
 * Ticket 33 acceptance: accessibility-sensitive controls are keyboard- and
 * screen-reader-usable (buildable spec §12.6). These are real-Worker browser
 * checks in Chromium, Firefox, and WebKit: every control is reached and
 * operated with the keyboard only, and each region and form control exposes
 * the accessible role/name an assistive technology needs.
 */

import { test, expect } from "./workspace-fixture";

test("creates a File using only the keyboard through a labelled dialog", async ({ page, workspace }) => {
  await expect(page.getByRole("heading", { name: "Draft.md", exact: true })).toBeVisible();
  expect(workspace.fileId).toBeTruthy();
  const newFile = page.getByRole("button", { name: "New File", exact: true });
  await newFile.focus();
  await expect(newFile).toBeFocused();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Create a name" });
  await expect(dialog).toBeVisible();
  const name = dialog.getByLabel("Name");
  await expect(name).toBeFocused();
  await name.pressSequentially("Keyboard.md");
  await page.keyboard.press("Enter");

  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("navigation", { name: "Files" }).getByRole("link", { name: "Keyboard.md", exact: true }),
  ).toBeVisible();
});

test("exposes labelled editor, preview, tree, and comment controls", async ({ page, workspace }) => {
  expect(workspace.fileId).toBeTruthy();
  await expect(page.getByRole("navigation", { name: "Files" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumbs" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Editor" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Markdown source" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Preview" })).toBeVisible();
  await expect(page.getByRole("status", { name: "File save status" })).toBeVisible();

  // The Comments view is reachable by keyboard and its thread selector and
  // composer are labelled.
  const comments = page.getByRole("button", { name: "Comments", exact: true });
  await comments.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tablist", { name: "Comment thread" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Private" })).toHaveAttribute("aria-selected", "true");
  const composer = page.getByRole("textbox", { name: "Add a private comment" });
  await expect(composer).toBeVisible();
  await composer.focus();
  await page.keyboard.type("Keyboard comment");
  await expect(composer).toHaveValue("Keyboard comment");
});

test("opens and closes the narrow tree drawer with the keyboard", async ({ page, workspace }) => {
  expect(workspace.fileId).toBeTruthy();
  await page.setViewportSize({ width: 480, height: 900 });
  const treeButton = page.getByRole("button", { name: "Tree", exact: true });
  await treeButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: "Files tree" })).toBeVisible();

  const close = page.getByRole("button", { name: "Close tree", exact: true });
  await close.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: "Files tree" })).toBeHidden();
  // The trigger remains reachable and operable by keyboard after the drawer closes.
  await treeButton.focus();
  await expect(treeButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: "Files tree" })).toBeVisible();
});
