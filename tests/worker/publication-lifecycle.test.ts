import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { openCommentEpochLink, openPublicCommentBody, sealCommentEpochLink, sealPublicCommentBody } from "../../app/shared/comments/public-content";
import { sealVaultRecoveryEnvelope, generateVaultRootKey } from "../../app/shared/crypto/vault";
import { createPublicationKeyPair, formatPublicationFragment, importPublicationKeyPair, isPublicationIdentifier,
  newPublicationIdentifier } from "../../app/shared/publications/capability";
import { openPublicRepresentation, publicPresentation, sealAuthorDeclaration, sealPublicRepresentation } from "../../app/shared/publications/content";
import { createCommentKeyEnvelope, type CommentKeyContext } from "../../app/shared/sharing/comment-keys";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/shared/tree/wire";
import { deletePayload, grant, invite, opaqueId, prepareGrantKeys, sharingAccount, sharingRequest, treeChild, type SharingAccount } from "./sharing-fixtures";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
// Participation counters are shared across a fixture account; start clean.
beforeEach(async () => { await env.DB.prepare("DELETE FROM rate_limit_counters").run(); });

type FileView = { revision: number; representationId: string;
  publication?: { publicationId: string; linkId: string; publicKey: string; revision?: number;
    declaration: { declarationId: string; revision: number; current: boolean } | null } };

async function fileView(actor: SharingAccount, fileId: string): Promise<FileView> {
  const response = await sharingRequest(actor, `/api/private/tree/files/${fileId}`);
  if (!response.ok) throw new Error(`file read failed: ${response.status}`);
  return response.json() as Promise<FileView>;
}

async function panelState(actor: SharingAccount, fileId: string) {
  const response = await sharingRequest(actor, `/api/private/publications/files/${fileId}`);
  if (!response.ok) throw new Error(`panel read failed: ${response.status}`);
  return response.json() as Promise<{
    isOwner: boolean; commentCount: number;
    publication: null | { publicationId: string; state: string; linkId?: string; createdAt: number;
      authors: { declarationId: string; ordinal: number; self: boolean; declared: boolean }[] };
    comments: null | { threadId: string; epochId: string; audience: string };
    teardown: null | { commentTotal: number; commentsRemaining: number };
  }>;
}

type Epoch = { threadId: string; epochId: string; capabilityId: string; capability: Uint8Array<ArrayBuffer>;
  audience: "public" | "collaborators_only" };

type Publication = { publicationId: string; linkId: string; linkKey: Awaited<ReturnType<typeof createPublicationKeyPair>>;
  fragment: string; declarationId: string | null; epochs: Epoch[] };

/** A real first audience epoch with the Owner recovery envelope and link wrapper. */
async function audienceEpoch(publicationId: string, linkId: string,
  linkKey: Awaited<ReturnType<typeof createPublicationKeyPair>>, owner: SharingAccount,
  audience: "public" | "collaborators_only", threadId: string, vaultRootKey = generateVaultRootKey()) {
  const epochId = opaqueId(), capabilityId = opaqueId();
  const capability = crypto.getRandomValues(new Uint8Array(32));
  const recoveryEnvelope = await sealVaultRecoveryEnvelope(vaultRootKey,
    { scope: "owned", objectId: epochId, keyId: capabilityId, key: capability },
    { purpose: "vault-recovery", vaultId: owner.accountId, objectId: epochId, keyId: capabilityId, keyEpoch: 1, revision: 1 });
  const linkWrapper = audience === "public" ? await sealCommentEpochLink(linkKey.privateKey, linkKey.publicKey,
    { publicationId, linkId, epochId, capabilityId, keyEpoch: 1, capability }) : null;
  return { threadId, epochId, capabilityId, capability, audience, recoveryEnvelope,
    body: { threadId, epochId, capabilityId, audience, recoveryEnvelope: encodeTreeBytes(recoveryEnvelope),
      linkWrapper: linkWrapper ? encodeTreeBytes(linkWrapper) : null } };
}

