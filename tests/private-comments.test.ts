import { describe, expect, it } from "vitest";
import { createPrivateThreadKey, openLegacyPrivateThreadFromDirectory, openPrivateAttribution,
  openPrivateComment, openPrivateThreadForDevice, openPrivateThreadFromFileReceiving,
  sealLegacyPrivateThreadForDirectory, sealPrivateAttribution, sealPrivateComment,
  sealPrivateThreadForDevice, sealPrivateThreadForFileReceiving } from "../app/crypto/private-comments";
import { createSymmetricWriter, inspectEnvelope, sealToRecipient } from "../app/crypto/enc-v1";
import { createFileReceivingKey, openFileReceivingKey } from "../app/crypto/file-receiving";
import { cases } from "./support/private-comments-contract";

const thread = { ownerVaultId: "owner-1", threadId: "private-thread-1", threadKeyId: "thread-key-1", threadEpoch: 3, wrapRevision: 5 };

// This tests the browser-facing crypto seam, not authorization by the Worker or Grant registry.
describe("Private Comment crypto", () => {
  for (const contract of cases) it(contract.name, contract.run);
  it("creates independent fresh thread keys and delivers one to a device with purpose/recipient binding", async () => {
    const key = createPrivateThreadKey();
    const second = createPrivateThreadKey();
    expect(key).toHaveLength(32);
    expect(key).not.toEqual(second);
    const device = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const envelope = await sealPrivateThreadForDevice(key, device.publicKey, { ...thread, deviceId: "device-1" });
    expect(await openPrivateThreadForDevice(envelope, device, { ...thread, deviceId: "device-1" })).toEqual(key);
  });

  it("roundtrips literal plain text, 2,000 Unicode scalar values, and rejects oversized plaintext even after decrypt", async () => {
    const key = createPrivateThreadKey();
    const identity = { ownerVaultId: thread.ownerVaultId, commentId: "comment-1", threadKeyId: thread.threadKeyId,
      threadEpoch: thread.threadEpoch, revision: 2 };
    const markup = "<script>alert('x')</script>\n**literal Markdown**\n\uFEFFend";
    expect(await openPrivateComment(await sealPrivateComment(key, markup, identity), key, identity)).toBe(markup);
    for (const text of ["a".repeat(2_000), "😀".repeat(2_000)]) {
      expect(await openPrivateComment(await sealPrivateComment(key, text, identity), key, identity)).toBe(text);
    }
    await expect(sealPrivateComment(key, "😀".repeat(2_001), identity)).rejects.toMatchObject({ code: "malformed" });
    await expect(sealPrivateComment(key, "hi\uD800", identity)).rejects.toMatchObject({ code: "malformed" });
    const forged = await (await createSymmetricWriter(key)).seal(new TextEncoder().encode("a".repeat(2_001)), {
      purpose: "comment-content", vaultId: identity.ownerVaultId, objectId: identity.commentId,
      keyId: identity.threadKeyId, keyEpoch: identity.threadEpoch, revision: identity.revision,
    });
    await expect(openPrivateComment(forged, key, identity)).rejects.toMatchObject({ code: "malformed" });
    const ciphertext = await sealPrivateComment(key, markup, identity);
    for (const wrong of [
      { ...identity, ownerVaultId: "other-owner" }, { ...identity, commentId: "other-comment" },
      { ...identity, threadKeyId: "other-thread-key" }, { ...identity, revision: 3 },
    ]) await expect(openPrivateComment(ciphertext, key, wrong)).rejects.toMatchObject({ code: "context-mismatch" });
    await expect(openPrivateComment(ciphertext, createPrivateThreadKey(), identity))
      .rejects.toMatchObject({ code: "authentication-failed" });
    await expect(openPrivateComment(ciphertext, key, { ...identity, threadEpoch: 4 }))
      .rejects.toMatchObject({ code: "stale-epoch" });
    await expect(openPrivateComment(ciphertext, key, { ...identity, threadEpoch: 2 }))
      .rejects.toMatchObject({ code: "unexpected-epoch" });
    await expect(openPrivateComment(ciphertext, key, { ...identity, revision: 0 }))
      .rejects.toMatchObject({ code: "malformed" });
    await expect(openPrivateComment(new Uint8Array(16_385), key, identity))
      .rejects.toMatchObject({ code: "malformed" });
    const invalidUtf8 = await (await createSymmetricWriter(key)).seal(new Uint8Array([0xff]), {
      purpose: "comment-content", vaultId: identity.ownerVaultId, objectId: identity.commentId,
      keyId: identity.threadKeyId, keyEpoch: identity.threadEpoch, revision: identity.revision,
    });
    await expect(openPrivateComment(invalidUtf8, key, identity)).rejects.toMatchObject({ code: "malformed" });
    const hpkeBody = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const hpkeCiphertext = await sealToRecipient(new TextEncoder().encode(markup), hpkeBody.publicKey, {
      purpose: "comment-content", vaultId: identity.ownerVaultId, objectId: identity.commentId,
      keyId: identity.threadKeyId, keyEpoch: identity.threadEpoch, revision: identity.revision,
      recipientId: "device-1",
    });
    await expect(openPrivateComment(hpkeCiphertext, key, identity))
      .rejects.toMatchObject({ code: "unsupported-suite" });
    const oversizedSupplementary = await (await createSymmetricWriter(key)).seal(new TextEncoder().encode("😀".repeat(2_001)), {
      purpose: "comment-content", vaultId: identity.ownerVaultId, objectId: identity.commentId,
      keyId: identity.threadKeyId, keyEpoch: identity.threadEpoch, revision: identity.revision,
    });
    await expect(openPrivateComment(oversizedSupplementary, key, identity))
      .rejects.toMatchObject({ code: "malformed" });
  });

  it("encrypts the caller's decrypted Account-profile Public pseudonym as a declaration, not author proof", async () => {
    const key = createPrivateThreadKey();
    const identity = { ownerVaultId: thread.ownerVaultId, attributionId: "attribution-1",
      threadKeyId: thread.threadKeyId, threadEpoch: thread.threadEpoch, revision: 2 };
    const profile = { publicPseudonym: "Member 🦊" };
    const envelope = await sealPrivateAttribution(key, profile, identity);
    expect(await openPrivateAttribution(envelope, key, identity)).toBe(profile.publicPseudonym);
    await expect(openPrivateAttribution(envelope, key, { ...identity, attributionId: "other" }))
      .rejects.toMatchObject({ code: "context-mismatch" });
    await expect(sealPrivateAttribution(key, { publicPseudonym: "broken\uD800" }, identity))
      .rejects.toMatchObject({ code: "malformed" });
    const invalidUtf8 = await (await createSymmetricWriter(key)).seal(new Uint8Array([0xff]), {
      purpose: "attribution", vaultId: identity.ownerVaultId, objectId: identity.attributionId,
      keyId: identity.threadKeyId, keyEpoch: identity.threadEpoch, revision: identity.revision,
    });
    await expect(openPrivateAttribution(invalidUtf8, key, identity)).rejects.toMatchObject({ code: "malformed" });
    await expect(sealPrivateAttribution(key, { publicPseudonym: "a".repeat(4_000) }, identity))
      .rejects.toMatchObject({ code: "malformed" }); // plaintext fits; envelope does not.
    await expect(openPrivateAttribution(new Uint8Array(4_097), key, identity))
      .rejects.toMatchObject({ code: "malformed" });
    await expect(openPrivateAttribution(envelope, key, { ...identity, revision: 3 }))
      .rejects.toMatchObject({ code: "context-mismatch" });
    const crossPurpose = await (await createSymmetricWriter(key)).seal(new TextEncoder().encode("Member 🦊"), {
      purpose: "comment-content", vaultId: identity.ownerVaultId, objectId: identity.attributionId,
      keyId: identity.threadKeyId, keyEpoch: identity.threadEpoch, revision: identity.revision,
    });
    await expect(openPrivateAttribution(crossPurpose, key, identity))
      .rejects.toMatchObject({ code: "context-mismatch" });
  });

  it("requires the explicit legacy Directory tag, never falls back from HPKE", async () => {
    const key = createPrivateThreadKey();
    const directory = crypto.getRandomValues(new Uint8Array(32));
    const legacy = await sealLegacyPrivateThreadForDirectory(key, directory, thread);
    expect(legacy.kind).toBe("legacy-directory");
    expect(await openLegacyPrivateThreadFromDirectory(legacy, directory, thread)).toEqual(key);
    await expect(openLegacyPrivateThreadFromDirectory({ ...legacy, kind: "other" as "legacy-directory" }, directory, thread))
      .rejects.toMatchObject({ code: "malformed" });
    const device = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    await expect(openPrivateThreadForDevice(legacy.ciphertext, device, { ...thread, deviceId: "device-1" }))
      .rejects.toMatchObject({ code: "unsupported-suite" });
  });

  it("rejects wrong trusted context, cross-purpose, suite downgrade, malformed key and oversized capability bytes", async () => {
    const key = createPrivateThreadKey();
    const device = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const recipient = { ...thread, deviceId: "device-1" };
    const envelope = await sealPrivateThreadForDevice(key, device.publicKey, recipient);
    expect(inspectEnvelope(envelope)).toMatchObject({ suite: "HPKE-P256/HKDF-SHA-256/AES-256-GCM",
      context: { purpose: "private-comment-thread", vaultId: thread.ownerVaultId, objectId: thread.threadId,
        keyId: thread.threadKeyId, keyEpoch: thread.threadEpoch, revision: thread.wrapRevision, recipientId: "device-1" } });
    for (const expected of [
      { ...recipient, ownerVaultId: "other-owner" }, { ...recipient, threadId: "other-thread" },
      { ...recipient, threadKeyId: "other-key" }, { ...recipient, wrapRevision: 6 },
      { ...recipient, deviceId: "device-2" },
    ]) {
      await expect(openPrivateThreadForDevice(envelope, device, expected))
        .rejects.toMatchObject({ code: "context-mismatch" });
    }
    await expect(openPrivateThreadForDevice(envelope, device, { ...recipient, threadEpoch: 4 }))
      .rejects.toMatchObject({ code: "stale-epoch" });
    await expect(openPrivateThreadForDevice(envelope, device, { ...recipient, threadEpoch: 2 }))
      .rejects.toMatchObject({ code: "unexpected-epoch" });
    await expect(openPrivateThreadForDevice(envelope, device, { ...recipient, threadEpoch: 0 }))
      .rejects.toMatchObject({ code: "malformed" });
    await expect(openPrivateThreadForDevice(envelope, device, { ...recipient, wrapRevision: Number.MAX_SAFE_INTEGER + 1 }))
      .rejects.toMatchObject({ code: "malformed" });
    const alternateDevice = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    await expect(openPrivateThreadForDevice(envelope, alternateDevice, recipient))
      .rejects.toMatchObject({ code: "authentication-failed" });
    const symmetric = await (await createSymmetricWriter(key)).seal(key, {
      purpose: "private-comment-thread", vaultId: thread.ownerVaultId, objectId: thread.threadId,
      keyId: thread.threadKeyId, keyEpoch: thread.threadEpoch, revision: thread.wrapRevision, recipientId: "device-1",
    });
    await expect(openPrivateThreadForDevice(symmetric, device, recipient))
      .rejects.toMatchObject({ code: "unsupported-suite" });
    const wrongPurpose = await sealToRecipient(key, device.publicKey, {
      purpose: "grant", vaultId: thread.ownerVaultId, objectId: thread.threadId,
      keyId: thread.threadKeyId, keyEpoch: thread.threadEpoch, revision: thread.wrapRevision, recipientId: "device-1",
    });
    await expect(openPrivateThreadForDevice(wrongPurpose, device, recipient))
      .rejects.toMatchObject({ code: "context-mismatch" });
    for (const badKey of [new Uint8Array(31), new Uint8Array(33)]) {
      await expect(sealPrivateThreadForDevice(badKey, device.publicKey, recipient))
        .rejects.toMatchObject({ code: "malformed" });
      const wrongLength = await sealToRecipient(badKey, device.publicKey, {
        purpose: "private-comment-thread", vaultId: thread.ownerVaultId, objectId: thread.threadId,
        keyId: thread.threadKeyId, keyEpoch: thread.threadEpoch, revision: thread.wrapRevision, recipientId: "device-1",
      });
      await expect(openPrivateThreadForDevice(wrongLength, device, recipient))
        .rejects.toMatchObject({ code: "malformed" });
    }
    await expect(openPrivateThreadForDevice(new Uint8Array(16_385), device, recipient))
      .rejects.toMatchObject({ code: "malformed" });
  });

  it("snapshots mutable identity, raw target and key bytes before HPKE awaits", async () => {
    const directory = crypto.getRandomValues(new Uint8Array(32));
    const receiving = await createFileReceivingKey(directory, { vaultId: thread.ownerVaultId, fileId: "file-1",
      receivingKeyId: "receiving-1", receivingEpoch: 2, wrapRevision: 2 });
    const pair = await openFileReceivingKey(receiving.privateKeyEnvelope, directory, receiving);
    const target = { vaultId: receiving.vaultId, fileId: receiving.fileId, receivingKeyId: receiving.receivingKeyId,
      receivingEpoch: receiving.receivingEpoch, publicKeyDigest: receiving.publicKeyDigest.slice() };
    const expected = { ...thread, fileId: receiving.fileId, receivingTarget: target,
      receivingPublicKey: receiving.publicKey.slice() };
    const key = createPrivateThreadKey();
    const preserved = key.slice();
    const pending = sealPrivateThreadForFileReceiving(key, expected);
    key.fill(0);
    expected.threadId = "changed-thread";
    expected.receivingPublicKey.fill(0);
    target.publicKeyDigest.fill(0);
    const ciphertext = await pending;
    expect(await openPrivateThreadFromFileReceiving(ciphertext, pair, { ...thread, fileId: receiving.fileId,
      receivingTarget: { ...target, publicKeyDigest: receiving.publicKeyDigest },
      receivingPublicKey: receiving.publicKey })).toEqual(preserved);
  });

  it("delivers the same independent epoch key to a device and the Owner's authenticated File receiving target", async () => {
    const directory = crypto.getRandomValues(new Uint8Array(32));
    const file = await createFileReceivingKey(directory, {
      vaultId: thread.ownerVaultId, fileId: "file-1", receivingKeyId: "receiving-1", receivingEpoch: 2, wrapRevision: 3,
    });
    const target = { vaultId: file.vaultId, fileId: file.fileId, receivingKeyId: file.receivingKeyId,
      receivingEpoch: file.receivingEpoch, publicKeyDigest: file.publicKeyDigest };
    const recipient = { ...thread, fileId: file.fileId, receivingTarget: target, receivingPublicKey: file.publicKey };
    const key = createPrivateThreadKey();
    const envelope = await sealPrivateThreadForFileReceiving(key, recipient);
    const reopened = await openFileReceivingKey(file.privateKeyEnvelope, directory, file);
    expect(await openPrivateThreadFromFileReceiving(envelope, reopened, recipient)).toEqual(key);
    await expect(sealPrivateThreadForFileReceiving(key, { ...recipient, fileId: "other-file" }))
      .rejects.toMatchObject({ code: "context-mismatch" });
    await expect(sealPrivateThreadForFileReceiving(key, { ...recipient, receivingPublicKey: new Uint8Array(65) }))
      .rejects.toMatchObject({ code: "malformed" });
    await expect(sealPrivateThreadForFileReceiving(key, { ...recipient, ownerVaultId: "another-owner" }))
      .rejects.toMatchObject({ code: "context-mismatch" });
    await expect(sealPrivateThreadForFileReceiving(key, { ...recipient,
      receivingTarget: { ...target, publicKeyDigest: new Uint8Array(32) } }))
      .rejects.toMatchObject({ code: "context-mismatch" });
    await expect(openPrivateThreadFromFileReceiving(envelope, reopened,
      { ...recipient, receivingTarget: { ...target, receivingKeyId: "other-target" } }))
      .rejects.toMatchObject({ code: "context-mismatch" });
    const anotherFile = await createFileReceivingKey(directory, { vaultId: thread.ownerVaultId, fileId: "file-2",
      receivingKeyId: "receiving-2", receivingEpoch: 2, wrapRevision: 3 });
    await expect(openPrivateThreadFromFileReceiving(envelope, anotherFile.keyPair, recipient))
      .rejects.toMatchObject({ code: "context-mismatch" });
    await expect(openPrivateThreadFromFileReceiving(new Uint8Array(16_385), reopened, recipient))
      .rejects.toMatchObject({ code: "malformed" });
  });
});
