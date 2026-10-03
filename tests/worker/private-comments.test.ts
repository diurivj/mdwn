import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { MAX_COMMENT_BODY_BYTES, MAX_COMMENT_CHARS, sealAttribution, sealCommentBody } from "../../app/comments/content";
import { createRecoveryMaterial, generateVaultRootKey, openVaultRecoveryEnvelope, sealDeviceEnrollmentEnvelope, sealVaultRecoveryEnvelope } from "../../app/crypto/vault";
import { createCommentKeyEnvelope, openCommentKeyEnvelope, type CommentKeyContext } from "../../app/sharing/comment-keys";
import { resumeRotation, type RotationBrowser } from "../../app/sharing/rotation-client";
import { openSymmetric } from "../../app/crypto/enc-v1";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/tree/wire";
import { deletePayload, grant, invite, opaqueId, prepareGrantKeys, sharingAccount, sharingRequest, treeChild, type SharingAccount } from "./sharing-fixtures";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

type ThreadFixture = { threadId: string; epochId: string; capabilityId: string;
  capability: Uint8Array<ArrayBuffer>; vaultRootKey: Uint8Array };

/** Owner creates the one Private thread with a real `vault-recovery` envelope. */
async function createThread(owner: SharingAccount, fileId: string, fill = 41,
  vaultRootKey: Uint8Array = generateVaultRootKey()): Promise<ThreadFixture> {
  const threadId = opaqueId(), epochId = opaqueId(), capabilityId = opaqueId();
  const capability = new Uint8Array(32).fill(fill);
  const recoveryEnvelope = await sealVaultRecoveryEnvelope(vaultRootKey,
    { scope: "owned", objectId: threadId, keyId: capabilityId, key: capability },
    { purpose: "vault-recovery", vaultId: owner.accountId, objectId: threadId, keyId: capabilityId, keyEpoch: 1, revision: 1 });
  const response = await sharingRequest(owner, `/api/private/comments/files/${fileId}`, "PUT",
    { threadId, epochId, capabilityId, recoveryEnvelope: encodeTreeBytes(recoveryEnvelope) });
  if (response.status !== 201) throw new Error(`thread create failed: ${response.status} ${await response.text()}`);
  return { threadId, epochId, capabilityId, capability, vaultRootKey };
}

async function sealedComment(ownerId: string, thread: ThreadFixture, text: string, revision = 1) {
  const commentId = opaqueId();
  const sealed = await sealCommentBody(thread.capability, { vaultId: ownerId, commentId,
    capabilityId: thread.capabilityId, keyEpoch: 1, revision, text });
  return { commentId, ...sealed };
}

async function sealedAttribution(ownerId: string, thread: ThreadFixture, pseudonym: string) {
  const attributionId = opaqueId();
  return sealAttribution(thread.capability, { vaultId: ownerId, attributionId, pseudonym,
    capabilityId: thread.capabilityId, keyEpoch: 1 });
}

function commentPayload(thread: ThreadFixture, comment: { commentId: string; bodyCiphertext: string; contentKeyEnvelope: string },
  attribution: { attributionId: string; ciphertext: string; contentKeyEnvelope: string } | null = null) {
  return { commentId: comment.commentId, threadId: thread.threadId, capabilityId: thread.capabilityId,
    capabilityEpoch: 1, epochId: thread.epochId, bodyCiphertext: comment.bodyCiphertext,
    contentKeyEnvelope: comment.contentKeyEnvelope, attribution };
}

type ThreadBody = { thread: null | { threadId: string; ownerId: string; epochId: string; capabilityId: string;
  capabilityEpoch: number; canComment: boolean; canDeleteAny: boolean; actorAccountId: string;
  envelope: { mode: "owned"; keyEpoch: number; ciphertext: string } | { mode: "grant"; grantId: string } };
  canCreateThread?: boolean;
  comments?: { id: string; authorId: string; sequence: number; revision: number; bodyCiphertext: string;
    contentKeyEnvelope: string; createdAt: number; updatedAt: number }[];
  attributions?: { id: string; authorId: string; revision: number; ciphertext: string; contentKeyEnvelope: string }[];
  nextCursor?: number | null };

