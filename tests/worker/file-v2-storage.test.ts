import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createSymmetricWriter, openSymmetric, sealToRecipient } from "../../app/crypto/enc-v1";
import { createFileReceivingKey, createFileSave, openFileContentKeyFromReceiving, openFileReceivingKey } from "../../app/crypto/file-receiving";
import { createChildDirectoryCapability, createFileRepresentation, decodeFileRepresentation, generateDirectoryCapabilityKey } from "../../app/crypto/vault";
import { signDeviceProof, sessionBindingDigest } from "../../app/device/proof";
import { signFileHead, verifyFileHead, verifyFileParentEnvelope, verifyFileRepresentation,
  verifyDirectFileRecipientEnvelope,
  type FileHeadStatement } from "../../app/tree/file-head";
import { createListingHead, openListingHead, type SealedEntry } from "../../app/tree/listing";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/tree/wire";
import { seedNormalSession } from "./auth-fixtures";
import { account as seedRecipient } from "./sharing-fixtures";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[]; SESSION_COOKIE_SECRET: string } } }
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const id = () => { const u = crypto.randomUUID(); return `${u.slice(0, 14)}7${u.slice(15)}`; };
const encode = encodeTreeBytes;
const hash = async (v: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(v)));
const wire = (head: { bytes: Uint8Array; digest: Uint8Array; signature: Uint8Array }) =>
  ({ bytes: encode(head.bytes), digest: encode(head.digest), signature: encode(head.signature) });

async function setup() {
  const ownerId = id(), rootId = id(), deviceId = id(), credentialId = id(), now = Date.now();
  const assertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const transport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(ownerId, id(), now, now),
    env.DB.prepare("INSERT INTO passkeys (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at) VALUES (?, ?, X'01', 0, '[]', 'singleDevice', 0, ?, ?)").bind(credentialId, ownerId, now, now),
    env.DB.prepare("INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)").bind(ownerId, rootId),
    env.DB.prepare("INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, ?, ?, 'active', 'signup', 1, ?)").bind(deviceId, ownerId,
      new Uint8Array(await crypto.subtle.exportKey("raw", transport.publicKey)),
      new Uint8Array(await crypto.subtle.exportKey("raw", assertion.publicKey)), now),
  ]);
  const session = await seedNormalSession({ accountId: ownerId, credentialIds: [credentialId] });
  await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(deviceId, session.id).run();
  const rootKey = generateDirectoryCapabilityKey();
  async function request(path: string, method: "POST" | "PUT" | "PATCH", value?: object, proofId?: string) {
    const url = `https://mdwn.test${path}`, body = value === undefined ? undefined : JSON.stringify(value);
    const proof = await signDeviceProof(assertion.privateKey, { sessionBinding: await sessionBindingDigest(session.id),
      deviceId, registryEpoch: 1, method, url, body, ...(proofId ? { proofId } : {}) });
    return SELF.fetch(url, { method, headers: { cookie: session.cookie, origin: "https://mdwn.test",
      "X-Mdwn-Device-Proof": JSON.stringify(proof), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body === undefined ? {} : { body }) });
  }
  const fileId = id(), representationId = id();
  const writer = await createSymmetricWriter(rootKey);
  const nameCiphertext = encode(await writer.seal(new TextEncoder().encode("opaque.md"), {
    purpose: "directory-metadata", vaultId: ownerId, objectId: fileId, keyId: rootId, keyEpoch: 1, revision: 1 }));
  const orderCiphertext = encode(await writer.seal(new TextEncoder().encode("first"), {
    purpose: "directory-metadata", vaultId: ownerId, objectId: fileId, keyId: rootId, keyEpoch: 1, revision: 1 }));
  const content = await createFileRepresentation(rootKey, { markdown: "initial", metadata: new Uint8Array() },
    { vaultId: ownerId, fileId });
  const entry: SealedEntry = { nodeId: fileId, kind: "file", nameCiphertext, orderCiphertext,
    keyEnvelope: encode(content.fileContentKeyEnvelope) };
  const listingHead = await createListingHead(rootKey, assertion.privateKey, { vaultId: ownerId,
    directoryId: rootId, deviceId, revision: 2, entries: [entry] });
  const created = await request(`/api/private/tree/directories/${rootId}/children`, "PUT", {
    ...entry, expectedRevision: 1, representation: { id: representationId, contentKeyId: fileId,
      keyEpoch: 1, revision: 1, ciphertext: encode(content.contentEnvelope) }, listingHead });
  expect(created.status, await created.clone().text()).toBe(201);
  return { ownerId, rootId, deviceId, assertion, rootKey, fileId, entry, representationId, content, request };
}

