import { test, expect } from "./fixtures";
import { markCheckpointDiagnosticPhase, openEditor } from "./editor-workspace.fixture";
import { commitConcurrentFileRevision } from "./editor-conflict.fixture";
import { signDeviceBytes } from "./editor-fixture-crypto";
import { decodeBytes, encodeBytes } from "../app/signup/protocol";

import type { Page } from "@playwright/test";

test.setTimeout(240_000);

const fileRead = (fileId: string) => `**/api/private/tree/files/${fileId}`;

/** Delay only completion of a genuine WebCrypto verification of the retained rev-1 head.
 * The Worker responses, signatures, decryption, and browser checkpoint are real.
 */
function delayPreviousHeadVerification() {
  const original = crypto.subtle.verify.bind(crypto.subtle);
  let held = false;
  const gate = { waiting: false, completed: false, release: () => {} };
  Object.assign(window, { __fileCheckpointGate: gate });
  Object.defineProperty(crypto.subtle, "verify", { configurable: true,
    value: async (...args: Parameters<SubtleCrypto["verify"]>) => {
      const verified = await original(...args);
      if (!held && verified &&
          new TextDecoder().decode(args[3]).startsWith('["mdwn/file-head/v1",') &&
          JSON.parse(new TextDecoder().decode(args[3]))[4] === 1) {
        held = true;
        gate.waiting = true;
        await new Promise<void>((resolve) => { gate.release = resolve; });
        gate.completed = true;
      }
      return verified;
    },
  });
}

async function waitForCheckpointVerification(page: Page) {
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __fileCheckpointGate: { waiting: boolean } }).__fileCheckpointGate?.waiting),
  { timeout: 20_000 }).toBe(true);
}

async function releaseCheckpointVerification(page: Page) {
  await page.evaluate(() =>
    (window as unknown as { __fileCheckpointGate: { release: () => void } }).__fileCheckpointGate?.release());
}

async function waitForQueuedFileRead(page: Page, key: string) {
  // This is only a scheduler for the browser-platform interleaving, not a test
  // of a private module. The assertions below use the visible File view.
  await expect.poll(() => page.evaluate(async (name) =>
    (await navigator.locks.query())?.pending?.some((lock) => lock.name === name) ?? false, key),
  { timeout: 20_000 }).toBe(true);
}

test("overlapping authenticated File reads across tabs cannot roll back the checkpoint or accept a replay", async ({ browser, server, baseURL }) => {
  const { context, page, fileId, accountId, deviceId } = await openEditor(browser, server, baseURL!);
  const older = await context.newPage();
  const newer = await context.newPage();
  let releaseResponse: (() => void) | undefined;
  try {
    const key = `mdwn:file-head:${accountId}:${fileId}`;
    expect(JSON.parse((await page.evaluate((name) => localStorage.getItem(name), key))!).revision).toBe(1);
    await commitConcurrentFileRevision({ server, page, accountId, deviceId, fileId,
      source: "current representation two" });
    await older.addInitScript(delayPreviousHeadVerification);
    let captured!: (value: { body: Buffer; headers: Record<string, string>; status: number }) => void;
    const capturedResponse = new Promise<{ body: Buffer; headers: Record<string, string>; status: number }>(
      (resolve) => { captured = resolve; });
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    await older.route(fileRead(fileId), async (route) => {
      const response = await route.fetch(); // Obtain the authentic revision-2 bytes from the migrated Worker.
      const body = await response.body();
      captured({ body, headers: response.headers(), status: response.status() });
      await responseGate;
      await route.fulfill({ response });
    });
    const oldNavigation = older.goto(new URL(`/f/${fileId}`, baseURL!).href);
    const replay = await capturedResponse;
    expect(JSON.parse(replay.body.toString()).revision).toBe(2);
    await commitConcurrentFileRevision({ server, page, accountId, deviceId, fileId,
      source: "current representation three" });
    // The editor tab has not observed either genuine, signed external revision.
    expect(JSON.parse((await page.evaluate((name) => localStorage.getItem(name), key))!).revision).toBe(1);
    releaseResponse?.();
    await waitForCheckpointVerification(older); // Old read has read rev 1 and is awaiting genuine verify.

    await newer.goto(new URL(`/f/${fileId}`, baseURL!).href);
    await waitForQueuedFileRead(newer, key);
    await releaseCheckpointVerification(older);
    await oldNavigation;
    await expect(older.getByRole("textbox", { name: "Markdown source" })).toHaveValue("current representation two");
    await expect(newer.getByRole("textbox", { name: "Markdown source" })).toHaveValue("current representation three");

    await newer.route(fileRead(fileId), (route) => route.fulfill(replay));
    await newer.reload();
    await expect(newer.getByRole("heading", { name: "Files unavailable" })).toBeVisible();
  } finally {
    releaseResponse?.();
    await releaseCheckpointVerification(older).catch(() => {});
    await context.close();
  }
});

