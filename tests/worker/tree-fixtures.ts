import { env, SELF } from "cloudflare:test";

import { openSymmetric, sealToRecipient } from "../../app/crypto/enc-v1";
import { createFileReceivingKey, createFileSave } from "../../app/crypto/file-receiving";
import { generateDirectoryCapabilityKey } from "../../app/crypto/vault";
import { signDeviceProof, sessionBindingDigest } from "../../app/device/proof";
import { sealShareLabel } from "../../app/sharing/label";
import { digestBytes, hex, signOffer, type Offer } from "../../app/sharing/offer";
import { encryptedEntry, prepareTreeCreate, type DirectoryListing, type TreeEntry } from "../../app/tree/client";
import { signFileHead } from "../../app/tree/file-head";
import { createListingHead, type ListingVersion, type SealedEntry } from "../../app/tree/listing";
import { orderBetween, type DirectoryState, type StructureSigner } from "../../app/tree/structure-client";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/tree/wire";
import { seedNormalSession } from "./auth-fixtures";

/** Real migrated D1 + SELF.fetch actors with real device keys; no test endpoint or mock DB. */
export function uuid7(): string {
  const value = crypto.randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

export type Actor = { accountId: string; rootId: string; deviceId: string; session: { id: string; cookie: string };
  assertion: CryptoKeyPair; transport: CryptoKeyPair; rootKey: Uint8Array<ArrayBuffer>; signer: StructureSigner };

export async function actor(): Promise<Actor> {
  const accountId = uuid7(), rootId = uuid7(), deviceId = uuid7(), credentialId = uuid7(), now = Date.now();
  const assertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const transport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const raw = async (key: CryptoKey) => new Uint8Array(await crypto.subtle.exportKey("raw", key));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(accountId, uuid7(), now, now),
    env.DB.prepare(`INSERT INTO passkeys (credential_id, account_id, public_key, counter, transports, device_type,
      backed_up, created_at, updated_at) VALUES (?, ?, X'01', 0, '[]', 'singleDevice', 0, ?, ?)`).bind(credentialId, accountId, now, now),
    env.DB.prepare("INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)")
      .bind(accountId, rootId),
    env.DB.prepare(`INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state,
      approval_provenance, registry_epoch, created_at) VALUES (?, ?, ?, ?, 'active', 'signup', 1, ?)`)
      .bind(deviceId, accountId, await raw(transport.publicKey), await raw(assertion.publicKey), now),
  ]);
  const session = await seedNormalSession({ accountId, credentialIds: [credentialId] });
  await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(deviceId, session.id).run();
  return { accountId, rootId, deviceId, session, assertion, transport, rootKey: generateDirectoryCapabilityKey(),
    signer: { deviceId, assertionKey: assertion.privateKey } };
}

/** One proof-signed request exactly as the browser's privateRequest sends it. */
export async function call(who: Actor, path: string, method: "POST" | "PUT" | "PATCH" | "DELETE",
  value?: object): Promise<Response> {
  const url = `https://mdwn.test${path}`;
  const body = value === undefined ? undefined : JSON.stringify(value);
  const registry = await env.DB.prepare("SELECT registry_epoch FROM account_encryption_identities WHERE account_id = ?")
    .bind(who.accountId).first<{ registry_epoch: number }>();
  const proof = await signDeviceProof(who.assertion.privateKey, { sessionBinding: await sessionBindingDigest(who.session.id),
    deviceId: who.deviceId, registryEpoch: registry!.registry_epoch, method, url, body });
  return SELF.fetch(url, { method, headers: { cookie: who.session.cookie, origin: "https://mdwn.test",
    "X-Mdwn-Device-Proof": JSON.stringify(proof), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body }) });
}

