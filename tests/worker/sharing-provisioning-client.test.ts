import { describe, expect, it } from "vitest";

import { createSymmetricWriter, inspectEnvelope, openForRecipient, sealToRecipient } from "../../app/crypto/enc-v1";
import { HPKE_SUITE } from "../../app/crypto/enc-v1/format";
import type { StoredDevice } from "../../app/device/store";
import { digestBytes, hex, offerBytes, signOffer, type Offer } from "../../app/sharing/offer";
import { prepareDirectFileProvisioning } from "../../app/sharing/provisioning-client";
import { assertFileHeadCommitTransition, signFileHead, verifyFileHead } from "../../app/tree/file-head";
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
    otherTransport, otherPublicKey, ownerAssertion, offer, ids: { ownerId, ownerSignerId, accountId, deviceId, grantId,
      fileId, contentKeyId, receivingKeyId, representationId, otherAccountId, otherDeviceId, otherGrantId } };
}

type ProvisioningFixture = Awaited<ReturnType<typeof fixture>>;

async function installSignedOffer(current: ProvisioningFixture, offer: Offer): Promise<void> {
  const signed = await signOffer(offer, current.ownerAssertion.privateKey);
  current.bootstrap.retained.provenance.offerBytes = encodeTreeBytes(signed.bytes);
  current.bootstrap.retained.provenance.offerDigest = encodeTreeBytes(signed.digest);
  current.bootstrap.retained.provenance.offerSignature = encodeTreeBytes(signed.signature);
}

async function replaceRetainedEnvelope(current: ProvisioningFixture, ciphertext: Uint8Array): Promise<void> {
  const digest = await digestBytes(ciphertext);
  current.bootstrap.retained.ciphertext = encodeTreeBytes(ciphertext);
  current.bootstrap.retained.digest = encodeTreeBytes(digest);
  await installSignedOffer(current, { ...current.offer, devices: current.offer.devices.map((device) =>
    device.deviceId === current.ids.deviceId ? { ...device, contentDigest: hex(digest) } : device) });
}

