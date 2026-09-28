import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { ThreadKeySource } from "../../app/comments/client";
import { COMMENT_CHARACTER_LIMIT, CommentTextError, generateThreadKey, openAttribution, openComment,
  openPreviousThreadKey, openThreadKeyFromDevice, openThreadKeyFromReceiving, sealAttribution, sealComment,
  sealThreadKeyToDevice, sealThreadKeyToReceiving } from "../../app/comments/crypto";
import { openFileReceivingKey } from "../../app/crypto/file-receiving";
import { prepareTreeDelete, prepareTreeMove, type FileRotationSource } from "../../app/tree/structure-client";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/tree/wire";
import { actor, call, directory, legacyFile, state, treeIntegrity, uuid7, v2File, type Actor } from "./tree-fixtures";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const root = (who: Actor) => state(who, who.accountId, who.rootId, who.rootKey);
const files = (fileId: string) => `/api/private/comments/files/${fileId}`;
const comments = (commentId: string) => `/api/private/comments/comments/${commentId}`;
const importP256 = (raw: Uint8Array) => crypto.subtle.importKey("raw", new Uint8Array(raw),
  { name: "ECDH", namedCurve: "P-256" }, true, []);

async function budget(response: Response) {
  const [queries, bindings] = (response.headers.get("X-Mdwn-Sharing-Budget") ?? "").split(";").map(Number);
  expect(queries).toBeGreaterThan(0);
  expect(queries).toBeLessThanOrEqual(50);
  expect(bindings).toBeLessThanOrEqual(100);
}

