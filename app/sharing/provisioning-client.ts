import { inspectEnvelope, openForRecipient, sealToRecipient } from "~/crypto/enc-v1";
import { HPKE_SUITE } from "~/crypto/enc-v1/format";
import { privateRequest } from "~/device/private-client";
import { getDevice, type StoredDevice } from "~/device/store";
import { assertExactFileRecipientDescriptors, assertFileHeadCommitTransition,
  signFileHead, verifyDirectFileRecipientEnvelope, verifyFileHead,
  type DirectRecipientDescriptor, type FileHeadStatement } from "~/tree/file-head";
import { decodeTreeBytes, encodeTreeBytes, isV7 } from "~/tree/wire";
import { digestBytes, hex, sameBytes, verifyOffer } from "./offer";
import type { FileProvisioningBootstrap, FileProvisioningCompletion } from "./provisioning-wire";

type Bytes = Uint8Array<ArrayBuffer>;

const exactFields = (value: unknown, fields: readonly string[]): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));

function requireFields(value: unknown, fields: readonly string[]): void {
  if (!exactFields(value, fields)) throw new Error("Invalid direct File provisioning data");
}

function requireId(value: unknown): string {
  if (!isV7(value)) throw new Error("Invalid direct File provisioning identity");
  return value;
}

function requireCounter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Invalid direct File provisioning counter");
  }
  return value;
}

function requireP256Point(value: Uint8Array): Bytes {
  if (value.length !== 65 || value[0] !== 4) throw new Error("Invalid direct File provisioning public key");
  return new Uint8Array(value);
}

function isEcKey(key: CryptoKey | undefined, type: "private" | "public", algorithm: "ECDH" | "ECDSA",
  usage?: KeyUsage): key is CryptoKey {
  return !!key && key.type === type && key.extractable === (type === "public") &&
    key.algorithm.name === algorithm && "namedCurve" in key.algorithm && key.algorithm.namedCurve === "P-256" &&
    (!usage || key.usages.includes(usage));
}

type RecipientSnapshot = { accountId: string; deviceId: string; registryEpoch: number;
  publicKeyBytes: Bytes; grants: { id: string; generation: number }[] };
type BootstrapSnapshot = { ownerId: string; fileId: string;
  currentHead: { bytes: Bytes; digest: Bytes; signature: Bytes;
    signerDeviceId: string; signerPublicKey: Bytes; digestWire: string };
  recipients: RecipientSnapshot[];
  retained: { ciphertext: Bytes; digest: Bytes; contentKeyId: string;
    contentEpoch: number; revision: number; provenance: { grantId: string; offerBytes: Bytes;
      offerDigest: Bytes; offerSignature: Bytes; signerDeviceId: string; signerPublicKey: Bytes } } };

