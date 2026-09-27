import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createSymmetricWriter, openForRecipient, openSymmetric, sealToRecipient } from "../../app/crypto/enc-v1";
import { createFileReceivingKey, createFileSave, openFileContentKeyFromDevice } from "../../app/crypto/file-receiving";
import { createChildDirectoryCapability, generateDirectoryCapabilityKey } from "../../app/crypto/vault";
import { signDeviceProof, sessionBindingDigest } from "../../app/device/proof";
import { sealShareLabel, openShareLabel } from "../../app/sharing/label";
import { hex, signOffer, verifyOffer, parseOffer, digestBytes, type Offer } from "../../app/sharing/offer";
import type { FileProvisioningBootstrap } from "../../app/sharing/provisioning-wire";
import { signFileHead, verifyFileHead, assertFileHeadCommitTransition,
  assertExactFileRecipientDescriptors, verifyDirectFileRecipientEnvelope, type FileHeadStatement } from "../../app/tree/file-head";
import { createListingHead, openListingHead, type SealedEntry } from "../../app/tree/listing";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/tree/wire";
import { seedNormalSession } from "./auth-fixtures";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[]; SESSION_COOKIE_SECRET: string } } }
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const id = () => { const v = crypto.randomUUID(); return `${v.slice(0, 14)}7${v.slice(15)}`; };
const digest = async (v: Uint8Array) => hex(await digestBytes(v));
const enc = encodeTreeBytes;
const hash = async (v: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(v)));
const wireHead = (head: { bytes: Uint8Array; digest: Uint8Array; signature: Uint8Array }) =>
  ({ bytes: enc(head.bytes), digest: enc(head.digest), signature: enc(head.signature) });
function checkBudget(header: string | null) {
  expect(header).toMatch(/^\d+;\d+$/);
  const [queries, maxBindings] = header!.split(";").map(Number);
  expect(queries).toBeLessThanOrEqual(50);
  expect(maxBindings).toBeLessThanOrEqual(100);
  return { queries, maxBindings };
}

async function account() {
  const accountId = id(), rootId = id(), deviceId = id(), credentialId = id(), shareId = id();
  const now = Date.now();
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const transport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", transport.publicKey));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(accountId, shareId, now, now),
    env.DB.prepare("INSERT INTO passkeys (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at) VALUES (?, ?, X'01', 0, '[]', 'singleDevice', 0, ?, ?)")
      .bind(credentialId, accountId, now, now),
    env.DB.prepare("INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)")
      .bind(accountId, rootId),
    env.DB.prepare("INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, ?, ?, 'active', 'signup', 1, ?)")
      .bind(deviceId, accountId, publicKey,
        new Uint8Array(await crypto.subtle.exportKey("raw", signing.publicKey)), now),
  ]);
  const session = await seedNormalSession({ accountId, credentialIds: [credentialId] });
  await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(deviceId, session.id).run();
  let registryEpoch = 1;
  async function signedRequest(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", value?: object) {
    const url = `https://mdwn.test${path}`, body = value === undefined ? undefined : JSON.stringify(value);
    const proof = await signDeviceProof(signing.privateKey, { sessionBinding: await sessionBindingDigest(session.id),
      deviceId, registryEpoch, method, url, body });
    return () => SELF.fetch(url, { method, headers: { cookie: session.cookie, origin: "https://mdwn.test",
      "X-Mdwn-Device-Proof": JSON.stringify(proof), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body } : {}) });
  }
  async function request(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", value?: object) {
    return (await signedRequest(path, method, value))();
  }
  return { accountId, shareId, rootId, deviceId, credentialId, signing, transport, publicKey,
    rootKey: generateDirectoryCapabilityKey(), vaultRoot: generateDirectoryCapabilityKey(), request, signedRequest,
    setRegistryEpoch(epoch: number) { registryEpoch = epoch; } };
}
type Account = Awaited<ReturnType<typeof account>>;

async function createDirectory(actor: Account, owner: Account, parentId: string,
  parentKey: Uint8Array, name: string, listing?: { entriesRevision: number; entries: SealedEntry[];
    listingVersion: 1 | 2 }) {
  const childId = id(), writer = await createSymmetricWriter(parentKey);
  const context = { purpose: "directory-metadata" as const, vaultId: owner.accountId,
    objectId: childId, keyId: parentId, keyEpoch: 1, revision: 1 };
  const child = await createChildDirectoryCapability(parentKey, { vaultId: owner.accountId,
    parentDirectoryId: parentId, childDirectoryId: childId });
  const entry: SealedEntry = { nodeId: childId, kind: "directory",
    nameCiphertext: enc(await writer.seal(new TextEncoder().encode(name), context)),
    orderCiphertext: enc(await writer.seal(new TextEncoder().encode(id()), context)),
    keyEnvelope: enc(child.envelope), ...(listing?.listingVersion === 2 ? { encoding: "directory" as const } : {}) };
  const revision = listing?.entriesRevision ?? 1;
  const head = await createListingHead(parentKey, actor.signing.privateKey, {
    vaultId: owner.accountId, directoryId: parentId, deviceId: actor.deviceId,
    revision: revision + 1, entries: [...(listing?.entries ?? []), entry], version: listing?.listingVersion ?? 1 });
  const response = await actor.request(`/api/private/tree/directories/${parentId}/children`, "PUT", {
    ...entry, expectedRevision: revision, listingHead: head });
  expect(response.status, await response.clone().text()).toBe(201);
  return { childId, key: child.capabilityKey, entry };
}
async function list(actor: Account, owner: Account, directoryId: string, key: Uint8Array) {
  const response = await actor.request(`/api/private/tree/directories/${directoryId}`, "POST");
  expect(response.status, await response.clone().text()).toBe(200);
  const data = await response.json() as { entriesRevision: number; entries: SealedEntry[]; listingVersion: 1 | 2;
    listingHead: { ciphertext: string; digest: string; signature: string; signerDeviceId: string;
      signerPublicKey: string } | null };
  if (data.listingHead) await openListingHead(key, { vaultId: owner.accountId, directoryId,
    revision: data.entriesRevision, entries: data.entries, version: data.listingVersion,
    head: { ...data.listingHead, signerPublicKey: decodeTreeBytes(data.listingHead.signerPublicKey, 65) } });
  return data;
}

