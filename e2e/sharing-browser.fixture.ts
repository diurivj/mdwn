import type { Browser, BrowserContext, Locator, Page, Request as PlaywrightRequest,
  Response as PlaywrightResponse } from "@playwright/test";
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
  if (!row?.share_id || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(row.share_id)) {
    throw new Error("Expected an existing canonical opaque Account share ID");
  }
  return row.share_id;
}

type InviteObservation = { method: string; path: string; status: number | "pending" | "failed";
  response?: PlaywrightResponse };
type InviteWaitResult = { response: PlaywrightResponse } | { failure: "request-failed" | "timed-out" };
type InviteWaiter = { method: string; path: string; resolve: (result: InviteWaitResult) => void;
  timer: ReturnType<typeof setTimeout> };

/** Capture only fixed sharing endpoints and HTTP status; never inspect request or response bodies. */
function watchInviteRequests(page: Page) {
  const watchedPaths = new Set([
    "/resources/sharing",
    "/api/private/sharing/resolve",
    "/api/private/sharing/target",
    "/api/private/sharing/shares",
  ]);
  const observations: InviteObservation[] = [];
  const byRequest = new Map<PlaywrightRequest, InviteObservation>();
  const waiters: InviteWaiter[] = [];
  let active = false;

  const settle = (waiter: InviteWaiter, result: InviteWaitResult) => {
    clearTimeout(waiter.timer);
    const index = waiters.indexOf(waiter);
    if (index !== -1) waiters.splice(index, 1);
    waiter.resolve(result);
  };
  const onRequest = (request: PlaywrightRequest) => {
    if (!active) return;
    const path = new URL(request.url()).pathname;
    if (!watchedPaths.has(path)) return;
    const observation: InviteObservation = { method: request.method(), path, status: "pending" };
    observations.push(observation);
    byRequest.set(request, observation);
  };
  const onResponse = (response: PlaywrightResponse) => {
    const observation = byRequest.get(response.request());
    if (!observation) return;
    observation.status = response.status();
    observation.response = response;
    const waiter = waiters.find((candidate) => candidate.method === observation.method &&
      candidate.path === observation.path);
    if (waiter) settle(waiter, { response });
  };
  const onRequestFailed = (request: PlaywrightRequest) => {
    const observation = byRequest.get(request);
    if (!observation) return;
    observation.status = "failed";
    const waiter = waiters.find((candidate) => candidate.method === observation.method &&
      candidate.path === observation.path);
    if (waiter) settle(waiter, { failure: "request-failed" });
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);

  return {
    start() { active = true; },
    waitForResponse(method: string, path: string): Promise<InviteWaitResult> {
      const existing = observations.find((item) => item.method === method && item.path === path && item.response);
      if (existing?.response) return Promise.resolve({ response: existing.response });
      if (observations.some((item) => item.method === method && item.path === path && item.status === "failed")) {
        return Promise.resolve({ failure: "request-failed" });
      }
      return new Promise((resolve) => {
        let waiter: InviteWaiter;
        const timer = setTimeout(() => settle(waiter, { failure: "timed-out" }), 30_000);
        waiter = { method, path, resolve, timer };
        waiters.push(waiter);
      });
    },
    summary() {
      return observations.length
        ? observations.slice(-12).map(({ method, path, status }) => `${method} ${path} ${status}`).join("; ")
        : "no allowlisted sharing requests";
    },
    stop() {
      active = false;
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
      for (const waiter of [...waiters]) settle(waiter, { failure: "timed-out" });
    },
  };
}

async function requireInviteResponse(wait: Promise<InviteWaitResult>, trace: ReturnType<typeof watchInviteRequests>,
  panel: Locator, method: string, path: string): Promise<PlaywrightResponse> {
  const result = await wait;
  if ("failure" in result) {
    const alertVisible = await panel.getByRole("alert").isVisible().catch(() => false);
    throw new Error(`No ${method} ${path} response within 30s (${result.failure}); ` +
      `sanitized request evidence: ${trace.summary()}; invite alert visible: ${alertVisible}`);
  }
  return result.response;
}

function requireInviteStatus(response: PlaywrightResponse, method: string, path: string, expected: number,
  trace: ReturnType<typeof watchInviteRequests>) {
  if (response.status() !== expected) {
    throw new Error(`${method} ${path} returned HTTP ${response.status()} (expected ${expected}); ` +
      `sanitized request evidence: ${trace.summary()}`);
  }
}

/** Resolve an actual Account share ID and submit the application's real Share workflow. */
export async function inviteFromCurrentPage(page: Page, shareId: string,
  permission: "read_only" | "read_write"): Promise<string> {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const panel = page.getByRole("region", { name: "Share this content" });
  await panel.getByLabel("Exact share ID or @handle").fill(shareId);
  await panel.getByLabel("Permission").selectOption(permission);

  const trace = watchInviteRequests(page);
  trace.start();
  try {
    const resolving = trace.waitForResponse("POST", "/api/private/sharing/resolve");
    await panel.getByRole("button", { name: "Invite", exact: true }).click();
    const resolve = await requireInviteResponse(resolving, trace, panel, "POST", "/api/private/sharing/resolve");
    requireInviteStatus(resolve, "POST", "/api/private/sharing/resolve", 200, trace);

    const preparing = trace.waitForResponse("POST", "/api/private/sharing/target");
    const target = await requireInviteResponse(preparing, trace, panel, "POST", "/api/private/sharing/target");
    requireInviteStatus(target, "POST", "/api/private/sharing/target", 200, trace);

    const creating = trace.waitForResponse("PUT", "/api/private/sharing/shares");
    const response = await requireInviteResponse(creating, trace, panel, "PUT", "/api/private/sharing/shares");
    requireInviteStatus(response, "PUT", "/api/private/sharing/shares", 201, trace);
    const result = await response.json() as { shareId?: unknown };
    if (typeof result.shareId !== "string" || !/^[0-9a-f-]{36}$/.test(result.shareId)) {
      throw new Error("PUT /api/private/sharing/shares did not return a valid Share identifier");
    }
    await expect(panel.getByText("Invitation sent.", { exact: false })).toBeVisible();
    return result.shareId;
  } finally {
    trace.stop();
  }
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