/** Copy and strictly bound every untrusted byte string before the first async crypto operation. */
function snapshotBootstrap(input: FileProvisioningBootstrap): BootstrapSnapshot {
  requireFields(input, ["ownerId", "fileId", "currentHead", "recipients", "retained"]);
  const ownerId = requireId(input.ownerId);
  const fileId = requireId(input.fileId);
  requireFields(input.currentHead, ["bytes", "digest", "signature", "signerDeviceId", "signerPublicKey"]);
  const currentHead = { bytes: decodeTreeBytes(input.currentHead.bytes, 131_072),
    digest: decodeTreeBytes(input.currentHead.digest, 32),
    signature: decodeTreeBytes(input.currentHead.signature, 64),
    signerDeviceId: requireId(input.currentHead.signerDeviceId),
    signerPublicKey: requireP256Point(decodeTreeBytes(input.currentHead.signerPublicKey, 65)),
    digestWire: input.currentHead.digest };

  requireFields(input.retained, ["ciphertext", "digest", "contentKeyId", "contentEpoch", "revision", "provenance"]);
  const contentKeyId = requireId(input.retained.contentKeyId);
  const contentEpoch = requireCounter(input.retained.contentEpoch);
  const revision = requireCounter(input.retained.revision);
  const ciphertext = decodeTreeBytes(input.retained.ciphertext, 16_384);
  const digest = decodeTreeBytes(input.retained.digest, 32);
  requireFields(input.retained.provenance,
    ["grantId", "offerBytes", "offerDigest", "offerSignature", "signerDeviceId", "signerPublicKey"]);
  const provenance = { grantId: requireId(input.retained.provenance.grantId),
    offerBytes: decodeTreeBytes(input.retained.provenance.offerBytes, 131_072),
    offerDigest: decodeTreeBytes(input.retained.provenance.offerDigest, 32),
    offerSignature: decodeTreeBytes(input.retained.provenance.offerSignature, 64),
    signerDeviceId: requireId(input.retained.provenance.signerDeviceId),
    signerPublicKey: requireP256Point(decodeTreeBytes(input.retained.provenance.signerPublicKey, 65)) };

  if (!Array.isArray(input.recipients) || input.recipients.length < 1 || input.recipients.length > 256) {
    throw new Error("Invalid direct File recipient set");
  }
  const seenDevices = new Set<string>();
  const recipients = input.recipients.map((recipient): RecipientSnapshot => {
    requireFields(recipient, ["accountId", "deviceId", "registryEpoch", "publicKey", "grants"]);
    const accountId = requireId(recipient.accountId);
    const deviceId = requireId(recipient.deviceId);
    if (seenDevices.has(deviceId)) throw new Error("Duplicate direct File recipient");
    seenDevices.add(deviceId);
    const registryEpoch = requireCounter(recipient.registryEpoch);
    const publicKeyBytes = requireP256Point(decodeTreeBytes(recipient.publicKey, 65));
    if (!Array.isArray(recipient.grants) || recipient.grants.length < 1 || recipient.grants.length > 16) {
      throw new Error("Invalid direct File recipient Grants");
    }
    const seenGrants = new Set<string>();
    const grants = recipient.grants.map((grant) => {
      requireFields(grant, ["id", "generation"]);
      const id = requireId(grant.id);
      if (seenGrants.has(id)) throw new Error("Duplicate direct File recipient Grant");
      seenGrants.add(id);
      return { id, generation: requireCounter(grant.generation) };
    }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    return { accountId, deviceId, registryEpoch, publicKeyBytes, grants };
  }).sort((left, right) => left.accountId < right.accountId ? -1 : left.accountId > right.accountId ? 1 :
    left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0);

  return { ownerId, fileId, currentHead, recipients,
    retained: { ciphertext, digest, contentKeyId, contentEpoch, revision, provenance } };
}

function snapshotDevice(input: StoredDevice): { accountId: string; deviceId: string; registryEpoch: number;
  transportKeyPair: CryptoKeyPair; assertionKeyPair: CryptoKeyPair } {
  if (!input || typeof input !== "object") throw new Error("Local device unavailable");
  const accountId = requireId(input.accountId);
  const deviceId = requireId(input.deviceId);
  const registryEpoch = requireCounter(input.registryEpoch);
  const transportKeyPair = input.transportKeyPair;
  const assertionKeyPair = input.assertionKeyPair;
  if (!transportKeyPair || !isEcKey(transportKeyPair.privateKey, "private", "ECDH", "deriveBits") ||
      !isEcKey(transportKeyPair.publicKey, "public", "ECDH") ||
      !assertionKeyPair || !isEcKey(assertionKeyPair.privateKey, "private", "ECDSA", "sign") ||
      !isEcKey(assertionKeyPair.publicKey, "public", "ECDSA", "verify")) {
    throw new Error("Local device keys unavailable");
  }
  return { accountId, deviceId, registryEpoch, transportKeyPair, assertionKeyPair };
}

function verifyRetainedContext(ciphertext: Uint8Array, expected: {
  ownerId: string; fileId: string; contentKeyId: string; contentEpoch: number; revision: number; deviceId: string;
}): void {
  const envelope = inspectEnvelope(ciphertext);
  const context = envelope.context;
  const fields = ["purpose", "vaultId", "objectId", "keyId", "keyEpoch", "revision", "recipientId"];
  if (envelope.suite !== HPKE_SUITE || Object.keys(context).length !== fields.length ||
      fields.some((field) => !Object.hasOwn(context, field)) || context.purpose !== "grant" ||
      context.vaultId !== expected.ownerId || context.objectId !== expected.fileId ||
      context.keyId !== expected.contentKeyId || context.keyEpoch !== expected.contentEpoch ||
      context.revision !== expected.revision || context.recipientId !== expected.deviceId) {
    throw new Error("Invalid retained File key envelope");
  }
}

/**
 * Verify Owner-signed historical provenance and prepare a complete, same-revision
 * recipient-set update. The plaintext File content key is held only in this call
 * and zeroed before the completion wire leaves it.
 */
export async function prepareDirectFileProvisioning(input: FileProvisioningBootstrap,
  localInput: StoredDevice): Promise<FileProvisioningCompletion> {
  const bootstrap = snapshotBootstrap(input);
  const device = snapshotDevice(localInput);
  const localTransportBytes = requireP256Point(new Uint8Array(await crypto.subtle.exportKey(
    "raw", device.transportKeyPair.publicKey)));
  await crypto.subtle.importKey("raw", localTransportBytes,
    { name: "ECDH", namedCurve: "P-256" }, false, []);
  const localTransportDigest = await digestBytes(localTransportBytes);
  const localAssertionBytes = requireP256Point(new Uint8Array(await crypto.subtle.exportKey(
    "raw", device.assertionKeyPair.publicKey)));

  const offer = await verifyOffer(bootstrap.retained.provenance.offerBytes,
    bootstrap.retained.provenance.offerDigest, bootstrap.retained.provenance.offerSignature,
    bootstrap.retained.provenance.signerPublicKey);
  if (offer.grantId !== bootstrap.retained.provenance.grantId ||
      offer.signerDeviceId !== bootstrap.retained.provenance.signerDeviceId ||
      offer.ownerId !== bootstrap.ownerId || offer.recipientId !== device.accountId ||
      offer.targetId !== bootstrap.fileId || offer.kind !== "file" ||
      offer.targetKeyId !== bootstrap.retained.contentKeyId ||
      offer.targetEpoch !== bootstrap.retained.contentEpoch ||
      offer.contentRevision !== bootstrap.retained.revision) {
    throw new Error("Retained Owner provenance does not match this File");
  }
  const historicalDevices = offer.devices.filter((item) =>
    item.accountId === device.accountId && item.deviceId === device.deviceId);
  if (historicalDevices.length !== 1) throw new Error("Retained Owner provenance omits this device");
  const historicalDevice = historicalDevices[0]!;
  const retainedDigest = await digestBytes(bootstrap.retained.ciphertext);
  if (!sameBytes(retainedDigest, bootstrap.retained.digest) ||
      historicalDevice.publicKeyDigest !== hex(localTransportDigest) ||
      historicalDevice.contentDigest !== hex(retainedDigest)) {
    throw new Error("Retained Owner provenance does not match the retained material");
  }

  const currentHead = await verifyFileHead({ bytes: bootstrap.currentHead.bytes,
    digest: bootstrap.currentHead.digest, signature: bootstrap.currentHead.signature }, {
    ownerId: bootstrap.ownerId, vaultId: bootstrap.ownerId, fileId: bootstrap.fileId,
    signerDeviceId: bootstrap.currentHead.signerDeviceId,
    publicKey: bootstrap.currentHead.signerPublicKey, revision: bootstrap.retained.revision,
  });
  const before = currentHead.statement;
  if (before.contentKey.id !== bootstrap.retained.contentKeyId ||
      before.contentKey.epoch !== bootstrap.retained.contentEpoch ||
      before.revision !== bootstrap.retained.revision) {
    throw new Error("Current File head does not match the retained key");
  }

  const currentRecipients = await Promise.all(bootstrap.recipients.map(async (recipient) => {
    const publicKey = await crypto.subtle.importKey("raw", recipient.publicKeyBytes,
      { name: "ECDH", namedCurve: "P-256" }, true, []);
    return { ...recipient, publicKey, publicKeyDigest: await digestBytes(recipient.publicKeyBytes) };
  }));
  const localRecipients = currentRecipients.filter((recipient) =>
    recipient.accountId === device.accountId && recipient.deviceId === device.deviceId);
  if (localRecipients.length !== 1) throw new Error("Current recipient set omits this device");
  const localRecipient = localRecipients[0]!;
  if (localRecipient.registryEpoch !== device.registryEpoch ||
      !sameBytes(localRecipient.publicKeyBytes, localTransportBytes) ||
      !sameBytes(localRecipient.publicKeyDigest, localTransportDigest) ||
      !localRecipient.grants.some((grant) => grant.id === bootstrap.retained.provenance.grantId)) {
    throw new Error("Current recipient identity does not match this device");
  }

  verifyRetainedContext(bootstrap.retained.ciphertext, { ownerId: bootstrap.ownerId,
    fileId: bootstrap.fileId, contentKeyId: bootstrap.retained.contentKeyId,
    contentEpoch: bootstrap.retained.contentEpoch, revision: bootstrap.retained.revision,
    deviceId: device.deviceId });

  const contentKey = await openForRecipient(bootstrap.retained.ciphertext, device.transportKeyPair, {
    context: { purpose: "grant", vaultId: bootstrap.ownerId, objectId: bootstrap.fileId,
      keyId: bootstrap.retained.contentKeyId, keyEpoch: bootstrap.retained.contentEpoch,
      revision: bootstrap.retained.revision, recipientId: device.deviceId },
  });
  try {
    if (contentKey.length !== 32) throw new Error("Invalid retained File content key");
    const wrapped = await Promise.all(currentRecipients.map(async (recipient) => {
      const ciphertext = await sealToRecipient(contentKey, recipient.publicKey, {
        purpose: "grant", vaultId: bootstrap.ownerId, objectId: bootstrap.fileId,
        keyId: before.contentKey.id, keyEpoch: before.contentKey.epoch,
        revision: before.revision, recipientId: recipient.deviceId,
      });
      return { ...recipient, ciphertext, envelopeDigest: await digestBytes(ciphertext) };
    }));
    const recipients: DirectRecipientDescriptor[] = wrapped.map((item) => ({
      accountId: item.accountId, deviceId: item.deviceId, registryEpoch: item.registryEpoch,
      publicKeyDigest: item.publicKeyDigest, grants: item.grants, envelopeDigest: item.envelopeDigest,
    }));
    const recipientSetVersion = before.recipientSetVersion + 1;
    if (!Number.isSafeInteger(recipientSetVersion)) throw new Error("File recipient set is exhausted");
    const statement: FileHeadStatement = { ...before, recipients, recipientSetVersion, signerDeviceId: device.deviceId };
    const signed = await signFileHead(statement, device.assertionKeyPair.privateKey);
    const next = await verifyFileHead(signed, { ownerId: bootstrap.ownerId, vaultId: bootstrap.ownerId,
      fileId: bootstrap.fileId, revision: before.revision, signerDeviceId: device.deviceId,
      publicKey: localAssertionBytes });
    assertFileHeadCommitTransition(currentHead, next, { expectedSameRevisionTransition: "recipient-set-update" });
    assertExactFileRecipientDescriptors(next, recipients.map(({ envelopeDigest: _digest, ...recipient }) => recipient));
    await Promise.all(wrapped.map((recipient) => verifyDirectFileRecipientEnvelope(next,
      recipient.accountId, recipient.deviceId, recipient.publicKeyBytes, recipient.ciphertext)));

    return { expectedHeadDigest: bootstrap.currentHead.digestWire,
      expectedRevision: before.revision, expectedRecipientSetVersion: before.recipientSetVersion,
      signedHead: { bytes: encodeTreeBytes(signed.bytes), digest: encodeTreeBytes(signed.digest),
        signature: encodeTreeBytes(signed.signature) },
      recipientEnvelopes: wrapped.map((recipient) => ({ deviceId: recipient.deviceId,
        ciphertext: encodeTreeBytes(recipient.ciphertext) })) };
  } finally {
    contentKey.fill(0);
  }
}

export type DirectFileProvisioningState = "ready" | "provisioning" | "stale" | "error";

/** Resolve the currently authenticated, locally-held device without exposing its keys. */
async function currentStoredDevice(signal: AbortSignal): Promise<StoredDevice> {
  signal.throwIfAborted();
  const response = await fetch("/api/device/state", { cache: "no-store", signal });
  if (!response.ok) throw new Error("Device state unavailable");
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Device state unavailable");
  }
  const state = value as Record<string, unknown>;
  const accountId = state.accountId;
  const deviceId = state.deviceId;
  const registryEpoch = state.registryEpoch;
  if (!isV7(accountId) || !isV7(deviceId) || typeof registryEpoch !== "number" ||
      !Number.isSafeInteger(registryEpoch) || registryEpoch < 1 ||
      typeof state.sessionBinding !== "string" || !state.sessionBinding) {
    throw new Error("Device state unavailable");
  }
  const device = await getDevice(accountId);
  signal.throwIfAborted();
  if (!device || device.deviceId !== deviceId || device.registryEpoch !== registryEpoch) {
    throw new Error("Local device unavailable");
  }
  return device;
}

