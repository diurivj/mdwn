import { openForRecipient, sealToRecipient } from "~/crypto/enc-v1";
import { openFileContentKeyFromReceiving, openFileReceivingKey } from "~/crypto/file-receiving";
import { privateRequest } from "~/device/private-client";
import { getDevice } from "~/device/store";
import { newOpaqueId } from "~/opaque-id";
import { isV7 } from "~/tree/wire";
import { authenticateFileHead, type FileHeadWire } from "~/tree/client";
import { signFileHead, verifyFileParentEnvelope,
  type DirectRecipientDescriptor, type FileHeadStatement } from "~/tree/file-head";
import type { FilesSnapshot } from "~/tree/navigation-client";
import { decodeTreeBytes, encodeTreeBytes } from "~/tree/wire";
import { sealShareLabel, openShareLabel } from "./label";
import { digestBytes, hex, signOffer, verifyOffer, type Offer } from "./offer";
import { deriveShareHandleLookupToken } from "./share-handle";

export type GrantRoot = { grantId: string; ownerId: string; targetId: string;
  kind: "file" | "directory"; permission: "read_only" | "read_write";
  generation: number; labelId: string; labelCiphertext: string; labelDigest: string;
  offerBytes: string; offerDigest: string; offerSignature: string; signerPublicKey: string;
  capability?: { ciphertext: string; targetKeyId: string; targetEpoch: number; digest: string };
  status: "ready" | "provisioning" };
export type ResolvedRecipient = { accountId: string; registryEpoch: number;
  devices: { deviceId: string; publicKey: string; registryEpoch: number }[] };
export type ShareItem = { id: string; kind: "file" | "directory"; permission: "read_only" | "read_write"; createdAt: number };

async function resource<T>(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", input?: object,
  signal?: AbortSignal): Promise<T> {
  const response = await privateRequest(path, { method, signal, ...(input ? { body: JSON.stringify(input) } : {}) });
  if (!response.ok) throw new Error("Shared content unavailable");
  return response.json() as Promise<T>;
}
const digest = async (value: Uint8Array) => hex(await digestBytes(value));
const headWire = (head: { bytes: Uint8Array; digest: Uint8Array; signature: Uint8Array }) =>
  ({ bytes: encodeTreeBytes(head.bytes), digest: encodeTreeBytes(head.digest), signature: encodeTreeBytes(head.signature) });

/** Exact addressing only. The service never returns a browseable Account directory. */
export async function encodeRecipientAddress(value: string, signal?: AbortSignal):
  Promise<{ kind: "share-id" | "handle"; value: string }> {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /\s/u.test(value)) {
    throw new TypeError("Invalid share address");
  }
  if (value.startsWith("@")) {
    // Remove exactly one marker. The reviewed helper rejects a second @, spaces,
    // non-ASCII spellings and every other non-canonical handle before any request.
    const token = await deriveShareHandleLookupToken(value.slice(1));
    signal?.throwIfAborted();
    return { kind: "handle", value: token };
  }
  if (!isV7(value)) throw new TypeError("Invalid share address");
  return { kind: "share-id", value };
}

export async function resolveRecipient(value: string, signal?: AbortSignal): Promise<ResolvedRecipient> {
  const address = await encodeRecipientAddress(value, signal);
  signal?.throwIfAborted();
  return resource("/api/private/sharing/resolve", "POST", address, signal);
}

async function currentOwnedFileKey(snapshot: FilesSnapshot, targetId: string): Promise<{
  key: Uint8Array; head: FileHeadWire; ownerId: string; contentKeyId: string;
  contentEpoch: number; contentRevision: number }> {
  const file = snapshot.file;
  if (!file?.v2 || file.parentId !== snapshot.crumbs.at(-2)?.id || snapshot.crumbs.at(-1)?.id !== targetId) {
    throw new Error("Open the current File before sharing it");
  }
  const response = await privateRequest(`/api/private/tree/files/${targetId}`, { method: "POST" });
  if (!response.ok) throw new Error("File changed");
  const data = await response.json() as { fileHead: FileHeadWire; ownerId: string; fileId: string;
    keyEnvelope: string; parentEnvelope: string; receivingPublicKey: string; receivingKeyId: string;
    receivingEpoch: number; wrapRevision: number; contentKeyId: string; keyEpoch: number; revision: number };
  if (data.ownerId !== snapshot.access.vaultId || data.fileId !== targetId ||
      data.fileHead.digest !== file.v2.signedHead.digest || data.revision !== file.revision) throw new Error("File changed");
  const head = await authenticateFileHead(data.fileHead, data.ownerId, targetId, data.revision);
  await verifyFileParentEnvelope(head, decodeTreeBytes(data.parentEnvelope, 16384));
  const pair = await openFileReceivingKey(decodeTreeBytes(data.keyEnvelope, 16384), snapshot.keys[file.parentId]!,
    { vaultId: data.ownerId, fileId: targetId, receivingKeyId: data.receivingKeyId,
      receivingEpoch: data.receivingEpoch, wrapRevision: data.wrapRevision,
      publicKey: decodeTreeBytes(data.receivingPublicKey, 65) });
  const key = await openFileContentKeyFromReceiving(decodeTreeBytes(data.parentEnvelope, 16384), pair,
    { vaultId: data.ownerId, fileId: targetId, receivingKeyId: data.receivingKeyId,
      contentKeyId: data.contentKeyId, contentEpoch: data.keyEpoch, revision: data.revision });
  return { key, head: data.fileHead, ownerId: data.ownerId, contentKeyId: data.contentKeyId,
    contentEpoch: data.keyEpoch, contentRevision: data.revision };
}

