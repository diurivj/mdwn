import { test, expect } from "./workspace-fixture";
import { waitForSharedProvisioning } from "./support/navigation";

for (const source of ["file", "device-access"] as const) {
  test(`leaves ${source} safely while the shared-access route module is loading`, async ({ page, workspace }) => {
    let markRequested!: () => void;
    let release!: () => void;
    const requested = new Promise<void>((resolve) => { markRequested = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const modulePattern = "**/assets/account-shared-access-main-*.js";
    const importErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && message.text().includes("Error loading route module")) importErrors.push(message.text());
    });
    // Reproduce the CI window without relying on runner speed or a fixed sleep.
    await page.route(modulePattern, async (route) => {
      markRequested();
      await held;
      await route.continue().catch(() => { /* Teardown may cancel this held request after a failed assertion. */ });
    });
    try {
      if (source === "file") await page.reload();
      else await page.goto("/account/device-access");
      await expect(page.getByRole("heading", {
        name: source === "file" ? "Draft.md" : "Private access ready", exact: true,
      })).toBeVisible();
      await requested;
      await expect(page.getByRole("region", { name: "Shared access provisioning", exact: true }))
        .toHaveAttribute("aria-busy", "true");
      if (source === "file") {
        // An in-app transition must work even before the background import finishes.
        await page.getByRole("complementary", { name: "Files tree", exact: true })
          .getByRole("link", { name: "Files", exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/d/${workspace.rootId}$`));
        await expect(page.getByRole("heading", { name: "Files", exact: true })).toBeVisible();
        release();
        await waitForSharedProvisioning(page);
      } else {
        // External deep links still replace the document; wait for the explicit
        // readiness signal rather than cancelling the browser route-module load.
        release();
        await waitForSharedProvisioning(page);
        await page.goto(`/f/${workspace.fileId}`);
        await expect(page).toHaveURL(new RegExp(`/f/${workspace.fileId}$`));
        await expect(page.getByRole("heading", { name: "Draft.md", exact: true })).toBeVisible();
      }
      expect(importErrors).toEqual([]);
    } finally {
      release();
      await page.unroute(modulePattern);
    }
  });
}
