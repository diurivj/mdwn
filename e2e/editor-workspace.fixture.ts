import { test as playwrightTest } from "@playwright/test";
import type { Browser, BrowserContext, Page, Request } from "@playwright/test";
import type { TestHarness } from "wrangler";

import { completeRecoveryPresentation } from "./signup-recovery";

type DiagnosticMode = "signup" | "checkpoint";
type CheckpointDiagnosticPhase =
  | "initial-reader-navigation"
  | "same-head-reload-start"
  | "same-head-reload-resolved"
  | "fork-replay-reload-start"
  | "fork-replay-reload-resolved"
  | "restored-head-reload-start"
  | "restored-head-reload-resolved";
type DiagnosticRequest = { route: string; method: string; startedAt: number; phase: string };
type DiagnosticState = {
  mode: DiagnosticMode;
  testTitle: string;
  startedAt: number;
  requests: WeakMap<Request, DiagnosticRequest>;
  phases: WeakMap<Page, string>;
  recoveryStep: string;
  verifyObserved: boolean;
};

const diagnosticStates = new WeakMap<BrowserContext, DiagnosticState>();

function activeDiagnosticMode(): DiagnosticMode | undefined {
  const mode = process.env.MDWN_E2E_DIAG_MODE;
  return mode === "signup" || mode === "checkpoint" ? mode : undefined;
}

function diagnosticRoute(mode: DiagnosticMode, request: Request): string | undefined {
  const pathname = new URL(request.url()).pathname;
  if (mode === "signup") {
    if (pathname === "/api/signup/challenge") return "signup.challenge";
    if (pathname === "/api/signup/options") return "signup.options";
    if (pathname === "/api/signup/verify") return "signup.verify";
    return undefined;
  }
  if (request.method() === "GET" && /^\/f\/[^/]+$/.test(pathname)) return "file.document";
  if (/^\/api\/private\/tree\/files\/[^/]+$/.test(pathname)) return "private.file-api";
  return undefined;
}

function emitDiagnostic(state: DiagnosticState, event: Record<string, unknown>) {
  process.stdout.write(`[MDWN_DIAG_SAFE]${JSON.stringify({
    test: state.testTitle,
    elapsedMs: Math.round(performance.now() - state.startedAt),
    ...event,
  })}\n`);
}

function pageForRequest(request: Request): Page | undefined {
  try { return request.frame().page(); }
  catch { return undefined; }
}

function attachDiagnosticListeners(context: BrowserContext, state: DiagnosticState) {
  context.on("request", (request) => {
    let route: string | undefined;
    try { route = diagnosticRoute(state.mode, request); }
    catch { return; }
    if (!route) return;
    const startedAt = performance.now();
    const page = pageForRequest(request);
    const phase = page ? state.phases.get(page) ?? "unmarked" : "unmarked";
    const stamp = { route, method: request.method(), startedAt, phase };
    state.requests.set(request, stamp);
    emitDiagnostic(state, { kind: "request", route, method: stamp.method,
      requestStartMs: Math.round(startedAt - state.startedAt), phase });
    if (route === "signup.verify") {
      state.verifyObserved = true;
      state.recoveryStep = "startRegistration-returned";
      emitDiagnostic(state, { kind: "client-step", step: "startRegistration-returned" });
    }
  });
  context.on("response", (response) => {
    const stamp = state.requests.get(response.request());
    if (!stamp) return;
    emitDiagnostic(state, { kind: "response", route: stamp.route, method: stamp.method,
      status: response.status(), durationMs: Math.round(performance.now() - stamp.startedAt), phase: stamp.phase });
  });
  context.on("requestfailed", (request) => {
    const stamp = state.requests.get(request);
    if (!stamp) return;
    emitDiagnostic(state, { kind: "request-ended", route: stamp.route, method: stamp.method,
      status: null, durationMs: Math.round(performance.now() - stamp.startedAt), phase: stamp.phase });
  });
}

export function markCheckpointDiagnosticPhase(page: Page, phase: CheckpointDiagnosticPhase) {
  const state = diagnosticStates.get(page.context());
  if (!state || state.mode !== "checkpoint") return;
  state.phases.set(page, phase);
  emitDiagnostic(state, { kind: "phase", phase });
}

/** Browser + real migrated Worker: the same private File seam used by a person editing. */
export async function openEditor(browser: Browser, server: TestHarness, baseURL: string,
  name = "Workspace.md"): Promise<{ context: BrowserContext; page: Page; fileId: string; rootId: string;
    accountId: string; deviceId: string; phrase: string }> {
  await server.getWorker<{ DB: D1Database }>().applyD1Migrations("DB");
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1200, height: 850 } });
  const mode = activeDiagnosticMode();
  const diagnostic: DiagnosticState | undefined = mode ? {
    mode,
    testTitle: playwrightTest.info().title,
    startedAt: performance.now(),
    requests: new WeakMap(),
    phases: new WeakMap(),
    recoveryStep: "not-started",
    verifyObserved: false,
  } : undefined;
  if (diagnostic) {
    diagnosticStates.set(context, diagnostic);
    attachDiagnosticListeners(context, diagnostic);
    emitDiagnostic(diagnostic, { kind: "probe-start", mode });
  }
  await context.addInitScript(() => {
    if (typeof globalThis.PublicKeyCredential !== "function") {
      Object.defineProperty(globalThis, "PublicKeyCredential", { configurable: true,
        value: class PublicKeyCredential {} });
    }
  });
  await context.credentials.install();
  const page = await context.newPage();
  await page.goto(new URL("/sign-up", baseURL).href, { waitUntil: "commit" });
  const configuredVerifyTimeout = Number(process.env.MDWN_E2E_DIAG_VERIFY_TIMEOUT_MS);
  const verifyTimeoutMs = Number.isSafeInteger(configuredVerifyTimeout) && configuredVerifyTimeout > 0
    ? configuredVerifyTimeout : 120_000;
  const verify = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/signup/verify" &&
    request.method() === "POST", { timeout: verifyTimeoutMs });
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  const recovery = await completeRecoveryPresentation(page, diagnostic?.mode === "signup" ? {
    onDiagnosticStep: (step) => {
      diagnostic.recoveryStep = step;
      emitDiagnostic(diagnostic, { kind: "recovery-step", step });
    },
  } : {});
  const signupRequest = await verify.catch((error: unknown) => {
    if (diagnostic?.mode === "signup") emitDiagnostic(diagnostic, {
      kind: "signup-summary", startRegistrationReturned: "not-observed",
      recoveryStep: diagnostic.recoveryStep, verifyWaitMs: verifyTimeoutMs,
    });
    throw error;
  });
  if (diagnostic?.mode === "signup") emitDiagnostic(diagnostic, {
    kind: "signup-summary", startRegistrationReturned: diagnostic.verifyObserved,
    recoveryStep: diagnostic.recoveryStep, verifyWaitMs: verifyTimeoutMs,
  });
  const signup = signupRequest.postDataJSON() as { transcript: {
    rootDirectoryId: string; accountId: string; deviceId: string;
  } };
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
