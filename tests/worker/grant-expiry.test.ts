import { applyD1Migrations, createScheduledController, env, type D1Migration } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { addSharingDevice, grant, opaqueId, renamePayload, sharingAccount, sharingRequest, treeChild } from "./sharing-fixtures";
import { createGrantKeyEnvelope, type GrantKeyContext } from "../../app/sharing/grant-keys";
import { createCommentKeyEnvelope, type CommentKeyContext } from "../../app/sharing/comment-keys";
import type { SharingAccount } from "./sharing-fixtures";
import worker from "../../workers/app";
import { createSymmetricWriter } from "../../app/crypto/enc-v1";
import { encodeTreeBytes } from "../../app/tree/wire";
import { rotationResumeContext } from "../../app/sharing/rotation-wire";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

/** Time boundary: make the persisted deadline past according to D1, without sleeps. */
async function passDeadline(grantId: string) {
  await env.DB.prepare("UPDATE grants SET expires_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 1 WHERE id = ?")
    .bind(grantId).run();
}

it("only the Owner can set or clear a live Grant deadline without rotating its keys", async () => {
  const owner = await sharingAccount(), recipient = await sharingAccount();
  const target = await treeChild(owner, owner.rootId, "directory");
  const { grantId } = await grant(owner, recipient, target);
  const path = `/api/private/grants/${grantId}`, expiresAt = Date.now() + 60_000;
  expect((await sharingRequest(recipient, path, "PATCH", { expectedRevision: 1, expiresAt })).status).toBe(404);
  const changed = await sharingRequest(owner, path, "PATCH", { expectedRevision: 1, expiresAt });
  expect(changed.status).toBe(200);
  expect(await changed.json()).toEqual({ revision: 2 });
  expect(await (await sharingRequest(recipient, "/api/private/grants")).json()).toMatchObject({
    received: [{ grantId, expiresAt, revision: 2, keyEpoch: 1 }],
  });
  expect(await (await sharingRequest(owner, "/api/private/key-rotations")).json()).toEqual({ jobs: [], nextCursor: null });
  expect((await sharingRequest(owner, path, "PATCH", { expectedRevision: 1, expiresAt: null })).status).toBe(409);
  expect((await sharingRequest(owner, path, "PATCH", { expectedRevision: 2, expiresAt: null })).status).toBe(200);
  expect(await (await sharingRequest(recipient, "/api/private/grants")).json()).toMatchObject({
    received: [{ grantId, expiresAt: null, revision: 3, keyEpoch: 1 }],
  });
  for (const invalid of [1, 1.5, Number.MAX_SAFE_INTEGER + 1, "tomorrow"]) {
    expect((await sharingRequest(owner, path, "PATCH", { expectedRevision: 3, expiresAt: invalid })).status).toBe(400);
  }
  const permission = await sharingRequest(owner, path, "PATCH", { expectedRevision: 3, expiresAt, permission: "read_write" });
  expect(permission.status).toBe(200);
  expect(await permission.json()).toMatchObject({ revision: 4, rotation: { targetId: target, state: "pending" } });
});