/**
 * Run one proof-bound browser provisioning attempt. The only response data is a
 * safe UI state; bootstrap material and the signed completion stay in this call.
 */
export async function provisionDirectFile(fileId: string, signal: AbortSignal):
  Promise<DirectFileProvisioningState> {
  if (!isV7(fileId)) return "error";

  signal.throwIfAborted();
  const bootstrapResponse = await privateRequest(
    `/api/private/sharing/direct-files/${fileId}/bootstrap`, { method: "POST", signal });
  if (bootstrapResponse.status === 202) return "provisioning";
  if (bootstrapResponse.status === 409) return "stale";
  if (bootstrapResponse.status !== 200) return "error";

  const bootstrap = await bootstrapResponse.json() as FileProvisioningBootstrap;
  const device = await currentStoredDevice(signal);
  signal.throwIfAborted();
  const completion = await prepareDirectFileProvisioning(bootstrap, device);

  signal.throwIfAborted();
  const response = await privateRequest(`/api/private/sharing/direct-files/${fileId}/complete`, {
    method: "PATCH", body: JSON.stringify(completion), signal,
  });
  if (response.status === 202) return "provisioning";
  if (response.status === 409) return "stale";
  if (response.status !== 200) return "error";

  const result: unknown = await response.json();
  if (typeof result !== "object" || result === null || Array.isArray(result)) return "error";
  const status = (result as Record<string, unknown>).status;
  return status === "ready" || status === "provisioning" ? status : "error";
}
