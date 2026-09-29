import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createSymmetricWriter, openForRecipient, sealToRecipient } from "../../app/crypto/enc-v1";
import { createFileReceivingKey, createFileSave, openFileContentKeyFromDevice } from "../../app/crypto/file-receiving";
import { createChildDirectoryCapability, generateDirectoryCapabilityKey } from "../../app/crypto/vault";
import { signDeviceProof, sessionBindingDigest } from "../../app/device/proof";
import { sealShareLabel, openShareLabel } from "../../app/sharing/label";
import { digestBytes, hex, signOffer, verifyOffer, parseOffer, type Offer } from "../../app/sharing/offer";
import { atomicSqlBatch, sql } from "../../app/db/client.server";
import { reconcileNeedStatements } from "../../app/sharing/needs.server";
import { prepareGrantSeals, type RotationStep } from "../../app/sharing/rotation-client";
import type { FileProvisioningBootstrap } from "../../app/sharing/provisioning-wire";
import { signFileHead, verifyFileHead, assertFileHeadCommitTransition,
  assertExactFileRecipientDescriptors, verifyDirectFileRecipientEnvelope, type FileHeadStatement } from "../../app/tree/file-head";
import { importDeviceKey, prepareFulfillGrants, type FulfillDevice, type FulfillStep,
  type SealOwner } from "./provisioning-fixtures";
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
  const head = await createListingHead(parentKey, actor.signing.privateKey, { epoch: 1,
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
  if (data.listingHead) await openListingHead(key, { epoch: 1, vaultId: owner.accountId, directoryId,
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
  const listingHead = await createListingHead(owner.rootKey, owner.signing.privateKey, { epoch: 1,
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

/** Revocation hard-deletes the Grant and every envelope, label, retained key and need it carried. */
const noResidue = { grants: 0, envelopes: 0, retained: 0, labels: 0, deliveries: 0, needs: 0 };
async function grantResidue(grantId: string) {
  return await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM grants WHERE id = ?1) AS grants,
    (SELECT COUNT(*) FROM grant_device_envelopes WHERE grant_id = ?1) AS envelopes,
    (SELECT COUNT(*) FROM grant_retained_material WHERE grant_id = ?1) AS retained,
    (SELECT COUNT(*) FROM grant_labels WHERE grant_id = ?1) AS labels,
    (SELECT COUNT(*) FROM grant_label_deliveries WHERE grant_id = ?1) AS deliveries,
    (SELECT COUNT(*) FROM provisioning_needs WHERE grant_id = ?1) AS needs`).bind(grantId).first();
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
    // Storage itself refuses an offer signer that is not an active device of the Grant's Owner.
    await expect(env.DB.prepare("UPDATE grant_labels SET signer_device_id = ? WHERE grant_id = ?")
      .bind(otherOwner.deviceId, invitation.grantId).run()).rejects.toThrow();
    expect((await recipient.request(path, "POST")).status).toBe(200);
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
      const folder = await createDirectory(owner, owner, owner.rootId, owner.rootKey, `Folder ${i}`);
      const offer = await inviteDirectory(owner, recipient, folder.childId, folder.key, `Root ${i}`);
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

    const wholeInvocationBudgets = {
      directoryInvite: invitedBudget,
      directoryAccept: acceptedBudget,
      fileInvite: fileInvitedBudget,
      fileAccept: fileAcceptedBudget,
      fileBootstrap: fileBootBudget,
      fileCompleteAfterFinalLabelRead: fileCompleteBudget,
    };
    for (const [operation, budget] of Object.entries(wholeInvocationBudgets)) {
      expect(budget.queries, `${operation}: whole-invocation D1 queries`).toBeLessThanOrEqual(50);
      expect(budget.maxBindings, `${operation}: maximum per-statement D1 bindings`).toBeLessThanOrEqual(100);
    }
    console.info("sharing-256-whole-invocation-budget", JSON.stringify(wholeInvocationBudgets));
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
    expect(await grantResidue(pending.grantId)).toEqual(noResidue);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM file_device_envelopes WHERE recipient_id = ?")
      .bind(second.accountId).first()).toEqual({ count: 0 });
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
    expect(await grantResidue(invitation.grantId)).toEqual(noResidue);
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

describe("Directory permission-change rotation", () => {
  it("re-seals the capability at the new generation under a re-signed offer that roots accept", async () => {
    const owner = await account(), recipient = await account();
    const directory = await createDirectory(owner, owner, owner.rootId, owner.rootKey, "Team");
    const invitation = await inviteDirectory(owner, recipient, directory.childId, directory.key, "Team");
    expect((await recipient.request(`/api/private/sharing/shares/${invitation.shareId}/accept`, "POST",
      { materialRevision: 1 })).status).toBe(200);
    const rootsOf = async () => (await (await recipient.request("/api/private/sharing/roots", "POST")).json() as {
      roots: { grantId: string; status: string; permission: string; generation: number;
        capability?: { ciphertext: string; targetKeyId: string; targetEpoch: number } }[] }).roots[0]!;
    expect(await rootsOf()).toMatchObject({ status: "ready", permission: "read_write", generation: 1 });

    expect((await owner.request(`/api/private/sharing/grants/${invitation.grantId}`, "PATCH",
      { permission: "read_only" })).status).toBe(200);
    // Authority changed at once; the old capability envelope is gone until the Owner re-seals it.
    expect(await rootsOf()).toMatchObject({ status: "provisioning", permission: "read_only", generation: 2 });
    const next = await owner.request(`/api/private/rotations/${directory.childId}/next`, "POST");
    expect(next.status, await next.clone().text()).toBe(200);
    checkBudget(next.headers.get("X-Mdwn-Sharing-Budget"));
    const step = await next.json() as Extract<RotationStep, { step: "grants" }>;
    expect(step).toMatchObject({ step: "grants", mode: "reprovision", epoch: 1 });
    expect(step.grants.map((item) => [item.grantId, item.generation, item.devices.length]))
      .toEqual([[invitation.grantId, 2, 1]]);
    const grants = await prepareGrantSeals({ ownerId: owner.accountId, directoryId: directory.childId,
      key: directory.key, epoch: 1, signer: { deviceId: owner.deviceId, assertionKey: owner.signing.privateKey },
      grants: step.grants });
    const tampered = { ...grants[0]!, envelopes: grants[0]!.envelopes.map((item) => ({ ...item,
      ciphertext: invitation.ciphertext.length ? enc(invitation.ciphertext) : item.ciphertext })) };
    expect((await owner.request(`/api/private/rotations/${directory.childId}/grants`, "PATCH",
      { barrierEpoch: step.barrierEpoch, epoch: 1, grants: [tampered] })).status).toBe(400);
    const done = await owner.request(`/api/private/rotations/${directory.childId}/grants`, "PATCH",
      { barrierEpoch: step.barrierEpoch, epoch: 1, grants });
    expect(done.status, await done.clone().text()).toBe(200);
    checkBudget(done.headers.get("X-Mdwn-Sharing-Budget"));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sharing_rotation_jobs WHERE target_node_id = ?")
      .bind(directory.childId).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM rotation_barriers WHERE target_node_id = ?")
      .bind(directory.childId).first()).toEqual({ n: 0 });

    const ready = await rootsOf();
    expect(ready).toMatchObject({ status: "ready", permission: "read_only", generation: 2 });
    const opened = await openForRecipient(decodeTreeBytes(ready.capability!.ciphertext, 16_384), recipient.transport,
      { context: { purpose: "grant", vaultId: owner.accountId, objectId: directory.childId,
        keyId: directory.childId, keyEpoch: 1, revision: 1, recipientId: recipient.deviceId } });
    expect(opened).toEqual(directory.key);
    const stored = await env.DB.prepare("SELECT offer_bytes FROM grant_labels WHERE grant_id = ?")
      .bind(invitation.grantId).first<{ offer_bytes: ArrayBuffer }>();
    expect(parseOffer(new Uint8Array(stored!.offer_bytes))).toMatchObject({ materialRevision: 2,
      permission: "read_only", targetEpoch: 1 });
  });
});

const sealOwner = (owner: Account): SealOwner => ({ accountId: owner.accountId, deviceId: owner.deviceId,
  assertionKey: owner.signing.privateKey, vaultRoot: owner.vaultRoot });

const directoryCapability = (owner: Account, directoryId: string, key: Uint8Array) => (device: FulfillDevice) =>
  importDeviceKey(device.publicKey).then((publicKey) => sealToRecipient(key, publicKey,
    { purpose: "grant", vaultId: owner.accountId, objectId: directoryId, keyId: directoryId,
      keyEpoch: 1, revision: 1, recipientId: device.deviceId }));

async function countRows(table: string, where: string, ...values: unknown[]): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...values)
    .first<{ n: number }>())!.n;
}

async function addDevice(account: Account, epoch: number): Promise<string> {
  const deviceId = id();
  const transport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const assertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  await env.DB.prepare(`INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key,
    state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, ?, ?, 'active', 'routine', ?, ?)`)
    .bind(deviceId, account.accountId, new Uint8Array(await crypto.subtle.exportKey("raw", transport.publicKey)),
      new Uint8Array(await crypto.subtle.exportKey("raw", assertion.publicKey)), epoch, Date.now()).run();
  return deviceId;
}

describe("ticket 20 grant provisioning fulfillment", () => {
  it("re-seals a Directory Grant for both devices an epoch advance invalidated and refuses an exact replay", async () => {
    const owner = await account(), recipient = await account();
    const directory = await createDirectory(owner, owner, owner.rootId, owner.rootKey, "Fulfil");
    const invite = await inviteDirectory(owner, recipient, directory.childId, directory.key, "Fulfil");
    expect((await recipient.request(`/api/private/sharing/shares/${invite.shareId}/accept`, "POST",
      { materialRevision: 1 })).status).toBe(200);
    const second = await addDevice(recipient, 2);
    recipient.setRegistryEpoch(2);
    // The recipient sees provisioning, and its scope still resolves to an opaque directory grant.
    expect(((await (await recipient.request("/api/private/sharing/roots", "POST")).json()) as {
      roots: { status: string }[] }).roots[0]!.status).toBe("provisioning");
    const scope = await recipient.request("/api/private/sharing/scope", "POST",
      { nodeId: directory.childId, kind: "directory" });
    expect(scope.status, await scope.clone().text()).toBe(200);
    expect((await scope.json() as { scope: string }).scope).toBe("directory-grant");
    // The Owner records one opaque need per active device.
    const list = await owner.request("/api/private/provisioning", "POST");
    expect(list.status, await list.clone().text()).toBe(200);
    expect((await list.json() as { targets: unknown[] }).targets).toEqual([
      expect.objectContaining({ targetId: directory.childId, kind: "directory", needs: 2, devices: 2 })]);
    const needs = await env.DB.prepare(`SELECT grant_id, owner_id, recipient_id, device_id, generation,
      registry_epoch FROM provisioning_needs WHERE grant_id = ? ORDER BY device_id`).bind(invite.grantId).all();
    expect(needs.results.map((row) => (row as { device_id: string }).device_id).sort())
      .toEqual([recipient.deviceId, second].sort());
    expect(needs.results).toEqual(needs.results.map(() => ({ grant_id: invite.grantId, owner_id: owner.accountId,
      recipient_id: recipient.accountId, device_id: expect.any(String), generation: 1, registry_epoch: 2 })));
    // A need carries no name, plaintext, digest or capability: only opaque IDs and counters.
    expect((await env.DB.prepare("PRAGMA table_info(provisioning_needs)").all()).results
      .map((row) => (row as { name: string }).name).sort()).toEqual(["created_at", "device_id", "generation",
        "grant_id", "owner_id", "recipient_id", "registry_epoch", "updated_at"]);
    // Only the Owner fulfills: a recipient gets no scope for the Owner's target and no step.
    expect((await recipient.request(`/api/private/provisioning/${directory.childId}/next`, "POST")).status).toBe(404);
    const next = await owner.request(`/api/private/provisioning/${directory.childId}/next`, "POST");
    expect(next.status, await next.clone().text()).toBe(200);
    const step = await next.json() as Extract<FulfillStep, { step: "grants" }>;
    expect(step).toMatchObject({ step: "grants", targetId: directory.childId, directoryId: directory.childId, epoch: 1 });
    expect(step.grants[0]!.ownerCopy).toBeTruthy();
    expect(step.grants[0]!.devices.map((device) => device.labelDigest)).toEqual([null, null]);
    const grants = await prepareFulfillGrants(sealOwner(owner), step, directoryCapability(owner, directory.childId, directory.key));
    // Only the Owner's own active device may provision: a recipient Grant holder is refused too.
    expect((await recipient.request(`/api/private/provisioning/${directory.childId}/grants`, "PATCH",
      { epoch: 1, grants })).status).toBe(404);
    const done = await owner.request(`/api/private/provisioning/${directory.childId}/grants`, "PATCH",
      { epoch: 1, grants });
    expect(done.status, await done.clone().text()).toBe(200);
    checkBudget(done.headers.get("X-Mdwn-Sharing-Budget"));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM provisioning_needs WHERE grant_id = ?")
      .bind(invite.grantId).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM grant_label_deliveries
      WHERE grant_id = ? AND registry_epoch = 2`).bind(invite.grantId).first()).toEqual({ n: 2 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM grant_device_envelopes
      WHERE grant_id = ? AND registry_epoch = 2 AND generation = 1`).bind(invite.grantId).first()).toEqual({ n: 2 });
    const stored = await env.DB.prepare("SELECT offer_bytes FROM grant_labels WHERE grant_id = ?")
      .bind(invite.grantId).first<{ offer_bytes: ArrayBuffer }>();
    expect(parseOffer(new Uint8Array(stored!.offer_bytes)).devices).toHaveLength(2);
    expect(((await (await recipient.request("/api/private/sharing/roots", "POST")).json()) as {
      roots: { status: string }[] }).roots[0]!.status).toBe("ready");
    // An exact replay is refused and leaves the stored envelope bytes untouched: the server
    // stores only submitted ciphertext, so it never re-seals with a fresh writer or context.
    const before = await env.DB.prepare(`SELECT device_id, ciphertext FROM grant_device_envelopes
      WHERE grant_id = ? ORDER BY device_id`).bind(invite.grantId).all();
    const replay = await owner.request(`/api/private/provisioning/${directory.childId}/grants`, "PATCH",
      { epoch: 1, grants });
    expect(replay.status).toBe(400);
    const after = await env.DB.prepare(`SELECT device_id, ciphertext FROM grant_device_envelopes
      WHERE grant_id = ? ORDER BY device_id`).bind(invite.grantId).all();
    expect(after.results).toEqual(before.results);
  });

  it("re-seals a direct File Grant and its label for a newly enrolled device", async () => {
    const owner = await account(), recipient = await account(), file = await createV2File(owner);
    const invite = await inviteFile(owner, recipient, file);
    expect((await recipient.request(`/api/private/sharing/shares/${invite.shareId}/accept`, "POST",
      { materialRevision: 1 })).status).toBe(200);
    const second = await addDevice(recipient, 2);
    recipient.setRegistryEpoch(2);
    const list = await owner.request("/api/private/provisioning", "POST");
    expect((await list.json() as { targets: { targetId: string }[] }).targets)
      .toEqual([expect.objectContaining({ targetId: file.fileId, kind: "file", needs: 2 })]);
    const step = await (await owner.request(`/api/private/provisioning/${file.fileId}/next`, "POST"))
      .json() as Extract<FulfillStep, { step: "file" }>;
    expect(step.recipients.map((item) => item.deviceId).sort()).toEqual([recipient.deviceId, second].sort());
    const current = await (await owner.request(`/api/private/tree/files/${file.fileId}`, "POST")).json() as {
      fileHead: { bytes: string; digest: string; signature: string }; revision: number; contentKeyId: string;
      keyEpoch: number };
    const before = await verifyFileHead({ bytes: decodeTreeBytes(current.fileHead.bytes, 131_072),
      digest: decodeTreeBytes(current.fileHead.digest, 32), signature: decodeTreeBytes(current.fileHead.signature, 64) },
    { ownerId: owner.accountId, vaultId: owner.accountId, fileId: file.fileId, revision: current.revision,
      signerDeviceId: owner.deviceId, publicKey: new Uint8Array(await crypto.subtle.exportKey(
        "raw", owner.signing.publicKey)) });
    const envelopes = await Promise.all(step.recipients.map(async (item) => ({ deviceId: item.deviceId,
      ciphertext: enc(await sealToRecipient(file.saved.fileContentKey, await importDeviceKey(item.publicKey),
        { purpose: "grant", vaultId: owner.accountId, objectId: file.fileId, keyId: current.contentKeyId,
          keyEpoch: current.keyEpoch, revision: current.revision, recipientId: item.deviceId })) })));
    const nextHead = await signFileHead({ ...before.statement,
      recipientSetVersion: before.statement.recipientSetVersion + 1,
      recipients: await Promise.all(step.recipients.map(async (item) => ({ accountId: item.accountId,
        deviceId: item.deviceId, registryEpoch: item.registryEpoch, grants: item.grants,
        publicKeyDigest: await hash(decodeTreeBytes(item.publicKey, 65)),
        envelopeDigest: await hash(decodeTreeBytes(envelopes.find((entry) => entry.deviceId === item.deviceId)!.ciphertext, 16_384)) }))),
      signerDeviceId: owner.deviceId }, owner.signing.privateKey);
    const envelopeBytes = new Map(envelopes.map((entry) => [entry.deviceId, decodeTreeBytes(entry.ciphertext, 16_384)] as const));
    const grants = await prepareFulfillGrants(sealOwner(owner), step, async (device) => envelopeBytes.get(device.deviceId)!);
    // A rotation barrier for this File interlocks: the recipient-set update is refused, no write.
    await env.DB.prepare("INSERT INTO rotation_barriers (owner_id, target_node_id, epoch) VALUES (?, ?, 2)")
      .bind(owner.accountId, file.fileId).run();
    const headBefore = await env.DB.prepare("SELECT digest, recipient_set_version FROM file_heads WHERE file_node_id = ?")
      .bind(file.fileId).first();
    const blocked = await owner.request(`/api/private/provisioning/${file.fileId}/file`, "PATCH", {
      expectedHeadDigest: current.fileHead.digest, signedHead: wireHead(nextHead), recipientEnvelopes: envelopes, grants });
    expect([404, 409]).toContain(blocked.status);
    expect(await env.DB.prepare("SELECT digest, recipient_set_version FROM file_heads WHERE file_node_id = ?")
      .bind(file.fileId).first()).toEqual(headBefore);
    await env.DB.prepare("DELETE FROM rotation_barriers WHERE owner_id = ? AND target_node_id = ?")
      .bind(owner.accountId, file.fileId).run();
    const done = await owner.request(`/api/private/provisioning/${file.fileId}/file`, "PATCH", {
      expectedHeadDigest: current.fileHead.digest, signedHead: wireHead(nextHead),
      recipientEnvelopes: envelopes, grants });
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM provisioning_needs WHERE grant_id = ?")
      .bind(invite.grantId).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM file_device_envelopes
      WHERE file_node_id = ? AND registry_epoch = 2`).bind(file.fileId).first()).toEqual({ n: 2 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM grant_label_deliveries
      WHERE grant_id = ? AND registry_epoch = 2`).bind(invite.grantId).first()).toEqual({ n: 2 });
    expect(((await (await recipient.request("/api/private/sharing/roots", "POST")).json()) as {
      roots: { status: string }[] }).roots[0]!.status).toBe("ready");
  });

  it("refuses fulfillment while a rotation barrier is up and writes nothing", async () => {
    const owner = await account(), recipient = await account();
    const directory = await createDirectory(owner, owner, owner.rootId, owner.rootKey, "Barrier");
    const invite = await inviteDirectory(owner, recipient, directory.childId, directory.key, "Barrier");
    expect((await recipient.request(`/api/private/sharing/shares/${invite.shareId}/accept`, "POST",
      { materialRevision: 1 })).status).toBe(200);
    await addDevice(recipient, 2);
    recipient.setRegistryEpoch(2);
    await owner.request("/api/private/provisioning", "POST");
    const step = await (await owner.request(`/api/private/provisioning/${directory.childId}/next`, "POST"))
      .json() as Extract<FulfillStep, { step: "grants" }>;
    const grants = await prepareFulfillGrants(sealOwner(owner), step, directoryCapability(owner, directory.childId, directory.key));
    const before = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM grant_device_envelopes WHERE grant_id = ?1) AS envelopes,
      (SELECT COUNT(*) FROM provisioning_needs WHERE grant_id = ?1) AS needs`).bind(invite.grantId).first();
    await env.DB.prepare("INSERT INTO rotation_barriers (owner_id, target_node_id, epoch) VALUES (?, ?, 2)")
      .bind(owner.accountId, directory.childId).run();
    expect((await owner.request(`/api/private/provisioning/${directory.childId}/next`, "POST")).status).toBe(404);
    const refused = await owner.request(`/api/private/provisioning/${directory.childId}/grants`, "PATCH",
      { epoch: 1, grants });
    expect([404, 409]).toContain(refused.status);
    expect(await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM grant_device_envelopes WHERE grant_id = ?1) AS envelopes,
      (SELECT COUNT(*) FROM provisioning_needs WHERE grant_id = ?1) AS needs`).bind(invite.grantId).first())
      .toEqual(before);
    await env.DB.prepare("DELETE FROM rotation_barriers WHERE owner_id = ? AND target_node_id = ?")
      .bind(owner.accountId, directory.childId).run();
  });

  it("leaves a revoked Grant with no need, no material and no way to provision", async () => {
    const owner = await account(), recipient = await account();
    const directory = await createDirectory(owner, owner, owner.rootId, owner.rootKey, "Revoke");
    const invite = await inviteDirectory(owner, recipient, directory.childId, directory.key, "Revoke");
    expect((await recipient.request(`/api/private/sharing/shares/${invite.shareId}/accept`, "POST",
      { materialRevision: 1 })).status).toBe(200);
    await addDevice(recipient, 2);
    recipient.setRegistryEpoch(2);
    await owner.request("/api/private/provisioning", "POST");
    const step = await (await owner.request(`/api/private/provisioning/${directory.childId}/next`, "POST"))
      .json() as Extract<FulfillStep, { step: "grants" }>;
    const grants = await prepareFulfillGrants(sealOwner(owner), step, directoryCapability(owner, directory.childId, directory.key));
    expect((await owner.request(`/api/private/sharing/grants/${invite.grantId}`, "DELETE")).status).toBe(200);
    const refused = await owner.request(`/api/private/provisioning/${directory.childId}/grants`, "PATCH",
      { epoch: 1, grants });
    expect([400, 404, 409]).toContain(refused.status);
    expect(await grantResidue(invite.grantId)).toEqual(noResidue);
    const list = await owner.request("/api/private/provisioning", "POST");
    expect((await list.json() as { targets: { targetId: string }[] }).targets).toEqual([]);
    // The revoked recipient keeps no ready root: withdrawn access is never resurrected.
    const roots = await recipient.request("/api/private/sharing/roots", "POST");
    expect((await roots.json() as { roots: unknown[] }).roots).toEqual([]);
  });

  it("caps one reconcile at 256 eligible rows and stamps the final registry epoch", async () => {
    const owner = await account(), recipient = await account();
    // 200 active devices: within the 1..256 fulfilment bound, so both Grants are eligible and
    // together exceed the 256-row cap. The registry epoch advances once per device insertion.
    for (let start = 0; start < 200; start += 100) {
      const statements = [];
      for (let index = start; index < start + 100; index++) {
        const transport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
        const assertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
        statements.push(env.DB.prepare(`INSERT INTO encryption_devices (id, account_id, transport_public_key,
          assertion_public_key, state, approval_provenance, registry_epoch, created_at)
          VALUES (?, ?, ?, ?, 'active', 'routine', ?, ?)`).bind(id(), recipient.accountId,
          new Uint8Array(await crypto.subtle.exportKey("raw", transport.publicKey)),
          new Uint8Array(await crypto.subtle.exportKey("raw", assertion.publicKey)), index + 2, Date.now()));
      }
      await env.DB.batch(statements);
    }
    const epoch = (await env.DB.prepare("SELECT registry_epoch FROM account_encryption_identities WHERE account_id = ?")
      .bind(recipient.accountId).first<{ registry_epoch: number }>())!.registry_epoch;
    expect(epoch).toBe(201);
    const directory = await createDirectory(owner, owner, owner.rootId, owner.rootKey, "Cap");
    const now = Date.now();
    await env.DB.batch([owner.rootId, directory.childId].map((target) => env.DB.prepare(
      `INSERT INTO grants (id, owner_id, recipient_id, target_node_id, target_kind, permission,
        generation, created_at, updated_at) VALUES (?, ?, ?, ?, 'directory', 'read_only', 1, ?, ?)`)
      .bind(id(), owner.accountId, recipient.accountId, target, now, now)));
    const list = await owner.request("/api/private/provisioning", "POST");
    const targets = (await list.json() as { targets: { targetId: string; needs: number }[] }).targets;
    expect(targets.map((target) => target.targetId).sort()).toEqual([owner.rootId, directory.childId].sort());
    // 400 satisfiable (grant, device) rows, but the single statement inserts at most 256.
    expect(targets.reduce((total, target) => total + target.needs, 0)).toBe(256);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n, MIN(registry_epoch) AS lo, MAX(registry_epoch) AS hi
      FROM provisioning_needs WHERE owner_id = ?`).bind(owner.accountId).first()).toEqual({ n: 256, lo: 201, hi: 201 });
    // A second pass upserts the same 256 rows rather than duplicating or bypassing the cap.
    await owner.request("/api/private/provisioning", "POST");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM provisioning_needs WHERE owner_id = ?")
      .bind(owner.accountId).first()).toEqual({ n: 256 });
  });
});

