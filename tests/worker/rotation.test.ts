import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { ThreadKeySource } from "../../app/comments/client";
import { generateThreadKey, openComment, openPreviousThreadKey, openThreadKeyFromDevice, openThreadKeyFromReceiving,
  sealAttribution, sealComment, sealThreadKeyToDevice, sealThreadKeyToReceiving } from "../../app/comments/crypto";
import { inspectEnvelope, openForRecipient, openSymmetric } from "../../app/crypto/enc-v1";
import { openFileContentKeyFromDevice, openFileContentKeyFromReceiving,
  openFileReceivingKey } from "../../app/crypto/file-receiving";
import { decodeFileRepresentation } from "../../app/crypto/vault";
import { prepareDirectoryRekey, prepareFileTargetRotation, prepareReceivingRekey, type RotationFile,
  type RotationStep } from "../../app/sharing/rotation-client";
import { verifyFileHead } from "../../app/tree/file-head";
import { openListingHead, type SealedEntry, type StoredListingHead } from "../../app/tree/listing";
import type { DirectoryState } from "../../app/tree/structure-client";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/tree/wire";
import { actor, call, directory, legacyFile, shareDirectory, state, uuid7, v2File, type Actor } from "./tree-fixtures";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const root = (who: Actor) => state(who, who.accountId, who.rootId, who.rootKey);

