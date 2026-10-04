import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { sealAttribution, sealCommentBody } from "../../app/comments/content";
import { generateVaultRootKey, sealVaultRecoveryEnvelope } from "../../app/crypto/vault";
import { newPublicationIdentifier } from "../../app/publications/capability";
import { applyPublicParticipationSuspension } from "../../app/security/public-participation.server";
import { encodeTreeBytes } from "../../app/tree/wire";
import {
  commentPayload, publish, sealedAttribution, sealedComment, type Publication,
} from "./publication-fixtures";
import {
  deletePayload, grant, invite, opaqueId, prepareGrantKeys, sharingAccount, sharingRequest, treeChild,
  type SharingAccount,
} from "./sharing-fixtures";

/**
 * Ticket 27: deleting a File or Directory removes every dependent record the
 * Account owns — Shares and Grants, Publications, both Comment threads, Public
 * Comment reports and staged pseudonym items included — and an over-cap
 * Directory changes nothing at all. Assertions run through the public API and
 * at the real-D1 storage seam, and the FK inventory proves no privacy table
 * leans on a generic database cascade.
 */

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rate_limit_counters"),
    env.DB.prepare("DELETE FROM public_comment_reports"),
    env.DB.prepare("DELETE FROM public_participation_suspensions"),
  ]);
});

async function count(table: string, where = "1", ...values: unknown[]) {
  return (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)
    .bind(...values).first<{ n: number }>())!.n;
}

type PrivateThread = { threadId: string; epochId: string; capabilityId: string; capability: Uint8Array<ArrayBuffer> };

/** Owner creates the one Private thread with a real `vault-recovery` envelope. */
async function privateThread(owner: SharingAccount, fileId: string): Promise<PrivateThread> {
  const vaultRootKey = generateVaultRootKey();
  const threadId = opaqueId(), epochId = opaqueId(), capabilityId = opaqueId();
  const capability = crypto.getRandomValues(new Uint8Array(32));
  const recoveryEnvelope = await sealVaultRecoveryEnvelope(vaultRootKey,
    { scope: "owned", objectId: threadId, keyId: capabilityId, key: capability },
    { purpose: "vault-recovery", vaultId: owner.accountId, objectId: threadId, keyId: capabilityId, keyEpoch: 1, revision: 1 });
  const response = await sharingRequest(owner, `/api/private/comments/files/${fileId}`, "PUT",
    { threadId, epochId, capabilityId, recoveryEnvelope: encodeTreeBytes(recoveryEnvelope) });
  if (response.status !== 201) throw new Error(`thread create failed: ${response.status} ${await response.text()}`);
  return { threadId, epochId, capabilityId, capability };
}

async function privateComment(owner: SharingAccount, fileId: string, thread: PrivateThread, text: string) {
  const commentId = opaqueId(), attributionId = opaqueId();
  const comment = await sealCommentBody(thread.capability, { vaultId: owner.accountId, commentId,
    capabilityId: thread.capabilityId, keyEpoch: 1, revision: 1, text });
  const attribution = await sealAttribution(thread.capability, { vaultId: owner.accountId, attributionId,
    pseudonym: "Hard Delete Author", capabilityId: thread.capabilityId, keyEpoch: 1, revision: 1 });
  const response = await sharingRequest(owner, `/api/private/comments/files/${fileId}/entries`, "POST",
    { commentId, threadId: thread.threadId, capabilityId: thread.capabilityId, capabilityEpoch: 1, epochId: thread.epochId,
      bodyCiphertext: comment.bodyCiphertext, contentKeyEnvelope: comment.contentKeyEnvelope, attribution });
  if (response.status !== 201) throw new Error(`comment create failed: ${response.status} ${await response.text()}`);
  return { commentId, attributionId };
}

async function publicComment(owner: SharingAccount, fileId: string, publication: Publication, text: string) {
  const comment = await sealedComment(publication, text);
  const attribution = await sealedAttribution(publication, "Public Hard Delete Author");
  const response = await sharingRequest(owner, `/api/private/comments/files/${fileId}/public/entries`, "POST",
    commentPayload(publication, comment, attribution));
  if (response.status !== 201) throw new Error(`public comment failed: ${response.status} ${await response.text()}`);
  return { commentId: comment.commentId, attributionId: attribution.attributionId };
}

const report = (account: SharingAccount, commentId: string) =>
  sharingRequest(account, "/api/private/comments/reports", "POST", { commentId, category: "spam" });