describe("ticket 20 need reconciliation ordering", () => {
  it("stamps every need with the final registry epoch after recovery's double advance", async () => {
    const owner = await account(), recipient = await account();
    const now = Date.now(), grantId = id();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO grants (id, owner_id, recipient_id, target_node_id, target_kind, permission,
        generation, created_at, updated_at) VALUES (?, ?, ?, ?, 'directory', 'read_only', 1, ?, ?)`)
        .bind(grantId, owner.accountId, recipient.accountId, owner.rootId, now, now),
      env.DB.prepare(`INSERT INTO grant_labels (grant_id, label_id, owner_copy, offer_bytes, offer_digest,
        offer_signature, signer_device_id) VALUES (?, ?, X'01', X'01', zeroblob(32), zeroblob(64), ?)`)
        .bind(grantId, id(), owner.deviceId),
    ]);
    const replacement = id();
    const transport = new Uint8Array(await crypto.subtle.exportKey("raw",
      (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])).publicKey));
    const assertion = new Uint8Array(await crypto.subtle.exportKey("raw",
      (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])).publicKey));
    // Recovery's order in one atomic batch: activate the replacement (advance), tombstone
    // the old device (advance again), then reconcile LAST against the final epoch.
    await atomicSqlBatch(env.DB, [
      sql`INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state,
        approval_provenance, registry_epoch, created_at)
        VALUES (${replacement}, ${recipient.accountId}, ${transport}, ${assertion}, 'active', 'recovery', 2, ${now})`,
      sql`UPDATE encryption_devices SET state = 'tombstoned', revocation_reason = 'recovery'
        WHERE account_id = ${recipient.accountId} AND id != ${replacement} AND state = 'active'`,
      reconcileNeedStatements({ recipientId: recipient.accountId }, now, sql`1 = 1`),
    ]);
    expect(await env.DB.prepare("SELECT registry_epoch FROM account_encryption_identities WHERE account_id = ?")
      .bind(recipient.accountId).first()).toEqual({ registry_epoch: 3 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n, MIN(registry_epoch) AS lo, MAX(registry_epoch) AS hi
      FROM provisioning_needs WHERE grant_id = ?`).bind(grantId).first())
      .toEqual({ n: 1, lo: 3, hi: 3 });
  });
});