/** The Owner's browser half of publishing. */
async function publish(owner: SharingAccount, fileId: string, options: {
  markdown?: string; pseudonym?: string; audience?: "public" | "collaborators_only";
} = {}): Promise<Publication> {
  const current = await fileView(owner, fileId);
  const linkKey = await createPublicationKeyPair();
  const publicationId = newPublicationIdentifier(), linkId = newPublicationIdentifier();
  const epoch = await audienceEpoch(publicationId, linkId, linkKey, owner, options.audience ?? "public", opaqueId());
  const ciphertext = await sealPublicRepresentation({ publicationId, linkId, publicKey: linkKey.publicKey, revision: 1 },
    publicPresentation(options.markdown ?? "# Public body"));
  const declarationId = options.pseudonym ? newPublicationIdentifier() : null;
  const author = options.pseudonym && declarationId ? { declarationId, ciphertext: encodeTreeBytes(await sealAuthorDeclaration(
    { publicationId, linkId, publicKey: linkKey.publicKey, declarationId, revision: 1 }, options.pseudonym)) } : null;
  const response = await sharingRequest(owner, `/api/private/publications/files/${fileId}`, "PUT", {
    publicationId, linkId, publicKey: encodeTreeBytes(linkKey.publicKey),
    expectedRevision: current.revision, expectedRepresentationId: current.representationId,
    representation: { ciphertext: encodeTreeBytes(ciphertext) }, author,
    comments: epoch.body,
  });
  if (response.status !== 201) throw new Error(`publish failed: ${response.status} ${await response.text()}`);
  return { publicationId, linkId, linkKey, fragment: formatPublicationFragment(linkKey.privateKey), declarationId,
    epochs: [{ threadId: epoch.threadId, epochId: epoch.epochId, capabilityId: epoch.capabilityId,
      capability: epoch.capability, audience: epoch.audience }] };
}

/** The Owner starts a fresh audience epoch (the ticket 23 audience control). */
async function changeAudience(owner: SharingAccount, fileId: string, publication: Publication,
  audience: "public" | "collaborators_only"): Promise<Epoch> {
  const current = publication.epochs.at(-1)!;
  const built = await audienceEpoch(publication.publicationId, publication.linkId, publication.linkKey, owner, audience,
    current.threadId);
  const response = await sharingRequest(owner, `/api/private/comments/files/${fileId}/public`, "PUT", {
    publicationId: publication.publicationId, expectedEpochId: current.epochId, epoch: built.body });
  if (response.status !== 200) throw new Error(`audience change failed: ${response.status} ${await response.text()}`);
  const epoch: Epoch = { threadId: built.threadId, epochId: built.epochId, capabilityId: built.capabilityId,
    capability: built.capability, audience };
  publication.epochs.push(epoch);
  return epoch;
}

/** An accepted Grant device delivery for one epoch, exactly as ticket 23 posts it. */
async function grantWithEpoch(owner: SharingAccount, recipient: SharingAccount, targetId: string, epoch: Epoch) {
  const share = await invite(owner, recipient, targetId, "read_only");
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
  if (!uploaded.ok) throw new Error(`epoch delivery failed: ${uploaded.status}`);
  const accepted = await sharingRequest(recipient, `/api/private/shares/${share.shareId}/accept`, "POST", {});
  if (!accepted.ok) throw new Error(`accept failed: ${accepted.status}`);
  return ((await accepted.json()) as { grantId: string }).grantId;
}

/** Post a real Public Comment through the authenticated File route. */
async function comment(owner: SharingAccount, fileId: string, publication: Publication, text: string,
  epoch: Epoch = publication.epochs.at(-1)!) {
  const commentId = opaqueId();
  const sealed = await sealPublicCommentBody(epoch.capability, { publicationId: publication.publicationId, commentId,
    capabilityId: epoch.capabilityId, keyEpoch: 1, revision: 1, text });
  const response = await sharingRequest(owner, `/api/private/comments/files/${fileId}/public/entries`, "POST", {
    commentId, threadId: publication.epochs[0]!.threadId, epochId: epoch.epochId,
    capabilityId: epoch.capabilityId, capabilityEpoch: 1, bodyCiphertext: sealed.bodyCiphertext,
    contentKeyEnvelope: sealed.contentKeyEnvelope, attribution: null });
  if (response.status !== 201) throw new Error(`comment failed: ${response.status} ${await response.text()}`);
  return commentId;
}

type Anonymous = { publicationId: string; linkId: string; publicKey: string;
  representation: { revision: number; ciphertext: string };
  authors: { declarationId: string; revision: number; ciphertext: string }[];
  comments: { audience: string; threadId: string | null;
    epochs: { epochId: string; ordinal: number; state: string; capabilityId: string; capabilityEpoch: number; wrapper: string }[];
    comments: { id: string; epochId: string; revision: number; bodyCiphertext: string; contentKeyEnvelope: string }[];
    attributions: unknown[]; nextCursor: number | null } };

function readAnonymous(linkId: string) {
  return SELF.fetch(`https://mdwn.test/api/public/publications/${linkId}`);
}

