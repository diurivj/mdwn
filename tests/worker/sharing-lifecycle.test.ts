import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createSymmetricWriter, openForRecipient, openSymmetric, sealToRecipient } from "../../app/crypto/enc-v1";
import { createChildDirectoryCapability, generateDirectoryCapabilityKey } from "../../app/crypto/vault";
import { signDeviceProof, sessionBindingDigest } from "../../app/device/proof";
import { sealShareLabel, openShareLabel } from "../../app/sharing/label";
import { hex, signOffer, digestBytes, type Offer } from "../../app/sharing/offer";
import { createListingHead, openListingHead, type SealedEntry } from "../../app/tree/listing";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/tree/wire";
import { seedNormalSession } from "./auth-fixtures";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[]; SESSION_COOKIE_SECRET: string } } }
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const id = () => { const v = crypto.randomUUID(); return `${v.slice(0, 14)}7${v.slice(15)}`; };
const digest = async (v: Uint8Array) => hex(await digestBytes(v));
const enc = encodeTreeBytes;

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
  async function request(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", value?: object) {
    const url = `https://mdwn.test${path}`, body = value === undefined ? undefined : JSON.stringify(value);
    const proof = await signDeviceProof(signing.privateKey, { sessionBinding: await sessionBindingDigest(session.id),
      deviceId, registryEpoch: 1, method, url, body });
    return SELF.fetch(url, { method, headers: { cookie: session.cookie, origin: "https://mdwn.test",
      "X-Mdwn-Device-Proof": JSON.stringify(proof), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body } : {}) });
  }
  return { accountId, shareId, rootId, deviceId, signing, transport, publicKey,
    rootKey: generateDirectoryCapabilityKey(), vaultRoot: generateDirectoryCapabilityKey(), request };
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
  name: string) {
  const prep = await owner.request("/api/private/sharing/target", "POST", {
    targetId, kind: "directory", recipientId: recipient.accountId });
  expect(prep.status, await prep.clone().text()).toBe(200);
  const coordinates = await prep.json() as { targetKeyId: string; targetEpoch: number;
    revision: number; headDigest: string };
  const grantId = id(), shareId = id(), labelId = id();
  const labels = await sealShareLabel(name, owner.accountId, targetId, labelId,
    [{ deviceId: recipient.deviceId, publicKey: recipient.transport.publicKey }], owner.vaultRoot);
  const ciphertext = await sealToRecipient(key, recipient.transport.publicKey, {
    purpose: "grant", vaultId: owner.accountId, objectId: targetId, keyId: coordinates.targetKeyId,
    keyEpoch: coordinates.targetEpoch, revision: 1, recipientId: recipient.deviceId });
  const contentDigest = await digest(ciphertext), labelDigest = await digest(labels.deliveries[0]!.envelope);
  const offer: Offer = { shareId, grantId, ownerId: owner.accountId, recipientId: recipient.accountId,
    targetId, kind: "directory", permission: "read_write", materialRevision: 1,
    targetKeyId: coordinates.targetKeyId, targetEpoch: coordinates.targetEpoch,
    contentRevision: coordinates.revision, headDigest: hex(decodeTreeBytes(coordinates.headDigest, 32)),
    labelId, ownerCopyDigest: await digest(labels.ownerCopy), registryEpoch: 1,
    devices: [{ accountId: recipient.accountId, deviceId: recipient.deviceId, registryEpoch: 1,
      publicKeyDigest: await digest(recipient.publicKey), contentDigest, labelDigest }],
    candidateDigest: null, signerDeviceId: owner.deviceId };
  const signed = await signOffer(offer, owner.signing.privateKey);
  const sent = await owner.request("/api/private/sharing/shares", "PUT", {
    ...offer, ownerCopy: enc(labels.ownerCopy), offerBytes: enc(signed.bytes),
    offerDigest: enc(signed.digest), offerSignature: enc(signed.signature), candidate: null,
    deliveries: [{ deviceId: recipient.deviceId, registryEpoch: 1, publicKey: enc(recipient.publicKey),
      ciphertext: enc(ciphertext), labelCiphertext: enc(labels.deliveries[0]!.envelope) }] });
  expect(sent.status, await sent.clone().text()).toBe(201);
  return { grantId, shareId, labelId, key, ciphertext, label: labels.deliveries[0]!.envelope };
}

describe("private sharing lifecycle through the built Worker", () => {
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
