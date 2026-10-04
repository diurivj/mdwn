import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import {
  changePseudonym,
  PseudonymCooldownError,
  readPseudonymState,
  runPseudonymUpdate,
  type PseudonymBrowser,
} from "../../app/account/pseudonym-client";
import { openAttribution, sealAttribution, sealCommentBody } from "../../app/comments/content";
import {
  openCommentEpochLink,
  openPublicAttribution,
  sealCommentEpochLink,
  sealPublicAttribution,
  sealPublicCommentBody,
} from "../../app/comments/public-content";
import { openAccountProfile, sealAccountProfile } from "../../app/crypto/account-profile";
import { generateVaultRootKey, sealVaultRecoveryEnvelope } from "../../app/crypto/vault";
import {
  createPublicationKeyPair, importPublicationKeyPair, newPublicationIdentifier,
} from "../../app/publications/capability";
import {
  openAuthorDeclaration, publicPresentation, sealAuthorDeclaration, sealPublicRepresentation,
} from "../../app/publications/content";
import { createCommentKeyEnvelope, type CommentKeyContext } from "../../app/sharing/comment-keys";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/tree/wire";
import {
  grant, invite, opaqueId, prepareGrantKeys, sharingAccount, sharingRequest, treeChild, type SharingAccount,
} from "./sharing-fixtures";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

type ThreadFixture = { threadId: string; epochId: string; ownerId: string; capabilityId: string;
  capability: Uint8Array<ArrayBuffer>; vaultRootKey: Uint8Array<ArrayBuffer> };

/** The Owner creates the one Private thread with a real `vault-recovery` envelope. */
async function createThread(owner: SharingAccount, fileId: string, vaultRootKey: Uint8Array<ArrayBuffer>,
  fill = 41): Promise<ThreadFixture> {
  const threadId = opaqueId(), epochId = opaqueId(), capabilityId = opaqueId();
  const capability = new Uint8Array(32).fill(fill);
  const recoveryEnvelope = await sealVaultRecoveryEnvelope(vaultRootKey,
    { scope: "owned", objectId: threadId, keyId: capabilityId, key: capability },
    { purpose: "vault-recovery", vaultId: owner.accountId, objectId: threadId, keyId: capabilityId, keyEpoch: 1, revision: 1 });
  const response = await sharingRequest(owner, `/api/private/comments/files/${fileId}`, "PUT",
    { threadId, epochId, capabilityId, recoveryEnvelope: encodeTreeBytes(recoveryEnvelope) });
  if (response.status !== 201) throw new Error(`thread create failed: ${response.status} ${await response.text()}`);
  return { threadId, epochId, ownerId: owner.accountId, capabilityId, capability, vaultRootKey };
}

async function sealedComment(ownerId: string, thread: ThreadFixture, text: string) {
  const commentId = opaqueId();
  const sealed = await sealCommentBody(thread.capability, { vaultId: ownerId, commentId,
    capabilityId: thread.capabilityId, keyEpoch: 1, revision: 1, text });
  return { commentId, ...sealed };
}

async function sealedAttribution(ownerId: string, thread: ThreadFixture, pseudonym: string, revision = 1) {
  const attributionId = opaqueId();
  return sealAttribution(thread.capability, { vaultId: ownerId, attributionId, pseudonym,
    capabilityId: thread.capabilityId, keyEpoch: 1, revision });
}

