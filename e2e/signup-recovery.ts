import { expect, type Page } from "@playwright/test";

/** Complete the local recovery presentation; the confirmation button starts registration. */
export async function completeRecoveryPresentation(
  page: Page,
  options: { checkIncorrectWord?: boolean; beforeConfirm?: () => Promise<void> } = {},
) {
  await expect(page.getByRole("heading", { name: "Save your recovery phrase" })).toBeVisible({ timeout: 120_000 });
  const phrase = await page.locator("section ol li").allTextContents();
  expect(phrase).toHaveLength(24);
  const labels = await page.locator("section form label span").allTextContents();
  expect(labels).toHaveLength(3);
  for (const label of labels) {
    const position = Number(label.replace("Word ", "")) - 1;
    await page.getByLabel(label, { exact: true }).fill(phrase[position]!.replace(/^\d+\.\s*/, "").trim());
  }
  if (options.checkIncorrectWord) {
    await page.getByLabel(labels[0]!, { exact: true }).fill("wrong");
    await page.getByRole("button", { name: "Verify phrase" }).click();
    await expect(page.getByRole("alert")).toContainText("do not match");
    await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toHaveCount(0);
    const position = Number(labels[0]!.replace("Word ", "")) - 1;
    await page.getByLabel(labels[0]!, { exact: true }).fill(phrase[position]!.replace(/^\d+\.\s*/, "").trim());
  }
  await page.getByRole("button", { name: "Verify phrase" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  const codes = await page.locator("section ol li").allTextContents();
  expect(codes).toHaveLength(10);
  expect(new Set(codes).size).toBe(10);
  await options.beforeConfirm?.();
  await page.getByRole("button", { name: "I saved my phrase and codes" }).click();
  return { phrase, codes };
}
