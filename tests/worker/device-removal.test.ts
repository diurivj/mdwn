import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { signDeviceProof, sessionBindingDigest } from "../../app/device/proof";
import { createSymmetricWriter, openSymmetric } from "../../app/crypto/enc-v1";
import { openDeviceEnrollmentEnvelope, sealDeviceEnrollmentEnvelope } from "../../app/crypto/vault";
import { decodeBytes, encodeBytes } from "../../app/signup/protocol";
import { recoveryCookie, seedNormalSession } from "./auth-fixtures";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const origin = "https://mdwn.test";
const inventoryUrl = `${origin}/api/private/devices/inventory`;
const removalUrl = `${origin}/api/private/devices/remove`;

type Device = { id: string; assertion: CryptoKeyPair; transport: CryptoKeyPair;
  session: Awaited<ReturnType<typeof seedNormalSession>> };

async function fixture(count = 2) {
  const id = crypto.randomUUID();
  const account = { accountId: `${id.slice(0, 14)}7${id.slice(15)}`, credentialIds: [crypto.randomUUID()] };
  const rootId = crypto.randomUUID();
  const rootKey = crypto.getRandomValues(new Uint8Array(32));
  const now = Date.now();
  const devices: Device[] = [];
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(account.accountId, crypto.randomUUID(), now, now),
    env.DB.prepare("INSERT INTO passkeys (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at) VALUES (?, ?, ?, 0, '[]', 'singleDevice', 0, ?, ?)")
      .bind(account.credentialIds[0], account.accountId, Uint8Array.of(1), now, now),
  ]);
  await env.DB.prepare("INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)")
    .bind(account.accountId, rootId).run();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO account_profiles (account_id, ciphertext, revision, epoch, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)")
      .bind(account.accountId, Uint8Array.of(7), now, now),
    env.DB.prepare("INSERT INTO recovery_capsules (account_id, generation, recovery_salt, ciphertext, verification_public_key) VALUES (?, 1, ?, ?, ?)")
      .bind(account.accountId, Uint8Array.of(3), Uint8Array.of(4), Uint8Array.of(5)),
    env.DB.prepare("INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'vault-recovery', ?, 'vault-root', ?, 1)")
      .bind(account.accountId, rootId, Uint8Array.of(1)),
  ]);
  for (let index = 0; index < count; index++) {
    const id = crypto.randomUUID();
    const assertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const transport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const session = await seedNormalSession(account);
    const writer = await createSymmetricWriter(rootKey);
    const label = await writer.seal(new TextEncoder().encode(`Device ${index + 1}`), {
      purpose: "device-label", vaultId: account.accountId,
      objectId: id, keyId: id, keyEpoch: 1, revision: 1,
    });
    const rootEnvelope = await sealDeviceEnrollmentEnvelope(rootKey, transport.publicKey, {
      purpose: "device-enrollment", vaultId: account.accountId,
      objectId: id, keyId: id, keyEpoch: 1, revision: 1, recipientId: id,
    });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, label_ciphertext, registry_epoch, created_at) VALUES (?, ?, ?, ?, 'active', 'signup', ?, ?, ?)")
        .bind(id, account.accountId, new Uint8Array(await crypto.subtle.exportKey("raw", transport.publicKey)),
          new Uint8Array(await crypto.subtle.exportKey("raw", assertion.publicKey)), label, index + 1, now),
      env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(id, session.id),
      env.DB.prepare("INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'device-enrollment', ?, ?, ?, 1)")
        .bind(account.accountId, id, id, rootEnvelope),
      env.DB.prepare("INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'owned-device', ?, ?, ?, 1)")
        .bind(account.accountId, rootId, id, Uint8Array.of(index + 10)),
    ]);
    devices.push({ id, assertion, transport, session });
  }
  async function send(device: Device, url: string, body?: object, epoch = count, proof?: unknown) {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const signed = proof ?? await signDeviceProof(device.assertion.privateKey, {
      sessionBinding: await sessionBindingDigest(device.session.id), deviceId: device.id,
      registryEpoch: epoch, method: "POST", url, body: raw,
    });
    return SELF.fetch(url, { method: "POST", headers: {
      cookie: device.session.cookie, origin, "X-Mdwn-Device-Proof": JSON.stringify(signed),
      ...(raw === undefined ? {} : { "content-type": "application/json" }),
    }, body: raw });
  }
  async function confirmation(device: Device, target: Device, epoch = count) {
    const inventory = await send(device, inventoryUrl, undefined, epoch);
    expect(inventory.status, await inventory.clone().text()).toBe(200);
    const list = await inventory.json() as { registryEpoch: number; devices: Array<{ id: string; labelCiphertext: string }> };
    const labelCiphertext = list.devices.find((item) => item.id === target.id)?.labelCiphertext;
    expect(labelCiphertext).toBeTruthy();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(labelCiphertext!));
    return { targetDeviceId: target.id, expectedEpoch: epoch, labelDigest: encodeBytes(new Uint8Array(digest)), confirmation: "remove-device" };
  }
  return { account, devices, send, confirmation, rootKey };
}