test("a second signed File head at the same revision cannot fork the visible File", async ({ browser, server, baseURL }) => {
  const { context, page, fileId, accountId } = await openEditor(browser, server, baseURL!);
  const reader = await context.newPage();
  try {
    markCheckpointDiagnosticPhase(reader, "initial-reader-navigation");
    await reader.goto(new URL(`/f/${fileId}`, baseURL!).href);
    await expect(reader.getByRole("textbox", { name: "Markdown source" })).toHaveValue("");
    markCheckpointDiagnosticPhase(reader, "same-head-reload-start");
    await reader.reload(); // Re-reading the exact same signed head remains valid.
    markCheckpointDiagnosticPhase(reader, "same-head-reload-resolved");
    await expect(reader.getByRole("textbox", { name: "Markdown source" })).toHaveValue("");
    await reader.route(fileRead(fileId), async (route) => {
      const response = await route.fetch(); // Authentic Worker material, then a signed service-response fork.
      const data = await response.json() as { representationId: string;
        fileHead: { bytes: string; digest: string; signature: string } };
      const statement = JSON.parse(new TextDecoder().decode(decodeBytes(data.fileHead.bytes))) as unknown[];
      expect(statement[0]).toBe("mdwn/file-head/v1");
      const forkedRepresentationId = `${data.representationId}-fork`;
      statement[10] = forkedRepresentationId;
      const bytes = new TextEncoder().encode(JSON.stringify(statement));
      const signature = await signDeviceBytes(page, accountId, bytes); // Genuine non-extractable device signer.
      data.fileHead = { ...data.fileHead, bytes: encodeBytes(bytes),
        digest: encodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))),
        signature: encodeBytes(signature) };
      data.representationId = forkedRepresentationId;
      await route.fulfill({ response, json: data });
    });
    markCheckpointDiagnosticPhase(reader, "fork-replay-reload-start");
    await reader.reload();
    markCheckpointDiagnosticPhase(reader, "fork-replay-reload-resolved");
    await expect(reader.getByRole("heading", { name: "Files unavailable" })).toBeVisible();
    await reader.unroute(fileRead(fileId));
    markCheckpointDiagnosticPhase(reader, "restored-head-reload-start");
    await reader.reload();
    markCheckpointDiagnosticPhase(reader, "restored-head-reload-resolved");
    await expect(reader.getByRole("textbox", { name: "Markdown source" })).toHaveValue("");
  } finally { await context.close(); }
});