describe("ticket 20 partial-label reuse and oversized-Grant isolation", () => {
  it("reuses a current-epoch label delivery and only seals the missing one", async () => {
    const owner = await account(), recipient = await account();
    const directory = await createDirectory(owner, owner, owner.rootId, owner.rootKey, "Reuse");
    const invite = await inviteDirectory(owner, recipient, directory.childId, directory.key, "Reuse");
    // The second device arrives before acceptance: the first keeps a current-epoch delivery.
    const second = await addDevice(recipient, 2);
    recipient.setRegistryEpoch(2);
    const accepted = await recipient.request(`/api/private/sharing/shares/${invite.shareId}/accept`, "POST",
      { materialRevision: 1 });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect((await accepted.json() as { status: string }).status).toBe("ready");
    const first = await env.DB.prepare(`SELECT ciphertext FROM grant_label_deliveries
      WHERE grant_id = ? AND device_id = ?`).bind(invite.grantId, recipient.deviceId)
      .first<{ ciphertext: ArrayBuffer }>();
    expect(first).not.toBeNull();
    expect(await countRows("provisioning_needs", "grant_id = ? AND device_id = ?", invite.grantId, second)).toBe(1);
    expect(await countRows("provisioning_needs", "grant_id = ? AND device_id = ?", invite.grantId,
      recipient.deviceId)).toBe(0);
    await owner.request("/api/private/provisioning", "POST");
    const step = await (await owner.request(`/api/private/provisioning/${directory.childId}/next`, "POST"))
      .json() as Extract<FulfillStep, { step: "grants" }>;
    expect(step.grants[0]!.ownerCopy).toBeTruthy();
    const grants = await prepareFulfillGrants(sealOwner(owner), step,
      directoryCapability(owner, directory.childId, directory.key));
    // The device with a current delivery submits no label; the missing device submits one.
    const kept = grants[0]!.devices.find((item) => item.deviceId === recipient.deviceId) as
      { labelCiphertext: string | null };
    const fresh = grants[0]!.devices.find((item) => item.deviceId === second) as { labelCiphertext: string | null };
    expect(kept.labelCiphertext).toBeNull();
    expect(fresh.labelCiphertext).not.toBeNull();
    expect((await owner.request(`/api/private/provisioning/${directory.childId}/grants`, "PATCH",
      { epoch: 1, grants })).status).toBe(200);
    const after = await env.DB.prepare(`SELECT ciphertext FROM grant_label_deliveries
      WHERE grant_id = ? AND device_id = ?`).bind(invite.grantId, recipient.deviceId)
      .first<{ ciphertext: ArrayBuffer }>();
    // The existing delivery is byte-identical: reused, never re-sealed.
    expect(new Uint8Array(after!.ciphertext)).toEqual(new Uint8Array(first!.ciphertext));
    expect(await countRows("grant_label_deliveries", "grant_id = ? AND registry_epoch = 2", invite.grantId)).toBe(2);
    expect(await countRows("provisioning_needs", "grant_id = ?", invite.grantId)).toBe(0);
  });

  it("does not let an oversized Grant that sorts first starve a normal Grant's needs", async () => {
    const owner = await account(), normal = await account(), oversized = await account();
    const directory = await createDirectory(owner, owner, owner.rootId, owner.rootKey, "Mixed");
    const invite = await inviteDirectory(owner, normal, directory.childId, directory.key, "Mixed");
    expect((await normal.request(`/api/private/sharing/shares/${invite.shareId}/accept`, "POST",
      { materialRevision: 1 })).status).toBe(200);
    await addDevice(normal, 2);
    normal.setRegistryEpoch(2);
    // An oversized Grant (301 active devices) that sorts first is inserted before any reconcile.
    for (let start = 0; start < 301; start += 100) {
      const statements = [];
      for (let index = start; index < start + 100 && index < 301; index++) {
        const transport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
        const assertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
        statements.push(env.DB.prepare(`INSERT INTO encryption_devices (id, account_id, transport_public_key,
          assertion_public_key, state, approval_provenance, registry_epoch, created_at)
          VALUES (?, ?, ?, ?, 'active', 'routine', ?, ?)`).bind(id(), oversized.accountId,
          new Uint8Array(await crypto.subtle.exportKey("raw", transport.publicKey)),
          new Uint8Array(await crypto.subtle.exportKey("raw", assertion.publicKey)), index + 2, Date.now()));
      }
      await env.DB.batch(statements);
    }
    const oversizedGrant = "00000000-0000-7000-8000-000000000000", now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO grants (id, owner_id, recipient_id, target_node_id, target_kind, permission,
        generation, created_at, updated_at) VALUES (?, ?, ?, ?, 'directory', 'read_only', 1, ?, ?)`)
        .bind(oversizedGrant, owner.accountId, oversized.accountId, directory.childId, now, now),
      env.DB.prepare(`INSERT INTO grant_labels (grant_id, label_id, owner_copy, offer_bytes, offer_digest,
        offer_signature, signer_device_id) VALUES (?, ?, X'01', X'01', zeroblob(32), zeroblob(64), ?)`)
        .bind(oversizedGrant, id(), owner.deviceId),
    ]);
    // One reconcile: the oversized Grant is outside the 1..256 fulfilment bound, so it records no
    // needs and cannot consume the 256-row cap; the normal Grant still gets its rows.
    await owner.request("/api/private/provisioning", "POST");
    expect(await countRows("provisioning_needs", "grant_id = ?", invite.grantId)).toBeGreaterThan(0);
    expect(await countRows("provisioning_needs", "grant_id = ?", oversizedGrant)).toBe(0);
    const next = await owner.request(`/api/private/provisioning/${directory.childId}/next`, "POST");
    expect(next.status, await next.clone().text()).toBe(200);
    const step = await next.json() as Extract<FulfillStep, { step: "grants" }>;
    // Only the normal Grant is offered; the oversized one is skipped, not fatal.
    expect(step.grants.map((grant) => grant.grantId)).toEqual([invite.grantId]);
    const grants = await prepareFulfillGrants(sealOwner(owner), step,
      directoryCapability(owner, directory.childId, directory.key));
    expect((await owner.request(`/api/private/provisioning/${directory.childId}/grants`, "PATCH",
      { epoch: 1, grants })).status).toBe(200);
    expect(await countRows("provisioning_needs", "grant_id = ?", invite.grantId)).toBe(0);
    expect(await countRows("provisioning_needs", "grant_id = ?", oversizedGrant)).toBe(0);
    expect(await countRows("grant_device_envelopes", "grant_id = ?", oversizedGrant)).toBe(0);
    // No fulfilable work remains, so a run terminates instead of retrying the oversized Grant.
    expect((await owner.request(`/api/private/provisioning/${directory.childId}/next`, "POST")).status).toBe(404);
  });
});
