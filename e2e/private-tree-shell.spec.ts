import { test, expect } from "./fixtures";

const opaque = "019950d7-98c0-7000-8000-000000000014";

for (const prefix of ["d", "f"] as const) {
  test(`${prefix === "d" ? "Directory" : "File"} deep link server-renders only a public Files shell`, async ({ page }) => {
    const document = await page.request.get(`/${prefix}/${opaque}`);
    expect(document.status()).toBe(200);
    const html = await document.text();
    expect(html).toContain("Opening Files");
    expect(html).not.toContain("rootRecoveryEnvelope");
    expect(html).not.toContain("encryptedProfile");
    await page.goto(`/${prefix}/${opaque}`);
    await expect(page.getByRole("heading", { name: "Files unavailable" })).toBeVisible();
    await expect(page).toHaveTitle("Files — mdwn");
  });
}