async function readThread(account: SharingAccount, fileId: string) {
  const response = await sharingRequest(account, `/api/private/comments/files/${fileId}`);
  return { response, body: response.status === 200 ? await response.json() as ThreadBody : null };
}

/** Deliver the pending Share's thread envelope so acceptance coverage is complete. */
async function deliverThreadKey(owner: SharingAccount, relationshipId: string, thread: ThreadFixture) {
  const path = `/api/private/shares/${relationshipId}/comment-keys/${thread.threadId}`;
  const targets = await (await sharingRequest(owner, path)).json() as CommentKeyContext & {
    devices: { deviceId: string; transportPublicKey: string }[] };
  const envelopes = await Promise.all(targets.devices.map(async (device) => createCommentKeyEnvelope(thread.capability,
    await crypto.subtle.importKey("raw", decodeTreeBytes(device.transportPublicKey, 65),
      { name: "ECDH", namedCurve: "P-256" }, true, []), owner.assertion.privateKey,
    { ...targets, deviceId: device.deviceId, signerDeviceId: owner.deviceId })));
  const uploaded = await sharingRequest(owner, path, "PUT", { capabilityId: targets.capabilityId,
    capabilityEpoch: targets.capabilityEpoch, ownerRegistryEpoch: targets.ownerRegistryEpoch,
    recipientRegistryEpoch: targets.recipientRegistryEpoch, envelopes });
  if (!uploaded.ok) throw new Error(`comment delivery failed: ${uploaded.status}`);
}

/** Invite, cover the existing thread requirement, then accept. */
async function grantWithThread(owner: SharingAccount, recipient: SharingAccount, targetId: string,
  thread: ThreadFixture, permission: "read_only" | "read_write" = "read_only") {
  const share = await invite(owner, recipient, targetId, permission);
  await prepareGrantKeys(owner, share.shareId);
  await deliverThreadKey(owner, share.shareId, thread);
  const accepted = await sharingRequest(recipient, `/api/private/shares/${share.shareId}/accept`, "POST", {});
  if (accepted.status !== 201) throw new Error(`accept failed: ${accepted.status}`);
  return accepted.json() as Promise<{ grantId: string }>;
}

it("creates exactly one Private thread per File, idempotently and only for the Owner", async () => {
  const owner = await sharingAccount(), collaborator = await sharingAccount();
  const fileId = await treeChild(owner, owner.rootId, "file");
  const thread = await createThread(owner, fileId);
  const retry = await sharingRequest(owner, `/api/private/comments/files/${fileId}`, "PUT",
    { threadId: opaqueId(), epochId: opaqueId(), capabilityId: opaqueId(), recoveryEnvelope: "AQ" });
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual({ threadId: thread.threadId, created: false });
  expect((await sharingRequest(collaborator, `/api/private/comments/files/${fileId}`, "PUT",
    { threadId: opaqueId(), epochId: opaqueId(), capabilityId: opaqueId(), recoveryEnvelope: "AQ" })).status).toBe(404);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM comment_threads WHERE file_id = ? AND purpose = 'private'")
    .bind(fileId).first()).toEqual({ n: 1 });
  await expect(env.DB.prepare(`INSERT INTO comment_thread_epochs (id, thread_id, audience, key_epoch, ordinal, state, created_at)
    VALUES (?, ?, NULL, 1, 2, 'active', 1)`).bind(opaqueId(), thread.threadId).run()).rejects.toThrow();
  expect(await env.DB.prepare(`SELECT count(*) AS n FROM comment_thread_epochs
    WHERE thread_id = ? AND state = 'active'`).bind(thread.threadId).first()).toEqual({ n: 1 });
});

