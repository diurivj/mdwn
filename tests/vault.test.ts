import { describe, expect, it } from "vitest";

import {
  RecoveryError,
  createRecoveryMaterial,
  createChildDirectoryCapability,
  createFileRepresentation,
  createVaultKeyHierarchy,
  decodeFileRepresentation,
  generateRecoveryPhrase,
  openRecoveryCapsule,
  openDeviceEnrollmentEnvelope,
  openVaultRecoveryEnvelope,
  sealDeviceEnrollmentEnvelope,
  sealVaultRecoveryEnvelope,
  reissueRecoveryMaterial,
  type RecoveryCapsuleExpectation,
} from "../app/crypto/vault";
import { inspectEnvelope, openSymmetric } from "../app/crypto/enc-v1";

const accountId = "account-01";
const expected: RecoveryCapsuleExpectation = {
  accountId,
  generation: 1,
};

describe("Vault key hierarchy", () => {
  it("creates independent Vault and root Directory keys and protects the root capability", async () => {
    const hierarchy = await createVaultKeyHierarchy({ accountId, rootDirectoryId: "directory-root" });

    expect(hierarchy.vaultRootKey).toHaveLength(32);
    expect(hierarchy.rootDirectoryCapabilityKey).toHaveLength(32);
    expect(hierarchy.rootDirectoryCapabilityKey).not.toEqual(hierarchy.vaultRootKey);
    expect(inspectEnvelope(hierarchy.rootDirectoryRecoveryEnvelope).context).toMatchObject({
      purpose: "vault-recovery",
      vaultId: accountId,
      objectId: "directory-root",
    });
    await expect(openVaultRecoveryEnvelope(
      hierarchy.rootDirectoryRecoveryEnvelope,
      hierarchy.vaultRootKey,
      hierarchy.rootDirectoryRecoveryContext,
    )).resolves.toEqual(hierarchy.rootDirectoryCapabilityKey);
  });

  it("rejects Grant-derived capabilities at the Vault-recovery envelope seam", async () => {
    const hierarchy = await createVaultKeyHierarchy({ accountId, rootDirectoryId: "directory-root" });

    await expect(sealVaultRecoveryEnvelope(hierarchy.vaultRootKey, {
      key: new Uint8Array(32),
      objectId: "shared-directory",
      keyId: "grant-key",
      scope: "grant",
    }, {
      purpose: "vault-recovery",
      vaultId: accountId,
      objectId: "shared-directory",
      keyId: "grant-key",
      keyEpoch: 1,
      revision: 1,
    })).rejects.toMatchObject({ code: "grant-capability" });
    await expect(sealVaultRecoveryEnvelope(hierarchy.vaultRootKey, {
      key: new Uint8Array(32),
      objectId: "shared-directory",
      keyId: "grant-key",
      scope: "owned",
      grantDerived: true,
    }, {
      purpose: "vault-recovery",
      vaultId: accountId,
      objectId: "shared-directory",
      keyId: "grant-key",
      keyEpoch: 1,
      revision: 1,
    })).rejects.toMatchObject({ code: "grant-capability" });
  });

  it("wraps a child Directory capability and a fresh File representation under their parent keys", async () => {
    const hierarchy = await createVaultKeyHierarchy({ accountId, rootDirectoryId: "directory-root" });
    const child = await createChildDirectoryCapability(hierarchy.rootDirectoryCapabilityKey, {
      vaultId: accountId,
      parentDirectoryId: "directory-root",
      childDirectoryId: "directory-child",
    });
    expect(child.capabilityKey).toHaveLength(32);
    expect(inspectEnvelope(child.envelope).context.purpose).toBe("directory-capability");
    await expect(openSymmetric(child.envelope, hierarchy.rootDirectoryCapabilityKey, { context: child.context }))
      .resolves.toEqual(child.capabilityKey);

    const file = await createFileRepresentation(child.capabilityKey, {
      markdown: "# Private",
      metadata: new TextEncoder().encode("{\"title\":\"Private\"}"),
    }, {
      vaultId: accountId,
      fileId: "file-1",
    });
    expect(file.fileContentKey).toHaveLength(32);
    expect(inspectEnvelope(file.fileContentKeyEnvelope).context.purpose).toBe("file-content-key");
    expect(inspectEnvelope(file.contentEnvelope).context.purpose).toBe("file-content");
    const openedFileKey = await openSymmetric(file.fileContentKeyEnvelope, child.capabilityKey, { context: file.keyContext });
    const openedRepresentation = await openSymmetric(file.contentEnvelope, openedFileKey, { context: file.contentContext });
    expect(decodeFileRepresentation(openedRepresentation)).toEqual({
      markdown: "# Private",
      metadata: new TextEncoder().encode("{\"title\":\"Private\"}"),
    });
  });

  it("uses HPKE device-enrollment envelopes for the Vault root", async () => {
    const hierarchy = await createVaultKeyHierarchy({ accountId, rootDirectoryId: "directory-root" });
    const device = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const context = {
      purpose: "device-enrollment" as const,
      vaultId: accountId,
      objectId: "device-1",
      keyId: "vault-root",
      keyEpoch: 1,
      revision: 1,
      recipientId: "device-1",
    };
    const envelope = await sealDeviceEnrollmentEnvelope(hierarchy.vaultRootKey, device.publicKey, context);
    expect(inspectEnvelope(envelope).suite).toBe("HPKE-P256/HKDF-SHA-256/AES-256-GCM");
    await expect(openDeviceEnrollmentEnvelope(envelope, device, context)).resolves.toEqual(hierarchy.vaultRootKey);
  });
});

