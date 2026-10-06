import { expect, test } from "./fixtures";
import { SUPPORT_ADDRESS_FIXTURES } from "../tests/support/donation-fixtures";

const CONFIGURED_ASSET_COUNT = Object.keys(SUPPORT_ADDRESS_FIXTURES).length;

test("home footer links to the anonymous support page", async ({ page }) => {
  await page.goto("/");

  const link = page.getByRole("link", { name: "Support mdwn" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "/support");

  // Router client-side navigation must resolve the same loader data, not an
  // effect-driven request: the addresses and QR codes appear without a reload.
  await link.click();
  await expect(page).toHaveURL(/\/support$/);
  await expect(page.getByRole("heading", { name: "Support mdwn" })).toBeVisible();
  await expect(page.locator("svg[shape-rendering='crispEdges']")).toHaveCount(CONFIGURED_ASSET_COUNT);
});

test("support page serves static addresses and locally generated QR codes privately", async ({ page, baseURL }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  const response = await page.goto("/support");
  expect(response?.status()).toBe(200);

  // The built Worker applies the strict, nonce-based production CSP.
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'none'");
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9_-]{16,}'/);
  expect(csp).not.toContain("unsafe-eval");
  expect(response?.headers()["x-robots-tag"]).toBe("noindex, nofollow, noarchive");

  for (const address of Object.values(SUPPORT_ADDRESS_FIXTURES)) {
    await expect(page.getByText(address)).toBeVisible();
  }
  // One inline SVG QR code per configured asset, generated locally at render.
  await expect(page.locator("svg[shape-rendering='crispEdges']")).toHaveCount(CONFIGURED_ASSET_COUNT);

  // Funding and no-entitlement statements required by the spec.
  await expect(page.getByText(/domain and any future paid infrastructure/i)).toBeVisible();
  await expect(page.getByText(/runs identically/i)).toBeVisible();
  await expect(page.getByText(/fails closed rather than triggering paid spend/i)).toBeVisible();
  await expect(page.getByText(/No badge, priority, feature, storage, or service guarantee/i)).toBeVisible();

  // No Account, session, or non-essential cookie is set or read.
  expect((await page.context().cookies()).map((cookie) => cookie.name)).toEqual([]);

  // Every request stays on the mdwn origin: no third-party script, widget,
  // tracker, analytics, or QR image service.
  const mdwnOrigin = new URL(baseURL!).origin;
  expect(requests.filter((url) => new URL(url).origin !== mdwnOrigin)).toEqual([]);
});