async function prepareMigration(f: Awaited<ReturnType<typeof setup>>) {
  const listing = await (await f.request(`/api/private/tree/directories/${f.rootId}`, "POST")).json() as {
    entriesRevision: number; entries: SealedEntry[]; listingHead: { ciphertext: string; digest: string; signature: string;
      signerDeviceId: string; signerPublicKey: string } };
  await openListingHead(f.rootKey, { vaultId: f.ownerId, directoryId: f.rootId,
    revision: listing.entriesRevision, entries: listing.entries,
    head: { ...listing.listingHead, signerPublicKey: decodeTreeBytes(listing.listingHead.signerPublicKey, 65) } });
  const prior = await (await f.request(`/api/private/tree/files/${f.fileId}`, "POST")).json() as {
    revision: number; representationId: string; contentKeyId: string; keyEpoch: number; ciphertext: string;
    keyEnvelope: string };
  const currentKey = await openSymmetric(decodeTreeBytes(prior.keyEnvelope), f.rootKey, { context: {
    purpose: "file-content-key", vaultId: f.ownerId, objectId: f.fileId,
    keyId: prior.contentKeyId, keyEpoch: prior.keyEpoch, revision: prior.revision } });
  const receivingKeyId = id();
  const receiver = await createFileReceivingKey(f.rootKey, { vaultId: f.ownerId, fileId: f.fileId,
    receivingKeyId, receivingEpoch: 1, wrapRevision: listing.entriesRevision + 1 });
  const dynamic = await sealToRecipient(currentKey, receiver.keyPair.publicKey, { purpose: "file-content-key",
    vaultId: f.ownerId, objectId: f.fileId, keyId: prior.contentKeyId,
    keyEpoch: 1, revision: prior.revision, recipientId: receivingKeyId });
  const statement: FileHeadStatement = { ownerId: f.ownerId, vaultId: f.ownerId, fileId: f.fileId,
    revision: prior.revision, contentKey: { id: prior.contentKeyId, epoch: 1 },
    receivingKey: { id: receivingKeyId, epoch: 1, publicKeyDigest: receiver.publicKeyDigest },
    representation: { id: prior.representationId, digest: await hash(decodeTreeBytes(prior.ciphertext, 524_288)) },
    parentEnvelopeDigest: await hash(dynamic), recipientSetVersion: 1, recipients: [],
    publication: { status: "none" }, signerDeviceId: f.deviceId };
  const signed = await signFileHead(statement, f.assertion.privateKey);
  const entries: SealedEntry[] = listing.entries.map((entry) => entry.nodeId === f.fileId ? {
    ...entry, encoding: "receiving-file", keyEnvelope: encode(receiver.privateKeyEnvelope),
    receivingKeyId, receivingEpoch: 1, wrapRevision: listing.entriesRevision + 1 } :
    { ...entry, encoding: entry.kind === "file" ? "legacy-file" : "directory" });
  const head = await createListingHead(f.rootKey, f.assertion.privateKey, { vaultId: f.ownerId,
    directoryId: f.rootId, deviceId: f.deviceId, revision: listing.entriesRevision + 1, version: 2, entries });
  return { value: { expectedEntriesRevision: listing.entriesRevision, expectedRevision: 1, expectedEntry: {
    nameCiphertext: f.entry.nameCiphertext, orderCiphertext: f.entry.orderCiphertext,
    keyEnvelope: f.entry.keyEnvelope }, representation: { id: prior.representationId,
      contentKeyId: prior.contentKeyId, keyEpoch: 1, ciphertext: prior.ciphertext },
    receivingKeyId, receivingEpoch: 1, wrapRevision: listing.entriesRevision + 1,
    receivingPublicKey: encode(receiver.publicKey),
    receivingWrapper: encode(receiver.privateKeyEnvelope), parentEnvelope: encode(dynamic),
    recipientEnvelopes: [], signedHead: wire(signed), listingHead: head, listingVersion: 1 },
  receiver, prior, signed, currentKey };
}