it("serves an empty create-capable state before a thread exists and never combines threads", async () => {
  const owner = await sharingAccount(), collaborator = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  const ownerRead = await readThread(owner, fileId);
  expect(ownerRead.body).toEqual({ thread: null, canCreateThread: true });
  await grant(owner, collaborator, directoryId);
  expect((await readThread(collaborator, fileId)).body).toEqual({ thread: null, canCreateThread: false });
  await createThread(owner, fileId);
  const shared = await readThread(collaborator, fileId);
  expect(shared.response.status).toBe(409);
  expect(await shared.response.json()).toEqual({ error: "secure_access_preparing" });
});

it("reads the Owner envelope, ordered ciphertext and create-once pseudonym attributions", async () => {
  const owner = await sharingAccount();
  const fileId = await treeChild(owner, owner.rootId, "file");
  const thread = await createThread(owner, fileId);
  const attribution = await sealedAttribution(owner.accountId, thread, "Member Quiet Pine");
  const first = await sealedComment(owner.accountId, thread, "First line\r\nSecond line");
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/entries`, "POST",
    commentPayload(thread, first, attribution))).status).toBe(201);
  const second = await sealedComment(owner.accountId, thread, "Second comment");
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/entries`, "POST",
    commentPayload(thread, second, await sealedAttribution(owner.accountId, thread, "Member Late Bloom")))).status).toBe(201);
  const { response, body } = await readThread(owner, fileId);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(body!.thread).toMatchObject({ threadId: thread.threadId, ownerId: owner.accountId, epochId: thread.epochId,
    capabilityId: thread.capabilityId, capabilityEpoch: 1, canComment: true, canDeleteAny: true });
  expect(body!.thread!.envelope.mode).toBe("owned");
  const opened = await openVaultRecoveryEnvelope(decodeTreeBytes((body!.thread!.envelope as { ciphertext: string }).ciphertext),
    thread.vaultRootKey, { purpose: "vault-recovery", vaultId: owner.accountId, objectId: thread.threadId,
      keyId: thread.capabilityId, keyEpoch: 1, revision: 1 });
  expect(opened).toEqual(thread.capability);
  expect(body!.comments!.map((comment) => comment.sequence)).toEqual([1, 2]);
  expect(body!.comments![0]!.bodyCiphertext).toBe(first.bodyCiphertext);
  expect(body!.attributions).toHaveLength(1);
  expect(body!.attributions![0]!.ciphertext).toBe(attribution.ciphertext);
  // The stored body is a real encrypted envelope, never plain text.
  const row = await env.DB.prepare("SELECT body_ciphertext, body_size, content_key_envelope FROM comments WHERE id = ?")
    .bind(first.commentId).first<{ body_ciphertext: ArrayBuffer; body_size: number; content_key_envelope: ArrayBuffer }>();
  expect(row!.body_size).toBe(new Uint8Array(row!.body_ciphertext as unknown as ArrayBuffer).length);
  expect(new TextDecoder().decode(new Uint8Array(row!.body_ciphertext))).not.toContain("First line");
  const contentKey = await openSymmetric(decodeTreeBytes(first.contentKeyEnvelope), thread.capability, { context: {
    purpose: "comment-content", vaultId: owner.accountId, objectId: first.commentId,
    keyId: thread.capabilityId, keyEpoch: 1, revision: 1 } });
  const plaintext = await openSymmetric(new Uint8Array(row!.body_ciphertext), contentKey, { context: {
    purpose: "comment-content", vaultId: owner.accountId, objectId: first.commentId,
    keyId: first.commentId, keyEpoch: 1, revision: 1 } });
  expect(new TextDecoder().decode(plaintext)).toBe("First line\nSecond line");
});

