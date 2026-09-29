import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { digestEnvelope, openForRecipient, openSymmetric, sealToRecipient } from "../../app/crypto/enc-v1";
import {
  createRecoveryMaterial, createVaultKeyHierarchy, openDeviceEnrollmentEnvelope,
  openOwnedDeviceEnvelope, openRecoveryCapsule, openVaultRecoveryEnvelope,
  sealDeviceEnrollmentEnvelope, sealOwnedDeviceEnvelope,
} from "../../app/crypto/vault";
import { signDeviceProof, sessionBindingDigest } from "../../app/device/proof";
import { nextRecoveryMetadataDigest, possessionMessage, recoveryIntentMessage, sha256, type RecoveryIntent } from "../../app/recovery/protocol";
import { decodeBytes, encodeBytes } from "../../app/signup/protocol";
import { hex } from "../../app/sharing/offer";
import { decodeTreeBytes } from "../../app/tree/wire";
import { seedNormalSession, type SeededSession } from "./auth-fixtures";
import { importDeviceKey, prepareFulfillGrants, type FulfillStep } from "./provisioning-fixtures";
import { actor, call, directory, shareDirectory, state, type Actor } from "./tree-fixtures";

declare global {
  namespace Cloudflare { interface Env {
    TEST_MIGRATIONS: D1Migration[];
    SESSION_COOKIE_SECRET: string;
    ABUSE_HMAC_SECRET: string;
  } }
}

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

function uuidv7(): string {
  const id = crypto.randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}

const networks = new Map<string, string>();
const post = (path: string, cookie: string, body: object = {}) => SELF.fetch(`https://mdwn.test${path}`, {
  method: "POST", headers: { cookie, origin: "https://mdwn.test", "content-type": "application/json",
    "CF-Connecting-IP": networks.get(cookie) ?? (() => {
      const ip = `198.51.100.${networks.size + 1}`;
      networks.set(cookie, ip);
      return ip;
    })() },
  body: JSON.stringify(body),
});

async function fixture() {
  const accountId = uuidv7();
  const rootId = uuidv7();
  const oldDeviceId = uuidv7();
  const credentialId = crypto.randomUUID();
  const now = Date.now();
  const hierarchy = await createVaultKeyHierarchy({ accountId, rootDirectoryId: rootId });
  const material = await createRecoveryMaterial(accountId, { vaultRootKey: hierarchy.vaultRootKey });
  const oldTransport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const oldAssertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const oldEnrollment = await sealDeviceEnrollmentEnvelope(hierarchy.vaultRootKey, oldTransport.publicKey, {
    purpose: "device-enrollment", vaultId: accountId, objectId: oldDeviceId,
    keyId: oldDeviceId, keyEpoch: 1, revision: 1, recipientId: oldDeviceId,
  });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(accountId, crypto.randomUUID(), now, now),
    env.DB.prepare("INSERT INTO passkeys (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at) VALUES (?, ?, ?, 0, '[]', 'singleDevice', 0, ?, ?)")
      .bind(credentialId, accountId, Uint8Array.of(1), now, now),
    env.DB.prepare("INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)")
      .bind(accountId, rootId),
    env.DB.prepare("INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, ?, ?, 'active', 'signup', 1, ?)")
      .bind(oldDeviceId, accountId, new Uint8Array(await crypto.subtle.exportKey("raw", oldTransport.publicKey)),
        new Uint8Array(await crypto.subtle.exportKey("raw", oldAssertion.publicKey)), now),
    env.DB.prepare("INSERT INTO recovery_capsules (account_id, generation, recovery_salt, ciphertext, verification_public_key) VALUES (?, 1, ?, ?, ?)")
      .bind(accountId, material.recoverySalt, material.record.capsule, material.recoveryVerificationPublicKeyBytes),
    env.DB.prepare("INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'vault-recovery', ?, ?, ?, 1)")
      .bind(accountId, rootId, "vault-root", hierarchy.rootDirectoryRecoveryEnvelope),
    env.DB.prepare("INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'device-enrollment', ?, ?, ?, 1)")
      .bind(accountId, oldDeviceId, oldDeviceId, oldEnrollment),
    env.DB.prepare("INSERT INTO account_profiles (account_id, ciphertext, revision, epoch, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)")
      .bind(accountId, Uint8Array.of(7), now, now),
  ]);
  const recovering = await seedNormalSession({ accountId, credentialIds: [credentialId] });
  const old = await seedNormalSession({ accountId, credentialIds: [credentialId] });
  await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(oldDeviceId, old.id).run();
  return { accountId, rootId, oldDeviceId, oldAssertion, hierarchy, material, recovering, old };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function startRecovery(f: Fixture) {
  const response = await post("/api/files-recovery/start", f.recovering.cookie);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<{
    enrollmentId: string; accountId: string; generation: number; registryEpoch: number;
    nonce: string; recoverySalt: string; capsule: string; verificationPublicKey: string;
  }>;
}