async function grant(owner: Actor, recipient: Actor, target: string, kind: "file" | "directory",
  permission: "read_only" | "read_write") {
  const id = uuid7(), now = Date.now();
  await env.DB.prepare(`INSERT INTO grants (id, owner_id, recipient_id, target_node_id, target_kind, permission,
    generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .bind(id, owner.accountId, recipient.accountId, target, kind, permission, now, now).run();
  return id;
}

type Receiving = { pair: CryptoKeyPair; receivingKeyId: string; receivingEpoch: number; publicKey: Uint8Array };
/** A parent-capability reader opens the File receiving pair exactly as loadFile does. */
async function receiving(who: Actor, ownerId: string, fileId: string, parentKey: Uint8Array): Promise<Receiving> {
  const response = await call(who, `/api/private/tree/files/${fileId}`, "POST");
  expect(response.status).toBe(200);
  const file = await response.json() as { keyEnvelope: string; receivingPublicKey: string; receivingKeyId: string;
    receivingEpoch: number; wrapRevision: number };
  const publicKey = decodeTreeBytes(file.receivingPublicKey, 65);
  const pair = await openFileReceivingKey(decodeTreeBytes(file.keyEnvelope, 16_384), parentKey, { vaultId: ownerId,
    fileId, receivingKeyId: file.receivingKeyId, receivingEpoch: file.receivingEpoch, wrapRevision: file.wrapRevision,
    publicKey });
  return { pair, receivingKeyId: file.receivingKeyId, receivingEpoch: file.receivingEpoch, publicKey };
}

type WireDevice = { accountId: string; deviceId: string; registryEpoch: number; publicKey: string; provisioned: boolean };
type WireRead = { ownerId: string; fileId: string; legacy: boolean; canDeleteAny: boolean;
  receivingKeyId: string; receivingEpoch: number; nextCursor: string | null; directDevices: WireDevice[];
  thread: null | { threadId: string; epoch: number; deviceEnvelope: string | null; epochs: { epoch: number;
    keyId: string; receivingKeyId: string; receivingWrapper?: string; previousWrapper: string | null }[] };
  comments: { commentId: string; authorId: string; epoch: number; revision: number; ciphertext: string }[];
  attributions: { accountId: string; epoch: number; revision: number; ciphertext: string }[] };

async function read(who: Actor, fileId: string): Promise<{ status: number; body: WireRead; text: string }> {
  const response = await call(who, files(fileId), "POST");
  const text = await response.text();
  return { status: response.status, body: (response.ok ? JSON.parse(text) : null) as WireRead, text };
}

type Thread = { ownerId: string; threadId: string; keyId: string; epoch: number; key: Uint8Array };

async function deviceEnvelopes(thread: Thread, devices: readonly { deviceId: string; publicKey: string }[]) {
  return Promise.all(devices.map(async (device) => ({ deviceId: device.deviceId, ciphertext: encodeTreeBytes(
    await sealThreadKeyToDevice(thread.key, await importP256(decodeTreeBytes(device.publicKey, 65)),
      { ...thread, deviceId: device.deviceId })) })));
}

/** A thread-create body exactly as createPrivateThread builds it in the browser. */
async function threadBody(ownerId: string, target: Pick<Receiving, "receivingKeyId" | "receivingEpoch" | "publicKey">,
  devices: readonly { deviceId: string; publicKey: string }[]) {
  const thread: Thread = { ownerId, threadId: uuid7(), keyId: uuid7(), epoch: 1, key: generateThreadKey() };
  const receivingWrapper = await sealThreadKeyToReceiving(thread.key, await importP256(target.publicKey),
    { ...thread, receivingKeyId: target.receivingKeyId });
  return { thread, body: { threadId: thread.threadId, keyId: thread.keyId, receivingKeyId: target.receivingKeyId,
    receivingEpoch: target.receivingEpoch, receivingWrapper: encodeTreeBytes(receivingWrapper),
    deviceEnvelopes: await deviceEnvelopes(thread, devices) } };
}

async function createThread(who: Actor, ownerId: string, fileId: string, target: Receiving,
  devices: readonly { deviceId: string; publicKey: string }[] = []): Promise<Thread> {
  const { thread, body } = await threadBody(ownerId, target, devices);
  const response = await call(who, `${files(fileId)}/thread`, "PUT", body);
  expect(response.status, await response.clone().text()).toBe(201);
  await budget(response);
  return thread;
}

const pseudonym = (who: Actor) => `quiet-${who.accountId.slice(-6)}`;
async function attribution(who: Actor, thread: Thread, revision: number) {
  return { revision, ciphertext: encodeTreeBytes(await sealAttribution(thread.key, { ownerId: thread.ownerId,
    accountId: who.accountId, keyId: thread.keyId, epoch: thread.epoch, revision, pseudonym: pseudonym(who) })) };
}

async function commentBody(who: Actor, thread: Thread, text: string, attributionRevision: number | null,
  commentId = uuid7()) {
  const ciphertext = await sealComment(thread.key, { ownerId: thread.ownerId, commentId, keyId: thread.keyId,
    epoch: thread.epoch, revision: 1, authorId: who.accountId, text });
  return { commentId, threadId: thread.threadId, epoch: thread.epoch, ciphertext: encodeTreeBytes(ciphertext),
    attribution: attributionRevision === null ? null : await attribution(who, thread, attributionRevision) };
}

async function post(who: Actor, fileId: string, thread: Thread, text: string,
  attributionRevision: number | null): Promise<string> {
  const body = await commentBody(who, thread, text, attributionRevision);
  const response = await call(who, `${files(fileId)}/comments`, "PUT", body);
  expect(response.status, await response.clone().text()).toBe(201);
  await budget(response);
  return body.commentId;
}

async function editBody(who: Actor, thread: Thread, commentId: string, revision: number, text: string) {
  const ciphertext = await sealComment(thread.key, { ownerId: thread.ownerId, commentId, keyId: thread.keyId,
    epoch: thread.epoch, revision: revision + 1, authorId: who.accountId, text });
  return { expectedRevision: revision, epoch: thread.epoch, ciphertext: encodeTreeBytes(ciphertext), attribution: null };
}

/** Decrypts every Comment and pseudonym of one page with the thread key chain. */
async function plaintext(view: WireRead, current: Uint8Array) {
  const thread = view.thread!;
  const keys = new Map<number, Uint8Array>([[thread.epoch, current]]);
  const byEpoch = new Map(thread.epochs.map((item) => [item.epoch, item]));
  for (let epoch = thread.epoch; epoch > 1; epoch--) {
    keys.set(epoch - 1, await openPreviousThreadKey(decodeTreeBytes(byEpoch.get(epoch)!.previousWrapper!),
      keys.get(epoch)!, { ownerId: view.ownerId, threadId: thread.threadId, keyId: byEpoch.get(epoch - 1)!.keyId,
        epoch: epoch - 1 }));
  }
  const names = new Map(await Promise.all(view.attributions.map(async (item) => [item.accountId,
    await openAttribution(decodeTreeBytes(item.ciphertext), keys.get(item.epoch)!, { ownerId: view.ownerId,
      accountId: item.accountId, keyId: byEpoch.get(item.epoch)!.keyId, epoch: item.epoch,
      revision: item.revision })] as const)));
  return Promise.all(view.comments.map(async (item) => ({ authorId: item.authorId,
    pseudonym: names.get(item.authorId) ?? null,
    text: await openComment(decodeTreeBytes(item.ciphertext, 9216), keys.get(item.epoch)!, { ownerId: view.ownerId,
      commentId: item.commentId, keyId: byEpoch.get(item.epoch)!.keyId, epoch: item.epoch, revision: item.revision,
      authorId: item.authorId }) })));
}

const count = async (table: string, where: string, ...values: unknown[]) =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).bind(...values).first<{ n: number }>())!.n;
const threadOf = async (fileId: string) => (await env.DB.prepare(`SELECT id, current_epoch FROM comment_threads
  WHERE file_node_id = ?`).bind(fileId).first<{ id: string; current_epoch: number }>());
const fails = (statement: D1PreparedStatement) => expect(statement.run()).rejects.toThrow();

describe("Private Comment threads", () => {
  it("creates exactly one thread per File under a race, opened by the Owner through the receiving key", async () => {
    const owner = await actor();
    const fileId = await v2File(owner, owner.accountId, await root(owner), "notes.md");
    const before = await read(owner, fileId);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ legacy: false, canDeleteAny: true, thread: null, comments: [],
      directDevices: [] });
    const target = await receiving(owner, owner.accountId, fileId, owner.rootKey);
    const [a, b] = await Promise.all([threadBody(owner.accountId, target, []), threadBody(owner.accountId, target, [])]);
    const statuses = await Promise.all([a, b].map(async ({ body }) =>
      (await call(owner, `${files(fileId)}/thread`, "PUT", body)).status));
    expect(statuses.slice().sort()).toEqual([201, 409]);
    expect(await count("comment_threads", "file_node_id = ?", fileId)).toBe(1);
    const winner = statuses[0] === 201 ? a.thread : b.thread;

    const view = await read(owner, fileId);
    await budget(await call(owner, files(fileId), "POST"));
    expect(view.body.thread).toMatchObject({ threadId: winner.threadId, epoch: 1, deviceEnvelope: null });
    const opened = await openThreadKeyFromReceiving(decodeTreeBytes(view.body.thread!.epochs[0]!.receivingWrapper!),
      target.pair, { ...winner, receivingKeyId: target.receivingKeyId });
    expect(opened).toEqual(winner.key);
    // The schema itself admits one Private thread per File.
    await fails(env.DB.prepare(`INSERT INTO comment_threads (id, owner_id, file_node_id, audience, current_epoch,
      created_at) VALUES (?, ?, ?, 'private', 1, 0)`).bind(uuid7(), owner.accountId, fileId));
    // A thread targeting a stale receiving key is refused.
    const stale = await threadBody(owner.accountId, { ...target, receivingEpoch: 2 }, []);
    expect((await call(owner, `${files(fileId)}/thread`, "PUT", stale.body)).status).toBe(409);
  });

  it("gives a read-only direct Collaborator the normal composer through a provisioned device envelope", async () => {
    const owner = await actor(), reader = await actor();
    const fileId = await v2File(owner, owner.accountId, await root(owner), "shared.md");
    const target = await receiving(owner, owner.accountId, fileId, owner.rootKey);
    await grant(owner, reader, fileId, "file", "read_only");
    // Creation must include every current direct device.
    const missing = await threadBody(owner.accountId, target, []);
    expect(await (await call(owner, `${files(fileId)}/thread`, "PUT", missing.body)).json())
      .toEqual({ error: "recipients_changed" });
    const devices = (await read(owner, fileId)).body.directDevices;
    expect(devices).toEqual([expect.objectContaining({ accountId: reader.accountId, deviceId: reader.deviceId,
      provisioned: false })]);
    const thread = await createThread(owner, owner.accountId, fileId, target, devices);

    const own = await read(reader, fileId);
    expect(own.status).toBe(200);
    expect(own.body.canDeleteAny).toBe(false);
    expect(own.body.thread!.epochs[0]!.receivingWrapper).toBeUndefined();
    const key = await openThreadKeyFromDevice(decodeTreeBytes(own.body.thread!.deviceEnvelope!), reader.transport,
      { ...thread, deviceId: reader.deviceId });
    expect(key).toEqual(thread.key);

    const commentId = await post(reader, fileId, { ...thread, key }, "Looks right.\nOne question.", 1);
    await post(owner, fileId, thread, "Thanks", 1);
    const view = (await read(owner, fileId)).body;
    expect(await plaintext(view, thread.key)).toEqual([
      { authorId: reader.accountId, pseudonym: pseudonym(reader), text: "Looks right.\nOne question." },
      { authorId: owner.accountId, pseudonym: pseudonym(owner), text: "Thanks" }]);
    expect(view.comments[0]!.commentId).toBe(commentId);
    // The service stores only ciphertext.
    const stored = await env.DB.prepare("SELECT ciphertext FROM comments WHERE id = ?").bind(commentId)
      .first<{ ciphertext: ArrayBuffer }>();
    expect(new TextDecoder().decode(new Uint8Array(stored!.ciphertext))).not.toContain("Looks right");
  });

  it("lets any current reader provision a waiting direct device and replaces registry-stale envelopes", async () => {
    const owner = await actor(), reader = await actor();
    const fileId = await v2File(owner, owner.accountId, await root(owner), "later.md");
    const target = await receiving(owner, owner.accountId, fileId, owner.rootKey);
    const thread = await createThread(owner, owner.accountId, fileId, target);
    await grant(owner, reader, fileId, "file", "read_write");
    const waiting = await read(reader, fileId);
    expect(waiting.body.thread!.deviceEnvelope).toBeNull();
    const devices = (await read(owner, fileId)).body.directDevices;
    expect(devices.map((device) => device.provisioned)).toEqual([false]);
    // Only current direct devices may receive an envelope.
    const foreign = await deviceEnvelopes(thread, [{ deviceId: owner.deviceId, publicKey: encodeTreeBytes(
      new Uint8Array(await crypto.subtle.exportKey("raw", owner.transport.publicKey))) }]);
    expect((await call(owner, `${files(fileId)}/thread/devices`, "PATCH", { threadId: thread.threadId, epoch: 1,
      deviceEnvelopes: foreign })).status).toBe(409);
    const body = { threadId: thread.threadId, epoch: 1, deviceEnvelopes: await deviceEnvelopes(thread, devices) };
    const provisioned = await call(owner, `${files(fileId)}/thread/devices`, "PATCH", body);
    expect(await provisioned.clone().json()).toEqual({ provisioned: 1 });
    await budget(provisioned);
    expect((await call(owner, `${files(fileId)}/thread/devices`, "PATCH", body)).status).toBe(409);
    expect((await read(reader, fileId)).body.thread!.deviceEnvelope).not.toBeNull();

    // The reader enrolls a second device: every envelope from the old registry is stale.
    const second = await actor();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key,
        state, approval_provenance, registry_epoch, created_at) SELECT ?, ?, transport_public_key,
        assertion_public_key, 'active', 'enrollment', 2, ? FROM encryption_devices WHERE id = ?`)
        .bind(uuid7(), reader.accountId, Date.now(), second.deviceId),
      env.DB.prepare("UPDATE account_encryption_identities SET registry_epoch = 2 WHERE account_id = ?")
        .bind(reader.accountId),
    ]);
    expect((await read(reader, fileId)).body.thread!.deviceEnvelope).toBeNull();
    const now = (await read(reader, fileId)).body.directDevices;
    expect(now.map((device) => device.provisioned)).toEqual([false, false]);
    // A read/write reader provisions both of its own devices through its (stale-free) key.
    const refreshed = await call(owner, `${files(fileId)}/thread/devices`, "PATCH", { threadId: thread.threadId,
      epoch: 1, deviceEnvelopes: await deviceEnvelopes(thread, now) });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    expect(await count("comment_thread_device_envelopes", "thread_id = ? AND registry_epoch = 2", thread.threadId))
      .toBe(2);
    const key = await openThreadKeyFromDevice(decodeTreeBytes((await read(reader, fileId)).body.thread!.deviceEnvelope!),
      reader.transport, { ...thread, deviceId: reader.deviceId });
    expect(key).toEqual(thread.key);
  });

  it("lets only the author edit, and the Owner hard-delete any Comment but never edit another body", async () => {
    const owner = await actor(), reader = await actor();
    const folder = await directory(owner, owner.accountId, await root(owner), "Team");
    const fileId = await v2File(owner, owner.accountId, await state(owner, owner.accountId, folder.nodeId, folder.key),
      "plan.md");
    await grant(owner, reader, folder.nodeId, "directory", "read_only");
    // A Directory reader reaches the thread through the receiving key, like the Owner.
    const readerTarget = await receiving(reader, owner.accountId, fileId, folder.key);
    const thread = await createThread(reader, owner.accountId, fileId, readerTarget);
    const readerView = await read(reader, fileId);
    expect(readerView.body.canDeleteAny).toBe(false);
    expect(readerView.body.thread!.epochs[0]!.receivingWrapper).toBeDefined();
    const mine = await post(reader, fileId, thread, "reader text", 1);
    const theirs = await post(owner, fileId, thread, "owner text", 1);

    // Nobody edits another author's body: the Owner's edit is indistinguishable from a missing Comment.
    const ownerEdit = await editBody(owner, thread, mine, 1, "rewritten");
    ownerEdit.ciphertext = encodeTreeBytes(await sealComment(thread.key, { ownerId: owner.accountId, commentId: mine,
      keyId: thread.keyId, epoch: 1, revision: 2, authorId: reader.accountId, text: "rewritten" }));
    expect((await call(owner, comments(mine), "PATCH", ownerEdit)).status).toBe(404);
    expect((await call(reader, comments(theirs), "PATCH", await editBody(reader, thread, theirs, 1, "x"))).status)
      .toBe(404);
    // The author edits once per revision; a wrong revision context is refused.
    const wrong = await editBody(reader, thread, mine, 1, "edited");
    wrong.ciphertext = (await commentBody(reader, thread, "edited", null, mine)).ciphertext;
    expect((await call(reader, comments(mine), "PATCH", wrong)).status).toBe(400);
    const edit = await editBody(reader, thread, mine, 1, "edited");
    const edited = await call(reader, comments(mine), "PATCH", edit);
    expect(await edited.clone().json()).toMatchObject({ commentId: mine, revision: 2 });
    await budget(edited);
    expect((await call(reader, comments(mine), "PATCH", edit)).status).toBe(409);
    expect((await plaintext((await read(owner, fileId)).body, thread.key)).map((item) => item.text))
      .toEqual(["edited", "owner text"]);

    // Deletion: never another author's Comment unless you are the Owner.
    expect((await call(reader, comments(theirs), "DELETE")).status).toBe(404);
    const removed = await call(owner, comments(mine), "DELETE");
    expect(removed.status).toBe(200);
    await budget(removed);
    const again = await post(reader, fileId, thread, "second", null);
    expect((await call(reader, comments(again), "DELETE")).status).toBe(200);
    expect((await call(reader, comments(again), "DELETE")).status).toBe(404);
    expect(await count("comments", "thread_id = ?", thread.threadId)).toBe(1);

    // Storage rules hold without the API: no reattribution, no revision skip.
    await fails(env.DB.prepare("UPDATE comments SET author_id = ? WHERE id = ?").bind(reader.accountId, theirs));
    await fails(env.DB.prepare("UPDATE comments SET revision = revision + 2 WHERE id = ?").bind(theirs));
  });

  it("enforces epoch, attribution and plain-text rules at the API and storage boundary", async () => {
    const owner = await actor(), stranger = await actor();
    const fileId = await v2File(owner, owner.accountId, await root(owner), "rules.md");
    const target = await receiving(owner, owner.accountId, fileId, owner.rootKey);
    const thread = await createThread(owner, owner.accountId, fileId, target);
    const put = (body: object, who = owner) => call(who, `${files(fileId)}/comments`, "PUT", body);

    // A first Comment must declare the author's pseudonym at revision 1 under the current epoch.
    expect((await put(await commentBody(owner, thread, "hi", null))).status).toBe(400);
    expect((await put(await commentBody(owner, thread, "hi", 2))).status).toBe(400);
    expect((await put({ ...await commentBody(owner, thread, "hi", 1), epoch: 2 })).status).toBe(409);
    // A Comment sealed for another Comment ID or epoch is refused structurally.
    const moved = await commentBody(owner, thread, "hi", 1);
    expect((await put({ ...moved, commentId: uuid7() })).status).toBe(400);
    const future = await commentBody(owner, { ...thread, epoch: 2 }, "hi", null);
    expect((await put({ ...future, epoch: 1 })).status).toBe(400);
    await post(owner, fileId, thread, "first", 1);
    // Once declared at this epoch none is needed; a replacement (a pseudonym change) takes the next revision.
    expect((await put(await commentBody(owner, thread, "hi", 1))).status).toBe(400);
    await post(owner, fileId, thread, "second", null);
    await post(owner, fileId, thread, "renamed", 2);
    // No File-read access: indistinguishable from a missing File.
    const outsider = await put(await commentBody(stranger, thread, "hi", 1), stranger);
    expect(outsider.status).toBe(404);
    expect((await read(stranger, fileId)).status).toBe(404);

    // Plain text only: at most 2,000 code points, line breaks kept, other controls refused.
    await expect(sealComment(thread.key, { ownerId: owner.accountId, commentId: uuid7(), keyId: thread.keyId,
      epoch: 1, revision: 1, authorId: owner.accountId, text: "x".repeat(COMMENT_CHARACTER_LIMIT + 1) }))
      .rejects.toBeInstanceOf(CommentTextError);
    await expect(sealComment(thread.key, { ownerId: owner.accountId, commentId: uuid7(), keyId: thread.keyId,
      epoch: 1, revision: 1, authorId: owner.accountId, text: "bell\u0007" })).rejects.toBeInstanceOf(CommentTextError);
    await post(owner, fileId, thread, "😀".repeat(COMMENT_CHARACTER_LIMIT), null);
    const markup = await post(owner, fileId, thread, "<b>**not bold**</b>\r\nnext", null);
    const texts = await plaintext((await read(owner, fileId)).body, thread.key);
    expect(texts.at(-1)!.text).toBe("<b>**not bold**</b>\nnext");
    expect(markup).toBeTruthy();
    const huge = { ...await commentBody(owner, thread, "x", null), ciphertext: encodeTreeBytes(new Uint8Array(9217)) };
    expect((await put(huge)).status).toBe(400);

    // Storage: epochs only move forward by one; Comments and declarations use the current epoch.
    await fails(env.DB.prepare("UPDATE comment_threads SET current_epoch = 3 WHERE id = ?").bind(thread.threadId));
    await fails(env.DB.prepare("UPDATE comment_threads SET current_epoch = 0 WHERE id = ?").bind(thread.threadId));
    await fails(env.DB.prepare(`INSERT INTO comments (id, thread_id, author_id, epoch, revision, ciphertext,
      created_at, updated_at) VALUES (?, ?, ?, 1, 2, X'01', 0, 0)`).bind(uuid7(), thread.threadId, owner.accountId));
    await fails(env.DB.prepare(`INSERT INTO comment_thread_device_envelopes (thread_id, epoch, recipient_id,
      device_id, registry_epoch, ciphertext, digest) VALUES (?, 1, ?, ?, 1, X'01', zeroblob(32))`)
      .bind(thread.threadId, stranger.accountId, stranger.deviceId));
  });

  it("serves a revoked device no thread material and removes its envelopes with the Grant", async () => {
    const owner = await actor(), reader = await actor();
    const fileId = await v2File(owner, owner.accountId, await root(owner), "revoked.md");
    const target = await receiving(owner, owner.accountId, fileId, owner.rootKey);
    const grantId = await grant(owner, reader, fileId, "file", "read_only");
    const thread = await createThread(owner, owner.accountId, fileId, target,
      (await read(owner, fileId)).body.directDevices);
    const mine = await post(reader, fileId, thread, "before revocation", 1);
    expect(await count("comment_thread_device_envelopes", "thread_id = ?", thread.threadId)).toBe(1);

    const revoked = await call(owner, `/api/private/sharing/grants/${grantId}`, "DELETE");
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect(await count("comment_thread_device_envelopes", "thread_id = ?", thread.threadId)).toBe(0);
    const after = await read(reader, fileId);
    expect(after.status).toBe(404);
    expect(after.text).toBe(JSON.stringify({ error: "not_found" }));
    expect((await call(reader, `${files(fileId)}/thread`, "POST")).status).toBe(404);
    expect((await call(reader, `${files(fileId)}/comments`, "PUT",
      await commentBody(reader, thread, "after", null))).status).toBe(404);
    expect((await call(reader, comments(mine), "PATCH", await editBody(reader, thread, mine, 1, "after"))).status)
      .toBe(404);
    expect((await call(reader, comments(mine), "DELETE")).status).toBe(404);
    // Revocation raised a rotation barrier: new writes wait for rotation, Owner deletion does not.
    expect(await (await call(owner, `${files(fileId)}/comments`, "PUT",
      await commentBody(owner, thread, "held", 1))).json()).toEqual({ error: "rotation_pending" });
    expect((await call(owner, comments(mine), "DELETE")).status).toBe(200);
  });

  it("pages a long thread oldest first in pages of 200", async () => {
    const owner = await actor();
    const fileId = await v2File(owner, owner.accountId, await root(owner), "long.md");
    const thread = await createThread(owner, owner.accountId, fileId,
      await receiving(owner, owner.accountId, fileId, owner.rootKey));
    const ids = Array.from({ length: 201 }, () => uuid7()).sort();
    await env.DB.batch(ids.map((id, index) => env.DB.prepare(`INSERT INTO comments (id, thread_id, author_id, epoch,
      revision, ciphertext, created_at, updated_at) VALUES (?, ?, ?, 1, 1, X'01', ?, ?)`)
      .bind(id, thread.threadId, owner.accountId, 1_000 + index, 1_000 + index)));
    const first = (await read(owner, fileId)).body;
    expect(first.comments.map((item) => item.commentId)).toEqual(ids.slice(0, 200));
    expect(first.nextCursor).toBe(ids[199]);
    const next = await call(owner, files(fileId), "POST", { cursor: first.nextCursor! });
    await budget(next);
    const second = await next.json() as WireRead;
    expect(second.comments.map((item) => item.commentId)).toEqual([ids[200]]);
    expect(second.nextCursor).toBeNull();
    expect((await call(owner, files(fileId), "POST", { cursor: "not-an-id" })).status).toBe(400);
  });

  it("keeps a legacy File without a thread until it is migrated", async () => {
    const owner = await actor();
    const fileId = await legacyFile(owner, owner.accountId, await root(owner), "old.md");
    const view = await read(owner, fileId);
    expect(view.body).toMatchObject({ legacy: true, thread: null, comments: [] });
    const target = { receivingKeyId: uuid7(), receivingEpoch: 1, publicKey: new Uint8Array(await crypto.subtle
      .exportKey("raw", owner.transport.publicKey)) };
    expect((await call(owner, `${files(fileId)}/thread`, "PUT",
      (await threadBody(owner.accountId, target, [])).body)).status).toBe(404);
  });
});

