import { loadThreadKeySource, prepareThreadRotation, type ThreadKeySource } from "~/comments/client";
import { sealToRecipient } from "~/crypto/enc-v1";
import { openFileContentKeyFromReceiving, openFileReceivingKey } from "~/crypto/file-receiving";
import { privateRequest } from "~/device/private-client";
import { authenticateFileHead, loadAncestors, loadDirectory, openChildDirectory, TreeNotFoundError,
  type RootAccess, type TreeEntry } from "~/tree/client";
import { signFileHead } from "~/tree/file-head";
import type { DirectoryState, FileRotationSource, StructureSigner } from "~/tree/structure-client";
import { decodeTreeBytes, encodeTreeBytes } from "~/tree/wire";
import { parseOffer, signOffer, type OfferDevice } from "./offer";

/** A live direct-File recipient device as the Worker reports it for a rotation step. */
export type RotationRecipient = { accountId: string; deviceId: string; registryEpoch: number; publicKey: string;
  grants: { id: string; generation: number }[] };
export type GrantMaterialWire = { grantId: string; recipientId: string; generation: number;
  permission: "read_only" | "read_write"; offer: { bytes: string; digest: string; signature: string };
  devices: { deviceId: string; registryEpoch: number; publicKey: string; labelDigest: string }[] };
export type RotationStep =
  | { step: "file"; targetId: string; fileId: string; mode: "rekey" | "reprovision"; barrierEpoch: number;
      recipients: RotationRecipient[] }
  | { step: "grants"; targetId: string; directoryId: string; mode: "reprovision"; barrierEpoch: number;
      epoch: number; grants: GrantMaterialWire[] };

const sha256 = async (value: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(value)));
const hex = (value: Uint8Array) => Array.from(value, (n) => n.toString(16).padStart(2, "0")).join("");
/** HPKE serializes the recipient key, so a public key is imported extractable (as browsers do anyway). */
const importP256 = (raw: string) => crypto.subtle.importKey("raw", decodeTreeBytes(raw, 65),
  { name: "ECDH", namedCurve: "P-256" }, true, []);

/** The current v2 File material a parent-capability holder reads, with its committed entry. */
export type RotationFile = FileRotationSource & { fileId: string };

/**
 * Opens the current File key through the parent capability and re-seals it to exactly the
 * live direct recipients in a same-revision recipient-set update. A `rekey` also moves the
 * Private thread to a new epoch under the SAME receiving pair: a direct reader never held it.
 */
