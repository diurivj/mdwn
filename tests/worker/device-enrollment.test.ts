import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createVaultKeyHierarchy, openDeviceEnrollmentEnvelope, sealDeviceEnrollmentEnvelope } from "../../app/shared/crypto/vault";
import { digestEnvelope } from "../../app/shared/crypto/enc-v1";
import { signDeviceProof, sessionBindingDigest } from "../../app/shared/device/proof";
import { approvalMessage, candidateTranscriptMessage, possessionMessage, sha256,
  type CandidateTranscript, type EnrollmentApproval } from "../../app/enrollment/protocol";
import { decodeBytes, encodeBytes } from "../../app/shared/signup/protocol";
import { seedNormalSession } from "./auth-fixtures";

declare global {
  namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } }
}

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

function uuidv7(): string {
  const id = crypto.randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}

async function fixture() {
  const accountId = uuidv7();
  const rootId = uuidv7();
  const approverId = uuidv7();
  const credentialId = crypto.randomUUID();
  const now = Date.now();
  const hierarchy = await createVaultKeyHierarchy({ accountId, rootDirectoryId: rootId });
  const approverTransport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const approverAssertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const approverEnvelope = await sealDeviceEnrollmentEnvelope(hierarchy.vaultRootKey, approverTransport.publicKey, {
    purpose: "device-enrollment", vaultId: accountId, objectId: approverId,
    keyId: approverId, keyEpoch: 1, revision: 1, recipientId: approverId,
  });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(accountId, crypto.randomUUID(), now, now),
    env.DB.prepare("INSERT INTO passkeys (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at) VALUES (?, ?, ?, 0, '[]', 'singleDevice', 0, ?, ?)")
      .bind(credentialId, accountId, Uint8Array.of(1), now, now),
    env.DB.prepare("INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)")
      .bind(accountId, rootId),
    env.DB.prepare("INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, ?, ?, 'active', 'signup', 1, ?)")
      .bind(approverId, accountId, new Uint8Array(await crypto.subtle.exportKey("raw", approverTransport.publicKey)),
        new Uint8Array(await crypto.subtle.exportKey("raw", approverAssertion.publicKey)), now),
    env.DB.prepare("INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'vault-recovery', ?, 'vault-root', ?, 1)")
      .bind(accountId, rootId, hierarchy.rootDirectoryRecoveryEnvelope),
    env.DB.prepare("INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'device-enrollment', ?, ?, ?, 1)")
      .bind(accountId, approverId, approverId, approverEnvelope),
    env.DB.prepare("INSERT INTO account_profiles (account_id, ciphertext, revision, epoch, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)")
      .bind(accountId, Uint8Array.of(7), now, now),
  ]);
  const candidate = await seedNormalSession({ accountId, credentialIds: [credentialId] });
  const approver = await seedNormalSession({ accountId, credentialIds: [credentialId] });
  await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(approverId, approver.id).run();
  const transport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const assertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const pairingSecret = crypto.getRandomValues(new Uint8Array(32));
  const transcript: CandidateTranscript = {
    accountId, registryEpoch: 1, deviceId: uuidv7(),
    transportPublicKey: encodeBytes(new Uint8Array(await crypto.subtle.exportKey("raw", transport.publicKey))),
    assertionPublicKey: encodeBytes(new Uint8Array(await crypto.subtle.exportKey("raw", assertion.publicKey))),
    pairingSecretHash: encodeBytes(await sha256(pairingSecret)),
  };
  return { accountId, approverId, candidate, approver, transcript, pairingSecret,
    transport, assertion, approverTransport, approverAssertion, hierarchy };
}

function post(path: string, cookie: string, body: object): Promise<Response> {
  return SELF.fetch(`https://mdwn.test${path}`, { method: "POST", headers: {
    cookie, origin: "https://mdwn.test", "content-type": "application/json",
  }, body: JSON.stringify(body) });
}

