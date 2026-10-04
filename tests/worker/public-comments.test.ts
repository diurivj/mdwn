import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { openPublicCommentBody, openCommentEpochLink, sealCommentEpochLink, sealPublicAttribution,
  sealPublicCommentBody } from "../../app/comments/public-content";
import { sealAttribution as sealPrivateAttribution, sealCommentBody as sealPrivateCommentBody } from "../../app/comments/content";
import { sealVaultRecoveryEnvelope, generateVaultRootKey } from "../../app/crypto/vault";
import { createPublicationKeyPair, newPublicationIdentifier } from "../../app/publications/capability";
import { createRecoveryMaterial, sealDeviceEnrollmentEnvelope } from "../../app/crypto/vault";
import { resumeRotation, type RotationBrowser } from "../../app/sharing/rotation-client";
import { openCommentKeyEnvelope, createCommentKeyEnvelope, type CommentKeyContext } from "../../app/sharing/comment-keys";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/tree/wire";
import { formatPublicationFragment } from "../../app/publications/capability";
import { invite, opaqueId, prepareGrantKeys, sharingAccount, sharingRequest, treeChild, type SharingAccount } from "./sharing-fixtures";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
// Abuse counters are keyed by the fixture edge address and would accumulate
// across the scenarios in this file; each scenario starts from a clean window.
beforeEach(async () => { await env.DB.prepare("DELETE FROM rate_limit_counters").run(); });

type FileView = { revision: number; representationId: string };

async function fileView(actor: SharingAccount, fileId: string): Promise<FileView> {
  const response = await sharingRequest(actor, `/api/private/tree/files/${fileId}`);
  if (!response.ok) throw new Error(`file read failed: ${response.status}`);
  return response.json() as Promise<FileView>;
}

type Epoch = { threadId: string; epochId: string; capabilityId: string; capability: Uint8Array<ArrayBuffer>;
  audience: "public" | "collaborators_only"; vaultRootKey: Uint8Array };

type Publication = { publicationId: string; linkId: string; linkKey: Awaited<ReturnType<typeof createPublicationKeyPair>>;
  fragment: string; epoch: Epoch };

/** The Owner's browser half of publishing with its first audience epoch. */
async function publish(owner: SharingAccount, fileId: string, audience: "public" | "collaborators_only" = "public",
  recovery = generateVaultRootKey()): Promise<Publication> {
  const current = await fileView(owner, fileId);
  const linkKey = await createPublicationKeyPair();
  const publicationId = newPublicationIdentifier(), linkId = newPublicationIdentifier();
  const built = await firstEpoch(owner, publicationId, linkId, linkKey, audience, recovery);
  const representation = await import("../../app/publications/content").then(({ publicPresentation, sealPublicRepresentation }) =>
    sealPublicRepresentation({ publicationId, linkId, publicKey: linkKey.publicKey, revision: 1 }, publicPresentation("# Public body")));
  const response = await sharingRequest(owner, `/api/private/publications/files/${fileId}`, "PUT", {
    publicationId, linkId, publicKey: encodeTreeBytes(linkKey.publicKey),
    expectedRevision: current.revision, expectedRepresentationId: current.representationId,
    representation: { ciphertext: encodeTreeBytes(representation) }, author: null,
    comments: { threadId: built.threadId, epochId: built.epochId, capabilityId: built.capabilityId,
      audience, recoveryEnvelope: encodeTreeBytes(built.recoveryEnvelope),
      linkWrapper: built.linkWrapper ? encodeTreeBytes(built.linkWrapper) : null },
  });
  if (response.status !== 201) throw new Error(`publish failed: ${response.status} ${await response.text()}`);
  return { publicationId, linkId, linkKey, fragment: formatPublicationFragment(linkKey.privateKey),
    epoch: { threadId: built.threadId, epochId: built.epochId, capabilityId: built.capabilityId, capability: built.capability,
      audience, vaultRootKey: recovery } };
}