async function prepare(f: Fixture, start: Awaited<ReturnType<typeof startRecovery>>) {
  const opened = await openRecoveryCapsule({
    accountId: start.accountId, generation: start.generation,
    recoverySalt: decodeBytes(start.recoverySalt, 32), capsule: decodeBytes(start.capsule),
    recoveryVerificationPublicKey: decodeBytes(start.verificationPublicKey, 65),
  }, f.material.phrase, { accountId: start.accountId, generation: start.generation,
    recoverySalt: decodeBytes(start.recoverySalt, 32) });
  const next = await createRecoveryMaterial(f.accountId, {
    generation: start.generation + 1, vaultRootKey: opened.vaultRootKey,
  });
  const deviceId = uuidv7();
  const transport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const assertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const envelope = await sealDeviceEnrollmentEnvelope(opened.vaultRootKey, transport.publicKey, {
    purpose: "device-enrollment", vaultId: f.accountId, objectId: deviceId,
    keyId: deviceId, keyEpoch: 1, revision: 1, recipientId: deviceId,
  });
  const metadata = {
    generation: next.generation, recoverySalt: encodeBytes(next.recoverySalt),
    verificationPublicKey: encodeBytes(next.recoveryVerificationPublicKeyBytes),
    capsuleDigest: encodeBytes(await digestEnvelope(next.record.capsule)),
    enrollmentEnvelopeDigest: encodeBytes(await digestEnvelope(envelope)),
  };
  const intent: RecoveryIntent = {
    accountId: f.accountId, generation: start.generation, registryEpoch: start.registryEpoch,
    nonce: start.nonce, deviceId,
    transportPublicKey: encodeBytes(new Uint8Array(await crypto.subtle.exportKey("raw", transport.publicKey))),
    assertionPublicKey: encodeBytes(new Uint8Array(await crypto.subtle.exportKey("raw", assertion.publicKey))),
    nextMetadataDigest: await nextRecoveryMetadataDigest(metadata),
  };
  const message = recoveryIntentMessage(intent);
  const intentSignature = encodeBytes(new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, opened.recoveryEnrollmentKeyPair.privateKey,
    new Uint8Array(message))));
  return { opened, next, deviceId, transport, assertion, envelope, metadata, intent, intentSignature,
    intentDigest: await sha256(message) };
}

type Prepared = Awaited<ReturnType<typeof prepare>>;

async function challenge(f: Fixture, start: Awaited<ReturnType<typeof startRecovery>>, prepared: Prepared) {
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" },
    prepared.opened.recoveryVerificationPublicKey, decodeBytes(prepared.intentSignature, 64),
    new Uint8Array(recoveryIntentMessage(prepared.intent)))).toBe(true);
  const response = await post("/api/files-recovery/challenge", f.recovering.cookie, {
    enrollmentId: start.enrollmentId, intent: prepared.intent, intentSignature: prepared.intentSignature,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const { challenge: ciphertext } = await response.json() as { challenge: string };
  const secret = await openDeviceEnrollmentEnvelope(decodeBytes(ciphertext), prepared.transport, {
    purpose: "device-enrollment", vaultId: f.accountId,
    objectId: "recovery-transport-challenge", keyId: "recovery-transport-challenge",
    keyEpoch: start.generation, revision: 1, recipientId: prepared.deviceId,
  });
  return { secret, ciphertext };
}

async function commit(f: Fixture, start: Awaited<ReturnType<typeof startRecovery>>, p: Prepared, secret: Uint8Array,
  signingKey = p.assertion.privateKey) {
  const challengeSignature = encodeBytes(new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, signingKey,
    new Uint8Array(possessionMessage(p.intentDigest, secret)))));
  return post("/api/files-recovery/commit", f.recovering.cookie, {
    enrollmentId: start.enrollmentId, intent: p.intent, intentSignature: p.intentSignature,
    challengeSecret: encodeBytes(secret), challengeSignature, nextMetadata: p.metadata,
    nextCapsule: encodeBytes(p.next.record.capsule), enrollmentEnvelope: encodeBytes(p.envelope),
  });
}