async function privatePost(path: string, cookie: string, body: object, f: Awaited<ReturnType<typeof fixture>>): Promise<Response> {
  const raw = JSON.stringify(body);
  const url = `https://mdwn.test${path}`;
  const proof = await signDeviceProof(f.approverAssertion.privateKey, {
    sessionBinding: await sessionBindingDigest(f.approver.id), deviceId: f.approverId,
    registryEpoch: 1, method: "POST", url, body: raw,
  });
  return SELF.fetch(url, { method: "POST", headers: {
    cookie, origin: "https://mdwn.test", "content-type": "application/json",
    "X-Mdwn-Device-Proof": JSON.stringify(proof),
  }, body: raw });
}

async function start(f: Awaited<ReturnType<typeof fixture>>) {
  const transcriptDigest = encodeBytes(await sha256(candidateTranscriptMessage(f.transcript)));
  const response = await post("/api/device-enrollment/start", f.candidate.cookie,
    { transcript: f.transcript, transcriptDigest });
  expect(response.status, await response.clone().text()).toBe(200);
  return { ...await response.json() as { enrollmentId: string; expiresAt: number }, transcriptDigest };
}

describe("routine device enrollment", () => {
  it("starts only from a fresh unbound Session and stores the exact public transcript without the pairing secret", async () => {
    const f = await fixture();
    const transcriptDigest = encodeBytes(await sha256(candidateTranscriptMessage(f.transcript)));
    await env.DB.prepare("UPDATE sessions SET fresh_asserted_at = ? WHERE id = ?")
      .bind(Date.now() - 10 * 60_000, f.candidate.id).run();
    const body = { transcript: f.transcript, transcriptDigest };
    expect((await post("/api/device-enrollment/start", f.candidate.cookie, body)).status).toBe(400);
    await env.DB.prepare("UPDATE sessions SET fresh_asserted_at = ? WHERE id = ?")
      .bind(Date.now(), f.candidate.id).run();
    const response = await post("/api/device-enrollment/start", f.candidate.cookie, body);
    expect(response.status, await response.clone().text()).toBe(200);
    const started = await response.json() as { enrollmentId: string; expiresAt: number };
    expect(started.enrollmentId).toBeTruthy();
    expect(started.expiresAt).toBeGreaterThan(Date.now());
    expect(started.expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
    const row = await env.DB.prepare("SELECT state, transcript, transcript_digest, pairing_secret_hash FROM device_enrollments WHERE id = ?")
      .bind(started.enrollmentId).first<{ state: string; transcript: ArrayBuffer; transcript_digest: ArrayBuffer; pairing_secret_hash: ArrayBuffer }>();
    expect(row?.state).toBe("pending");
    expect(new Uint8Array(row!.transcript)).toEqual(candidateTranscriptMessage(f.transcript));
    expect(new Uint8Array(row!.transcript_digest)).toEqual(await sha256(candidateTranscriptMessage(f.transcript)));
    expect(new Uint8Array(row!.pairing_secret_hash)).toEqual(await sha256(f.pairingSecret));
    expect(JSON.stringify(row)).not.toContain(encodeBytes(f.pairingSecret));
  });

  it("lets the active approver compare the exact pending keys and rejects a changed envelope digest", async () => {
    const f = await fixture();
    const started = await start(f);
    const pendingResponse = await privatePost("/api/device-enrollment/pending", f.approver.cookie,
      { enrollmentId: started.enrollmentId }, f);
    expect(pendingResponse.status, await pendingResponse.clone().text()).toBe(200);
    const pending = await pendingResponse.json() as { transcript: CandidateTranscript;
      transcriptDigest: string; expiresAt: number; pairingSecretHash: string };
    expect(pending.transcript).toEqual(f.transcript);
    expect(pending.transcriptDigest).toBe(started.transcriptDigest);
    expect(pending.pairingSecretHash).toBe(encodeBytes(await sha256(f.pairingSecret)));
    const envelope = await sealDeviceEnrollmentEnvelope(f.hierarchy.vaultRootKey, f.transport.publicKey, {
      purpose: "device-enrollment", vaultId: f.accountId, objectId: f.transcript.deviceId,
      keyId: f.transcript.deviceId, keyEpoch: 1, revision: 1, recipientId: f.transcript.deviceId,
    });
    const approval: EnrollmentApproval = { ...f.transcript,
      enrollmentId: started.enrollmentId, transcriptDigest: started.transcriptDigest,
      envelopeDigest: encodeBytes(await digestEnvelope(envelope)),
      approvingDeviceId: f.approverId, expiresAt: started.expiresAt };
    const approvalSignature = encodeBytes(new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, f.approverAssertion.privateKey,
      approvalMessage(approval))));
    const bad = await privatePost("/api/device-enrollment/approve", f.approver.cookie,
      { enrollmentId: started.enrollmentId, approval: { ...approval, envelopeDigest: encodeBytes(new Uint8Array(32)) },
        approvalSignature, enrollmentEnvelope: encodeBytes(envelope) }, f);
    expect(bad.status).toBe(400);
    expect(await env.DB.prepare("SELECT state FROM device_enrollments WHERE id = ?")
      .bind(started.enrollmentId).first()).toEqual({ state: "pending" });
    const good = await privatePost("/api/device-enrollment/approve", f.approver.cookie,
      { enrollmentId: started.enrollmentId, approval, approvalSignature,
        enrollmentEnvelope: encodeBytes(envelope) }, f);
    expect(good.status, await good.clone().text()).toBe(200);
    expect(await env.DB.prepare("SELECT state FROM device_enrollments WHERE id = ?")
      .bind(started.enrollmentId).first()).toEqual({ state: "challenged" });
  });

  it("proves candidate possession and atomically adds a second active device without revoking the first", async () => {
    const f = await fixture();
    const started = await start(f);
    const envelope = await sealDeviceEnrollmentEnvelope(f.hierarchy.vaultRootKey, f.transport.publicKey, {
      purpose: "device-enrollment", vaultId: f.accountId, objectId: f.transcript.deviceId,
      keyId: f.transcript.deviceId, keyEpoch: 1, revision: 1, recipientId: f.transcript.deviceId,
    });
    const approval: EnrollmentApproval = { ...f.transcript,
      enrollmentId: started.enrollmentId, transcriptDigest: started.transcriptDigest,
      envelopeDigest: encodeBytes(await digestEnvelope(envelope)),
      approvingDeviceId: f.approverId, expiresAt: started.expiresAt };
    const approvalSignature = encodeBytes(new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, f.approverAssertion.privateKey,
      approvalMessage(approval))));
    const approved = await privatePost("/api/device-enrollment/approve", f.approver.cookie,
      { enrollmentId: started.enrollmentId, approval, approvalSignature,
        enrollmentEnvelope: encodeBytes(envelope) }, f);
    expect(approved.status, await approved.clone().text()).toBe(200);
    const status = await post("/api/device-enrollment/status", f.candidate.cookie,
      { enrollmentId: started.enrollmentId });
    expect(status.status, await status.clone().text()).toBe(200);
    const challenge = await status.json() as { state: string; challenge: string; enrollmentEnvelope: string;
      approval: EnrollmentApproval; approvalSignature: string };
    expect(challenge.state).toBe("challenged");
    expect(challenge.approval).toEqual(approval);
    const secret = await openDeviceEnrollmentEnvelope(decodeBytes(challenge.challenge), f.transport, {
      purpose: "device-enrollment", vaultId: f.accountId,
      objectId: "routine-transport-challenge", keyId: "routine-transport-challenge",
      keyEpoch: 1, revision: 1, recipientId: f.transcript.deviceId,
    });
    const signature = encodeBytes(new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, f.assertion.privateKey,
      possessionMessage(decodeBytes(started.transcriptDigest, 32), secret))));
    const commit = { enrollmentId: started.enrollmentId, transcript: f.transcript,
      transcriptDigest: started.transcriptDigest, approval, approvalSignature,
      enrollmentEnvelope: challenge.enrollmentEnvelope,
      challengeSecret: encodeBytes(secret), challengeSignature: signature };
    const changedKey = await post("/api/device-enrollment/commit", f.candidate.cookie,
      { ...commit, transcript: { ...f.transcript, transportPublicKey:
        encodeBytes(new Uint8Array(await crypto.subtle.exportKey("raw", f.approverTransport.publicKey))) } });
    expect(changedKey.status).toBe(400);
    const changedApproval = await post("/api/device-enrollment/commit", f.candidate.cookie,
      { ...commit, approval: { ...approval, envelopeDigest: encodeBytes(new Uint8Array(32)) } });
    expect(changedApproval.status).toBe(400);
    const changedChallenge = await post("/api/device-enrollment/commit", f.candidate.cookie,
      { ...commit, challengeSignature: encodeBytes(new Uint8Array(64)) });
    expect(changedChallenge.status).toBe(400);
    await env.DB.prepare("UPDATE sessions SET fresh_asserted_at = ? WHERE id = ?")
      .bind(Date.now() - 10 * 60_000, f.candidate.id).run();
    expect((await post("/api/device-enrollment/commit", f.candidate.cookie, commit)).status).toBe(400);
    expect(await env.DB.prepare("SELECT state FROM device_enrollments WHERE id = ?")
      .bind(started.enrollmentId).first()).toEqual({ state: "challenged" });
    expect(await env.DB.prepare("SELECT id FROM encryption_devices WHERE id = ?")
      .bind(f.transcript.deviceId).first()).toBeNull();
    await env.DB.prepare("UPDATE sessions SET fresh_asserted_at = ? WHERE id = ?")
      .bind(Date.now(), f.candidate.id).run();
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), f.approver.id).run();
    expect((await post("/api/device-enrollment/commit", f.candidate.cookie, commit)).status).toBe(400);
    expect(await env.DB.prepare("SELECT id FROM encryption_devices WHERE id = ?")
      .bind(f.transcript.deviceId).first()).toBeNull();
    await env.DB.prepare("UPDATE sessions SET revoked_at = NULL WHERE id = ?")
      .bind(f.approver.id).run();
    const committed = await post("/api/device-enrollment/commit", f.candidate.cookie, commit);
    expect(committed.status, await committed.clone().text()).toBe(200);
    expect(committed.headers.get("set-cookie")).toContain("__Host-mdwn_session=");
    expect(await committed.json()).toMatchObject({ ok: true, accountId: f.accountId,
      deviceId: f.transcript.deviceId, registryEpoch: 2 });
    expect((await env.DB.prepare("SELECT id, state FROM encryption_devices WHERE account_id = ? ORDER BY created_at")
      .bind(f.accountId).all<{ id: string; state: string }>()).results).toEqual([
      { id: f.approverId, state: "active" }, { id: f.transcript.deviceId, state: "active" },
    ]);
    expect(await env.DB.prepare("SELECT kind, state FROM crypto_jobs WHERE device_id = ?")
      .bind(f.transcript.deviceId).first()).toEqual({ kind: "enrollment_owned", state: "pending" });
    expect((await post("/api/device-enrollment/commit", f.candidate.cookie, commit)).status).toBe(401);
  });

  it("rejects expired or stale pending enrollments without exposing the candidate", async () => {
    const expired = await fixture();
    const expiredStart = await start(expired);
    const now = Date.now();
    await env.DB.prepare("UPDATE device_enrollments SET created_at = ?, expires_at = ? WHERE id = ?")
      .bind(now - 9 * 60_000, now - 1, expiredStart.enrollmentId).run();
    expect((await post("/api/device-enrollment/status", expired.candidate.cookie,
      { enrollmentId: expiredStart.enrollmentId })).status).toBe(400);
    expect((await privatePost("/api/device-enrollment/pending", expired.approver.cookie,
      { enrollmentId: expiredStart.enrollmentId }, expired)).status).toBe(400);
    expect(await env.DB.prepare("SELECT id FROM encryption_devices WHERE id = ?")
      .bind(expired.transcript.deviceId).first()).toBeNull();
    const stale = await fixture();
    const staleStart = await start(stale);
    await env.DB.prepare("UPDATE account_encryption_identities SET registry_epoch = 2 WHERE account_id = ?")
      .bind(stale.accountId).run();
    expect((await post("/api/device-enrollment/status", stale.candidate.cookie,
      { enrollmentId: staleStart.enrollmentId })).status).toBe(400);
    expect((await privatePost("/api/device-enrollment/pending", stale.approver.cookie,
      { enrollmentId: staleStart.enrollmentId }, stale)).status).toBe(403);
    expect(await env.DB.prepare("SELECT id FROM encryption_devices WHERE id = ?")
      .bind(stale.transcript.deviceId).first()).toBeNull();
  });
});
