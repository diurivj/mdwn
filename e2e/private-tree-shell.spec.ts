import { test, expect } from "./fixtures";

const opaque = "019950d7-98c0-7000-8000-000000000014";

for (const prefix of ["d", "f"] as const) {
  test(`${prefix === "d" ? "Directory" : "File"} deep link server-renders only a public library shell`, async ({
    page,
  }) => {
    const document = await page.request.get(`/${prefix}/${opaque}`);
    expect(document.status()).toBe(200);
    const html = await document.text();
    expect(html).toContain("Opening your library");
    expect(html).not.toContain("rootRecoveryEnvelope");
    expect(html).not.toContain("encryptedProfile");
    await page.goto(`/${prefix}/${opaque}`);
    await expect(page.getByRole("heading", { name: "Files unavailable" })).toBeVisible();
    await expect(page).toHaveTitle("Library — mdwn");
    // Hydration takes over the server-rendered fallback rather than leaving it beside the page.
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByText("Opening your library", { exact: false })).toHaveCount(0);
  });
}