const decoder = new TextDecoder();
/** Decrypts one listing the way loadDirectory does (signature checks are covered elsewhere). */
export async function state(who: Actor, vaultId: string, directoryId: string, key: Uint8Array): Promise<DirectoryState> {
  const response = await call(who, `/api/private/tree/directories/${directoryId}`, "POST");
  if (!response.ok) throw new Error(`listing ${response.status}`);
  const listing = await response.json() as { entriesRevision: number; listingVersion: ListingVersion;
    capabilityEpoch: number; entries: SealedEntry[] };
  const entries = await Promise.all(listing.entries.map(async (entry): Promise<TreeEntry> => {
    const context = { purpose: "directory-metadata" as const, vaultId, objectId: entry.nodeId,
      keyId: directoryId, keyEpoch: listing.capabilityEpoch, revision: 1 };
    return { ...entry, name: decoder.decode(await openSymmetric(decodeTreeBytes(entry.nameCiphertext), key, { context })),
      order: decoder.decode(await openSymmetric(decodeTreeBytes(entry.orderCiphertext), key, { context })) };
  }));
  entries.sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : a.nodeId.localeCompare(b.nodeId));
  return { listing: { directoryId, entriesRevision: listing.entriesRevision, listingVersion: listing.listingVersion,
    capabilityEpoch: listing.capabilityEpoch, entries } satisfies DirectoryListing, key };
}

export function signListing(signer: StructureSigner, vaultId: string, parent: DirectoryState,
  entries: readonly SealedEntry[], version: ListingVersion = parent.listing.listingVersion ?? 1) {
  return createListingHead(parent.key, signer.assertionKey, { vaultId, directoryId: parent.listing.directoryId,
    epoch: parent.listing.capabilityEpoch,
    deviceId: signer.deviceId, revision: parent.listing.entriesRevision + 1, version,
    entries: entries.map((entry) => ({ nodeId: entry.nodeId, kind: entry.kind, nameCiphertext: entry.nameCiphertext,
      orderCiphertext: entry.orderCiphertext, keyEnvelope: entry.keyEnvelope,
      ...(version === 2 ? { encoding: entry.encoding ?? (entry.kind === "directory" ? "directory" : "legacy-file"),
        ...(entry.encoding === "receiving-file" ? { receivingKeyId: entry.receivingKeyId,
          receivingEpoch: entry.receivingEpoch, wrapRevision: entry.wrapRevision } : {}) } : {}) })) });
}

/** Creates a Directory and returns its capability. */
export async function directory(who: Actor, vaultId: string, parent: DirectoryState, name: string): Promise<{
  nodeId: string; key: Uint8Array<ArrayBuffer> }> {
  const payload = await prepareTreeCreate({ vaultId, parentId: parent.listing.directoryId, parentKey: parent.key,
    parentEpoch: parent.listing.capabilityEpoch,
    entriesRevision: parent.listing.entriesRevision, existingNames: parent.listing.entries.map((e) => e.name),
    requestedName: name, kind: "directory" });
  const listingHead = await signListing(who.signer, vaultId, parent, [...parent.listing.entries,
    { ...payload, encoding: "directory" }]);
  const response = await call(who, `/api/private/tree/directories/${parent.listing.directoryId}/children`, "PUT",
    { ...payload, listingHead });
  if (response.status !== 201) throw new Error(`directory ${response.status} ${await response.text()}`);
  const key = await openSymmetric(decodeTreeBytes(payload.keyEnvelope), parent.key, { context: {
    purpose: "directory-capability", vaultId, objectId: payload.nodeId, keyId: payload.nodeId, keyEpoch: 1, revision: 1 } });
  return { nodeId: payload.nodeId, key };
}

/** Legacy v1 File (symmetric parent-wrapped content key) through the real create route. */
export async function legacyFile(who: Actor, vaultId: string, parent: DirectoryState, name: string,
  markdown = "# legacy"): Promise<string> {
  const payload = await prepareTreeCreate({ vaultId, parentId: parent.listing.directoryId, parentKey: parent.key,
    parentEpoch: parent.listing.capabilityEpoch,
    entriesRevision: parent.listing.entriesRevision, existingNames: parent.listing.entries.map((e) => e.name),
    requestedName: name, kind: "file", markdown });
  const listingHead = await signListing(who.signer, vaultId, parent, [...parent.listing.entries,
    { ...payload, encoding: "legacy-file" }]);
  const response = await call(who, `/api/private/tree/directories/${parent.listing.directoryId}/children`, "PUT",
    { ...payload, listingHead });
  if (response.status !== 201) throw new Error(`legacy File ${response.status} ${await response.text()}`);
  return payload.nodeId;
}