async function oldPrivateRead(f: Fixture, registryEpoch = 1) {
  const url = "https://mdwn.test/api/private/bootstrap";
  const proof = await signDeviceProof(f.oldAssertion.privateKey, {
    sessionBinding: await sessionBindingDigest(f.old.id), deviceId: f.oldDeviceId,
    registryEpoch, method: "POST", url,
  });
  return SELF.fetch(url, { method: "POST", headers: {
    cookie: f.old.cookie, origin: "https://mdwn.test", "X-Mdwn-Device-Proof": JSON.stringify(proof),
  } });
}

describe("Vault recovery enrollment", () => {
  it("atomically replaces devices and Sessions, rotates the phrase, and preserves the owned root", async () => {
    const f = await fixture();
    expect((await oldPrivateRead(f)).status).toBe(200);
    const start = await startRecovery(f);
    const p = await prepare(f, start);
    const { secret } = await challenge(f, start, p);
    const response = await commit(f, start, p, secret);
    expect(response.status).toBe(200);
    const { registryEpoch } = await response.json() as { registryEpoch: number };
    expect(registryEpoch).toBeGreaterThan(1);
    expect((await oldPrivateRead(f, registryEpoch)).status).toBe(403);
    const oldSession = await env.DB.prepare("SELECT revoked_at FROM sessions WHERE id = ?").bind(f.old.id).first<{ revoked_at: number | null }>();
    const recoveringSession = await env.DB.prepare("SELECT revoked_at FROM sessions WHERE id = ?").bind(f.recovering.id).first<{ revoked_at: number | null }>();
    expect(oldSession?.revoked_at).not.toBeNull();
    expect(recoveringSession?.revoked_at).not.toBeNull();
    const oldDevice = await env.DB.prepare("SELECT state, revocation_reason FROM encryption_devices WHERE id = ?")
      .bind(f.oldDeviceId).first();
    expect(oldDevice).toEqual({ state: "tombstoned", revocation_reason: "recovery" });
    const oldEnvelope = await env.DB.prepare("SELECT superseded_at FROM key_envelopes WHERE recipient_id = ? AND purpose = 'device-enrollment'")
      .bind(f.oldDeviceId).first<{ superseded_at: number | null }>();
    expect(oldEnvelope?.superseded_at).not.toBeNull();
    const capsule = await env.DB.prepare("SELECT generation FROM recovery_capsules WHERE account_id = ?")
      .bind(f.accountId).first();
    expect(capsule).toEqual({ generation: 2 });
    const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
    const url = "https://mdwn.test/api/private/bootstrap";
    const newSessionId = (await env.DB.prepare("SELECT id FROM sessions WHERE account_id = ? AND device_id = ? AND revoked_at IS NULL")
      .bind(f.accountId, p.deviceId).first<{ id: string }>())!.id;
    const proof = await signDeviceProof(p.assertion.privateKey, {
      sessionBinding: await sessionBindingDigest(newSessionId),
      deviceId: p.deviceId, registryEpoch, method: "POST", url,
    });
    const privateResponse = await SELF.fetch(url, { method: "POST", headers: {
      cookie, origin: "https://mdwn.test", "X-Mdwn-Device-Proof": JSON.stringify(proof),
    } });
    expect(privateResponse.status).toBe(200);
    const bootstrap = await privateResponse.json() as { rootDirectoryId: string; rootRecoveryEnvelope: string; enrollmentEnvelope: string };
    expect(await openVaultRecoveryEnvelope(decodeBytes(bootstrap.rootRecoveryEnvelope), p.opened.vaultRootKey,
      { purpose: "vault-recovery", vaultId: f.accountId, objectId: f.rootId,
        keyId: f.rootId, keyEpoch: 1, revision: 1 })).toEqual(f.hierarchy.rootDirectoryCapabilityKey);
    expect(await openDeviceEnrollmentEnvelope(decodeBytes(bootstrap.enrollmentEnvelope), p.transport,
      { purpose: "device-enrollment", vaultId: f.accountId, objectId: p.deviceId,
        keyId: p.deviceId, keyEpoch: 1, revision: 1, recipientId: p.deviceId })).toEqual(p.opened.vaultRootKey);
    const recoveredRequest = async (path: string, method: "POST" | "PATCH", body?: string) => {
      const url = `https://mdwn.test${path}`;
      const proof = await signDeviceProof(p.assertion.privateKey, {
        sessionBinding: await sessionBindingDigest(newSessionId), deviceId: p.deviceId,
        registryEpoch, method, url, body,
      });
      return SELF.fetch(url, { method, headers: { cookie, origin: "https://mdwn.test",
        "X-Mdwn-Device-Proof": JSON.stringify(proof),
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body }) });
    };
    // Simulate interruption after commit: the job is still pending and resumes with only the new device.
    expect(await env.DB.prepare("SELECT state, cursor FROM crypto_jobs WHERE device_id = ?")
      .bind(p.deviceId).first()).toEqual({ state: "pending", cursor: null });
    const nextResponse = await recoveredRequest("/api/private/recovery-provision/next", "POST");
    expect(nextResponse.status).toBe(200);
    const next = await nextResponse.json() as { cursor: string | null; item: { objectId: string; envelope: string; keyEpoch: number } };
    expect(next.item.objectId).toBe(f.rootId);
    const ownedKey = await openVaultRecoveryEnvelope(decodeBytes(next.item.envelope), p.opened.vaultRootKey,
      { purpose: "vault-recovery", vaultId: f.accountId, objectId: f.rootId,
        keyId: f.rootId, keyEpoch: 1, revision: 1 });
    const ownedContext = { purpose: "owned-device" as const, vaultId: f.accountId,
      objectId: f.rootId, keyId: f.rootId, keyEpoch: 1, revision: 1, recipientId: p.deviceId };
    const wrapped = await sealOwnedDeviceEnvelope({ key: ownedKey, objectId: f.rootId,
      keyId: f.rootId, scope: "owned" }, p.transport.publicKey, ownedContext);
    const stepBody = JSON.stringify({ operation: "step", cursor: next.cursor,
      objectId: f.rootId, envelope: encodeBytes(wrapped) });
    expect((await recoveredRequest("/api/private/recovery-provision/step", "PATCH", stepBody)).status).toBe(200);
    expect(await openOwnedDeviceEnvelope(wrapped, p.transport, ownedContext)).toEqual(ownedKey);
    expect((await recoveredRequest("/api/private/recovery-provision/step", "PATCH", stepBody)).status).toBe(200);
    const finishBody = JSON.stringify({ operation: "finish" });
    expect((await recoveredRequest("/api/private/recovery-provision/step", "PATCH", finishBody)).status).toBe(200);
    expect(await env.DB.prepare("SELECT state, cursor FROM crypto_jobs WHERE device_id = ?")
      .bind(p.deviceId).first()).toEqual({ state: "complete", cursor: f.rootId });
    expect((await recoveredRequest("/api/private/recovery-provision/next", "POST")).status).toBe(200);
    expect((await commit(f, start, p, secret)).status).not.toBe(200);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE account_id = ? AND state = 'active'")
      .bind(f.accountId).first<{ n: number }>())?.n).toBe(1);
  });

  it("keeps a started or challenged ceremony invisible until commit and rejects substituted keys", async () => {
    const f = await fixture();
    const start = await startRecovery(f);
    const p = await prepare(f, start);
    const substituted = { ...p.intent, transportPublicKey: encodeBytes(new Uint8Array(65).fill(1)) };
    const invalid = await post("/api/files-recovery/challenge", f.recovering.cookie, {
      enrollmentId: start.enrollmentId, intent: substituted, intentSignature: p.intentSignature,
    });
    expect(invalid.status).not.toBe(200);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE account_id = ?")
      .bind(f.accountId).first<{ n: number }>())?.n).toBe(1);
    expect((await oldPrivateRead(f)).status).toBe(200);
    const retry = await startRecovery(f);
    const prepared = await prepare(f, retry);
    const { secret, ciphertext } = await challenge(f, retry, prepared);
    const wrongTransport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    await expect(openDeviceEnrollmentEnvelope(decodeBytes(ciphertext), wrongTransport, {
      purpose: "device-enrollment", vaultId: f.accountId,
      objectId: "recovery-transport-challenge", keyId: "recovery-transport-challenge",
      keyEpoch: retry.generation, revision: 1, recipientId: prepared.deviceId,
    })).rejects.toThrow();
    expect(secret.length).toBe(32);
    const wrongSigning = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    expect((await commit(f, retry, prepared, secret, wrongSigning.privateKey)).status).not.toBe(200);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE account_id = ?")
      .bind(f.accountId).first<{ n: number }>())?.n).toBe(1);
    expect((await oldPrivateRead(f)).status).toBe(200);
    const lastStart = await startRecovery(f);
    const lastPrepared = await prepare(f, lastStart);
    const lastChallenge = await challenge(f, lastStart, lastPrepared);
    const wrongSecret = crypto.getRandomValues(new Uint8Array(32));
    expect((await commit(f, lastStart, lastPrepared, wrongSecret)).status).not.toBe(200);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE account_id = ? AND state = 'active'")
      .bind(f.accountId).first<{ n: number }>())?.n).toBe(1);
    expect(lastChallenge.secret).toHaveLength(32);
  });

  it("rejects stale Sessions, missing fresh assertions, and a superseded generation", async () => {
    const f = await fixture();
    await env.DB.prepare("UPDATE sessions SET fresh_asserted_at = NULL WHERE id = ?").bind(f.recovering.id).run();
    expect((await post("/api/files-recovery/start", f.recovering.cookie)).status).not.toBe(200);
    await env.DB.prepare("UPDATE sessions SET fresh_asserted_at = ? WHERE id = ?")
      .bind(Date.now(), f.recovering.id).run();
    const start = await startRecovery(f);
    const p = await prepare(f, start);
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").bind(Date.now(), f.recovering.id).run();
    expect((await post("/api/files-recovery/challenge", f.recovering.cookie, {
      enrollmentId: start.enrollmentId, intent: p.intent, intentSignature: p.intentSignature,
    })).status).not.toBe(200);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE account_id = ?")
      .bind(f.accountId).first<{ n: number }>())?.n).toBe(1);
    const newer = await fixture();
    const newerStart = await startRecovery(newer);
    const newerPrepared = await prepare(newer, newerStart);
    const replacementCapsule = await createRecoveryMaterial(newer.accountId, {
      generation: 2, vaultRootKey: newer.hierarchy.vaultRootKey,
    });
    await env.DB.prepare("UPDATE recovery_capsules SET generation = 2, recovery_salt = ?, ciphertext = ?, verification_public_key = ? WHERE account_id = ?")
      .bind(replacementCapsule.recoverySalt, replacementCapsule.record.capsule,
        replacementCapsule.recoveryVerificationPublicKeyBytes, newer.accountId).run();
    expect((await post("/api/files-recovery/challenge", newer.recovering.cookie, {
      enrollmentId: newerStart.enrollmentId, intent: newerPrepared.intent,
      intentSignature: newerPrepared.intentSignature,
    })).status).not.toBe(200);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE account_id = ?")
      .bind(newer.accountId).first<{ n: number }>())?.n).toBe(1);
  });

  it("binds the nonce even when the old recovery key signs an altered intent", async () => {
    const f = await fixture();
    const start = await startRecovery(f);
    const p = await prepare(f, start);
    const altered = { ...p.intent, nonce: encodeBytes(crypto.getRandomValues(new Uint8Array(32))) };
    const signature = encodeBytes(new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, p.opened.recoveryEnrollmentKeyPair.privateKey,
      new Uint8Array(recoveryIntentMessage(altered)))));
    expect((await post("/api/files-recovery/challenge", f.recovering.cookie, {
      enrollmentId: start.enrollmentId, intent: altered, intentSignature: signature,
    })).status).not.toBe(200);
    expect((await post("/api/files-recovery/challenge", f.recovering.cookie, {
      enrollmentId: start.enrollmentId, intent: p.intent, intentSignature: p.intentSignature,
    })).status).not.toBe(200);
    expect((await oldPrivateRead(f)).status).toBe(200);
  });

  it("limits new starts and keeps a failed ceremony from adding a device", async () => {
    const f = await fixture();
    for (let index = 0; index < 3; index++) expect((await post("/api/files-recovery/start", f.recovering.cookie)).status).toBe(200);
    expect((await post("/api/files-recovery/start", f.recovering.cookie)).status).toBe(429);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE account_id = ?")
      .bind(f.accountId).first<{ n: number }>())?.n).toBe(1);
  });
});

