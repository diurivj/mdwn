import { describe, expect, it } from "vitest";
import { inspectEnvelope, openSymmetric } from "../app/crypto/enc-v1";
import { createFileReceivingKey, createFileSave, openFileContentKeyFromDevice,
  openFileContentKeyFromReceiving, openFileReceivingKey } from "../app/crypto/file-receiving";
import { decodeFileRepresentation } from "../app/crypto/vault";
import { cases } from "./support/file-receiving-contract";

const directoryKey = new Uint8Array(32).fill(7);
const parameters = { vaultId: "owner-1", fileId: "file-a", receivingKeyId: "receiving-a", receivingEpoch: 1, wrapRevision: 2 };

describe("File receiving key", () => {
  for (const contract of cases) it(contract.name, contract.run);
  it("creates a distinct purpose-20 pair per File and opens only under its Directory capability", async () => {
    const first = await createFileReceivingKey(directoryKey, parameters);
    const second = await createFileReceivingKey(directoryKey, { ...parameters, fileId: "file-b", receivingKeyId: "receiving-b" });
    expect(first.publicKey).not.toEqual(second.publicKey);
    expect(first.keyPair.privateKey.extractable).toBe(false);
    expect(first.privateKeyEnvelope[13]).toBe(20); // appended purpose; the v1 framing and prior IDs stay fixed.
    expect(inspectEnvelope(first.privateKeyEnvelope)).toMatchObject({
      suite: "AES-256-GCM/HKDF-SHA-256",
      context: { purpose: "file-receiving-key", objectId: "file-a", keyId: "receiving-a", keyEpoch: 1, revision: 2 },
    });
    const opened = await openFileReceivingKey(first.privateKeyEnvelope, directoryKey, { ...parameters, publicKey: first.publicKey });
    expect(opened.privateKey.extractable).toBe(false);
    await expect(openFileReceivingKey(first.privateKeyEnvelope, new Uint8Array(32).fill(3),
      { ...parameters, publicKey: first.publicKey })).rejects.toMatchObject({ code: "authentication-failed" });
    await expect(openFileReceivingKey(first.privateKeyEnvelope, directoryKey,
      { ...parameters, fileId: "file-b", publicKey: first.publicKey })).rejects.toMatchObject({ code: "context-mismatch" });
    await expect(openFileReceivingKey(first.privateKeyEnvelope, directoryKey,
      { ...parameters, receivingEpoch: 2, publicKey: first.publicKey })).rejects.toMatchObject({ code: "stale-epoch" });
    await expect(openFileReceivingKey(first.privateKeyEnvelope, directoryKey,
      { ...parameters, publicKey: second.publicKey })).rejects.toMatchObject({ code: "authentication-failed" });
    const changedPurpose = first.privateKeyEnvelope.slice();
    changedPurpose[13] = 2; // purpose 20 to 2 is never a decoder fallback.
    await expect(openFileReceivingKey(changedPurpose, directoryKey,
      { ...parameters, publicKey: first.publicKey })).rejects.toMatchObject({ code: "context-mismatch" });
  });

  it("lets Directory and direct-device readers open two fresh, independent saves without the parent at save time", async () => {
    const receiving = await createFileReceivingKey(directoryKey, parameters);
    const opened = await openFileReceivingKey(receiving.privateKeyEnvelope, directoryKey, receiving);
    const device = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const target = { vaultId: receiving.vaultId, fileId: receiving.fileId, receivingKeyId: receiving.receivingKeyId,
      receivingEpoch: receiving.receivingEpoch, publicKeyDigest: receiving.publicKeyDigest };
    let previous: Uint8Array | undefined;
    for (const revision of [2, 3]) {
      const identity = { vaultId: "owner-1", fileId: "file-a", contentKeyId: `content-${revision}`,
        contentEpoch: revision + 7, revision };
      const save = await createFileSave({ markdown: `# Save ${revision}`, metadata: new Uint8Array() },
        receiving.publicKey, target, identity, [{ deviceId: "device-1", publicKey: device.publicKey }]);
      expect(save.fileContentKey).toHaveLength(32);
      expect(save.fileContentKey).not.toEqual(previous);
      previous = save.fileContentKey;
      const directoryFileKey = await openFileContentKeyFromReceiving(save.parentEnvelope, opened,
        { ...identity, receivingKeyId: receiving.receivingKeyId });
      const deviceFileKey = await openFileContentKeyFromDevice(save.recipientEnvelopes[0].envelope, device,
        { ...identity, deviceId: "device-1" });
      expect(directoryFileKey).toEqual(deviceFileKey);
      expect(decodeFileRepresentation(await openSymmetric(save.contentEnvelope, directoryFileKey,
        { context: save.contentContext })).markdown).toBe(`# Save ${revision}`);
      await expect(openFileContentKeyFromDevice(save.recipientEnvelopes[0].envelope, device,
        { ...identity, deviceId: "other-device" })).rejects.toMatchObject({ code: "context-mismatch" });
      await expect(openFileContentKeyFromReceiving(save.parentEnvelope, opened,
        { ...identity, receivingKeyId: receiving.receivingKeyId, contentEpoch: identity.contentEpoch + 1 }))
        .rejects.toMatchObject({ code: "stale-epoch" });
    }
    const other = await createFileReceivingKey(directoryKey, { ...parameters, fileId: "other-file", receivingKeyId: "other-key" });
    await expect(createFileSave({ markdown: "# forged", metadata: new Uint8Array() }, other.publicKey,
      target, { vaultId: "owner-1", fileId: "file-a", contentKeyId: "fresh", contentEpoch: 10, revision: 4 }, []))
      .rejects.toMatchObject({ code: "context-mismatch" });
  });

  it("snapshots a File save's mutable representation, target, and recipient list before awaiting", async () => {
    const receiving = await createFileReceivingKey(directoryKey, parameters);
    const device = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const metadata = new Uint8Array([1, 2, 3]);
    const targetBytes = receiving.publicKey.slice();
    const target = { vaultId: receiving.vaultId, fileId: receiving.fileId, receivingKeyId: receiving.receivingKeyId,
      receivingEpoch: receiving.receivingEpoch, publicKeyDigest: receiving.publicKeyDigest.slice() };
    const identity = { vaultId: "owner-1", fileId: "file-a", contentKeyId: "content-2", contentEpoch: 2, revision: 3 };
    const recipients = [{ deviceId: "device-1", publicKey: device.publicKey }];
    const pending = createFileSave({ markdown: "# Before", metadata }, targetBytes, target, identity, recipients);
    metadata.fill(0); targetBytes.fill(0); target.publicKeyDigest.fill(0);
    identity.fileId = "wrong-file"; recipients[0].deviceId = "wrong-device";
    const saved = await pending;
    const opened = await openFileContentKeyFromDevice(saved.recipientEnvelopes[0].envelope, device,
      { vaultId: "owner-1", fileId: "file-a", contentKeyId: "content-2", contentEpoch: 2, revision: 3, deviceId: "device-1" });
    expect(decodeFileRepresentation(await openSymmetric(saved.contentEnvelope, opened,
      { context: saved.contentContext }))).toEqual({ markdown: "# Before", metadata: new Uint8Array([1, 2, 3]) });
  });
});