const sha256 = async (value: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(value)));

/** v2 File with its own receiving pair and signed File head (the browser's default create path). */
export async function v2File(who: Actor, vaultId: string, parent: DirectoryState, name: string,
  markdown = "# receiving"): Promise<string> {
  const listing = parent.listing, nodeId = uuid7(), receivingKeyId = uuid7(), contentKeyId = uuid7();
  const representationId = uuid7(), wrapRevision = listing.entriesRevision + 1;
  const metadata = await encryptedEntry(parent.key, vaultId, listing.directoryId, nodeId, name,
    orderBetween(listing.entries.at(-1)?.order ?? ""), listing.capabilityEpoch);
  const receiving = await createFileReceivingKey(parent.key, { vaultId, fileId: nodeId, receivingKeyId,
    receivingEpoch: 1, wrapRevision });
  const fresh = await createFileSave({ markdown, metadata: new Uint8Array() }, receiving.publicKey,
    { vaultId, fileId: nodeId, receivingKeyId, receivingEpoch: 1, publicKeyDigest: receiving.publicKeyDigest },
    { vaultId, fileId: nodeId, contentKeyId, contentEpoch: 1, revision: 1 }, []);
  const head = await signFileHead({ ownerId: vaultId, vaultId, fileId: nodeId, revision: 1,
    contentKey: { id: contentKeyId, epoch: 1 },
    receivingKey: { id: receivingKeyId, epoch: 1, publicKeyDigest: receiving.publicKeyDigest },
    representation: { id: representationId, digest: await sha256(fresh.contentEnvelope) },
    parentEnvelopeDigest: await sha256(fresh.parentEnvelope), recipientSetVersion: 1, recipients: [],
    publication: { status: "none" }, signerDeviceId: who.deviceId }, who.assertion.privateKey);
  const entry: SealedEntry = { nodeId, kind: "file", encoding: "receiving-file", ...metadata,
    keyEnvelope: encodeTreeBytes(receiving.privateKeyEnvelope), receivingKeyId, receivingEpoch: 1, wrapRevision };
  const listingHead = await signListing(who.signer, vaultId, parent, [...listing.entries, entry], 2);
  const response = await call(who, `/api/private/tree/directories/${listing.directoryId}/children`, "PUT", {
    nodeId, kind: "file", encoding: "receiving-file", expectedRevision: listing.entriesRevision, ...metadata,
    keyEnvelope: entry.keyEnvelope, receivingKeyId, receivingEpoch: 1, wrapRevision,
    representation: { id: representationId, contentKeyId, keyEpoch: 1, revision: 1,
      ciphertext: encodeTreeBytes(fresh.contentEnvelope) },
    receivingPublicKey: encodeTreeBytes(receiving.publicKey), parentEnvelope: encodeTreeBytes(fresh.parentEnvelope),
    recipientEnvelopes: [], signedHead: { bytes: encodeTreeBytes(head.bytes), digest: encodeTreeBytes(head.digest),
      signature: encodeTreeBytes(head.signature) }, listingHead });
  if (response.status !== 201) throw new Error(`v2 File ${response.status} ${await response.text()}`);
  return nodeId;
}

/** Every non-root node has exactly one agreeing edge and no teardown marker survives a batch. */
export async function treeIntegrity(ownerId: string): Promise<{ broken: number; markers: number }> {
  const broken = await env.DB.prepare(`SELECT count(*) AS n FROM vault_nodes n
    LEFT JOIN directory_entries e ON e.child_node_id = n.id AND e.parent_node_id = n.parent_node_id
      AND e.owner_id = n.owner_id
    WHERE n.owner_id = ? AND n.parent_node_id IS NOT NULL AND e.child_node_id IS NULL`).bind(ownerId).first<{ n: number }>();
  const markers = await env.DB.prepare("SELECT count(*) AS n FROM tree_teardown_nodes").first<{ n: number }>();
  return { broken: broken!.n, markers: markers!.n };
}

/**
 * A real accepted Directory Share: Owner-signed offer, sealed Shared-as labels and capability
 * envelopes for every current recipient device, through the same routes the browser uses.
 */
