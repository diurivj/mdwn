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
  await page.getByRole("button", { name: "Change pseudonym" }).click();
  await expect(page.getByText("Your Public pseudonym was updated everywhere it can be changed.")).toBeVisible();
  const changed = (await page.getByLabel("Current Public pseudonym").textContent()) ?? "";
  expect(changed).toMatch(/^Member /);
  expect(changed).not.toBe("Member Test");
  // The 30-day cooldown is stated and enforced in the UI.
  await expect(page.getByText(/You can change it again on/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Change pseudonym" })).toBeDisabled();

  // The Comment now displays the new pseudonym in the workspace.
  await page.goto(`/f/${workspace.fileId}`);
  await expect(page.getByRole("heading", { name: "Draft.md", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await expect(panel.getByText(changed)).toBeVisible();
  await expect(panel.getByText("Member Test")).toHaveCount(0);
});
