import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { getActiveSession } from "../../app/auth/session.server";
import { sql } from "../../app/db/client.server";
import { authorizePrivateRequest, commitPrivateMutation, purgeExpiredSignupProofs } from "../../app/device/proof.server";
import { sessionBindingDigest, signDeviceProof } from "../../app/device/proof";
import { encodeBytes, solveProofOfWork, type SignupTranscript } from "../../app/signup/protocol";
import { seedAccount, seedNormalSession } from "./auth-fixtures";

declare global {
  namespace Cloudflare { interface Env {
    TEST_MIGRATIONS: D1Migration[];
    SESSION_COOKIE_SECRET: string;
    ABUSE_HMAC_SECRET: string;
  } }
}

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

function signupRequest(path: string, body: unknown, origin = "https://mdwn.test") {
  return SELF.fetch(`https://mdwn.test${path}`, {
    method: "POST",
    headers: { origin, "CF-Connecting-IP": "203.0.113.4", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const v7 = (suffix: string) => `019950d7-98c0-7000-8000-${suffix}`;
const b64 = (length: number) => encodeBytes(new Uint8Array(length).fill(1));
const key = () => encodeBytes(Uint8Array.of(4, ...new Uint8Array(64).fill(1)));

function transcript(challenge: string, nonce: string): SignupTranscript {
  return {
    accountId: v7("000000000010"), rootDirectoryId: v7("000000000011"), deviceId: v7("000000000012"),
    transportPublicKey: key(), assertionPublicKey: key(), capsuleGeneration: 1,
    capsuleDigest: b64(32), recoverySalt: b64(32), recoveryVerificationPublicKey: key(),
    rootRecoveryEnvelopeDigest: b64(32), enrollmentEnvelopeDigest: b64(32), profileDigest: b64(32),
    recoveryCodeHashes: Array.from({ length: 10 }, (_, n) => encodeBytes(new Uint8Array(32).fill(n))),
    registrationChallenge: challenge, proofNonce: nonce, registryEpoch: 1,
  };
}

describe("signup challenge and first private-operation boundary", () => {
  it("limits issuance before creating a challenge, consumes valid or invalid PoW once", async () => {
    const first = await signupRequest("/api/signup/challenge", {});
    expect(first.status).toBe(200);
    const start = await first.json() as {challengeId:string;challenge:string};
    expect(start.challenge).toHaveLength(43);
    const incorrect = await signupRequest("/api/signup/options", {
      challengeId: start.challengeId, nonce: b64(8), transcript: transcript(start.challenge, b64(8)),
    });
    expect(incorrect.status).toBe(400);
    const nonce = await solveProofOfWork(start.challenge);
    expect((await signupRequest("/api/signup/options", {
      challengeId: start.challengeId, nonce, transcript: transcript(start.challenge, nonce),
    })).status).toBe(400);
    expect(await env.DB.prepare("SELECT id FROM registration_challenges WHERE id = ?").bind(start.challengeId).first()).toBeNull();

    const second = await signupRequest("/api/signup/challenge", {});
    const third = await signupRequest("/api/signup/challenge", {});
    const denied = await signupRequest("/api/signup/challenge", {});
    expect([second.status, third.status, denied.status]).toEqual([200, 200, 429]);
    expect(denied.headers.get("Retry-After")).not.toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM registration_challenges").first<{n:number}>()).toEqual({n:2});
  }, 30_000);

  it("rejects cross-origin and malformed JSON before issuing a challenge", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM registration_challenges").first();
    expect((await signupRequest("/api/signup/challenge", {}, "https://other.test")).status).toBe(403);
    const malformed = await SELF.fetch("https://mdwn.test/api/signup/challenge", {
      method: "POST",
      headers: { origin: "https://mdwn.test", "CF-Connecting-IP": "203.0.113.4", "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM registration_challenges").first()).toEqual(before);
  });

  it("rejects unbound, missing, stale, wrong-request and invalid proofs; read-only checks do not write", async () => {
    const account = await seedAccount(1);
    const seeded = await seedNormalSession(account);
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const deviceId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)")
        .bind(account.accountId, crypto.randomUUID()),
      env.DB.prepare("INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, ?, ?, 'active', 'signup', 1, ?)")
        .bind(deviceId, account.accountId, new Uint8Array(65), publicKey, Date.now()),
      env.DB.prepare("INSERT INTO account_profiles (account_id, ciphertext, revision, epoch, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)")
        .bind(account.accountId, new Uint8Array([1]), Date.now(), Date.now()),
    ]);
    const url = "https://mdwn.test/api/private/bootstrap";
    const read = new Request(url, { method: "POST", headers: { cookie: seeded.cookie, origin: "https://mdwn.test" } });
    const session = await getActiveSession(read, env);
    expect(session).not.toBeNull();
    const sign = (overrides: {url?:string;method?:string;now?:number;epoch?:number} = {}) => signDeviceProof(pair.privateKey, {
      deviceId, sessionBinding: "", registryEpoch: overrides.epoch ?? 1,
      method: overrides.method ?? "GET", url: overrides.url ?? url,
      ...(overrides.now !== undefined ? { now: overrides.now } : {}),
    });
    const binding = await sessionBindingDigest(seeded.id);
    const good = await signDeviceProof(pair.privateKey, {
      deviceId, sessionBinding: binding, registryEpoch: 1, method: "POST", url,
    });
    expect(await authorizePrivateRequest(read, env, good)).toBeNull();
    await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(deviceId, seeded.id).run();
    expect(await authorizePrivateRequest(read, env, null)).toBeNull();
    expect(await authorizePrivateRequest(read, env, await sign())).toBeNull();
    expect(await authorizePrivateRequest(read, env, await signDeviceProof(pair.privateKey, {
      deviceId, sessionBinding: binding, registryEpoch: 1, method: "POST", url: `${url}?changed=1`,
    }))).toBeNull();
    expect(await authorizePrivateRequest(read, env, await signDeviceProof(pair.privateKey, {
      deviceId, sessionBinding: binding, registryEpoch: 1, method: "POST", url, now: Date.now() - 300_001,
    }))).toBeNull();
    expect(await authorizePrivateRequest(read, env, { ...good, signature: b64(64) })).toBeNull();
    expect(await authorizePrivateRequest(read, env, good)).toMatchObject({deviceId, registryEpoch:1});
    const firstRead = await SELF.fetch(url, {method:"POST", headers: {cookie:seeded.cookie, origin:"https://mdwn.test", "X-Mdwn-Device-Proof": JSON.stringify(good)}});
    const secondRead = await SELF.fetch(url, {method:"POST", headers: {cookie:seeded.cookie, origin:"https://mdwn.test", "X-Mdwn-Device-Proof": JSON.stringify(good)}});
    expect(firstRead.status).toBe(403); // no bootstrap envelopes in this seed
    expect(secondRead.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM device_proof_uses WHERE account_id=?").bind(account.accountId).first()).toEqual({n:0});
    await env.DB.prepare("UPDATE account_encryption_identities SET registry_epoch=2 WHERE account_id=?").bind(account.accountId).run();
    expect(await authorizePrivateRequest(read, env, good)).toBeNull();
  });

  it("purges only expired proof IDs and signup challenges", async () => {
    const account = await seedAccount(1);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO device_proof_uses (account_id, proof_id, session_id, expires_at) VALUES (?, 'old', 's', ?)")
        .bind(account.accountId, now - 1),
      env.DB.prepare("INSERT INTO device_proof_uses (account_id, proof_id, session_id, expires_at) VALUES (?, 'live', 's', ?)")
        .bind(account.accountId, now + 300_000),
      env.DB.prepare("INSERT INTO registration_challenges (id, challenge, origin, expires_at, created_at) VALUES ('expired', 'expired', 'https://mdwn.test', ?, ?)")
        .bind(now - 1, now - 6000),
      env.DB.prepare("INSERT INTO registration_challenges (id, challenge, origin, expires_at, created_at) VALUES ('current', 'current', 'https://mdwn.test', ?, ?)")
        .bind(now + 300_000, now),
    ]);
    await purgeExpiredSignupProofs(env, now);
    expect(await env.DB.prepare("SELECT proof_id FROM device_proof_uses WHERE account_id=?").bind(account.accountId).all())
      .toMatchObject({results:[{proof_id:"live"}]});
    expect(await env.DB.prepare("SELECT id FROM registration_challenges WHERE id IN ('expired', 'current') ORDER BY id").all())
      .toMatchObject({results:[{id:"current"}]});
  });

  it("consumes mutation proof only with its expected revision and rejects replay without a D1 write on reads", async () => {
    const account = await seedAccount(1);
    const seeded = await seedNormalSession(account);
    const pair = await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"}, false, ["sign","verify"]);
    const deviceId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)").bind(account.accountId, crypto.randomUUID()),
      env.DB.prepare("INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, ?, ?, 'active', 'signup', 1, ?)")
        .bind(deviceId, account.accountId, new Uint8Array(65), new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)), Date.now()),
      env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(deviceId, seeded.id),
      env.DB.prepare("INSERT INTO account_profiles (account_id, ciphertext, revision, epoch, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)")
        .bind(account.accountId, new Uint8Array([1]), Date.now(), Date.now()),
    ]);
    const url = "https://mdwn.test/api/private/bootstrap";
    const read = new Request(url, {method:"POST",headers:{cookie:seeded.cookie, origin:"https://mdwn.test"}});
    const proof = await signDeviceProof(pair.privateKey, {
      deviceId, sessionBinding:await sessionBindingDigest(seeded.id), registryEpoch:1, method:"POST", url,
    });
    const authorized = await authorizePrivateRequest(read, env, proof);
    expect(authorized).not.toBeNull();
    if (!authorized) return;
    const update = (expectedRevision: number) => commitPrivateMutation(env, authorized, (guard) =>
      sql`UPDATE account_profiles SET revision = revision+1
        WHERE account_id = ${account.accountId} AND revision = ${expectedRevision} AND ${guard}`,
    );
    expect(await update(9)).toBe(false);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM device_proof_uses WHERE account_id=?").bind(account.accountId).first()).toEqual({n:0});
    expect(await update(1)).toBe(true);
    expect(await update(2)).toBe(false);
    expect(await env.DB.prepare("SELECT revision FROM account_profiles WHERE account_id=?").bind(account.accountId).first()).toEqual({revision:2});
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM device_proof_uses WHERE account_id=?").bind(account.accountId).first()).toEqual({n:1});
    const competingProof = await signDeviceProof(pair.privateKey, {
      deviceId, sessionBinding: await sessionBindingDigest(seeded.id), registryEpoch: 1, method: "POST", url,
    });
    const competing = await authorizePrivateRequest(read, env, competingProof);
    expect(competing).not.toBeNull();
    if (!competing) return;
    const results = await Promise.all([1, 2].map(() => commitPrivateMutation(env, competing, (guard) =>
      sql`UPDATE account_profiles SET revision = revision + 1
        WHERE account_id = ${account.accountId} AND revision = 2 AND ${guard}`,
    )));
    expect(results.sort()).toEqual([false, true]);
    expect(await env.DB.prepare("SELECT revision FROM account_profiles WHERE account_id=?").bind(account.accountId).first()).toEqual({revision:3});
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM device_proof_uses WHERE account_id=?").bind(account.accountId).first()).toEqual({n:2});
  });
});