it("rejects crossed, oversized and malformed Comment envelopes", async () => {
  const owner = await sharingAccount();
  const fileId = await treeChild(owner, owner.rootId, "file");
  const thread = await createThread(owner, fileId);
  const comment = await sealedComment(owner.accountId, thread, "Valid");
  const path = `/api/private/comments/files/${fileId}/entries`;
  expect((await sharingRequest(owner, path, "POST", { ...commentPayload(thread, comment), extra: true })).status).toBe(400);
  expect((await sharingRequest(owner, path, "POST", commentPayload(thread, { ...comment, commentId: opaqueId() }))).status).toBe(400);
  expect((await sharingRequest(owner, path, "POST", { ...commentPayload(thread, comment), bodyCiphertext: "AQ" })).status).toBe(400);
  expect((await sharingRequest(owner, path, "POST", { ...commentPayload(thread, comment), contentKeyEnvelope: "AQ" })).status).toBe(400);
  expect((await sharingRequest(owner, path, "POST", { ...commentPayload(thread, comment), capabilityEpoch: 2 })).status).toBe(409);
  const secondThread = await createThread(owner, await treeChild(owner, owner.rootId, "file"));
  const crossed = await sealedAttribution(owner.accountId, secondThread, "Member Crossed");
  expect((await sharingRequest(owner, path, "POST", commentPayload(thread, comment, crossed))).status).toBe(400);
  expect(MAX_COMMENT_BODY_BYTES).toBe(16_384);
  expect(MAX_COMMENT_CHARS).toBe(2_000);
});

it("lets a read-only Collaborator read, create, edit and delete its own Comments but not the Owner's", async () => {
  const owner = await sharingAccount(), collaborator = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  const thread = await createThread(owner, fileId);
  const ownerComment = await sealedComment(owner.accountId, thread, "Owner text");
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/entries`, "POST",
    commentPayload(thread, ownerComment, await sealedAttribution(owner.accountId, thread, "Member Owner")))).status).toBe(201);
  const grantRecord = await grantWithThread(owner, collaborator, directoryId, thread, "read_only");
  const shared = await readThread(collaborator, fileId);
  expect(shared.response.status).toBe(200);
  expect(shared.body!.thread).toMatchObject({ canComment: true, canDeleteAny: false });
  expect(shared.body!.thread!.envelope).toMatchObject({ mode: "grant", relationshipId: grantRecord.grantId });
  const grantEnvelope = await (await sharingRequest(collaborator,
    `/api/private/grants/${grantRecord.grantId}/comment-keys/${thread.threadId}`)).json() as Parameters<typeof openCommentKeyEnvelope>[0];
  expect(await openCommentKeyEnvelope({ ...grantEnvelope, recipient: collaborator.transport })).toEqual(thread.capability);
  const collaboratorComment = await sealedComment(owner.accountId, thread, "Collaborator text");
  expect((await sharingRequest(collaborator, `/api/private/comments/files/${fileId}/entries`, "POST",
    commentPayload(thread, collaboratorComment, await sealedAttribution(owner.accountId, thread, "Member Read Only")))).status).toBe(201);
  const edit = async (account: SharingAccount, target: { commentId: string; bodyCiphertext: string; contentKeyEnvelope: string }, text: string, revision: number) => {
    const sealed = await sealCommentBody(thread.capability, { vaultId: owner.accountId, commentId: target.commentId,
      capabilityId: thread.capabilityId, keyEpoch: 1, revision, text });
    return sharingRequest(account, `/api/private/comments/files/${fileId}/entries/${target.commentId}`, "PATCH", {
      threadId: thread.threadId, capabilityId: thread.capabilityId, capabilityEpoch: 1, epochId: thread.epochId,
      expectedRevision: revision - 1, bodyCiphertext: sealed.bodyCiphertext, contentKeyEnvelope: sealed.contentKeyEnvelope });
  };
  expect((await edit(collaborator, collaboratorComment, "Edited by author", 2)).status).toBe(200);
  expect((await edit(collaborator, ownerComment, "Hijacked", 2)).status).toBe(403);
  expect((await edit(owner, collaboratorComment, "Owner rewrite", 2)).status).toBe(403);
  const remove = (account: SharingAccount, commentId: string, revision: number) => sharingRequest(account,
    `/api/private/comments/files/${fileId}/entries/${commentId}`, "DELETE",
    { threadId: thread.threadId, capabilityId: thread.capabilityId, capabilityEpoch: 1, epochId: thread.epochId, expectedRevision: revision });
  expect((await remove(collaborator, ownerComment.commentId, 1)).status).toBe(403);
  expect((await remove(owner, collaboratorComment.commentId, 2)).status).toBe(200);
  expect((await remove(collaborator, collaboratorComment.commentId, 2)).status).toBe(200);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM comments WHERE thread_id = ?").bind(thread.threadId).first()).toEqual({ n: 1 });
  expect(await env.DB.prepare("SELECT count(*) AS n FROM thread_attributions WHERE thread_id = ?").bind(thread.threadId).first()).toEqual({ n: 2 });
});

it("denies a non-author edit without leaking and keeps the stored body unchanged", async () => {
  const owner = await sharingAccount(), stranger = await sharingAccount();
  const fileId = await treeChild(owner, owner.rootId, "file");
  const thread = await createThread(owner, fileId);
  const comment = await sealedComment(owner.accountId, thread, "Owner only");
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/entries`, "POST", commentPayload(thread, comment))).status).toBe(201);
  const before = await env.DB.prepare("SELECT body_ciphertext, revision FROM comments WHERE id = ?").bind(comment.commentId)
    .first<{ body_ciphertext: ArrayBuffer; revision: number }>();
  const sealed = await sealCommentBody(thread.capability, { vaultId: owner.accountId, commentId: comment.commentId,
    capabilityId: thread.capabilityId, keyEpoch: 1, revision: 2, text: "stranger edit" });
  const response = await sharingRequest(stranger, `/api/private/comments/files/${fileId}/entries/${comment.commentId}`, "PATCH", {
    threadId: thread.threadId, capabilityId: thread.capabilityId, capabilityEpoch: 1, epochId: thread.epochId,
    expectedRevision: 1, bodyCiphertext: sealed.bodyCiphertext, contentKeyEnvelope: sealed.contentKeyEnvelope });
  expect(response.status).toBe(404);
  const after = await env.DB.prepare("SELECT body_ciphertext, revision FROM comments WHERE id = ?").bind(comment.commentId)
    .first<{ body_ciphertext: ArrayBuffer; revision: number }>();
  expect(new Uint8Array(after!.body_ciphertext)).toEqual(new Uint8Array(before!.body_ciphertext));
  expect(after!.revision).toBe(1);
});