function commentPayload(thread: ThreadFixture, comment: { commentId: string; bodyCiphertext: string; contentKeyEnvelope: string },
  attribution: { attributionId: string; ciphertext: string; contentKeyEnvelope: string } | null = null) {
  return { commentId: comment.commentId, threadId: thread.threadId, capabilityId: thread.capabilityId,
    capabilityEpoch: 1, epochId: thread.epochId, bodyCiphertext: comment.bodyCiphertext,
    contentKeyEnvelope: comment.contentKeyEnvelope, attribution };
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

/** Insert the real encrypted Account profile the pseudonym job will swap. */
async function seedProfile(account: SharingAccount, pseudonym: string,
  vaultRootKey: Uint8Array<ArrayBuffer> = generateVaultRootKey()): Promise<Uint8Array<ArrayBuffer>> {
  const sealed = await sealAccountProfile(vaultRootKey, { publicPseudonym: pseudonym },
    { accountId: account.accountId, epoch: 1, revision: 1 });
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO account_profiles (account_id, ciphertext, revision, epoch, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(account.accountId, sealed.ciphertext, sealed.revision, sealed.epoch, now, now).run();
  return vaultRootKey;
}

function pseudonymBrowser(account: SharingAccount, vaultRootKey: Uint8Array<ArrayBuffer>): PseudonymBrowser {
  return { accountId: account.accountId, deviceId: account.deviceId, vaultRootKey,
    transportKeyPair: account.transport,
    request: (path, method = "POST", body) => sharingRequest(account, path, method, body) };
}

async function attributionState(authorId: string, thread: ThreadFixture): Promise<{ pseudonym: string; revision: number }> {
  const row = await env.DB.prepare(`SELECT id, revision, ciphertext, content_key_envelope, content_key_epoch
    FROM thread_attributions WHERE thread_id = ? AND author_id = ?`).bind(thread.threadId, authorId)
    .first<{ id: string; revision: number; ciphertext: ArrayBuffer; content_key_envelope: ArrayBuffer; content_key_epoch: number }>();
  if (!row) throw new Error("attribution missing");
  const pseudonym = await openAttribution(thread.capability, { vaultId: thread.ownerId, attributionId: row.id,
    revision: row.revision, capabilityId: thread.capabilityId, keyEpoch: row.content_key_epoch,
    ciphertext: encodeTreeBytes(new Uint8Array(row.ciphertext)),
    contentKeyEnvelope: encodeTreeBytes(new Uint8Array(row.content_key_envelope)) });
  return { pseudonym, revision: row.revision };
}

async function profileState(accountId: string, vaultRootKey: Uint8Array<ArrayBuffer>) {
  const row = await env.DB.prepare(`SELECT ciphertext, revision, epoch, pseudonym_changed_at FROM account_profiles
    WHERE account_id = ?`).bind(accountId).first<{ ciphertext: ArrayBuffer; revision: number; epoch: number;
      pseudonym_changed_at: number | null }>();
  if (!row) throw new Error("profile missing");
  const opened = await openAccountProfile(new Uint8Array(row.ciphertext), vaultRootKey,
    { accountId, epoch: row.epoch, revision: row.revision });
  return { pseudonym: opened.publicPseudonym, revision: row.revision, changedAt: row.pseudonym_changed_at };
}

type PublicationFixture = { publicationId: string; linkId: string; declarationId: string;
  keys: { privateKey: Uint8Array<ArrayBuffer>; publicKey: Uint8Array<ArrayBuffer> };
  epoch: { threadId: string; epochId: string; capabilityId: string;
    capability: Uint8Array<ArrayBuffer>; audience: "public" | "collaborators_only" } };

/** Publish an owner-authored, owner-credentialed Publication on a converted File. */
async function publishWithAuthor(owner: SharingAccount, fileId: string, pseudonym: string,
  vaultRootKey: Uint8Array<ArrayBuffer>): Promise<PublicationFixture> {
  const current = await (await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).json() as
    { revision: number; representationId: string };
  const keys = await createPublicationKeyPair();
  const publicationId = newPublicationIdentifier(), linkId = newPublicationIdentifier(), declarationId = newPublicationIdentifier();
  const binding = { publicationId, linkId, publicKey: keys.publicKey };
  const threadId = opaqueId(), epochId = opaqueId(), capabilityId = opaqueId();
  const capability = crypto.getRandomValues(new Uint8Array(32));
  const recoveryEnvelope = encodeTreeBytes(await sealVaultRecoveryEnvelope(vaultRootKey,
    { scope: "owned", objectId: epochId, keyId: capabilityId, key: capability },
    { purpose: "vault-recovery", vaultId: owner.accountId, objectId: epochId, keyId: capabilityId, keyEpoch: 1, revision: 1 }));
  const linkWrapper = encodeTreeBytes(await sealCommentEpochLink(keys.privateKey, keys.publicKey,
    { publicationId, linkId, epochId, capabilityId, keyEpoch: 1, capability }));
  const created = await sharingRequest(owner, `/api/private/publications/files/${fileId}`, "PUT", {
    publicationId, linkId, publicKey: encodeTreeBytes(keys.publicKey),
    expectedRevision: current.revision, expectedRepresentationId: current.representationId,
    representation: { ciphertext: encodeTreeBytes(await sealPublicRepresentation({ ...binding, revision: 1 },
      publicPresentation("# public"))) },
    author: { declarationId, ciphertext: encodeTreeBytes(await sealAuthorDeclaration(
      { ...binding, declarationId, revision: 1 }, pseudonym)) },
    comments: { threadId, epochId, capabilityId, audience: "public", recoveryEnvelope, linkWrapper },
  });
  if (created.status !== 201) throw new Error(`publish failed: ${created.status} ${await created.text()}`);
  return { publicationId, linkId, declarationId, keys,
    epoch: { threadId, epochId, capabilityId, capability, audience: "public" } };
}

/** Post an attributed comment into the Publication's public audience epoch. */
async function publicAttributedComment(owner: SharingAccount, fileId: string, publication: PublicationFixture,
  pseudonym: string) {
  const attributionId = opaqueId(), commentId = opaqueId();
  const attribution = await sealPublicAttribution(publication.epoch.capability, { publicationId: publication.publicationId,
    attributionId, pseudonym, capabilityId: publication.epoch.capabilityId, keyEpoch: 1 });
  const body = await sealPublicCommentBody(publication.epoch.capability, { publicationId: publication.publicationId,
    commentId, capabilityId: publication.epoch.capabilityId, keyEpoch: 1, revision: 1, text: "Public note" });
  const response = await sharingRequest(owner, `/api/private/comments/files/${fileId}/public/entries`, "POST", {
    commentId, threadId: publication.epoch.threadId, epochId: publication.epoch.epochId,
    capabilityId: publication.epoch.capabilityId, capabilityEpoch: 1,
    bodyCiphertext: body.bodyCiphertext, contentKeyEnvelope: body.contentKeyEnvelope, attribution });
  if (response.status !== 201) throw new Error(`public comment failed: ${response.status} ${await response.text()}`);
  return { attributionId, commentId };
}

/** Open the anonymous reader's attribution exactly as a Public reader would. */
async function publicThreadPseudonym(fixture: PublicationFixture, attributionId: string): Promise<string> {
  const response = await SELF.fetch(`https://mdwn.test/api/public/publications/${fixture.linkId}/comments`);
  expect(response.status).toBe(200);
  const body = await response.json() as { comments: { epochs: { epochId: string; capabilityId: string; capabilityEpoch: number;
    wrapper: string }[]; attributions: { id: string; epochId: string; revision: number; ciphertext: string;
      contentKeyEnvelope: string }[] } };
  const epoch = body.comments.epochs.find((candidate) => candidate.epochId === fixture.epoch.epochId);
  if (!epoch) throw new Error("public epoch missing");
  const capability = await openCommentEpochLink(fixture.keys.privateKey, fixture.keys.publicKey,
    { publicationId: fixture.publicationId, linkId: fixture.linkId, epochId: epoch.epochId,
      capabilityId: epoch.capabilityId, keyEpoch: epoch.capabilityEpoch, ciphertext: epoch.wrapper });
  const attribution = body.comments.attributions.find((candidate) => candidate.id === attributionId);
  if (!attribution) throw new Error("public attribution missing");
  return openPublicAttribution(capability, { publicationId: fixture.publicationId, attributionId,
    revision: attribution.revision, capabilityId: epoch.capabilityId, keyEpoch: epoch.capabilityEpoch,
    ciphertext: attribution.ciphertext, contentKeyEnvelope: attribution.contentKeyEnvelope });
}

async function publicAuthorPseudonym(fixture: PublicationFixture): Promise<string> {
  const response = await SELF.fetch(`https://mdwn.test/api/public/publications/${fixture.linkId}`);
  expect(response.status).toBe(200);
  const body = await response.json() as { publicKey: string;
    authors: { declarationId: string; revision: number; ciphertext: string }[] };
  const publicKey = decodeTreeBytes(body.publicKey, 65);
  const pair = await importPublicationKeyPair(fixture.keys.privateKey, publicKey);
  const author = body.authors.find((candidate) => candidate.declarationId === fixture.declarationId);
  if (!author) throw new Error("declaration missing");
  return openAuthorDeclaration(decodeTreeBytes(author.ciphertext, 4_096), pair,
    { publicationId: fixture.publicationId, linkId: fixture.linkId, publicKey,
      declarationId: author.declarationId, revision: author.revision });
}

async function pendingJobId(accountId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT id FROM crypto_jobs WHERE account_id = ? AND kind = 'pseudonym_update'
    AND state = 'pending'`).bind(accountId).first<{ id: string }>();
  if (!row) throw new Error("pending pseudonym job missing");
  return row.id;
}

it("switches a thread attribution and a Publication declaration from all-old to all-new atomically", async () => {
  const owner = await sharingAccount();
  const vaultRootKey = await seedProfile(owner, "Member Old Oak");
  const fileId = await treeChild(owner, owner.rootId, "file");
  const thread = await createThread(owner, fileId, vaultRootKey);
  const attribution = await sealedAttribution(owner.accountId, thread, "Member Old Oak");
  const comment = await sealedComment(owner.accountId, thread, "First");
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/entries`, "POST",
    commentPayload(thread, comment, attribution))).status).toBe(201);
  const publicFile = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
  const publication = await publishWithAuthor(owner, publicFile, "Member Old Oak", vaultRootKey);
  const publicComment = await publicAttributedComment(owner, publicFile, publication, "Member Old Oak");
  const browser = pseudonymBrowser(owner, vaultRootKey);

  // One bounded pass stages every context but does not commit: all-old remains.
  expect(await changePseudonym(browser, { maxSteps: 1 })).toBe(false);
  expect(await attributionState(owner.accountId, thread)).toEqual({ pseudonym: "Member Old Oak", revision: 1 });
  expect(await publicAuthorPseudonym(publication)).toBe("Member Old Oak");
  expect(await publicThreadPseudonym(publication, publicComment.attributionId)).toBe("Member Old Oak");
  expect((await profileState(owner.accountId, vaultRootKey)).pseudonym).toBe("Member Old Oak");
  // Normal work that would mint a new attribution context is blocked.
  const blockedComment = await sealedComment(owner.accountId, thread, "Blocked");
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/entries`, "POST",
    commentPayload(thread, blockedComment))).status).toBe(409);
  expect(await (await sharingRequest(owner, `/api/private/comments/files/${fileId}/entries`, "POST",
    commentPayload(thread, blockedComment))).json()).toEqual({ error: "pseudonym_update_pending" });
  const nextDeclaration = await sealAuthorDeclaration({ publicationId: publication.publicationId,
    linkId: publication.linkId, publicKey: publication.keys.publicKey, declarationId: publication.declarationId,
    revision: 2 }, "Member Blocked");
  expect((await sharingRequest(owner, `/api/private/publications/files/${publicFile}/authors/${publication.declarationId}/declaration`,
    "PUT", { publicationId: publication.publicationId, linkId: publication.linkId, revision: 2,
      ciphertext: encodeTreeBytes(nextDeclaration) })).status).toBe(409);
  // A second job cannot start; the same ID is an idempotent retry.
  expect((await sharingRequest(owner, "/api/private/pseudonym-updates", "PUT", { jobId: opaqueId(),
    profile: { ciphertext: "AQ", epoch: 1, revision: 2 } })).status).toBe(409);
  const jobId = await pendingJobId(owner.accountId);

  // An interrupted pass resumes from a fresh browser and commits everything at once.
  expect(await runPseudonymUpdate(jobId, pseudonymBrowser(owner, vaultRootKey))).toBe(true);
  const after = await attributionState(owner.accountId, thread);
  expect(after.revision).toBe(2);
  expect(after.pseudonym).not.toBe("Member Old Oak");
  expect(await publicAuthorPseudonym(publication)).toBe(after.pseudonym);
  expect(await publicThreadPseudonym(publication, publicComment.attributionId)).toBe(after.pseudonym);
  const profile = await profileState(owner.accountId, vaultRootKey);
  expect(profile.revision).toBe(2);
  expect(profile.pseudonym).toBe(after.pseudonym);
  expect(profile.changedAt).not.toBeNull();
  expect(await env.DB.prepare("SELECT count(*) AS n FROM pseudonym_update_items WHERE job_id = ?")
    .bind(jobId).first()).toEqual({ n: 0 });
  expect(await env.DB.prepare("SELECT count(*) AS n FROM pseudonym_update_profiles WHERE job_id = ?")
    .bind(jobId).first()).toEqual({ n: 0 });
  expect((await env.DB.prepare(`SELECT state FROM crypto_jobs WHERE id = ?`).bind(jobId).first())).toEqual({ state: "complete" });

  // The 30-day cooldown is enforced by the server and reported to the UI.
  const state = await readPseudonymState(browser);
  expect(state.publicPseudonym).toBe(after.pseudonym);
  expect(state.job).toBeNull();
  expect(state.nextChangeAt).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
  expect((await sharingRequest(owner, "/api/private/pseudonym-updates", "PUT", { jobId: opaqueId(),
    profile: { ciphertext: "AQ", epoch: 1, revision: 3 } })).status).toBe(409);
  await expect(changePseudonym(browser)).rejects.toBeInstanceOf(PseudonymCooldownError);
});

it("resumes a collaborator's interrupted update and re-seals through the grant envelope", async () => {
  const owner = await sharingAccount(), collaborator = await sharingAccount();
  await seedProfile(owner, "Member Owner");
  const collaboratorKey = await seedProfile(collaborator, "Member Grant Old");
  const fileId = await treeChild(owner, owner.rootId, "file");
  const thread = await createThread(owner, fileId, generateVaultRootKey());
  await grantWithThread(owner, collaborator, fileId, thread);
  const attribution = await sealedAttribution(owner.accountId, thread, "Member Grant Old", 1);
  const comment = await sealedComment(owner.accountId, thread, "Collaborator note");
  expect((await sharingRequest(collaborator, `/api/private/comments/files/${fileId}/entries`, "POST",
    commentPayload(thread, comment, attribution))).status).toBe(201);
  expect((await attributionState(collaborator.accountId, thread)).pseudonym).toBe("Member Grant Old");

  const browser = pseudonymBrowser(collaborator, collaboratorKey);
  expect(await changePseudonym(browser, { maxSteps: 1 })).toBe(false);
  expect((await attributionState(collaborator.accountId, thread)).pseudonym).toBe("Member Grant Old");
  const jobId = await pendingJobId(collaborator.accountId);
  expect(await runPseudonymUpdate(jobId, pseudonymBrowser(collaborator, collaboratorKey))).toBe(true);
  const after = await attributionState(collaborator.accountId, thread);
  expect(after.revision).toBe(2);
  expect(after.pseudonym).not.toBe("Member Grant Old");
  expect((await profileState(collaborator.accountId, collaboratorKey)).pseudonym).toBe(after.pseudonym);
  // The Owner's own attribution is untouched by another Account's update.
  expect((await env.DB.prepare("SELECT count(*) AS n FROM thread_attributions WHERE thread_id = ? AND author_id = ?")
    .bind(thread.threadId, owner.accountId).first())).toEqual({ n: 0 });
});

it("rejects malformed staging and can cancel a job without changing the pseudonym", async () => {
  const owner = await sharingAccount();
  const vaultRootKey = await seedProfile(owner, "Member Stable");
  const fileId = await treeChild(owner, owner.rootId, "file");
  const thread = await createThread(owner, fileId, vaultRootKey);
  const attribution = await sealedAttribution(owner.accountId, thread, "Member Stable");
  const comment = await sealedComment(owner.accountId, thread, "Note");
  expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/entries`, "POST",
    commentPayload(thread, comment, attribution))).status).toBe(201);

  const jobId = opaqueId();
  const sealed = await sealAccountProfile(vaultRootKey, { publicPseudonym: "Member Next" },
    { accountId: owner.accountId, epoch: 1, revision: 2 });
  expect((await sharingRequest(owner, "/api/private/pseudonym-updates", "PUT", { jobId,
    profile: { ciphertext: encodeTreeBytes(sealed.ciphertext), epoch: 1, revision: 2 } })).status).toBe(201);
  // The same request is an idempotent retry, never a second job.
  expect(await (await sharingRequest(owner, "/api/private/pseudonym-updates", "PUT", { jobId,
    profile: { ciphertext: encodeTreeBytes(sealed.ciphertext), epoch: 1, revision: 2 } })).json())
    .toEqual({ jobId, created: false });
  const next = await (await sharingRequest(owner, `/api/private/pseudonym-updates/${jobId}/next`)).json() as
    { operation: string; contexts: { kind: string; recordId: string; revision: number }[] };
  expect(next.operation).toBe("stage");
  expect(next.contexts).toHaveLength(1);
  expect(next.contexts[0]!.revision).toBe(2);
  const path = `/api/private/pseudonym-updates/${jobId}/items/${next.contexts[0]!.recordId}`;
  expect((await sharingRequest(owner, path, "PUT", { kind: "thread", revision: 2, ciphertext: "AQ",
    contentKeyEnvelope: "AQ" })).status).toBe(400);
  expect((await sharingRequest(owner, path, "PUT", { kind: "thread", revision: 3,
    ciphertext: attribution.ciphertext, contentKeyEnvelope: attribution.contentKeyEnvelope })).status).toBe(409);
  expect((await sharingRequest(owner, `/api/private/pseudonym-updates/${jobId}/step`, "PATCH",
    { operation: "commit" })).status).toBe(409);
  expect((await sharingRequest(owner, `/api/private/pseudonym-updates/${jobId}/step`, "PATCH",
    { operation: "cancel" })).status).toBe(200);
  expect((await attributionState(owner.accountId, thread)).pseudonym).toBe("Member Stable");
  expect((await profileState(owner.accountId, vaultRootKey)).pseudonym).toBe("Member Stable");
  expect(await env.DB.prepare(`SELECT count(*) AS n FROM pseudonym_update_items i
    JOIN crypto_jobs j ON j.id = i.job_id WHERE j.account_id = ?`).bind(owner.accountId).first()).toEqual({ n: 0 });
  // Cancelling consumes no cooldown, so a fresh change can start again.
  expect((await sharingRequest(owner, "/api/private/pseudonym-updates", "PUT", { jobId: opaqueId(),
    profile: { ciphertext: encodeTreeBytes(sealed.ciphertext), epoch: 1, revision: 2 } })).status).toBe(201);
});

