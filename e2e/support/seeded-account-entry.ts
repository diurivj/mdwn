import { prepareRecoveryCodeSet } from "../../app/auth/recovery-codes";
import { sealAccountProfile } from "../../app/crypto/account-profile";
import { createRecoveryMaterial, createVaultKeyHierarchy, sealDeviceEnrollmentEnvelope } from "../../app/crypto/vault";
import { createDevice, updateRegistryEpoch } from "../../app/device/store";
import { newOpaqueId } from "../../app/opaque-id";
import { encodeBytes } from "../../app/signup/protocol";

/** Test-only browser entry: no network, Session, recovery gate, or provisioning. */
export async function prepareAccount() {
  const accountId = newOpaqueId(), deviceId = newOpaqueId(), rootDirectoryId = newOpaqueId();
  const device = await createDevice(accountId, deviceId);
  await updateRegistryEpoch(accountId, 1);
  const hierarchy = await createVaultKeyHierarchy({ accountId, rootDirectoryId });
  const recovery = await createRecoveryMaterial(accountId, { vaultRootKey: hierarchy.vaultRootKey });
  const enrollment = await sealDeviceEnrollmentEnvelope(hierarchy.vaultRootKey, device.transportKeyPair.publicKey, {
    purpose: "device-enrollment", vaultId: accountId, objectId: deviceId, keyId: deviceId,
    keyEpoch: 1, revision: 1, recipientId: deviceId,
  });
  const profile = await sealAccountProfile(hierarchy.vaultRootKey, {
    publicPseudonym: `Member ${encodeBytes(crypto.getRandomValues(new Uint8Array(9)))}`,
  }, { accountId, epoch: 1, revision: 1 });
  const codes = await prepareRecoveryCodeSet();
  // Plain arrays survive Playwright's serialization in every browser engine.
  return {
    accountId, deviceId, rootDirectoryId,
    phrase: recovery.phrase, recoveryCodes: codes.codes, recoveryCodeHashes: codes.hashes,
    transportPublicKey: Array.from(new Uint8Array(await crypto.subtle.exportKey("raw", device.transportKeyPair.publicKey))),
    assertionPublicKey: Array.from(new Uint8Array(await crypto.subtle.exportKey("raw", device.assertionKeyPair.publicKey))),
    rootRecoveryEnvelope: Array.from(hierarchy.rootDirectoryRecoveryEnvelope),
    enrollmentEnvelope: Array.from(enrollment),
    profile: Array.from(profile.ciphertext),
    capsule: Array.from(recovery.record.capsule),
    recoverySalt: Array.from(recovery.recoverySalt),
    recoveryVerificationPublicKey: Array.from(recovery.recoveryVerificationPublicKeyBytes),
  };
}