/** The Share is not visible until *all* envelopes and the detached signature are ready. */
export async function inviteSharedRoot(snapshot: FilesSnapshot, targetId: string, kind: "file" | "directory",
  name: string, recipient: ResolvedRecipient, permission: "read_only" | "read_write"): Promise<string> {
  const ownerId = snapshot.access.vaultId, actorId = snapshot.access.actorAccountId ?? ownerId;
  if (ownerId !== actorId || !snapshot.access.vaultRoot || !recipient.devices.length || recipient.devices.length > 256 ||
      recipient.accountId === ownerId || snapshot.crumbs.at(-1)?.id !== targetId) throw new Error("Cannot invite to this content");
  const device = await getDevice(actorId);
  if (!device) throw new Error("Device unavailable");
  const shareId = newOpaqueId(), grantId = newOpaqueId(), labelId = newOpaqueId();
  const prep = await resource<{ targetKeyId: string; targetEpoch: number; headDigest: string;
    revision: number; recipients?: { accountId: string; deviceId: string; registryEpoch: number;
      publicKey: string; grants: { id: string; generation: number }[] }[]; head?: FileHeadWire }>(
    "/api/private/sharing/target", "POST", { targetId, kind, recipientId: recipient.accountId });
  const targets = await Promise.all(recipient.devices.map(async (d) => ({ ...d,
    encodedPublicKey: d.publicKey, publicKeyBytes: decodeTreeBytes(d.publicKey, 65),
    publicKey: await crypto.subtle.importKey("raw", decodeTreeBytes(d.publicKey, 65),
      { name: "ECDH", namedCurve: "P-256" }, false, []) })));
  const labels = await sealShareLabel(name, ownerId, targetId, labelId, targets, snapshot.access.vaultRoot);
  const fileKey = kind === "file" ? await currentOwnedFileKey(snapshot, targetId) : null;
  const key = fileKey?.key ?? snapshot.keys[targetId];
  if (!key || key.length !== 32 || (kind === "file" && (fileKey?.contentKeyId !== prep.targetKeyId ||
      fileKey.contentEpoch !== prep.targetEpoch || fileKey.head.digest !== prep.headDigest))) {
    throw new Error("Content changed; refresh before inviting");
  }
  try {
    const content = await Promise.all(targets.map(async (d) => ({ deviceId: d.deviceId,
      envelope: await sealToRecipient(key, d.publicKey, {
        purpose: "grant", vaultId: ownerId, objectId: targetId, keyId: prep.targetKeyId,
        keyEpoch: prep.targetEpoch, revision: kind === "file" ? prep.revision : 1,
        recipientId: d.deviceId,
      }) })));
    const devices = await Promise.all(targets.map(async (d) => ({ accountId: recipient.accountId,
      deviceId: d.deviceId, registryEpoch: d.registryEpoch,
      publicKeyDigest: await digest(d.publicKeyBytes), contentDigest: await digest(content.find((c) => c.deviceId === d.deviceId)!.envelope),
      labelDigest: await digest(labels.deliveries.find((c) => c.deviceId === d.deviceId)!.envelope) })));
    let candidate: ReturnType<typeof headWire> | null = null;
    if (kind === "file") {
      if (!prep.head || !prep.recipients || !fileKey) throw new Error("File must be upgraded before inviting");
      const before = await authenticateFileHead(prep.head, ownerId, targetId, prep.revision);
      const old = before.statement;
      const newDescriptors: DirectRecipientDescriptor[] = await Promise.all(targets.map(async (d) => ({
        accountId: recipient.accountId, deviceId: d.deviceId, registryEpoch: d.registryEpoch,
        publicKeyDigest: await digestBytes(d.publicKeyBytes),
        grants: [{ id: grantId, generation: 1 }],
        envelopeDigest: await digestBytes(content.find((c) => c.deviceId === d.deviceId)!.envelope),
      })));
      const statement: FileHeadStatement = { ...old, recipients: [...old.recipients, ...newDescriptors],
        recipientSetVersion: old.recipientSetVersion + 1, signerDeviceId: device.deviceId };
      candidate = headWire(await signFileHead(statement, device.assertionKeyPair.privateKey));
    }
    const offer: Offer = { shareId, grantId, ownerId, recipientId: recipient.accountId, targetId, kind,
      permission, materialRevision: 1, targetKeyId: prep.targetKeyId, targetEpoch: prep.targetEpoch,
      contentRevision: prep.revision, headDigest: hex(decodeTreeBytes(prep.headDigest, 32)), labelId,
      ownerCopyDigest: await digest(labels.ownerCopy), registryEpoch: recipient.registryEpoch,
      devices, candidateDigest: candidate?.digest ? await digest(decodeTreeBytes(candidate.bytes, 131072)) : null,
      signerDeviceId: device.deviceId };
    const signed = await signOffer(offer, device.assertionKeyPair.privateKey);
    await resource("/api/private/sharing/shares", "PUT", { ...offer,
      ownerCopy: encodeTreeBytes(labels.ownerCopy), offerBytes: encodeTreeBytes(signed.bytes),
      offerDigest: encodeTreeBytes(signed.digest), offerSignature: encodeTreeBytes(signed.signature), candidate,
      deliveries: targets.map((d) => ({ deviceId: d.deviceId, registryEpoch: d.registryEpoch,
        publicKey: d.encodedPublicKey, ciphertext: encodeTreeBytes(content.find((c) => c.deviceId === d.deviceId)!.envelope),
        labelCiphertext: encodeTreeBytes(labels.deliveries.find((c) => c.deviceId === d.deviceId)!.envelope) })) });
    return shareId;
  } finally { if (fileKey) fileKey.key.fill(0); }
}

