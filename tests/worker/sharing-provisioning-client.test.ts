import { describe, expect, it } from "vitest";

import { inspectEnvelope, openForRecipient, sealToRecipient } from "../../app/crypto/enc-v1";
import { HPKE_SUITE } from "../../app/crypto/enc-v1/format";
import type { StoredDevice } from "../../app/device/store";
import { digestBytes, hex, signOffer, type Offer } from "../../app/sharing/offer";
import { prepareDirectFileProvisioning } from "../../app/sharing/provisioning-client";
import { assertFileHeadCommitTransition, verifyFileHead } from "../../app/tree/file-head";
import { signFileHead } from "../../app/tree/file-head";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/tree/wire";
import type { FileProvisioningBootstrap } from "../../app/sharing/provisioning-wire";

const id = (value: number) => `018f0000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
const randomDigest = () => crypto.getRandomValues(new Uint8Array(32));
const jsonClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function fixture(options: { registryEpoch?: number; retainedPurpose?: "grant" | "file-content-key";
  signedPublicKeyDigest?: Uint8Array } = {}) {
  const ownerId = id(1), ownerSignerId = id(2), accountId = id(3), deviceId = id(4);
  const grantId = id(5), fileId = id(6), contentKeyId = id(7), receivingKeyId = id(8);
  const representationId = id(9), otherAccountId = id(10), otherDeviceId = id(11), otherGrantId = id(12);
  const localTransport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const localAssertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const otherTransport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const ownerAssertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const localPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", localTransport.publicKey));
  const otherPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", otherTransport.publicKey));
  const ownerPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", ownerAssertion.publicKey));
  const device: StoredDevice = { accountId, deviceId, registryEpoch: options.registryEpoch ?? 2,
    transportKeyPair: localTransport, assertionKeyPair: localAssertion };
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const retainedContext = { purpose: options.retainedPurpose ?? "grant" as const, vaultId: ownerId,
    objectId: fileId, keyId: contentKeyId, keyEpoch: 1, revision: 7, recipientId: deviceId };
  const retainedCiphertext = await sealToRecipient(contentKey, localTransport.publicKey, retainedContext);
  const retainedDigest = await digestBytes(retainedCiphertext);
  const localPublicKeyDigest = await digestBytes(localPublicKey);
  const offer: Offer = { shareId: id(13), grantId, ownerId, recipientId: accountId, targetId: fileId,
    kind: "file", permission: "read_only", materialRevision: 1, targetKeyId: contentKeyId,
    targetEpoch: 1, contentRevision: 7, headDigest: hex(randomDigest()), labelId: id(14),
    ownerCopyDigest: hex(randomDigest()), registryEpoch: 1,
    devices: [{ accountId, deviceId, registryEpoch: 1,
      publicKeyDigest: hex(options.signedPublicKeyDigest ?? localPublicKeyDigest),
      contentDigest: hex(retainedDigest), labelDigest: hex(randomDigest()) }],
    candidateDigest: hex(randomDigest()), signerDeviceId: ownerSignerId };
  const signedOffer = await signOffer(offer, ownerAssertion.privateKey);
  const oldRecipientEnvelopeDigest = retainedDigest;
  const oldHead = await signFileHead({ ownerId, vaultId: ownerId, fileId, revision: 7,
    contentKey: { id: contentKeyId, epoch: 1 },
    receivingKey: { id: receivingKeyId, epoch: 1, publicKeyDigest: randomDigest() },
    representation: { id: representationId, digest: randomDigest() },
    parentEnvelopeDigest: randomDigest(), recipientSetVersion: 2,
    recipients: [{ accountId, deviceId, registryEpoch: 1, publicKeyDigest: localPublicKeyDigest,
      grants: [{ id: grantId, generation: 1 }], envelopeDigest: oldRecipientEnvelopeDigest }],
    publication: { status: "none" }, signerDeviceId: ownerSignerId }, ownerAssertion.privateKey);
  const ownerHead: FileProvisioningBootstrap["currentHead"] = { bytes: encodeTreeBytes(oldHead.bytes),
    digest: encodeTreeBytes(oldHead.digest), signature: encodeTreeBytes(oldHead.signature),
    signerDeviceId: ownerSignerId, signerPublicKey: encodeTreeBytes(ownerPublicKey) };
  const bootstrap: FileProvisioningBootstrap = { ownerId, fileId, currentHead: ownerHead,
    recipients: [
      { accountId, deviceId, registryEpoch: options.registryEpoch ?? 2,
        publicKey: encodeTreeBytes(localPublicKey), grants: [{ id: grantId, generation: 1 }] },
      { accountId: otherAccountId, deviceId: otherDeviceId, registryEpoch: 3,
        publicKey: encodeTreeBytes(otherPublicKey), grants: [{ id: otherGrantId, generation: 4 }] },
    ],
    retained: { ciphertext: encodeTreeBytes(retainedCiphertext), digest: encodeTreeBytes(retainedDigest),
      contentKeyId, contentEpoch: 1, revision: 7,
      provenance: { grantId, offerBytes: encodeTreeBytes(signedOffer.bytes),
        offerDigest: encodeTreeBytes(signedOffer.digest), offerSignature: encodeTreeBytes(signedOffer.signature),
        signerDeviceId: ownerSignerId, signerPublicKey: encodeTreeBytes(ownerPublicKey) } } };
  const currentHead = await verifyFileHead(oldHead, { ownerId, vaultId: ownerId, fileId,
    signerDeviceId: ownerSignerId, publicKey: ownerPublicKey, revision: 7 });
  return { bootstrap, device, contentKey, currentHead, localTransport, localPublicKey,
    otherTransport, otherPublicKey, ids: { ownerId, ownerSignerId, accountId, deviceId, grantId,
      fileId, contentKeyId, receivingKeyId, representationId, otherAccountId, otherDeviceId, otherGrantId } };
}

describe("direct File provisioning preparation", () => {
  it("verifies historical provenance and prepares a same-revision update for every current recipient", async () => {
    const current = await fixture({ registryEpoch: 2 });
    const { bootstrap, device, contentKey, currentHead, localTransport, localPublicKey,
      otherTransport, otherPublicKey, ids } = current;

    expect(device.transportKeyPair.privateKey.extractable).toBe(false);
    const completion = await prepareDirectFileProvisioning(bootstrap, device);
    const nextHead = await verifyFileHead({
      bytes: decodeTreeBytes(completion.signedHead.bytes, 131072),
      digest: decodeTreeBytes(completion.signedHead.digest, 32),
      signature: decodeTreeBytes(completion.signedHead.signature, 64),
    }, { ownerId: ids.ownerId, vaultId: ids.ownerId, fileId: ids.fileId,
      signerDeviceId: ids.deviceId,
      publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", device.assertionKeyPair.publicKey)),
      revision: 7 });

    assertFileHeadCommitTransition(currentHead, nextHead,
      { expectedSameRevisionTransition: "recipient-set-update" });
    expect(completion.expectedHeadDigest).toBe(bootstrap.currentHead.digest);
    expect(completion.expectedRevision).toBe(7);
    expect(completion.expectedRecipientSetVersion).toBe(2);
    expect(nextHead.statement.recipientSetVersion).toBe(3);
    expect(nextHead.statement.contentKey).toEqual(currentHead.statement.contentKey);
    expect(nextHead.statement.receivingKey).toEqual(currentHead.statement.receivingKey);
    expect(nextHead.statement.representation).toEqual(currentHead.statement.representation);
    expect(nextHead.statement.parentEnvelopeDigest).toEqual(currentHead.statement.parentEnvelopeDigest);
    expect(nextHead.statement.publication).toEqual(currentHead.statement.publication);
    expect(nextHead.statement.recipients.map((item) => item.deviceId).sort())
      .toEqual([ids.deviceId, ids.otherDeviceId].sort());
    expect(completion.recipientEnvelopes.map((item) => item.deviceId).sort())
      .toEqual([ids.deviceId, ids.otherDeviceId].sort());
    expect(Object.keys(completion).sort()).toEqual([
      "expectedHeadDigest", "expectedRecipientSetVersion", "expectedRevision", "recipientEnvelopes", "signedHead",
    ]);

    for (const { deviceId, accountId, publicKey, transport } of [
      { deviceId: ids.deviceId, accountId: ids.accountId, publicKey: localPublicKey, transport: localTransport },
      { deviceId: ids.otherDeviceId, accountId: ids.otherAccountId, publicKey: otherPublicKey, transport: otherTransport },
    ]) {
      const ciphertext = decodeTreeBytes(completion.recipientEnvelopes.find((item) => item.deviceId === deviceId)!.ciphertext, 16384);
      const envelope = inspectEnvelope(ciphertext);
      expect(envelope.suite).toBe(HPKE_SUITE);
      expect(envelope.context).toEqual({ purpose: "grant", vaultId: ids.ownerId, objectId: ids.fileId,
        keyId: ids.contentKeyId, keyEpoch: 1, revision: 7, recipientId: deviceId });
      const opened = await openForRecipient(ciphertext, transport, { context: envelope.context });
      expect(opened).toEqual(contentKey);
      opened.fill(0);
      expect(accountId).toBeTruthy();
    }
  });

  it("rejects a detached Owner offer whose signature is modified", async () => {
    const current = await fixture();
    const tampered = jsonClone(current.bootstrap);
    const signature = decodeTreeBytes(tampered.retained.provenance.offerSignature, 64);
    signature[0] ^= 1;
    tampered.retained.provenance.offerSignature = encodeTreeBytes(signature);

    await expect(prepareDirectFileProvisioning(tampered, current.device)).rejects.toThrow();
  });
});