export async function shareDirectory(owner: Actor, recipient: Actor, directoryId: string, key: Uint8Array,
  permission: "read_only" | "read_write" = "read_only",
  vaultRoot: Uint8Array = generateDirectoryCapabilityKey()): Promise<{
    grantId: string; shareId: string; vaultRoot: Uint8Array }> {
  const prep = await call(owner, "/api/private/sharing/target", "POST",
    { targetId: directoryId, kind: "directory", recipientId: recipient.accountId });
  if (prep.status !== 200) throw new Error(`share target ${prep.status}`);
  const coordinates = await prep.json() as { targetKeyId: string; targetEpoch: number; revision: number;
    headDigest: string };
  const shareIdentity = (await env.DB.prepare("SELECT share_id FROM accounts WHERE id = ?")
    .bind(recipient.accountId).first<{ share_id: string }>())!.share_id;
  const resolved = await call(owner, "/api/private/sharing/resolve", "POST", { kind: "share-id", value: shareIdentity });
  const addressed = await resolved.json() as { registryEpoch: number;
    devices: { deviceId: string; publicKey: string; registryEpoch: number }[] };
  const targets = await Promise.all(addressed.devices.map(async (device) => ({ ...device,
    bytes: decodeTreeBytes(device.publicKey, 65), key: await crypto.subtle.importKey("raw",
      decodeTreeBytes(device.publicKey, 65), { name: "ECDH", namedCurve: "P-256" }, true, []) })));
  const shareId = uuid7(), grantId = uuid7(), labelId = uuid7();
  const labels = await sealShareLabel("Shared", owner.accountId, directoryId, labelId,
    targets.map((device) => ({ deviceId: device.deviceId, publicKey: device.key })), vaultRoot);
  const material = await Promise.all(targets.map(async (device) => ({ ...device,
    ciphertext: await sealToRecipient(key, device.key, { purpose: "grant", vaultId: owner.accountId,
      objectId: directoryId, keyId: coordinates.targetKeyId, keyEpoch: coordinates.targetEpoch, revision: 1,
      recipientId: device.deviceId }),
    label: labels.deliveries.find((item) => item.deviceId === device.deviceId)!.envelope })));
  const fingerprint = async (value: Uint8Array) => hex(await digestBytes(value));
  const offer: Offer = { shareId, grantId, ownerId: owner.accountId, recipientId: recipient.accountId,
    targetId: directoryId, kind: "directory", permission, materialRevision: 1,
    targetKeyId: coordinates.targetKeyId, targetEpoch: coordinates.targetEpoch,
    contentRevision: coordinates.revision, headDigest: hex(decodeTreeBytes(coordinates.headDigest, 32)),
    labelId, ownerCopyDigest: await fingerprint(labels.ownerCopy), registryEpoch: addressed.registryEpoch,
    devices: await Promise.all(material.map(async (device) => ({ accountId: recipient.accountId,
      deviceId: device.deviceId, registryEpoch: device.registryEpoch, publicKeyDigest: await fingerprint(device.bytes),
      contentDigest: await fingerprint(device.ciphertext), labelDigest: await fingerprint(device.label) }))),
    candidateDigest: null, signerDeviceId: owner.deviceId };
  const signed = await signOffer(offer, owner.assertion.privateKey);
  const sent = await call(owner, "/api/private/sharing/shares", "PUT", { ...offer,
    ownerCopy: encodeTreeBytes(labels.ownerCopy), offerBytes: encodeTreeBytes(signed.bytes),
    offerDigest: encodeTreeBytes(signed.digest), offerSignature: encodeTreeBytes(signed.signature), candidate: null,
    deliveries: material.map((device) => ({ deviceId: device.deviceId, registryEpoch: device.registryEpoch,
      publicKey: device.publicKey, ciphertext: encodeTreeBytes(device.ciphertext),
      labelCiphertext: encodeTreeBytes(device.label) })) });
  if (sent.status !== 201) throw new Error(`share ${sent.status} ${await sent.text()}`);
  const accepted = await call(recipient, `/api/private/sharing/shares/${shareId}/accept`, "POST", { materialRevision: 1 });
  if (accepted.status !== 200) throw new Error(`accept ${accepted.status} ${await accepted.text()}`);
  return { grantId, shareId, vaultRoot };
}