/** Open the served representation and one Comment exactly as the Public reader does. */
async function openAnonymous(linkId: string, fragment: string, markdown: string, commentTexts: string[]) {
  const response = await readAnonymous(linkId);
  expect(response.status).toBe(200);
  const body = await response.json() as Anonymous;
  const privateKey = decodeTreeBytes(fragment.slice(3), 32);
  const publicKey = decodeTreeBytes(body.publicKey, 65);
  const presentation = await openPublicRepresentation(decodeTreeBytes(body.representation.ciphertext, 524_288),
    await importPublicationKeyPair(privateKey, publicKey),
    { publicationId: body.publicationId, linkId, publicKey, revision: body.representation.revision });
  expect(presentation.markdown).toBe(markdown);
  const texts: string[] = [];
  for (const epoch of body.comments.epochs) {
    const capability = await openCommentEpochLink(privateKey, publicKey, {
      publicationId: body.publicationId, linkId, epochId: epoch.epochId, capabilityId: epoch.capabilityId,
      keyEpoch: epoch.capabilityEpoch, ciphertext: epoch.wrapper });
    for (const entry of body.comments.comments.filter((value) => value.epochId === epoch.epochId)) {
      const opened = await openPublicCommentBody(capability, {
        publicationId: body.publicationId, commentId: entry.id, revision: entry.revision,
        capabilityId: epoch.capabilityId, keyEpoch: epoch.capabilityEpoch,
        bodyCiphertext: entry.bodyCiphertext, contentKeyEnvelope: entry.contentKeyEnvelope });
      texts.push(opened);
    }
  }
  expect(texts.sort()).toEqual([...commentTexts].sort());
  return { body, presentation };
}

/** The Owner's browser half of rotation: fresh keys, re-encrypted representation, rewrapped public epochs. */
async function rotate(owner: SharingAccount, fileId: string, publication: Publication, markdown: string) {
  const current = await fileView(owner, fileId);
  const linkKey = await createPublicationKeyPair(), linkId = newPublicationIdentifier();
  const revision = current.publication!.revision!;
  const ciphertext = await sealPublicRepresentation({ publicationId: publication.publicationId, linkId,
    publicKey: linkKey.publicKey, revision }, publicPresentation(markdown));
  const epochs = await Promise.all(publication.epochs.filter((epoch) => epoch.audience === "public").map(async (epoch) => ({
    epochId: epoch.epochId, capabilityId: epoch.capabilityId, keyEpoch: 1,
    wrapper: encodeTreeBytes(await sealCommentEpochLink(linkKey.privateKey, linkKey.publicKey,
      { publicationId: publication.publicationId, linkId, epochId: epoch.epochId, capabilityId: epoch.capabilityId,
        keyEpoch: 1, capability: epoch.capability })),
  })));
  return { linkKey, linkId, revision, ciphertext, epochs,
    body: { publicationId: publication.publicationId, linkId, publicKey: encodeTreeBytes(linkKey.publicKey),
      expectedLinkId: publication.linkId, expectedPresentationRevision: revision,
      expectedRevision: current.revision, expectedRepresentationId: current.representationId,
      representation: { ciphertext: encodeTreeBytes(ciphertext) }, epochs } };
}

async function count(table: string, where = "1", ...values: unknown[]) {
  return (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).bind(...values).first<{ n: number }>())!.n;
}

async function notFoundShape(response: Response) {
  return { status: response.status, contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"), robots: response.headers.get("x-robots-tag"),
    cookie: response.headers.get("set-cookie"), body: await response.text() };
}