it("denies reads and mutations after revocation and serves no thread material to a revoked device", async () => {
  const owner = await sharingAccount(), collaborator = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  const thread = await createThread(owner, fileId);
  const grantRecord = await grantWithThread(owner, collaborator, directoryId, thread);
  const comment = await sealedComment(owner.accountId, thread, "Shared note");
  expect((await sharingRequest(collaborator, `/api/private/comments/files/${fileId}/entries`, "POST",
    commentPayload(thread, comment))).status).toBe(201);
  expect((await sharingRequest(owner, `/api/private/grants/${grantRecord.grantId}`, "DELETE", { expectedRevision: 1 })).status).toBe(200);
  const denied = await readThread(collaborator, fileId);
  expect(denied.response.status).toBe(404);
  expect(await denied.response.text()).not.toContain("bodyCiphertext");
  expect((await sharingRequest(collaborator, `/api/private/grants/${grantRecord.grantId}/comment-keys/${thread.threadId}`)).status).toBe(404);
  await env.DB.prepare("UPDATE encryption_devices SET state = 'revoked' WHERE id = ?").bind(collaborator.deviceId).run();
  expect((await readThread(collaborator, fileId)).response.status).toBe(403);
  expect((await env.DB.prepare("SELECT count(*) AS n FROM comments WHERE thread_id = ?").bind(thread.threadId).first())).toEqual({ n: 1 });
});