describe("Vault recovery phrase and capsule", () => {
  it("round-trips a 256-bit checksum phrase and opens the capsule", async () => {
    const material = await createRecoveryMaterial(accountId, {
      vaultRootKey: Uint8Array.from({ length: 32 }, (_, index) => index),
    });

    expect(material.phrase.split(" ")).toHaveLength(24);
    expect(generateRecoveryPhrase(material.recoverySecret)).toBe(material.phrase);
    await expect(openRecoveryCapsule(material.record, material.phrase, {
      ...expected,
      recoverySalt: material.record.recoverySalt,
    })).resolves.toMatchObject({
      accountId,
      generation: 1,
      vaultRootKey: material.vaultRootKey,
    });
  });

  it("rejects a wrong phrase, generation, salt, tampered capsule, and superseded generation", async () => {
    const material = await createRecoveryMaterial(accountId);
    const wrongPhrase = `${"abandon ".repeat(23)}abandon`;
    await expect(openRecoveryCapsule(material.record, wrongPhrase, expected)).rejects.toMatchObject({ code: "invalid-phrase" });
    const validWrongPhrase = generateRecoveryPhrase(new Uint8Array(32));
    await expect(openRecoveryCapsule(material.record, validWrongPhrase, expected))
      .rejects.toMatchObject({ code: "authentication-failed" });
    await expect(openRecoveryCapsule(material.record, material.phrase, { accountId, generation: 2 }))
      .rejects.toMatchObject({ code: "superseded-generation" });
    await expect(openRecoveryCapsule(material.record, material.phrase, {
      accountId,
      generation: 1,
      recoverySalt: Uint8Array.from(material.record.recoverySalt, (byte) => byte ^ 1),
    })).rejects.toMatchObject({ code: "wrong-salt" });

    const tampered = new Uint8Array(material.record.capsule);
    tampered[tampered.length - 1] ^= 1;
    await expect(openRecoveryCapsule({ ...material.record, capsule: tampered }, material.phrase, expected))
      .rejects.toMatchObject({ code: "authentication-failed" });

    const next = await reissueRecoveryMaterial(material.record, material.phrase, {
      accountId,
      generation: material.generation,
      recoverySalt: material.record.recoverySalt,
    });
    expect(next.generation).toBe(2);
    expect(next.vaultRootKey).toEqual(material.vaultRootKey);
    await expect(openRecoveryCapsule(material.record, material.phrase, { accountId, generation: next.generation }))
      .rejects.toMatchObject({ code: "superseded-generation" });
    await expect(openRecoveryCapsule(next.record, next.phrase, {
      accountId,
      generation: next.generation,
      recoverySalt: next.record.recoverySalt,
    }))
      .resolves.toMatchObject({ vaultRootKey: material.vaultRootKey, generation: 2 });
    await expect(openSymmetric(next.record.capsule, next.recoverySecret, {
      context: {
        purpose: "recovery-capsule",
        vaultId: accountId,
        objectId: "vault-recovery-capsule",
        keyId: "vault-recovery-capsule",
        keyEpoch: next.generation,
        revision: 1,
      },
    })).rejects.toMatchObject({ code: "authentication-failed" });
  });

  it("does not accept a capsule under another Account or a missing signing key", async () => {
    const material = await createRecoveryMaterial(accountId);
    await expect(openRecoveryCapsule(material.record, material.phrase, { accountId: "other-account", generation: 1 }))
      .rejects.toMatchObject({ code: "wrong-account" });
    await expect(openRecoveryCapsule(material.record, material.phrase, {
      ...expected,
      recoverySalt: new Uint8Array(32),
    })).rejects.toMatchObject({ code: "wrong-salt" });
    const otherMaterial = await createRecoveryMaterial(accountId);
    await expect(openRecoveryCapsule({
      ...material.record,
      recoveryVerificationPublicKey: otherMaterial.record.recoveryVerificationPublicKey,
    }, material.phrase, {
      ...expected,
      recoverySalt: material.record.recoverySalt,
    })).rejects.toMatchObject({ code: "missing-key" });
  });
});

describe("RecoveryError", () => {
  it("does not include secrets or plaintext in its message", () => {
    const error = new RecoveryError("authentication-failed");
    expect(error.message).toBe("mdwn/vault: authentication-failed");
  });
});
