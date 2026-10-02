import type { Browser, Page } from "@playwright/test";
import { expect, installWorkspaceScript, objectId, type Workspace } from "../workspace-fixture";
import { completeRecoveryPresentation } from "../signup-recovery";
import type { GrantKeyContext } from "../../app/sharing/grant-keys";
import type { CommentKeyContext } from "../../app/sharing/comment-keys";

export const provisioningNext = "**/api/private/grant-provisioning/next";
export const sharedMarkdown = "# Shared secret\n\nOnly the target File.";
export async function loadFixture(page: Page) {
  await page.addScriptTag({ url: new URL("/__test__/workspace.js", page.url()).href });
}
export async function authenticator(browser: Browser, origin: string,
  passkey?: Awaited<ReturnType<Awaited<ReturnType<Browser["newContext"]>>["credentials"]["get"]>>[number]) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addInitScript(() => {
    if (typeof globalThis.PublicKeyCredential !== "function") Object.defineProperty(globalThis, "PublicKeyCredential", {
      configurable: true, value: class PublicKeyCredential {},
    });
  });
  if (passkey) await context.credentials.create(new URL(origin).hostname, passkey);
  await context.credentials.install();
  const page = await context.newPage();
  // Keep automatic visits from silently completing the explicit pass under test.
  await page.route(provisioningNext, (route) => route.abort());
  return { context, page };
}
export async function signup(browser: Browser, origin: string, script: string) {
  const actor = await authenticator(browser, origin);
  await installWorkspaceScript(actor.page, script, origin);
  await actor.page.goto(`${origin}/sign-up`);
  await actor.page.getByRole("button", { name: "Create account", exact: true }).click();
  let accountId = "", code = "";
  const saved = await completeRecoveryPresentation(actor.page, { beforeConfirm: async () => {
    const text = await actor.page.getByText("Save this non-secret recovery identifier", { exact: false }).textContent();
    accountId = text?.match(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/)?.[0] ?? "";
    code = (await actor.page.locator("section ol li").first().textContent())!.replace(/^\d+\.\s*/, "").trim();
  } });
  await expect(actor.page.getByText("Your account is ready.", { exact: false })).toBeVisible({ timeout: 120_000 });
  await loadFixture(actor.page);
  return { ...actor, accountId, code, phrase: saved.phrase.map((word) => word.replace(/^\d+\.\s*/, "").trim()).join(" ") };
}
export async function enroll(browser: Browser, original: Awaited<ReturnType<typeof signup>>, origin: string, script: string) {
  const candidate = await authenticator(browser, origin, (await original.context.credentials.get())[0]!);
  await installWorkspaceScript(candidate.page, script, origin);
  await candidate.page.goto(`${origin}/sign-in`);
  await candidate.page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(candidate.page.getByText("Signed in.", { exact: false })).toBeVisible();
  await candidate.page.goto(`${origin}/enroll-device`);
  await candidate.page.getByRole("button", { name: "Create pairing QR code" }).click();
  await expect(candidate.page.getByRole("heading", { name: "Scan this QR code" })).toBeVisible();
  const link = await candidate.page.getByRole("textbox", { name: "Pairing link" }).inputValue();
  await candidate.page.goto(origin);
  await original.page.goto(`${origin}/enroll-device/approve`);
  await original.page.getByRole("textbox", { name: "Pairing link" }).fill(link);
  // The synced virtual credential's original counter catches up with the
  // candidate's sign-in and fresh assertion before approval can succeed.
  for (let attempt = 0; attempt < 3; attempt++) {
    await original.page.getByRole("button", { name: "Approve device" }).click();
    await expect(original.page.getByRole(attempt === 2 ? "status" : "alert")).toBeVisible({ timeout: 30_000 });
  }
  await expect(original.page.getByRole("status")).toContainText("Approval sent");
  await candidate.page.goto(`${origin}/enroll-device`);
  await expect(candidate.page.getByRole("status")).toHaveText("Your Account-owned Files are ready on this device.", { timeout: 120_000 });
  await candidate.page.goto(`${origin}/account/device-access`);
  await expect(candidate.page.getByRole("heading", { name: "Private access ready" })).toBeVisible();
  await loadFixture(original.page);
  await loadFixture(candidate.page);
  return candidate;
}

/** No Comment producer exists yet: seed its ciphertext at the DB boundary,
 * while invitation, signatures, acceptance and reads use the real APIs. */