it("blocks new Comments under a rotation seal but still allows hard deletion", async () => {
  const owner = await sharingAccount();
  const fileId = await treeChild(owner, owner.rootId, "file");
  const thread = await createThread(owner, fileId);
  const comment = await sealedComment(owner.accountId, thread, "Sealed");
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/entries`, "POST", commentPayload(thread, comment))).status).toBe(201);
  await env.DB.prepare(`INSERT INTO sharing_write_blocks (target_id, owner_id, target_kind, key_epoch, created_at)
    VALUES (?, ?, 'file', 2, ?)`).bind(fileId, owner.accountId, Date.now()).run();
  const blocked = await sealedComment(owner.accountId, thread, "Blocked");
  const sealedWrite = await sharingRequest(owner, `/api/private/comments/files/${fileId}/entries`, "POST", commentPayload(thread, blocked));
  expect(sealedWrite.status).toBe(409);
  expect(await sealedWrite.json()).toEqual({ error: "key_rotation_required" });
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/entries/${comment.commentId}`, "DELETE",
    { threadId: thread.threadId, capabilityId: thread.capabilityId, capabilityEpoch: 1, epochId: thread.epochId, expectedRevision: 1 })).status).toBe(200);
});

it("hard-deletes the Private thread, Comments, attributions and owned envelopes with the File", async () => {
  const owner = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  const thread = await createThread(owner, fileId);
  const comment = await sealedComment(owner.accountId, thread, "Doomed");
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/entries`, "POST",
    commentPayload(thread, comment, await sealedAttribution(owner.accountId, thread, "Member Doomed")))).status).toBe(201);
  const deletion = await deletePayload(owner, owner.accountId, fileId, directoryId);
  expect((await sharingRequest(owner, `/api/private/tree/nodes/${fileId}`, "DELETE", deletion)).status).toBe(200);
  for (const [table, column, value] of [
    ["comments", "thread_id", thread.threadId], ["thread_attributions", "thread_id", thread.threadId],
    ["comment_thread_epochs", "thread_id", thread.threadId], ["comment_threads", "id", thread.threadId],
    ["sharing_comment_capabilities", "object_id", thread.threadId], ["key_envelopes", "object_id", thread.threadId],
  ] as const) {
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).bind(value).first()).toEqual({ n: 0 });
  }
});

it("reports missing owned and Grant Comment envelopes without serving ciphertext", async () => {
  const owner = await sharingAccount(), collaborator = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  const grantRecord = await grant(owner, collaborator, directoryId);
  const thread = await createThread(owner, fileId);
  const missing = await readThread(collaborator, fileId);
  expect(missing.response.status).toBe(409);
  expect(await missing.response.json()).toEqual({ error: "secure_access_preparing" });
  expect(await env.DB.prepare("SELECT count(*) AS n FROM provisioning_needs WHERE grant_id = ?").bind(grantRecord.grantId).first())
    .toEqual({ n: 1 });
  await env.DB.prepare("DELETE FROM key_envelopes WHERE object_id = ? AND purpose = 'vault-recovery'").bind(thread.threadId).run();
  const owned = await readThread(owner, fileId);
  expect(owned.response.status).toBe(409);
  expect(await owned.response.json()).toEqual({ error: "owned_comment_key_missing" });
});

/** Same Owner-side browser seam used by the rotation tests. */
async function rotationBrowser(owner: SharingAccount): Promise<RotationBrowser> {
  const vaultRootKey = generateVaultRootKey();
  const material = await createRecoveryMaterial(owner.accountId, { vaultRootKey });
  const recovery = await sealVaultRecoveryEnvelope(vaultRootKey, { key: owner.keys.get(owner.rootId)!,
    objectId: owner.rootId, keyId: owner.rootId, scope: "owned" }, { purpose: "vault-recovery", vaultId: owner.accountId,
      objectId: owner.rootId, keyId: owner.rootId, keyEpoch: 1, revision: 1 });
  const enrollment = await sealDeviceEnrollmentEnvelope(vaultRootKey, owner.transport.publicKey, { purpose: "device-enrollment",
    vaultId: owner.accountId, objectId: owner.deviceId, keyId: owner.deviceId, keyEpoch: 1, revision: 1, recipientId: owner.deviceId });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch)
      VALUES (?, 'vault-recovery', ?, 'vault-root', ?, 1), (?, 'device-enrollment', ?, ?, ?, 1)`)
      .bind(owner.accountId, owner.rootId, recovery, owner.accountId, owner.deviceId, owner.deviceId, enrollment),
    env.DB.prepare(`INSERT INTO recovery_capsules (account_id, generation, recovery_salt, ciphertext, verification_public_key)
      VALUES (?, 1, ?, ?, ?)`).bind(owner.accountId, material.record.recoverySalt, material.record.capsule, material.recoveryVerificationPublicKeyBytes),
    env.DB.prepare(`INSERT INTO account_profiles (account_id, ciphertext, revision, epoch, created_at, updated_at) VALUES (?, X'01', 1, 1, 1, 1)`)
      .bind(owner.accountId),
  ]);
  return { accountId: owner.accountId, deviceId: owner.deviceId, vaultRootKey, assertionKey: owner.assertion.privateKey,
    request: (path, method = "POST", body) => sharingRequest(owner, path, method, body) };
}