it("expiry immediately denies root/Comment reads and fulfillment and seals Owner writes before cleanup", async () => {
  const owner = await sharingAccount(), recipient = await sharingAccount();
  const directory = await treeChild(owner, owner.rootId, "directory"), file = await treeChild(owner, directory, "file");
  const { grantId } = await grant(owner, recipient, directory, "read_write");
  const path = `/api/private/grants/${grantId}`;
  const objectId = opaqueId(), capabilityId = opaqueId();
  await env.DB.prepare(`INSERT INTO sharing_comment_capabilities
    (object_id, owner_id, file_id, thread_id, purpose, publication_id, capability_id, capability_epoch)
    VALUES (?, ?, ?, ?, 'private-comment-thread', NULL, ?, 1)`)
    .bind(objectId, owner.accountId, file, objectId, capabilityId).run();
  const root = await (await sharingRequest(owner, `${path}/keys`)).json() as GrantKeyContext;
  const comment = await (await sharingRequest(owner, `${path}/comment-keys/${objectId}`)).json() as CommentKeyContext;
  const rootEnvelope = await createGrantKeyEnvelope(owner.keys.get(directory)!, recipient.transport.publicKey, owner.assertion.privateKey,
    { ...root, deviceId: recipient.deviceId, signerDeviceId: owner.deviceId });
  const commentEnvelope = await createCommentKeyEnvelope(new Uint8Array(32).fill(7), recipient.transport.publicKey, owner.assertion.privateKey,
    { ...comment, deviceId: recipient.deviceId, signerDeviceId: owner.deviceId });
  const packet = (context: GrantKeyContext, envelope: typeof rootEnvelope) => ({ capabilityId: context.capabilityId,
    capabilityEpoch: context.capabilityEpoch, ownerRegistryEpoch: context.ownerRegistryEpoch,
    recipientRegistryEpoch: context.recipientRegistryEpoch, envelopes: [envelope] });
  const commentPacket = packet(comment, commentEnvelope), rootPacket = packet(root, rootEnvelope);
  expect((await sharingRequest(owner, `${path}/comment-keys/${objectId}`, "PUT", commentPacket)).status).toBe(200);
  const rename = await renamePayload(owner, owner.accountId, file, directory);
  expect((await sharingRequest(owner, path, "PATCH", { expectedRevision: 1, expiresAt: Date.now() + 60_000 })).status).toBe(200);
  await passDeadline(grantId);
  expect((await sharingRequest(recipient, `/api/private/tree/files/${file}`)).status).toBe(404);
  expect((await sharingRequest(owner, `/api/private/tree/files/${file}`)).status).toBe(200);
  for (const actor of [owner, recipient]) {
    for (const suffix of ["/keys", "/comment-keys", `/comment-keys/${objectId}`, "/needs"]) {
      expect((await sharingRequest(actor, `${path}${suffix}`)).status).toBe(404);
    }
  }
  for (let freshProof = 0; freshProof < 2; freshProof++) {
    expect((await sharingRequest(owner, `${path}/keys`, "PUT", rootPacket)).status).toBe(404);
    expect((await sharingRequest(owner, `${path}/comment-keys/${objectId}`, "PUT", commentPacket)).status).toBe(404);
    expect((await sharingRequest(owner, path, "PATCH", { expectedRevision: 2, expiresAt: null })).status).toBe(404);
  }
  expect(await (await sharingRequest(recipient, "/api/private/grants")).json()).toMatchObject({ received: [] });
  expect(await (await sharingRequest(recipient, "/api/private/grant-provisioning/next")).json())
    .toEqual({ item: null, pending: false });
  expect(await (await sharingRequest(owner, "/api/private/grant-provisioning/next")).json())
    .toEqual({ item: null, pending: false, expirationPending: true });
  const blocked = await sharingRequest(owner, `/api/private/tree/nodes/${file}/name`, "PATCH", rename);
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toEqual({ error: "key_rotation_required" });
  await addSharingDevice(recipient);
  expect((await sharingRequest(recipient, `${path}/needs`)).status).toBe(404);
});

it("an overlapping live Grant preserves reads while expiry pauses even an already-started Owner rotation", async () => {
  const owner = await sharingAccount(), recipient = await sharingAccount(), other = await sharingAccount();
  const directory = await treeChild(owner, owner.rootId, "directory"), file = await treeChild(owner, directory, "file", owner.accountId, true);
  const broad = await grant(owner, recipient, directory), direct = await grant(owner, recipient, file);
  const removed = await grant(owner, other, directory);
  const revoke = await sharingRequest(owner, `/api/private/grants/${removed.grantId}`, "DELETE", { expectedRevision: 1 });
  const { rotation } = await revoke.json() as { rotation: { jobId: string } };
  const next = `/api/private/key-rotations/${rotation.jobId}/next`;
  const before = await sharingRequest(owner, next);
  expect(before.status).toBe(200);
  const { source } = await before.json() as { source: { entriesRevision: number } };
  const resumeEnvelope = encodeTreeBytes(await (await createSymmetricWriter(new Uint8Array(32).fill(9)))
    .seal(new Uint8Array(32).fill(10), rotationResumeContext(owner.accountId, rotation.jobId, directory, 2)));
  const packet = { operation: "start", operationId: opaqueId(), objectId: directory, sourceEpoch: 1,
    sourceRevision: source.entriesRevision, targetEpoch: 2, capabilityId: directory, resumeEnvelope };
  await passDeadline(broad.grantId);
  expect((await sharingRequest(recipient, `/api/private/tree/files/${file}`)).status).toBe(200);
  expect((await sharingRequest(recipient, `/api/private/tree/directories/${directory}`)).status).toBe(404);
  expect(await (await sharingRequest(recipient, "/api/private/grants")).json()).toMatchObject({ received: [{ grantId: direct.grantId }] });
  expect((await sharingRequest(owner, next)).status).toBe(409);
  expect((await sharingRequest(owner, `/api/private/key-rotations/${rotation.jobId}/step`, "PATCH", packet)).status).toBe(409);
  expect(await (await sharingRequest(owner, "/api/private/key-rotations")).json()).toMatchObject({ jobs: [{ runnable: false }] });
  expect((await sharingRequest(owner, `/api/private/key-rotations/${rotation.jobId}/grants/${direct.grantId}/keys`)).status).toBe(409);
});