async function firstEpoch(owner: SharingAccount, publicationId: string, linkId: string,
  linkKey: Awaited<ReturnType<typeof createPublicationKeyPair>>, audience: "public" | "collaborators_only",
  vaultRootKey: Uint8Array, threadId = opaqueId()) {
  const epochId = opaqueId(), capabilityId = opaqueId();
  const capability = crypto.getRandomValues(new Uint8Array(32));
  const recoveryEnvelope = await sealVaultRecoveryEnvelope(vaultRootKey,
    { scope: "owned", objectId: epochId, keyId: capabilityId, key: capability },
    { purpose: "vault-recovery", vaultId: owner.accountId, objectId: epochId, keyId: capabilityId, keyEpoch: 1, revision: 1 });
  const linkWrapper = audience === "public" ? await sealCommentEpochLink(linkKey.privateKey, linkKey.publicKey,
    { publicationId, linkId, epochId, capabilityId, keyEpoch: 1, capability }) : null;
  return { threadId, epochId, capabilityId, capability, recoveryEnvelope, linkWrapper };
}

function sealedComment(publication: Publication, text: string, revision = 1, epoch = publication.epoch) {
  const commentId = opaqueId();
  return sealPublicCommentBody(epoch.capability, { publicationId: publication.publicationId, commentId,
    capabilityId: epoch.capabilityId, keyEpoch: 1, revision, text }).then((sealed) => ({ commentId, ...sealed }));
}

function sealedAttribution(publication: Publication, pseudonym: string) {
  const attributionId = opaqueId();
  return sealPublicAttribution(publication.epoch.capability, { publicationId: publication.publicationId, attributionId,
    pseudonym, capabilityId: publication.epoch.capabilityId, keyEpoch: 1 });
}

function payload(publication: Publication, comment: { commentId: string; bodyCiphertext: string; contentKeyEnvelope: string },
  attribution: { attributionId: string; ciphertext: string; contentKeyEnvelope: string } | null = null) {
  return { commentId: comment.commentId, threadId: publication.epoch.threadId, epochId: publication.epoch.epochId,
    capabilityId: publication.epoch.capabilityId, capabilityEpoch: 1,
    bodyCiphertext: comment.bodyCiphertext, contentKeyEnvelope: comment.contentKeyEnvelope, attribution };
}

type AnonymousComments = { audience: string; threadId: string | null;
  epochs: { epochId: string; capabilityId: string; capabilityEpoch: number; wrapper: string }[];
  comments: { id: string; epochId: string; authorId: string; sequence: number; revision: number;
    bodyCiphertext: string; contentKeyEnvelope: string; contentKeyEpoch: number }[];
  attributions: { id: string; authorId: string; epochId: string; ciphertext: string; contentKeyEnvelope: string }[];
  nextCursor: number | null };

