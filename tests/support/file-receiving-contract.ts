// The same public-API exercise runs in Node, workerd, and actual browsers.
import { EnvelopeError, inspectEnvelope, openSymmetric, type EnvelopeErrorCode } from "../../app/crypto/enc-v1";
import { createFileReceivingKey, createFileSave, openFileContentKeyFromDevice,
  openFileContentKeyFromReceiving, openFileReceivingKey, rewrapFileReceivingKey } from "../../app/crypto/file-receiving";
import { decodeFileRepresentation } from "../../app/crypto/vault";

async function rejectsWith(pending: Promise<unknown>, code: EnvelopeErrorCode): Promise<void> {
  try { await pending; }
  catch (error) {
    if (error instanceof EnvelopeError && error.code === code) return;
    throw new Error(`Expected ${code}, got ${error instanceof EnvelopeError ? error.code : String(error)}`);
  }
  throw new Error(`Expected ${code} rejection`);
}

export const cases = [{
  name: "purpose-20 receiving pair and two direct/Directory saves cross engines",
  async run() {
    const directory = crypto.getRandomValues(new Uint8Array(32));
    const receiving = await createFileReceivingKey(directory, {
      vaultId: "owner-cross-engine", fileId: "file-cross-engine", receivingKeyId: "target-cross-engine",
      receivingEpoch: 2, wrapRevision: 4,
    });
    if (receiving.keyPair.privateKey.extractable || inspectEnvelope(receiving.privateKeyEnvelope).context.purpose !== "file-receiving-key") {
      throw new Error("Receiving wrapper or key type mismatch");
    }
    const reopened = await openFileReceivingKey(receiving.privateKeyEnvelope, directory, receiving);
    const device = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    let lastKey: Uint8Array | undefined;
    for (const revision of [5, 6]) {
      const identity = { vaultId: receiving.vaultId, fileId: receiving.fileId,
        contentKeyId: `content-${revision}`, contentEpoch: revision + 4, revision };
      const save = await createFileSave({ markdown: `# Saved ${revision}`, metadata: new Uint8Array() }, receiving.publicKey,
        { vaultId: receiving.vaultId, fileId: receiving.fileId, receivingKeyId: receiving.receivingKeyId,
          receivingEpoch: receiving.receivingEpoch, publicKeyDigest: receiving.publicKeyDigest },
        identity, [{ deviceId: "recipient-device", publicKey: device.publicKey }]);
      const directoryKey = await openFileContentKeyFromReceiving(save.parentEnvelope, reopened,
        { ...identity, receivingKeyId: receiving.receivingKeyId });
      const directKey = await openFileContentKeyFromDevice(save.recipientEnvelopes[0].envelope, device,
        { ...identity, deviceId: "recipient-device" });
      const oldKey = lastKey;
      if (directoryKey.some((value, i) => value !== directKey[i]) ||
          (oldKey !== undefined && directoryKey.every((value, i) => value === oldKey[i]))) {
        throw new Error("Fresh key or recipient parity mismatch");
      }
      lastKey = directoryKey;
      const opened = await openSymmetric(save.contentEnvelope, directKey, { context: save.contentContext });
      if (decodeFileRepresentation(opened).markdown !== `# Saved ${revision}`) throw new Error("Save content mismatch");
    }
  },
}, {
  name: "a safe File move rewraps the same receiving pair for the destination across engines",
  async run() {
    const source = crypto.getRandomValues(new Uint8Array(32));
    const destination = crypto.getRandomValues(new Uint8Array(32));
    const identity = { vaultId: "move-owner", fileId: "moved-file", receivingKeyId: "stable-target",
      receivingEpoch: 2, wrapRevision: 4 };
    const original = await createFileReceivingKey(source, identity);
    const target = { vaultId: identity.vaultId, fileId: identity.fileId,
      receivingKeyId: identity.receivingKeyId, receivingEpoch: identity.receivingEpoch,
      publicKeyDigest: original.publicKeyDigest };
    const before = { vaultId: identity.vaultId, fileId: identity.fileId,
      contentKeyId: "before-move", contentEpoch: 5, revision: 5 };
    const existing = await createFileSave({ markdown: "# Before move", metadata: new Uint8Array() },
      original.publicKey, target, before, []);
    const moved = await rewrapFileReceivingKey(original.privateKeyEnvelope, source, destination,
      { ...identity, publicKey: original.publicKey }, 7);
    const header = inspectEnvelope(moved);
    if (header.suite !== "AES-256-GCM/HKDF-SHA-256" || header.context.purpose !== "file-receiving-key" ||
        header.context.vaultId !== identity.vaultId || header.context.objectId !== identity.fileId ||
        header.context.keyId !== identity.receivingKeyId || header.context.keyEpoch !== identity.receivingEpoch ||
        header.context.revision !== 7) throw new Error("Move changed the receiving identity or context");
    const reopened = await openFileReceivingKey(moved, destination,
      { ...identity, wrapRevision: 7, publicKey: original.publicKey });
    if (reopened.privateKey.extractable) throw new Error("Moved private handle must remain non-extractable");
    const existingKey = await openFileContentKeyFromReceiving(existing.parentEnvelope, reopened,
      { ...before, receivingKeyId: identity.receivingKeyId });
    if (existingKey.some((byte, i) => byte !== existing.fileContentKey[i])) {
      throw new Error("Moved pair cannot open an existing File key");
    }
    const after = { ...before, contentKeyId: "after-move", contentEpoch: 6, revision: 6 };
    const future = await createFileSave({ markdown: "# After move", metadata: new Uint8Array() },
      original.publicKey, target, after, []);
    const futureKey = await openFileContentKeyFromReceiving(future.parentEnvelope, reopened,
      { ...after, receivingKeyId: identity.receivingKeyId });
    if (futureKey.some((byte, i) => byte !== future.fileContentKey[i])) {
      throw new Error("Moved pair cannot open a future File key");
    }
    let rejected = false;
    try {
      await openFileReceivingKey(moved, source, { ...identity, wrapRevision: 7, publicKey: original.publicKey });
    } catch { rejected = true; }
    if (!rejected) throw new Error("Source Directory capability opened destination wrapper");
  },
}, {
  name: "receiving rewrap refuses substituted context, target and invalid revisions across engines",
  async run() {
    const source = crypto.getRandomValues(new Uint8Array(32));
    const destination = crypto.getRandomValues(new Uint8Array(32));
    const identity = { vaultId: "owner", fileId: "file", receivingKeyId: "receiving",
      receivingEpoch: 3, wrapRevision: 4 };
    const current = await createFileReceivingKey(source, identity);
    const different = await createFileReceivingKey(source, { ...identity, fileId: "different-file" });
    const wrap = (envelope: Uint8Array, expected: typeof identity & { publicKey: Uint8Array }, revision = 5) =>
      rewrapFileReceivingKey(envelope, source, destination, expected, revision);
    await rejectsWith(wrap(current.privateKeyEnvelope, { ...identity, vaultId: "wrong-owner", publicKey: current.publicKey }), "context-mismatch");
    await rejectsWith(wrap(current.privateKeyEnvelope, { ...identity, fileId: "wrong-file", publicKey: current.publicKey }), "context-mismatch");
    await rejectsWith(wrap(current.privateKeyEnvelope, { ...identity, receivingKeyId: "wrong-key", publicKey: current.publicKey }), "context-mismatch");
    await rejectsWith(wrap(current.privateKeyEnvelope, { ...identity, receivingEpoch: 4, publicKey: current.publicKey }), "stale-epoch");
    await rejectsWith(wrap(current.privateKeyEnvelope, { ...identity, wrapRevision: 3, publicKey: current.publicKey }), "context-mismatch");
    await rejectsWith(wrap(current.privateKeyEnvelope, { ...identity, publicKey: different.publicKey }), "authentication-failed");
    const wrongPurpose = current.privateKeyEnvelope.slice();
    wrongPurpose[13] = 2;
    await rejectsWith(wrap(wrongPurpose, { ...identity, publicKey: current.publicKey }), "context-mismatch");
    await rejectsWith(wrap(current.privateKeyEnvelope.slice(0, -1), { ...identity, publicKey: current.publicKey }), "malformed");
    await rejectsWith(wrap(current.privateKeyEnvelope, current, 4), "context-mismatch");
    await rejectsWith(wrap(current.privateKeyEnvelope, current, Number.MAX_SAFE_INTEGER + 1), "malformed");
  },
}];
