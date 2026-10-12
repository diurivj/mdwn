import { test, expect } from "./workspace-fixture";

test("changes the Public pseudonym everywhere and states the cooldown", async ({ page, workspace }) => {
  expect(workspace.fileId).toBeTruthy();
  // A real Comment attribution is the context the change must re-seal.
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  const panel = page.getByRole("region", { name: "Private comments", exact: true });
  await page.getByLabel("Add a private comment").fill("Attribution check");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(panel.getByText("Member Test")).toBeVisible();

  await page.goto("/account/pseudonym");
  await expect(page.getByLabel("Current Public pseudonym")).toHaveText("Member Test");
  await expect(page.getByText("Cached copies and screenshots cannot be changed.")).toBeVisible();
  // The new pseudonym is the person's own text; nothing is submitted until there is some.
  const change = page.getByRole("button", { name: "Change pseudonym" });
  await expect(change).toBeDisabled();
  const field = page.getByRole("textbox", { name: "New pseudonym", exact: true });
  await field.fill("x");
  await expect(page.getByRole("alert")).toHaveText("Use at least 2 characters.");
  await expect(change).toBeDisabled();
  await field.fill("Member Test");
  await change.click();
  await expect(page.getByRole("alert")).toHaveText("That is already your Public pseudonym.");
  await page.getByRole("button", { name: "Suggest one", exact: true }).click();
  await expect(field).toHaveValue(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{2}$/);
  const changed = "  Night   Owl  ";
  await field.fill(changed);
  await change.click();
  await expect(page.getByText("Your Public pseudonym was updated everywhere it can be changed.")).toBeVisible();
  await expect(page.getByLabel("Current Public pseudonym")).toHaveText("Night Owl");
  await expect(field).toHaveValue("");
  // The 30-day cooldown is stated and enforced in the UI.
  await expect(page.getByText(/You can change it again on/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Change pseudonym" })).toBeDisabled();

  // The Comment now displays the new pseudonym in the workspace.
  await page.goto(`/f/${workspace.fileId}`);
  await expect(page.getByRole("heading", { name: "Draft.md", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await expect(panel.getByText("Night Owl", { exact: true })).toBeVisible();
  await expect(panel.getByText("Member Test")).toHaveCount(0);
});