test("canceling a File load during signature verification leaves its trusted checkpoint unchanged", async ({ browser, server, baseURL }) => {
  const { context, page, fileId, accountId, deviceId, rootId } = await openEditor(browser, server, baseURL!);
  const canceled = await context.newPage();
  const replayPage = await context.newPage();
  try {
    let captured!: (value: { body: Buffer; headers: Record<string, string>; status: number }) => void;
    const capturedResponse = new Promise<{ body: Buffer; headers: Record<string, string>; status: number }>(
      (resolve) => { captured = resolve; });
    await canceled.route(fileRead(fileId), async (route) => {
      const response = await route.fetch();
      captured({ body: await response.body(), headers: response.headers(), status: response.status() });
      await route.fulfill({ response });
    });
    await canceled.goto(new URL(`/f/${fileId}`, baseURL!).href);
    const replay = await capturedResponse;
    expect(JSON.parse(replay.body.toString()).revision).toBe(1);
    await expect(canceled.getByRole("textbox", { name: "Markdown source" })).toHaveValue("");
    await canceled.unroute(fileRead(fileId));
    await commitConcurrentFileRevision({ server, page, accountId, deviceId, fileId, source: "two" });
    await canceled.evaluate(delayPreviousHeadVerification);
    const started = canceled.waitForRequest((request) => request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/private/tree/files/${fileId}`);
    await canceled.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Workspace.md" }).click();
    await started;
    await waitForCheckpointVerification(canceled);
    await canceled.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Files" }).click();
    await expect(canceled).toHaveURL(new URL(`/d/${rootId}`, baseURL!).href);
    await releaseCheckpointVerification(canceled);
    await expect.poll(() => canceled.evaluate(() =>
      (window as unknown as { __fileCheckpointGate: { completed: boolean } }).__fileCheckpointGate.completed)).toBe(true);

    await replayPage.route(fileRead(fileId), (route) => route.fulfill(replay));
    await replayPage.goto(new URL(`/f/${fileId}`, baseURL!).href);
    await expect(replayPage.getByRole("textbox", { name: "Markdown source" })).toHaveValue("");
    await replayPage.unroute(fileRead(fileId));
    await replayPage.reload();
    await expect(replayPage.getByRole("textbox", { name: "Markdown source" })).toHaveValue("two");
  } finally {
    await releaseCheckpointVerification(canceled).catch(() => {});
    await context.close();
  }
});

test("canceling a File load queued behind another tab never advances the checkpoint", async ({ browser, server, baseURL }) => {
  const { context, page, fileId, accountId, deviceId, rootId } = await openEditor(browser, server, baseURL!);
  const older = await context.newPage();
  const canceled = await context.newPage();
  let releaseResponse: (() => void) | undefined;
  try {
    const key = `mdwn:file-head:${accountId}:${fileId}`;
    await canceled.goto(new URL(`/d/${rootId}`, baseURL!).href);
    await expect(canceled.getByRole("link", { name: "Workspace.md" })).toBeVisible();
    await commitConcurrentFileRevision({ server, page, accountId, deviceId, fileId, source: "two" });
    await older.addInitScript(delayPreviousHeadVerification);
    let captured!: (value: { body: Buffer; headers: Record<string, string>; status: number }) => void;
    const capturedResponse = new Promise<{ body: Buffer; headers: Record<string, string>; status: number }>(
      (resolve) => { captured = resolve; });
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    await older.route(fileRead(fileId), async (route) => {
      const response = await route.fetch();
      captured({ body: await response.body(), headers: response.headers(), status: response.status() });
      await responseGate;
      await route.fulfill({ response });
    });
    const olderNavigation = older.goto(new URL(`/f/${fileId}`, baseURL!).href);
    const replay = await capturedResponse;
    expect(JSON.parse(replay.body.toString()).revision).toBe(2);
    await commitConcurrentFileRevision({ server, page, accountId, deviceId, fileId, source: "three" });
    releaseResponse?.();
    await waitForCheckpointVerification(older);
    await canceled.getByRole("navigation", { name: "Files" }).getByRole("link", { name: "Workspace.md" }).click();
    await waitForQueuedFileRead(canceled, key);
    await canceled.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Files" }).click();
    await expect(canceled).toHaveURL(new URL(`/d/${rootId}`, baseURL!).href);
    await expect.poll(() => canceled.evaluate(async (name) =>
      (await navigator.locks.query())?.pending?.some((lock) => lock.name === name) ?? false, key)).toBe(false);
    await releaseCheckpointVerification(older);
    await olderNavigation;
    await expect(older.getByRole("textbox", { name: "Markdown source" })).toHaveValue("two");

    await canceled.route(fileRead(fileId), (route) => route.fulfill(replay));
    await canceled.getByRole("navigation", { name: "Files" }).getByRole("link", { name: "Workspace.md" }).click();
    await expect(canceled.getByRole("textbox", { name: "Markdown source" })).toHaveValue("two");
    await canceled.unroute(fileRead(fileId));
    await canceled.reload();
    await expect(canceled.getByRole("textbox", { name: "Markdown source" })).toHaveValue("three");
  } finally {
    releaseResponse?.();
    await releaseCheckpointVerification(older).catch(() => {});
    await context.close();
  }
});
