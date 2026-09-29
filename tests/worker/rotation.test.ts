import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { ThreadKeySource } from "../../app/comments/client";
import { generateThreadKey, openThreadKeyFromDevice, sealThreadKeyToDevice,
  sealThreadKeyToReceiving } from "../../app/comments/crypto";
import { openFileContentKeyFromDevice } from "../../app/crypto/file-receiving";
import { prepareFileTargetRotation, type RotationFile, type RotationStep } from "../../app/sharing/rotation-client";
import { verifyFileHead } from "../../app/tree/file-head";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/tree/wire";
import { actor, call, directory, state, uuid7, v2File, type Actor } from "./tree-fixtures";

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
