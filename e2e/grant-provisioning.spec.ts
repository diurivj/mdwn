import { createHash } from "node:crypto";
import type { Page, Request } from "@playwright/test";

import { test, expect } from "./fixtures";
import { settled } from "./support/settle";
import { accountShareId, addSecondDevice, inviteFromCurrentPage, openEditor } from "./sharing-browser.fixture";

/**
 * Ticket 20's browser proof: the Owner's real `needs-client.ts` sealer — not the
 * `tests/worker/provisioning-fixtures.ts` mirror — fulfils the provisioning needs an
 * enrollment left behind. A routine second device advances the recipient's registry
 * epoch, which invalidates every existing device's Shared-as label, capability and File
 * envelope; the Owner's browser re-seals them at the current epoch under a re-signed offer.
 */
const DIRECTORY_MARKDOWN = "PROVISIONED_DIRECTORY_CONTENT_MUST_BE_READABLE";
const DIRECT_MARKDOWN = "PROVISIONED_DIRECT_FILE_CONTENT_MUST_BE_READABLE";

test.setTimeout(420_000);
test.use({ trace: "off", screenshot: "off", video: "off" });

type TestEnv = { DB: D1Database };

/** D1 returns BLOBs as ArrayBuffer (some runtimes hand back a numeric array); normalize. */
function hexOf(value: unknown): string {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value)
    : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value as number[]);
  return Buffer.from(bytes).toString("hex");
}

const fromWire = (value: string) => new Uint8Array(Buffer.from(value, "base64url"));

const digestOf = (value: string) => createHash("sha256").update(fromWire(value)).digest("hex");

async function open(page: Page, url: string) {
  await settled(page);
  try { await page.goto(url); }
  catch (error) {
    if (!/NS_BINDING_ABORTED|interrupted by another navigation/.test(String(error))) throw error;
    await page.goto(url);
  }
}

