import { loadPrivateThread, provisionThreadDevices, type ThreadSubject } from "~/comments/client";
import { openSymmetric, sealToRecipient } from "~/crypto/enc-v1";
import { openFileReceivingKey } from "~/crypto/file-receiving";
import { privateRequest } from "~/device/private-client";
import { TreeNotFoundError, type RootAccess } from "~/tree/client";
import type { StructureSigner } from "~/tree/structure-client";
import { decodeTreeBytes, encodeTreeBytes } from "~/tree/wire";
import { digestBytes, hex, parseOffer, signOffer, type OfferDevice } from "./offer";
import { fileSource, openPath, prepareFileTargetRotation, type RotationRecipient } from "./rotation-client";

/** The Owner's outstanding provisioning work, grouped one opaque target at a time. */
export type ProvisioningTarget = { targetId: string; kind: "file" | "directory"; needs: number; devices: number };
/** One Grant's current devices as the Worker reports them; `labelDigest` is null when the
 * recipient's epoch advance invalidated its Shared-as label and a fresh one must be sealed. */
export type FulfillGrantWire = { grantId: string; recipientId: string; generation: number;
  permission: "read_only" | "read_write"; offer: { bytes: string; digest: string; signature: string };
  labelId: string; ownerCopy?: string;
  devices: { deviceId: string; registryEpoch: number; publicKey: string; labelDigest: string | null }[] };
export type ProvisioningStep =
  | { step: "grants"; targetId: string; directoryId: string; epoch: number; grants: FulfillGrantWire[] }
  | { step: "file"; targetId: string; fileId: string; recipients: RotationRecipient[];
      grants: FulfillGrantWire[] };

export class ProvisioningChangedError extends Error {
  constructor() { super("provisioning_changed"); }
}

async function request<T>(path: string, method: "POST" | "PATCH", body?: object): Promise<T> {
  const response = await privateRequest(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.status === 404) throw new TreeNotFoundError();
  if (response.status === 409) throw new ProvisioningChangedError();
  if (!response.ok) throw new Error("provisioning unavailable");
  return response.json() as Promise<T>;
}

/** HPKE serializes the recipient key, so a public key is imported extractable (as browsers do anyway). */
const importP256 = (raw: string) => crypto.subtle.importKey("raw", decodeTreeBytes(raw, 65),
  { name: "ECDH", namedCurve: "P-256" }, true, []);

type ContentSealer = (deviceId: string, publicKey: string) => Promise<Uint8Array>;

/**
 * Re-seals one Grant: a re-signed offer at the next material revision listing exactly the
 * recipient's active devices, each with the digest of the submitted capability/File envelope,
 * plus a fresh Shared-as label for every device whose current-epoch delivery was missing.
 * The label ID and Owner copy never change, so the recipient's `roots` verification accepts
 * the re-signed offer exactly as it accepted the original.
 */