export async function prepareFileTargetRotation(options: { vaultId: string; signer: StructureSigner;
  parent: DirectoryState; entry: TreeEntry; file: RotationFile; step: Extract<RotationStep, { step: "file" }>;
  thread: ThreadKeySource | null }) {
  const { vaultId, signer, parent, entry, file, step } = options;
  if (entry.encoding !== "receiving-file" || !entry.receivingKeyId || !entry.receivingEpoch || !entry.wrapRevision ||
      entry.nodeId !== file.fileId) throw new Error("invalid File entry");
  const head = await authenticateFileHead(file.fileHead, vaultId, file.fileId, file.revision);
  if (head.statement.receivingKey.id !== entry.receivingKeyId || head.statement.receivingKey.epoch !== entry.receivingEpoch ||
      head.statement.contentKey.id !== file.contentKeyId || head.statement.contentKey.epoch !== file.keyEpoch) {
    throw new Error("invalid File head");
  }
  const pair = await openFileReceivingKey(decodeTreeBytes(entry.keyEnvelope, 16_384), parent.key, { vaultId,
    fileId: file.fileId, receivingKeyId: entry.receivingKeyId, receivingEpoch: entry.receivingEpoch,
    wrapRevision: entry.wrapRevision, publicKey: decodeTreeBytes(file.receivingPublicKey, 65) });
  const contentKey = await openFileContentKeyFromReceiving(decodeTreeBytes(file.parentEnvelope, 16_384), pair, {
    vaultId, fileId: file.fileId, revision: file.revision, contentKeyId: file.contentKeyId,
    contentEpoch: file.keyEpoch, receivingKeyId: entry.receivingKeyId });
  try {
    const sealed = await Promise.all(step.recipients.map(async (recipient) => {
      const ciphertext = await sealToRecipient(contentKey, await importP256(recipient.publicKey), {
        purpose: "grant", vaultId, objectId: file.fileId, keyId: file.contentKeyId, keyEpoch: file.keyEpoch,
        revision: file.revision, recipientId: recipient.deviceId });
      return { recipient, ciphertext };
    }));
    const signed = await signFileHead({ ...head.statement,
      recipientSetVersion: head.statement.recipientSetVersion + 1,
      recipients: await Promise.all(sealed.map(async ({ recipient, ciphertext }) => ({
        accountId: recipient.accountId, deviceId: recipient.deviceId, registryEpoch: recipient.registryEpoch,
        grants: recipient.grants, publicKeyDigest: await sha256(decodeTreeBytes(recipient.publicKey, 65)),
        envelopeDigest: await sha256(ciphertext) }))),
      signerDeviceId: signer.deviceId }, signer.assertionKey);
    const thread = step.mode === "rekey" && options.thread ? await prepareThreadRotation(options.thread,
      { receivingKeyId: entry.receivingKeyId, receivingEpoch: entry.receivingEpoch, pair },
      { receivingKeyId: entry.receivingKeyId, publicKey: pair.publicKey }) : null;
    return { barrierEpoch: step.barrierEpoch, expectedHeadDigest: file.fileHead.digest,
      signedHead: { bytes: encodeTreeBytes(signed.bytes), digest: encodeTreeBytes(signed.digest),
        signature: encodeTreeBytes(signed.signature) },
      recipientEnvelopes: sealed.map(({ recipient, ciphertext }) => ({ deviceId: recipient.deviceId,
        ciphertext: encodeTreeBytes(ciphertext) })), thread };
  } finally { contentKey.fill(0); }
}

/**
 * Re-seals one Directory capability to every label-ready device of each Grant on it, with a
 * re-signed offer at the next material revision (new epoch/permission, new content digests).
 * The recipient's `roots` verification accepts it exactly as it accepted the original offer.
 */
export async function prepareGrantSeals(options: { ownerId: string; directoryId: string; key: Uint8Array;
  epoch: number; signer: StructureSigner; grants: readonly GrantMaterialWire[] }) {
  const { ownerId, directoryId, key, epoch, signer } = options;
  return Promise.all(options.grants.map(async (grant) => {
    const stored = parseOffer(decodeTreeBytes(grant.offer.bytes, 131_072));
    if (stored.grantId !== grant.grantId || stored.ownerId !== ownerId || stored.targetId !== directoryId ||
        stored.recipientId !== grant.recipientId || stored.kind !== "directory") throw new Error("invalid Grant offer");
    const envelopes = await Promise.all(grant.devices.map(async (device) => ({ device,
      ciphertext: await sealToRecipient(key, await importP256(device.publicKey), { purpose: "grant", vaultId: ownerId,
        objectId: directoryId, keyId: directoryId, keyEpoch: epoch, revision: 1, recipientId: device.deviceId }) })));
    const devices: OfferDevice[] = await Promise.all(envelopes.map(async ({ device, ciphertext }) => ({
      accountId: grant.recipientId, deviceId: device.deviceId, registryEpoch: device.registryEpoch,
      publicKeyDigest: hex(await sha256(decodeTreeBytes(device.publicKey, 65))),
      contentDigest: hex(await sha256(ciphertext)), labelDigest: device.labelDigest })));
    const offer = await signOffer({ ...stored, permission: grant.permission,
      materialRevision: stored.materialRevision + 1, targetEpoch: epoch,
      registryEpoch: devices[0]?.registryEpoch ?? stored.registryEpoch, devices,
      signerDeviceId: signer.deviceId }, signer.assertionKey);
    return { grantId: grant.grantId,
      offer: { bytes: encodeTreeBytes(offer.bytes), digest: encodeTreeBytes(offer.digest),
        signature: encodeTreeBytes(offer.signature) },
      envelopes: envelopes.map(({ device, ciphertext }) => ({ deviceId: device.deviceId,
        ciphertext: encodeTreeBytes(ciphertext) })) };
  }));
}