async function create(page: Page, kind: "New folder" | "New File", name: string): Promise<string> {
  await page.getByRole("button", { name: kind, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a name" });
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

async function accept(page: Page, origin: string, rootId: string, shareId: string, label: string) {
  await open(page, `${origin}/d/${rootId}`);
  const acceptance = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/private/sharing/shares/${shareId}/accept`);
  await page.getByText(label, { exact: true }).locator("..").getByRole("button", { name: "Accept", exact: true }).click();
  const response = await acceptance;
  expect(response.status()).toBe(200);
  return await response.json() as { grantId: string; status: string };
}

/** Captures the next JSON body the page sends to one route. */
function captureJson(page: Page, path: string, method: "PATCH" | "POST") {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => { resolve = done; });
  const handler = (request: Request) => {
    if (request.method() !== method || new URL(request.url()).pathname !== path) return;
    page.off("request", handler);
    resolve(request.postDataJSON());
  };
  page.on("request", handler);
  return promise;
}

async function count(env: TestEnv, sql: string, ...values: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql).bind(...values).first<{ n: number }>())!.n;
}

async function currentEpoch(server: Parameters<typeof addSecondDevice>[2], accountId: string): Promise<number> {
  const env = await server.getWorker<TestEnv>().getEnv();
  return (await env.DB.prepare("SELECT registry_epoch AS epoch FROM account_encryption_identities WHERE account_id = ?")
    .bind(accountId).first<{ epoch: number }>())!.epoch;
}

test("the Owner's browser fulfills a Directory Grant after the recipient's device enrollment", async ({
  browser, server, baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const owner = await openEditor(browser, server, baseURL!, "OwnerSeed.md");
  const recipient = await openEditor(browser, server, baseURL!, "RecipientPrivate.md");
  let secondDevice: Awaited<ReturnType<typeof addSecondDevice>> | undefined;
  try {
    const env = await server.getWorker<TestEnv>().getEnv();
    const recipientShareId = await accountShareId(server, recipient.accountId);

    await open(owner.page, `${origin}/d/${owner.rootId}`);
    const directoryId = await create(owner.page, "New folder", "Research");
    const fileId = await create(owner.page, "New File", "Directory.md");
    await owner.page.getByRole("textbox", { name: "Markdown source" }).fill(DIRECTORY_MARKDOWN);
    await expect(owner.page.getByRole("status", { name: "Save status" })).toHaveText("Saved", { timeout: 30_000 });

    await open(owner.page, `${origin}/d/${directoryId}`);
    const shareId = await inviteFromCurrentPage(owner.page, recipientShareId, "read_write");
    const accepted = await accept(recipient.page, origin, recipient.rootId, shareId,
      "Invitation to a folder (read/write)");
    expect(accepted.status).toBe("ready");
    const grantId = accepted.grantId;

    // Baseline: at epoch 1 the recipient's current device reads the File through the Grant.
    await open(recipient.page, `${origin}/f/${fileId}`);
    await expect(recipient.page.getByRole("textbox", { name: "Markdown source" }))
      .toHaveValue(DIRECTORY_MARKDOWN, { timeout: 30_000 });
    expect(await count(env, "SELECT COUNT(*) AS n FROM grant_device_envelopes WHERE grant_id = ? AND registry_epoch = 1",
      grantId)).toBe(1);

    // Routine enrollment of a second device advances the recipient's registry epoch to 2...
    secondDevice = await addSecondDevice(browser, baseURL!, server, recipient);
    expect(await currentEpoch(server, recipient.accountId)).toBe(2);
    // ...which invalidates the existing device's material and records one opaque need per device.
    await expect.poll(() => count(env, "SELECT COUNT(*) AS n FROM provisioning_needs WHERE grant_id = ?", grantId),
      { timeout: 30_000 }).toBe(2);
    expect(await count(env, "SELECT COUNT(*) AS n FROM grant_device_envelopes WHERE grant_id = ? AND registry_epoch = 2",
      grantId)).toBe(0);
    expect(await count(env, "SELECT COUNT(*) AS n FROM grant_label_deliveries WHERE grant_id = ? AND registry_epoch = 2",
      grantId)).toBe(0);

    // While the need is unfulfilled the recipient sees no name and cannot read the content.
    await open(recipient.page, `${origin}/d/${recipient.rootId}`);
    await expect(recipient.page.getByText("Shared content is being securely provisioned", { exact: true }))
      .toBeVisible({ timeout: 30_000 });
    await expect(recipient.page.getByRole("link", { name: "Research (Shared as)", exact: true })).toHaveCount(0);
    await open(recipient.page, `${origin}/d/${directoryId}`);
    await expect(recipient.page.getByText("Shared content is being securely provisioned", { exact: true })).toBeVisible();
    await expect(recipient.page.getByText(DIRECTORY_MARKDOWN, { exact: true })).toHaveCount(0);

    // The Owner's browser fulfils from an owned Files page, exactly as rotation.spec.ts drives rotation.
    const fulfillment = captureJson(owner.page, `/api/private/provisioning/${directoryId}/grants`, "PATCH");
    await open(owner.page, `${origin}/d/${owner.rootId}`);
    await expect.poll(() => count(env, "SELECT COUNT(*) AS n FROM provisioning_needs WHERE grant_id = ?", grantId),
      { timeout: 120_000 }).toBe(0);
    const body = await fulfillment as { epoch: number; grants: { grantId: string;
      offer: { bytes: string; digest: string; signature: string };
      devices: { deviceId: string; ciphertext: string; labelCiphertext: string | null }[] }[] };

    // What the real sealer submitted is exactly what the Worker stored.
    expect(Object.keys(body).sort()).toEqual(["epoch", "grants"]);
    const capabilityEpoch = (await env.DB.prepare("SELECT capability_epoch AS epoch FROM directories WHERE node_id = ?")
      .bind(directoryId).first<{ epoch: number }>())!.epoch;
    expect(body.epoch).toBe(capabilityEpoch);
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]!.grantId).toBe(grantId);
    const devices = body.grants[0]!.devices;
    expect(devices.map((device) => device.deviceId).sort())
      .toEqual([recipient.deviceId, secondDevice.deviceId].sort());
    for (const device of devices) {
      expect(Object.keys(device).sort()).toEqual(["ciphertext", "deviceId", "labelCiphertext"]);
      // A stale epoch has no current label for either device, so the browser re-seals one from
      // the Owner copy instead of reusing the stored digest.
      expect(device.labelCiphertext, "the browser must re-seal the Shared-as label").not.toBeNull();
      const envelope = await env.DB.prepare(`SELECT ciphertext, digest, registry_epoch, target_epoch, generation
        FROM grant_device_envelopes WHERE grant_id = ? AND device_id = ?`).bind(grantId, device.deviceId)
        .first<{ ciphertext: unknown; digest: unknown; registry_epoch: number; target_epoch: number; generation: number }>();
      expect(envelope, "the sealed capability envelope must be stored").not.toBeNull();
      expect(envelope!.registry_epoch).toBe(2);
      expect(envelope!.target_epoch).toBe(capabilityEpoch);
      expect(envelope!.generation).toBe(1);
      expect(hexOf(envelope!.ciphertext)).toBe(hexOf(fromWire(device.ciphertext)));
      const label = await env.DB.prepare(`SELECT ciphertext, digest, registry_epoch FROM grant_label_deliveries
        WHERE grant_id = ? AND device_id = ?`).bind(grantId, device.deviceId)
        .first<{ ciphertext: unknown; digest: unknown; registry_epoch: number }>();
      expect(label, "the re-sealed label must be stored").not.toBeNull();
      expect(label!.registry_epoch).toBe(2);
      expect(hexOf(label!.ciphertext)).toBe(hexOf(fromWire(device.labelCiphertext!)));
      // The offer's device digests bind exactly the stored label and capability bytes.
      expect(digestOf(device.ciphertext)).toBe(hexOf(envelope!.digest));
      expect(digestOf(device.labelCiphertext!)).toBe(hexOf(label!.digest));
    }
    expect(await count(env, "SELECT COUNT(*) AS n FROM grant_label_deliveries WHERE grant_id = ? AND registry_epoch = 2",
      grantId)).toBe(2);

    // The re-signed offer the browser produced is the stored one, signed by the Owner's device.
    const offer = await env.DB.prepare(`SELECT lower(hex(offer_digest)) AS digest,
      lower(hex(offer_signature)) AS signature, signer_device_id FROM grant_labels WHERE grant_id = ?`).bind(grantId)
      .first<{ digest: string; signature: string; signer_device_id: string }>();
    expect(offer!.digest).toBe(hexOf(fromWire(body.grants[0]!.offer.digest)));
    expect(offer!.signature).toBe(hexOf(fromWire(body.grants[0]!.offer.signature)));
    expect(offer!.signer_device_id).toBe(owner.deviceId);

    // The material the recipient reads comes from the Grant, never from a Vault-root envelope.
    const capability = await env.DB.prepare("SELECT ciphertext FROM grant_device_envelopes WHERE grant_id = ? AND device_id = ?")
      .bind(grantId, recipient.deviceId).first<{ ciphertext: unknown }>();
    const label = await env.DB.prepare("SELECT ciphertext FROM grant_label_deliveries WHERE grant_id = ? AND device_id = ?")
      .bind(grantId, recipient.deviceId).first<{ ciphertext: unknown }>();
    const vaultEnvelopes = (await env.DB.prepare("SELECT ciphertext FROM key_envelopes WHERE account_id = ?")
      .bind(recipient.accountId).all<{ ciphertext: unknown }>()).results.map((row) => hexOf(row.ciphertext));
    expect(vaultEnvelopes).not.toContain(hexOf(capability!.ciphertext));
    expect(vaultEnvelopes).not.toContain(hexOf(label!.ciphertext));

    // The recipient's page becomes ready and it reads the shared content.
    await open(recipient.page, `${origin}/d/${recipient.rootId}`);
    await expect(recipient.page.getByRole("link", { name: "Research (Shared as)", exact: true }))
      .toBeVisible({ timeout: 30_000 });
    await open(recipient.page, `${origin}/f/${fileId}`);
    await expect(recipient.page.getByRole("textbox", { name: "Markdown source" }))
      .toHaveValue(DIRECTORY_MARKDOWN, { timeout: 30_000 });
  } finally {
    await secondDevice?.context.close();
    await recipient.context.close();
    await owner.context.close();
  }
});

test("the Owner's browser fulfills a direct File Grant after the recipient's device enrollment", async ({
  browser, server, baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const owner = await openEditor(browser, server, baseURL!, "OwnerSeed.md");
  const recipient = await openEditor(browser, server, baseURL!, "RecipientPrivate.md");
  let secondDevice: Awaited<ReturnType<typeof addSecondDevice>> | undefined;
  try {
    const env = await server.getWorker<TestEnv>().getEnv();
    const recipientShareId = await accountShareId(server, recipient.accountId);

    await open(owner.page, `${origin}/f/${owner.fileId}`);
    await owner.page.getByRole("textbox", { name: "Markdown source" }).fill(DIRECT_MARKDOWN);
    await expect(owner.page.getByRole("status", { name: "Save status" })).toHaveText("Saved", { timeout: 30_000 });
    const shareId = await inviteFromCurrentPage(owner.page, recipientShareId, "read_only");
    const accepted = await accept(recipient.page, origin, recipient.rootId, shareId, "Invitation to a File (read-only)");
    expect(accepted.status).toBe("ready");
    const grantId = accepted.grantId;

    await open(recipient.page, `${origin}/f/${owner.fileId}`);
    await expect(recipient.page.getByRole("textbox", { name: "Markdown source" }))
      .toHaveValue(DIRECT_MARKDOWN, { timeout: 30_000 });

    secondDevice = await addSecondDevice(browser, baseURL!, server, recipient);
    expect(await currentEpoch(server, recipient.accountId)).toBe(2);
    await expect.poll(() => count(env, "SELECT COUNT(*) AS n FROM provisioning_needs WHERE grant_id = ?", grantId),
      { timeout: 30_000 }).toBe(2);
    expect(await count(env, "SELECT COUNT(*) AS n FROM file_device_envelopes WHERE file_node_id = ? AND registry_epoch = 2",
      owner.fileId)).toBe(0);

    // Unfulfilled: no name, no content, and the direct-File surface only offers a retry.
    await open(recipient.page, `${origin}/d/${recipient.rootId}`);
    await expect(recipient.page.getByText("Shared content is being securely provisioned", { exact: true }))
      .toBeVisible({ timeout: 30_000 });
    await expect(recipient.page.getByRole("link", { name: "OwnerSeed.md (Shared as)", exact: true })).toHaveCount(0);
    await open(recipient.page, `${origin}/f/${owner.fileId}`);
    await expect(recipient.page.getByText("Shared content is being securely provisioned", { exact: true })).toBeVisible();
    await expect(recipient.page.getByText(DIRECT_MARKDOWN, { exact: true })).toHaveCount(0);

    const fulfillment = captureJson(owner.page, `/api/private/provisioning/${owner.fileId}/file`, "PATCH");
    await open(owner.page, `${origin}/d/${owner.rootId}`);
    await expect.poll(() => count(env, "SELECT COUNT(*) AS n FROM provisioning_needs WHERE grant_id = ?", grantId),
      { timeout: 120_000 }).toBe(0);
    const body = await fulfillment as { expectedHeadDigest: string; signedHead: { bytes: string; digest: string;
      signature: string }; recipientEnvelopes: { deviceId: string; ciphertext: string }[];
      grants: { grantId: string; offer: { bytes: string; digest: string; signature: string };
        devices: { deviceId: string; labelCiphertext: string | null }[] }[] };

    expect(Object.keys(body).sort())
      .toEqual(["expectedHeadDigest", "grants", "recipientEnvelopes", "signedHead"]);
    expect(body.recipientEnvelopes.map((item) => item.deviceId).sort())
      .toEqual([recipient.deviceId, secondDevice.deviceId].sort());
    // The File target's offers carry only a re-sealed label; the File envelope is the
    // same-revision recipient-set update submitted alongside them.
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]!.grantId).toBe(grantId);
    await expect.poll(() => count(env, "SELECT COUNT(*) AS n FROM file_device_envelopes WHERE file_node_id = ? AND registry_epoch = 2",
      owner.fileId), { timeout: 30_000 }).toBe(2);
    for (const item of body.recipientEnvelopes) {
      const stored = await env.DB.prepare(`SELECT ciphertext, digest, registry_epoch FROM file_device_envelopes
        WHERE file_node_id = ? AND device_id = ?`).bind(owner.fileId, item.deviceId)
        .first<{ ciphertext: unknown; digest: unknown; registry_epoch: number }>();
      expect(stored, "the re-sealed File envelope must be stored").not.toBeNull();
      expect(stored!.registry_epoch).toBe(2);
      expect(hexOf(stored!.ciphertext)).toBe(hexOf(fromWire(item.ciphertext)));
      expect(digestOf(item.ciphertext)).toBe(hexOf(stored!.digest));
    }
    for (const device of body.grants[0]!.devices) {
      expect(Object.keys(device).sort()).toEqual(["deviceId", "labelCiphertext"]);
      expect(device.labelCiphertext).not.toBeNull();
      const label = await env.DB.prepare(`SELECT ciphertext, digest, registry_epoch FROM grant_label_deliveries
        WHERE grant_id = ? AND device_id = ?`).bind(grantId, device.deviceId)
        .first<{ ciphertext: unknown; digest: unknown; registry_epoch: number }>();
      expect(label).not.toBeNull();
      expect(label!.registry_epoch).toBe(2);
      expect(hexOf(label!.ciphertext)).toBe(hexOf(fromWire(device.labelCiphertext!)));
    }
    // The Owner's browser committed a same-revision recipient-set update signed by its device.
    const head = await env.DB.prepare(`SELECT recipient_set_version, signer_device_id FROM file_heads
      WHERE file_node_id = ?`).bind(owner.fileId).first<{ recipient_set_version: number; signer_device_id: string }>();
    expect(head!.signer_device_id).toBe(owner.deviceId);
    expect(head!.recipient_set_version).toBeGreaterThan(1);
    const offer = await env.DB.prepare(`SELECT lower(hex(offer_digest)) AS digest,
      lower(hex(offer_signature)) AS signature, signer_device_id FROM grant_labels WHERE grant_id = ?`).bind(grantId)
      .first<{ digest: string; signature: string; signer_device_id: string }>();
    expect(offer!.digest).toBe(hexOf(fromWire(body.grants[0]!.offer.digest)));
    expect(offer!.signature).toBe(hexOf(fromWire(body.grants[0]!.offer.signature)));
    expect(offer!.signer_device_id).toBe(owner.deviceId);

    // The File material the recipient reads comes from the Grant, not from a Vault-root envelope.
    const fileKey = await env.DB.prepare("SELECT ciphertext FROM file_device_envelopes WHERE file_node_id = ? AND device_id = ?")
      .bind(owner.fileId, recipient.deviceId).first<{ ciphertext: unknown }>();
    const vaultEnvelopes = (await env.DB.prepare("SELECT ciphertext FROM key_envelopes WHERE account_id = ?")
      .bind(recipient.accountId).all<{ ciphertext: unknown }>()).results.map((row) => hexOf(row.ciphertext));
    expect(vaultEnvelopes).not.toContain(hexOf(fileKey!.ciphertext));

    await open(recipient.page, `${origin}/d/${recipient.rootId}`);
    await expect(recipient.page.getByRole("link", { name: "OwnerSeed.md (Shared as)", exact: true }))
      .toBeVisible({ timeout: 30_000 });
    await open(recipient.page, `${origin}/f/${owner.fileId}`);
    await expect(recipient.page.getByRole("textbox", { name: "Markdown source" }))
      .toHaveValue(DIRECT_MARKDOWN, { timeout: 30_000 });
    await expect(recipient.page.getByRole("textbox", { name: "Markdown source" })).toHaveAttribute("readonly", "");
  } finally {
    await secondDevice?.context.close();
    await recipient.context.close();
    await owner.context.close();
  }
});
