import { test, expect } from "./fixtures";
import { openEditor } from "./editor-workspace.fixture";
import { createSymmetricWriter, digestEnvelope } from "../app/crypto/enc-v1";
import { createFileRepresentation, openRecoveryCapsule, openVaultRecoveryEnvelope } from "../app/crypto/vault";
import { decodeBytes as decodeTreeBytes, encodeBytes as encodeTreeBytes } from "../app/signup/protocol";

test.setTimeout(180_000);
const id = () => { const u = crypto.randomUUID(); return `${u.slice(0, 14)}7${u.slice(15)}`; };
const encoded = (data: ArrayBuffer | Uint8Array) => encodeTreeBytes(new Uint8Array(data));

test("a trusted mixed v2 listing upgrades a legacy File on the owned browser's first edit", async ({ browser, server, baseURL }) => {
  const opened = await openEditor(browser, server, baseURL!);
  const { page, context, rootId, accountId, deviceId, phrase } = opened;
  const db = (await server.getWorker<{ DB: D1Database }>().getEnv()).DB;
  try {
    const capsule = await db.prepare(`SELECT generation, recovery_salt, ciphertext, verification_public_key
      FROM recovery_capsules WHERE account_id = ?`).bind(accountId)
      .first<{ generation: number; recovery_salt: ArrayBuffer; ciphertext: ArrayBuffer;
        verification_public_key: ArrayBuffer }>();
    const recovery = await db.prepare(`SELECT ciphertext FROM key_envelopes WHERE account_id = ?
      AND purpose = 'vault-recovery' AND object_id = ?`).bind(accountId, rootId)
      .first<{ ciphertext: ArrayBuffer }>();
    if (!capsule || !recovery) throw new Error("no owned recovery material");
    const root = await openRecoveryCapsule({ accountId, generation: capsule.generation,
      recoverySalt: new Uint8Array(capsule.recovery_salt), capsule: new Uint8Array(capsule.ciphertext),
      recoveryVerificationPublicKey: new Uint8Array(capsule.verification_public_key) }, phrase,
    { accountId, generation: capsule.generation, recoverySalt: new Uint8Array(capsule.recovery_salt) });
    const rootKey = await openVaultRecoveryEnvelope(new Uint8Array(recovery.ciphertext), root.vaultRootKey,
      { purpose: "vault-recovery", vaultId: accountId, objectId: rootId, keyId: rootId,
        keyEpoch: 1, revision: 1 });
    const legacyId = id(), reprId = id();
    const key = await createFileRepresentation(rootKey, { markdown: "legacy current", metadata: new Uint8Array() },
      { vaultId: accountId, fileId: legacyId });
    const writer = await createSymmetricWriter(rootKey);
    const meta = { purpose: "directory-metadata" as const, vaultId: accountId, objectId: legacyId,
      keyId: rootId, keyEpoch: 1, revision: 1 };
    const entry = { nodeId: legacyId, kind: "file" as const, encoding: "legacy-file" as const,
      nameCiphertext: encoded(await writer.seal(new TextEncoder().encode("Old.md"), meta)),
      orderCiphertext: encoded(await writer.seal(new TextEncoder().encode("last"), meta)),
      keyEnvelope: encoded(key.fileContentKeyEnvelope) };
    const old = await db.prepare(`SELECT entries_revision FROM directories WHERE node_id = ?`)
      .bind(rootId).first<{ entries_revision: number }>();
    if (!old) throw new Error("missing parent");
    const existing = await db.prepare(`SELECT e.child_node_id AS node_id, n.kind, e.encoding,
      e.name_ciphertext, e.order_ciphertext, e.key_envelope, e.receiving_key_id, e.receiving_epoch, e.wrap_revision
      FROM directory_entries e JOIN vault_nodes n ON n.id = e.child_node_id WHERE e.parent_node_id = ?`)
      .bind(rootId).all<{ node_id: string; kind: "file" | "directory"; encoding: string;
        name_ciphertext: ArrayBuffer; order_ciphertext: ArrayBuffer; key_envelope: ArrayBuffer;
        receiving_key_id: string | null; receiving_epoch: number | null; wrap_revision: number | null }>();
    const entries = [...existing.results.map((r) => ({ nodeId: r.node_id, kind: r.kind, encoding: r.encoding,
      nameCiphertext: encoded(r.name_ciphertext), orderCiphertext: encoded(r.order_ciphertext),
      keyEnvelope: encoded(r.key_envelope), receivingKeyId: r.receiving_key_id,
      receivingEpoch: r.receiving_epoch, wrapRevision: r.wrap_revision })), entry];
    const bytes = new TextEncoder();
    const committed = await Promise.all(entries.sort((a, b) => a.nodeId.localeCompare(b.nodeId)).map(async (r) => {
      const value = r.encoding === "receiving-file" ? [r.kind, r.encoding, r.nameCiphertext,
        r.orderCiphertext, r.keyEnvelope, r.receivingKeyId, r.receivingEpoch, r.wrapRevision] :
        [r.encoding, r.kind, r.nameCiphertext, r.orderCiphertext, r.keyEnvelope];
      return [r.nodeId, encoded(new Uint8Array(await crypto.subtle.digest("SHA-256",
        bytes.encode(JSON.stringify(value)))))];
    }));
    const revision = old.entries_revision + 1;
    const ciphertext = await writer.seal(bytes.encode(JSON.stringify(committed)), {
      purpose: "directory-metadata", vaultId: accountId, objectId: rootId, keyId: rootId,
      keyEpoch: 1, revision });
    const digest = encoded(await digestEnvelope(ciphertext));
    const signature = await page.evaluate(async ({ accountId, message }) => {
      const store = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("mdwn-device-store", 3);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const device = await new Promise<{ assertionKeyPair: CryptoKeyPair }>((resolve, reject) => {
          const request = store.transaction("devices", "readonly").objectStore("devices").get(accountId);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return Array.from(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" },
          device.assertionKeyPair.privateKey, new TextEncoder().encode(message))));
      } finally { store.close(); }
    }, { accountId, message: JSON.stringify(["mdwn/directory-listing/v2", accountId, rootId, deviceId, revision, digest]) });
    const now = Date.now();
    await db.batch([
      db.prepare(`INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at)
        VALUES (?, 'file', ?, ?, ?, ?)`).bind(legacyId, accountId, rootId, now, now),
      db.prepare(`INSERT INTO files (node_id, owner_id, current_representation_id, current_revision)
        VALUES (?, ?, ?, 1)`).bind(legacyId, accountId, reprId),
      db.prepare(`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id,
        key_epoch, ciphertext, ciphertext_size, created_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?, ?)`)
        .bind(reprId, legacyId, accountId, legacyId, key.contentEnvelope, key.contentEnvelope.length, now),
      db.prepare(`INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id,
        name_ciphertext, order_ciphertext, key_envelope, encoding)
        VALUES (?, ?, ?, ?, ?, ?, 'legacy-file')`).bind(legacyId, accountId, rootId,
        decodeTreeBytes(entry.nameCiphertext), decodeTreeBytes(entry.orderCiphertext),
        key.fileContentKeyEnvelope),
      db.prepare(`UPDATE directories SET entries_revision = ?, listing_ciphertext = ?, listing_digest = ?,
        listing_signature = ?, listing_device_id = ? WHERE node_id = ?`)
        .bind(revision, ciphertext, decodeTreeBytes(digest, 32),
          new Uint8Array(signature), deviceId, rootId),
    ]);
    await page.goto(new URL(`/f/${legacyId}`, baseURL!).href);
    await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("legacy current");
    await page.getByRole("textbox", { name: "Markdown source" }).fill("migrated and saved");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved", { timeout: 30_000 });
    expect(await db.prepare("SELECT revision FROM file_heads WHERE file_node_id = ?").bind(legacyId).first())
      .toEqual({ revision: 2 });
    expect(await db.prepare("SELECT entries_revision, listing_version FROM directories WHERE node_id = ?")
      .bind(rootId).first()).toEqual({ entries_revision: revision + 1, listing_version: 2 });
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue("migrated and saved");
  } finally { await context.close(); }
});
