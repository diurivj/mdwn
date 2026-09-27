import type { Page } from "@playwright/test";
import type { TestHarness } from "wrangler";

import { createSymmetricWriter, digestEnvelope } from "../app/crypto/enc-v1";
import { createFileRepresentation, openRecoveryCapsule, openVaultRecoveryEnvelope } from "../app/crypto/vault";
import { decodeBytes, encodeBytes } from "../app/signup/protocol";

function id(): string {
  const value = crypto.randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

type Seed = { server: TestHarness; page: Page; accountId: string; deviceId: string;
  rootId: string; fileId: string; phrase: string };

/** Seed a pre-limit encrypted representation via migrated local D1 without weakening immutability triggers.
 * Crypto uses public Vault/listing APIs; the non-extractable signing key remains inside the test browser. */
export async function seedLegacyOversizedFile({ server, page, accountId, deviceId, rootId, fileId, phrase }: Seed) {
  const db = (await server.getWorker<{ DB: D1Database }>().getEnv()).DB;
  const capsule = await db.prepare(`SELECT generation, recovery_salt AS salt, ciphertext,
    verification_public_key AS publicKey FROM recovery_capsules WHERE account_id = ?`)
    .bind(accountId).first<{ generation: number; salt: ArrayBuffer; ciphertext: ArrayBuffer; publicKey: ArrayBuffer }>();
  const envelope = await db.prepare(`SELECT ciphertext FROM key_envelopes
    WHERE account_id = ? AND purpose = 'vault-recovery' AND object_id = ?`)
    .bind(accountId, rootId).first<{ ciphertext: ArrayBuffer }>();
  if (!capsule || !envelope) throw new Error("missing signup recovery material");
  const opened = await openRecoveryCapsule({ accountId, generation: capsule.generation,
    recoverySalt: new Uint8Array(capsule.salt), capsule: new Uint8Array(capsule.ciphertext),
    recoveryVerificationPublicKey: new Uint8Array(capsule.publicKey) }, phrase, {
    accountId, generation: capsule.generation, recoverySalt: new Uint8Array(capsule.salt),
  });
  const rootKey = await openVaultRecoveryEnvelope(new Uint8Array(envelope.ciphertext), opened.vaultRootKey,
    { purpose: "vault-recovery", vaultId: accountId, objectId: rootId, keyId: rootId, keyEpoch: 1, revision: 1 });
  const row = await db.prepare(`SELECT f.current_representation_id AS oldId, f.current_revision AS revision,
    d.entries_revision AS entriesRevision FROM files f JOIN directories d ON d.node_id = ?
    WHERE f.node_id = ?`).bind(rootId, fileId)
    .first<{ oldId: string; revision: number; entriesRevision: number }>();
  if (!row) throw new Error("missing File");
  const source = "a".repeat(262_146); // Exactly two bytes over the source limit.
  const markdown = new TextEncoder().encode(source);
  const magic = new TextEncoder().encode("mdwn/file-representation/v1\0");
  const plain = new Uint8Array(magic.length + 4 + markdown.length + 4);
  plain.set(magic);
  new DataView(plain.buffer).setUint32(magic.length, markdown.length);
  plain.set(markdown, magic.length + 4);
  const keyId = id(), representationId = id(), revision = row.revision + 1;
  const fresh = await createFileRepresentation(rootKey, plain,
    { vaultId: accountId, fileId, keyId, keyEpoch: 1, revision });
  const entries = await db.prepare(`SELECT e.child_node_id AS nodeId, n.kind AS kind,
    e.name_ciphertext AS nameCiphertext, e.order_ciphertext AS orderCiphertext,
    e.key_envelope AS keyEnvelope FROM directory_entries e JOIN vault_nodes n ON n.id = e.child_node_id
    WHERE e.parent_node_id = ?`).bind(rootId).all<{
    nodeId: string; kind: "file" | "directory"; nameCiphertext: ArrayBuffer;
    orderCiphertext: ArrayBuffer; keyEnvelope: ArrayBuffer;
  }>();
  const members = entries.results.map((entry) => ({ nodeId: entry.nodeId, kind: entry.kind,
    nameCiphertext: encodeBytes(new Uint8Array(entry.nameCiphertext)),
    orderCiphertext: encodeBytes(new Uint8Array(entry.orderCiphertext)),
    keyEnvelope: entry.nodeId === fileId ? encodeBytes(fresh.fileContentKeyEnvelope)
      : encodeBytes(new Uint8Array(entry.keyEnvelope)) }));
  // The fixture writes the same signed listing format as the browser's public tree protocol.
  const encoder = new TextEncoder();
  const committed = await Promise.all(members.sort((a, b) => a.nodeId.localeCompare(b.nodeId)).map(async (entry) => [
    entry.nodeId, encodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256",
      encoder.encode(JSON.stringify([entry.kind, entry.nameCiphertext, entry.orderCiphertext, entry.keyEnvelope]))))),
  ]));
  const ciphertext = await (await createSymmetricWriter(rootKey)).seal(encoder.encode(JSON.stringify(committed)), {
    purpose: "directory-metadata", vaultId: accountId, objectId: rootId, keyId: rootId,
    keyEpoch: 1, revision: row.entriesRevision + 1,
  });
  const digest = encodeBytes(await digestEnvelope(ciphertext));
  // Sign the public listing protocol message with the real, non-extractable device handle.
  const signature = await page.evaluate(async ({ accountId, message }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("mdwn-device-store", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const device = await new Promise<{ assertionKeyPair: CryptoKeyPair }>((resolve, reject) => {
        const request = db.transaction("devices", "readonly").objectStore("devices").get(accountId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return Array.from(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" },
        device.assertionKeyPair.privateKey, new TextEncoder().encode(message))));
    } finally { db.close(); }
  }, { accountId, message: JSON.stringify(["mdwn/directory-listing/v1", accountId, rootId, deviceId,
    row.entriesRevision + 1, digest]) });
  await db.batch([
    db.prepare(`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id,
      key_epoch, ciphertext, ciphertext_size, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .bind(representationId, fileId, accountId, revision, keyId, fresh.contentEnvelope,
        fresh.contentEnvelope.length, Date.now()),
    db.prepare(`UPDATE directory_entries SET key_envelope = ? WHERE child_node_id = ?`)
      .bind(fresh.fileContentKeyEnvelope, fileId),
    db.prepare(`UPDATE directories SET entries_revision = ?, listing_ciphertext = ?, listing_digest = ?,
      listing_signature = ?, listing_device_id = ? WHERE node_id = ?`)
      .bind(row.entriesRevision + 1, ciphertext, decodeBytes(digest),
        new Uint8Array(signature), deviceId, rootId),
    db.prepare(`UPDATE files SET current_representation_id = ?, current_revision = ? WHERE node_id = ?`)
      .bind(representationId, revision, fileId),
    db.prepare(`DELETE FROM file_representations WHERE id = ?`).bind(row.oldId),
  ]);
  return source;
}