describe("link rotation", () => {
  it("replaces the path in one transaction, keeping the Publication, representation and Comments", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId, { markdown: "# Public body", pseudonym: "Member Owner" });
    await comment(owner, fileId, publication, "Comment before rotation");
    const before = await fileView(owner, fileId);
    expect(((await (await readAnonymous(publication.linkId)).json()) as Anonymous).authors).toHaveLength(1);
    const rotation = await rotate(owner, fileId, publication, "# Public body");
    const response = await sharingRequest(owner, `/api/private/publications/files/${fileId}/link`, "PUT", rotation.body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ publicationId: publication.publicationId, linkId: rotation.linkId });

    // The logical Publication and presentation revision survive; the path does not.
    const row = await env.DB.prepare(`SELECT p.id, p.state, p.current_link_id, l.public_key, r.revision, r.file_revision
      FROM publications p JOIN publication_links l ON l.id = p.current_link_id
      JOIN public_representations r ON r.id = p.current_representation_id WHERE p.file_id = ?`).bind(fileId)
      .first<{ id: string; state: string; current_link_id: string; public_key: ArrayBuffer; revision: number; file_revision: number }>();
    expect(row).toMatchObject({ id: publication.publicationId, state: "active", current_link_id: rotation.linkId,
      revision: before.publication!.revision, file_revision: before.revision });
    expect(new Uint8Array(row!.public_key)).toEqual(rotation.linkKey.publicKey);
    expect(await count("publication_links", "id = ?", publication.linkId)).toBe(0);
    expect(await count("publication_links", "publication_id = ?", publication.publicationId)).toBe(1);
    expect(await count("public_comment_epoch_links",
      "publication_id = ? AND link_id = ? AND epoch_id = ?", publication.publicationId, rotation.linkId,
      publication.epochs[0]!.epochId)).toBe(1);

    // The old path is byte-identical to an unknown one; the new path serves
    // the same document and Comment through the new fragment only.
    const unknown = await readAnonymous("A".repeat(43));
    const retired = await readAnonymous(publication.linkId);
    expect(await notFoundShape(retired)).toEqual(await notFoundShape(unknown));
    await openAnonymous(rotation.linkId, formatPublicationFragment(rotation.linkKey.privateKey), "# Public body",
      ["Comment before rotation"]);
    // The retired link's author declaration is never served for the new link;
    // the author's own device re-declares when it next sees the File.
    const rotatedView = await fileView(owner, fileId);
    expect(rotatedView.publication!.declaration).toMatchObject({ declarationId: publication.declarationId,
      current: false, revision: 1 });
    expect(((await (await readAnonymous(rotation.linkId)).json()) as Anonymous).authors).toEqual([]);
    await sharingRequest(owner, `/api/private/publications/files/${fileId}/authors/${publication.declarationId}/declaration`,
      "PUT", { publicationId: publication.publicationId, linkId: rotation.linkId, revision: 2,
        ciphertext: encodeTreeBytes(await sealAuthorDeclaration({ publicationId: publication.publicationId,
          linkId: rotation.linkId, publicKey: rotation.linkKey.publicKey, declarationId: publication.declarationId!,
          revision: 2 }, "Member Owner")) });
    expect(((await (await readAnonymous(rotation.linkId)).json()) as Anonymous).authors).toHaveLength(1);
    const state = await panelState(owner, fileId);
    expect(state.publication).toMatchObject({ publicationId: publication.publicationId, state: "active",
      linkId: rotation.linkId });
    expect(state.commentCount).toBe(1);
  });

  it("requires the Owner and rejects incomplete, stale or mis-bound material without changing anything", async () => {
    const owner = await sharingAccount(), collaborator = await sharingAccount(), stranger = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    await grant(owner, collaborator, fileId, "read_only");
    const publication = await publish(owner, fileId);
    const rotation = await rotate(owner, fileId, publication, "# Public body");
    const before = await env.DB.prepare("SELECT r.ciphertext, w.ciphertext AS wrapper FROM public_representations r JOIN public_comment_epoch_links w ON w.publication_id = r.publication_id WHERE r.publication_id = ?")
      .bind(publication.publicationId).first<{ ciphertext: ArrayBuffer; wrapper: ArrayBuffer }>();

    // A Collaborator, a stranger and a missing proof cannot rotate.
    expect((await sharingRequest(collaborator, `/api/private/publications/files/${fileId}/link`, "PUT", rotation.body)).status).toBe(404);
    expect((await sharingRequest(stranger, `/api/private/publications/files/${fileId}/link`, "PUT", rotation.body)).status).toBe(404);
    // A stale expected link is a conflict, not a silent overwrite.
    const stale = { ...rotation.body, expectedLinkId: newPublicationIdentifier() };
    expect((await sharingRequest(owner, `/api/private/publications/files/${fileId}/link`, "PUT", stale)).status).toBe(409);
    // A missing public epoch, an unknown epoch and a wrong capability identity
    // can never install a partial rotation.
    for (const epochs of [[], [{ ...rotation.epochs[0], epochId: opaqueId() }],
      [{ ...rotation.epochs[0], capabilityId: opaqueId() }]]) {
      const response = await sharingRequest(owner, `/api/private/publications/files/${fileId}/link`, "PUT",
        { ...rotation.body, epochs });
      expect([400, 409]).toContain(response.status);
    }
    // A structurally valid wrapper bound to the retired link is refused.
    const bound = await sealCommentEpochLink(publication.linkKey.privateKey, publication.linkKey.publicKey,
      { publicationId: publication.publicationId, linkId: publication.linkId, epochId: publication.epochs[0]!.epochId,
        capabilityId: publication.epochs[0]!.capabilityId, keyEpoch: 1, capability: publication.epochs[0]!.capability });
    const misbound = await sharingRequest(owner, `/api/private/publications/files/${fileId}/link`, "PUT",
      { ...rotation.body, epochs: [{ ...rotation.epochs[0], wrapper: encodeTreeBytes(bound) }] });
    expect(misbound.status).toBe(400);
    // A File saved after the material was prepared is `file_changed`.
    const fresher = await sharingRequest(owner, `/api/private/publications/files/${fileId}/link`, "PUT",
      { ...rotation.body, expectedRevision: rotation.body.expectedRevision + 1 });
    expect(fresher.status).toBe(409);
    expect(await fresher.json()).toEqual({ error: "file_changed" });

    // Nothing changed: same link, same representation ciphertext, same wrapper.
    const after = await env.DB.prepare("SELECT r.ciphertext, w.ciphertext AS wrapper FROM public_representations r JOIN public_comment_epoch_links w ON w.publication_id = r.publication_id WHERE r.publication_id = ?")
      .bind(publication.publicationId).first<{ ciphertext: ArrayBuffer; wrapper: ArrayBuffer }>();
    expect(new Uint8Array(after!.ciphertext)).toEqual(new Uint8Array(before!.ciphertext));
    expect(new Uint8Array(after!.wrapper)).toEqual(new Uint8Array(before!.wrapper));
    expect((await panelState(owner, fileId)).publication).toMatchObject({ linkId: publication.linkId });
    await openAnonymous(publication.linkId, publication.fragment, "# Public body", []);
  });

  it("rewraps every public audience epoch and leaves Collaborators-only epochs and device envelopes alone", async () => {
    const owner = await sharingAccount(), collaborator = await sharingAccount();
    const directoryId = await treeChild(owner, owner.rootId, "directory");
    const fileId = await treeChild(owner, directoryId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    await comment(owner, fileId, publication, "First public comment", publication.epochs[0]!);
    const grantId = await grantWithEpoch(owner, collaborator, directoryId, publication.epochs[0]!);
    const envelopeBefore = await env.DB.prepare("SELECT ciphertext FROM grant_comment_key_envelopes WHERE relationship_id = ? AND object_id = ?")
      .bind(grantId, publication.epochs[0]!.epochId).first<{ ciphertext: ArrayBuffer }>();
    await changeAudience(owner, fileId, publication, "collaborators_only");
    const secondPublic = await changeAudience(owner, fileId, publication, "public");
    await comment(owner, fileId, publication, "Second public comment", secondPublic);
    const ownerEnvelopesBefore = await count("key_envelopes", "purpose = 'vault-recovery' AND object_id IN (?, ?, ?)",
      publication.epochs[0]!.epochId, publication.epochs[1]!.epochId, publication.epochs[2]!.epochId);

    const rotation = await rotate(owner, fileId, publication, "# Public body");
    expect((await sharingRequest(owner, `/api/private/publications/files/${fileId}/link`, "PUT", rotation.body)).status).toBe(200);
    // Both public epochs (not the Collaborators-only one) now wrap to the new link.
    const wrappers = await env.DB.prepare("SELECT epoch_id, link_id FROM public_comment_epoch_links WHERE publication_id = ? ORDER BY epoch_id")
      .bind(publication.publicationId).all<{ epoch_id: string; link_id: string }>();
    expect(wrappers.results.map((row) => row.link_id)).toEqual([rotation.linkId, rotation.linkId]);
    expect(new Set(wrappers.results.map((row) => row.epoch_id))).toEqual(
      new Set([publication.epochs[0]!.epochId, publication.epochs[2]!.epochId]));
    await openAnonymous(rotation.linkId, formatPublicationFragment(rotation.linkKey.privateKey), "# Public body",
      ["First public comment", "Second public comment"]);
    // Device envelopes and Owner recovery envelopes are a separate channel.
    const envelopeAfter = await env.DB.prepare("SELECT ciphertext FROM grant_comment_key_envelopes WHERE relationship_id = ? AND object_id = ?")
      .bind(grantId, publication.epochs[0]!.epochId).first<{ ciphertext: ArrayBuffer }>();
    expect(new Uint8Array(envelopeAfter!.ciphertext)).toEqual(new Uint8Array(envelopeBefore!.ciphertext));
    expect(await count("key_envelopes", "purpose = 'vault-recovery' AND object_id IN (?, ?, ?)",
      publication.epochs[0]!.epochId, publication.epochs[1]!.epochId, publication.epochs[2]!.epochId))
      .toBe(ownerEnvelopesBefore);
  });
});