async function anonymous(linkId: string): Promise<AnonymousComments> {
  const response = await SELF.fetch(`https://mdwn.test/api/public/publications/${linkId}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { comments: AnonymousComments }).comments;
}

type ThreadBody = { thread: null | { threadId: string; ownerId: string; publicationId: string; currentEpochId: string;
  audience: string; canComment: boolean; canDeleteAny: boolean; actorAccountId: string;
  epochs: { epochId: string; audience: string; state: string; capabilityId: string; capabilityEpoch: number;
    envelope: Parameters<typeof openCommentKeyEnvelope>[0] }[] };
  canCreateThread?: boolean;
  comments: { id: string; epochId: string; authorId: string; sequence: number; revision: number; bodyCiphertext: string;
    contentKeyEnvelope: string; contentKeyEpoch: number }[];
  attributions: { id: string; authorId: string; epochId: string; revision: number; ciphertext: string;
    contentKeyEnvelope: string; contentKeyEpoch: number }[];
  nextCursor: number | null };

async function readThread(account: SharingAccount, fileId: string, cursor?: number) {
  const response = await sharingRequest(account, `/api/private/comments/files/${fileId}/public${cursor ? `?cursor=${cursor}` : ""}`);
  return { response, body: response.status === 200 ? await response.json() as ThreadBody : null };
}

/** Deliver one epoch capability to an accepted Grant's active devices. */
async function deliverEpoch(owner: SharingAccount, grantId: string,
  epoch: Pick<Epoch, "epochId" | "capabilityId" | "capability">) {
  const path = `/api/private/grants/${grantId}/comment-keys/${epoch.epochId}`;
  const targets = await (await sharingRequest(owner, path)).json() as CommentKeyContext & {
    devices: { deviceId: string; transportPublicKey: string }[] };
  const envelopes = await Promise.all(targets.devices.map(async (device) => createCommentKeyEnvelope(epoch.capability,
    await crypto.subtle.importKey("raw", decodeTreeBytes(device.transportPublicKey, 65),
      { name: "ECDH", namedCurve: "P-256" }, true, []), owner.assertion.privateKey,
    { ...targets, deviceId: device.deviceId, signerDeviceId: owner.deviceId })));
  const uploaded = await sharingRequest(owner, path, "PUT", { capabilityId: targets.capabilityId,
    capabilityEpoch: targets.capabilityEpoch, ownerRegistryEpoch: targets.ownerRegistryEpoch,
    recipientRegistryEpoch: targets.recipientRegistryEpoch, envelopes });
  if (!uploaded.ok) throw new Error(`epoch delivery failed: ${uploaded.status}`);
}

/** Deliver one epoch capability to the pending Share's devices, then accept. */
async function grantWithEpoch(owner: SharingAccount, recipient: SharingAccount, targetId: string,
  publication: Publication, epoch = publication.epoch, permission: "read_only" | "read_write" = "read_only") {
  const share = await invite(owner, recipient, targetId, permission);
  await prepareGrantKeys(owner, share.shareId);
  const path = `/api/private/shares/${share.shareId}/comment-keys/${epoch.epochId}`;
  const targets = await (await sharingRequest(owner, path)).json() as CommentKeyContext & {
    devices: { deviceId: string; transportPublicKey: string }[] };
  const envelopes = await Promise.all(targets.devices.map(async (device) => createCommentKeyEnvelope(epoch.capability,
    await crypto.subtle.importKey("raw", decodeTreeBytes(device.transportPublicKey, 65),
      { name: "ECDH", namedCurve: "P-256" }, true, []), owner.assertion.privateKey,
    { ...targets, deviceId: device.deviceId, signerDeviceId: owner.deviceId })));
  const uploaded = await sharingRequest(owner, path, "PUT", { capabilityId: targets.capabilityId,
    capabilityEpoch: targets.capabilityEpoch, ownerRegistryEpoch: targets.ownerRegistryEpoch,
    recipientRegistryEpoch: targets.recipientRegistryEpoch, envelopes });
  if (!uploaded.ok) throw new Error(`comment delivery failed: ${uploaded.status}`);
  const accepted = await sharingRequest(recipient, `/api/private/shares/${share.shareId}/accept`, "POST", {});
  if (accepted.status !== 201) throw new Error(`accept failed: ${accepted.status}`);
  return accepted.json() as Promise<{ grantId: string }>;
}

it("creates one Public thread whose first epoch is public by default and readable anonymously", async () => {
  const owner = await sharingAccount();
  const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
  const publication = await publish(owner, fileId);
  const view = await anonymous(publication.linkId);
  expect(view.audience).toBe("public");
  expect(view.threadId).toBe(publication.epoch.threadId);
  expect(view.epochs).toHaveLength(1);
  expect(view.epochs[0]).toMatchObject({ epochId: publication.epoch.epochId,
    capabilityId: publication.epoch.capabilityId, capabilityEpoch: 1 });
  // A reader holding only the fragment opens the link wrapper and the Comment.
  const capability = await openCommentEpochLink(publication.linkKey.privateKey, publication.linkKey.publicKey, {
    publicationId: publication.publicationId, linkId: publication.linkId, epochId: publication.epoch.epochId,
    capabilityId: publication.epoch.capabilityId, keyEpoch: 1, ciphertext: view.epochs[0]!.wrapper });
  expect(capability).toEqual(publication.epoch.capability);
  const comment = await sealedComment(publication, "Anonymous can read this");
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/public/entries`, "POST",
    payload(publication, comment, await sealedAttribution(publication, "Member Public")))).status).toBe(201);
  const readable = await anonymous(publication.linkId);
  expect(readable.comments.map((entry) => entry.id)).toEqual([comment.commentId]);
  expect(await openPublicCommentBody(capability, { publicationId: publication.publicationId,
    commentId: comment.commentId, revision: 1, capabilityId: publication.epoch.capabilityId, keyEpoch: 1,
    bodyCiphertext: readable.comments[0]!.bodyCiphertext, contentKeyEnvelope: readable.comments[0]!.contentKeyEnvelope }))
    .toBe("Anonymous can read this");
  expect(readable.attributions).toHaveLength(1);
  const thread = await readThread(owner, fileId);
  expect(thread.response.status).toBe(200);
  expect(thread.body!.thread).toMatchObject({ threadId: publication.epoch.threadId, audience: "public",
    currentEpochId: publication.epoch.epochId, canDeleteAny: true });
  expect(thread.body!.comments).toHaveLength(1);
});

