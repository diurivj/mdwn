import { openSymmetric, sealToRecipient } from "../../app/crypto/enc-v1";
import { digestBytes, hex, parseOffer, signOffer } from "../../app/sharing/offer";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/tree/wire";

/** Fixture-side mirror of the browser's needs-client sealing, shared by the Worker suites. */
export type FulfillDevice = { deviceId: string; registryEpoch: number; publicKey: string;
  labelDigest: string | null };
export type FulfillGrant = { grantId: string; recipientId: string; generation: number;
  permission: "read_only" | "read_write"; offer: { bytes: string; digest: string; signature: string };
  labelId: string; ownerCopy?: string; devices: FulfillDevice[] };
export type FulfillStep =
  | { step: "grants"; targetId: string; directoryId: string; epoch: number; grants: FulfillGrant[] }
  | { step: "file"; targetId: string; fileId: string; recipients: { accountId: string; deviceId: string;
      registryEpoch: number; publicKey: string; grants: { id: string; generation: number }[] }[];
      grants: FulfillGrant[] };
export type SealOwner = { accountId: string; deviceId: string; assertionKey: CryptoKey;
  vaultRoot: Uint8Array };

const enc = encodeTreeBytes;
const digest = async (value: Uint8Array) => hex(await digestBytes(value));

export function importDeviceKey(publicKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", decodeTreeBytes(publicKey, 65),
    { name: "ECDH", namedCurve: "P-256" }, true, []);
}

/**
 * A re-signed offer at the next material revision listing exactly the recipient's active
 * devices, plus a fresh Shared-as label only for devices whose current-epoch delivery is
 * missing. An existing delivery is reused: no label ciphertext is submitted for it, so the
 * stored bytes never change.
 */
export async function prepareFulfillGrants(owner: SealOwner, step: FulfillStep,
  content: (device: FulfillDevice, grant: FulfillGrant) => Promise<Uint8Array>) {
  const targetId = step.step === "grants" ? step.directoryId : step.fileId;
  return Promise.all(step.grants.map(async (grant) => {
    const stored = parseOffer(decodeTreeBytes(grant.offer.bytes, 131_072));
    const envelopes = await Promise.all(grant.devices.map(async (device) => ({ device,
      ciphertext: await content(device, grant) })));
    let plaintext: Uint8Array | null = null;
    if (grant.ownerCopy) plaintext = await openSymmetric(decodeTreeBytes(grant.ownerCopy, 4096), owner.vaultRoot,
      { context: { purpose: "share-root-label", vaultId: owner.accountId, objectId: targetId,
        keyId: grant.labelId, keyEpoch: 1, revision: 1 } });
    const labels = await Promise.all(grant.devices.map(async (device) => {
      if (device.labelDigest) return { deviceId: device.deviceId, ciphertext: null as Uint8Array | null,
        digest: device.labelDigest };
      const ciphertext = await sealToRecipient(plaintext!, await importDeviceKey(device.publicKey),
        { purpose: "share-root-label", vaultId: owner.accountId, objectId: targetId, keyId: grant.labelId,
          keyEpoch: 1, revision: 1, recipientId: device.deviceId });
      return { deviceId: device.deviceId, ciphertext, digest: await digest(ciphertext) };
    }));
    const devices = await Promise.all(envelopes.map(async ({ device, ciphertext }) => ({
      accountId: grant.recipientId, deviceId: device.deviceId, registryEpoch: device.registryEpoch,
      publicKeyDigest: await digest(decodeTreeBytes(device.publicKey, 65)),
      contentDigest: await digest(ciphertext),
      labelDigest: labels.find((item) => item.deviceId === device.deviceId)!.digest })));
    const offer = await signOffer({ ...stored, permission: grant.permission,
      materialRevision: stored.materialRevision + 1,
      targetKeyId: step.step === "grants" ? targetId : stored.targetKeyId,
      targetEpoch: step.step === "grants" ? step.epoch : stored.targetEpoch,
      registryEpoch: grant.devices[0]!.registryEpoch, devices, signerDeviceId: owner.deviceId },
      owner.assertionKey);
    return { grantId: grant.grantId,
      offer: { bytes: enc(offer.bytes), digest: enc(offer.digest), signature: enc(offer.signature) },
      devices: envelopes.map(({ device, ciphertext }, index) => ({ deviceId: device.deviceId,
        ...(step.step === "grants" ? { ciphertext: enc(ciphertext) } : {}),
        labelCiphertext: labels[index]!.ciphertext ? enc(labels[index]!.ciphertext!) : null })) };
  }));
}
