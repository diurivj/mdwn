import type { Page } from "@playwright/test";
import type { TestHarness } from "wrangler";

import { createSymmetricWriter, digestEnvelope } from "../app/crypto/enc-v1";
import { createFileRepresentation, encodeFileRepresentation, openRecoveryCapsule,
  openVaultRecoveryEnvelope } from "../app/crypto/vault";
import { decodeBytes, encodeBytes } from "../app/signup/protocol";
import { signDeviceBytes } from "./editor-fixture-crypto";

function id(): string {
  const value = crypto.randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

type Seed = { server: TestHarness; page: Page; accountId: string; deviceId: string;
  rootId: string; phrase: string };

/** Recreate a pre-limit v1 encrypted File *as a legacy entry*, not by rewriting a v2
 * pointer. The v2 structural listing commits the complete legacy key envelope. All
 * graph FKs, signed-head provenance and immutability triggers stay enabled. */
export async function seedLegacyFile({ server, page, accountId, deviceId, rootId, phrase }: Seed,
  { name, source }: { name: string; source: string }): Promise<{ fileId: string; entriesRevision: number }> {
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
  const parent = await db.prepare(`SELECT entries_revision AS revision, listing_version AS version FROM directories WHERE node_id = ?`)
    .bind(rootId).first<{ revision: number; version: number }>();
  if (!parent || parent.version !== 2 || parent.revision < 2) throw new Error("expected signed v2 parent listing");
  const fileId = id(), representationId = id(), writer = await createSymmetricWriter(rootKey);
  const metadata = { purpose: "directory-metadata" as const, vaultId: accountId, objectId: fileId,
    keyId: rootId, keyEpoch: 1, revision: 1 };
  const nameCiphertext = await writer.seal(new TextEncoder().encode(name), metadata);
  const orderCiphertext = await writer.seal(new TextEncoder().encode(id()), metadata);
  const markdown = new TextEncoder().encode(source);
  // This format predates the source limit; the public encoder correctly refuses new
  // over-limit source, while the versioned decoder still accepts existing v1 bytes.
  const plain = markdown.length <= 262_144 ? encodeFileRepresentation({ markdown: source,
    metadata: new Uint8Array() }) : (() => {
    const magic = new TextEncoder().encode("mdwn/file-representation/v1\0");
    const bytes = new Uint8Array(magic.length + 4 + markdown.length + 4);
    bytes.set(magic);
    new DataView(bytes.buffer).setUint32(magic.length, markdown.length);
    bytes.set(markdown, magic.length + 4);
    return bytes;
  })();
  const fresh = await createFileRepresentation(rootKey, plain,
    { vaultId: accountId, fileId, keyId: fileId, keyEpoch: 1, revision: 1 });
  const entry = { nodeId: fileId, kind: "file" as const, encoding: "legacy-file",
    nameCiphertext: encodeBytes(nameCiphertext), orderCiphertext: encodeBytes(orderCiphertext),
    keyEnvelope: encodeBytes(fresh.fileContentKeyEnvelope) };
  const existing = await db.prepare(`SELECT e.child_node_id AS nodeId, n.kind AS kind, e.encoding AS encoding,
    e.name_ciphertext AS nameCiphertext, e.order_ciphertext AS orderCiphertext,
    e.key_envelope AS keyEnvelope, e.receiving_key_id AS receivingKeyId,
    e.receiving_epoch AS receivingEpoch, e.wrap_revision AS wrapRevision
    FROM directory_entries e JOIN vault_nodes n ON n.id = e.child_node_id WHERE e.parent_node_id = ?`)
    .bind(rootId).all<{ nodeId: string; kind: "file" | "directory"; encoding: "directory" | "legacy-file" | "receiving-file";
      nameCiphertext: ArrayBuffer; orderCiphertext: ArrayBuffer; keyEnvelope: ArrayBuffer;
      receivingKeyId: string | null; receivingEpoch: number | null; wrapRevision: number | null }>();
  const entries = [...existing.results.map((r) => ({ nodeId: r.nodeId, kind: r.kind, encoding: r.encoding,
    nameCiphertext: encodeBytes(new Uint8Array(r.nameCiphertext)),
    orderCiphertext: encodeBytes(new Uint8Array(r.orderCiphertext)),
    keyEnvelope: encodeBytes(new Uint8Array(r.keyEnvelope)), receivingKeyId: r.receivingKeyId,
    receivingEpoch: r.receivingEpoch, wrapRevision: r.wrapRevision })),
  { ...entry, receivingKeyId: null, receivingEpoch: null, wrapRevision: null }];
  const encoder = new TextEncoder();
  const committed = await Promise.all(entries.sort((a, b) => a.nodeId.localeCompare(b.nodeId)).map(async (r) => {
    const value = r.encoding === "receiving-file" ? [r.kind, r.encoding, r.nameCiphertext,
      r.orderCiphertext, r.keyEnvelope, r.receivingKeyId, r.receivingEpoch, r.wrapRevision] :
      [r.encoding, r.kind, r.nameCiphertext, r.orderCiphertext, r.keyEnvelope];
    return [r.nodeId, encodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256",
      encoder.encode(JSON.stringify(value)))))];
  }));
  const revision = parent.revision + 1;
  const ciphertext = await writer.seal(encoder.encode(JSON.stringify(committed)), {
    purpose: "directory-metadata", vaultId: accountId, objectId: rootId, keyId: rootId,
    keyEpoch: 1, revision,
  });
  const digest = encodeBytes(await digestEnvelope(ciphertext));
  const signature = await signDeviceBytes(page, accountId, encoder.encode(JSON.stringify([
    "mdwn/directory-listing/v2", accountId, rootId, deviceId, revision, digest,
  ])));
  const now = Date.now();
  await db.batch([
    db.prepare(`INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at)
      VALUES (?, 'file', ?, ?, ?, ?)`).bind(fileId, accountId, rootId, now, now),
    db.prepare(`INSERT INTO files (node_id, owner_id, current_representation_id, current_revision)
      VALUES (?, ?, ?, 1)`).bind(fileId, accountId, representationId),
    db.prepare(`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id,
      key_epoch, ciphertext, ciphertext_size, created_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?, ?)`)
      .bind(representationId, fileId, accountId, fileId, fresh.contentEnvelope,
        fresh.contentEnvelope.length, now),
    db.prepare(`INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id,
      name_ciphertext, order_ciphertext, key_envelope, encoding)
      VALUES (?, ?, ?, ?, ?, ?, 'legacy-file')`).bind(fileId, accountId, rootId,
        nameCiphertext, orderCiphertext, fresh.fileContentKeyEnvelope),
    db.prepare(`UPDATE directories SET entries_revision = ?, listing_ciphertext = ?, listing_digest = ?,
      listing_signature = ?, listing_device_id = ? WHERE node_id = ?`)
      .bind(revision, ciphertext, decodeBytes(digest), signature, deviceId, rootId),
  ]);
  return { fileId, entriesRevision: revision };
}

export async function seedLegacyOversizedFile(seed: Seed): Promise<{ fileId: string; source: string }> {
  const source = "a".repeat(262_146); // Exactly two bytes over the current source limit.
  const { fileId } = await seedLegacyFile(seed, { name: "Legacy.md", source });
  return { fileId, source };
}
