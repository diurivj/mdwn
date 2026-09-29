import type { Browser, BrowserContext, Page } from "@playwright/test";
import type { TestHarness } from "wrangler";

import { completeRecoveryPresentation } from "./signup-recovery";

/** Browser + real migrated Worker: the same private File seam used by a person editing. */
export async function openEditor(browser: Browser, server: TestHarness, baseURL: string,
  name = "Workspace.md"): Promise<{ context: BrowserContext; page: Page; fileId: string; rootId: string;
    accountId: string; deviceId: string; phrase: string }> {
  await server.getWorker<{ DB: D1Database }>().applyD1Migrations("DB");
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1200, height: 850 } });
  await context.addInitScript(() => {
    if (typeof globalThis.PublicKeyCredential !== "function") {
      Object.defineProperty(globalThis, "PublicKeyCredential", { configurable: true,
        value: class PublicKeyCredential {} });
    }
  });
  await context.credentials.install();
  const page = await context.newPage();
  await page.goto(new URL("/sign-up", baseURL).href, { waitUntil: "commit" });
  const { recovery, signup } = await signUp(page);
  await expectReady(page);
  const rootId = signup.transcript.rootDirectoryId;
  await page.goto(new URL(`/d/${rootId}`, baseURL).href);
  await page.getByRole("button", { name: "New File" }).click();
  const dialog = page.getByRole("dialog", { name: "Create a name" });
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("heading", { name }).waitFor();
  return { context, page, fileId: new URL(page.url()).pathname.split("/").at(-1)!, rootId,
    accountId: signup.transcript.accountId, deviceId: signup.transcript.deviceId,
    phrase: recovery.phrase.map((word) => word.replace(/^\d+\.\s*/, "").trim()).join(" ") };
}

type SignupTranscript = { transcript: { rootDirectoryId: string; accountId: string; deviceId: string } };

/**
 * Signs up once, retrying a single time only after a network-level failure of a
 * signup request. The local harness is served by workerd, which closes an idle
 * HTTP/1.1 connection after 5 s without announcing it; WebKit, unlike Chromium and
 * Firefox, does not replay a POST that lands on the closing socket. Signup's proof
 * of work leaves a variable idle gap before `/api/signup/options`, so it can hit
 * that ~2 ms window. Any HTTP-level refusal still fails the test.
 */
async function signUp(page: Page): Promise<{ recovery: Awaited<ReturnType<typeof completeRecoveryPresentation>>;
  signup: SignupTranscript }> {
  const signupRequest = (request: { url(): string }) => new URL(request.url()).pathname.startsWith("/api/signup/");
  for (let attempt = 1; ; attempt++) {
    let networkFailure: string | null = null;
    const failed = (request: { url(): string; failure(): { errorText: string } | null }) => {
      if (signupRequest(request)) networkFailure ??= `${new URL(request.url()).pathname}: ${request.failure()?.errorText}`;
    };
    page.on("requestfailed", failed);
    try {
      const verified = page.waitForResponse((response) => response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/signup/verify", { timeout: 120_000 });
      verified.catch(() => undefined); // A losing race must not surface as an unhandled rejection.
      await page.getByRole("button", { name: "Create account", exact: true }).click();
      const recovery = await completeRecoveryPresentation(page);
      // Only confirming the codes commits; a previous attempt's alert is gone by now.
      const refused = page.getByText("We could not create your account.", { exact: false })
        .waitFor({ timeout: 120_000 });
      refused.catch(() => undefined);
      const outcome = await Promise.race([verified, refused.then(() => null)]);
      if (outcome) {
        if (!outcome.ok()) throw new Error(`signup verification returned ${outcome.status()}`);
        return { recovery, signup: outcome.request().postDataJSON() as SignupTranscript };
      }
      if (!networkFailure || attempt > 1) {
        throw new Error(`signup failed${networkFailure ? ` after a retry (${networkFailure})` : " without a network failure"}`);
      }
    } finally {
      page.off("requestfailed", failed);
    }
  }
}

async function expectReady(page: Page) {
  await page.getByText("Your account is ready.", { exact: false }).waitFor({ timeout: 120_000 });
}

export function warnsOnUnload(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

export function filePatch(request: { url(): string; method(): string }, fileId: string): boolean {
  return request.method() === "PATCH" && new URL(request.url()).pathname === `/api/private/tree/files/${fileId}`;
}

export async function compose(page: Page, value: string, data: string) {
  await page.getByRole("textbox", { name: "Markdown source" }).evaluate((area: HTMLTextAreaElement,
    input: { value: string; data: string }) => {
    area.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: input.data }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, input.value);
    area.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: input.data }));
    area.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: input.data }));
  }, { value, data });
}
