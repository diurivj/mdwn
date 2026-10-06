import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { digestEnvelope } from "../../app/shared/crypto/enc-v1";
import {
  createRecoveryMaterial,
  createVaultKeyHierarchy,
  openDeviceEnrollmentEnvelope,
  openOwnedDeviceEnvelope,
  openRecoveryCapsule,
  openVaultRecoveryEnvelope,
  sealDeviceEnrollmentEnvelope,
  sealOwnedDeviceEnvelope,
} from "../../app/shared/crypto/vault";
import { signDeviceProof, sessionBindingDigest } from "../../app/shared/device/proof";
import {
  nextRecoveryMetadataDigest,
  possessionMessage,
  recoveryIntentMessage,
  sha256,
  type RecoveryIntent,
} from "../../app/recovery/protocol";
import { decodeBytes, encodeBytes } from "../../app/shared/signup/protocol";
import { seedNormalSession } from "./auth-fixtures";
import { seedRecipientEnvelopeDependents } from "./grant-envelope-lifecycle-fixtures";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      SESSION_COOKIE_SECRET: string;
      ABUSE_HMAC_SECRET: string;
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

function uuidv7(): string {
  const id = crypto.randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}

const networks = new Map<string, string>();
const post = (path: string, cookie: string, body: object = {}) =>
  SELF.fetch(`https://mdwn.test${path}`, {
    method: "POST",
    headers: {
      cookie,
      origin: "https://mdwn.test",
      "content-type": "application/json",
      "CF-Connecting-IP":
        networks.get(cookie) ??
        (() => {
          const ip = `198.51.100.${networks.size + 1}`;
          networks.set(cookie, ip);
          return ip;
        })(),
    },
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
  const oldAssertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  const oldEnrollment = await sealDeviceEnrollmentEnvelope(hierarchy.vaultRootKey, oldTransport.publicKey, {
    purpose: "device-enrollment",
    vaultId: accountId,
    objectId: oldDeviceId,
    keyId: oldDeviceId,
    keyEpoch: 1,
    revision: 1,
    recipientId: oldDeviceId,
  });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(
      accountId,
      crypto.randomUUID(),
      now,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO passkeys (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at) VALUES (?, ?, ?, 0, '[]', 'singleDevice', 0, ?, ?)",
    ).bind(credentialId, accountId, Uint8Array.of(1), now, now),
    env.DB.prepare(
      "INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)",
    ).bind(accountId, rootId),
    env.DB.prepare(
      "INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, ?, ?, 'active', 'signup', 1, ?)",
    ).bind(
      oldDeviceId,
      accountId,
      new Uint8Array(await crypto.subtle.exportKey("raw", oldTransport.publicKey)),
      new Uint8Array(await crypto.subtle.exportKey("raw", oldAssertion.publicKey)),
      now,
    ),
    env.DB.prepare(
      "INSERT INTO recovery_capsules (account_id, generation, recovery_salt, ciphertext, verification_public_key) VALUES (?, 1, ?, ?, ?)",
    ).bind(accountId, material.recoverySalt, material.record.capsule, material.recoveryVerificationPublicKeyBytes),
    env.DB.prepare(
      "INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'vault-recovery', ?, ?, ?, 1)",
    ).bind(accountId, rootId, "vault-root", hierarchy.rootDirectoryRecoveryEnvelope),
    env.DB.prepare(
      "INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'device-enrollment', ?, ?, ?, 1)",
    ).bind(accountId, oldDeviceId, oldDeviceId, oldEnrollment),
    env.DB.prepare(
      "INSERT INTO account_profiles (account_id, ciphertext, revision, epoch, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)",
    ).bind(accountId, Uint8Array.of(7), now, now),
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
    enrollmentId: string;
    accountId: string;
    generation: number;
    registryEpoch: number;
    nonce: string;
    recoverySalt: string;
    capsule: string;
    verificationPublicKey: string;
  }>;
}