async function buildSeals(options: { ownerId: string; targetId: string; targetKind: "file" | "directory";
  epoch: number; signer: StructureSigner; vaultRoot: Uint8Array; grants: readonly FulfillGrantWire[];
  content: ContentSealer; includeContent: boolean }) {
  return Promise.all(options.grants.map(async (grant) => {
    const stored = parseOffer(decodeTreeBytes(grant.offer.bytes, 131_072));
    if (stored.grantId !== grant.grantId || stored.ownerId !== options.ownerId ||
        stored.targetId !== options.targetId || stored.recipientId !== grant.recipientId ||
        stored.kind !== options.targetKind || stored.labelId !== grant.labelId || !grant.devices.length) {
      throw new Error("invalid Grant material");
    }
    const envelopes = await Promise.all(grant.devices.map(async (device) => ({ device,
      ciphertext: await options.content(device.deviceId, device.publicKey) })));
    let plaintext: Uint8Array | null = null;
    if (grant.ownerCopy) {
      plaintext = await openSymmetric(decodeTreeBytes(grant.ownerCopy, 4096), options.vaultRoot,
        { context: { purpose: "share-root-label", vaultId: options.ownerId, objectId: options.targetId,
          keyId: grant.labelId, keyEpoch: 1, revision: 1 } });
    }
    const labels = await Promise.all(grant.devices.map(async (device) => {
      if (device.labelDigest) return { deviceId: device.deviceId, ciphertext: null as Uint8Array | null,
        digest: device.labelDigest };
      if (!plaintext) throw new Error("missing Owner copy");
      const ciphertext = await sealToRecipient(plaintext, await importP256(device.publicKey),
        { purpose: "share-root-label", vaultId: options.ownerId, objectId: options.targetId, keyId: grant.labelId,
          keyEpoch: 1, revision: 1, recipientId: device.deviceId });
      return { deviceId: device.deviceId, ciphertext, digest: hex(await digestBytes(ciphertext)) };
    }));
    const devices: OfferDevice[] = await Promise.all(envelopes.map(async ({ device, ciphertext }) => ({
      accountId: grant.recipientId, deviceId: device.deviceId, registryEpoch: device.registryEpoch,
      publicKeyDigest: hex(await digestBytes(decodeTreeBytes(device.publicKey, 65))),
      contentDigest: hex(await digestBytes(ciphertext)),
      labelDigest: labels.find((item) => item.deviceId === device.deviceId)!.digest })));
    const offer = await signOffer({ ...stored, permission: grant.permission,
      materialRevision: stored.materialRevision + 1,
      targetKeyId: options.targetKind === "directory" ? options.targetId : stored.targetKeyId,
      targetEpoch: options.targetKind === "directory" ? options.epoch : stored.targetEpoch,
      registryEpoch: grant.devices[0]!.registryEpoch, devices, signerDeviceId: options.signer.deviceId },
      options.signer.assertionKey);
    return { grantId: grant.grantId,
      offer: { bytes: encodeTreeBytes(offer.bytes), digest: encodeTreeBytes(offer.digest),
        signature: encodeTreeBytes(offer.signature) },
      devices: envelopes.map(({ device, ciphertext }, index) => ({ deviceId: device.deviceId,
        ...(options.includeContent ? { ciphertext: encodeTreeBytes(ciphertext) } : {}),
        labelCiphertext: labels[index]!.ciphertext ? encodeTreeBytes(labels[index]!.ciphertext!) : null })) };
  }));
}

/** A Directory's unchanged current capability re-sealed to every active device of every Grant. */
export async function prepareDirectoryFulfillment(options: { ownerId: string; directoryId: string;
  epoch: number; signer: StructureSigner; vaultRoot: Uint8Array;
  grants: readonly FulfillGrantWire[]; key: Uint8Array }) {
  return { epoch: options.epoch, grants: await buildSeals({ ...options, targetId: options.directoryId,
    targetKind: "directory", includeContent: true, content: async (deviceId, publicKey) =>
      sealToRecipient(options.key, await importP256(publicKey), { purpose: "grant", vaultId: options.ownerId,
        objectId: options.directoryId, keyId: options.directoryId, keyEpoch: options.epoch, revision: 1,
        recipientId: deviceId }) }) };
}

/** Re-signed offers and fresh labels over the File envelopes the recipient-set update already produced. */
export async function prepareFileFulfillment(options: { ownerId: string; fileId: string;
  signer: StructureSigner; vaultRoot: Uint8Array; grants: readonly FulfillGrantWire[];
  envelopes: ReadonlyMap<string, Uint8Array> }) {
  return { grants: await buildSeals({ ...options, targetId: options.fileId, targetKind: "file", epoch: 0,
    includeContent: false, content: async (deviceId) => {
      const ciphertext = options.envelopes.get(deviceId);
      if (!ciphertext) throw new Error("missing File envelope");
      return ciphertext; } }) };
}

/** The Owner opens the File receiving pair through the parent capability for thread provisioning. */
async function threadSubject(access: RootAccess, fileId: string): Promise<ThreadSubject | null> {
  const { states, entry } = await openPath(access, fileId);
  const parentId = [...states.keys()].at(-1);
  const parent = parentId ? states.get(parentId) : undefined;
  if (!parent || !entry || entry.encoding !== "receiving-file" || !entry.receivingKeyId ||
      !entry.receivingEpoch || !entry.wrapRevision || entry.nodeId !== fileId) return null;
  const file = await fileSource(fileId);
  const receiving = await openFileReceivingKey(decodeTreeBytes(entry.keyEnvelope, 16_384), parent.key, {
    vaultId: access.vaultId, fileId, receivingKeyId: entry.receivingKeyId, receivingEpoch: entry.receivingEpoch,
    wrapRevision: entry.wrapRevision, publicKey: decodeTreeBytes(file.receivingPublicKey, 65) });
  return { ownerId: access.vaultId, fileId, actorAccountId: access.actorAccountId ?? access.vaultId,
    receivingKeyId: entry.receivingKeyId, receivingEpoch: entry.receivingEpoch,
    receivingPublicKey: decodeTreeBytes(file.receivingPublicKey, 65), receiving };
}