describe("v2 File storage over proof-guarded resources", () => {
  it("commits mixed tagged legacy and receiving entries without v1 verification fallback", async () => {
    const f = await setup(), secondId = id(), secondRepresentationId = id();
    const writer = await createSymmetricWriter(f.rootKey);
    const metadata = { purpose: "directory-metadata" as const, vaultId: f.ownerId,
      objectId: secondId, keyId: f.rootId, keyEpoch: 1, revision: 1 };
    const second = await createFileRepresentation(f.rootKey, { markdown: "other", metadata: new Uint8Array() },
      { vaultId: f.ownerId, fileId: secondId });
    const entry: SealedEntry = { nodeId: secondId, kind: "file",
      nameCiphertext: encode(await writer.seal(new TextEncoder().encode("other.md"), metadata)),
      orderCiphertext: encode(await writer.seal(new TextEncoder().encode("second"), metadata)),
      keyEnvelope: encode(second.fileContentKeyEnvelope) };
    const head = await createListingHead(f.rootKey, f.assertion.privateKey, { vaultId: f.ownerId,
      directoryId: f.rootId, deviceId: f.deviceId, revision: 3, entries: [f.entry, entry] });
    const created = await f.request(`/api/private/tree/directories/${f.rootId}/children`, "PUT", {
      ...entry, expectedRevision: 2, representation: { id: secondRepresentationId,
        contentKeyId: secondId, keyEpoch: 1, revision: 1, ciphertext: encode(second.contentEnvelope) }, listingHead: head });
    expect(created.status, await created.clone().text()).toBe(201);
    const migration = await prepareMigration(f);
    expect((await f.request(`/api/private/tree/files/${f.fileId}/migrate`, "PATCH", migration.value)).status).toBe(200);
    const listing = await (await f.request(`/api/private/tree/directories/${f.rootId}`, "POST")).json() as {
      entriesRevision: number; listingVersion: number; entries: SealedEntry[]; listingHead: {
        ciphertext: string; digest: string; signature: string; signerDeviceId: string; signerPublicKey: string } };
    expect(listing.entries.map((item) => [item.nodeId, item.encoding]).sort()).toEqual([
      [f.fileId, "receiving-file"], [secondId, "legacy-file"]].sort());
    await openListingHead(f.rootKey, { vaultId: f.ownerId, directoryId: f.rootId, version: 2,
      revision: 4, entries: listing.entries, head: { ...listing.listingHead,
        signerPublicKey: decodeTreeBytes(listing.listingHead.signerPublicKey, 65) } });
    await expect(openListingHead(f.rootKey, { vaultId: f.ownerId, directoryId: f.rootId, version: 1,
      revision: 4, entries: listing.entries, head: { ...listing.listingHead,
        signerPublicKey: decodeTreeBytes(listing.listingHead.signerPublicKey, 65) } })).rejects.toThrow();
    expect((await f.request(`/api/private/tree/files/${secondId}`, "POST")).status).toBe(200);
    await env.DB.prepare("UPDATE directory_entries SET key_envelope = X'01' WHERE child_node_id = ?")
      .bind(secondId).run();
    const forged = await (await f.request(`/api/private/tree/directories/${f.rootId}`, "POST")).json() as {
      entries: SealedEntry[] };
    await expect(openListingHead(f.rootKey, { vaultId: f.ownerId, directoryId: f.rootId, version: 2,
      revision: 4, entries: forged.entries, head: { ...listing.listingHead,
        signerPublicKey: decodeTreeBytes(listing.listingHead.signerPublicKey, 65) } })).rejects.toThrow();
  });

  it("atomically migrates a verified full v1 listing and preserves the File's current bytes", async () => {
    const f = await setup(), migration = await prepareMigration(f);
    const migrated = await f.request(`/api/private/tree/files/${f.fileId}/migrate`, "PATCH", migration.value);
    expect(migrated.status, await migrated.clone().text()).toBe(200);
    const listed = await (await f.request(`/api/private/tree/directories/${f.rootId}`, "POST")).json() as {
      listingVersion: number; entriesRevision: number; entries: SealedEntry[]; listingHead: {
        ciphertext: string; digest: string; signature: string; signerDeviceId: string; signerPublicKey: string } };
    expect([listed.listingVersion, listed.entriesRevision, listed.entries[0]?.encoding]).toEqual([2, 3, "receiving-file"]);
    await openListingHead(f.rootKey, { vaultId: f.ownerId, directoryId: f.rootId,
      version: 2, revision: 3, entries: listed.entries,
      head: { ...listed.listingHead, signerPublicKey: decodeTreeBytes(listed.listingHead.signerPublicKey, 65) } });
    const read = await (await f.request(`/api/private/tree/files/${f.fileId}`, "POST")).json() as {
      revision: number; representationId: string; ciphertext: string; keyEnvelope: string; parentEnvelope: string;
      fileHead: { bytes: string; digest: string; signature: string; signerDeviceId: string; signerPublicKey: string } };
    expect([read.revision, read.representationId]).toEqual([1, f.representationId]);
    const verified = await verifyFileHead({ bytes: decodeTreeBytes(read.fileHead.bytes, 131_072),
      digest: decodeTreeBytes(read.fileHead.digest, 32), signature: decodeTreeBytes(read.fileHead.signature, 64) }, {
      ownerId: f.ownerId, vaultId: f.ownerId, fileId: f.fileId, signerDeviceId: f.deviceId,
      publicKey: decodeTreeBytes(read.fileHead.signerPublicKey, 65), revision: 1 });
    await verifyFileRepresentation(verified, f.representationId, decodeTreeBytes(read.ciphertext, 524_288));
    await verifyFileParentEnvelope(verified, decodeTreeBytes(read.parentEnvelope));
    const pair = await openFileReceivingKey(decodeTreeBytes(read.keyEnvelope), f.rootKey, {
      vaultId: f.ownerId, fileId: f.fileId, receivingKeyId: migration.receiver.receivingKeyId,
      receivingEpoch: 1, wrapRevision: 3, publicKey: migration.receiver.publicKey });
    const key = await openFileContentKeyFromReceiving(decodeTreeBytes(read.parentEnvelope), pair, {
      vaultId: f.ownerId, fileId: f.fileId, contentKeyId: f.fileId, contentEpoch: 1, revision: 1,
      receivingKeyId: migration.receiver.receivingKeyId });
    expect(decodeFileRepresentation(await openSymmetric(decodeTreeBytes(read.ciphertext, 524_288), key, {
      context: { purpose: "file-content", vaultId: f.ownerId, objectId: f.fileId,
        keyId: f.fileId, keyEpoch: 1, revision: 1 } })).markdown).toBe("initial");
    expect((await f.request(`/api/private/tree/files/${f.fileId}/migrate`, "PATCH", migration.value)).status).toBe(404);
  });

  it("saves a fresh v2 key without changing the structural listing, and denies a replay", async () => {
    const f = await setup(), migration = await prepareMigration(f);
    expect((await f.request(`/api/private/tree/files/${f.fileId}/migrate`, "PATCH", migration.value)).status).toBe(200);
    const context = await (await f.request(`/api/private/tree/files/${f.fileId}/context`, "POST")).json() as {
      ownerId: string; fileId: string; recipientSetVersion: number; receivingPublicKey: string;
      currentHead: { digest: string }; recipients: unknown[] };
    expect(Object.keys(context).sort()).toEqual(["currentHead", "fileId", "ownerId", "receivingPublicKey",
      "recipientSetVersion", "recipients", "signerProvenance"].sort());
    const keyId = id(), representationId = id();
    const fresh = await createFileSave({ markdown: "saved", metadata: new Uint8Array() },
      decodeTreeBytes(context.receivingPublicKey, 65), { vaultId: f.ownerId, fileId: f.fileId,
        receivingKeyId: migration.receiver.receivingKeyId, receivingEpoch: 1,
        publicKeyDigest: migration.receiver.publicKeyDigest },
      { vaultId: f.ownerId, fileId: f.fileId, contentKeyId: keyId, contentEpoch: 2, revision: 2 }, []);
    const signed = await signFileHead({ ownerId: f.ownerId, vaultId: f.ownerId, fileId: f.fileId,
      revision: 2, contentKey: { id: keyId, epoch: 2 },
      receivingKey: { id: migration.receiver.receivingKeyId, epoch: 1,
        publicKeyDigest: migration.receiver.publicKeyDigest },
      representation: { id: representationId, digest: await hash(fresh.contentEnvelope) },
      parentEnvelopeDigest: await hash(fresh.parentEnvelope), recipientSetVersion: 1,
      recipients: [], publication: { status: "none" }, signerDeviceId: f.deviceId }, f.assertion.privateKey);
    const save = { expectedHeadDigest: context.currentHead.digest, expectedRevision: 1,
      expectedRecipientSetVersion: 1, parentEnvelope: encode(fresh.parentEnvelope), recipientEnvelopes: [],
      representation: { id: representationId, contentKeyId: keyId, keyEpoch: 2, revision: 2,
        ciphertext: encode(fresh.contentEnvelope) }, signedHead: wire(signed) };
    const response = await f.request(`/api/private/tree/files/${f.fileId}`, "PATCH", save);
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await f.request(`/api/private/tree/files/${f.fileId}`, "PATCH", save)).status).toBe(409);
    const listing = await (await f.request(`/api/private/tree/directories/${f.rootId}`, "POST")).json() as {
      entriesRevision: number; entries: SealedEntry[] };
    expect([listing.entriesRevision, listing.entries[0]?.keyEnvelope]).toEqual([3, migration.value.receivingWrapper]);
    const read = await (await f.request(`/api/private/tree/files/${f.fileId}`, "POST")).json() as {
      revision: number; ciphertext: string; representationId: string };
    expect([read.revision, read.representationId]).toEqual([2, representationId]);
    expect(decodeFileRepresentation(await openSymmetric(decodeTreeBytes(read.ciphertext, 524_288), fresh.fileContentKey,
      { context: fresh.contentContext })).markdown).toBe("saved");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM file_representations WHERE file_node_id = ?")
      .bind(f.fileId).first()).toEqual({ count: 1 });
  });

  it("rejects a tampered or stale migration without advancing File or structural heads", async () => {
    const f = await setup(), migration = await prepareMigration(f);
    const route = `/api/private/tree/files/${f.fileId}/migrate`;
    const tampered = await f.request(route, "PATCH", { ...migration.value,
      parentEnvelope: migration.value.receivingWrapper });
    expect(tampered.status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM file_heads WHERE file_node_id = ?")
      .bind(f.fileId).first()).toEqual({ count: 0 });
    // Another structural commit wins the parent CAS while the stale browser is sealing.
    const sibling = id(), writer = await createSymmetricWriter(f.rootKey);
    const meta = { purpose: "directory-metadata" as const, vaultId: f.ownerId,
      objectId: sibling, keyId: f.rootId, keyEpoch: 1, revision: 1 };
    const child = { nodeId: sibling, kind: "directory" as const,
      nameCiphertext: encode(await writer.seal(new TextEncoder().encode("new"), meta)),
      orderCiphertext: encode(await writer.seal(new TextEncoder().encode("after"), meta)),
      keyEnvelope: encode((await createChildDirectoryCapability(f.rootKey,
        { vaultId: f.ownerId, parentDirectoryId: f.rootId, childDirectoryId: sibling })).envelope),
      expectedRevision: 2 };
    const v1Head = await createListingHead(f.rootKey, f.assertion.privateKey, { vaultId: f.ownerId,
      directoryId: f.rootId, deviceId: f.deviceId, revision: 3,
      entries: [f.entry, child] });
    expect((await f.request(`/api/private/tree/directories/${f.rootId}/children`, "PUT",
      { ...child, listingHead: v1Head })).status).toBe(201);
    expect((await f.request(route, "PATCH", migration.value)).status).toBe(409);
    expect(await env.DB.prepare("SELECT entries_revision, listing_version FROM directories WHERE node_id = ?")
      .bind(f.rootId).first()).toEqual({ entries_revision: 3, listing_version: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM file_heads WHERE file_node_id = ?")
      .bind(f.fileId).first()).toEqual({ count: 0 });
  });

  it("rolls back a failed representation insert after the guarded witness", async () => {
    const f = await setup(), other = await setup(), migration = await prepareMigration(f);
    expect((await f.request(`/api/private/tree/files/${f.fileId}/migrate`, "PATCH", migration.value)).status).toBe(200);
    const before = await (await f.request(`/api/private/tree/files/${f.fileId}`, "POST")).json() as {
      revision: number; representationId: string; fileHead: { digest: string } };
    const keyId = id();
    const fresh = await createFileSave({ markdown: "should roll back", metadata: new Uint8Array() },
      migration.receiver.publicKey, { vaultId: f.ownerId, fileId: f.fileId,
        receivingKeyId: migration.receiver.receivingKeyId, receivingEpoch: 1,
        publicKeyDigest: migration.receiver.publicKeyDigest },
      { vaultId: f.ownerId, fileId: f.fileId, contentKeyId: keyId, contentEpoch: 2, revision: 2 }, []);
    const signed = await signFileHead({ ownerId: f.ownerId, vaultId: f.ownerId, fileId: f.fileId,
      revision: 2, contentKey: { id: keyId, epoch: 2 },
      receivingKey: { id: migration.receiver.receivingKeyId, epoch: 1,
        publicKeyDigest: migration.receiver.publicKeyDigest },
      representation: { id: other.representationId, digest: await hash(fresh.contentEnvelope) },
      parentEnvelopeDigest: await hash(fresh.parentEnvelope), recipientSetVersion: 1,
      recipients: [], publication: { status: "none" }, signerDeviceId: f.deviceId }, f.assertion.privateKey);
    const attempted = await f.request(`/api/private/tree/files/${f.fileId}`, "PATCH", {
      expectedHeadDigest: before.fileHead.digest, expectedRevision: 1, expectedRecipientSetVersion: 1,
      parentEnvelope: encode(fresh.parentEnvelope), recipientEnvelopes: [],
      representation: { id: other.representationId, contentKeyId: keyId, keyEpoch: 2,
        revision: 2, ciphertext: encode(fresh.contentEnvelope) }, signedHead: wire(signed) });
    expect(attempted.status).toBe(400);
    const after = await (await f.request(`/api/private/tree/files/${f.fileId}`, "POST")).json() as typeof before;
    expect(after.fileHead.digest).toBe(before.fileHead.digest);
    expect([after.revision, after.representationId]).toEqual([1, f.representationId]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM file_write_witnesses WHERE file_node_id = ?")
      .bind(f.fileId).first()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM file_representations WHERE file_node_id = ?")
      .bind(f.fileId).first()).toEqual({ count: 1 });
  });

  it("pins pending Share device material to its precise offer revision", async () => {
    const f = await setup(), recipient = await seedRecipient(), migration = await prepareMigration(f);
    expect((await f.request(`/api/private/tree/files/${f.fileId}/migrate`, "PATCH", migration.value)).status).toBe(200);
    const shareId = id(), now = Date.now(), grantId = id(), targetKeyId = id();
    await env.DB.prepare(`INSERT INTO shares (id, owner_id, recipient_id, target_node_id, target_kind,
      permission, created_at) VALUES (?, ?, ?, ?, 'file', 'read_only', ?)`)
      .bind(shareId, f.ownerId, recipient.accountId, f.fileId, now).run();
    await env.DB.prepare(`INSERT INTO share_material (share_id, material_revision, target_key_id, target_epoch,
      head_digest, registry_epoch, anticipated_grant_id) VALUES (?, 1, ?, 1, ?, 1, ?)`)
      .bind(shareId, targetKeyId, migration.signed.digest, grantId).run();
    const insert = async (materialRevision: number) => env.DB.prepare(`INSERT INTO share_device_material
      (share_id, material_revision, device_id, registry_epoch, public_key_digest, ciphertext, digest)
      VALUES (?, ?, ?, 1, ?, X'01', ?)`).bind(shareId, materialRevision, recipient.device.deviceId,
        await hash(new Uint8Array([1])), await hash(new Uint8Array([1]))).run();
    await insert(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM grants WHERE id = ?")
      .bind(grantId).first()).toEqual({ count: 0 }); // Pending offers do not grant access.
    await expect(env.DB.prepare("UPDATE share_material SET material_revision = 2 WHERE share_id = ?")
      .bind(shareId).run()).rejects.toThrow();
    await env.DB.prepare("DELETE FROM share_device_material WHERE share_id = ?").bind(shareId).run();
    await env.DB.prepare("UPDATE share_material SET material_revision = 2 WHERE share_id = ?")
      .bind(shareId).run();
    await expect(insert(1)).rejects.toThrow();
    await insert(2);
  });

  it("seals the exact direct recipient set and permits a parent-free collaborator save", async () => {
    const f = await setup(), migration = await prepareMigration(f);
    expect((await f.request(`/api/private/tree/files/${f.fileId}/migrate`, "PATCH", migration.value)).status).toBe(200);
    const recipientId = id(), recipientDeviceId = id(), credentialId = id(), now = Date.now();
    const assertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const transport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", transport.publicKey));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .bind(recipientId, id(), now, now),
      env.DB.prepare("INSERT INTO passkeys (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at) VALUES (?, ?, X'01', 0, '[]', 'singleDevice', 0, ?, ?)")
        .bind(credentialId, recipientId, now, now),
      env.DB.prepare("INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)")
        .bind(recipientId, id()),
      env.DB.prepare("INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, ?, ?, 'active', 'signup', 1, ?)")
        .bind(recipientDeviceId, recipientId, publicKey,
          new Uint8Array(await crypto.subtle.exportKey("raw", assertion.publicKey)), now),
    ]);
    const session = await seedNormalSession({ accountId: recipientId, credentialIds: [credentialId] });
    await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(recipientDeviceId, session.id).run();
    const grantId = id();
    await env.DB.prepare(`INSERT INTO grants (id, owner_id, recipient_id, target_node_id, target_kind, permission,
      generation, created_at, updated_at) VALUES (?, ?, ?, ?, 'file', 'read_write', 1, ?, ?)`)
      .bind(grantId, f.ownerId, recipientId, f.fileId, now, now).run();
    const path = `/api/private/tree/files/${f.fileId}`;
    async function recipientRequest(route: string, method: "POST" | "PATCH", value?: object) {
      const url = `https://mdwn.test${route}`, body = value ? JSON.stringify(value) : undefined;
      const proof = await signDeviceProof(assertion.privateKey, { sessionBinding: await sessionBindingDigest(session.id),
        deviceId: recipientDeviceId, registryEpoch: 1, method, url, body });
      return SELF.fetch(url, { method, headers: { cookie: session.cookie, origin: "https://mdwn.test",
        "X-Mdwn-Device-Proof": JSON.stringify(proof), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body } : {}) });
    }
    const direct = (method: "POST" | "PATCH", value?: object) => recipientRequest(path, method, value);
    const pending = await direct("POST");
    expect(pending.status).toBe(202); // Authority exists, but not yet any File key.
    expect(await pending.json()).toEqual({ error: "provisioning_required" });
    const context = await (await f.request(`${path}/context`, "POST")).json() as {
      recipients: { accountId: string; deviceId: string; registryEpoch: number; publicKey: string;
        grants: { id: string; generation: number }[] }[]; currentHead: { digest: string };
      recipientSetVersion: number };
    expect(context.recipients).toEqual([{ accountId: recipientId, deviceId: recipientDeviceId,
      registryEpoch: 1, publicKey: encode(publicKey), grants: [{ id: grantId, generation: 1 }] }]);
    const firstKeyId = id(), firstRepresentationId = id();
    const first = await createFileSave({ markdown: "owner provisioned", metadata: new Uint8Array() },
      migration.receiver.publicKey, { vaultId: f.ownerId, fileId: f.fileId,
        receivingKeyId: migration.receiver.receivingKeyId, receivingEpoch: 1,
        publicKeyDigest: migration.receiver.publicKeyDigest },
      { vaultId: f.ownerId, fileId: f.fileId, contentKeyId: firstKeyId, contentEpoch: 2, revision: 2 },
      [{ deviceId: recipientDeviceId, publicKey: transport.publicKey }]);
    const firstHead = await signFileHead({ ownerId: f.ownerId, vaultId: f.ownerId, fileId: f.fileId,
      revision: 2, contentKey: { id: firstKeyId, epoch: 2 }, receivingKey: {
        id: migration.receiver.receivingKeyId, epoch: 1, publicKeyDigest: migration.receiver.publicKeyDigest },
      representation: { id: firstRepresentationId, digest: await hash(first.contentEnvelope) },
      parentEnvelopeDigest: await hash(first.parentEnvelope), recipientSetVersion: 2,
      recipients: [{ accountId: recipientId, deviceId: recipientDeviceId, registryEpoch: 1,
        publicKeyDigest: await hash(publicKey), grants: [{ id: grantId, generation: 1 }],
        envelopeDigest: await hash(first.recipientEnvelopes[0]!.envelope) }],
      publication: { status: "none" }, signerDeviceId: f.deviceId }, f.assertion.privateKey);
    const save = (head: ReturnType<typeof wire>, fresh: Awaited<ReturnType<typeof createFileSave>>,
      expectedDigest: string, expectedRevision: number, expectedSetVersion: number,
      reprId: string, keyId: string, epoch: number) => ({ expectedHeadDigest: expectedDigest,
        expectedRevision, expectedRecipientSetVersion: expectedSetVersion, parentEnvelope: encode(fresh.parentEnvelope),
        recipientEnvelopes: fresh.recipientEnvelopes.map((e) => ({ deviceId: e.deviceId, ciphertext: encode(e.envelope) })),
        representation: { id: reprId, contentKeyId: keyId, keyEpoch: epoch, revision: expectedRevision + 1,
          ciphertext: encode(fresh.contentEnvelope) }, signedHead: head });
    const ownerSave = await f.request(path, "PATCH", save(wire(firstHead), first, context.currentHead.digest,
      1, 1, firstRepresentationId, firstKeyId, 2));
    expect(ownerSave.status, await ownerSave.clone().text()).toBe(200);
    const directRead = await direct("POST");
    expect(directRead.status, await directRead.clone().text()).toBe(200);
    const data = await directRead.json() as { fileHead: { bytes: string; digest: string; signature: string;
      signerDeviceId: string; signerPublicKey: string }; recipientEnvelope: string; ciphertext: string };
    expect(JSON.stringify(data)).not.toContain(f.rootId);
    expect(data).not.toHaveProperty("parentId");
    expect(data).not.toHaveProperty("keyEnvelope");
    expect(data).not.toHaveProperty("parentEnvelope");
    const verified = await verifyFileHead({ bytes: decodeTreeBytes(data.fileHead.bytes, 131_072),
      digest: decodeTreeBytes(data.fileHead.digest, 32), signature: decodeTreeBytes(data.fileHead.signature, 64) }, {
      ownerId: f.ownerId, vaultId: f.ownerId, fileId: f.fileId, signerDeviceId: f.deviceId,
      publicKey: decodeTreeBytes(data.fileHead.signerPublicKey, 65), revision: 2 });
    await verifyDirectFileRecipientEnvelope(verified, recipientId, recipientDeviceId, publicKey,
      decodeTreeBytes(data.recipientEnvelope, 16_384));
    const secondKeyId = id(), secondRepresentationId = id();
    const second = await createFileSave({ markdown: "direct editor", metadata: new Uint8Array() },
      migration.receiver.publicKey, { vaultId: f.ownerId, fileId: f.fileId,
        receivingKeyId: migration.receiver.receivingKeyId, receivingEpoch: 1,
        publicKeyDigest: migration.receiver.publicKeyDigest },
      { vaultId: f.ownerId, fileId: f.fileId, contentKeyId: secondKeyId, contentEpoch: 3, revision: 3 },
      [{ deviceId: recipientDeviceId, publicKey: transport.publicKey }]);
    const secondHead = await signFileHead({ ...verified.statement, revision: 3,
      contentKey: { id: secondKeyId, epoch: 3 },
      representation: { id: secondRepresentationId, digest: await hash(second.contentEnvelope) },
      parentEnvelopeDigest: await hash(second.parentEnvelope),
      recipients: [{ ...verified.statement.recipients[0]!, envelopeDigest: await hash(second.recipientEnvelopes[0]!.envelope) }],
      signerDeviceId: recipientDeviceId }, assertion.privateKey);
    const directSave = await direct("PATCH", save(wire(secondHead), second, encode(firstHead.digest),
      2, 2, secondRepresentationId, secondKeyId, 3));
    expect(directSave.status, await directSave.clone().text()).toBe(200);
    expect((await (await f.request(path, "POST")).json() as { revision: number }).revision).toBe(3);
    expect((await (await f.request(`/api/private/tree/directories/${f.rootId}`, "POST")).json() as {
      entriesRevision: number }).entriesRevision).toBe(3);
    const thirdKeyId = id(), thirdRepresentationId = id();
    const third = await createFileSave({ markdown: "blocked by rotation or stale Grant", metadata: new Uint8Array() },
      migration.receiver.publicKey, { vaultId: f.ownerId, fileId: f.fileId,
        receivingKeyId: migration.receiver.receivingKeyId, receivingEpoch: 1,
        publicKeyDigest: migration.receiver.publicKeyDigest },
      { vaultId: f.ownerId, fileId: f.fileId, contentKeyId: thirdKeyId, contentEpoch: 4, revision: 4 },
      [{ deviceId: recipientDeviceId, publicKey: transport.publicKey }]);
    const thirdHead = await signFileHead({ ...verified.statement, revision: 4,
      contentKey: { id: thirdKeyId, epoch: 4 },
      representation: { id: thirdRepresentationId, digest: await hash(third.contentEnvelope) },
      parentEnvelopeDigest: await hash(third.parentEnvelope),
      recipients: [{ ...verified.statement.recipients[0]!, envelopeDigest: await hash(third.recipientEnvelopes[0]!.envelope) }],
      signerDeviceId: recipientDeviceId }, assertion.privateKey);
    const thirdSave = save(wire(thirdHead), third, encode(secondHead.digest),
      3, 2, thirdRepresentationId, thirdKeyId, 4);
    await env.DB.prepare("INSERT INTO rotation_barriers (owner_id, target_node_id, epoch) VALUES (?, ?, 2)")
      .bind(f.ownerId, f.rootId).run();
    expect((await direct("PATCH", thirdSave)).status).toBe(409);
    await env.DB.prepare("DELETE FROM rotation_barriers WHERE owner_id = ? AND target_node_id = ?")
      .bind(f.ownerId, f.rootId).run();
    await env.DB.prepare("UPDATE grants SET generation = generation + 1, updated_at = ? WHERE id = ?")
      .bind(Date.now(), grantId).run();
    expect((await direct("PATCH", thirdSave)).status).toBe(400);
    expect((await (await f.request(path, "POST")).json() as { revision: number }).revision).toBe(3);
    await env.DB.prepare("DELETE FROM grants WHERE id = ?").bind(grantId).run();
    expect((await direct("POST")).status).toBe(404);
    const oldSignerRead = await f.request(path, "POST");
    expect(oldSignerRead.status).toBe(200); // Historical signer provenance remains verifiable.
    const oldHead = await (await oldSignerRead.json() as { fileHead: typeof data.fileHead }).fileHead;
    await expect(verifyFileHead({ bytes: decodeTreeBytes(oldHead.bytes, 131_072),
      digest: decodeTreeBytes(oldHead.digest, 32), signature: decodeTreeBytes(oldHead.signature, 64) }, {
      ownerId: f.ownerId, vaultId: f.ownerId, fileId: f.fileId, signerDeviceId: recipientDeviceId,
      publicKey: decodeTreeBytes(oldHead.signerPublicKey, 65), revision: 3 })).resolves.toBeDefined();
    // An independent Directory path retains authority after the direct path is revoked.
    const directoryGrantId = id();
    await env.DB.prepare(`INSERT INTO grants (id, owner_id, recipient_id, target_node_id, target_kind,
      permission, generation, created_at, updated_at) VALUES (?, ?, ?, ?, 'directory', 'read_write', 1, ?, ?)`)
      .bind(directoryGrantId, f.ownerId, recipientId, f.rootId, now, now).run();
    const inherited = await direct("POST");
    expect(inherited.status, await inherited.clone().text()).toBe(200);
    const inheritedData = await inherited.json() as { parentId: string; keyEnvelope: string };
    expect(inheritedData.parentId).toBe(f.rootId);
    const listingRoute = `/api/private/tree/directories/${f.rootId}`;
    const inheritedListing = await recipientRequest(listingRoute, "POST");
    expect(inheritedListing.status).toBe(200);
    const listing = await inheritedListing.json() as { entriesRevision: number; entries: SealedEntry[] };
    const nextName = encode(await (await createSymmetricWriter(f.rootKey)).seal(new TextEncoder().encode("after.md"), {
      purpose: "directory-metadata", vaultId: f.ownerId, objectId: f.fileId,
      keyId: f.rootId, keyEpoch: 1, revision: 1 }));
    const renameHead = await createListingHead(f.rootKey, assertion.privateKey, {
      vaultId: f.ownerId, directoryId: f.rootId, deviceId: recipientDeviceId, version: 2,
      revision: listing.entriesRevision + 1,
      entries: listing.entries.map((entry) => entry.nodeId === f.fileId ? { ...entry, nameCiphertext: nextName } : entry),
    });
    const renamed = await recipientRequest(`/api/private/tree/nodes/${f.fileId}/name`, "PATCH", {
      expectedRevision: listing.entriesRevision, nameCiphertext: nextName,
      orderCiphertext: listing.entries[0]!.orderCiphertext, listingHead: renameHead });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    await env.DB.prepare("DELETE FROM grants WHERE id = ?").bind(directoryGrantId).run();
    const historical = await (await f.request(listingRoute, "POST")).json() as {
      entriesRevision: number; entries: SealedEntry[]; listingHead: { ciphertext: string;
        digest: string; signature: string; signerDeviceId: string; signerPublicKey: string } };
    expect(historical.listingHead.signerDeviceId).toBe(recipientDeviceId);
    await expect(openListingHead(f.rootKey, { vaultId: f.ownerId, directoryId: f.rootId,
      version: 2, revision: historical.entriesRevision, entries: historical.entries,
      head: { ...historical.listingHead,
        signerPublicKey: decodeTreeBytes(historical.listingHead.signerPublicKey, 65) } })).resolves.toBeUndefined();
    expect((await direct("POST")).status).toBe(404);
  });
});