async function prepare(f: Fixture, start: Awaited<ReturnType<typeof startRecovery>>) {
  const opened = await openRecoveryCapsule(
    {
      accountId: start.accountId,
      generation: start.generation,
      recoverySalt: decodeBytes(start.recoverySalt, 32),
      capsule: decodeBytes(start.capsule),
      recoveryVerificationPublicKey: decodeBytes(start.verificationPublicKey, 65),
    },
    f.material.phrase,
    { accountId: start.accountId, generation: start.generation, recoverySalt: decodeBytes(start.recoverySalt, 32) },
  );
  const next = await createRecoveryMaterial(f.accountId, {
    generation: start.generation + 1,
    vaultRootKey: opened.vaultRootKey,
  });
  const deviceId = uuidv7();
  const transport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const assertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const envelope = await sealDeviceEnrollmentEnvelope(opened.vaultRootKey, transport.publicKey, {
    purpose: "device-enrollment",
    vaultId: f.accountId,
    objectId: deviceId,
    keyId: deviceId,
    keyEpoch: 1,
    revision: 1,
    recipientId: deviceId,
  });
  const metadata = {
    generation: next.generation,
    recoverySalt: encodeBytes(next.recoverySalt),
    verificationPublicKey: encodeBytes(next.recoveryVerificationPublicKeyBytes),
    capsuleDigest: encodeBytes(await digestEnvelope(next.record.capsule)),
    enrollmentEnvelopeDigest: encodeBytes(await digestEnvelope(envelope)),
  };
  const intent: RecoveryIntent = {
    accountId: f.accountId,
    generation: start.generation,
    registryEpoch: start.registryEpoch,
    nonce: start.nonce,
    deviceId,
    transportPublicKey: encodeBytes(new Uint8Array(await crypto.subtle.exportKey("raw", transport.publicKey))),
    assertionPublicKey: encodeBytes(new Uint8Array(await crypto.subtle.exportKey("raw", assertion.publicKey))),
    nextMetadataDigest: await nextRecoveryMetadataDigest(metadata),
  };
  const message = recoveryIntentMessage(intent);
  const intentSignature = encodeBytes(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        opened.recoveryEnrollmentKeyPair.privateKey,
        new Uint8Array(message),
      ),
    ),
  );
  return {
    opened,
    next,
    deviceId,
    transport,
    assertion,
    envelope,
    metadata,
    intent,
    intentSignature,
    intentDigest: await sha256(message),
  };
}

type Prepared = Awaited<ReturnType<typeof prepare>>;

async function challenge(f: Fixture, start: Awaited<ReturnType<typeof startRecovery>>, prepared: Prepared) {
  expect(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      prepared.opened.recoveryVerificationPublicKey,
      decodeBytes(prepared.intentSignature, 64),
      new Uint8Array(recoveryIntentMessage(prepared.intent)),
    ),
  ).toBe(true);
  const response = await post("/api/files-recovery/challenge", f.recovering.cookie, {
    enrollmentId: start.enrollmentId,
    intent: prepared.intent,
    intentSignature: prepared.intentSignature,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const { challenge: ciphertext } = (await response.json()) as { challenge: string };
  const secret = await openDeviceEnrollmentEnvelope(decodeBytes(ciphertext), prepared.transport, {
    purpose: "device-enrollment",
    vaultId: f.accountId,
    objectId: "recovery-transport-challenge",
    keyId: "recovery-transport-challenge",
    keyEpoch: start.generation,
    revision: 1,
    recipientId: prepared.deviceId,
  });
  return { secret, ciphertext };
}

async function commit(
  f: Fixture,
  start: Awaited<ReturnType<typeof startRecovery>>,
  p: Prepared,
  secret: Uint8Array,
  signingKey = p.assertion.privateKey,
) {
  const challengeSignature = encodeBytes(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        signingKey,
        new Uint8Array(possessionMessage(p.intentDigest, secret)),
      ),
    ),
  );
  return post("/api/files-recovery/commit", f.recovering.cookie, {
    enrollmentId: start.enrollmentId,
    intent: p.intent,
    intentSignature: p.intentSignature,
    challengeSecret: encodeBytes(secret),
    challengeSignature,
    nextMetadata: p.metadata,
    nextCapsule: encodeBytes(p.next.record.capsule),
    enrollmentEnvelope: encodeBytes(p.envelope),
  });
}