export class RotationChangedError extends Error {
  constructor() { super("rotation_changed"); }
}

async function rotationRequest<T>(path: string, method: "POST" | "PATCH", body?: object): Promise<T> {
  const response = await privateRequest(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.status === 404) throw new TreeNotFoundError();
  if (response.status === 409) throw new RotationChangedError();
  if (!response.ok) throw new Error("rotation unavailable");
  return response.json() as Promise<T>;
}

/** The Owner's verified key chain from the hidden root to one node's parent (and the node, if a Directory). */
async function openPath(access: RootAccess, nodeId: string): Promise<{ states: Map<string, DirectoryState>;
  entry: TreeEntry | null }> {
  const path = await loadAncestors(nodeId);
  if (path[0] !== access.rootId) throw new TreeNotFoundError();
  const states = new Map<string, DirectoryState>();
  let key: Uint8Array = access.rootKey, entry: TreeEntry | null = null;
  for (let index = 0; index < path.length; index++) {
    const id = path[index]!;
    if (index > 0 && entry?.kind !== "directory") break;
    const listing = await loadDirectory(access, id, key);
    states.set(id, { listing, key });
    const next = path[index + 1];
    if (!next) break;
    entry = listing.entries.find((item) => item.nodeId === next) ?? null;
    if (!entry) throw new TreeNotFoundError();
    if (entry.kind === "directory") key = await openChildDirectory(access, key, entry);
  }
  return { states, entry };
}

async function fileSource(fileId: string): Promise<RotationFile> {
  const response = await privateRequest(`/api/private/tree/files/${fileId}`, { method: "POST" });
  if (response.status === 404) throw new TreeNotFoundError();
  if (!response.ok) throw new Error("rotation unavailable");
  const file = await response.json() as Partial<RotationFile>;
  if (file.fileId !== fileId || !file.fileHead || !file.parentEnvelope || !file.receivingPublicKey) {
    throw new Error("invalid File head");
  }
  return file as RotationFile;
}

/** Runs one step of one job; returns false once the job has completed. */
export async function runRotationStep(access: RootAccess, signer: StructureSigner, targetId: string): Promise<boolean> {
  let step: RotationStep;
  try { step = await rotationRequest<RotationStep>(`/api/private/rotations/${targetId}/next`, "POST"); }
  catch (error) { if (error instanceof TreeNotFoundError) return false; throw error; }
  if (step.step === "file") {
    const { states, entry } = await openPath(access, step.fileId);
    const parentId = [...states.keys()].at(-1);
    const parent = parentId ? states.get(parentId) : undefined;
    if (!parent || !entry || entry.nodeId !== step.fileId) throw new TreeNotFoundError();
    const thread = step.mode === "rekey" ? await loadThreadKeySource(step.fileId) : null;
    const body = await prepareFileTargetRotation({ vaultId: access.vaultId, signer, parent, entry,
      file: await fileSource(step.fileId), step, thread });
    await rotationRequest(`/api/private/rotations/${targetId}/file`, "PATCH", body);
    return false;
  }
  if (step.step === "grants") {
    const { states } = await openPath(access, step.directoryId);
    const directory = states.get(step.directoryId);
    if (!directory || directory.listing.capabilityEpoch !== step.epoch) throw new RotationChangedError();
    const grants = await prepareGrantSeals({ ownerId: access.vaultId, directoryId: step.directoryId,
      key: directory.key, epoch: step.epoch, signer, grants: step.grants });
    await rotationRequest(`/api/private/rotations/${targetId}/grants`, "PATCH",
      { barrierEpoch: step.barrierEpoch, epoch: step.epoch, grants });
    return false;
  }
  throw new Error("unsupported rotation step");
}