async function inviteDirectory(owner: Account, recipient: Account, targetId: string, key: Uint8Array,
  name: string, shareId = id()) {
  const prep = await owner.request("/api/private/sharing/target", "POST", {
    targetId, kind: "directory", recipientId: recipient.accountId });
  expect(prep.status, await prep.clone().text()).toBe(200);
  const coordinates = await prep.json() as { targetKeyId: string; targetEpoch: number;
    revision: number; headDigest: string };
  const grantId = id(), labelId = id();
  const resolved = await owner.request("/api/private/sharing/resolve", "POST",
    { kind: "share-id", value: recipient.shareId });
  expect(resolved.status).toBe(200);
  const addressed = await resolved.json() as { registryEpoch: number; devices: {
    deviceId: string; publicKey: string; registryEpoch: number }[] };
  const targets = await Promise.all(addressed.devices.map(async (d) => ({ ...d,
    bytes: decodeTreeBytes(d.publicKey, 65), key: await crypto.subtle.importKey("raw",
      decodeTreeBytes(d.publicKey, 65), { name: "ECDH", namedCurve: "P-256" }, true, []) })));
  const labels = await sealShareLabel(name, owner.accountId, targetId, labelId,
    targets.map((d) => ({ deviceId: d.deviceId, publicKey: d.key })), owner.vaultRoot);
  const sentMaterial = await Promise.all(targets.map(async (d) => {
    const ciphertext = await sealToRecipient(key, d.key, {
      purpose: "grant", vaultId: owner.accountId, objectId: targetId, keyId: coordinates.targetKeyId,
      keyEpoch: coordinates.targetEpoch, revision: 1, recipientId: d.deviceId });
    const label = labels.deliveries.find((item) => item.deviceId === d.deviceId)!.envelope;
    return { ...d, ciphertext, label, contentDigest: await digest(ciphertext), labelDigest: await digest(label) };
  }));
  const offer: Offer = { shareId, grantId, ownerId: owner.accountId, recipientId: recipient.accountId,
    targetId, kind: "directory", permission: "read_write", materialRevision: 1,
    targetKeyId: coordinates.targetKeyId, targetEpoch: coordinates.targetEpoch,
    contentRevision: coordinates.revision, headDigest: hex(decodeTreeBytes(coordinates.headDigest, 32)),
    labelId, ownerCopyDigest: await digest(labels.ownerCopy), registryEpoch: addressed.registryEpoch,
    devices: await Promise.all(sentMaterial.map(async (d) => ({ accountId: recipient.accountId,
      deviceId: d.deviceId, registryEpoch: d.registryEpoch, publicKeyDigest: await digest(d.bytes),
      contentDigest: d.contentDigest, labelDigest: d.labelDigest }))),
    candidateDigest: null, signerDeviceId: owner.deviceId };
  const signed = await signOffer(offer, owner.signing.privateKey);
  const sent = await owner.request("/api/private/sharing/shares", "PUT", {
    ...offer, ownerCopy: enc(labels.ownerCopy), offerBytes: enc(signed.bytes),
    offerDigest: enc(signed.digest), offerSignature: enc(signed.signature), candidate: null,
    deliveries: sentMaterial.map((d) => ({ deviceId: d.deviceId, registryEpoch: d.registryEpoch,
      publicKey: d.publicKey, ciphertext: enc(d.ciphertext), labelCiphertext: enc(d.label) })) });
  expect(sent.status, await sent.clone().text()).toBe(201);
  const current = sentMaterial.find((d) => d.deviceId === recipient.deviceId)!;
  return { grantId, shareId, labelId, key, ciphertext: current.ciphertext,
    label: current.label, budget: sent.headers.get("X-Mdwn-Sharing-Budget") };
}

async function createV2File(owner: Account) {
  const fileId = id(), representationId = id(), contentKeyId = id(), receivingKeyId = id();
  const receiver = await createFileReceivingKey(owner.rootKey, { vaultId: owner.accountId,
    fileId, receivingKeyId, receivingEpoch: 1, wrapRevision: 2 });
  const saved = await createFileSave({ markdown: "Current", metadata: new Uint8Array() }, receiver.publicKey,
    { vaultId: owner.accountId, fileId, receivingKeyId, receivingEpoch: 1,
      publicKeyDigest: receiver.publicKeyDigest },
    { vaultId: owner.accountId, fileId, contentKeyId, contentEpoch: 1, revision: 1 }, []);
  const statement: FileHeadStatement = { ownerId: owner.accountId, vaultId: owner.accountId,
    fileId, revision: 1, contentKey: { id: contentKeyId, epoch: 1 },
    receivingKey: { id: receivingKeyId, epoch: 1, publicKeyDigest: receiver.publicKeyDigest },
    representation: { id: representationId, digest: await hash(saved.contentEnvelope) },
    parentEnvelopeDigest: await hash(saved.parentEnvelope), recipientSetVersion: 1, recipients: [],
    publication: { status: "none" }, signerDeviceId: owner.deviceId };
  const signed = await signFileHead(statement, owner.signing.privateKey);
  const writer = await createSymmetricWriter(owner.rootKey);
  const ctx = { purpose: "directory-metadata" as const, vaultId: owner.accountId,
    objectId: fileId, keyId: owner.rootId, keyEpoch: 1, revision: 1 };
  const entry: SealedEntry = { nodeId: fileId, kind: "file", encoding: "receiving-file",
    nameCiphertext: enc(await writer.seal(new TextEncoder().encode("Private.md"), ctx)),
    orderCiphertext: enc(await writer.seal(new TextEncoder().encode("first"), ctx)),
    keyEnvelope: enc(receiver.privateKeyEnvelope), receivingKeyId, receivingEpoch: 1, wrapRevision: 2 };
  const listingHead = await createListingHead(owner.rootKey, owner.signing.privateKey, {
    vaultId: owner.accountId, directoryId: owner.rootId, deviceId: owner.deviceId,
    revision: 2, entries: [entry], version: 2 });
  const created = await owner.request(`/api/private/tree/directories/${owner.rootId}/children`, "PUT", {
    ...entry, expectedRevision: 1, representation: { id: representationId, contentKeyId, keyEpoch: 1,
      revision: 1, ciphertext: enc(saved.contentEnvelope) }, receivingPublicKey: enc(receiver.publicKey),
    parentEnvelope: enc(saved.parentEnvelope), recipientEnvelopes: [], signedHead: wireHead(signed), listingHead });
  expect(created.status, await created.clone().text()).toBe(201);
  return { fileId, receiver, saved, signed, representationId, contentKeyId };
}