describe("Encryption-device inventory and removal", () => {
  it("shows only opaque encrypted inventory to a current active device", async () => {
    const f = await fixture();
    const [actor] = f.devices;
    const response = await f.send(actor!, inventoryUrl);
    expect(response.status).toBe(200);
    const data = await response.json() as { registryEpoch: number; devices: Array<Record<string, unknown>> };
    expect(data.registryEpoch).toBe(2);
    expect(data.devices).toHaveLength(2);
    expect(data.devices[0]).toEqual({ id: expect.any(String), labelCiphertext: expect.any(String), state: "active",
      createdAt: expect.any(Number), lastUseAt: null });
    expect(JSON.stringify(data)).not.toContain("Device 1");
    const readProof = await signDeviceProof(actor!.assertion.privateKey, {
      sessionBinding: await sessionBindingDigest(actor!.session.id), deviceId: actor!.id,
      registryEpoch: 2, method: "POST", url: inventoryUrl,
    });
    expect((await f.send(actor!, inventoryUrl, undefined, 2, readProof)).status).toBe(200);
    expect((await f.send(actor!, inventoryUrl, undefined, 2, readProof)).status).toBe(200);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM device_proof_uses WHERE account_id = ?")
      .bind(f.account.accountId).first()).toEqual({ n: 0 });
    const unbound = await seedNormalSession(f.account);
    expect((await SELF.fetch(inventoryUrl, { method: "POST", headers: { cookie: unbound.cookie, origin } })).status).toBe(403);
    expect((await SELF.fetch(inventoryUrl, { method: "POST", headers: { cookie: await recoveryCookie(f.account.accountId), origin } })).status).toBe(401);
  });

  it("rejects self-removal and cannot remove the last active device", async () => {
    const f = await fixture();
    const [actor, target] = f.devices;
    const body = await f.confirmation(actor!, actor!);
    expect((await f.send(actor!, removalUrl, body)).status).toBe(400);
    const single = await fixture(1);
    const only = single.devices[0]!;
    const attempt = await single.confirmation(only, only);
    expect((await single.send(only, removalUrl, attempt, 1)).status).toBe(400);
    expect((await f.send(actor!, inventoryUrl)).status).toBe(200);
    expect(target).toBeDefined();
  });

  it("cuts off only the target and keeps cached material outside the removal guarantee", async () => {
    const f = await fixture(3);
    const [actor, target, peer] = f.devices as [Device, Device, Device];
    const extra = await seedNormalSession(f.account);
    await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(target.id, extra.id).run();
    const before = await f.confirmation(actor, target, 3);
    const savedLabel = (await (await f.send(actor, inventoryUrl, undefined, 3)).json() as {
      devices: Array<{ id: string; labelCiphertext: string }>;
    }).devices.find((item) => item.id === target.id)!.labelCiphertext;
    const bootstrapUrl = `${origin}/api/private/bootstrap`;
    const readBootstrap = async (device: Device, epoch: number) => SELF.fetch(bootstrapUrl, {
      method: "POST", headers: { cookie: device.session.cookie, origin,
        "X-Mdwn-Device-Proof": JSON.stringify(await signDeviceProof(device.assertion.privateKey, {
          sessionBinding: await sessionBindingDigest(device.session.id), deviceId: device.id,
          registryEpoch: epoch, method: "POST", url: bootstrapUrl,
        })),
      },
    });
    const cachedBootstrap = await readBootstrap(target, 3);
    expect(cachedBootstrap.status).toBe(200);
    const savedRootEnvelope = (await cachedBootstrap.json() as { enrollmentEnvelope: string }).enrollmentEnvelope;
    const staleProof = await signDeviceProof(peer.assertion.privateKey, {
      sessionBinding: await sessionBindingDigest(peer.session.id), deviceId: peer.id,
      registryEpoch: 3, method: "POST", url: inventoryUrl,
    });
    const raw = JSON.stringify(before);
    const proof = await signDeviceProof(actor.assertion.privateKey, {
      sessionBinding: await sessionBindingDigest(actor.session.id), deviceId: actor.id,
      registryEpoch: 3, method: "POST", url: removalUrl, body: raw,
    });
    const removed = await f.send(actor, removalUrl, before, 3, proof);
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await removed.json()).toEqual({ ok: true, registryEpoch: 4 });
    expect((await f.send(actor, removalUrl, before, 3, proof)).status).toBe(200);
    expect((await f.send(actor, removalUrl, before, 4)).status).toBe(409);
    const renewed = await f.send(actor, removalUrl, { ...before, expectedEpoch: 4 }, 4);
    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toEqual({ ok: true, alreadyRemoved: true });
    expect((await f.send(peer, inventoryUrl, undefined, 3, staleProof)).status).toBe(403);
    const refreshed = await f.send(peer, inventoryUrl, undefined, 4);
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({ registryEpoch: 4,
      devices: expect.arrayContaining([expect.objectContaining({ id: target.id, state: "tombstoned" })]) });
    const actorInventory = await (await f.send(actor, inventoryUrl, undefined, 4)).json() as {
      devices: Array<{ id: string; lastUseAt: number | null }>;
    };
    expect(actorInventory.devices.find((item) => item.id === actor.id)?.lastUseAt)
      .toBe(Math.floor(Date.now() / 86_400_000) * 86_400_000);
    expect((await f.send(target, inventoryUrl, undefined, 4)).status).toBe(401);
    expect((await readBootstrap(target, 4)).status).toBe(403);
    expect((await readBootstrap(peer, 4)).status).toBe(200);
    expect((await SELF.fetch(inventoryUrl, { method: "POST", headers: { cookie: extra.cookie, origin } })).status).toBe(401);
    expect((await f.send(actor, inventoryUrl, undefined, 4)).status).toBe(200);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM key_envelopes WHERE account_id = ? AND recipient_id = ? AND superseded_at IS NULL")
      .bind(f.account.accountId, target.id).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM key_envelopes WHERE account_id = ? AND recipient_id = ? AND superseded_at IS NULL")
      .bind(f.account.accountId, peer.id).first()).toEqual({ n: 2 });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM key_envelopes WHERE account_id = ? AND purpose = 'vault-recovery' AND superseded_at IS NULL")
      .bind(f.account.accountId).first()).toEqual({ n: 1 });
    // A removed browser can still open the Vault-root envelope it fetched before removal.
    const cachedRoot = await openDeviceEnrollmentEnvelope(decodeBytes(savedRootEnvelope), target.transport, {
      purpose: "device-enrollment", vaultId: f.account.accountId,
      objectId: target.id, keyId: target.id, keyEpoch: 1, revision: 1, recipientId: target.id,
    });
    expect(cachedRoot).toEqual(f.rootKey);
    const cached = await openSymmetric(decodeBytes(savedLabel), f.rootKey, { context: {
      purpose: "device-label", vaultId: f.account.accountId,
      objectId: target.id, keyId: target.id, keyEpoch: 1, revision: 1,
    } });
    expect(new TextDecoder().decode(cached)).toBe("Device 2");
    expect((await env.DB.prepare("SELECT state FROM encryption_devices WHERE account_id = ? ORDER BY created_at, id")
      .bind(f.account.accountId).all()).results).toHaveLength(3);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM security_events WHERE account_id = ? AND action_class = 'device_removal'")
      .bind(f.account.accountId).first()).toEqual({ n: 1 });
  });

  it("cancels the target's pending enrollment, WebAuthn challenge and provisioning job", async () => {
    const f = await fixture();
    const [actor, target] = f.devices as [Device, Device];
    const candidate = await seedNormalSession(f.account);
    const now = Date.now();
    const enrollmentId = crypto.randomUUID();
    const challengeId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO device_enrollments (id, account_id, candidate_session_id,
        candidate_device_id, transport_public_key, assertion_public_key, transcript, transcript_digest,
        pairing_secret_hash, registry_epoch, state, approving_device_id, challenge_ciphertext,
        created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, 'challenged', ?, ?, ?, ?)`)
        .bind(enrollmentId, f.account.accountId, candidate.id, crypto.randomUUID(), new Uint8Array(65),
          new Uint8Array(65), Uint8Array.of(1), new Uint8Array(32), new Uint8Array(32), target.id,
          Uint8Array.of(2), now, now + 600_000),
      env.DB.prepare(`INSERT INTO webauthn_challenges (id, challenge, purpose, account_id, session_id,
        origin, rp_id, expires_at, created_at) VALUES (?, ?, 'fresh_assertion', ?, ?, ?, ?, ?, ?)`)
        .bind(challengeId, crypto.randomUUID(), f.account.accountId, target.session.id,
          origin, 'mdwn.test', now + 300_000, now),
      env.DB.prepare(`INSERT INTO crypto_jobs (id, account_id, device_id, kind, state, created_at, updated_at)
        VALUES (?, ?, ?, 'enrollment_owned', 'pending', ?, ?)`)
        .bind(crypto.randomUUID(), f.account.accountId, target.id, now, now),
    ]);
    const body = await f.confirmation(actor, target);
    expect((await f.send(actor, removalUrl, body)).status).toBe(200);
    expect(await env.DB.prepare("SELECT state, challenge_ciphertext FROM device_enrollments WHERE id = ?")
      .bind(enrollmentId).first()).toEqual({ state: "consumed", challenge_ciphertext: null });
    expect(await env.DB.prepare("SELECT id FROM webauthn_challenges WHERE id = ?").bind(challengeId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT state FROM crypto_jobs WHERE device_id = ?").bind(target.id).first())
      .toEqual({ state: "complete" });
  });

  it("requires a fresh assertion, current epoch, signed confirmation and label binding", async () => {
    const f = await fixture();
    const [actor, target] = f.devices as [Device, Device];
    const body = await f.confirmation(actor, target);
    const signed = await signDeviceProof(actor.assertion.privateKey, {
      sessionBinding: await sessionBindingDigest(actor.session.id), deviceId: actor.id,
      registryEpoch: 2, method: "POST", url: removalUrl, body: JSON.stringify(body),
    });
    expect((await f.send(actor, removalUrl, body, 2, { ...signed, signature: "bad" })).status).toBe(403);
    expect((await f.send(actor, removalUrl, { ...body, confirmation: "" }, 2, signed)).status).toBe(403);
    expect((await f.send(actor, removalUrl, { ...body, confirmation: "" })).status).toBe(400);
    expect((await f.send(actor, removalUrl, { ...body, labelDigest: encodeBytes(new Uint8Array(32)) })).status).toBe(409);
    await env.DB.prepare("UPDATE sessions SET fresh_asserted_at = ? WHERE id = ?")
      .bind(Date.now() - 600_000, actor.session.id).run();
    expect((await f.send(actor, removalUrl, body)).status).toBe(403);
    await env.DB.prepare("UPDATE sessions SET fresh_asserted_at = ? WHERE id = ?")
      .bind(Date.now(), actor.session.id).run();
    await env.DB.prepare("UPDATE account_encryption_identities SET registry_epoch = 3 WHERE account_id = ?")
      .bind(f.account.accountId).run();
    expect((await f.send(actor, removalUrl, body, 2)).status).toBe(403);
    expect((await f.send(actor, removalUrl, body, 3)).status).toBe(409);
    expect((await f.send(actor, removalUrl, { ...body, expectedEpoch: 3 }, 3)).status).toBe(200);
  });
});