describe("unpublish seal", () => {
  it("states the pinned Public Comment count and denies every Public route irreversibly", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    const first = await comment(owner, fileId, publication, "One");
    await comment(owner, fileId, publication, "Two");
    expect((await panelState(owner, fileId)).commentCount).toBe(2);

    const sealed = await sharingRequest(owner, `/api/private/publications/files/${fileId}/unpublish`, "POST");
    expect(sealed.status).toBe(200);
    expect(await sealed.json()).toMatchObject({ publicationId: publication.publicationId, commentTotal: 2 });
    const state = await panelState(owner, fileId);
    expect(state.publication).toMatchObject({ publicationId: publication.publicationId, state: "deleting" });
    expect(state.teardown).toEqual({ commentTotal: 2, commentsRemaining: 2 });
    const row = await env.DB.prepare("SELECT state, current_link_id, current_representation_id FROM publications WHERE file_id = ?")
      .bind(fileId).first<{ state: string; current_link_id: string | null; current_representation_id: string | null }>();
    expect(row).toEqual({ state: "deleting", current_link_id: null, current_representation_id: null });
    expect(await count("publication_links", "publication_id = ?", publication.publicationId)).toBe(0);
    expect(await count("public_comment_epoch_links", "publication_id = ?", publication.publicationId)).toBe(0);

    // Every Public route now takes the same ciphertext-free 404 path.
    const unknown = await readAnonymous("A".repeat(43));
    expect(await notFoundShape(await readAnonymous(publication.linkId))).toEqual(await notFoundShape(unknown));
    expect((await SELF.fetch(`https://mdwn.test/api/public/publications/${publication.linkId}/comments`)).status).toBe(404);
    expect((await sharingRequest(owner, `/api/private/comments/links/${publication.linkId}/entries`, "POST", {
      commentId: opaqueId(), threadId: publication.epochs[0]!.threadId, epochId: publication.epochs[0]!.epochId,
      capabilityId: publication.epochs[0]!.capabilityId, capabilityEpoch: 1, bodyCiphertext: "AA", contentKeyEnvelope: "AA",
      attribution: null })).status).toBe(404);
    expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/public`, "PUT", {
      publicationId: publication.publicationId, expectedEpochId: publication.epochs[0]!.epochId,
      epoch: { threadId: opaqueId(), epochId: opaqueId(), capabilityId: opaqueId(), audience: "public",
        recoveryEnvelope: "AA", linkWrapper: null } })).status).toBe(404);
    // The authenticated thread read settles without ciphertext or a thread.
    const thread = await sharingRequest(owner, `/api/private/comments/files/${fileId}/public`);
    expect(await thread.json()).toMatchObject({ thread: null, canCreateThread: false, publication: null });

    // The authenticated File route denies author edit and Owner delete too:
    // a retained thread capability cannot mutate a sealed Publication.
    const epoch = publication.epochs[0]!;
    expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/public/entries/${first}`, "PATCH", {
      threadId: epoch.threadId, capabilityId: epoch.capabilityId, capabilityEpoch: 1, epochId: epoch.epochId,
      expectedRevision: 1, bodyCiphertext: "AA", contentKeyEnvelope: "AA" })).status).toBe(404);
    expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/public/entries/${first}`, "DELETE", {
      threadId: epoch.threadId, capabilityId: epoch.capabilityId, capabilityEpoch: 1, epochId: epoch.epochId,
      expectedRevision: 1 })).status).toBe(404);
    expect(await count("comments", "id = ?", first)).toBe(1);

    // The seal is irreversible even by direct storage write.
    await expect(env.DB.prepare(`UPDATE publications SET state = 'active', current_link_id = ?,
      current_representation_id = NULL WHERE file_id = ?`).bind(newPublicationIdentifier(), fileId).run()).rejects.toThrow();
    // A sealed Publication can never gain a new link or representation.
    await expect(env.DB.prepare("INSERT INTO publication_links (id, publication_id, public_key, created_at) VALUES (?, ?, ?, ?)")
      .bind(newPublicationIdentifier(), publication.publicationId, publication.linkKey.publicKey, Date.now()).run()).rejects.toThrow();
    await expect(env.DB.prepare(`INSERT INTO public_representations (id, publication_id, link_id, revision, file_revision,
      ciphertext, ciphertext_size, created_at) VALUES (?, ?, ?, 1, 1, X'01', 1, ?)`)
      .bind(opaqueId(), publication.publicationId, newPublicationIdentifier(), Date.now()).run()).rejects.toThrow();
  });

  it("allows no new Publication for the File until cleanup completes", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    await publish(owner, fileId);
    expect((await sharingRequest(owner, `/api/private/publications/files/${fileId}/unpublish`, "POST")).status).toBe(200);
    const current = await fileView(owner, fileId);
    const linkKey = await createPublicationKeyPair(), linkId = newPublicationIdentifier(), publicationId = newPublicationIdentifier();
    const epoch = await audienceEpoch(publicationId, linkId, linkKey, owner, "collaborators_only", opaqueId());
    const blocked = await sharingRequest(owner, `/api/private/publications/files/${fileId}`, "PUT", {
      publicationId, linkId, publicKey: encodeTreeBytes(linkKey.publicKey),
      expectedRevision: current.revision, expectedRepresentationId: current.representationId,
      representation: { ciphertext: encodeTreeBytes(await sealPublicRepresentation({ publicationId, linkId,
        publicKey: linkKey.publicKey, revision: 1 }, publicPresentation("# Again"))) },
      author: null, comments: epoch.body });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: "publication_exists" });
  });
});

describe("unpublish teardown", () => {
  it("drives idempotent batches that remove the thread, envelopes, attribution and Publication row", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    await comment(owner, fileId, publication, "One");
    await comment(owner, fileId, publication, "Two");
    const declarationId = newPublicationIdentifier();
    expect((await sharingRequest(owner, `/api/private/publications/files/${fileId}/authors`, "PUT", {
      publicationId: publication.publicationId, declarationId, account: { self: true },
      declaration: { linkId: publication.linkId, ciphertext: encodeTreeBytes(await sealAuthorDeclaration(
        { publicationId: publication.publicationId, linkId: publication.linkId,
          publicKey: publication.linkKey.publicKey, declarationId, revision: 1 }, "Member Owner")) } })).status).toBe(201);
    expect((await sharingRequest(owner, `/api/private/publications/files/${fileId}/unpublish`, "POST")).status).toBe(200);

    const first = await sharingRequest(owner, `/api/private/publications/files/${fileId}/teardown`, "POST");
    expect(await first.json()).toEqual({ done: false, commentTotal: 2, commentsRemaining: 0 });
    expect(await count("comments", "thread_id = ?", publication.epochs[0]!.threadId)).toBe(0);
    const second = await sharingRequest(owner, `/api/private/publications/files/${fileId}/teardown`, "POST");
    expect(await second.json()).toEqual({ done: true, commentTotal: 2, commentsRemaining: 0 });

    for (const table of ["publications", "publication_requests"]) {
      expect(await count(table, "file_id = ?", fileId), table).toBe(0);
    }
    for (const table of ["publication_links", "public_representations", "public_comment_epoch_links",
      "publication_teardowns", "publication_authors"]) {
      expect(await count(table, "publication_id = ?", publication.publicationId), table).toBe(0);
    }
    for (const table of ["comment_threads"]) expect(await count(table, "file_id = ?", fileId), table).toBe(0);
    for (const table of ["comment_thread_epochs", "comments", "thread_attributions", "sharing_comment_capabilities"]) {
      expect(await count(table, "thread_id = ?", publication.epochs[0]!.threadId), table).toBe(0);
    }
    for (const table of ["grant_comment_key_envelopes", "share_comment_key_envelopes"]) {
      expect(await count(table, "object_id = ?", publication.epochs[0]!.epochId), table).toBe(0);
    }
    expect(await count("key_envelopes", "object_id IN (?, ?, ?)", publication.epochs[0]!.threadId,
      publication.epochs[0]!.epochId, declarationId)).toBe(0);
    // The idempotent third call still says done and changes nothing.
    expect(await (await sharingRequest(owner, `/api/private/publications/files/${fileId}/teardown`, "POST")).json())
      .toEqual({ done: true, commentTotal: 0, commentsRemaining: 0 });
    // A later Publication starts entirely fresh.
    const fresh = await publish(owner, fileId, { markdown: "# Fresh start" });
    expect(fresh.publicationId).not.toBe(publication.publicationId);
    expect(fresh.linkId).not.toBe(publication.linkId);
    expect((await panelState(owner, fileId)).commentCount).toBe(0);
  });

  it("bounds each batch, survives interruption, and resumes only for the Owner", async () => {
    const owner = await sharingAccount(), collaborator = await sharingAccount(), stranger = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    await grant(owner, collaborator, fileId, "read_only");
    const publication = await publish(owner, fileId);
    // 201 opaque Comment rows: one bounded batch deletes 200, never more.
    const rows = [];
    for (let sequence = 1; sequence <= 201; sequence++) rows.push(env.DB.prepare(`INSERT INTO comments
      (id, thread_id, epoch_id, author_id, sequence, revision, body_ciphertext, body_size, content_key_envelope,
        content_key_epoch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, X'01', 1, X'01', 1, 1, 1)`)
      .bind(opaqueId(), publication.epochs[0]!.threadId, publication.epochs[0]!.epochId, owner.accountId, sequence));
    await env.DB.batch(rows);
    expect((await sharingRequest(owner, `/api/private/publications/files/${fileId}/unpublish`, "POST")).status).toBe(200);
    expect((await panelState(owner, fileId)).teardown).toEqual({ commentTotal: 201, commentsRemaining: 201 });

    // A non-Owner can neither read progress nor resume the deletion.
    expect((await sharingRequest(collaborator, `/api/private/publications/files/${fileId}/teardown`, "POST")).status).toBe(404);
    expect((await sharingRequest(stranger, `/api/private/publications/files/${fileId}/teardown`, "POST")).status).toBe(404);
    expect(await panelState(collaborator, fileId)).toMatchObject({ isOwner: false, commentCount: 0, teardown: null });
    expect(await count("comments", "thread_id = ?", publication.epochs[0]!.threadId)).toBe(201);

    const first = await sharingRequest(owner, `/api/private/publications/files/${fileId}/teardown`, "POST");
    expect(await first.json()).toEqual({ done: false, commentTotal: 201, commentsRemaining: 1 });
    // An interrupted teardown stays sealed and Owner-resumable.
    expect((await panelState(owner, fileId)).teardown).toEqual({ commentTotal: 201, commentsRemaining: 1 });
    const second = await sharingRequest(owner, `/api/private/publications/files/${fileId}/teardown`, "POST");
    expect(await second.json()).toEqual({ done: false, commentTotal: 201, commentsRemaining: 0 });
    const third = await sharingRequest(owner, `/api/private/publications/files/${fileId}/teardown`, "POST");
    expect(await third.json()).toEqual({ done: true, commentTotal: 201, commentsRemaining: 0 });
    expect((await panelState(owner, fileId)).publication).toBeNull();
  });

  it("is never blocked by Public-participation limits, and unpublishing wins over a spent create limit", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    await comment(owner, fileId, publication, "Kept until teardown");
    // Exhaust the Publication-create limit for this Account, as abuse control would.
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO rate_limit_counters (purpose, scope_type, scope_id, window_ms, time_epoch, count, expires_at)
      VALUES ('publication.mutate', 'account', ?, 86400000, ?, 5, ?)`).bind(owner.accountId, now, now + 86400000).run();
    expect((await sharingRequest(owner, `/api/private/publications/files/${fileId}/unpublish`, "POST")).status).toBe(200);
    expect((await sharingRequest(owner, `/api/private/publications/files/${fileId}/teardown`, "POST")).status).toBe(200);
    expect((await sharingRequest(owner, `/api/private/publications/files/${fileId}/teardown`, "POST")).status).toBe(200);
    expect(await count("publications", "file_id = ?", fileId)).toBe(0);
    expect(await count("comments", "thread_id = ?", publication.epochs[0]!.threadId)).toBe(0);
  });
});