it("lets a signed-in link visitor post but not an unprovisioned Session", async () => {
  const owner = await sharingAccount(), visitor = await sharingAccount();
  const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
  const publication = await publish(owner, fileId);
  const visitorComment = await sealedComment(publication, "Visitor comment");
  const response = await sharingRequest(visitor, `/api/private/comments/links/${publication.linkId}/entries`, "POST",
    payload(publication, visitorComment, await sealedAttribution(publication, "Member Visitor")));
  expect(response.status).toBe(201);
  const view = await anonymous(publication.linkId);
  expect(view.comments.map((entry) => entry.id)).toEqual([visitorComment.commentId]);
  expect(view.attributions[0]!.authorId).toBe(visitor.accountId);
  // The visitor may edit and delete only its own Comment.
  const edit = await sealPublicCommentBody(publication.epoch.capability, { publicationId: publication.publicationId,
    commentId: visitorComment.commentId, capabilityId: publication.epoch.capabilityId, keyEpoch: 1, revision: 2, text: "Edited" });
  expect((await sharingRequest(visitor, `/api/private/comments/links/${publication.linkId}/entries/${visitorComment.commentId}`,
    "PATCH", { threadId: publication.epoch.threadId, capabilityId: publication.epoch.capabilityId, capabilityEpoch: 1,
      epochId: publication.epoch.epochId, expectedRevision: 1, bodyCiphertext: edit.bodyCiphertext,
      contentKeyEnvelope: edit.contentKeyEnvelope })).status).toBe(200);
  // A device-bound Session is required; no proof is the ordinary denial.
  const naked = await SELF.fetch(`https://mdwn.test/api/private/comments/links/${publication.linkId}/entries`, {
    method: "POST", headers: { origin: "https://mdwn.test", "content-type": "application/json" },
    body: JSON.stringify(payload(publication, await sealedComment(publication, "No device"))) });
  expect(naked.status).toBe(403);
});