export async function shareWithComments(owner: Page, recipient: Awaited<ReturnType<typeof signup>>, workspace: Workspace,
  options: { ownerRecovery?: boolean } = {}) {
  const address = await workspace.db.prepare("SELECT share_id FROM accounts WHERE id = ?")
    .bind(recipient.accountId).first<{ share_id: string }>();
  const comments = [objectId(), objectId(), objectId()];
  const publicationId = objectId(), threadId = objectId();
  for (const [index, id] of comments.entries()) await workspace.db.prepare(`INSERT INTO sharing_comment_capabilities
    (object_id, owner_id, file_id, thread_id, purpose, publication_id, capability_id, capability_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).bind(id, workspace.accountId, workspace.fileId,
      index === 0 ? id : threadId, index === 0 ? "private-comment-thread" : "public-comment-audience-epoch",
      index === 0 ? null : publicationId, id).run();
  await loadFixture(owner);
  const result = await owner.evaluate(async ({ fileId, shareId, comments, ownerRecovery }) => {
    const api = window.workspaceFixture, access = await api.openRoot();
    const listing = await api.loadDirectory(access, access.rootId, access.rootKey);
    const file = await api.loadFile(access, fileId, access.rootKey);
    await api.convertFileCapability(access, fileId, file, access.rootKey, listing);
    const converted = await api.loadFile(access, fileId, access.rootKey);
    const signer = (await api.getDevice(access.actorAccountId))!;
    const invite = await api.privateRequest("/api/private/shares", { method: "PUT", body: JSON.stringify({
      targetId: fileId, recipient: { shareId }, permission: "read_only",
    }) });
    if (!invite.ok) throw new Error(`Invitation: ${invite.status}`);
    const { shareId: grantId } = await invite.json() as { shareId: string };
    const path = `/api/private/shares/${grantId}/keys`;
    const targets = await (await api.privateRequest(path, { method: "POST" })).json() as GrantKeyContext & {
      devices: { deviceId: string; transportPublicKey: string }[] };
    const publicKey = async (encoded: string) => crypto.subtle.importKey("raw", api.decodeTreeBytes(encoded),
      { name: "ECDH", namedCurve: "P-256" }, true, []);
    const envelopes = await Promise.all(targets.devices.map(async (device) => api.createGrantKeyEnvelope(converted.capabilityKey!,
      await publicKey(device.transportPublicKey), signer.assertionKeyPair.privateKey,
      { ...targets, deviceId: device.deviceId, signerDeviceId: signer.deviceId })));
    const upload = async (path: string, context: GrantKeyContext, envelopes: unknown[]) => {
      const response = await api.privateRequest(path, { method: "PUT", body: JSON.stringify({
        capabilityId: context.capabilityId, capabilityEpoch: context.capabilityEpoch,
        ownerRegistryEpoch: context.ownerRegistryEpoch, recipientRegistryEpoch: context.recipientRegistryEpoch, envelopes,
      }) });
      if (!response.ok) throw new Error(`Key upload: ${response.status}`);
    };
    await upload(path, targets, envelopes);
    const boot = await (await api.privateRequest("/api/private/bootstrap", { method: "POST" })).json() as { enrollmentEnvelope: string };
    const vaultRoot = await api.openDeviceEnrollmentEnvelope(api.decodeTreeBytes(boot.enrollmentEnvelope), signer.transportKeyPair,
      { purpose: "device-enrollment", vaultId: access.actorAccountId, objectId: signer.deviceId, keyId: signer.deviceId,
        keyEpoch: 1, revision: 1, recipientId: signer.deviceId });
    const writer = await api.createSymmetricWriter(vaultRoot);
    const recovery: { objectId: string; ciphertext: number[] }[] = [];
    for (const [index, objectId] of comments.entries()) {
      const path = `/api/private/shares/${grantId}/comment-keys/${objectId}`;
      const context = await (await api.privateRequest(path, { method: "POST" })).json() as CommentKeyContext & {
        devices: { deviceId: string; transportPublicKey: string }[] };
      const key = new Uint8Array(32).fill(70 + index);
      const packets = await Promise.all(context.devices.map(async (device) => api.createCommentKeyEnvelope(key,
        await publicKey(device.transportPublicKey), signer.assertionKeyPair.privateKey,
        { ...context, deviceId: device.deviceId, signerDeviceId: signer.deviceId })));
      await upload(path, context, packets);
      if (ownerRecovery) recovery.push({ objectId, ciphertext: Array.from(await writer.seal(key, {
        purpose: "vault-recovery", vaultId: access.actorAccountId, objectId, keyId: context.capabilityId,
        keyEpoch: context.capabilityEpoch, revision: 1,
      })) });
    }
    return { grantId, fragment: api.encodeTreeBytes(converted.capabilityKey!), recovery };
  }, { fileId: workspace.fileId, shareId: address!.share_id, comments, ownerRecovery: options.ownerRecovery ?? false });
  for (const item of result.recovery) await workspace.db.prepare(`INSERT INTO key_envelopes
    (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'vault-recovery', ?, 'vault-root', ?, 1)`)
    .bind(workspace.accountId, item.objectId, Uint8Array.from(item.ciphertext)).run();
  expect(await recipient.page.evaluate(async (id) => (await window.workspaceFixture.privateRequest(
    `/api/private/shares/${id}/accept`, { method: "POST", body: "{}" })).status, result.grantId)).toBe(201);
  return { grantId: result.grantId, fragment: result.fragment, comments };
}
export async function recover(browser: Browser, original: Awaited<ReturnType<typeof signup>>, origin: string, script: string) {
  const replacement = await authenticator(browser, origin);
  await installWorkspaceScript(replacement.page, script, origin);
  await replacement.page.goto(`${origin}/recover`);
  await replacement.page.getByLabel("Recovery identifier").fill(original.accountId);
  await replacement.page.getByLabel("Unused recovery code").fill(original.code);
  await replacement.page.getByRole("button", { name: "Use recovery code" }).click();
  await expect(replacement.page.getByRole("status")).toContainText("Your passkey is ready and you are signed in", { timeout: 120_000 });
  // Restore the original Session before Vault recovery, so its later denial
  // proves the cryptographic cutover rather than just code-based recovery.
  await original.page.goto(`${origin}/sign-in`);
  await original.page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(original.page.getByText("Signed in.", { exact: false })).toBeVisible();
  const ownedObjects: string[] = [];
  await replacement.page.route("**/api/private/recovery-provision/next", async (route) => {
    const response = await route.fetch();
    const value = await response.json() as { item: { objectId: string } | null };
    if (value.item) ownedObjects.push(value.item.objectId);
    await route.fulfill({ response });
  });
  await replacement.page.goto(`${origin}/recover-files`);
  await replacement.page.getByLabel("Current recovery phrase").fill(original.phrase);
  await replacement.page.getByRole("button", { name: "Recover Files" }).click();
  await expect(replacement.page.getByRole("heading", { name: "Save your new recovery phrase" })).toBeVisible({ timeout: 120_000 });
  await replacement.page.goto(`${origin}/account/device-access`);
  await expect(replacement.page.getByRole("heading", { name: "Private access ready" })).toBeVisible({ timeout: 120_000 });
  await loadFixture(replacement.page);
  // Readiness renders before the background owned pass has committed its final
  // cursor. Keep this visit alive until that public job reports completion.
  await expect.poll(() => replacement.page.evaluate(async () => {
    const response = await window.workspaceFixture.privateRequest("/api/private/recovery-provision/next", { method: "POST" });
    return (await response.json() as { state: string }).state;
  }), { timeout: 30_000 }).toBe("complete");
  const root = await replacement.page.evaluate(async () => (await window.workspaceFixture.openRoot()).rootId);
  expect(ownedObjects.length).toBeGreaterThan(0);
  expect([...new Set(ownedObjects)]).toEqual([root]);
  await loadFixture(original.page);
  expect(await original.page.evaluate(async () => (await fetch("/api/device/state")).status)).toBe(401);
  expect(await original.page.evaluate(async () => {
    try { await window.workspaceFixture.resumeGrantProvisioning(); return "unexpected access"; }
    catch (error) { return error instanceof window.workspaceFixture.PrivateAccessError ? error.state : "unexpected failure"; }
  })).toBe("signed-out");
  return replacement;
}
export async function expectCommentKeys(page: Page, grantId: string, comments: string[]) {
  await loadFixture(page);
  const keys = await page.evaluate(async ({ grantId, comments }) => {
    const api = window.workspaceFixture;
    const state = await (await fetch("/api/device/state")).json() as { accountId: string };
    const device = (await api.getDevice(state.accountId))!;
    return Promise.all(comments.map(async (id) => {
      const response = await api.privateRequest(`/api/private/grants/${grantId}/comment-keys/${id}`, { method: "POST" });
      if (!response.ok) throw new Error(`Comment access: ${response.status}`);
      const envelope = await response.json() as Parameters<typeof api.openCommentKeyEnvelope>[0];
      return Array.from(await api.openCommentKeyEnvelope({ ...envelope, recipient: device.transportKeyPair }));
    }));
  }, { grantId, comments });
  expect(keys).toEqual(comments.map((_, index) => Array(32).fill(70 + index)));
}
export async function expectPending(page: Page, origin: string, fileId: string, fragment: string) {
  const sent: string[] = [];
  page.on("request", (request) => sent.push(request.url() + (request.postData() ?? "")));
  await page.goto(`${origin}/f/${fileId}#${fragment}`);
  await expect(page.getByText("Shared content is being securely provisioned", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveCount(0);
  await expect(page.getByText("Draft.md", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Only the target File.", { exact: false })).toHaveCount(0);
  expect(sent.some((request) => request.includes(fragment))).toBe(false);
  await loadFixture(page);
}
export async function manualPass(page: Page, origin: string) {
  await page.goto(`${origin}/account/shared-access`);
  await page.getByRole("button", { name: "Provision shared content", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Shared access pass complete" })).toBeVisible();
}