describe("ticket 20 needs recorded by Vault recovery", () => {
  it("records a need for the replacement device at the final epoch, not the tombstoned one", async () => {
    const f = await fixture();
    const ownerId = uuidv7(), ownerRootId = uuidv7(), ownerDeviceId = uuidv7(), now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .bind(ownerId, uuidv7(), now, now),
      env.DB.prepare("INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)")
        .bind(ownerId, ownerRootId),
      env.DB.prepare(`INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key,
        state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, X'02', X'02', 'active', 'signup', 1, ?)`)
        .bind(ownerDeviceId, ownerId, now),
    ]);
    const grantId = uuidv7();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO grants (id, owner_id, recipient_id, target_node_id, target_kind, permission,
        generation, created_at, updated_at) VALUES (?, ?, ?, ?, 'directory', 'read_only', 1, ?, ?)`)
        .bind(grantId, ownerId, f.accountId, ownerRootId, now, now),
      env.DB.prepare(`INSERT INTO grant_labels (grant_id, label_id, owner_copy, offer_bytes, offer_digest,
        offer_signature, signer_device_id) VALUES (?, ?, X'01', X'01', zeroblob(32), zeroblob(64), ?)`)
        .bind(grantId, uuidv7(), ownerDeviceId),
    ]);
    const start = await startRecovery(f);
    const prepared = await prepare(f, start);
    const { secret } = await challenge(f, start, prepared);
    expect((await commit(f, start, prepared, secret)).status).toBe(200);
    const epoch = (await env.DB.prepare("SELECT registry_epoch FROM account_encryption_identities WHERE account_id = ?")
      .bind(f.accountId).first<{ registry_epoch: number }>())!.registry_epoch;
    // Recovery advanced the epoch twice; the reconcile ran last and stamped the final value.
    expect(epoch).toBe(3);
    expect((await env.DB.prepare("SELECT device_id, registry_epoch FROM provisioning_needs WHERE grant_id = ?")
      .bind(grantId).all()).results).toEqual([{ device_id: prepared.deviceId, registry_epoch: epoch }]);
  });
});

describe("ticket 20 recovered device material isolation", () => {
  it("gives the replacement device shared access only through its Grant envelopes, never the Vault root", async () => {
    const f = await fixture();
    const owner = await actor();
    const vaultRoot = crypto.getRandomValues(new Uint8Array(32));
    const root = await state(owner, owner.accountId, owner.rootId, owner.rootKey);
    const folder = await directory(owner, owner.accountId, root, "Recovered");
    // The old device accepts a real Directory Grant before recovery.
    const recipient = { accountId: f.accountId, deviceId: f.oldDeviceId, session: f.old,
      assertion: f.oldAssertion } as unknown as Actor;
    const share = await shareDirectory(owner, recipient, folder.nodeId, folder.key, "read_write", vaultRoot);
    // Real Vault recovery replaces every device; the replacement has no current material.
    const start = await startRecovery(f);
    const prepared = await prepare(f, start);
    const { secret } = await challenge(f, start, prepared);
    const committed = await commit(f, start, prepared, secret);
    expect(committed.status, await committed.clone().text()).toBe(200);
    const epoch = (await env.DB.prepare("SELECT registry_epoch FROM account_encryption_identities WHERE account_id = ?")
      .bind(f.accountId).first<{ registry_epoch: number }>())!.registry_epoch;
    expect(epoch).toBe(3);
    const newSessionId = (await env.DB.prepare("SELECT id FROM sessions WHERE account_id = ? AND device_id = ? AND revoked_at IS NULL")
      .bind(f.accountId, prepared.deviceId).first<{ id: string }>())!.id;
    const cookie = committed.headers.get("set-cookie")!.split(";", 1)[0]!;
    const recoveredRequest = async (path: string, method: "POST" | "PATCH", value?: object) => {
      const body = value === undefined ? undefined : JSON.stringify(value);
      const url = `https://mdwn.test${path}`;
      const proof = await signDeviceProof(prepared.assertion.privateKey, {
        sessionBinding: await sessionBindingDigest(newSessionId), deviceId: prepared.deviceId,
        registryEpoch: epoch, method, url, body });
      return SELF.fetch(url, { method, headers: { cookie, origin: "https://mdwn.test",
        "X-Mdwn-Device-Proof": JSON.stringify(proof),
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body }) });
    };
    // Before fulfillment the replacement device has nothing and reports provisioning.
    const cold = await recoveredRequest("/api/private/sharing/roots", "POST");
    expect(cold.status, await cold.clone().text()).toBe(200);
    expect((await cold.json() as { roots: { status: string }[] }).roots[0]!.status).toBe("provisioning");
    // The Owner runs one real fulfillment step for the replacement device.
    expect((await call(owner, "/api/private/provisioning", "POST")).status).toBe(200);
    const next = await call(owner, `/api/private/provisioning/${folder.nodeId}/next`, "POST");
    expect(next.status, await next.clone().text()).toBe(200);
    const step = await next.json() as Extract<FulfillStep, { step: "grants" }>;
    expect(step.grants[0]!.devices.map((device) => device.deviceId)).toEqual([prepared.deviceId]);
    const grants = await prepareFulfillGrants({ accountId: owner.accountId, deviceId: owner.deviceId,
      assertionKey: owner.assertion.privateKey, vaultRoot }, step,
      (device) => importDeviceKey(device.publicKey).then((key) => sealToRecipient(folder.key, key,
        { purpose: "grant", vaultId: owner.accountId, objectId: folder.nodeId, keyId: folder.nodeId,
          keyEpoch: 1, revision: 1, recipientId: device.deviceId })));
    const done = await call(owner, `/api/private/provisioning/${folder.nodeId}/grants`, "PATCH",
      { epoch: step.epoch, grants });
    expect(done.status, await done.clone().text()).toBe(200);
    // Its access now comes only from the Grant envelopes.
    const roots = await recoveredRequest("/api/private/sharing/roots", "POST");
    const entry = (await roots.json() as { roots: { targetId: string; status: string;
      capability?: { ciphertext: string } }[] }).roots[0]!;
    expect(entry).toMatchObject({ targetId: folder.nodeId, status: "ready" });
    const capability = await env.DB.prepare(`SELECT ciphertext FROM grant_device_envelopes
      WHERE grant_id = ? AND device_id = ?`).bind(share.grantId, prepared.deviceId)
      .first<{ ciphertext: ArrayBuffer }>();
    const label = await env.DB.prepare(`SELECT ciphertext FROM grant_label_deliveries
      WHERE grant_id = ? AND device_id = ?`).bind(share.grantId, prepared.deviceId)
      .first<{ ciphertext: ArrayBuffer }>();
    expect(capability).not.toBeNull();
    expect(label).not.toBeNull();
    const context = { purpose: "grant" as const, vaultId: owner.accountId, objectId: folder.nodeId,
      keyId: folder.nodeId, keyEpoch: 1, revision: 1, recipientId: prepared.deviceId };
    expect(await openForRecipient(decodeTreeBytes(entry.capability!.ciphertext, 16_384), prepared.transport,
      { context })).toEqual(folder.key);
    // The Vault-root key cannot open the Grant capability, and the Grant ciphertexts are absent
    // from every Vault-root key envelope row for the recovering Account.
    await expect(openSymmetric(new Uint8Array(capability!.ciphertext), prepared.opened.vaultRootKey,
      { context })).rejects.toThrow();
    const enrollment = await env.DB.prepare(`SELECT ciphertext FROM key_envelopes
      WHERE account_id = ? AND recipient_id = ? AND purpose = 'device-enrollment'`)
      .bind(f.accountId, prepared.deviceId).first<{ ciphertext: ArrayBuffer }>();
    const vaultRootOpened = await openDeviceEnrollmentEnvelope(new Uint8Array(enrollment!.ciphertext),
      prepared.transport, { purpose: "device-enrollment", vaultId: f.accountId, objectId: prepared.deviceId,
        keyId: prepared.deviceId, keyEpoch: 1, revision: 1, recipientId: prepared.deviceId });
    expect(vaultRootOpened).toEqual(prepared.opened.vaultRootKey);
    expect(vaultRootOpened).not.toEqual(folder.key);
    const envelopes = (await env.DB.prepare("SELECT ciphertext FROM key_envelopes WHERE account_id = ?")
      .bind(f.accountId).all()).results as { ciphertext: ArrayBuffer }[];
    const stored = envelopes.map((row) => hex(new Uint8Array(row.ciphertext)));
    expect(stored).not.toContain(hex(new Uint8Array(capability!.ciphertext)));
    expect(stored).not.toContain(hex(new Uint8Array(label!.ciphertext)));
  });
});