it("never serves a Collaborators-only epoch or retained history anonymously, and keeps authorized history signed in", async () => {
  const owner = await sharingAccount(), collaborator = await sharingAccount(), stranger = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file", owner.accountId, true);
  const publication = await publish(owner, fileId);
  const grantRecord = await grantWithEpoch(owner, collaborator, directoryId, publication);
  const publicComment = await sealedComment(publication, "Public history");
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/public/entries`, "POST",
    payload(publication, publicComment))).status).toBe(201);
  // Switch to collaborators-only: a fresh device-enveloped epoch, no wrapper.
  const nextEpoch = await firstEpoch(owner, publication.publicationId, publication.linkId, publication.linkKey,
    "collaborators_only", generateVaultRootKey(), publication.epoch.threadId);
  const change = await sharingRequest(owner, `/api/private/comments/files/${fileId}/public`, "PUT", {
    publicationId: publication.publicationId, expectedEpochId: publication.epoch.epochId,
    epoch: { threadId: nextEpoch.threadId, epochId: nextEpoch.epochId, capabilityId: nextEpoch.capabilityId,
      audience: "collaborators_only", recoveryEnvelope: encodeTreeBytes(nextEpoch.recoveryEnvelope), linkWrapper: null },
  });
  expect(change.status).toBe(200);
  const denied = await anonymous(publication.linkId);
  expect(denied.audience).toBe("collaborators_only");
  expect(denied.epochs).toEqual([]);
  expect(denied.comments).toEqual([]);
  expect(denied.threadId).toBe(publication.epoch.threadId);
  // The signed-in stranger holds no File-read path: the link route refuses it.
  expect((await sharingRequest(stranger, `/api/private/comments/links/${publication.linkId}/entries`, "POST",
    payload({ ...publication, epoch: { ...publication.epoch, threadId: nextEpoch.threadId, epochId: nextEpoch.epochId,
      capabilityId: nextEpoch.capabilityId, capability: nextEpoch.capability } }, await sealedComment(publication, "Nope")))).status).toBe(404);
  expect((await readThread(stranger, fileId)).response.status).toBe(404);
  // The eligible collaborator still reads retained public history and the new
  // Collaborators-only epoch through its device envelope, never a fragment.
  await deliverEpoch(owner, grantRecord.grantId, nextEpoch);
  const collaboratorThread = await readThread(collaborator, fileId);
  expect(collaboratorThread.response.status).toBe(200);
  expect(collaboratorThread.body!.thread!.epochs.map((epoch) => epoch.epochId))
    .toEqual([publication.epoch.epochId, nextEpoch.epochId]);
  expect(collaboratorThread.body!.comments.map((entry) => entry.id)).toEqual([publicComment.commentId]);
  const envelope = collaboratorThread.body!.thread!.epochs[0]!.envelope as unknown as Parameters<typeof openCommentKeyEnvelope>[0];
  expect(await openCommentKeyEnvelope({ ...envelope, recipient: collaborator.transport })).toEqual(publication.epoch.capability);
  // Posting through the File route targets the current Collaborators-only epoch.
  const collaboratorCommentId = opaqueId();
  const privateComment = await sealPublicCommentBody(nextEpoch.capability, { publicationId: publication.publicationId,
    commentId: collaboratorCommentId, capabilityId: nextEpoch.capabilityId, keyEpoch: 1, revision: 1, text: "Collaborators only" });
  const createBody = { commentId: collaboratorCommentId, threadId: nextEpoch.threadId, epochId: nextEpoch.epochId,
    capabilityId: nextEpoch.capabilityId, capabilityEpoch: 1, bodyCiphertext: privateComment.bodyCiphertext,
    contentKeyEnvelope: privateComment.contentKeyEnvelope, attribution: null };
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/public/entries`, "POST", createBody)).status).toBe(201);
  const after = await anonymous(publication.linkId);
  expect(after.comments).toEqual([]);
  expect(JSON.stringify(after)).not.toContain(privateComment.bodyCiphertext);
});

