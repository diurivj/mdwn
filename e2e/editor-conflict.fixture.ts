import type { Page } from "@playwright/test";
import type { TestHarness } from "wrangler";

import { createFileSave } from "../app/crypto/file-receiving";
import { canonicalFileHeadBytes, verifyFileHead, verifyFileParentEnvelope,
  verifyFileReceivingTarget, verifyFileRepresentation } from "../app/tree/file-head";
import { signDeviceBytes } from "./editor-fixture-crypto";

function id(): string {
  const value = crypto.randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

/** Commit a genuine concurrent v2 File revision to migrated local D1. Unlike a
 * Directory rename this advances the File's own signed head and representation.
 * Public crypto verifies both heads; the real browser device signs the new one;
 * the FK graph and the File pointer/head triggers remain enforced. */
export async function commitConcurrentFileRevision({ server, page, accountId, deviceId, fileId, source }: {
  server: TestHarness; page: Page; accountId: string; deviceId: string; fileId: string; source: string;
}): Promise<number> {
  const db = (await server.getWorker<{ DB: D1Database }>().getEnv()).DB;
  const row = await db.prepare(`SELECT f.current_revision AS revision, f.current_representation_id AS oldId,
    h.bytes, h.digest, h.signature, h.signer_device_id AS signerDeviceId,
    h.receiving_public_key AS receivingPublicKey, h.parent_envelope AS parentEnvelope,
    r.ciphertext, d.assertion_public_key AS signerPublicKey
    FROM files f JOIN file_heads h ON h.file_node_id = f.node_id
    JOIN file_representations r ON r.id = f.current_representation_id
    JOIN encryption_devices d ON d.id = h.signer_device_id WHERE f.node_id = ? AND f.owner_id = ?`)
    .bind(fileId, accountId).first<{ revision: number; oldId: string; bytes: ArrayBuffer;
      digest: ArrayBuffer; signature: ArrayBuffer; signerDeviceId: string;
      receivingPublicKey: ArrayBuffer; parentEnvelope: ArrayBuffer; ciphertext: ArrayBuffer;
      signerPublicKey: ArrayBuffer }>();
  if (!row) throw new Error("missing current v2 File");
  const previous = await verifyFileHead({ bytes: new Uint8Array(row.bytes), digest: new Uint8Array(row.digest),
    signature: new Uint8Array(row.signature) }, { ownerId: accountId, vaultId: accountId, fileId,
    signerDeviceId: row.signerDeviceId, publicKey: new Uint8Array(row.signerPublicKey),
    revision: row.revision });
  if (previous.statement.representation.id !== row.oldId || previous.statement.recipients.length ||
      previous.statement.publication.status !== "none") throw new Error("not a current unshared File");
  await verifyFileReceivingTarget(previous, new Uint8Array(row.receivingPublicKey));
  await verifyFileRepresentation(previous, row.oldId, new Uint8Array(row.ciphertext));
  await verifyFileParentEnvelope(previous, new Uint8Array(row.parentEnvelope));
  const old = previous.statement, revision = row.revision + 1, representationId = id();
  const contentKeyId = id();
  const fresh = await createFileSave({ markdown: source, metadata: new Uint8Array() },
    new Uint8Array(row.receivingPublicKey), { vaultId: accountId, fileId,
      receivingKeyId: old.receivingKey.id, receivingEpoch: old.receivingKey.epoch,
      publicKeyDigest: old.receivingKey.publicKeyDigest }, { vaultId: accountId,
      fileId, contentKeyId, contentEpoch: old.contentKey.epoch + 1, revision }, []);
  const digest = async (value: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(value)));
  const bytes = canonicalFileHeadBytes({ ...old, revision,
    contentKey: { id: contentKeyId, epoch: old.contentKey.epoch + 1 },
    representation: { id: representationId, digest: await digest(fresh.contentEnvelope) },
    parentEnvelopeDigest: await digest(fresh.parentEnvelope), signerDeviceId: deviceId });
  const headDigest = await digest(bytes);
  const signature = await signDeviceBytes(page, accountId, bytes);
  await verifyFileHead({ bytes, digest: headDigest, signature }, { ownerId: accountId, vaultId: accountId, fileId,
    signerDeviceId: deviceId, publicKey: new Uint8Array(row.signerPublicKey), revision });
  const results = await db.batch([
    db.prepare(`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id,
      key_epoch, ciphertext, ciphertext_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(representationId, fileId, accountId, revision, contentKeyId, old.contentKey.epoch + 1,
        fresh.contentEnvelope, fresh.contentEnvelope.length, Date.now()),
    db.prepare(`UPDATE file_heads SET bytes = ?, digest = ?, signature = ?, signer_device_id = ?,
      revision = ?, representation_id = ?, content_key_id = ?, content_epoch = ?, parent_envelope = ?
      WHERE file_node_id = ? AND digest = ?`).bind(bytes, headDigest, signature, deviceId,
      revision, representationId, contentKeyId, old.contentKey.epoch + 1, fresh.parentEnvelope,
      fileId, new Uint8Array(row.digest)),
    db.prepare(`UPDATE files SET current_revision = ?, current_representation_id = ?
      WHERE node_id = ? AND current_revision = ? AND current_representation_id = ?`)
      .bind(revision, representationId, fileId, row.revision, row.oldId),
    db.prepare(`DELETE FROM file_representations WHERE id = ?`).bind(row.oldId),
  ]);
  if (results[1]?.meta.changes !== 1 || results[2]?.meta.changes !== 1 || results[3]?.meta.changes !== 1) {
    throw new Error("concurrent File revision was not committed atomically");
  }
  return revision;
}