describe("Private threads under structural changes", () => {
  async function threadSource(who: Actor, fileId: string): Promise<ThreadKeySource> {
    const response = await call(who, `${files(fileId)}/thread`, "POST");
    expect(response.status).toBe(200);
    await budget(response);
    return response.json() as Promise<ThreadKeySource>;
  }
  async function fileSource(who: Actor, fileId: string): Promise<FileRotationSource> {
    return (await call(who, `/api/private/tree/files/${fileId}`, "POST")).json() as Promise<FileRotationSource>;
  }

  it("moves a v2 File to a new thread epoch sealed to its new receiving key, keeping history", async () => {
    const owner = await actor(), reader = await actor();
    const a = await directory(owner, owner.accountId, await root(owner), "A");
    const b = await directory(owner, owner.accountId, await root(owner), "B");
    const fileId = await v2File(owner, owner.accountId, await state(owner, owner.accountId, a.nodeId, a.key), "m.md");
    await grant(owner, reader, fileId, "file", "read_only");
    const target = await receiving(owner, owner.accountId, fileId, a.key);
    const thread = await createThread(owner, owner.accountId, fileId, target,
      (await read(owner, fileId)).body.directDevices);
    await post(owner, fileId, thread, "before the move", 1);

    const source = await state(owner, owner.accountId, a.nodeId, a.key);
    const destination = await state(owner, owner.accountId, b.nodeId, b.key);
    const stale = await prepareTreeMove({ vaultId: owner.accountId, signer: owner.signer, source, destination,
      nodeId: fileId, file: await fileSource(owner, fileId), thread: { ...await threadSource(owner, fileId),
        thread: null } });
    // A move that ignores an existing thread is refused and changes nothing.
    expect(await (await call(owner, `/api/private/tree/nodes/${fileId}/parent`, "PATCH", stale)).json())
      .toEqual({ error: "file_changed" });
    const body = await prepareTreeMove({ vaultId: owner.accountId, signer: owner.signer, source, destination,
      nodeId: fileId, file: await fileSource(owner, fileId), thread: await threadSource(owner, fileId) });
    const moved = await call(owner, `/api/private/tree/nodes/${fileId}/parent`, "PATCH", body);
    expect(moved.status, await moved.clone().text()).toBe(200);
    await budget(moved);
    expect(await threadOf(fileId)).toEqual({ id: thread.threadId, current_epoch: 2 });

    const next = await receiving(owner, owner.accountId, fileId, b.key);
    expect(next.receivingEpoch).toBe(target.receivingEpoch + 1);
    const view = (await read(owner, fileId)).body;
    const epoch2 = view.thread!.epochs.find((item) => item.epoch === 2)!;
    expect(epoch2.receivingKeyId).toBe(next.receivingKeyId);
    const key = await openThreadKeyFromReceiving(decodeTreeBytes(epoch2.receivingWrapper!), next.pair,
      { ownerId: owner.accountId, threadId: thread.threadId, keyId: epoch2.keyId, epoch: 2,
        receivingKeyId: next.receivingKeyId });
    expect(key).not.toEqual(thread.key);
    // The old key is chained, so history stays readable; the direct reader was re-enveloped.
    expect((await plaintext(view, key)).map((item) => item.text)).toEqual(["before the move"]);
    const readerKey = await openThreadKeyFromDevice(decodeTreeBytes((await read(reader, fileId)).body.thread!
      .deviceEnvelope!), reader.transport, { ownerId: owner.accountId, threadId: thread.threadId,
      keyId: epoch2.keyId, epoch: 2, deviceId: reader.deviceId });
    expect(readerKey).toEqual(key);
    // New writes use the new epoch and need a fresh pseudonym declaration.
    const current = { ...thread, keyId: epoch2.keyId, epoch: 2, key };
    expect((await call(owner, `${files(fileId)}/comments`, "PUT",
      await commentBody(owner, thread, "old epoch", null))).status).toBe(409);
    await post(owner, fileId, current, "after the move", 2);
    expect((await plaintext((await read(owner, fileId)).body, key)).map((item) => item.pseudonym))
      .toEqual([pseudonym(owner), pseudonym(owner)]);
  });

  it("hard-deletes a File's thread, Comments, envelopes and declarations with the File", async () => {
    const owner = await actor(), reader = await actor();
    const folder = await directory(owner, owner.accountId, await root(owner), "Doomed");
    const fileId = await v2File(owner, owner.accountId, await state(owner, owner.accountId, folder.nodeId, folder.key),
      "gone.md");
    await grant(owner, reader, fileId, "file", "read_only");
    const target = await receiving(owner, owner.accountId, fileId, folder.key);
    const thread = await createThread(owner, owner.accountId, fileId, target,
      (await read(owner, fileId)).body.directDevices);
    await post(owner, fileId, thread, "bye", 1);
    await post(reader, fileId, thread, "bye too", 1);
    const parent = await root(owner);
    const response = await call(owner, `/api/private/tree/nodes/${folder.nodeId}`, "DELETE",
      await prepareTreeDelete({ vaultId: owner.accountId, signer: owner.signer, parent, nodeId: folder.nodeId }));
    expect(response.status, await response.clone().text()).toBe(200);
    await budget(response);
    for (const table of ["comments", "thread_attributions", "comment_thread_device_envelopes",
      "comment_thread_epochs"]) expect(await count(table, "thread_id = ?", thread.threadId)).toBe(0);
    expect(await threadOf(fileId)).toBeNull();
    expect(await treeIntegrity(owner.accountId)).toEqual({ broken: 0, markers: 0 });
  });
});