it("starts a fresh public epoch on collaborators_only -> public and never leaks collaborators-only history", async () => {
  const owner = await sharingAccount();
  const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
  const publication = await publish(owner, fileId, "collaborators_only");
  const secret = await sealedComment(publication, "Collaborators only secret");
  // The Owner posts to the collaborators-only epoch through the File route.
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/public/entries`, "POST",
    payload(publication, secret))).status).toBe(201);
  expect((await anonymous(publication.linkId)).comments).toEqual([]);
  const nextEpoch = await firstEpoch(owner, publication.publicationId, publication.linkId, publication.linkKey,
    "public", generateVaultRootKey(), publication.epoch.threadId);
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/public`, "PUT", {
    publicationId: publication.publicationId, expectedEpochId: publication.epoch.epochId,
    epoch: { threadId: nextEpoch.threadId, epochId: nextEpoch.epochId, capabilityId: nextEpoch.capabilityId,
      audience: "public", recoveryEnvelope: encodeTreeBytes(nextEpoch.recoveryEnvelope),
      linkWrapper: encodeTreeBytes(nextEpoch.linkWrapper!) },
  })).status).toBe(200);
  const view = await anonymous(publication.linkId);
  expect(view.audience).toBe("public");
  expect(view.epochs.map((epoch) => epoch.epochId)).toEqual([nextEpoch.epochId]);
  expect(view.comments).toEqual([]);
  expect(JSON.stringify(view)).not.toContain(secret.bodyCiphertext);
  const fresh = await sealedComment({ ...publication, epoch: { ...publication.epoch, threadId: nextEpoch.threadId,
    epochId: nextEpoch.epochId, capabilityId: nextEpoch.capabilityId, capability: nextEpoch.capability } }, "New public");
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/public/entries`, "POST",
    { ...payload(publication, fresh), threadId: nextEpoch.threadId, epochId: nextEpoch.epochId,
      capabilityId: nextEpoch.capabilityId })).status).toBe(201);
  const after = await anonymous(publication.linkId);
  expect(after.comments.map((entry) => entry.id)).toEqual([fresh.commentId]);
});

it("keeps the Private thread absent from every Public response and enforces author deletion rules", async () => {
  const owner = await sharingAccount(), collaborator = await sharingAccount();
  const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
  const publication = await publish(owner, fileId);
  await grantWithEpoch(owner, collaborator, fileId, publication);
  // A real Private thread with a Comment, seeded after the Grant so acceptance
  // does not wait for Private coverage this test does not need.
  const privateThreadId = opaqueId(), privateEpochId = opaqueId(), privateCapabilityId = opaqueId();
  const privateCapability = crypto.getRandomValues(new Uint8Array(32));
  const privateRecovery = await sealVaultRecoveryEnvelope(generateVaultRootKey(),
    { scope: "owned", objectId: privateThreadId, keyId: privateCapabilityId, key: privateCapability },
    { purpose: "vault-recovery", vaultId: owner.accountId, objectId: privateThreadId, keyId: privateCapabilityId,
      keyEpoch: 1, revision: 1 });
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}`, "PUT",
    { threadId: privateThreadId, epochId: privateEpochId, capabilityId: privateCapabilityId,
      recoveryEnvelope: encodeTreeBytes(privateRecovery) })).status).toBe(201);
  const privateCommentId = opaqueId();
  const privateBody = await sealPrivateCommentBody(privateCapability, { vaultId: owner.accountId, commentId: privateCommentId,
    capabilityId: privateCapabilityId, keyEpoch: 1, revision: 1, text: "Private secret" });
  const privateAttribution = await sealPrivateAttribution(privateCapability, { vaultId: owner.accountId,
    attributionId: opaqueId(), pseudonym: "Member Private", capabilityId: privateCapabilityId, keyEpoch: 1 });
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/entries`, "POST", {
    commentId: privateCommentId, threadId: privateThreadId, capabilityId: privateCapabilityId, capabilityEpoch: 1,
    epochId: privateEpochId, bodyCiphertext: privateBody.bodyCiphertext, contentKeyEnvelope: privateBody.contentKeyEnvelope,
    attribution: { attributionId: privateAttribution.attributionId, ciphertext: privateAttribution.ciphertext,
      contentKeyEnvelope: privateAttribution.contentKeyEnvelope } })).status).toBe(201);

  const ownerComment = await sealedComment(publication, "Owner public");
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/public/entries`, "POST",
    payload(publication, ownerComment, await sealedAttribution(publication, "Member Owner")))).status).toBe(201);
  const collaboratorComment = await sealedComment(publication, "Collaborator public");
  expect((await sharingRequest(collaborator, `/api/private/comments/files/${fileId}/public/entries`, "POST",
    payload(publication, collaboratorComment, await sealedAttribution(publication, "Member Collaborator")))).status).toBe(201);
  const view = await anonymous(publication.linkId);
  const text = JSON.stringify(view);
  for (const forbidden of [privateThreadId, privateEpochId, privateCapabilityId, privateCommentId,
    privateBody.bodyCiphertext, privateAttribution.ciphertext]) expect(text).not.toContain(forbidden);
  expect(view.comments.map((entry) => entry.id)).toEqual([ownerComment.commentId, collaboratorComment.commentId]);

  // Author identity is checked for edit; the Owner may hard-delete any Comment.
  const edit = (actor: SharingAccount, target: { commentId: string; revision: number }, text: string) =>
    sealPublicCommentBody(publication.epoch.capability, { publicationId: publication.publicationId, commentId: target.commentId,
      capabilityId: publication.epoch.capabilityId, keyEpoch: 1, revision: target.revision + 1, text })
      .then((sealed) => sharingRequest(actor, `/api/private/comments/files/${fileId}/public/entries/${target.commentId}`, "PATCH", {
        threadId: publication.epoch.threadId, capabilityId: publication.epoch.capabilityId, capabilityEpoch: 1,
        epochId: publication.epoch.epochId, expectedRevision: target.revision,
        bodyCiphertext: sealed.bodyCiphertext, contentKeyEnvelope: sealed.contentKeyEnvelope }));
  expect((await edit(collaborator, { commentId: collaboratorComment.commentId, revision: 1 }, "Edited by author")).status).toBe(200);
  expect((await edit(collaborator, { commentId: ownerComment.commentId, revision: 1 }, "Hijack")).status).toBe(403);
  expect((await edit(owner, { commentId: collaboratorComment.commentId, revision: 2 }, "Owner rewrite")).status).toBe(403);
  const remove = (actor: SharingAccount, commentId: string, revision: number) => sharingRequest(actor,
    `/api/private/comments/files/${fileId}/public/entries/${commentId}`, "DELETE",
    { threadId: publication.epoch.threadId, capabilityId: publication.epoch.capabilityId, capabilityEpoch: 1,
      epochId: publication.epoch.epochId, expectedRevision: revision });
  expect((await remove(collaborator, ownerComment.commentId, 1)).status).toBe(403);
  expect((await remove(owner, collaboratorComment.commentId, 2)).status).toBe(200);
  expect((await anonymous(publication.linkId)).comments.map((entry) => entry.id)).toEqual([ownerComment.commentId]);
});

