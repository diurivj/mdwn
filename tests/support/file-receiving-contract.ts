// The same public-API exercise runs in Node, workerd, and actual browsers.
import { inspectEnvelope, openSymmetric } from "../../app/crypto/enc-v1";
import { createFileReceivingKey, createFileSave, openFileContentKeyFromDevice,
  openFileContentKeyFromReceiving, openFileReceivingKey } from "../../app/crypto/file-receiving";
import { decodeFileRepresentation } from "../../app/crypto/vault";

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
}];