export type OwnerGrant = { grantId: string; targetId: string; permission: "read_only" | "read_write" };
export async function invitations(): Promise<{ incoming: ShareItem[];
  outgoing: (ShareItem & { targetId: string })[]; grants: OwnerGrant[] }> {
  return resource("/api/private/sharing/invitations", "POST");
}
export async function acceptInvitation(shareId: string): Promise<void> {
  await resource(`/api/private/sharing/shares/${shareId}/accept`, "POST", { materialRevision: 1 });
}
export async function cancelInvitation(shareId: string): Promise<void> {
  await resource(`/api/private/sharing/shares/${shareId}`, "DELETE");
}
export async function declineInvitation(shareId: string): Promise<void> {
  await resource(`/api/private/sharing/shares/${shareId}/decline`, "DELETE");
}
export async function leaveGrant(grantId: string): Promise<void> {
  await resource(`/api/private/sharing/grants/${grantId}/leave`, "DELETE");
}
export async function revokeGrant(grantId: string): Promise<void> {
  await resource(`/api/private/sharing/grants/${grantId}`, "DELETE");
}
export async function changeGrantPermission(grantId: string, permission: "read_only" | "read_write"): Promise<void> {
  await resource(`/api/private/sharing/grants/${grantId}`, "PATCH", { permission });
}
export async function sharedRoots(signal?: AbortSignal): Promise<GrantRoot[]> {
  return (await resource<{ roots: GrantRoot[] }>("/api/private/sharing/roots", "POST", undefined, signal)).roots;
}
async function verifiedRoot(root: GrantRoot, actorId: string) {
  const device = await getDevice(actorId);
  if (!device || root.status !== "ready") throw new Error("Content provisioning pending");
  const offer = await verifyOffer(decodeTreeBytes(root.offerBytes, 131072),
    decodeTreeBytes(root.offerDigest, 32), decodeTreeBytes(root.offerSignature, 64),
    decodeTreeBytes(root.signerPublicKey, 65));
  const entry = offer.devices.find((d) => d.deviceId === device.deviceId && d.accountId === actorId);
  const envelope = decodeTreeBytes(root.labelCiphertext, 4096);
  if (!entry || offer.grantId !== root.grantId || offer.ownerId !== root.ownerId ||
      offer.recipientId !== actorId || offer.targetId !== root.targetId || offer.kind !== root.kind ||
      offer.labelId !== root.labelId || entry.labelDigest !== await digest(envelope) ||
      root.labelDigest !== encodeTreeBytes(await digestBytes(envelope))) throw new Error("Invalid Shared-as label");
  return { device, entry, envelope };
}
export async function namedRoot(root: GrantRoot, actorId: string): Promise<string> {
  const { device, envelope } = await verifiedRoot(root, actorId);
  return openShareLabel(envelope, device.transportKeyPair,
    root.ownerId, root.targetId, root.labelId, device.deviceId);
}
export async function openGrantedDirectory(root: GrantRoot, actorId: string): Promise<Uint8Array> {
  const { device, entry } = await verifiedRoot(root, actorId);
  const capability = root.capability;
  if (!capability || root.kind !== "directory" || capability.targetKeyId !== root.targetId ||
      entry.contentDigest !== await digest(decodeTreeBytes(capability.ciphertext, 16384)) ||
      capability.digest !== encodeTreeBytes(await digestBytes(decodeTreeBytes(capability.ciphertext, 16384)))) {
    throw new Error("Invalid shared Directory capability");
  }
  const key = await openForRecipient(decodeTreeBytes(capability.ciphertext, 16384), device.transportKeyPair,
    { context: { purpose: "grant", vaultId: root.ownerId, objectId: root.targetId,
      keyId: capability.targetKeyId, keyEpoch: capability.targetEpoch, revision: 1, recipientId: device.deviceId } });
  if (key.length !== 32) throw new Error("Invalid Directory capability");
  return key;
}