/** The Owner's browser half of a rotation, matching production bootstrap material. */
async function rotationBrowser(owner: SharingAccount, vaultRootKey: Uint8Array): Promise<RotationBrowser> {
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
    env.DB.prepare("INSERT INTO account_profiles (account_id, ciphertext, revision, epoch, created_at, updated_at) VALUES (?, X'01', 1, 1, 1, 1)")
      .bind(owner.accountId),
  ]);
  return { accountId: owner.accountId, deviceId: owner.deviceId, vaultRootKey, assertionKey: owner.assertion.privateKey,
    request: (path, method = "POST", body) => sharingRequest(owner, path, method, body) };
}

it("rotates the current Collaborators-only epoch on revocation before remaining devices post", async () => {
  const owner = await sharingAccount(), removed = await sharingAccount(), remaining = await sharingAccount();
  const vaultRootKey = generateVaultRootKey();
  const browser = await rotationBrowser(owner, vaultRootKey);
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file", owner.accountId, true);
  const publication = await publish(owner, fileId, "public", vaultRootKey);
  const removedGrant = await grantWithEpoch(owner, removed, directoryId, publication);
  const remainingGrant = await grantWithEpoch(owner, remaining, directoryId, publication);
  const nextEpoch = await firstEpoch(owner, publication.publicationId, publication.linkId, publication.linkKey,
    "collaborators_only", vaultRootKey, publication.epoch.threadId);
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/public`, "PUT", {
    publicationId: publication.publicationId, expectedEpochId: publication.epoch.epochId,
    epoch: { threadId: nextEpoch.threadId, epochId: nextEpoch.epochId, capabilityId: nextEpoch.capabilityId,
      audience: "collaborators_only", recoveryEnvelope: encodeTreeBytes(nextEpoch.recoveryEnvelope), linkWrapper: null },
  })).status).toBe(200);
  await deliverEpoch(owner, removedGrant.grantId, nextEpoch);
  await deliverEpoch(owner, remainingGrant.grantId, nextEpoch);
  const secret = await sealedComment(publication, "Rotate this", 1,
    { ...publication.epoch, threadId: nextEpoch.threadId, epochId: nextEpoch.epochId, capabilityId: nextEpoch.capabilityId,
      capability: nextEpoch.capability });
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/public/entries`, "POST",
    { commentId: secret.commentId, threadId: nextEpoch.threadId, epochId: nextEpoch.epochId,
      capabilityId: nextEpoch.capabilityId, capabilityEpoch: 1, bodyCiphertext: secret.bodyCiphertext,
      contentKeyEnvelope: secret.contentKeyEnvelope, attribution: null })).status).toBe(201);

  const revoked = await sharingRequest(owner, `/api/private/grants/${removedGrant.grantId}`, "DELETE", { expectedRevision: 1 });
  expect(revoked.status).toBe(200);
  const { rotation } = await revoked.json() as { rotation: { jobId: string } };
  // Authorization disappears immediately, before any browser work, and the
  // remaining device cannot post until the replacement key is installed.
  expect((await readThread(removed, fileId)).response.status).toBe(404);
  const sealedPost = await sealedComment(publication, "During rotation", 1,
    { ...publication.epoch, threadId: nextEpoch.threadId, epochId: nextEpoch.epochId,
      capabilityId: nextEpoch.capabilityId, capability: nextEpoch.capability });
  expect((await sharingRequest(remaining, `/api/private/comments/files/${fileId}/public/entries`, "POST",
    { commentId: sealedPost.commentId, threadId: nextEpoch.threadId, epochId: nextEpoch.epochId,
      capabilityId: nextEpoch.capabilityId, capabilityEpoch: 1, bodyCiphertext: sealedPost.bodyCiphertext,
      contentKeyEnvelope: sealedPost.contentKeyEnvelope, attribution: null })).status).toBe(409);
  expect(await resumeRotation(rotation.jobId, browser, { maxSteps: 100 })).toBe(true);

  // The Collaborators-only epoch advanced in place; retained public history
  // kept its key; the remaining device opens the rewritten wrapper and text.
  expect(await env.DB.prepare("SELECT key_epoch FROM comment_thread_epochs WHERE id = ?").bind(nextEpoch.epochId).first())
    .toEqual({ key_epoch: 2 });
  const thread = await readThread(remaining, fileId);
  expect(thread.response.status).toBe(200);
  const epochEnvelope = thread.body!.thread!.epochs.find((epoch) => epoch.epochId === nextEpoch.epochId)!.envelope;
  const capability = await openCommentKeyEnvelope({ ...epochEnvelope, recipient: remaining.transport });
  const displayed = thread.body!.comments.find((comment) => comment.id === secret.commentId)!;
  expect(await openPublicCommentBody(capability, { publicationId: publication.publicationId,
    commentId: secret.commentId, revision: 1, capabilityId: nextEpoch.capabilityId, keyEpoch: 2,
    bodyCiphertext: displayed.bodyCiphertext, contentKeyEnvelope: displayed.contentKeyEnvelope })).toBe("Rotate this");
  // The revoked device and anonymous readers still receive no ciphertext.
  expect((await readThread(removed, fileId)).response.status).toBe(404);
  expect((await anonymous(publication.linkId)).comments).toEqual([]);
});