async function grant(owner: Actor, recipient: Actor, target: string, kind: "file" | "directory",
  permission: "read_only" | "read_write") {
  const id = uuid7(), now = Date.now();
  await env.DB.prepare(`INSERT INTO grants (id, owner_id, recipient_id, target_node_id, target_kind, permission,
    generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .bind(id, owner.accountId, recipient.accountId, target, kind, permission, now, now).run();
  return id;
}

async function job(ownerId: string, targetId: string) {
  return env.DB.prepare(`SELECT mode, barrier_epoch, cursor FROM sharing_rotation_jobs
    WHERE owner_id = ? AND target_node_id = ?`).bind(ownerId, targetId)
    .first<{ mode: string; barrier_epoch: number; cursor: string | null }>();
}

describe("rotation jobs", () => {
  it("records reprovision for a permission change and never weakens a pending rekey", async () => {
    const owner = await actor(), a = await actor(), b = await actor();
    const folder = await directory(owner, owner.accountId, await root(owner), "Team");
    const first = await grant(owner, a, folder.nodeId, "directory", "read_only");
    const second = await grant(owner, b, folder.nodeId, "directory", "read_only");
    expect((await call(owner, `/api/private/sharing/grants/${first}`, "PATCH", { permission: "read_write" })).status)
      .toBe(200);
    expect(await job(owner.accountId, folder.nodeId)).toMatchObject({ mode: "reprovision", cursor: null });
    expect((await call(owner, `/api/private/sharing/grants/${first}`, "DELETE")).status).toBe(200);
    expect(await job(owner.accountId, folder.nodeId)).toMatchObject({ mode: "rekey" });
    // A later permission change on another Grant keeps the rekey and restarts it at a new barrier epoch.
    const before = (await job(owner.accountId, folder.nodeId))!.barrier_epoch;
    expect((await call(owner, `/api/private/sharing/grants/${second}`, "PATCH", { permission: "read_write" })).status)
      .toBe(200);
    expect(await job(owner.accountId, folder.nodeId)).toMatchObject({ mode: "rekey", cursor: null });
    expect((await job(owner.accountId, folder.nodeId))!.barrier_epoch).toBeGreaterThan(before);
  });

  it("only advances a Directory capability epoch by one", async () => {
    const owner = await actor();
    const folder = await directory(owner, owner.accountId, await root(owner), "Epochs");
    const set = (epoch: number) => env.DB.prepare("UPDATE directories SET capability_epoch = ? WHERE node_id = ?")
      .bind(epoch, folder.nodeId).run();
    await expect(set(3)).rejects.toThrow();
    await expect(set(1)).rejects.toThrow();
    await set(2);
    await expect(set(1)).rejects.toThrow();
  });

  it("never shares the hidden root", async () => {
    const owner = await actor(), recipient = await actor();
    const response = await call(owner, "/api/private/sharing/target", "POST",
      { targetId: owner.rootId, kind: "directory", recipientId: recipient.accountId });
    expect(response.status).toBe(404);
    const folder = await directory(owner, owner.accountId, await root(owner), "Shareable");
    expect((await call(owner, "/api/private/sharing/target", "POST",
      { targetId: folder.nodeId, kind: "directory", recipientId: recipient.accountId })).status).toBe(200);
  });
});

async function budget(response: Response) {
  const [queries, bindings] = (response.headers.get("X-Mdwn-Sharing-Budget") ?? "").split(";").map(Number);
  expect(queries).toBeGreaterThan(0);
  expect(queries).toBeLessThanOrEqual(50);
  expect(bindings).toBeLessThanOrEqual(100);
}
const raw = async (key: CryptoKey) => new Uint8Array(await crypto.subtle.exportKey("raw", key));
const importP256 = (value: Uint8Array) => crypto.subtle.importKey("raw", new Uint8Array(value),
  { name: "ECDH", namedCurve: "P-256" }, true, []);
const count = async (table: string, where: string, ...values: unknown[]) =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).bind(...values).first<{ n: number }>())!.n;

describe("File-target rotation", () => {
  it("drops a revoked direct reader from the signed head and moves the thread to a new epoch", async () => {
    const owner = await actor(), removed = await actor(), kept = await actor();
    const fileId = await v2File(owner, owner.accountId, await root(owner), "direct.md", "# shared");
    await grant(owner, removed, fileId, "file", "read_only");
    const keptGrant = await grant(owner, kept, fileId, "file", "read_write");
    const removedGrant = (await env.DB.prepare("SELECT id FROM grants WHERE recipient_id = ?")
      .bind(removed.accountId).first<{ id: string }>())!.id;
    // A Private thread both direct readers can open.
    const head = await (await call(owner, `/api/private/tree/files/${fileId}`, "POST")).json() as RotationFile & {
      receivingKeyId: string; receivingEpoch: number };
    const threadKey = generateThreadKey(), threadId = uuid7(), keyId = uuid7();
    const identity = { ownerId: owner.accountId, threadId, keyId, epoch: 1 };
    const devices = [removed, kept];
    const created = await call(owner, `/api/private/comments/files/${fileId}/thread`, "PUT", { threadId, keyId,
      receivingKeyId: head.receivingKeyId, receivingEpoch: head.receivingEpoch,
      receivingWrapper: encodeTreeBytes(await sealThreadKeyToReceiving(threadKey,
        await importP256(decodeTreeBytes(head.receivingPublicKey, 65)), { ...identity, receivingKeyId: head.receivingKeyId })),
      deviceEnvelopes: await Promise.all(devices.map(async (who) => ({ deviceId: who.deviceId,
        ciphertext: encodeTreeBytes(await sealThreadKeyToDevice(threadKey, who.transport.publicKey,
          { ...identity, deviceId: who.deviceId })) }))) });
    expect(created.status, await created.clone().text()).toBe(201);

    expect((await call(owner, `/api/private/sharing/grants/${removedGrant}`, "DELETE")).status).toBe(200);
    expect(await job(owner.accountId, fileId)).toMatchObject({ mode: "rekey" });
    const next = await call(owner, `/api/private/rotations/${fileId}/next`, "POST");
    expect(next.status, await next.clone().text()).toBe(200);
    await budget(next);
    const step = await next.json() as Extract<RotationStep, { step: "file" }>;
    expect(step).toMatchObject({ step: "file", fileId, mode: "rekey" });
    expect(step.recipients.map((item) => item.deviceId)).toEqual([kept.deviceId]);
    // Only the Owner runs rotation.
    expect((await call(kept, `/api/private/rotations/${fileId}/next`, "POST")).status).toBe(404);

    const parent = await root(owner);
    const body = await prepareFileTargetRotation({ vaultId: owner.accountId, signer: owner.signer, parent,
      entry: parent.listing.entries.find((entry) => entry.nodeId === fileId)!, file: { ...head, fileId }, step,
      thread: await (await call(owner, `/api/private/comments/files/${fileId}/thread`, "POST")).json() as ThreadKeySource });
    const done = await call(owner, `/api/private/rotations/${fileId}/file`, "PATCH", body);
    expect(done.status, await done.clone().text()).toBe(200);
    await budget(done);
    expect(await job(owner.accountId, fileId)).toBeNull();
    expect(await count("rotation_barriers", "target_node_id = ?", fileId)).toBe(0);
    expect((await call(owner, `/api/private/rotations/${fileId}/file`, "PATCH", body)).status).toBe(404);

    // The signed head now names exactly the remaining reader at its Grant generation.
    const after = await (await call(owner, `/api/private/tree/files/${fileId}`, "POST")).json() as RotationFile;
    const verified = await verifyFileHead({ bytes: decodeTreeBytes(after.fileHead.bytes, 131_072),
      digest: decodeTreeBytes(after.fileHead.digest, 32), signature: decodeTreeBytes(after.fileHead.signature, 64) },
    { ownerId: owner.accountId, vaultId: owner.accountId, fileId, revision: after.revision,
      signerDeviceId: owner.deviceId, publicKey: await raw(owner.assertion.publicKey) });
    expect(verified.statement.recipients.map((item) => [item.deviceId, item.grants])).toEqual([
      [kept.deviceId, [{ id: keptGrant, generation: 1 }]]]);
    // The kept reader opens the same File key through its fresh envelope and the new thread epoch.
    const direct = await (await call(kept, `/api/private/sharing/direct-files/${fileId}`, "POST")).json() as {
      recipientEnvelope: string; contentKeyId: string; keyEpoch: number; revision: number };
    await openFileContentKeyFromDevice(decodeTreeBytes(direct.recipientEnvelope, 16_384), kept.transport,
      { vaultId: owner.accountId, fileId, contentKeyId: direct.contentKeyId, contentEpoch: direct.keyEpoch,
        revision: direct.revision, deviceId: kept.deviceId });
    const view = await (await call(kept, `/api/private/comments/files/${fileId}`, "POST")).json() as {
      thread: { epoch: number; deviceEnvelope: string; epochs: { epoch: number; keyId: string }[] } };
    expect(view.thread.epoch).toBe(2);
    const epoch2 = view.thread.epochs.find((item) => item.epoch === 2)!;
    const newKey = await openThreadKeyFromDevice(decodeTreeBytes(view.thread.deviceEnvelope, 4096), kept.transport,
      { ownerId: owner.accountId, threadId, keyId: epoch2.keyId, epoch: 2, deviceId: kept.deviceId });
    expect(newKey).not.toEqual(threadKey);
    expect(await count("comment_thread_device_envelopes", "thread_id = ? AND device_id = ?", threadId,
      removed.deviceId)).toBe(0);
    expect((await call(removed, `/api/private/comments/files/${fileId}`, "POST")).status).toBe(404);
  });
});

/** The Owner's verified key chain from the root down to a node (its own state too, for a Directory). */
async function chain(owner: Actor, nodeId: string): Promise<Map<string, DirectoryState>> {
  const path = (await (await call(owner, `/api/private/tree/nodes/${nodeId}/ancestors`, "POST")).json() as {
    ancestors: string[] }).ancestors;
  const states = new Map<string, DirectoryState>();
  let key: Uint8Array = owner.rootKey;
  for (let index = 0; index < path.length; index++) {
    const current = await state(owner, owner.accountId, path[index]!, key);
    states.set(path[index]!, current);
    const entry = current.listing.entries.find((item) => item.nodeId === path[index + 1]);
    if (!entry || entry.kind !== "directory") break;
    const envelope = decodeTreeBytes(entry.keyEnvelope);
    key = await openSymmetric(envelope, current.key, { context: inspectEnvelope(envelope).context });
  }
  return states;
}

async function receivingPair(owner: Actor, fileId: string, parentKey: Uint8Array) {
  const file = await (await call(owner, `/api/private/tree/files/${fileId}`, "POST")).json() as RotationFile & {
    keyEnvelope: string; receivingKeyId: string; receivingEpoch: number; wrapRevision: number; ciphertext: string };
  const pair = await openFileReceivingKey(decodeTreeBytes(file.keyEnvelope, 16_384), parentKey, {
    vaultId: owner.accountId, fileId, receivingKeyId: file.receivingKeyId, receivingEpoch: file.receivingEpoch,
    wrapRevision: file.wrapRevision, publicKey: decodeTreeBytes(file.receivingPublicKey, 65) });
  return { file, pair };
}

async function markdown(owner: Actor, fileId: string, parentKey: Uint8Array): Promise<string> {
  const { file, pair } = await receivingPair(owner, fileId, parentKey);
  const key = await openFileContentKeyFromReceiving(decodeTreeBytes(file.parentEnvelope, 16_384), pair, {
    vaultId: owner.accountId, fileId, revision: file.revision, contentKeyId: file.contentKeyId,
    contentEpoch: file.keyEpoch, receivingKeyId: file.receivingKeyId });
  return decodeFileRepresentation(await openSymmetric(decodeTreeBytes(file.ciphertext, 524_288), key, { context: {
    purpose: "file-content", vaultId: owner.accountId, objectId: fileId, keyId: file.contentKeyId,
    keyEpoch: file.keyEpoch, revision: file.revision } })).markdown;
}

async function legacyMarkdown(owner: Actor, fileId: string, parentKey: Uint8Array): Promise<string> {
  const file = await (await call(owner, `/api/private/tree/files/${fileId}`, "POST")).json() as {
    ciphertext: string; keyEnvelope: string; revision: number; contentKeyId: string; keyEpoch: number };
  const context = { vaultId: owner.accountId, objectId: fileId, keyId: file.contentKeyId, keyEpoch: file.keyEpoch,
    revision: file.revision };
  const key = await openSymmetric(decodeTreeBytes(file.keyEnvelope, 16_384), parentKey,
    { context: { ...context, purpose: "file-content-key" } });
  return decodeFileRepresentation(await openSymmetric(decodeTreeBytes(file.ciphertext, 524_288), key,
    { context: { ...context, purpose: "file-content" } })).markdown;
}

/** Drives a rekey job with the Owner's fixture keys exactly as the browser runner would. */
async function runSteps(owner: Actor, targetId: string, limit = 50): Promise<string[]> {
  const done: string[] = [];
  while (done.length < limit) {
    const next = await call(owner, `/api/private/rotations/${targetId}/next`, "POST");
    if (next.status === 404) return done;
    expect(next.status, await next.clone().text()).toBe(200);
    await budget(next);
    const step = await next.json() as RotationStep;
    let response: Response;
    if (step.step === "directory") {
      const states = await chain(owner, step.directoryId);
      response = await call(owner, `/api/private/rotations/${targetId}/directory`, "PATCH",
        await prepareDirectoryRekey({ vaultId: owner.accountId, signer: owner.signer,
          parent: states.get(step.parentId)!, directory: states.get(step.directoryId)!, step }));
      done.push(`directory:${step.directoryId}`);
    } else if (step.step === "receiving") {
      const states = await chain(owner, step.fileId);
      const file = await (await call(owner, `/api/private/tree/files/${step.fileId}`, "POST")).json() as RotationFile;
      const thread = await (await call(owner, `/api/private/comments/files/${step.fileId}/thread`, "POST"))
        .json() as ThreadKeySource;
      response = await call(owner, `/api/private/rotations/${targetId}/receiving`, "PATCH",
        await prepareReceivingRekey({ vaultId: owner.accountId, signer: owner.signer,
          parent: states.get(step.parentId)!, file, thread, step }));
      done.push(`receiving:${step.fileId}`);
    } else if (step.step === "finish") {
      response = await call(owner, `/api/private/rotations/${targetId}/finish`, "PATCH",
        { barrierEpoch: step.barrierEpoch });
      done.push("finish");
    } else throw new Error(`unexpected step ${step.step}`);
    expect(response.status, await response.clone().text()).toBe(200);
    await budget(response);
  }
  return done;
}

async function listingHeadOpens(owner: Actor, directoryId: string, key: Uint8Array, epoch: number) {
  const wire = await (await call(owner, `/api/private/tree/directories/${directoryId}`, "POST")).json() as {
    entriesRevision: number; listingVersion: 1 | 2; entries: SealedEntry[];
    listingHead: Omit<StoredListingHead, "signerPublicKey"> & { signerPublicKey: string } };
  return openListingHead(key, { vaultId: owner.accountId, directoryId, epoch, revision: wire.entriesRevision,
    entries: wire.entries, version: wire.listingVersion,
    head: { ...wire.listingHead, signerPublicKey: decodeTreeBytes(wire.listingHead.signerPublicKey, 65) } })
    .then(() => true, () => false);
}

describe("Directory subtree rekey", () => {
  it("rekeys a shared subtree top-down after a revoke, keeping remaining readers and all content", async () => {
    const owner = await actor(), kept = await actor(), removed = await actor();
    const a = await directory(owner, owner.accountId, await root(owner), "A");
    const inA = () => state(owner, owner.accountId, a.nodeId, a.key);
    const b = await directory(owner, owner.accountId, await inA(), "B");
    const one = await v2File(owner, owner.accountId, await inA(), "one.md", "# one");
    const old = await legacyFile(owner, owner.accountId, await inA(), "old.md", "# old");
    const two = await v2File(owner, owner.accountId, await state(owner, owner.accountId, b.nodeId, b.key),
      "two.md", "# two");
    await shareDirectory(owner, kept, a.nodeId, a.key);
    await shareDirectory(owner, kept, b.nodeId, b.key);
    const revoked = await shareDirectory(owner, removed, a.nodeId, a.key, "read_write");
    // A commented thread on the deepest File.
    const { file: twoFile, pair: twoPair } = await receivingPair(owner, two, b.key);
    const threadKey = generateThreadKey(), threadId = uuid7(), keyId = uuid7(), commentId = uuid7();
    const identity = { ownerId: owner.accountId, threadId, keyId, epoch: 1 };
    expect((await call(owner, `/api/private/comments/files/${two}/thread`, "PUT", { threadId, keyId,
      receivingKeyId: twoFile.receivingKeyId, receivingEpoch: twoFile.receivingEpoch,
      receivingWrapper: encodeTreeBytes(await sealThreadKeyToReceiving(threadKey, twoPair.publicKey,
        { ...identity, receivingKeyId: twoFile.receivingKeyId })), deviceEnvelopes: [] })).status).toBe(201);
    expect((await call(owner, `/api/private/comments/files/${two}/comments`, "PUT", { commentId, threadId, epoch: 1,
      ciphertext: encodeTreeBytes(await sealComment(threadKey, { ...identity, commentId, revision: 1,
        authorId: owner.accountId, text: "history" })),
      attribution: { revision: 1, ciphertext: encodeTreeBytes(await sealAttribution(threadKey, { ...identity,
        accountId: owner.accountId, revision: 1, pseudonym: "owner" })) } })).status).toBe(201);

    expect((await call(owner, `/api/private/sharing/grants/${revoked.grantId}`, "DELETE")).status).toBe(200);
    expect(await job(owner.accountId, a.nodeId)).toMatchObject({ mode: "rekey", cursor: null });
    // Removed at once, before any key changes; writes beneath the folder wait for the rekey.
    expect((await call(removed, `/api/private/tree/directories/${a.nodeId}`, "POST")).status).toBe(404);
    await expect(legacyFile(owner, owner.accountId, await inA(), "blocked.md")).rejects.toThrow("legacy File 409");
    const steps = await runSteps(owner, a.nodeId);
    expect(steps[0]).toBe(`directory:${a.nodeId}`);
    expect(steps.slice(1, 3).sort()).toEqual([`directory:${b.nodeId}`, `receiving:${one}`].sort());
    expect(steps.slice(3)).toEqual([`receiving:${two}`, "finish"]);
    expect(await job(owner.accountId, a.nodeId)).toBeNull();
    expect(await count("rotation_barriers", "target_node_id = ?", a.nodeId)).toBe(0);

    // New capabilities at epoch 2; every name and all content still readable through them.
    const states = await chain(owner, two);
    const newA = states.get(a.nodeId)!, newB = states.get(b.nodeId)!;
    expect([newA.listing.capabilityEpoch, newB.listing.capabilityEpoch]).toEqual([2, 2]);
    expect(newA.key).not.toEqual(a.key);
    expect(newB.key).not.toEqual(b.key);
    expect(newA.listing.entries.map((entry) => entry.name).sort()).toEqual(["B", "old.md", "one.md"]);
    await legacyFile(owner, owner.accountId, newA, "after.md");
    expect(await markdown(owner, one, newA.key)).toBe("# one");
    expect(await markdown(owner, two, newB.key)).toBe("# two");
    expect(await legacyMarkdown(owner, old, newA.key)).toBe("# old");
    expect(await listingHeadOpens(owner, a.nodeId, newA.key, 2)).toBe(true);
    expect(await listingHeadOpens(owner, a.nodeId, a.key, 2)).toBe(false);
    expect(await listingHeadOpens(owner, b.nodeId, b.key, 2)).toBe(false);
    // Receiving pairs rotated, so an old receiving private key targets nothing current.
    const { file: rotatedTwo, pair: newTwoPair } = await receivingPair(owner, two, newB.key);
    expect(rotatedTwo.receivingEpoch).toBe(twoFile.receivingEpoch + 1);
    expect(rotatedTwo.receivingKeyId).not.toBe(twoFile.receivingKeyId);

    // The thread moved to epoch 2 under the new receiving key; its history stays readable.
    const view = await (await call(owner, `/api/private/comments/files/${two}`, "POST")).json() as {
      thread: { epoch: number; epochs: { epoch: number; keyId: string; receivingWrapper: string;
        previousWrapper: string | null }[] }; comments: { commentId: string; ciphertext: string }[] };
    expect(view.thread.epoch).toBe(2);
    const epoch2 = view.thread.epochs.find((item) => item.epoch === 2)!;
    const current = await openThreadKeyFromReceiving(decodeTreeBytes(epoch2.receivingWrapper, 4096), newTwoPair,
      { ownerId: owner.accountId, threadId, keyId: epoch2.keyId, epoch: 2, receivingKeyId: rotatedTwo.receivingKeyId });
    const previous = await openPreviousThreadKey(decodeTreeBytes(epoch2.previousWrapper!, 4096), current, identity);
    expect(await openComment(decodeTreeBytes(view.comments[0]!.ciphertext, 9216), previous,
      { ...identity, commentId, revision: 1, authorId: owner.accountId })).toBe("history");

    // The remaining reader's Grants are ready again at the new epoch, opening to the new keys.
    const roots = (await (await call(kept, "/api/private/sharing/roots", "POST")).json() as { roots: {
      targetId: string; status: string; capability: { ciphertext: string; targetEpoch: number } }[] }).roots;
    expect(roots.map((item) => [item.targetId, item.status, item.capability?.targetEpoch]).sort())
      .toEqual([[a.nodeId, "ready", 2], [b.nodeId, "ready", 2]].sort());
    for (const item of roots) {
      const opened = await openForRecipient(decodeTreeBytes(item.capability.ciphertext, 16_384), kept.transport,
        { context: { purpose: "grant", vaultId: owner.accountId, objectId: item.targetId, keyId: item.targetId,
          keyEpoch: 2, revision: 1, recipientId: kept.deviceId } });
      expect(opened).toEqual(item.targetId === a.nodeId ? newA.key : newB.key);
    }
    expect(await count("grant_device_envelopes", "target_key_id IN (?, ?) AND target_epoch != 2",
      a.nodeId, b.nodeId)).toBe(0);
    expect((await call(removed, `/api/private/tree/directories/${a.nodeId}`, "POST")).status).toBe(404);
  });

  it("resumes from its cursor, refuses a replayed step, and restarts from the top on a further change", async () => {
    const owner = await actor(), kept = await actor(), removed = await actor();
    const a = await directory(owner, owner.accountId, await root(owner), "A");
    const b = await directory(owner, owner.accountId, await state(owner, owner.accountId, a.nodeId, a.key), "B");
    const keptGrant = await shareDirectory(owner, kept, a.nodeId, a.key);
    const revoked = await shareDirectory(owner, removed, a.nodeId, a.key);
    expect((await call(owner, `/api/private/sharing/grants/${revoked.grantId}`, "DELETE")).status).toBe(200);
    // Interrupted after one step: the cursor persists and a fresh runner continues from it.
    expect(await runSteps(owner, a.nodeId, 1)).toEqual([`directory:${a.nodeId}`]);
    expect((await job(owner.accountId, a.nodeId))!.cursor).toBe(`000:${a.nodeId}`);
    const step = await (await call(owner, `/api/private/rotations/${a.nodeId}/next`, "POST")).json() as
      Extract<RotationStep, { step: "directory" }>;
    expect(step.directoryId).toBe(b.nodeId);
    const states = await chain(owner, b.nodeId);
    const body = await prepareDirectoryRekey({ vaultId: owner.accountId, signer: owner.signer,
      parent: states.get(a.nodeId)!, directory: states.get(b.nodeId)!, step });
    // Another access change restarts the whole rekey at a new barrier epoch; the stale step is refused.
    expect((await call(owner, `/api/private/sharing/grants/${keptGrant.grantId}`, "PATCH",
      { permission: "read_write" })).status).toBe(200);
    expect(await job(owner.accountId, a.nodeId)).toMatchObject({ mode: "rekey", cursor: null });
    expect((await call(owner, `/api/private/rotations/${a.nodeId}/directory`, "PATCH", body)).status).toBe(409);
    expect(await runSteps(owner, a.nodeId)).toEqual([`directory:${a.nodeId}`, `directory:${b.nodeId}`, "finish"]);
    const final = await chain(owner, b.nodeId);
    expect(final.get(a.nodeId)!.listing.capabilityEpoch).toBe(3);
    expect(final.get(b.nodeId)!.listing.capabilityEpoch).toBe(2);
    const roots = (await (await call(kept, "/api/private/sharing/roots", "POST")).json() as { roots: {
      status: string; permission: string; capability: { targetEpoch: number } }[] }).roots;
    expect(roots).toEqual([expect.objectContaining({ status: "ready", permission: "read_write",
      capability: expect.objectContaining({ targetEpoch: 3 }) })]);
  });
});