describe("direct File provisioning preparation", () => {
  it("verifies historical provenance and prepares a same-revision update for every current recipient", async () => {
    const current = await fixture({ registryEpoch: 2 });
    const { bootstrap, device, contentKey, currentHead, localTransport, localPublicKey,
      otherTransport, otherPublicKey, ids } = current;

    expect(device.transportKeyPair.privateKey.extractable).toBe(false);
    expect(current.offer.registryEpoch).toBe(1);
    expect(device.registryEpoch).toBe(2);
    expect(current.bootstrap.retained.provenance.signerDeviceId).toBe(ids.ownerSignerId);
    expect(currentHead.statement.recipients.some((item) => item.deviceId === ids.otherDeviceId)).toBe(false);
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
    expect(nextHead.statement.revision).toBe(7);
    expect(nextHead.statement.signerDeviceId).toBe(ids.deviceId);
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

    for (const { deviceId, accountId, registryEpoch, grants, publicKey } of [
      { deviceId: ids.deviceId, accountId: ids.accountId, registryEpoch: 2,
        grants: [{ id: ids.grantId, generation: 1 }], publicKey: localPublicKey },
      { deviceId: ids.otherDeviceId, accountId: ids.otherAccountId, registryEpoch: 3,
        grants: [{ id: ids.otherGrantId, generation: 4 }], publicKey: otherPublicKey },
    ]) {
      const descriptor = nextHead.statement.recipients.find((item) => item.deviceId === deviceId)!;
      const envelope = decodeTreeBytes(completion.recipientEnvelopes.find((item) => item.deviceId === deviceId)!.ciphertext, 16384);
      expect(descriptor.accountId).toBe(accountId);
      expect(descriptor.registryEpoch).toBe(registryEpoch);
      expect(descriptor.grants).toEqual(grants);
      expect(descriptor.publicKeyDigest).toEqual(await digestBytes(publicKey));
      expect(descriptor.envelopeDigest).toEqual(await digestBytes(envelope));
    }

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

  it("rejects a rewritten canonical Owner offer even when its replacement digest is correct", async () => {
    const current = await fixture();
    const rewritten = offerBytes({ ...current.offer, labelId: id(31) });
    current.bootstrap.retained.provenance.offerBytes = encodeTreeBytes(rewritten);
    current.bootstrap.retained.provenance.offerDigest = encodeTreeBytes(await digestBytes(rewritten));

    await expect(prepareDirectFileProvisioning(current.bootstrap, current.device)).rejects.toThrow();
  });

  it("rejects changed retained ciphertext even when an attacker recomputes both untrusted hashes", async () => {
    const current = await fixture();
    const ciphertext = decodeTreeBytes(current.bootstrap.retained.ciphertext, 16384);
    ciphertext[ciphertext.length - 1] ^= 1;
    const attackerDigest = await digestBytes(ciphertext);
    current.bootstrap.retained.ciphertext = encodeTreeBytes(ciphertext);
    current.bootstrap.retained.digest = encodeTreeBytes(attackerDigest);
    const rewrittenOffer = offerBytes({ ...current.offer, devices: current.offer.devices.map((device) =>
      ({ ...device, contentDigest: hex(attackerDigest) })) });
    current.bootstrap.retained.provenance.offerBytes = encodeTreeBytes(rewrittenOffer);
    current.bootstrap.retained.provenance.offerDigest = encodeTreeBytes(await digestBytes(rewrittenOffer));

    await expect(prepareDirectFileProvisioning(current.bootstrap, current.device)).rejects.toThrow();
  });

  it("rejects a valid Owner signature that binds a different identity or retained key", async () => {
    const current = await fixture();
    const otherPublicKeyDigest = hex(await digestBytes(current.otherPublicKey));
    const cases: [string, Offer][] = [
      ["Owner", { ...current.offer, ownerId: id(32) }],
      ["Grant", { ...current.offer, grantId: id(33) }],
      ["recipient Account", { ...current.offer, recipientId: id(34),
        devices: current.offer.devices.map((device) => ({ ...device, accountId: id(34) })) }],
      ["File", { ...current.offer, targetId: id(35) }],
      ["signer", { ...current.offer, signerDeviceId: id(36) }],
      ["key id", { ...current.offer, targetKeyId: id(37) }],
      ["key epoch", { ...current.offer, targetEpoch: 2 }],
      ["content revision", { ...current.offer, contentRevision: 8 }],
      ["physical device", { ...current.offer, devices: current.offer.devices.map((device) =>
        ({ ...device, deviceId: id(38) })) }],
      ["transport public-key digest", { ...current.offer, devices: current.offer.devices.map((device) =>
        ({ ...device, publicKeyDigest: otherPublicKeyDigest })) }],
      ["retained-content digest", { ...current.offer, devices: current.offer.devices.map((device) =>
        ({ ...device, contentDigest: hex(randomDigest()) })) }],
    ];
    for (const [_case, offer] of cases) {
      await installSignedOffer(current, offer);
      await expect(prepareDirectFileProvisioning(current.bootstrap, current.device)).rejects.toThrow();
    }
  });

  it("rejects mismatched bootstrap identity and current-head commitments", async () => {
    const current = await fixture();
    const wrongOwner = jsonClone(current.bootstrap);
    wrongOwner.ownerId = id(39);
    await expect(prepareDirectFileProvisioning(wrongOwner, current.device)).rejects.toThrow();

    const wrongFile = jsonClone(current.bootstrap);
    wrongFile.fileId = id(40);
    await expect(prepareDirectFileProvisioning(wrongFile, current.device)).rejects.toThrow();

    const wrongRevision = jsonClone(current.bootstrap);
    wrongRevision.retained.revision = 8;
    await expect(prepareDirectFileProvisioning(wrongRevision, current.device)).rejects.toThrow();

    const wrongKey = jsonClone(current.bootstrap);
    wrongKey.retained.contentKeyId = id(41);
    await expect(prepareDirectFileProvisioning(wrongKey, current.device)).rejects.toThrow();

    const wrongEpoch = jsonClone(current.bootstrap);
    wrongEpoch.retained.contentEpoch = 2;
    await expect(prepareDirectFileProvisioning(wrongEpoch, current.device)).rejects.toThrow();
  });

  it("verifies the exact signed current head digest and signature before key opening", async () => {
    const current = await fixture();
    const wrongDigest = jsonClone(current.bootstrap);
    const digest = decodeTreeBytes(wrongDigest.currentHead.digest, 32);
    digest[0] ^= 1;
    wrongDigest.currentHead.digest = encodeTreeBytes(digest);
    await expect(prepareDirectFileProvisioning(wrongDigest, current.device)).rejects.toThrow();

    const wrongSignature = jsonClone(current.bootstrap);
    const signature = decodeTreeBytes(wrongSignature.currentHead.signature, 64);
    signature[0] ^= 1;
    wrongSignature.currentHead.signature = encodeTreeBytes(signature);
    await expect(prepareDirectFileProvisioning(wrongSignature, current.device)).rejects.toThrow();
  });

  it("requires the current complete recipient list to uniquely contain this active physical device", async () => {
    const current = await fixture();
    const missing = jsonClone(current.bootstrap);
    missing.recipients = missing.recipients.filter((item) => item.deviceId !== current.ids.deviceId);
    await expect(prepareDirectFileProvisioning(missing, current.device)).rejects.toThrow();

    const duplicate = jsonClone(current.bootstrap);
    duplicate.recipients.push(jsonClone(duplicate.recipients[0]!));
    await expect(prepareDirectFileProvisioning(duplicate, current.device)).rejects.toThrow();

    const wrongPublicKey = jsonClone(current.bootstrap);
    wrongPublicKey.recipients[0]!.publicKey = encodeTreeBytes(current.otherPublicKey);
    await expect(prepareDirectFileProvisioning(wrongPublicKey, current.device)).rejects.toThrow();

    const staleEpoch = jsonClone(current.bootstrap);
    staleEpoch.recipients[0]!.registryEpoch += 1;
    await expect(prepareDirectFileProvisioning(staleEpoch, current.device)).rejects.toThrow();

    const missingGrant = jsonClone(current.bootstrap);
    missingGrant.recipients[0]!.grants = [{ id: current.ids.otherGrantId, generation: 4 }];
    await expect(prepareDirectFileProvisioning(missingGrant, current.device)).rejects.toThrow();
  });

  it("rejects an HPKE envelope whose recipient context names another physical device", async () => {
    const current = await fixture();
    const ciphertext = await sealToRecipient(current.contentKey, current.localTransport.publicKey, {
      purpose: "grant", vaultId: current.ids.ownerId, objectId: current.ids.fileId,
      keyId: current.ids.contentKeyId, keyEpoch: 1, revision: 7, recipientId: current.ids.otherDeviceId,
    });
    await replaceRetainedEnvelope(current, ciphertext);

    await expect(prepareDirectFileProvisioning(current.bootstrap, current.device)).rejects.toThrow();
  });

  it("rejects an envelope from another suite even with a correctly signed retained digest", async () => {
    const current = await fixture();
    const writer = await createSymmetricWriter(current.contentKey);
    const ciphertext = await writer.seal(current.contentKey, { purpose: "file-content", vaultId: current.ids.ownerId,
      objectId: current.ids.fileId, keyId: current.ids.contentKeyId, keyEpoch: 1, revision: 7 });
    await replaceRetainedEnvelope(current, ciphertext);

    await expect(prepareDirectFileProvisioning(current.bootstrap, current.device)).rejects.toThrow();
  });

  it("rejects a retained HPKE plaintext that is not a 32-byte File content key", async () => {
    const current = await fixture();
    const ciphertext = await sealToRecipient(crypto.getRandomValues(new Uint8Array(31)),
      current.localTransport.publicKey, { purpose: "grant", vaultId: current.ids.ownerId,
        objectId: current.ids.fileId, keyId: current.ids.contentKeyId, keyEpoch: 1, revision: 7,
        recipientId: current.ids.deviceId });
    await replaceRetainedEnvelope(current, ciphertext);

    await expect(prepareDirectFileProvisioning(current.bootstrap, current.device)).rejects.toThrow();
  });
});