it("the migrated Directory-head constraint rejects an expired Collaborator signer", async () => {
  const owner = await sharingAccount(), recipient = await sharingAccount();
  const directory = await treeChild(owner, owner.rootId, "directory");
  const { grantId } = await grant(owner, recipient, directory, "read_write");
  // Exercise the storage constraint itself, independently of the route's authorization predicate.
  const replaceHead = () => env.DB.prepare(`UPDATE directories SET entries_revision = entries_revision + 1,
    listing_ciphertext = X'01', listing_digest = zeroblob(32), listing_signature = zeroblob(64), listing_device_id = ?
    WHERE node_id = ?`).bind(recipient.deviceId, directory).run();
  await expect(replaceHead()).resolves.toMatchObject({ success: true });
  await passDeadline(grantId);
  await expect(replaceHead()).rejects.toThrow("invalid current Directory head");
});

const expiryPath = "/api/private/grant-provisioning/expire";
async function expirePass(owner: SharingAccount) {
  const response = await sharingRequest(owner, expiryPath, "PATCH", {});
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.json() as Promise<{ pending: boolean }>;
}

it("expiry drains only twenty dependent rows per pass, then hands its seal to an Owner rotation", async () => {
  const owner = await sharingAccount(), recipient = await sharingAccount();
  const directory = await treeChild(owner, owner.rootId, "directory"), file = await treeChild(owner, directory, "file");
  const { grantId } = await grant(owner, recipient, directory);
  // Seed producer-owned opaque Comment metadata and delivery ciphertext at the D1 boundary.
  for (let i = 0; i < 21; i++) {
    const objectId = opaqueId(), capabilityId = opaqueId();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO sharing_comment_capabilities
        (object_id, owner_id, file_id, thread_id, purpose, publication_id, capability_id, capability_epoch)
        VALUES (?, ?, ?, ?, 'public-comment-audience-epoch', ?, ?, 1)`)
        .bind(objectId, owner.accountId, file, objectId, opaqueId(), capabilityId),
      env.DB.prepare(`INSERT INTO grant_comment_key_envelopes (relationship_id, device_id, capability_id, capability_epoch,
        grant_key_epoch, owner_registry_epoch, recipient_registry_epoch, ciphertext, signature, signer_device_id, object_id)
        VALUES (?, ?, ?, 1, 1, 1, 1, X'01', zeroblob(64), ?, ?)`)
        .bind(grantId, recipient.deviceId, capabilityId, owner.deviceId, objectId),
    ]);
  }
  await passDeadline(grantId);
  expect(await expirePass(recipient)).toEqual({ pending: false });
  const proofId = opaqueId();
  const first = await sharingRequest(owner, expiryPath, "PATCH", {}, proofId);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ pending: true });
  expect((await sharingRequest(owner, expiryPath, "PATCH", {}, proofId)).status).toBe(409);
  expect(await (await sharingRequest(owner, "/api/private/key-rotations")).json()).toMatchObject({ jobs: [] });
  expect(await expirePass(owner)).toEqual({ pending: true });
  expect(await (await sharingRequest(owner, "/api/private/key-rotations")).json()).toMatchObject({ jobs: [] });
  expect(await expirePass(owner)).toEqual({ pending: false });
  expect(await (await sharingRequest(owner, "/api/private/key-rotations")).json()).toMatchObject({
    jobs: [{ targetId: directory, keyEpoch: 2, runnable: true }],
  });
  expect((await sharingRequest(owner, `/api/private/tree/files/${file}`, "PATCH", {})).status).toBe(409);
  expect((await sharingRequest(recipient, `/api/private/grants/${grantId}/keys`)).status).toBe(404);
  expect(await expirePass(owner)).toEqual({ pending: false });
});

it.each(["entries", "items", "receipts"] as const)("expiry drains superseded rotation %s in bounded passes before handing off the seal", async (kind) => {
  const owner = await sharingAccount(), recipient = await sharingAccount(), removed = await sharingAccount();
  const directory = await treeChild(owner, owner.rootId, "directory");
  const children = [];
  for (let index = 0; index < 21; index++) children.push(await treeChild(owner, directory, "file"));
  const active = await grant(owner, recipient, directory), revoked = await grant(owner, removed, directory);
  const response = await sharingRequest(owner, `/api/private/grants/${revoked.grantId}`, "DELETE", { expectedRevision: 1 });
  const { rotation } = await response.json() as { rotation: { jobId: string } };
  // Persist an interrupted job at the D1 boundary. Cleanup must bound each table,
  // including staged edges whose parent traversal item cannot yet be removed.
  for (const child of children) {
    if (kind === "entries") await env.DB.prepare(`INSERT INTO key_rotation_entries
      (job_id, directory_id, child_id, name_ciphertext, order_ciphertext, key_envelope)
      VALUES (?, ?, ?, X'01', X'01', X'01')`).bind(rotation.jobId, directory, child).run();
    if (kind === "items") await env.DB.prepare(`INSERT INTO key_rotation_items
      (job_id, object_id, kind, depth, state) VALUES (?, ?, 'file', 1, 'ready')`).bind(rotation.jobId, child).run();
    if (kind === "receipts") await env.DB.prepare(`INSERT INTO key_rotation_receipts
      (job_id, operation_id, digest) VALUES (?, ?, zeroblob(32))`).bind(rotation.jobId, opaqueId()).run();
  }
  await passDeadline(active.grantId);
  for (let pass = 0; pass < 2; pass++) {
    expect(await expirePass(owner)).toEqual({ pending: true });
    expect(await (await sharingRequest(owner, "/api/private/key-rotations")).json()).toMatchObject({
      jobs: [{ jobId: rotation.jobId, keyEpoch: 2, runnable: false }],
    });
    expect((await sharingRequest(owner, `/api/private/key-rotations/${rotation.jobId}/next`)).status).toBe(409);
    expect((await sharingRequest(owner, `/api/private/tree/files/${children[0]}`, "PATCH", {})).status).toBe(409);
    expect((await sharingRequest(recipient, `/api/private/tree/files/${children[0]}`)).status).toBe(404);
  }
  expect(await expirePass(owner)).toEqual({ pending: false });
  expect(await (await sharingRequest(owner, "/api/private/key-rotations")).json()).toMatchObject({
    jobs: [{ targetId: directory, keyEpoch: 3, runnable: true }],
  });
  expect((await sharingRequest(owner, `/api/private/key-rotations/${rotation.jobId}/next`)).status).toBe(409);
});

it("device and Comment insertion/rotation never recreate an expired Grant need", async () => {
  const owner = await sharingAccount(), recipient = await sharingAccount();
  const directory = await treeChild(owner, owner.rootId, "directory"), file = await treeChild(owner, directory, "file");
  const { grantId } = await grant(owner, recipient, directory);
  await passDeadline(grantId);
  expect(await expirePass(owner)).toEqual({ pending: true }); // drain the original root envelope
  await addSharingDevice(recipient);
  const objectId = opaqueId();
  await env.DB.prepare(`INSERT INTO sharing_comment_capabilities
    (object_id, owner_id, file_id, thread_id, purpose, publication_id, capability_id, capability_epoch)
    VALUES (?, ?, ?, ?, 'private-comment-thread', NULL, ?, 1)`)
    .bind(objectId, owner.accountId, file, objectId, opaqueId()).run();
  await env.DB.prepare("UPDATE sharing_comment_capabilities SET capability_epoch = 2 WHERE object_id = ?").bind(objectId).run();
  // Any regenerated need would require another drain pass rather than this immediate handoff.
  expect(await expirePass(owner)).toEqual({ pending: false });
  expect((await sharingRequest(recipient, `/api/private/grants/${grantId}/needs`)).status).toBe(404);
});

it("scheduled cleanup retains the write seal and skips drained Grants on its next pass", async () => {
  const owner = await sharingAccount(), recipient = await sharingAccount();
  const first = await treeChild(owner, owner.rootId, "directory"), second = await treeChild(owner, owner.rootId, "directory");
  const one = await grant(owner, recipient, first), two = await grant(owner, recipient, second);
  // Make these the oldest sweep candidates independent of other test Accounts.
  await env.DB.prepare("UPDATE grants SET expires_at = CASE id WHEN ? THEN 1 ELSE 2 END WHERE id IN (?, ?)")
    .bind(one.grantId, one.grantId, two.grantId).run();
  await worker.scheduled(createScheduledController({ scheduledTime: Date.now() }), env);
  await worker.scheduled(createScheduledController({ scheduledTime: Date.now() }), env);
  expect(await (await sharingRequest(owner, "/api/private/key-rotations")).json()).toMatchObject({ jobs: [] });
  for (const directory of [first, second]) {
    expect((await sharingRequest(owner, `/api/private/tree/directories/${directory}/children`, "PUT", {})).status).toBe(409);
  }
  expect(await expirePass(owner)).toEqual({ pending: true });
  expect(await (await sharingRequest(owner, "/api/private/key-rotations")).json()).toMatchObject({ jobs: [{ runnable: false }] });
  expect(await expirePass(owner)).toEqual({ pending: false });
  const jobs = await (await sharingRequest(owner, "/api/private/key-rotations")).json() as { jobs: { targetId: string }[] };
  expect(jobs.jobs.map((job) => job.targetId).sort()).toEqual([first, second].sort());
});
