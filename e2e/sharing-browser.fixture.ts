import type { Browser, BrowserContext, Page } from "@playwright/test";
import type { TestHarness } from "wrangler";

import { expect } from "./fixtures";
import { openEditor } from "./editor-workspace.fixture";

type TestAccount = Awaited<ReturnType<typeof openEditor>>;
type Passkey = Awaited<ReturnType<BrowserContext["credentials"]["get"]>>[number];
type TestEnv = { DB: D1Database };

export async function accountShareId(server: TestHarness, accountId: string): Promise<string> {
  const db = (await server.getWorker<TestEnv>().getEnv()).DB;
  const row = await db.prepare("SELECT share_id FROM accounts WHERE id = ?")
    .bind(accountId).first<{ share_id: string }>();
  if (!row?.share_id) throw new Error("Expected an existing opaque Account share ID");
  return row.share_id;
}

/** Resolve an actual Account share ID and submit the application's real Share workflow. */
export async function inviteFromCurrentPage(page: Page, shareId: string,
  permission: "read_only" | "read_write"): Promise<string> {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const panel = page.getByRole("region", { name: "Share this content" });
  await panel.getByLabel("Exact share ID or @handle").fill(shareId);
  await panel.getByLabel("Permission").selectOption(permission);
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request();
    return new URL(response.url()).pathname === "/api/private/sharing/shares" && request.method() === "PUT";
  });
  await panel.getByRole("button", { name: "Invite", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const result = await response.json() as { shareId: string };
  expect(result.shareId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(panel.getByText("Invitation sent.", { exact: false })).toBeVisible();
  return result.shareId;
}

/** Add a real second Encryption device with the existing QR + virtual-passkey ceremony. */
export async function addSecondDevice(browser: Browser, baseURL: string, server: TestHarness,
  account: TestAccount): Promise<{ context: BrowserContext; deviceId: string }> {
  const passkey: Passkey | undefined = (await account.context.credentials.get())[0];
  if (!passkey) throw new Error("The Account signup did not create a passkey");

  const origin = new URL(baseURL).origin;
  const candidateContext = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await candidateContext.addInitScript(() => {
      if (typeof globalThis.PublicKeyCredential !== "function") {
        Object.defineProperty(globalThis, "PublicKeyCredential", {
          configurable: true, value: class PublicKeyCredential {},
        });
      }
    });
    await candidateContext.credentials.create(new URL(origin).hostname, passkey);
    await candidateContext.credentials.install();
    const candidate = await candidateContext.newPage();
    await candidate.goto(`${origin}/sign-in`, { waitUntil: "commit" });
    await candidate.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect(candidate.getByText("Signed in.", { exact: false })).toBeVisible();
    await candidate.goto(`${origin}/account/device-access`, { waitUntil: "commit" });
    await expect(candidate.getByRole("heading", { name: "Restore private access" })).toBeVisible();
    await candidate.getByRole("link", { name: "Enroll this device" }).click();
    await candidate.getByRole("button", { name: "Create pairing QR code" }).click();
    await expect(candidate.getByRole("heading", { name: "Scan this QR code" })).toBeVisible();
    const pairingLink = await candidate.getByRole("textbox", { name: "Pairing link" }).inputValue();
    await candidate.getByRole("button", { name: "I've scanned it" }).click();
    await expect(candidate.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();

    await account.page.goto(`${origin}/enroll-device/approve`, { waitUntil: "commit" });
    await account.page.getByRole("textbox", { name: "Pairing link" }).fill(pairingLink);
    let approved = false;
    for (let attempt = 0; attempt < 3 && !approved; attempt++) {
      const verification = account.page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/auth/passkeys/fresh/verify");
      await account.page.getByRole("button", { name: "Approve device" }).click();
      approved = (await verification).status() === 200;
      if (!approved) await expect(account.page.getByRole("alert")).toBeVisible();
    }
    expect(approved).toBe(true);

    await candidate.goto(`${origin}/enroll-device`, { waitUntil: "commit" });
    const db = (await server.getWorker<TestEnv>().getEnv()).DB;
    await expect.poll(async () => {
      const row = await db.prepare("SELECT count(*) AS n FROM encryption_devices WHERE account_id = ? AND state = 'active'")
        .bind(account.accountId).first<{ n: number }>();
      return row?.n ?? 0;
    }, { timeout: 120_000 }).toBe(2);
    await candidate.goto(`${origin}/account/device-access`, { waitUntil: "commit" });
    await expect(candidate.getByRole("heading", { name: "Private access ready" })).toBeVisible({ timeout: 120_000 });

    const devices = await db.prepare(`SELECT id FROM encryption_devices
      WHERE account_id = ? AND state = 'active' ORDER BY created_at, id`).bind(account.accountId)
      .all<{ id: string }>();
    expect(devices.results).toHaveLength(2);
    const deviceId = devices.results.find((device) => device.id !== account.deviceId)?.id;
    if (!deviceId) throw new Error("The second active device was not persisted");
    return { context: candidateContext, deviceId };
  } catch (error) {
    await candidateContext.close();
    throw error;
  }
}

export { openEditor };
