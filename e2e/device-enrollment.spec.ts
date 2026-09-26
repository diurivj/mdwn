import type { Browser } from "@playwright/test";

import { test, expect } from "./fixtures";
import { completeRecoveryPresentation } from "./signup-recovery";

test.setTimeout(240_000);

async function withPasskey(browser: Browser, origin: string,
  passkey?: Awaited<ReturnType<Awaited<ReturnType<Browser["newContext"]>>["credentials"]["get"]>>[number]) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addInitScript(() => {
    if (typeof globalThis.PublicKeyCredential !== "function") {
      Object.defineProperty(globalThis, "PublicKeyCredential", {
        configurable: true, value: class PublicKeyCredential {},
      });
    }
  });
  if (passkey) await context.credentials.create(new URL(origin).hostname, passkey);
  await context.credentials.install();
  const page = await context.newPage();
  await page.goto(`${origin}/sign-up`, { waitUntil: "commit" });
  return { context, page };
}

test("a synced Passkey needs QR approval before the second browser can open Files", async ({ browser, server, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const worker = server.getWorker<{ DB: D1Database }>();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();
  const original = await withPasskey(browser, origin);
  const browserErrors: string[] = [];
  original.page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  let candidate: Awaited<ReturnType<typeof withPasskey>> | undefined;
  try {
    await original.page.getByRole("button", { name: "Create account", exact: true }).click();
    await completeRecoveryPresentation(original.page);
    await expect(original.page.getByText("Your account is ready.", { exact: false })).toBeVisible({ timeout: 120_000 });
    const passkey = (await original.context.credentials.get())[0]!;
    candidate = await withPasskey(browser, origin, passkey);
    await candidate.page.goto(`${origin}/sign-in`, { waitUntil: "commit" });
    await candidate.page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect(candidate.page.getByText("Signed in.", { exact: false })).toBeVisible();
    await candidate.page.goto(`${origin}/account/device-access`, { waitUntil: "commit" });
    await expect(candidate.page.getByRole("heading", { name: "Restore private access" })).toBeVisible();
    await candidate.page.getByRole("link", { name: "Enroll this device" }).click();
    await candidate.page.getByLabel("Device label (optional)").fill("Second device");
    await candidate.page.getByRole("button", { name: "Create pairing QR code" }).click();
    await expect(candidate.page.getByRole("heading", { name: "Scan this QR code" })).toBeVisible();
    await expect.poll(() => candidate!.page.locator("canvas[aria-label='Device pairing QR code']")
      .evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBe(512);
    const pairingLink = await candidate.page.getByRole("textbox", { name: "Pairing link" }).inputValue();
    expect(pairingLink).toContain("#");
    const rawSecret = (JSON.parse(atob(pairingLink.split("#")[1]!.replaceAll("-", "+").replaceAll("_", "/"))) as {
      pairingSecret: string;
    }).pairingSecret;
    const sent: string[] = [];
    candidate.page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/device-enrollment/")) {
        sent.push(`${request.url()} ${request.postData() ?? ""}`);
      }
    });
    await original.page.goto(`${origin}/enroll-device/approve`, { waitUntil: "commit" });
    await original.page.getByRole("textbox", { name: "Pairing link" }).fill(pairingLink);
    await original.page.getByRole("button", { name: "Approve device" }).click();
    // The candidate's sign-in and fresh assertion advanced its virtual copy
    // twice. The original virtual copy catches up before it can approve.
    await expect(original.page.getByRole("alert")).toBeVisible({ timeout: 30_000 });
    const secondAssertion = original.page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/auth/passkeys/fresh/verify");
    await original.page.getByRole("button", { name: "Approve device" }).click();
    expect((await secondAssertion).status()).toBe(401);
    const thirdAssertion = original.page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/auth/passkeys/fresh/verify");
    await original.page.getByRole("button", { name: "Approve device" }).click();
    expect((await thirdAssertion).status()).toBe(200);
    await expect(original.page.getByRole("status").or(original.page.getByRole("alert"))).toBeVisible({ timeout: 30_000 });
    expect(await original.page.getByRole("alert").count(), browserErrors.join("\n")).toBe(0);
    await expect(original.page.getByRole("status")).toContainText("Approval sent");
    await expect(candidate.page.getByRole("heading", { name: "Setting up your Files securely…" }))
      .toBeVisible({ timeout: 120_000 });
    await candidate.page.goto(`${origin}/account/device-access`, { waitUntil: "commit" });
    await expect(candidate.page.getByRole("heading", { name: "Private access ready" })).toBeVisible();
    expect(sent.every((request) => !request.includes(rawSecret) && !request.includes("Second device"))).toBe(true);
    const devices = await env.DB.prepare("SELECT state FROM encryption_devices ORDER BY created_at").all<{ state: string }>();
    expect(devices.results).toEqual([{ state: "active" }, { state: "active" }]);
    const enrolled = await env.DB.prepare("SELECT label_ciphertext FROM encryption_devices WHERE approval_provenance != 'signup'")
      .first<{ label_ciphertext: ArrayBuffer | number[] }>();
    const ciphertext = new Uint8Array(enrolled!.label_ciphertext);
    expect(ciphertext.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(ciphertext)).not.toContain("Second device");
    await expect.poll(async () => (await env.DB.prepare("SELECT state FROM crypto_jobs WHERE kind = 'enrollment_owned'")
      .first<{ state: string }>())?.state, { timeout: 30_000 }).toBe("complete");
    expect((await env.DB.prepare("SELECT count(*) AS n FROM key_envelopes WHERE purpose = 'owned-device'")
      .first<{ n: number }>())?.n).toBe(1);
    expect((await original.page.evaluate(async () =>
      (await fetch("/api/auth/session")).json() as Promise<{ authenticated: boolean }>)).authenticated).toBe(true);
  } finally {
    await candidate?.context.close();
    await original.context.close();
  }
});