async function inviteFile(owner: Account, recipient: Account,
  file: Awaited<ReturnType<typeof createV2File>>, permission: "read_only" | "read_write" = "read_only") {
  const grantId = id(), shareId = id(), labelId = id();
  const prep = await owner.request("/api/private/sharing/target", "POST", {
    targetId: file.fileId, kind: "file", recipientId: recipient.accountId });
  expect(prep.status, await prep.clone().text()).toBe(200);
  const coordinates = await prep.json() as { targetKeyId: string; targetEpoch: number; revision: number;
    headDigest: string; head: { bytes: string; signature: string; signerDeviceId: string; signerPublicKey: string };
    recipients: { accountId: string; deviceId: string; registryEpoch: number; publicKey: string;
      grants: { id: string; generation: number }[] }[] };
  const resolved = await owner.request("/api/private/sharing/resolve", "POST",
    { kind: "share-id", value: recipient.shareId });
  expect(resolved.status).toBe(200);
  const addressed = await resolved.json() as { registryEpoch: number; devices: {
    deviceId: string; publicKey: string; registryEpoch: number }[] };
  const targets = await Promise.all(addressed.devices.map(async (d) => ({ ...d,
    bytes: decodeTreeBytes(d.publicKey, 65), key: await crypto.subtle.importKey("raw",
      decodeTreeBytes(d.publicKey, 65), { name: "ECDH", namedCurve: "P-256" }, true, []) })));
  const labels = await sealShareLabel("Shared File", owner.accountId, file.fileId, labelId,
    targets.map((d) => ({ deviceId: d.deviceId, publicKey: d.key })), owner.vaultRoot);
  const sentMaterial = await Promise.all(targets.map(async (d) => {
    const ciphertext = await sealToRecipient(file.saved.fileContentKey, d.key, {
      purpose: "grant", vaultId: owner.accountId, objectId: file.fileId,
      keyId: file.contentKeyId, keyEpoch: 1, revision: 1, recipientId: d.deviceId });
    const label = labels.deliveries.find((item) => item.deviceId === d.deviceId)!.envelope;
    return { ...d, ciphertext, label, contentDigest: await digest(ciphertext), labelDigest: await digest(label) };
  }));
  const before = await verifyFileHead({ bytes: decodeTreeBytes(coordinates.head.bytes),
    digest: decodeTreeBytes(coordinates.headDigest, 32), signature: decodeTreeBytes(coordinates.head.signature, 64) },
  { ownerId: owner.accountId, vaultId: owner.accountId, fileId: file.fileId, revision: 1,
    signerDeviceId: coordinates.head.signerDeviceId,
    publicKey: decodeTreeBytes(coordinates.head.signerPublicKey, 65) });
  const candidate = await signFileHead({ ...before.statement, recipientSetVersion: before.statement.recipientSetVersion + 1,
    recipients: [...await Promise.all(coordinates.recipients.map(async (r) => ({ accountId: r.accountId,
      deviceId: r.deviceId, registryEpoch: r.registryEpoch, grants: r.grants,
      publicKeyDigest: await hash(decodeTreeBytes(r.publicKey, 65)),
      envelopeDigest: before.statement.recipients.find((d) => d.deviceId === r.deviceId)!.envelopeDigest }))),
      ...await Promise.all(sentMaterial.map(async (d) => ({ accountId: recipient.accountId,
        deviceId: d.deviceId, registryEpoch: d.registryEpoch,
        grants: [{ id: grantId, generation: 1 }], publicKeyDigest: await hash(d.bytes),
        envelopeDigest: await hash(d.ciphertext) })))], signerDeviceId: owner.deviceId }, owner.signing.privateKey);
  const offer: Offer = { shareId, grantId, ownerId: owner.accountId, recipientId: recipient.accountId,
    targetId: file.fileId, kind: "file", permission, materialRevision: 1,
    targetKeyId: file.contentKeyId, targetEpoch: 1, contentRevision: 1,
    headDigest: hex(decodeTreeBytes(coordinates.headDigest, 32)), labelId,
    ownerCopyDigest: await digest(labels.ownerCopy), registryEpoch: addressed.registryEpoch,
    devices: await Promise.all(sentMaterial.map(async (d) => ({ accountId: recipient.accountId,
      deviceId: d.deviceId, registryEpoch: d.registryEpoch, publicKeyDigest: await digest(d.bytes),
      contentDigest: d.contentDigest, labelDigest: d.labelDigest }))),
    candidateDigest: await digest(candidate.bytes), signerDeviceId: owner.deviceId };
  const signed = await signOffer(offer, owner.signing.privateKey);
  const sent = await owner.request("/api/private/sharing/shares", "PUT", {
    ...offer, ownerCopy: enc(labels.ownerCopy), offerBytes: enc(signed.bytes), offerDigest: enc(signed.digest),
    offerSignature: enc(signed.signature), candidate: wireHead(candidate),
    deliveries: sentMaterial.map((d) => ({ deviceId: d.deviceId, registryEpoch: d.registryEpoch,
      publicKey: d.publicKey, ciphertext: enc(d.ciphertext), labelCiphertext: enc(d.label) })) });
  expect(sent.status, await sent.clone().text()).toBe(201);
  return { shareId, grantId, signed, candidate,
    ciphertext: sentMaterial.find((d) => d.deviceId === recipient.deviceId)!.ciphertext,
    labelId, budget: sent.headers.get("X-Mdwn-Sharing-Budget") };
}