it("rotation rewraps Comment bodies beneath the replacement thread capability and preserves ciphertext", async () => {
  const owner = await sharingAccount(), removed = await sharingAccount();
  const browser = await rotationBrowser(owner);
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  const thread = await createThread(owner, fileId, 41, browser.vaultRootKey);
  const attribution = await sealedAttribution(owner.accountId, thread, "Member Rotated");
  const comment = await sealedComment(owner.accountId, thread, "Preserved body");
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/entries`, "POST",
    commentPayload(thread, comment, attribution))).status).toBe(201);
  const before = await env.DB.prepare("SELECT body_ciphertext FROM comments WHERE id = ?").bind(comment.commentId)
    .first<{ body_ciphertext: ArrayBuffer }>();
  const revoked = await grantWithThread(owner, removed, directoryId, thread);
  const { rotation } = await (await sharingRequest(owner, `/api/private/grants/${revoked.grantId}`, "DELETE",
    { expectedRevision: 1 })).json() as { rotation: { jobId: string } };
  expect(await resumeRotation(rotation.jobId, browser, { maxSteps: 100 })).toBe(true);
  const after = await env.DB.prepare(`SELECT c.body_ciphertext, c.content_key_envelope, c.content_key_epoch,
    e.key_epoch AS thread_epoch, cap.capability_epoch FROM comments c
    JOIN comment_thread_epochs e ON e.id = c.epoch_id JOIN sharing_comment_capabilities cap ON cap.object_id = c.thread_id
    WHERE c.id = ?`).bind(comment.commentId).first<{ body_ciphertext: ArrayBuffer; content_key_envelope: ArrayBuffer;
      content_key_epoch: number; thread_epoch: number; capability_epoch: number }>();
  expect(new Uint8Array(after!.body_ciphertext)).toEqual(new Uint8Array(before!.body_ciphertext));
  expect(after!.content_key_epoch).toBe(2);
  expect(after!.thread_epoch).toBe(2);
  expect(after!.capability_epoch).toBe(2);
  const currentEnvelope = await env.DB.prepare(`SELECT ciphertext, key_epoch FROM key_envelopes
    WHERE object_id = ? AND purpose = 'vault-recovery' AND recipient_id = 'vault-root' AND superseded_at IS NULL`)
    .bind(thread.threadId).first<{ ciphertext: ArrayBuffer; key_epoch: number }>();
  expect(currentEnvelope!.key_epoch).toBe(2);
  const replacementKey = await openVaultRecoveryEnvelope(new Uint8Array(currentEnvelope!.ciphertext), thread.vaultRootKey,
    { purpose: "vault-recovery", vaultId: owner.accountId, objectId: thread.threadId,
      keyId: thread.capabilityId, keyEpoch: 2, revision: 1 });
  const contentKey = await openSymmetric(new Uint8Array(after!.content_key_envelope), replacementKey, { context: {
    purpose: "comment-content", vaultId: owner.accountId, objectId: comment.commentId,
    keyId: thread.capabilityId, keyEpoch: 2, revision: 1 } });
  expect(contentKey).toHaveLength(32);
  await expect(openSymmetric(new Uint8Array(after!.content_key_envelope), thread.capability, { context: {
    purpose: "comment-content", vaultId: owner.accountId, objectId: comment.commentId,
    keyId: thread.capabilityId, keyEpoch: 1, revision: 1 } })).rejects.toThrow();
  const attributionRow = await env.DB.prepare("SELECT content_key_envelope, content_key_epoch FROM thread_attributions WHERE id = ?")
    .bind(attribution.attributionId).first<{ content_key_envelope: ArrayBuffer; content_key_epoch: number }>();
  expect(attributionRow!.content_key_epoch).toBe(2);
  const attributionKey = await openSymmetric(new Uint8Array(attributionRow!.content_key_envelope), replacementKey, { context: {
    purpose: "attribution", vaultId: owner.accountId, objectId: attribution.attributionId,
    keyId: thread.capabilityId, keyEpoch: 2, revision: 1 } });
  expect(attributionKey).toHaveLength(32);
  // The post-rotation Owner read serves the new epoch and the same body ciphertext.
  const reread = await readThread(owner, fileId);
  expect(reread.body!.thread!.capabilityEpoch).toBe(2);
  expect(reread.body!.comments![0]!.bodyCiphertext).toBe(comment.bodyCiphertext);
});

it("treats an exact Comment-create retry as idempotent without duplicating the row", async () => {
  const owner = await sharingAccount();
  const fileId = await treeChild(owner, owner.rootId, "file");
  const thread = await createThread(owner, fileId);
  const comment = await sealedComment(owner.accountId, thread, "Once");
  const path = `/api/private/comments/files/${fileId}/entries`;
  expect((await sharingRequest(owner, path, "POST", commentPayload(thread, comment))).status).toBe(201);
  const retry = await sharingRequest(owner, path, "POST", commentPayload(thread, comment));
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual({ commentId: comment.commentId, created: false });
  expect(await env.DB.prepare("SELECT count(*) AS n FROM comments WHERE thread_id = ?").bind(thread.threadId).first())
    .toEqual({ n: 1 });
});

it("attribution rows are create-once per author even across later Comments", async () => {
  const owner = await sharingAccount();
  const fileId = await treeChild(owner, owner.rootId, "file");
  const thread = await createThread(owner, fileId);
  const first = await sealedAttribution(owner.accountId, thread, "Member First");
  const firstComment = await sealedComment(owner.accountId, thread, "One");
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/entries`, "POST",
    commentPayload(thread, firstComment, first))).status).toBe(201);
  const secondComment = await sealedComment(owner.accountId, thread, "Two");
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/entries`, "POST",
    commentPayload(thread, secondComment, await sealedAttribution(owner.accountId, thread, "Member Second")))).status).toBe(201);
  const rows = await env.DB.prepare(`SELECT id, ciphertext, content_key_envelope FROM thread_attributions
    WHERE thread_id = ?`).bind(thread.threadId).all<{ id: string; ciphertext: ArrayBuffer; content_key_envelope: ArrayBuffer }>();
  expect(rows.results).toHaveLength(1);
  expect(rows.results[0]!.id).toBe(first.attributionId);
  const attributionKey = await openSymmetric(new Uint8Array(rows.results[0]!.content_key_envelope), thread.capability, { context: {
    purpose: "attribution", vaultId: owner.accountId, objectId: first.attributionId,
    keyId: thread.capabilityId, keyEpoch: 1, revision: 1 } });
  const opened = await openSymmetric(new Uint8Array(rows.results[0]!.ciphertext), attributionKey, { context: {
    purpose: "attribution", vaultId: owner.accountId, objectId: first.attributionId,
    keyId: first.attributionId, keyEpoch: 1, revision: 1 } });
  expect(new TextDecoder().decode(opened)).toBe("Member First");
});
