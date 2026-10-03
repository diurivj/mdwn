import type { Page } from "@playwright/test";
import { createCookie } from "react-router";
import { build } from "vite";

import { sealAccountProfile } from "../app/crypto/account-profile";
import { createSymmetricWriter } from "../app/crypto/enc-v1";
import { createFileRepresentation, createVaultKeyHierarchy, sealDeviceEnrollmentEnvelope } from "../app/crypto/vault";
import { encodeTreeBytes } from "../app/tree/wire";
import { test as appTest, expect, TEST_SESSION_COOKIE_SECRET } from "./fixtures";
import { waitForSharedProvisioning } from "./support/navigation";

export type Workspace = { fileId: string; rootId: string; accountId: string; rootKey: Uint8Array; db: D1Database };
declare global { interface Window { workspaceFixture: typeof import("./support/workspace-entry"); } }

export const test = appTest.extend<{ workspace: Workspace; initialSource: string; legacySource: boolean }, { workspaceScript: string }>({
  initialSource: ["", { option: true }],
  legacySource: [false, { option: true }],
  workspaceScript: [async ({}, use) => {
    const result = await build({ configFile: false, publicDir: false, logLevel: "error",
      resolve: { alias: { "~": new URL("../app", import.meta.url).pathname } },
      build: { write: false, minify: false, lib: {
        entry: "e2e/support/workspace-entry.ts", name: "workspaceFixture", formats: ["iife"],
      } } });
    const output = (Array.isArray(result) ? result : [result]).flatMap((item) => "output" in item ? item.output : []);
    const script = output.find((item) => item.type === "chunk");
    if (script?.type !== "chunk") throw new Error("Missing workspace fixture bundle");
    await use(script.code);
  }, { scope: "worker" }],
  workspace: async ({ page, context, server, baseURL, workspaceScript, initialSource, legacySource }, use) => {
    const worker = server.getWorker<{ DB: D1Database }>();
    await worker.applyD1Migrations("DB");
    const db = (await worker.getEnv()).DB;
    const accountId = objectId(), rootId = objectId(), fileId = objectId(), deviceId = objectId();
    const credentialId = objectId(), sessionId = objectId(), now = Date.now();
    await installWorkspaceScript(page, workspaceScript, baseURL!);
    const publicKeys = await page.evaluate(async ({ accountId, deviceId }) => {
      const device = await window.workspaceFixture.createDevice(accountId, deviceId);
      await window.workspaceFixture.updateRegistryEpoch(accountId, 1);
      return {
        transport: Array.from(new Uint8Array(await crypto.subtle.exportKey("raw", device.transportKeyPair.publicKey))),
        assertion: Array.from(new Uint8Array(await crypto.subtle.exportKey("raw", device.assertionKeyPair.publicKey))),
      };
    }, { accountId, deviceId });
    const hierarchy = await createVaultKeyHierarchy({ accountId, rootDirectoryId: rootId });
    const profile = await sealAccountProfile(hierarchy.vaultRootKey, { publicPseudonym: "Member Test" },
      { accountId, epoch: 1, revision: 1 });
    const transportKey = await crypto.subtle.importKey("raw", Uint8Array.from(publicKeys.transport),
      { name: "ECDH", namedCurve: "P-256" }, true, []);
    const enrollment = await sealDeviceEnrollmentEnvelope(hierarchy.vaultRootKey, transportKey, {
      purpose: "device-enrollment", vaultId: accountId, objectId: deviceId, keyId: deviceId,
      keyEpoch: 1, revision: 1, recipientId: deviceId,
    });
    await db.batch([
      db.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(accountId, objectId(), now, now),
      db.prepare("INSERT INTO passkeys (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at) VALUES (?, ?, X'01', 0, '[]', 'singleDevice', 0, ?, ?)").bind(credentialId, accountId, now, now),
      db.prepare("INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)").bind(accountId, rootId),
      db.prepare("INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, ?, ?, 'active', 'signup', 1, ?)").bind(deviceId, accountId, Uint8Array.from(publicKeys.transport), Uint8Array.from(publicKeys.assertion), now),
      db.prepare("INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'vault-recovery', ?, 'vault-root', ?, 1)").bind(accountId, rootId, hierarchy.rootDirectoryRecoveryEnvelope),
      db.prepare("INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'device-enrollment', ?, ?, ?, 1)").bind(accountId, deviceId, deviceId, enrollment),
      // These unrelated bootstrap fields are opaque fixture records, not used by the Files flow.
      db.prepare("INSERT INTO recovery_capsules (account_id, generation, recovery_salt, ciphertext, verification_public_key) VALUES (?, 1, zeroblob(32), X'01', X'01')").bind(accountId),
      db.prepare("INSERT INTO account_profiles (account_id, ciphertext, revision, epoch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(accountId, profile.ciphertext, profile.revision, profile.epoch, now, now),
      db.prepare("INSERT INTO sessions (id, account_id, purpose, authenticated_passkey_id, device_id, created_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, 'normal', ?, ?, ?, ?, ?)").bind(sessionId, accountId, credentialId, deviceId, now, now + 3_600_000, now + 86_400_000),
    ]);
    const cookie = await createCookie("__Host-mdwn_session", { path: "/", secure: true, secrets: [TEST_SESSION_COOKIE_SECRET] }).serialize(sessionId);
    await context.addCookies([{ name: "__Host-mdwn_session", value: cookie.split(";", 1)[0]!.slice("__Host-mdwn_session=".length),
      url: new URL(baseURL!).origin, httpOnly: true, secure: true, sameSite: "Lax" }]);
    const workspace = { accountId, rootId, fileId, rootKey: hierarchy.rootDirectoryCapabilityKey, db };
    await seedWorkspaceContent(workspace, page, initialSource, legacySource);
    await page.goto(`/f/${fileId}`);
    await expect(page.getByRole("heading", { name: "Draft.md", exact: true })).toBeVisible();
    await waitForSharedProvisioning(page);
    await use(workspace);
  },
});

export { expect };
export function objectId(): string { const id = crypto.randomUUID(); return `${id.slice(0, 14)}7${id.slice(15)}`; }

export async function installWorkspaceScript(page: Page, script: string, baseURL: string) {
  await page.route("**/__test__/workspace.js", (route) => route.fulfill({ contentType: "text/javascript", body: script }));
  await page.goto(baseURL, { waitUntil: "commit" });
  await page.addScriptTag({ url: new URL("/__test__/workspace.js", page.url()).href });
}

/** Seed at the database boundary, while real browser keys sign the actual Directory protocol. */
export async function seedWorkspaceContent(w: Workspace, page: Page, markdown: string, legacy = false) {
  let plaintext: Uint8Array | { markdown: string; metadata: Uint8Array } = { markdown, metadata: new Uint8Array() };
  if (legacy) {
    const magic = new TextEncoder().encode("mdwn/file-representation/v1\0");
    const bytes = new TextEncoder().encode(markdown);
    const encoded = new Uint8Array(magic.length + 8 + bytes.length);
    encoded.set(magic); new DataView(encoded.buffer).setUint32(magic.length, bytes.length);
    encoded.set(bytes, magic.length + 4); plaintext = encoded;
  }
  const file = await createFileRepresentation(w.rootKey, plaintext, { vaultId: w.accountId, fileId: w.fileId });
  const writer = await createSymmetricWriter(w.rootKey);
  const context = { purpose: "directory-metadata" as const, vaultId: w.accountId, objectId: w.fileId,
    keyId: w.rootId, keyEpoch: 1, revision: 1 };
  const entry = { nodeId: w.fileId, kind: "file" as const,
    nameCiphertext: encodeTreeBytes(await writer.seal(new TextEncoder().encode("Draft.md"), context)),
    orderCiphertext: encodeTreeBytes(await writer.seal(new TextEncoder().encode("first"), context)),
    keyEnvelope: encodeTreeBytes(file.fileContentKeyEnvelope) };
  // Fixture code is loaded only by the browser harness, never exposed by a production endpoint.
  const head = await page.evaluate(async ({ accountId, rootId, rootKey, entry }) => {
    const device = await window.workspaceFixture.getDevice(accountId);
    if (!device) throw new Error("Missing fixture device");
    return { ...(await window.workspaceFixture.createListingHead(Uint8Array.from(rootKey), device.assertionKeyPair.privateKey, {
      vaultId: accountId, directoryId: rootId, deviceId: device.deviceId, revision: 2, entries: [entry],
    })), deviceId: device.deviceId };
  }, { accountId: w.accountId, rootId: w.rootId, rootKey: Array.from(w.rootKey), entry });
  const decode = (s: string) => Uint8Array.from(Buffer.from(s, "base64url"));
  const reprId = objectId();
  await w.db.batch([
    w.db.prepare("INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at) VALUES (?, 'file', ?, ?, 1, 1)").bind(w.fileId, w.accountId, w.rootId),
    w.db.prepare("INSERT INTO files (node_id, owner_id, current_representation_id, current_revision) VALUES (?, ?, ?, 1)").bind(w.fileId, w.accountId, reprId),
    w.db.prepare("INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id, key_epoch, ciphertext, ciphertext_size, created_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?, 1)").bind(reprId, w.fileId, w.accountId, w.fileId, file.contentEnvelope, file.contentEnvelope.length),
    w.db.prepare("INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id, name_ciphertext, order_ciphertext, key_envelope) VALUES (?, ?, ?, ?, ?, ?)").bind(w.fileId, w.accountId, w.rootId, decode(entry.nameCiphertext), decode(entry.orderCiphertext), decode(entry.keyEnvelope)),
    w.db.prepare("UPDATE directories SET entries_revision = 2, listing_ciphertext = ?, listing_digest = ?, listing_signature = ?, listing_device_id = ? WHERE node_id = ?").bind(decode(head.ciphertext), decode(head.digest), decode(head.signature), head.deviceId, w.rootId),
  ]);
}
