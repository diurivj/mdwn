import { describe, expect, it } from "vitest";
import { inspectEnvelope, openSymmetric, sealToRecipient } from "../app/crypto/enc-v1";
import { createFileReceivingKey, createFileSave, openFileContentKeyFromDevice,
  openFileContentKeyFromReceiving, openFileReceivingKey, rewrapFileReceivingKey } from "../app/crypto/file-receiving";
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

  it("rejects mismatched old context, public target, malformed data, and cross-purpose/suite wrappers", async () => {
    const first = await createFileReceivingKey(directoryKey, parameters);
    const other = await createFileReceivingKey(directoryKey, { ...parameters, fileId: "other-file", receivingKeyId: "other-key" });
    const destination = new Uint8Array(32).fill(11);
    const rewrap = (envelope: Uint8Array, expected: typeof parameters & { publicKey: Uint8Array }) =>
      rewrapFileReceivingKey(envelope, directoryKey, destination, expected, 3);
    for (const [expected, code] of [
      [{ ...parameters, vaultId: "another-owner", publicKey: first.publicKey }, "context-mismatch"],
      [{ ...parameters, fileId: "another-file", publicKey: first.publicKey }, "context-mismatch"],
      [{ ...parameters, receivingKeyId: "another-target", publicKey: first.publicKey }, "context-mismatch"],
      [{ ...parameters, receivingEpoch: 2, publicKey: first.publicKey }, "stale-epoch"],
      [{ ...parameters, wrapRevision: 3, publicKey: first.publicKey }, "context-mismatch"],
      [{ ...parameters, wrapRevision: 1, publicKey: first.publicKey }, "context-mismatch"],
      [{ ...parameters, publicKey: other.publicKey }, "authentication-failed"],
    ] as const) {
      await expect(rewrap(first.privateKeyEnvelope, expected)).rejects.toMatchObject({ code });
    }
    await expect(rewrapFileReceivingKey(first.privateKeyEnvelope, new Uint8Array(32).fill(13), destination,
      { ...parameters, publicKey: first.publicKey }, 3)).rejects.toMatchObject({ code: "authentication-failed" });
    const futureEpoch = await createFileReceivingKey(directoryKey, { ...parameters, receivingEpoch: 2 });
    await expect(rewrap(futureEpoch.privateKeyEnvelope, { ...parameters, publicKey: futureEpoch.publicKey }))
      .rejects.toMatchObject({ code: "unexpected-epoch" });
    const truncated = first.privateKeyEnvelope.slice(0, -1);
    await expect(rewrap(truncated, { ...parameters, publicKey: first.publicKey }))
      .rejects.toMatchObject({ code: "malformed" });
    const tampered = first.privateKeyEnvelope.slice();
    tampered[tampered.length - 1] ^= 1;
    await expect(rewrap(tampered, { ...parameters, publicKey: first.publicKey }))
      .rejects.toMatchObject({ code: "authentication-failed" });
    const wrongPurpose = first.privateKeyEnvelope.slice();
    wrongPurpose[13] = 2;
    await expect(rewrap(wrongPurpose, { ...parameters, publicKey: first.publicKey }))
      .rejects.toMatchObject({ code: "context-mismatch" });
    const hpkePurpose20 = await sealToRecipient(new Uint8Array([1, 2]), first.keyPair.publicKey,
      { purpose: "file-receiving-key", vaultId: parameters.vaultId, objectId: parameters.fileId,
        keyId: parameters.receivingKeyId, keyEpoch: parameters.receivingEpoch,
        revision: parameters.wrapRevision, recipientId: parameters.receivingKeyId });
    await expect(rewrap(hpkePurpose20, { ...parameters, publicKey: first.publicKey }))
      .rejects.toMatchObject({ code: "unsupported-suite" });
  });

  it("requires a strictly advancing safe structural wrap revision, not a File-save revision", async () => {
    const first = await createFileReceivingKey(directoryKey, parameters);
    const destination = new Uint8Array(32).fill(11);
    for (const revision of [parameters.wrapRevision, 1]) {
      await expect(rewrapFileReceivingKey(first.privateKeyEnvelope, directoryKey, destination,
        first, revision)).rejects.toMatchObject({ code: "context-mismatch" });
    }
    for (const revision of [0, -1, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(rewrapFileReceivingKey(first.privateKeyEnvelope, directoryKey, destination,
        first, revision)).rejects.toMatchObject({ code: "malformed" });
    }
    const last = await createFileReceivingKey(directoryKey, { ...parameters, wrapRevision: Number.MAX_SAFE_INTEGER });
    await expect(rewrapFileReceivingKey(last.privateKeyEnvelope, directoryKey, destination,
      last, Number.MAX_SAFE_INTEGER + 1)).rejects.toMatchObject({ code: "malformed" });
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

  it("snapshots both Directory keys, wrapper, identity and public target before awaiting", async () => {
    const source = directoryKey.slice();
    const destination = new Uint8Array(32).fill(11);
    const original = await createFileReceivingKey(source, parameters);
    const encrypted = original.privateKeyEnvelope.slice();
    const expected = { ...parameters, publicKey: original.publicKey.slice() };
    const pending = rewrapFileReceivingKey(encrypted, source, destination, expected, 3);
    encrypted.fill(0); source.fill(0); destination.fill(0); expected.publicKey.fill(0);
    expected.vaultId = "wrong-owner"; expected.fileId = "wrong-file";
    expected.receivingKeyId = "wrong-target"; expected.receivingEpoch = 22; expected.wrapRevision = 33;
    const moved = await pending;
    const opened = await openFileReceivingKey(moved, new Uint8Array(32).fill(11),
      { ...parameters, wrapRevision: 3, publicKey: original.publicKey });
    expect(opened.privateKey.extractable).toBe(false);
    await expect(openFileReceivingKey(moved, directoryKey, { ...parameters, wrapRevision: 3, publicKey: original.publicKey }))
      .rejects.toMatchObject({ code: "authentication-failed" });
    // Rewrapping is not revocation: the old wrapper and source key still open the pair.
    const retained = await openFileReceivingKey(original.privateKeyEnvelope, directoryKey, original);
    expect(retained.privateKey.extractable).toBe(false);
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