/** Direct thread devices waiting for the current epoch are provisioned through the same route
 * the Comments pane uses; the Owner reaches the thread key through the File receiving pair. */
export async function provisionFileThread(access: RootAccess, fileId: string): Promise<number> {
  const subject = await threadSubject(access, fileId);
  if (!subject) return 0;
  const thread = await loadPrivateThread(subject);
  if (thread.status !== "ready") return 0;
  return provisionThreadDevices(subject, thread);
}

/** Runs one bounded step for one target: Directory Grants, or a File recipient-set update. */
export async function runProvisioningStep(access: RootAccess, signer: StructureSigner, targetId: string): Promise<void> {
  const step = await request<ProvisioningStep>(`/api/private/provisioning/${targetId}/next`, "POST");
  const vaultRoot = access.vaultRoot;
  if (!vaultRoot) throw new Error("vault root unavailable");
  if (step.step === "grants") {
    const { states } = await openPath(access, step.directoryId);
    const directory = states.get(step.directoryId);
    if (!directory || directory.listing.capabilityEpoch !== step.epoch) throw new ProvisioningChangedError();
    const body = await prepareDirectoryFulfillment({ ownerId: access.vaultId, directoryId: step.directoryId,
      epoch: step.epoch, signer, vaultRoot, grants: step.grants, key: directory.key });
    await request(`/api/private/provisioning/${targetId}/grants`, "PATCH", body);
    return;
  }
  const { states, entry } = await openPath(access, step.fileId);
  const parentId = [...states.keys()].at(-1);
  const parent = parentId ? states.get(parentId) : undefined;
  if (!parent || !entry || entry.nodeId !== step.fileId) throw new TreeNotFoundError();
  const rotation = await prepareFileTargetRotation({ vaultId: access.vaultId, signer, parent, entry,
    file: await fileSource(step.fileId), thread: null,
    step: { step: "file", targetId: step.targetId, fileId: step.fileId, mode: "reprovision",
      barrierEpoch: 0, recipients: step.recipients } });
  const envelopes = new Map(rotation.recipientEnvelopes.map((item) =>
    [item.deviceId, decodeTreeBytes(item.ciphertext, 16_384)] as const));
  const grants = await prepareFileFulfillment({ ownerId: access.vaultId, fileId: step.fileId, signer,
    vaultRoot, grants: step.grants, envelopes });
  await request(`/api/private/provisioning/${targetId}/file`, "PATCH", {
    expectedHeadDigest: rotation.expectedHeadDigest, signedHead: rotation.signedHead,
    recipientEnvelopes: rotation.recipientEnvelopes, grants: grants.grants });
  await provisionFileThread(access, step.fileId);
}

/**
 * Runs every outstanding fulfillment target to completion, one bounded step at a time.
 * A step refused because a rotation barrier or a concurrent change moved underneath it is
 * left for the next pass; the needs rows it did not satisfy remain the resumable cursor.
 */
export async function runPendingProvisioning(access: RootAccess, signer: StructureSigner,
  onProgress: (progress: { targets: number; done: number }) => void): Promise<number> {
  let done = 0;
  for (let round = 0; round < 1000; round++) {
    const list = await request<{ targets: ProvisioningTarget[]; nextCursor: string | null }>(
      "/api/private/provisioning", "POST");
    if (!list.targets.length) return done;
    let progressed = 0;
    for (const target of list.targets) {
      try { await runProvisioningStep(access, signer, target.targetId); progressed++; done++; }
      catch (error) {
        if (!(error instanceof ProvisioningChangedError || error instanceof TreeNotFoundError)) throw error;
      }
      onProgress({ targets: list.targets.length, done });
    }
    if (!progressed) return done;
  }
  return done;
}