async function oldPrivateRead(f: Fixture, registryEpoch = 1) {
  const url = "https://mdwn.test/api/private/bootstrap";
  const proof = await signDeviceProof(f.oldAssertion.privateKey, {
    sessionBinding: await sessionBindingDigest(f.old.id),
    deviceId: f.oldDeviceId,
    registryEpoch,
    method: "POST",
    url,
  });
  return SELF.fetch(url, {
    method: "POST",
    headers: {
      cookie: f.old.cookie,
      origin: "https://mdwn.test",
      "X-Mdwn-Device-Proof": JSON.stringify(proof),
    },
  });
}

describe("Vault recovery enrollment", () => {
  it("atomically replaces devices and Sessions, rotates the phrase, and preserves the owned root", async () => {
    const f = await fixture();
    const shared = await seedRecipientEnvelopeDependents(f.accountId, [f.oldDeviceId]);
    expect((await oldPrivateRead(f)).status).toBe(200);
    const start = await startRecovery(f);
    const p = await prepare(f, start);
    const { secret } = await challenge(f, start, p);
    const response = await commit(f, start, p, secret);
    expect(response.status).toBe(200);
    const { registryEpoch } = (await response.json()) as { registryEpoch: number };
    expect(registryEpoch).toBeGreaterThan(1);
    expect((await oldPrivateRead(f, registryEpoch)).status).toBe(403);
    const oldSession = await env.DB.prepare("SELECT revoked_at FROM sessions WHERE id = ?")
      .bind(f.old.id)
      .first<{ revoked_at: number | null }>();
    const recoveringSession = await env.DB.prepare("SELECT revoked_at FROM sessions WHERE id = ?")
      .bind(f.recovering.id)
      .first<{ revoked_at: number | null }>();
    expect(oldSession?.revoked_at).not.toBeNull();
    expect(recoveringSession?.revoked_at).not.toBeNull();
    const oldDevice = await env.DB.prepare("SELECT state, revocation_reason FROM encryption_devices WHERE id = ?")
      .bind(f.oldDeviceId)
      .first();
    expect(oldDevice).toEqual({ state: "tombstoned", revocation_reason: "recovery" });
    const oldEnvelope = await env.DB.prepare(
      "SELECT superseded_at FROM key_envelopes WHERE recipient_id = ? AND purpose = 'device-enrollment'",
    )
      .bind(f.oldDeviceId)
      .first<{ superseded_at: number | null }>();
    expect(oldEnvelope?.superseded_at).not.toBeNull();
    const capsule = await env.DB.prepare("SELECT generation FROM recovery_capsules WHERE account_id = ?")
      .bind(f.accountId)
      .first();
    expect(capsule).toEqual({ generation: 2 });
    const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
    const url = "https://mdwn.test/api/private/bootstrap";
    const newSessionId = (await env.DB.prepare(
      "SELECT id FROM sessions WHERE account_id = ? AND device_id = ? AND revoked_at IS NULL",
    )
      .bind(f.accountId, p.deviceId)
      .first<{ id: string }>())!.id;
    const proof = await signDeviceProof(p.assertion.privateKey, {
      sessionBinding: await sessionBindingDigest(newSessionId),
      deviceId: p.deviceId,
      registryEpoch,
      method: "POST",
      url,
    });
    const privateResponse = await SELF.fetch(url, {
      method: "POST",
      headers: {
        cookie,
        origin: "https://mdwn.test",
        "X-Mdwn-Device-Proof": JSON.stringify(proof),
      },
    });
    expect(privateResponse.status).toBe(200);
    const bootstrap = (await privateResponse.json()) as {
      rootDirectoryId: string;
      rootRecoveryEnvelope: string;
      enrollmentEnvelope: string;
    };
    expect(
      await openVaultRecoveryEnvelope(decodeBytes(bootstrap.rootRecoveryEnvelope), p.opened.vaultRootKey, {
        purpose: "vault-recovery",
        vaultId: f.accountId,
        objectId: f.rootId,
        keyId: f.rootId,
        keyEpoch: 1,
        revision: 1,
      }),
    ).toEqual(f.hierarchy.rootDirectoryCapabilityKey);
    expect(
      await openDeviceEnrollmentEnvelope(decodeBytes(bootstrap.enrollmentEnvelope), p.transport, {
        purpose: "device-enrollment",
        vaultId: f.accountId,
        objectId: p.deviceId,
        keyId: p.deviceId,
        keyEpoch: 1,
        revision: 1,
        recipientId: p.deviceId,
      }),
    ).toEqual(p.opened.vaultRootKey);
    const recoveredRequest = async (path: string, method: "POST" | "PATCH", body?: string) => {
      const url = `https://mdwn.test${path}`;
      const proof = await signDeviceProof(p.assertion.privateKey, {
        sessionBinding: await sessionBindingDigest(newSessionId),
        deviceId: p.deviceId,
        registryEpoch,
        method,
        url,
        body,
      });
      return SELF.fetch(url, {
        method,
        headers: {
          cookie,
          origin: "https://mdwn.test",
          "X-Mdwn-Device-Proof": JSON.stringify(proof),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
      });
    };
    for (const relationship of shared) {
      const table = relationship.kind === "shares" ? "share_key_envelopes" : "grant_key_envelopes";
      expect(
        (await env.DB.prepare(`SELECT device_id FROM ${table} WHERE relationship_id = ?`).bind(relationship.id).all())
          .results,
      ).toEqual([]);
      expect(
        await env.DB.prepare(`SELECT recipient_id FROM ${relationship.kind} WHERE id = ?`)
          .bind(relationship.id)
          .first(),
      ).toEqual({ recipient_id: f.accountId });
      const comments = relationship.kind === "shares" ? "share_comment_key_envelopes" : "grant_comment_key_envelopes";
      expect(
        await env.DB.prepare(`SELECT count(*) AS n FROM ${comments} WHERE relationship_id = ?`)
          .bind(relationship.id)
          .first(),
      ).toEqual({ n: 0 });
      if (relationship.kind === "grants") {
        expect(await (await recoveredRequest(`/api/private/grants/${relationship.id}/needs`, "POST")).json()).toEqual({
          needs: [{ grantId: relationship.id, deviceId: p.deviceId, grantKeyEpoch: 1 }],
          nextCursor: null,
        });
        for (const objectId of relationship.commentObjectIds) {
          const comment = await recoveredRequest(
            `/api/private/grants/${relationship.id}/comment-keys/${objectId}`,
            "POST",
          );
          expect(comment.status).toBe(409);
          expect(await comment.json()).toEqual({ error: "secure_access_preparing" });
        }
        const missing = await recoveredRequest(`/api/private/grants/${relationship.id}/keys`, "POST");
        expect(missing.status).toBe(409);
        expect(await missing.json()).toEqual({ error: "shared_content_provisioning_required" });
      }
    }
    expect(
      await env.DB.prepare(`SELECT count(*) AS n FROM provisioning_needs WHERE device_id IN
      (SELECT id FROM encryption_devices WHERE account_id = ? AND id != ?)`)
        .bind(f.accountId, p.deviceId)
        .first(),
    ).toEqual({ n: 0 });
    // Simulate interruption after commit: the job is still pending and resumes with only the new device.
    expect(
      await env.DB.prepare("SELECT state, cursor FROM crypto_jobs WHERE device_id = ?").bind(p.deviceId).first(),
    ).toEqual({ state: "pending", cursor: null });
    const nextResponse = await recoveredRequest("/api/private/recovery-provision/next", "POST");
    expect(nextResponse.status).toBe(200);
    const next = (await nextResponse.json()) as {
      cursor: string | null;
      item: { objectId: string; envelope: string; keyEpoch: number };
    };
    expect(next.item.objectId).toBe(f.rootId);
    const ownedKey = await openVaultRecoveryEnvelope(decodeBytes(next.item.envelope), p.opened.vaultRootKey, {
      purpose: "vault-recovery",
      vaultId: f.accountId,
      objectId: f.rootId,
      keyId: f.rootId,
      keyEpoch: 1,
      revision: 1,
    });
    const ownedContext = {
      purpose: "owned-device" as const,
      vaultId: f.accountId,
      objectId: f.rootId,
      keyId: f.rootId,
      keyEpoch: 1,
      revision: 1,
      recipientId: p.deviceId,
    };
    const wrapped = await sealOwnedDeviceEnvelope(
      { key: ownedKey, objectId: f.rootId, keyId: f.rootId, scope: "owned" },
      p.transport.publicKey,
      ownedContext,
    );
    const stepBody = JSON.stringify({
      operation: "step",
      cursor: next.cursor,
      objectId: f.rootId,
      envelope: encodeBytes(wrapped),
    });
    expect((await recoveredRequest("/api/private/recovery-provision/step", "PATCH", stepBody)).status).toBe(200);
    expect(await openOwnedDeviceEnvelope(wrapped, p.transport, ownedContext)).toEqual(ownedKey);
    expect((await recoveredRequest("/api/private/recovery-provision/step", "PATCH", stepBody)).status).toBe(200);
    const finishBody = JSON.stringify({ operation: "finish" });
    expect((await recoveredRequest("/api/private/recovery-provision/step", "PATCH", finishBody)).status).toBe(200);
    expect(
      await env.DB.prepare("SELECT state, cursor FROM crypto_jobs WHERE device_id = ?").bind(p.deviceId).first(),
    ).toEqual({ state: "complete", cursor: f.rootId });
    expect((await recoveredRequest("/api/private/recovery-provision/next", "POST")).status).toBe(200);
    expect((await commit(f, start, p, secret)).status).not.toBe(200);
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE account_id = ? AND state = 'active'")
          .bind(f.accountId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });

  it("keeps a started or challenged ceremony invisible until commit and rejects substituted keys", async () => {
    const f = await fixture();
    const start = await startRecovery(f);
    const p = await prepare(f, start);
    const substituted = { ...p.intent, transportPublicKey: encodeBytes(new Uint8Array(65).fill(1)) };
    const invalid = await post("/api/files-recovery/challenge", f.recovering.cookie, {
      enrollmentId: start.enrollmentId,
      intent: substituted,
      intentSignature: p.intentSignature,
    });
    expect(invalid.status).not.toBe(200);
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE account_id = ?")
          .bind(f.accountId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect((await oldPrivateRead(f)).status).toBe(200);
    const retry = await startRecovery(f);
    const prepared = await prepare(f, retry);
    const { secret, ciphertext } = await challenge(f, retry, prepared);
    const wrongTransport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
      "deriveBits",
    ]);
    await expect(
      openDeviceEnrollmentEnvelope(decodeBytes(ciphertext), wrongTransport, {
        purpose: "device-enrollment",
        vaultId: f.accountId,
        objectId: "recovery-transport-challenge",
        keyId: "recovery-transport-challenge",
        keyEpoch: retry.generation,
        revision: 1,
        recipientId: prepared.deviceId,
      }),
    ).rejects.toThrow();
    expect(secret.length).toBe(32);
    const wrongSigning = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    expect((await commit(f, retry, prepared, secret, wrongSigning.privateKey)).status).not.toBe(200);
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE account_id = ?")
          .bind(f.accountId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect((await oldPrivateRead(f)).status).toBe(200);
    const lastStart = await startRecovery(f);
    const lastPrepared = await prepare(f, lastStart);
    const lastChallenge = await challenge(f, lastStart, lastPrepared);
    const wrongSecret = crypto.getRandomValues(new Uint8Array(32));
    expect((await commit(f, lastStart, lastPrepared, wrongSecret)).status).not.toBe(200);
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE account_id = ? AND state = 'active'")
          .bind(f.accountId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(lastChallenge.secret).toHaveLength(32);
  });

  it("rejects stale Sessions, missing fresh assertions, and a superseded generation", async () => {
    const f = await fixture();
    await env.DB.prepare("UPDATE sessions SET fresh_asserted_at = NULL WHERE id = ?").bind(f.recovering.id).run();
    expect((await post("/api/files-recovery/start", f.recovering.cookie)).status).not.toBe(200);
    await env.DB.prepare("UPDATE sessions SET fresh_asserted_at = ? WHERE id = ?")
      .bind(Date.now(), f.recovering.id)
      .run();
    const start = await startRecovery(f);
    const p = await prepare(f, start);
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").bind(Date.now(), f.recovering.id).run();
    expect(
      (
        await post("/api/files-recovery/challenge", f.recovering.cookie, {
          enrollmentId: start.enrollmentId,
          intent: p.intent,
          intentSignature: p.intentSignature,
        })
      ).status,
    ).not.toBe(200);
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE account_id = ?")
          .bind(f.accountId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    const newer = await fixture();
    const newerStart = await startRecovery(newer);
    const newerPrepared = await prepare(newer, newerStart);
    const replacementCapsule = await createRecoveryMaterial(newer.accountId, {
      generation: 2,
      vaultRootKey: newer.hierarchy.vaultRootKey,
    });
    await env.DB.prepare(
      "UPDATE recovery_capsules SET generation = 2, recovery_salt = ?, ciphertext = ?, verification_public_key = ? WHERE account_id = ?",
    )
      .bind(
        replacementCapsule.recoverySalt,
        replacementCapsule.record.capsule,
        replacementCapsule.recoveryVerificationPublicKeyBytes,
        newer.accountId,
      )
      .run();
    expect(
      (
        await post("/api/files-recovery/challenge", newer.recovering.cookie, {
          enrollmentId: newerStart.enrollmentId,
          intent: newerPrepared.intent,
          intentSignature: newerPrepared.intentSignature,
        })
      ).status,
    ).not.toBe(200);
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE account_id = ?")
          .bind(newer.accountId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });

  it("binds the nonce even when the old recovery key signs an altered intent", async () => {
    const f = await fixture();
    const start = await startRecovery(f);
    const p = await prepare(f, start);
    const altered = { ...p.intent, nonce: encodeBytes(crypto.getRandomValues(new Uint8Array(32))) };
    const signature = encodeBytes(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          p.opened.recoveryEnrollmentKeyPair.privateKey,
          new Uint8Array(recoveryIntentMessage(altered)),
        ),
      ),
    );
    expect(
      (
        await post("/api/files-recovery/challenge", f.recovering.cookie, {
          enrollmentId: start.enrollmentId,
          intent: altered,
          intentSignature: signature,
        })
      ).status,
    ).not.toBe(200);
    expect(
      (
        await post("/api/files-recovery/challenge", f.recovering.cookie, {
          enrollmentId: start.enrollmentId,
          intent: p.intent,
          intentSignature: p.intentSignature,
        })
      ).status,
    ).not.toBe(200);
    expect((await oldPrivateRead(f)).status).toBe(200);
  });

  it("limits new starts and keeps a failed ceremony from adding a device", async () => {
    const f = await fixture();
    for (let index = 0; index < 3; index++)
      expect((await post("/api/files-recovery/start", f.recovering.cookie)).status).toBe(200);
    expect((await post("/api/files-recovery/start", f.recovering.cookie)).status).toBe(429);
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE account_id = ?")
          .bind(f.accountId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
});