it("blocks only the changing Account's new attributions, not a Collaborator's", async () => {
  const owner = await sharingAccount(), collaborator = await sharingAccount();
  const ownerKey = await seedProfile(owner, "Member Busy");
  await seedProfile(collaborator, "Member Collaborator");
  const ownerFile = await treeChild(owner, owner.rootId, "file");
  const ownerThread = await createThread(owner, ownerFile, ownerKey);
  const first = await sealedAttribution(owner.accountId, ownerThread, "Member Busy");
  const ownerComment = await sealedComment(owner.accountId, ownerThread, "Owner");
  expect((await sharingRequest(owner, `/api/private/comments/files/${ownerFile}/entries`, "POST",
    commentPayload(ownerThread, ownerComment, first))).status).toBe(201);
  const sharedFile = await treeChild(owner, owner.rootId, "file");
  const sharedThread = await createThread(owner, sharedFile, generateVaultRootKey());
  await grantWithThread(owner, collaborator, sharedFile, sharedThread);
  expect(await changePseudonym(pseudonymBrowser(owner, ownerKey), { maxSteps: 1 })).toBe(false);
  // The Owner's pending update pauses only the Owner's new attribution contexts.
  const blocked = await sealedComment(owner.accountId, ownerThread, "Blocked");
  expect((await sharingRequest(owner, `/api/private/comments/files/${ownerFile}/entries`, "POST",
    commentPayload(ownerThread, blocked))).status).toBe(409);
  const allowed = await sealedAttribution(owner.accountId, sharedThread, "Member Collaborator");
  const collaboratorComment = await sealedComment(owner.accountId, sharedThread, "Collaborator");
  expect((await sharingRequest(collaborator, `/api/private/comments/files/${sharedFile}/entries`, "POST",
    commentPayload(sharedThread, collaboratorComment, allowed))).status).toBe(201);
  const jobId = await pendingJobId(owner.accountId);
  expect(await runPseudonymUpdate(jobId, pseudonymBrowser(owner, ownerKey))).toBe(true);
  expect((await attributionState(owner.accountId, ownerThread)).revision).toBe(2);
  expect((await attributionState(collaborator.accountId, sharedThread)).pseudonym).toBe("Member Collaborator");
});