describe("private sharing lifecycle through the built Worker", () => {
  it("bootstraps a retained File key with independently verifiable Owner-signed sender provenance", async () => {
    const owner = await account(), recipient = await account(), file = await createV2File(owner);
    const invitation = await inviteFile(owner, recipient, file);
    expect((await recipient.request(`/api/private/sharing/shares/${invitation.shareId}/accept`, "POST",
      { materialRevision: 1 })).status).toBe(200);
    // The pre-invitation File head does not name this device. HPKE base mode
    // and a self-consistent hash alone cannot authenticate who sealed its key.
    const response = await recipient.request(`/api/private/sharing/direct-files/${file.fileId}/bootstrap`, "POST");
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as FileProvisioningBootstrap;
    const proof = body.retained.provenance;
    const signed = await verifyOffer(decodeTreeBytes(proof.offerBytes, 131072),
      decodeTreeBytes(proof.offerDigest, 32), decodeTreeBytes(proof.offerSignature, 64),
      decodeTreeBytes(proof.signerPublicKey, 65));
    expect(signed).toMatchObject({ ownerId: owner.accountId, recipientId: recipient.accountId,
      targetId: file.fileId, kind: "file", grantId: invitation.grantId, signerDeviceId: owner.deviceId,
      targetKeyId: file.contentKeyId, targetEpoch: 1, contentRevision: 1 });
    expect(proof).toMatchObject({ grantId: invitation.grantId, signerDeviceId: owner.deviceId });
    const receiver = signed.devices.find((d) => d.accountId === recipient.accountId &&
      d.deviceId === recipient.deviceId);
    expect(receiver).toMatchObject({ publicKeyDigest: await digest(recipient.publicKey),
      contentDigest: await digest(decodeTreeBytes(body.retained.ciphertext, 16384)) });
    expect(body.retained.digest).toBe(enc(await hash(decodeTreeBytes(body.retained.ciphertext, 16384))));
    expect(await openFileContentKeyFromDevice(decodeTreeBytes(body.retained.ciphertext, 16384),
      recipient.transport, { vaultId: owner.accountId, fileId: file.fileId,
        contentKeyId: file.contentKeyId, contentEpoch: 1, revision: 1,
        deviceId: recipient.deviceId })).toEqual(file.saved.fileContentKey);
    expect(JSON.stringify(body)).not.toMatch(/Private\.md|Shared File|ownerCopy|labelCiphertext|representationCiphertext|parentId/i);
  });

  it("fails closed on a retained cipher with a matching untrusted digest or substituted signed offer", async () => {
    const owner = await account(), recipient = await account(), file = await createV2File(owner);
    const invitation = await inviteFile(owner, recipient, file);
    expect((await recipient.request(`/api/private/sharing/shares/${invitation.shareId}/accept`, "POST",
      { materialRevision: 1 })).status).toBe(200);
    const path = `/api/private/sharing/direct-files/${file.fileId}/bootstrap`;
    const original = parseOffer(invitation.signed.bytes);
    const tampered = new Uint8Array(invitation.ciphertext);
    tampered[tampered.length - 1] ^= 1;
    await env.DB.prepare("UPDATE grant_retained_material SET ciphertext = ?, digest = ? WHERE grant_id = ?")
      .bind(tampered, await hash(tampered), invitation.grantId).run();
    expect((await recipient.request(path, "POST")).status).toBe(202);
    await env.DB.prepare("UPDATE grant_retained_material SET ciphertext = ?, digest = ? WHERE grant_id = ?")
      .bind(invitation.ciphertext, await hash(invitation.ciphertext), invitation.grantId).run();
    for (const substituted of [
      { ...original, targetId: id() },
      { ...original, grantId: id() },
      { ...original, contentRevision: original.contentRevision + 1 },
      { ...original, devices: original.devices.map((d) => ({ ...d, deviceId: id() })) },
      { ...original, devices: original.devices.map((d) => ({ ...d, publicKeyDigest: "a".repeat(64) })) },
    ]) {
      const signed = await signOffer(substituted, owner.signing.privateKey);
      await env.DB.prepare(`UPDATE grant_labels SET offer_bytes = ?, offer_digest = ?,
        offer_signature = ? WHERE grant_id = ?`)
        .bind(signed.bytes, signed.digest, signed.signature, invitation.grantId).run();
      expect((await recipient.request(path, "POST")).status).toBe(202);
    }
    await env.DB.prepare(`UPDATE grant_labels SET offer_bytes = ?, offer_digest = ?,
      offer_signature = ? WHERE grant_id = ?`)
      .bind(invitation.signed.bytes, invitation.signed.digest, invitation.signed.signature,
        invitation.grantId).run();
    expect((await recipient.request(path, "POST")).status).toBe(200);
    const otherOwner = await account();
    await env.DB.prepare("UPDATE grant_labels SET signer_device_id = ? WHERE grant_id = ?")
      .bind(otherOwner.deviceId, invitation.grantId).run();
    expect((await recipient.request(path, "POST")).status).toBe(202);
    await env.DB.prepare("UPDATE grant_labels SET signer_device_id = ? WHERE grant_id = ?")
      .bind(owner.deviceId, invitation.grantId).run();
    const corruptedSignature = new Uint8Array(invitation.signed.signature);
    corruptedSignature[0] ^= 1;
    await env.DB.prepare("UPDATE grant_labels SET offer_signature = ? WHERE grant_id = ?")
      .bind(corruptedSignature, invitation.grantId).run();
    expect((await recipient.request(path, "POST")).status).toBe(202);
    await env.DB.prepare("DELETE FROM grant_label_deliveries WHERE grant_id = ?")
      .bind(invitation.grantId).run();
    await env.DB.prepare("DELETE FROM grant_labels WHERE grant_id = ?")
      .bind(invitation.grantId).run();
    expect((await recipient.request(path, "POST")).status).toBe(202);
  });

  it("allows historical Owner signer and same physical key after registry advance, but only a current actor completes", async () => {
    const owner = await account(), recipient = await account(), file = await createV2File(owner);
    const invitation = await inviteFile(owner, recipient, file);
    expect((await recipient.request(`/api/private/sharing/shares/${invitation.shareId}/accept`, "POST",
      { materialRevision: 1 })).status).toBe(200);
    await env.DB.prepare("UPDATE encryption_devices SET state = 'revoked', revocation_reason = 'test' WHERE id = ?")
      .bind(owner.deviceId).run();
    const newcomer = { deviceId: id(), pair: await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]) };
    await env.DB.prepare(`INSERT INTO encryption_devices (id, account_id, transport_public_key,
      assertion_public_key, state, approval_provenance, registry_epoch, created_at)
      VALUES (?, ?, ?, ?, 'active', 'routine', 2, ?)`)
      .bind(newcomer.deviceId, recipient.accountId,
        new Uint8Array(await crypto.subtle.exportKey("raw", newcomer.pair.publicKey)),
        new Uint8Array(await crypto.subtle.exportKey("raw", recipient.signing.publicKey)), Date.now()).run();
    recipient.setRegistryEpoch(2);
    const path = `/api/private/sharing/direct-files/${file.fileId}`;
    const response = await recipient.request(`${path}/bootstrap`, "POST");
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as FileProvisioningBootstrap;
    const verified = await verifyOffer(decodeTreeBytes(body.retained.provenance.offerBytes, 131072),
      decodeTreeBytes(body.retained.provenance.offerDigest, 32),
      decodeTreeBytes(body.retained.provenance.offerSignature, 64),
      decodeTreeBytes(body.retained.provenance.signerPublicKey, 65));
    expect(verified.registryEpoch).toBe(1);
    expect(body.recipients).toHaveLength(2);
    expect(body.retained.provenance.signerDeviceId).toBe(owner.deviceId);
    const head = await verifyFileHead({ bytes: decodeTreeBytes(body.currentHead.bytes, 131072),
      digest: decodeTreeBytes(body.currentHead.digest, 32),
      signature: decodeTreeBytes(body.currentHead.signature, 64) },
    { ownerId: owner.accountId, vaultId: owner.accountId, fileId: file.fileId,
      signerDeviceId: body.currentHead.signerDeviceId,
      publicKey: decodeTreeBytes(body.currentHead.signerPublicKey, 65) });
    const sealed = await Promise.all(body.recipients.map(async (r) => ({ ...r,
      ciphertext: await sealToRecipient(file.saved.fileContentKey,
        await crypto.subtle.importKey("raw", decodeTreeBytes(r.publicKey, 65),
          { name: "ECDH", namedCurve: "P-256" }, true, []),
        { purpose: "grant", vaultId: owner.accountId, objectId: file.fileId,
          keyId: file.contentKeyId, keyEpoch: 1, revision: 1, recipientId: r.deviceId }) })));
    const signed = await signFileHead({ ...head.statement,
      recipientSetVersion: head.statement.recipientSetVersion + 1,
      recipients: await Promise.all(sealed.map(async (r) => ({ accountId: r.accountId,
        deviceId: r.deviceId, registryEpoch: r.registryEpoch, grants: r.grants,
        publicKeyDigest: await hash(decodeTreeBytes(r.publicKey, 65)),
        envelopeDigest: await hash(r.ciphertext) }))), signerDeviceId: recipient.deviceId },
    recipient.signing.privateKey);
    const verifiedNext = await verifyFileHead(signed, { ownerId: owner.accountId, vaultId: owner.accountId,
      fileId: file.fileId, revision: 1, signerDeviceId: recipient.deviceId,
      publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", recipient.signing.publicKey)) });
    assertFileHeadCommitTransition(head, verifiedNext, { expectedSameRevisionTransition: "recipient-set-update" });
    assertExactFileRecipientDescriptors(verifiedNext, await Promise.all(sealed.map(async (r) => ({
      accountId: r.accountId, deviceId: r.deviceId, registryEpoch: r.registryEpoch, grants: r.grants,
      publicKeyDigest: await hash(decodeTreeBytes(r.publicKey, 65)),
    }))));
    for (const r of sealed) await verifyDirectFileRecipientEnvelope(verifiedNext, r.accountId, r.deviceId,
      decodeTreeBytes(r.publicKey, 65), r.ciphertext);
    const complete = await recipient.request(`${path}/complete`, "PATCH", {
      expectedHeadDigest: body.currentHead.digest, expectedRevision: 1,
      expectedRecipientSetVersion: head.statement.recipientSetVersion, signedHead: wireHead(signed),
      recipientEnvelopes: sealed.map((r) => ({ deviceId: r.deviceId, ciphertext: enc(r.ciphertext) })) });
    expect(complete.status, await complete.clone().text()).toBe(200);
    expect((await complete.json() as { status: string }).status).toBe("provisioning");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM file_device_envelopes WHERE file_node_id = ?")
      .bind(file.fileId).first<{ count: number }>())?.count).toBe(2);
    // The original recipient no longer signs with the old epoch, and the new
    // device has no retained provenance of its own yet.
    recipient.setRegistryEpoch(1);
    expect((await recipient.request(`${path}/bootstrap`, "POST")).status).not.toBe(200);
  });

  it("rejects cross-Account retained material and label rows at the storage boundary", async () => {
    const owner = await account(), recipient = await account(), file = await createV2File(owner);
    const offer = await inviteFile(owner, recipient, file);
    expect((await recipient.request(`/api/private/sharing/shares/${offer.shareId}/accept`, "POST",
      { materialRevision: 1 })).status).toBe(200);
    const foreign = await sealToRecipient(file.saved.fileContentKey, owner.transport.publicKey, {
      purpose: "grant", vaultId: owner.accountId, objectId: file.fileId,
      keyId: file.contentKeyId, keyEpoch: 1, revision: 1, recipientId: owner.deviceId });
    await expect(env.DB.prepare(`INSERT INTO grant_retained_material (grant_id, device_id,
      registry_epoch, content_key_id, content_epoch, revision, public_key_digest, ciphertext, digest)
      VALUES (?, ?, 1, ?, 1, 1, ?, ?, ?)`).bind(offer.grantId, owner.deviceId,
      file.contentKeyId, await hash(owner.publicKey), foreign, await hash(foreign)).run()).rejects.toThrow();
    await expect(env.DB.prepare(`INSERT INTO grant_label_deliveries (grant_id, device_id,
      registry_epoch, ciphertext, digest) VALUES (?, ?, 1, ?, ?)`).bind(offer.grantId,
      owner.deviceId, foreign, await hash(foreign)).run()).rejects.toThrow();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM grant_retained_material WHERE grant_id = ?")
      .bind(offer.grantId).first()).toEqual({ count: 1 });
  });
  it("paginates beyond 200 independently ready roots without hiding the last Grant", async () => {
    const recipient = await account(), expected: string[] = [];
    for (let i = 0; i < 201; i++) {
      const owner = await account();
      const offer = await inviteDirectory(owner, recipient, owner.rootId, owner.rootKey, `Root ${i}`);
      const accepted = await recipient.request(`/api/private/sharing/shares/${offer.shareId}/accept`,
        "POST", { materialRevision: 1 });
      expect(accepted.status, `root ${i}: ${await accepted.clone().text()}`).toBe(200);
      expected.push(offer.grantId);
    }
    let cursor: string | null = null;
    const received: string[] = [];
    for (const count of [100, 100, 1]) {
      const page = await recipient.request("/api/private/sharing/roots", "POST",
        cursor ? { cursor } : undefined);
      expect(page.status).toBe(200);
      checkBudget(page.headers.get("X-Mdwn-Sharing-Budget"));
      const response = await page.json() as { roots: { grantId: string; status: string }[];
        nextCursor: string | null };
      expect(response.roots).toHaveLength(count);
      expect(response.roots.every((root) => root.status === "ready")).toBe(true);
      received.push(...response.roots.map((root) => root.grantId));
      cursor = response.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(received.sort()).toEqual(expected.sort());
  }, 120_000);
  it("resolves only the stored exact lookup token or opaque share identifier, without discovery", async () => {
    const actor = await account(), recipient = await account();
    await env.DB.prepare("UPDATE accounts SET share_handle_lookup_token = ? WHERE id = ?")
      .bind("lookup-token:alice", recipient.accountId).run();
    for (const [kind, value] of [["handle", "lookup-token:alice"], ["share-id", recipient.shareId]]) {
      const found = await actor.request("/api/private/sharing/resolve", "POST", { kind, value });
      expect(found.status).toBe(200);
      expect((await found.json() as { accountId: string }).accountId).toBe(recipient.accountId);
    }
    for (const value of ["@Alice", "alice", "ALICE", "lookup-token:ali"]) {
      expect((await actor.request("/api/private/sharing/resolve", "POST",
        { kind: "handle", value })).status).toBe(404);
    }
  });

  it("declines without material residue and consumes just one proof under a competing acceptance", async () => {
    const owner = await account(), recipient = await account();
    const directory = await createDirectory(owner, owner, owner.rootId, owner.rootKey, "Pending");
    const invitation = await inviteDirectory(owner, recipient, directory.childId, directory.key, "Pending");
    expect((await recipient.request(`/api/private/sharing/shares/${invitation.shareId}/accept`, "DELETE")).status).toBe(404);
    const path = `/api/private/sharing/shares/${invitation.shareId}`;
    const accept = await recipient.signedRequest(`${path}/accept`, "POST", { materialRevision: 1 });
    const decline = await recipient.signedRequest(`${path}/decline`, "DELETE");
    const results = await Promise.all([accept(), decline()]);
    expect(results.map((r) => r.status).filter((status) => status === 200)).toHaveLength(1);
    const accepted = await env.DB.prepare("SELECT COUNT(*) AS count FROM grants WHERE id = ?")
      .bind(invitation.grantId).first<{ count: number }>();
    expect(accepted?.count).toBe(results[0]!.status === 200 ? 1 : 0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM shares WHERE id = ?")
      .bind(invitation.shareId).first()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM share_offers WHERE share_id = ?")
      .bind(invitation.shareId).first()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM device_proof_uses WHERE account_id = ?")
      .bind(recipient.accountId).first()).toEqual({ count: 1 });
    if (accepted?.count === 1) {
      expect((await recipient.request(`/api/private/sharing/grants/${invitation.grantId}/leave`,
        "PATCH", { permission: "read_only" })).status).toBe(404);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM rotation_barriers WHERE owner_id = ?")
        .bind(owner.accountId).first()).toEqual({ count: 0 });
    }
  });
  it("commits all 256 real device deliveries within the measured whole-request D1 budget", async () => {
    const owner = await account(), recipient = await account();
    const directory = await createDirectory(owner, owner, owner.rootId, owner.rootKey, "Bounded directory");
    const extra = await Promise.all(Array.from({ length: 255 }, async () => ({
      id: id(), pair: await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" },
        false, ["deriveBits"]) })));
    for (let i = 0; i < extra.length; i += 20) {
      const batch = await Promise.all(extra.slice(i, i + 20).map(async (device, index) =>
        env.DB.prepare(`INSERT INTO encryption_devices (id, account_id, transport_public_key,
          assertion_public_key, state, approval_provenance, registry_epoch, created_at)
          VALUES (?, ?, ?, ?, 'active', 'routine', ?, ?)`).bind(device.id, recipient.accountId,
          new Uint8Array(await crypto.subtle.exportKey("raw", device.pair.publicKey)),
          new Uint8Array(await crypto.subtle.exportKey("raw", recipient.signing.publicKey)),
          i + index + 2, Date.now())));
      await env.DB.batch(batch);
    }
    recipient.setRegistryEpoch(256);
    const offer = await inviteDirectory(owner, recipient, directory.childId, directory.key, "256 devices");
    const invitedBudget = checkBudget(offer.budget);
    const accept = await recipient.request(`/api/private/sharing/shares/${offer.shareId}/accept`, "POST",
      { materialRevision: 1 });
    expect(accept.status, await accept.clone().text()).toBe(200);
    const acceptedBudget = checkBudget(accept.headers.get("X-Mdwn-Sharing-Budget"));
    expect((await accept.json() as { status: string }).status).toBe("ready");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM grant_device_envelopes WHERE grant_id = ?")
      .bind(offer.grantId).first()).toEqual({ count: 256 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM grant_label_deliveries WHERE grant_id = ?")
      .bind(offer.grantId).first()).toEqual({ count: 256 });
    // Header values include Session+device authorization, preflight D1 reads,
    // and every statement in the one atomic batch; not just statement.length.
    expect(invitedBudget.queries).toBeGreaterThan(10);
    expect(acceptedBudget.queries).toBeGreaterThan(15);
    const fileOwner = await account(), file = await createV2File(fileOwner);
    const fileOffer = await inviteFile(fileOwner, recipient, file);
    const fileInvitedBudget = checkBudget(fileOffer.budget);
    const fileAcceptance = await recipient.request(`/api/private/sharing/shares/${fileOffer.shareId}/accept`,
      "POST", { materialRevision: 1 });
    expect(fileAcceptance.status, await fileAcceptance.clone().text()).toBe(200);
    const fileAcceptedBudget = checkBudget(fileAcceptance.headers.get("X-Mdwn-Sharing-Budget"));
    expect((await fileAcceptance.json() as { status: string }).status).toBe("ready");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM file_device_envelopes WHERE file_node_id = ?")
      .bind(file.fileId).first()).toEqual({ count: 256 });
    const bootstrap = await recipient.request(`/api/private/sharing/direct-files/${file.fileId}/bootstrap`, "POST");
    expect(bootstrap.status).toBe(200);
    const fileBootBudget = checkBudget(bootstrap.headers.get("X-Mdwn-Sharing-Budget"));
    const prepared = await bootstrap.json() as FileProvisioningBootstrap;
    expect(prepared.recipients).toHaveLength(256);
    const before = await verifyFileHead({ bytes: decodeTreeBytes(prepared.currentHead.bytes, 131072),
      digest: decodeTreeBytes(prepared.currentHead.digest, 32),
      signature: decodeTreeBytes(prepared.currentHead.signature, 64) },
    { ownerId: fileOwner.accountId, vaultId: fileOwner.accountId, fileId: file.fileId,
      signerDeviceId: prepared.currentHead.signerDeviceId,
      publicKey: decodeTreeBytes(prepared.currentHead.signerPublicKey, 65) });
    const refreshed = await Promise.all(prepared.recipients.map(async (r) => ({ ...r,
      envelope: await sealToRecipient(file.saved.fileContentKey,
        await crypto.subtle.importKey("raw", decodeTreeBytes(r.publicKey, 65),
          { name: "ECDH", namedCurve: "P-256" }, true, []),
        { purpose: "grant", vaultId: fileOwner.accountId, objectId: file.fileId,
          keyId: file.contentKeyId, keyEpoch: 1, revision: 1, recipientId: r.deviceId }) })));
    const signed = await signFileHead({ ...before.statement, recipientSetVersion: before.statement.recipientSetVersion + 1,
      recipients: await Promise.all(refreshed.map(async (r) => ({ accountId: r.accountId,
        deviceId: r.deviceId, registryEpoch: r.registryEpoch, grants: r.grants,
        publicKeyDigest: await hash(decodeTreeBytes(r.publicKey, 65)), envelopeDigest: await hash(r.envelope) }))),
      signerDeviceId: recipient.deviceId }, recipient.signing.privateKey);
    const completion = await recipient.request(`/api/private/sharing/direct-files/${file.fileId}/complete`,
      "PATCH", { expectedHeadDigest: prepared.currentHead.digest, expectedRevision: 1,
        expectedRecipientSetVersion: before.statement.recipientSetVersion, signedHead: wireHead(signed),
        recipientEnvelopes: refreshed.map((r) => ({ deviceId: r.deviceId, ciphertext: enc(r.envelope) })) });
    expect(completion.status, await completion.clone().text()).toBe(200);
    const fileCompleteBudget = checkBudget(completion.headers.get("X-Mdwn-Sharing-Budget"));
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM file_device_envelopes WHERE file_node_id = ?")
      .bind(file.fileId).first()).toEqual({ count: 256 });
    expect(fileInvitedBudget.queries).toBeGreaterThan(10);
    expect(fileAcceptedBudget.queries).toBeGreaterThan(15);
    expect(fileBootBudget.queries).toBeGreaterThan(3);
    expect(fileCompleteBudget.queries).toBeGreaterThan(10);
  }, 120_000);
  it("keeps the current physical device ready while a newly enrolled device has only an opaque need", async () => {
    const owner = await account(), recipient = await account();
    const directory = await createDirectory(owner, owner, owner.rootId, owner.rootKey, "A directory");
    const offer = await inviteDirectory(owner, recipient, directory.childId, directory.key, "Snapshot");
    const secondId = id(), transport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" },
      false, ["deriveBits"]), assertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" },
      false, ["sign", "verify"]);
    await env.DB.prepare(`INSERT INTO encryption_devices (id, account_id, transport_public_key,
      assertion_public_key, state, approval_provenance, registry_epoch, created_at)
      VALUES (?, ?, ?, ?, 'active', 'routine', 2, ?)`).bind(secondId, recipient.accountId,
      new Uint8Array(await crypto.subtle.exportKey("raw", transport.publicKey)),
      new Uint8Array(await crypto.subtle.exportKey("raw", assertion.publicKey)), Date.now()).run();
    recipient.setRegistryEpoch(2);
    const accepted = await recipient.request(`/api/private/sharing/shares/${offer.shareId}/accept`, "POST",
      { materialRevision: 1 });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect((await accepted.json() as { status: string }).status).toBe("ready");
    expect(await env.DB.prepare("SELECT device_id, registry_epoch FROM provisioning_needs WHERE grant_id = ?")
      .bind(offer.grantId).all()).toMatchObject({ results: [
      { device_id: secondId, registry_epoch: 2 },
    ] });
    const own = await recipient.request("/api/private/sharing/roots", "POST");
    expect((await own.json() as { roots: { status: string }[] }).roots[0]!.status).toBe("ready");
    const otherSession = await seedNormalSession({ accountId: recipient.accountId,
      credentialIds: [recipient.credentialId] });
    await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?")
      .bind(secondId, otherSession.id).run();
    const url = "https://mdwn.test/api/private/sharing/roots";
    const proof = await signDeviceProof(assertion.privateKey, {
      sessionBinding: await sessionBindingDigest(otherSession.id), deviceId: secondId,
      registryEpoch: 2, method: "POST", url });
    const other = await SELF.fetch(url, { method: "POST", headers: {
      cookie: otherSession.cookie, origin: "https://mdwn.test", "X-Mdwn-Device-Proof": JSON.stringify(proof) } });
    expect(other.status).toBe(200);
    expect((await other.json() as { roots: { status: string; labelCiphertext: string;
      capability?: unknown }[] }).roots).toEqual([expect.objectContaining({
      status: "provisioning", labelCiphertext: "",
    })]);
  });
  it("never installs an obsolete File-key offer after a real content-key save", async () => {
    const owner = await account(), recipient = await account(), file = await createV2File(owner);
    const offer = await inviteFile(owner, recipient, file);
    const contentKeyId = id(), representationId = id();
    const saved = await createFileSave({ markdown: "New version", metadata: new Uint8Array() },
      file.receiver.publicKey, { vaultId: owner.accountId, fileId: file.fileId,
        receivingKeyId: file.receiver.receivingKeyId, receivingEpoch: 1,
        publicKeyDigest: file.receiver.publicKeyDigest },
      { vaultId: owner.accountId, fileId: file.fileId, contentKeyId, contentEpoch: 2, revision: 2 }, []);
    const next = await signFileHead({ ...(await verifyFileHead(file.signed, {
      ownerId: owner.accountId, vaultId: owner.accountId, fileId: file.fileId,
      signerDeviceId: owner.deviceId, publicKey: new Uint8Array(await crypto.subtle.exportKey(
        "raw", owner.signing.publicKey)) })).statement,
    revision: 2, contentKey: { id: contentKeyId, epoch: 2 },
    representation: { id: representationId, digest: await hash(saved.contentEnvelope) },
    parentEnvelopeDigest: await hash(saved.parentEnvelope) }, owner.signing.privateKey);
    const save = await owner.request(`/api/private/tree/files/${file.fileId}`, "PATCH", {
      expectedHeadDigest: enc(file.signed.digest), expectedRevision: 1, expectedRecipientSetVersion: 1,
      representation: { id: representationId, contentKeyId, keyEpoch: 2,
        revision: 2, ciphertext: enc(saved.contentEnvelope) }, parentEnvelope: enc(saved.parentEnvelope),
      recipientEnvelopes: [], signedHead: wireHead(next) });
    expect(save.status, await save.clone().text()).toBe(200);
    const accepted = await recipient.request(`/api/private/sharing/shares/${offer.shareId}/accept`, "POST",
      { materialRevision: 1 });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect((await accepted.json() as { status: string }).status).toBe("provisioning");
    const bootstrap = await recipient.request(`/api/private/sharing/direct-files/${file.fileId}/bootstrap`, "POST");
    expect(bootstrap.status).toBe(202);
    expect((await recipient.request(`/api/private/sharing/direct-files/${file.fileId}`, "POST")).status).toBe(202);
    const roots = await recipient.request("/api/private/sharing/roots", "POST");
    expect((await roots.json() as { roots: { status: string; labelCiphertext: string }[] }).roots)
      .toEqual([expect.objectContaining({ status: "provisioning", labelCiphertext: "" })]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM grant_retained_material WHERE grant_id = ?")
      .bind(offer.grantId).first()).toEqual({ count: 0 });
  });
  it("retains a stale-head current key and gives a read-only holder a parent-free completion bootstrap", async () => {
    const owner = await account(), first = await account(), second = await account();
    const file = await createV2File(owner);
    const pending = await inviteFile(owner, second, file);
    const other = await inviteFile(owner, first, file);
    const winner = await first.request(`/api/private/sharing/shares/${other.shareId}/accept`, "POST",
      { materialRevision: 1 });
    expect(winner.status, await winner.clone().text()).toBe(200);
    expect((await winner.json() as { status: string }).status).toBe("ready");
    const accepted = await second.request(`/api/private/sharing/shares/${pending.shareId}/accept`, "POST",
      { materialRevision: 1 });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect((await accepted.json() as { status: string }).status).toBe("provisioning");
    const bootstrap = await second.request(`/api/private/sharing/direct-files/${file.fileId}/bootstrap`, "POST");
    expect(bootstrap.status, await bootstrap.clone().text()).toBe(200);
    const body = await bootstrap.json() as FileProvisioningBootstrap;
    expect(await openFileContentKeyFromDevice(decodeTreeBytes(body.retained.ciphertext), second.transport,
      { vaultId: owner.accountId, fileId: file.fileId, contentKeyId: file.contentKeyId,
        contentEpoch: 1, revision: 1, deviceId: second.deviceId })).toEqual(file.saved.fileContentKey);
    expect(JSON.stringify(body)).not.toMatch(/Private\.md|Shared File|label|representation|parent/i);
    expect(body.recipients).toHaveLength(2);
    const old = await verifyFileHead({ bytes: decodeTreeBytes(body.currentHead.bytes),
      digest: decodeTreeBytes(body.currentHead.digest, 32),
      signature: decodeTreeBytes(body.currentHead.signature, 64) },
    { ownerId: owner.accountId, vaultId: owner.accountId, fileId: file.fileId,
      signerDeviceId: body.currentHead.signerDeviceId,
      publicKey: decodeTreeBytes(body.currentHead.signerPublicKey, 65) });
    const envelopes = await Promise.all(body.recipients.map(async ({ deviceId }) => ({ deviceId,
      ciphertext: await sealToRecipient(file.saved.fileContentKey,
        deviceId === first.deviceId ? first.transport.publicKey : second.transport.publicKey,
        { purpose: "grant", vaultId: owner.accountId, objectId: file.fileId,
          keyId: file.contentKeyId, keyEpoch: 1, revision: 1, recipientId: deviceId }) })));
    const signed = await signFileHead({ ...old.statement,
      recipientSetVersion: old.statement.recipientSetVersion + 1,
      recipients: await Promise.all(body.recipients.map(async (r) => ({ accountId: r.accountId,
        deviceId: r.deviceId, registryEpoch: r.registryEpoch, grants: r.grants,
        publicKeyDigest: await hash(decodeTreeBytes(r.publicKey, 65)),
        envelopeDigest: await hash(envelopes.find((e) => e.deviceId === r.deviceId)!.ciphertext) }))),
      signerDeviceId: second.deviceId }, second.signing.privateKey);
    const completion = { expectedHeadDigest: body.currentHead.digest, expectedRevision: 1,
      expectedRecipientSetVersion: old.statement.recipientSetVersion, signedHead: wireHead(signed),
      recipientEnvelopes: envelopes.map((e) => ({ deviceId: e.deviceId, ciphertext: enc(e.ciphertext) })) };
    const path = `/api/private/sharing/direct-files/${file.fileId}/complete`;
    const altered = await signFileHead({ ...old.statement,
      representation: { ...old.statement.representation, id: id() },
      recipientSetVersion: old.statement.recipientSetVersion + 1,
      recipients: (await verifyFileHead(signed, { ownerId: owner.accountId, vaultId: owner.accountId,
        fileId: file.fileId, signerDeviceId: second.deviceId,
        publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", second.signing.publicKey)) })).statement.recipients,
      signerDeviceId: second.deviceId }, second.signing.privateKey);
    const invalidChange = await second.request(path, "PATCH", { ...completion, signedHead: wireHead(altered) });
    expect(invalidChange.status).toBe(400); // Read-only holder cannot change representation.
    const [attemptA, attemptB] = await Promise.all([
      second.request(path, "PATCH", completion), second.request(path, "PATCH", completion),
    ]);
    expect([attemptA.status, attemptB.status].sort()).toEqual([200, 409]);
    const after = await second.request(`/api/private/sharing/direct-files/${file.fileId}`, "POST");
    expect(after.status, await after.clone().text()).toBe(200);
    const readable = await after.json() as { ciphertext: string; representationId: string;
      parentId?: string; nameCiphertext?: string; recipientEnvelope: string };
    expect(readable.representationId).toBe(file.representationId);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM file_representations WHERE file_node_id = ?")
      .bind(file.fileId).first()).toEqual({ count: 1 });
    expect(readable).not.toHaveProperty("parentId");
    expect(readable).not.toHaveProperty("nameCiphertext");
    expect(await openFileContentKeyFromDevice(decodeTreeBytes(readable.recipientEnvelope), second.transport,
      { vaultId: owner.accountId, fileId: file.fileId, contentKeyId: file.contentKeyId,
        contentEpoch: 1, revision: 1, deviceId: second.deviceId })).toEqual(file.saved.fileContentKey);
    const roots = await second.request("/api/private/sharing/roots", "POST");
    expect((await roots.json() as { roots: { status: string }[] }).roots[0]!.status).toBe("ready");
    expect((await second.request(path, "PATCH", completion)).status).toBe(409);
    expect((await second.request(`/api/private/tree/files/${file.fileId}/context`, "POST")).status).toBe(404);
    const scoped = await second.request("/api/private/sharing/scope", "POST", { nodeId: file.fileId, kind: "file" });
    expect(scoped.status, await scoped.clone().text()).toBe(200);
    expect((await scoped.json() as { scope: string; path?: string; parentId?: string }).scope).toBe("direct-file");
    expect((await second.request(`/api/private/tree/directories/${owner.rootId}`, "POST")).status).toBe(404);
    const revoked = await owner.request(`/api/private/sharing/grants/${pending.grantId}`, "DELETE");
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect((await second.request(`/api/private/sharing/direct-files/${file.fileId}`, "POST")).status).toBe(404);
    const job = await env.DB.prepare("SELECT state, barrier_epoch FROM sharing_rotation_jobs WHERE owner_id = ? AND target_node_id = ?")
      .bind(owner.accountId, file.fileId).first<{ state: string; barrier_epoch: number }>();
    expect(job?.state).toBe("pending");
    expect(job?.barrier_epoch).toBeGreaterThanOrEqual(2);
    await env.DB.prepare("UPDATE encryption_devices SET state = 'revoked', revocation_reason = 'test' WHERE id = ?")
      .bind(second.deviceId).run();
    const historical = await owner.request(`/api/private/tree/files/${file.fileId}`, "POST");
    expect(historical.status, await historical.clone().text()).toBe(200);
    expect((await historical.json() as { fileHead: { signerDeviceId: string } }).fileHead.signerDeviceId)
      .toBe(second.deviceId);
  });

  it("a replayed cancellation cannot delete a fresh invitation sharing the old ID", async () => {
    const owner = await account(), recipient = await account();
    const directory = await createDirectory(owner, owner, owner.rootId, owner.rootKey, "Shared folder");
    const first = await inviteDirectory(owner, recipient, directory.childId, directory.key, "Original");
    const cancel = await owner.signedRequest(`/api/private/sharing/shares/${first.shareId}`, "DELETE");
    expect((await cancel()).status).toBe(200);
    const second = await inviteDirectory(owner, recipient, directory.childId, directory.key,
      "Replacement", first.shareId);
    const replay = await cancel();
    expect(replay.status).not.toBe(200);
    const pending = await recipient.request("/api/private/sharing/invitations", "POST");
    expect((await pending.json() as { incoming: { id: string }[] }).incoming).toEqual([
      expect.objectContaining({ id: second.shareId }),
    ]);
  });
  it("accepts with Owner offline after a descendant change, creates Owner-owned descendants signed by Collaborator, and seals on revoke", async () => {
    const owner = await account(), recipient = await account();
    const directory = await createDirectory(owner, owner, owner.rootId, owner.rootKey, "Shared folder");
    const invitation = await inviteDirectory(owner, recipient, directory.childId, directory.key, "Shared folder");
    const pending = await recipient.request("/api/private/sharing/invitations", "POST");
    expect(pending.status).toBe(200);
    const pendingBody = await pending.text();
    expect(pendingBody).not.toContain("Shared folder");
    expect((await recipient.request(`/api/private/tree/directories/${directory.childId}`, "POST")).status).toBe(404);
    // An Owner creates a descendant BEFORE the recipient accepts. This changes
    // the signed structural listing, not the independently stable Directory key.
    await createDirectory(owner, owner, directory.childId, directory.key, "Earlier child");
    const accepted = await recipient.request(`/api/private/sharing/shares/${invitation.shareId}/accept`, "POST",
      { materialRevision: 1 });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect((await accepted.json() as { status: string }).status).toBe("ready");
    const rootsResponse = await recipient.request("/api/private/sharing/roots", "POST");
    expect(rootsResponse.status, await rootsResponse.clone().text()).toBe(200);
    const roots = await rootsResponse.json() as { roots: { grantId: string; labelCiphertext: string;
      capability: { ciphertext: string }; status: string }[] };
    expect(roots.roots).toHaveLength(1);
    expect(roots.roots[0]!.status).toBe("ready");
    expect(await openShareLabel(decodeTreeBytes(roots.roots[0]!.labelCiphertext, 4096),
      recipient.transport, owner.accountId, directory.childId, invitation.labelId, recipient.deviceId)).toBe("Shared folder");
    const decrypted = await openForRecipient(decodeTreeBytes(roots.roots[0]!.capability.ciphertext, 16384),
      recipient.transport, { context: { purpose: "grant", vaultId: owner.accountId, objectId: directory.childId,
        keyId: directory.childId, keyEpoch: 1, revision: 1, recipientId: recipient.deviceId } });
    expect(decrypted).toEqual(directory.key);
    const before = await list(recipient, owner, directory.childId, decrypted);
    const made = await createDirectory(recipient, owner, directory.childId, decrypted,
      "Collaborator child", before);
    const saved = await list(owner, owner, directory.childId, directory.key);
    expect(saved.entries.some((e) => e.nodeId === made.childId)).toBe(true);
    const relation = await env.DB.prepare("SELECT owner_id FROM vault_nodes WHERE id = ?")
      .bind(made.childId).first<{ owner_id: string }>();
    expect(relation?.owner_id).toBe(owner.accountId);
    const signer = await env.DB.prepare("SELECT listing_device_id FROM directories WHERE node_id = ?")
      .bind(directory.childId).first<{ listing_device_id: string }>();
    expect(signer?.listing_device_id).toBe(recipient.deviceId);
    const revoked = await owner.request(`/api/private/sharing/grants/${invitation.grantId}`, "DELETE");
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect((await recipient.request(`/api/private/tree/directories/${directory.childId}`, "POST")).status).toBe(404);
    expect((await recipient.request("/api/private/sharing/roots", "POST")).status).toBe(200);
    await env.DB.prepare("UPDATE encryption_devices SET state = 'revoked', revocation_reason = 'test' WHERE id = ?")
      .bind(recipient.deviceId).run();
    // Old committed signature stays verifiable after both Grant and signing device lose authority.
    const historical = await list(owner, owner, directory.childId, directory.key);
    expect(historical.listingHead!.signerDeviceId).toBe(recipient.deviceId);
    const blocked = await owner.request(`/api/private/tree/directories/${directory.childId}/children`, "PUT", {});
    expect(blocked.status).not.toBe(201);
  });
});