describe("storage guards", () => {
  it("removes a sealed teardown with the File on hard deletion", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    await comment(owner, fileId, publication, "Gone with the File");
    expect((await sharingRequest(owner, `/api/private/publications/files/${fileId}/unpublish`, "POST")).status).toBe(200);
    expect((await sharingRequest(owner, `/api/private/tree/nodes/${fileId}`, "DELETE",
      await deletePayload(owner, owner.accountId, fileId, owner.rootId))).status).toBe(200);
    expect(await count("publications", "file_id = ?", fileId)).toBe(0);
    expect(await count("publication_teardowns", "publication_id = ?", publication.publicationId)).toBe(0);
    expect(await count("comments", "thread_id = ?", publication.epochs[0]!.threadId)).toBe(0);
  });

  it("keeps the link identity immutable except by an active rotation", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    // A same-identity update and an unrelated publication id are both refused.
    await expect(env.DB.prepare("UPDATE publication_links SET public_key = ? WHERE id = ?")
      .bind(publication.linkKey.publicKey, publication.linkId).run()).rejects.toThrow();
    await expect(env.DB.prepare("UPDATE publication_links SET id = ? WHERE id = ?")
      .bind(newPublicationIdentifier(), publication.linkId).run()).rejects.toThrow();
    // The retired path identifier is gone, not kept in a registry.
    const rotation = await rotate(owner, fileId, publication, "# Public body");
    expect((await sharingRequest(owner, `/api/private/publications/files/${fileId}/link`, "PUT", rotation.body)).status).toBe(200);
    expect(await count("publication_links", "id = ?", publication.linkId)).toBe(0);
    expect(isPublicationIdentifier(rotation.linkId)).toBe(true);
  });
});