/** A pending Pseudonym-update job staging the given attribution contexts. */
async function stagePseudonymItems(account: SharingAccount, items: { kind: "thread" | "publication"; recordId: string }[]) {
  const now = Date.now(), jobId = opaqueId();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO crypto_jobs (id, account_id, device_id, kind, state, progress, created_at, updated_at)
      VALUES (?, ?, ?, 'pseudonym_update', 'pending', 0, ?, ?)`)
      .bind(jobId, account.accountId, account.deviceId, now, now),
    ...items.map((item) => item.kind === "thread"
      ? env.DB.prepare(`INSERT INTO pseudonym_update_items
        (job_id, kind, record_id, revision, ciphertext, content_key_envelope, content_key_epoch, created_at)
        VALUES (?, 'thread', ?, 1, X'01', X'01', 1, ?)`).bind(jobId, item.recordId, now)
      : env.DB.prepare(`INSERT INTO pseudonym_update_items
        (job_id, kind, record_id, revision, ciphertext, content_key_envelope, content_key_epoch, created_at)
        VALUES (?, 'publication', ?, 1, X'01', NULL, NULL, ?)`).bind(jobId, item.recordId, now)),
  ]);
  return jobId;
}

type FileDependents = {
  fileId: string; privateThread: PrivateThread; privateAttributionId: string; privateCommentId: string;
  publication: Publication; publicAttributionId: string; publicCommentId: string;
  authorDeclarationId: string; grantId: string; pseudonymJobId: string;
};

async function publishFileWithDependents(owner: SharingAccount, collaborator: SharingAccount,
  reporter: SharingAccount, fileId: string): Promise<FileDependents> {
  // The Grant exists before the threads, so acceptance never waits on Comment
  // key delivery.
  const { grantId } = await grant(owner, collaborator, fileId);
  const thread = await privateThread(owner, fileId);
  const privatePosted = await privateComment(owner, fileId, thread, "Private note");
  // A Collaborator's pending request exists only before the Publication does.
  expect((await sharingRequest(collaborator, `/api/private/publications/files/${fileId}/requests`, "POST", {})).status).toBe(201);
  const publication = await publish(owner, fileId);
  const publicPosted = await publicComment(owner, fileId, publication, "Public note");
  expect((await report(reporter, publicPosted.commentId)).status).toBe(201);
  // A pending author declaration is part of the Publication's public material.
  const now = Date.now(), authorDeclarationId = newPublicationIdentifier();
  await env.DB.prepare(`INSERT INTO publication_authors (id, publication_id, author_id, ordinal, revision, created_at, updated_at)
    VALUES (?, ?, ?, 1, 0, ?, ?)`).bind(authorDeclarationId, publication.publicationId, owner.accountId, now, now).run();
  const pseudonymJobId = await stagePseudonymItems(owner, [
    { kind: "thread", recordId: privatePosted.attributionId },
    { kind: "thread", recordId: publicPosted.attributionId },
    { kind: "publication", recordId: authorDeclarationId },
  ]);
  return { fileId, privateThread: thread, privateAttributionId: privatePosted.attributionId,
    privateCommentId: privatePosted.commentId, publication, publicAttributionId: publicPosted.attributionId,
    publicCommentId: publicPosted.commentId, authorDeclarationId, grantId, pseudonymJobId };
}

describe("hard-deletion completeness", () => {
  it("keeps every privacy-sensitive foreign key on RESTRICT rather than a generic cascade", async () => {
    const tables = (await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all<{ name: string }>()).results;
    const cascades: string[] = [];
    for (const { name } of tables) {
      const keys = (await env.DB.prepare(`PRAGMA foreign_key_list("${name}")`)
        .all<{ table: string; from: string; on_delete: string }>()).results;
      for (const key of keys) if (key.on_delete === "CASCADE") cascades.push(`${name}.${key.from} -> ${key.table}`);
    }
    expect(cascades).toEqual([]);
    const reports = (await env.DB.prepare("PRAGMA foreign_key_list(public_comment_reports)")
      .all<{ table: string; from: string; on_delete: string }>()).results;
    expect(reports).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "comments", from: "comment_id", on_delete: "RESTRICT" })]));
  });

  it("hard-deletes a File with a Publication, Comments, Grants and staged pseudonym items with no orphan rows", async () => {
    const owner = await sharingAccount(), collaborator = await sharingAccount(), reporter = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const scope = await publishFileWithDependents(owner, collaborator, reporter, fileId);
    const { publication } = scope;
    expect(await count("publications", "file_id = ?", fileId)).toBe(1);
    expect(await count("public_comment_reports", "comment_id = ?", scope.publicCommentId)).toBe(1);
    expect(await count("pseudonym_update_items", "record_id IN (?, ?, ?)",
      scope.privateAttributionId, scope.publicAttributionId, scope.authorDeclarationId)).toBe(3);

    const deletion = await deletePayload(owner, owner.accountId, fileId, owner.rootId);
    const deleted = await sharingRequest(owner, `/api/private/tree/nodes/${fileId}`, "DELETE", deletion);
    expect(deleted.status, await deleted.clone().text()).toBe(200);

    const epochIds = [scope.privateThread.epochId, publication.epoch.epochId];
    const threadIds = [scope.privateThread.threadId, publication.epoch.threadId];
    const ids = [fileId, ...threadIds, ...epochIds];
    const placeholders = ids.map(() => "?").join(", ");
    const threadPlaceholders = threadIds.map(() => "?").join(", ");
    for (const [table, where, values] of [
      ["vault_nodes", `id IN (${placeholders})`, ids],
      ["directory_entries", `child_node_id IN (${placeholders})`, ids],
      ["files", `node_id = ?`, [fileId]],
      ["file_representations", `file_node_id = ?`, [fileId]],
      ["key_envelopes", `object_id IN (${placeholders})`, ids],
      ["shares", `target_id = ?`, [fileId]],
      ["grants", `target_id = ?`, [fileId]],
      ["share_key_envelopes", `relationship_id = ?`, [scope.grantId]],
      ["grant_key_envelopes", `relationship_id = ?`, [scope.grantId]],
      ["provisioning_needs", `grant_id = ?`, [scope.grantId]],
      ["sharing_comment_capabilities", `file_id = ? OR object_id IN (${placeholders})`, [fileId, ...ids]],
      ["share_comment_key_envelopes", `object_id IN (${placeholders})`, ids],
      ["grant_comment_key_envelopes", `object_id IN (${placeholders})`, ids],
      ["sharing_write_blocks", `target_id = ?`, [fileId]],
      ["comment_threads", `file_id = ?`, [fileId]],
      ["comment_thread_epochs", `thread_id IN (${threadPlaceholders})`, threadIds],
      ["thread_attributions", `thread_id IN (${threadPlaceholders})`, threadIds],
      ["comments", `thread_id IN (${threadPlaceholders})`, threadIds],
      ["public_comment_reports", `comment_id = ?`, [scope.publicCommentId]],
      ["public_comment_epoch_links", `publication_id = ?`, [publication.publicationId]],
      ["publications", `file_id = ?`, [fileId]],
      ["publication_links", `publication_id = ?`, [publication.publicationId]],
      ["public_representations", `publication_id = ?`, [publication.publicationId]],
      ["publication_authors", `publication_id = ?`, [publication.publicationId]],
      ["publication_teardowns", `publication_id = ?`, [publication.publicationId]],
      ["publication_requests", `file_id = ?`, [fileId]],
      ["pseudonym_update_items", `record_id IN (?, ?, ?)`,
        [scope.privateAttributionId, scope.publicAttributionId, scope.authorDeclarationId]],
    ] as const) {
      expect(await count(table, where as string, ...(values as unknown[])), table).toBe(0);
    }
    expect((await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).status).toBe(404);
    expect((await sharingRequest(collaborator, `/api/private/tree/files/${fileId}`)).status).toBe(404);
  });

  it("hard-deletes a Directory subtree with its Publications, Comments, Grants and staged items", async () => {
    const owner = await sharingAccount(), collaborator = await sharingAccount(), reporter = await sharingAccount();
    const directoryId = await treeChild(owner, owner.rootId, "directory");
    const fileId = await treeChild(owner, directoryId, "file", owner.accountId, true);
    // The Directory Grant exists before the comments, so acceptance never waits
    // on Comment key delivery; it is itself a dependent of the deleted subtree.
    const directoryGrant = await grant(owner, collaborator, directoryId, "read_write");
    const scope = await publishFileWithDependents(owner, collaborator, reporter, fileId);
    const { publication } = scope;

    const body = await deletePayload(owner, owner.accountId, directoryId, owner.rootId);
    const deleted = await sharingRequest(owner, `/api/private/tree/nodes/${directoryId}`, "DELETE", body);
    expect(deleted.status, await deleted.clone().text()).toBe(200);

    const epochIds = [scope.privateThread.epochId, publication.epoch.epochId];
    const threadIds = [scope.privateThread.threadId, publication.epoch.threadId];
    const subtree = [directoryId, fileId];
    const threadPlaceholders = threadIds.map(() => "?").join(", ");
    expect(await count("vault_nodes", "id IN (?, ?)", directoryId, fileId)).toBe(0);
    expect(await count("directory_entries", "child_node_id IN (?, ?)", directoryId, fileId)).toBe(0);
    expect(await count("directories", "node_id = ?", directoryId)).toBe(0);
    expect(await count("files", "node_id = ?", fileId)).toBe(0);
    expect(await count("file_representations", "file_node_id = ?", fileId)).toBe(0);
    expect(await count("grants", `target_id IN (?, ?)`, ...subtree)).toBe(0);
    expect(await count("shares", `target_id IN (?, ?)`, ...subtree)).toBe(0);
    expect(await count("share_key_envelopes", `relationship_id IN (?, ?)`, scope.grantId, directoryGrant.grantId)).toBe(0);
    expect(await count("grant_key_envelopes", `relationship_id IN (?, ?)`, scope.grantId, directoryGrant.grantId)).toBe(0);
    expect(await count("provisioning_needs", `grant_id IN (?, ?)`, scope.grantId, directoryGrant.grantId)).toBe(0);
    expect(await count("sharing_comment_capabilities", `file_id = ?`, fileId)).toBe(0);
    expect(await count("comment_threads", `file_id = ?`, fileId)).toBe(0);
    expect(await count("comment_thread_epochs", `thread_id IN (${threadPlaceholders})`, ...threadIds)).toBe(0);
    expect(await count("thread_attributions", `thread_id IN (${threadPlaceholders})`, ...threadIds)).toBe(0);
    expect(await count("comments", `thread_id IN (${threadPlaceholders})`, ...threadIds)).toBe(0);
    expect(await count("public_comment_reports", `comment_id = ?`, scope.publicCommentId)).toBe(0);
    expect(await count("publications", `file_id = ?`, fileId)).toBe(0);
    expect(await count("publication_links", `publication_id = ?`, publication.publicationId)).toBe(0);
    expect(await count("public_representations", `publication_id = ?`, publication.publicationId)).toBe(0);
    expect(await count("publication_authors", `publication_id = ?`, publication.publicationId)).toBe(0);
    expect(await count("publication_requests", `file_id = ?`, fileId)).toBe(0);
    expect(await count("pseudonym_update_items", `record_id IN (?, ?, ?)`,
      scope.privateAttributionId, scope.publicAttributionId, scope.authorDeclarationId)).toBe(0);
    expect(await count("key_envelopes", `object_id IN (?, ?, ?, ?)`,
      fileId, scope.privateThread.threadId, ...epochIds)).toBe(0);
    expect((await sharingRequest(collaborator, `/api/private/tree/files/${fileId}`)).status).toBe(404);
  });

  it("leaves an over-cap Directory and every dependent record unchanged", async () => {
    const owner = await sharingAccount(), collaborator = await sharingAccount(), reporter = await sharingAccount();
    const directoryId = await treeChild(owner, owner.rootId, "directory");
    const fileId = await treeChild(owner, directoryId, "file", owner.accountId, true);
    const scope = await publishFileWithDependents(owner, collaborator, reporter, fileId);
    const { publication } = scope;
    // Grow the subtree past the cap at the opaque storage boundary; the
    // over-cap refusal happens before any dependent is touched. The selected
    // Directory and the real File plus 499 seeded nodes make 501.
    const nodes = Array.from({ length: 499 }, (_, index) => ({ id: opaqueId(),
      kind: (index % 2 ? "directory" : "file") as "directory" | "file", parent: directoryId }));
    const serialized = JSON.stringify(nodes);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at)
        SELECT json_extract(value, '$.id'), json_extract(value, '$.kind'), ?, json_extract(value, '$.parent'), 1, 1
        FROM json_each(?)`).bind(owner.accountId, serialized),
      env.DB.prepare(`INSERT INTO directories (node_id, owner_id, entries_revision)
        SELECT json_extract(value, '$.id'), ?, 1 FROM json_each(?)
        WHERE json_extract(value, '$.kind') = 'directory'`).bind(owner.accountId, serialized),
      env.DB.prepare(`INSERT INTO files (node_id, owner_id, current_representation_id, current_revision)
        SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.id'), 1 FROM json_each(?)
        WHERE json_extract(value, '$.kind') = 'file'`).bind(owner.accountId, serialized),
      env.DB.prepare(`INSERT INTO file_representations (id, file_node_id, owner_id, revision,
        content_key_id, key_epoch, ciphertext, ciphertext_size, created_at)
        SELECT node_id, node_id, owner_id, 1, node_id, 1, X'01', 1, 1 FROM files
        WHERE owner_id = ? AND current_representation_id = node_id`).bind(owner.accountId),
      env.DB.prepare(`INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id,
        name_ciphertext, order_ciphertext, key_envelope)
        SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.parent'), X'01', X'01', X'01' FROM json_each(?)`)
        .bind(owner.accountId, serialized),
    ]);
    const state = {
      nodes: await count("vault_nodes", "owner_id = ?", owner.accountId),
      publications: await count("publications", "file_id = ?", fileId),
      comments: await count("comments", "thread_id IN (?, ?)",
        scope.privateThread.threadId, publication.epoch.threadId),
      reports: await count("public_comment_reports", "comment_id = ?", scope.publicCommentId),
      grants: await count("grants", "owner_id = ?", owner.accountId),
      items: await count("pseudonym_update_items", "record_id IN (?, ?, ?)",
        scope.privateAttributionId, scope.publicAttributionId, scope.authorDeclarationId),
      proofs: await count("device_proof_uses", "account_id = ?", owner.accountId),
    };
    const body = await deletePayload(owner, owner.accountId, directoryId, owner.rootId);
    const response = await sharingRequest(owner, `/api/private/tree/nodes/${directoryId}`, "DELETE", body);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "directory_too_large", maxNodes: 500 });
    expect({
      nodes: await count("vault_nodes", "owner_id = ?", owner.accountId),
      publications: await count("publications", "file_id = ?", fileId),
      comments: await count("comments", "thread_id IN (?, ?)",
        scope.privateThread.threadId, publication.epoch.threadId),
      reports: await count("public_comment_reports", "comment_id = ?", scope.publicCommentId),
      grants: await count("grants", "owner_id = ?", owner.accountId),
      items: await count("pseudonym_update_items", "record_id IN (?, ?, ?)",
        scope.privateAttributionId, scope.publicAttributionId, scope.authorDeclarationId),
      proofs: await count("device_proof_uses", "account_id = ?", owner.accountId),
    }).toEqual(state);
    expect((await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).status).toBe(200);
  });

  it("removes a deleted Public Comment's reports explicitly, without a database cascade", async () => {
    const owner = await sharingAccount(), reporter = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    const posted = await publicComment(owner, fileId, publication, "Reported then deleted");
    expect((await report(reporter, posted.commentId)).status).toBe(201);
    expect(await count("public_comment_reports", "comment_id = ?", posted.commentId)).toBe(1);

    const deleted = await sharingRequest(owner,
      `/api/private/comments/files/${fileId}/public/entries/${posted.commentId}`, "DELETE", {
        threadId: publication.epoch.threadId, capabilityId: publication.epoch.capabilityId, capabilityEpoch: 1,
        epochId: publication.epoch.epochId, expectedRevision: 1 });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await count("comments", "id = ?", posted.commentId)).toBe(0);
    expect(await count("public_comment_reports", "comment_id = ?", posted.commentId)).toBe(0);
  });

  it("removes Public Comment reports and staged pseudonym items in the bounded unpublish teardown", async () => {
    const owner = await sharingAccount(), reporter = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    const posted = await publicComment(owner, fileId, publication, "Reported then unpublished");
    expect((await report(reporter, posted.commentId)).status).toBe(201);
    await stagePseudonymItems(owner, [{ kind: "thread", recordId: posted.attributionId }]);
    expect(await count("pseudonym_update_items", "record_id = ?", posted.attributionId)).toBe(1);

    expect((await sharingRequest(owner, `/api/private/publications/files/${fileId}/unpublish`, "POST")).status).toBe(200);
    let progress: { done: boolean };
    do {
      const batch = await sharingRequest(owner, `/api/private/publications/files/${fileId}/teardown`, "POST");
      expect(batch.status, await batch.clone().text()).toBe(200);
      progress = await batch.json() as { done: boolean };
    } while (!progress.done);
    expect(await count("comments", "id = ?", posted.commentId)).toBe(0);
    expect(await count("public_comment_reports", "comment_id = ?", posted.commentId)).toBe(0);
    expect(await count("pseudonym_update_items", "record_id = ?", posted.attributionId)).toBe(0);
  });

  it("still hard-deletes a published File while the Owner is suspended from public participation", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    await publicComment(owner, fileId, publication, "Suspended hard delete");
    await applyPublicParticipationSuspension(env.DB, owner.accountId, "report_pattern");

    const body = await deletePayload(owner, owner.accountId, fileId, owner.rootId);
    const deleted = await sharingRequest(owner, `/api/private/tree/nodes/${fileId}`, "DELETE", body);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await count("publications", "file_id = ?", fileId)).toBe(0);
  });
});
