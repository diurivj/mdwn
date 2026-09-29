import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { ThreadKeySource } from "../../app/comments/client";
import { openSymmetric } from "../../app/crypto/enc-v1";
import { openFileContentKeyFromReceiving, openFileReceivingKey } from "../../app/crypto/file-receiving";
import { decodeFileRepresentation } from "../../app/crypto/vault";
import { NameConflictError } from "../../app/tree/client";
import { orderBetween, prepareTreeDelete, prepareTreeMove, prepareTreeReorder,
  type FileRotationSource } from "../../app/tree/structure-client";
import { openListingHead, type SealedEntry, type StoredListingHead } from "../../app/tree/listing";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/tree/wire";
import { actor, call, directory, legacyFile, state, treeIntegrity, uuid7, v2File,
  type Actor } from "./tree-fixtures";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const root = (who: Actor) => state(who, who.accountId, who.rootId, who.rootKey);
async function budget(response: Response) {
  const [queries, bindings] = (response.headers.get("X-Mdwn-Sharing-Budget") ?? "").split(";").map(Number);
  expect(queries).toBeGreaterThan(0);
  expect(queries).toBeLessThanOrEqual(50);
  expect(bindings).toBeLessThanOrEqual(100);
}
async function fileSource(who: Actor, fileId: string): Promise<FileRotationSource> {
  const response = await call(who, `/api/private/tree/files/${fileId}`, "POST");
  expect(response.status).toBe(200);
  return response.json() as Promise<FileRotationSource>;
}
async function threadSource(who: Actor, fileId: string): Promise<ThreadKeySource> {
  const response = await call(who, `/api/private/comments/files/${fileId}/thread`, "POST");
  expect(response.status).toBe(200);
  return response.json() as Promise<ThreadKeySource>;
}
async function readV2(who: Actor, ownerId: string, fileId: string, parentKey: Uint8Array): Promise<string> {
  const file = await (await call(who, `/api/private/tree/files/${fileId}`, "POST")).json() as {
    ciphertext: string; keyEnvelope: string; parentEnvelope: string; receivingPublicKey: string;
    receivingKeyId: string; receivingEpoch: number; wrapRevision: number; revision: number;
    contentKeyId: string; keyEpoch: number };
  const pair = await openFileReceivingKey(decodeTreeBytes(file.keyEnvelope, 16_384), parentKey, { vaultId: ownerId,
    fileId, receivingKeyId: file.receivingKeyId, receivingEpoch: file.receivingEpoch, wrapRevision: file.wrapRevision,
    publicKey: decodeTreeBytes(file.receivingPublicKey, 65) });
  const key = await openFileContentKeyFromReceiving(decodeTreeBytes(file.parentEnvelope, 16_384), pair, {
    vaultId: ownerId, fileId, revision: file.revision, contentKeyId: file.contentKeyId, contentEpoch: file.keyEpoch,
    receivingKeyId: file.receivingKeyId });
  return decodeFileRepresentation(await openSymmetric(decodeTreeBytes(file.ciphertext, 524_288), key, { context: {
    purpose: "file-content", vaultId: ownerId, objectId: fileId, keyId: file.contentKeyId, keyEpoch: file.keyEpoch,
    revision: file.revision } })).markdown;
}
async function readLegacy(who: Actor, ownerId: string, fileId: string, parentKey: Uint8Array): Promise<string> {
  const file = await (await call(who, `/api/private/tree/files/${fileId}`, "POST")).json() as {
    ciphertext: string; keyEnvelope: string; revision: number; contentKeyId: string; keyEpoch: number };
  const context = { vaultId: ownerId, objectId: fileId, keyId: file.contentKeyId, keyEpoch: file.keyEpoch,
    revision: file.revision };
  const key = await openSymmetric(decodeTreeBytes(file.keyEnvelope, 16_384), parentKey,
    { context: { ...context, purpose: "file-content-key" } });
  return decodeFileRepresentation(await openSymmetric(decodeTreeBytes(file.ciphertext, 524_288), key,
    { context: { ...context, purpose: "file-content" } })).markdown;
}
async function parentOf(nodeId: string) {
  return (await env.DB.prepare("SELECT parent_node_id FROM vault_nodes WHERE id = ?").bind(nodeId)
    .first<{ parent_node_id: string }>())?.parent_node_id;
}
async function revisionOf(directoryId: string) {
  return (await env.DB.prepare("SELECT entries_revision FROM directories WHERE node_id = ?").bind(directoryId)
    .first<{ entries_revision: number }>())?.entries_revision;
}
async function grant(owner: Actor, recipient: Actor, target: string, kind: "file" | "directory",
  permission: "read_only" | "read_write") {
  const id = uuid7(), now = Date.now();
  await env.DB.prepare(`INSERT INTO grants (id, owner_id, recipient_id, target_node_id, target_kind, permission,
    generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .bind(id, owner.accountId, recipient.accountId, target, kind, permission, now, now).run();
  return id;
}

describe("order keys", () => {
  it("always sorts strictly between neighbours, including existing opaque UUIDv7 orders", () => {
    const keys = [uuid7(), uuid7()].sort();
    for (let i = 0; i < 400; i++) {
      const at = Math.floor(Math.random() * (keys.length + 1));
      const next = orderBetween(keys[at - 1] ?? "", keys[at]);
      expect(next > (keys[at - 1] ?? "")).toBe(true);
      if (keys[at] !== undefined) expect(next < keys[at]!).toBe(true);
      expect(next.length).toBeLessThanOrEqual(256);
      keys.splice(at, 0, next);
    }
    expect(keys.slice().sort()).toEqual(keys);
    expect(() => orderBetween("b", "a")).toThrow();
  });
});

describe("reorder", () => {
  it("re-encrypts only the moved entry's order under a CAS'd, signed parent listing", async () => {
    const owner = await actor();
    await directory(owner, owner.accountId, await root(owner), "a");
    await directory(owner, owner.accountId, await root(owner), "b");
    await legacyFile(owner, owner.accountId, await root(owner), "c.md");
    const before = await root(owner);
    expect(before.listing.entries.map((e) => e.name)).toEqual(["a", "b", "c.md"]);
    const c = before.listing.entries[2]!;
    const body = await prepareTreeReorder({ vaultId: owner.accountId, signer: owner.signer, parent: before,
      nodeId: c.nodeId, direction: "up" });
    const response = await call(owner, `/api/private/tree/nodes/${c.nodeId}/order`, "PATCH", body);
    expect(response.status, await response.clone().text()).toBe(200);
    await budget(response);
    const after = await root(owner);
    expect(after.listing.entries.map((e) => e.name)).toEqual(["a", "c.md", "b"]);
    expect(after.listing.entriesRevision).toBe(before.listing.entriesRevision + 1);
    expect(after.listing.entries.find((e) => e.nodeId === c.nodeId)!.nameCiphertext).toBe(c.nameCiphertext);
    // A replayed or stale reorder changes nothing.
    expect((await call(owner, `/api/private/tree/nodes/${c.nodeId}/order`, "PATCH", body)).status).toBe(409);
    expect((await root(owner)).listing.entriesRevision).toBe(after.listing.entriesRevision);
    const top = await prepareTreeReorder({ vaultId: owner.accountId, signer: owner.signer, parent: after,
      nodeId: c.nodeId, direction: "up" });
    expect((await call(owner, `/api/private/tree/nodes/${c.nodeId}/order`, "PATCH", top)).status).toBe(200);
    expect((await root(owner)).listing.entries.map((e) => e.name)).toEqual(["c.md", "a", "b"]);
    await expect(prepareTreeReorder({ vaultId: owner.accountId, signer: owner.signer, parent: await root(owner),
      nodeId: c.nodeId, direction: "up" })).rejects.toThrow();
  });
});

describe("move", () => {
  it("moves Directories and both File encodings with agreeing nodes/edges and rewrapped keys", async () => {
    const owner = await actor();
    const a = await directory(owner, owner.accountId, await root(owner), "A");
    const b = await directory(owner, owner.accountId, await root(owner), "B");
    const inner = await directory(owner, owner.accountId, await state(owner, owner.accountId, a.nodeId, a.key), "Inner");
    const legacy = await legacyFile(owner, owner.accountId, await state(owner, owner.accountId, inner.nodeId, inner.key),
      "legacy.md", "# kept legacy");
    const modern = await v2File(owner, owner.accountId, await state(owner, owner.accountId, a.nodeId, a.key),
      "modern.md", "# kept v2");

    // Directory: A/Inner -> B/Inner; its own capability and descendants are unchanged.
    let source = await state(owner, owner.accountId, a.nodeId, a.key);
    let destination = await state(owner, owner.accountId, b.nodeId, b.key);
    const moveDirectory = await prepareTreeMove({ vaultId: owner.accountId, signer: owner.signer, source,
      destination, nodeId: inner.nodeId });
    let response = await call(owner, `/api/private/tree/nodes/${inner.nodeId}/parent`, "PATCH", moveDirectory);
    expect(response.status, await response.clone().text()).toBe(200);
    await budget(response);
    expect(await parentOf(inner.nodeId)).toBe(b.nodeId);
    expect(await revisionOf(a.nodeId)).toBe(source.listing.entriesRevision + 1);
    expect(await revisionOf(b.nodeId)).toBe(destination.listing.entriesRevision + 1);
    const movedEntry = (await state(owner, owner.accountId, b.nodeId, b.key)).listing.entries
      .find((e) => e.nodeId === inner.nodeId)!;
    expect(movedEntry.name).toBe("Inner");
    const reopened = await openSymmetric(decodeTreeBytes(movedEntry.keyEnvelope), b.key, { context: {
      purpose: "directory-capability", vaultId: owner.accountId, objectId: inner.nodeId, keyId: inner.nodeId,
      keyEpoch: 1, revision: 1 } });
    expect(encodeTreeBytes(reopened)).toBe(encodeTreeBytes(inner.key));
    expect(await readLegacy(owner, owner.accountId, legacy, inner.key)).toBe("# kept legacy");

    // Legacy File: B/Inner/legacy.md -> A/legacy.md, content key rewrapped under A.
    source = await state(owner, owner.accountId, inner.nodeId, inner.key);
    destination = await state(owner, owner.accountId, a.nodeId, a.key);
    response = await call(owner, `/api/private/tree/nodes/${legacy}/parent`, "PATCH", await prepareTreeMove({
      vaultId: owner.accountId, signer: owner.signer, source, destination, nodeId: legacy }));
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await readLegacy(owner, owner.accountId, legacy, a.key)).toBe("# kept legacy");

    // v2 File: A/modern.md -> root; its receiving pair and File head rotate at the same revision.
    const before = await env.DB.prepare(`SELECT receiving_key_id, receiving_epoch, revision, digest FROM file_heads
      WHERE file_node_id = ?`).bind(modern).first<{ receiving_key_id: string; receiving_epoch: number;
        revision: number; digest: ArrayBuffer }>();
    source = await state(owner, owner.accountId, a.nodeId, a.key);
    destination = await root(owner);
    const moveFile = await prepareTreeMove({ vaultId: owner.accountId, signer: owner.signer, source, destination,
      nodeId: modern, file: await fileSource(owner, modern),
      thread: await threadSource(owner, modern) });
    response = await call(owner, `/api/private/tree/nodes/${modern}/parent`, "PATCH", moveFile);
    expect(response.status, await response.clone().text()).toBe(200);
    await budget(response);
    const after = await env.DB.prepare(`SELECT h.receiving_key_id, h.receiving_epoch, h.revision, e.receiving_key_id AS entry_key,
      e.receiving_epoch AS entry_epoch, d.listing_version FROM file_heads h
      JOIN directory_entries e ON e.child_node_id = h.file_node_id JOIN directories d ON d.node_id = e.parent_node_id
      WHERE h.file_node_id = ?`).bind(modern).first<Record<string, unknown>>();
    expect(after).toMatchObject({ receiving_epoch: before!.receiving_epoch + 1, revision: before!.revision,
      entry_epoch: before!.receiving_epoch + 1, listing_version: 2 });
    expect(after!.receiving_key_id).not.toBe(before!.receiving_key_id);
    expect(after!.entry_key).toBe(after!.receiving_key_id);
    expect(await readV2(owner, owner.accountId, modern, owner.rootKey)).toBe("# kept v2");
    // The departed parent's capability no longer opens the moved File's (rotated) wrapper.
    await expect(readV2(owner, owner.accountId, modern, a.key)).rejects.toThrow();
    expect(await treeIntegrity(owner.accountId)).toEqual({ broken: 0, markers: 0 });
  });

  it("rejects cycles, same-parent, stale, replayed and cross-owner moves without changing anything", async () => {
    const owner = await actor(), other = await actor();
    const a = await directory(owner, owner.accountId, await root(owner), "A");
    const child = await directory(owner, owner.accountId, await state(owner, owner.accountId, a.nodeId, a.key), "Child");
    const source = await root(owner);
    const into = await state(owner, owner.accountId, child.nodeId, child.key);
    const cycle = await prepareTreeMove({ vaultId: owner.accountId, signer: owner.signer, source, destination: into,
      nodeId: a.nodeId });
    expect((await call(owner, `/api/private/tree/nodes/${a.nodeId}/parent`, "PATCH", cycle)).status).toBe(404);
    await expect(env.DB.prepare("UPDATE vault_nodes SET parent_node_id = ? WHERE id = ?")
      .bind(child.nodeId, a.nodeId).run()).rejects.toThrow();
    await expect(env.DB.prepare("UPDATE vault_nodes SET parent_node_id = NULL WHERE id = ?")
      .bind(a.nodeId).run()).rejects.toThrow();

    const b = await directory(owner, owner.accountId, await root(owner), "B");
    const file = await legacyFile(owner, owner.accountId, await root(owner), "f.md");
    const fresh = await root(owner);
    const destination = await state(owner, owner.accountId, b.nodeId, b.key);
    const body = await prepareTreeMove({ vaultId: owner.accountId, signer: owner.signer, source: fresh, destination,
      nodeId: file });
    const [first, second] = await Promise.all([
      call(owner, `/api/private/tree/nodes/${file}/parent`, "PATCH", body),
      call(owner, `/api/private/tree/nodes/${file}/parent`, "PATCH", body)]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(await parentOf(file)).toBe(b.nodeId);
    // Moving back with a now-stale source revision changes nothing.
    const stale = await prepareTreeMove({ vaultId: owner.accountId, signer: owner.signer,
      source: await state(owner, owner.accountId, b.nodeId, b.key), destination: await root(owner), nodeId: file });
    await legacyFile(owner, owner.accountId, await state(owner, owner.accountId, b.nodeId, b.key), "later.md");
    const staleResponse = await call(owner, `/api/private/tree/nodes/${file}/parent`, "PATCH", stale);
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toEqual({ error: "namespace_changed" });
    expect(await parentOf(file)).toBe(b.nodeId);

    // Same-parent "move" is a reorder, never a move.
    const again = await state(owner, owner.accountId, b.nodeId, b.key);
    await expect(prepareTreeMove({ vaultId: owner.accountId, signer: owner.signer, source: again,
      destination: again, nodeId: file })).rejects.toBeInstanceOf(NameConflictError);
    const same = await call(owner, `/api/private/tree/nodes/${file}/parent`, "PATCH", { ...body,
      sourceId: b.nodeId, destinationId: b.nodeId });
    expect(same.status).toBe(400);

    // Another Account cannot move into or out of this tree.
    const foreign = await root(other);
    const crossOwner = await call(other, `/api/private/tree/nodes/${file}/parent`, "PATCH", { ...body,
      destinationId: other.rootId });
    expect(crossOwner.status).toBe(404);
    const intoForeign = await call(owner, `/api/private/tree/nodes/${file}/parent`, "PATCH", { ...body,
      destinationId: foreign.listing.directoryId });
    expect(intoForeign.status).toBe(404);
    expect(await parentOf(file)).toBe(b.nodeId);

    // A local name collision is found in the browser before any request.
    await legacyFile(owner, owner.accountId, await root(owner), "F.MD");
    await expect(prepareTreeMove({ vaultId: owner.accountId, signer: owner.signer,
      source: await state(owner, owner.accountId, b.nodeId, b.key), destination: await root(owner), nodeId: file }))
      .rejects.toBeInstanceOf(NameConflictError);
    expect(await treeIntegrity(owner.accountId)).toEqual({ broken: 0, markers: 0 });
  });

  it("confines Collaborators to their read/write subtree and never leaves Directory readers a stale scope", async () => {
    const owner = await actor(), writer = await actor(), reader = await actor(), direct = await actor();
    const shared = await directory(owner, owner.accountId, await root(owner), "Shared");
    const sharedState = () => state(owner, owner.accountId, shared.nodeId, shared.key);
    const left = await directory(owner, owner.accountId, await sharedState(), "Left");
    const right = await directory(owner, owner.accountId, await sharedState(), "Right");
    const file = await legacyFile(owner, owner.accountId, await state(owner, owner.accountId, left.nodeId, left.key), "n.md");
    const outside = await directory(owner, owner.accountId, await root(owner), "Outside");
    await grant(owner, writer, shared.nodeId, "directory", "read_write");
    await grant(owner, reader, shared.nodeId, "directory", "read_only");
    await grant(owner, direct, file, "file", "read_write");

    // Inside the granted subtree, a read/write Collaborator may move.
    const withinSource = await state(writer, owner.accountId, left.nodeId, left.key);
    const withinDestination = await state(writer, owner.accountId, right.nodeId, right.key);
    const inside = await prepareTreeMove({ vaultId: owner.accountId, signer: writer.signer, source: withinSource,
      destination: withinDestination, nodeId: file });
    expect((await call(reader, `/api/private/tree/nodes/${file}/parent`, "PATCH", inside)).status).toBe(404);
    expect((await call(direct, `/api/private/tree/nodes/${file}/parent`, "PATCH", inside)).status).toBe(404);
    const moved = await call(writer, `/api/private/tree/nodes/${file}/parent`, "PATCH", inside);
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(await parentOf(file)).toBe(right.nodeId);

    // ...but never outside it, and never the shared root itself.
    const out = await prepareTreeMove({ vaultId: owner.accountId, signer: writer.signer,
      source: await state(writer, owner.accountId, right.nodeId, right.key),
      destination: await state(owner, owner.accountId, outside.nodeId, outside.key), nodeId: file });
    expect((await call(writer, `/api/private/tree/nodes/${file}/parent`, "PATCH", out)).status).toBe(404);
    const rootMove = await prepareTreeMove({ vaultId: owner.accountId, signer: writer.signer, source: await root(owner),
      destination: await state(owner, owner.accountId, outside.nodeId, outside.key), nodeId: shared.nodeId });
    expect((await call(writer, `/api/private/tree/nodes/${shared.nodeId}/parent`, "PATCH", rootMove)).status).toBe(404);
    expect(await parentOf(file)).toBe(right.nodeId);

    // Read-only and direct-File Collaborators have no structural authority at all.
    await legacyFile(owner, owner.accountId, await state(owner, owner.accountId, right.nodeId, right.key), "m.md");
    const parent = await state(owner, owner.accountId, right.nodeId, right.key);
    const reorder = await prepareTreeReorder({ vaultId: owner.accountId, signer: reader.signer, parent,
      nodeId: file, direction: parent.listing.entries[0]!.nodeId === file ? "down" : "up" });
    expect((await call(reader, `/api/private/tree/nodes/${file}/order`, "PATCH", reorder)).status).toBe(404);
    expect((await call(direct, `/api/private/tree/nodes/${file}/order`, "PATCH", reorder)).status).toBe(404);
    const deletion = await prepareTreeDelete({ vaultId: owner.accountId, signer: reader.signer, parent, nodeId: file });
    expect((await call(reader, `/api/private/tree/nodes/${file}`, "DELETE", deletion)).status).toBe(404);
    expect((await call(direct, `/api/private/tree/nodes/${file}`, "DELETE", deletion)).status).toBe(404);
    const rootDelete = await prepareTreeDelete({ vaultId: owner.accountId, signer: writer.signer,
      parent: await root(owner), nodeId: shared.nodeId });
    expect((await call(writer, `/api/private/tree/nodes/${shared.nodeId}`, "DELETE", rootDelete)).status).toBe(404);
    expect(await parentOf(shared.nodeId)).toBe(owner.rootId);

    // Owner: moving a Directory out of a shared subtree would strand a reader holding its capability.
    const strand = await prepareTreeMove({ vaultId: owner.accountId, signer: owner.signer,
      source: await sharedState(), destination: await state(owner, owner.accountId, outside.nodeId, outside.key),
      nodeId: left.nodeId });
    const refused = await call(owner, `/api/private/tree/nodes/${left.nodeId}/parent`, "PATCH", strand);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "move_leaves_shared_scope" });
    expect(await parentOf(left.nodeId)).toBe(shared.nodeId);
    // Once both recipients also cover the destination, the same move keeps everyone's scope.
    await grant(owner, writer, outside.nodeId, "directory", "read_only");
    await grant(owner, reader, outside.nodeId, "directory", "read_only");
    expect((await call(owner, `/api/private/tree/nodes/${left.nodeId}/parent`, "PATCH", strand)).status).toBe(200);
    expect(await treeIntegrity(owner.accountId)).toEqual({ broken: 0, markers: 0 });
  });

  it("rotates a v2 File's receiving pair when the Owner moves it out of a shared Directory", async () => {
    const owner = await actor(), reader = await actor();
    const shared = await directory(owner, owner.accountId, await root(owner), "Shared");
    const file = await v2File(owner, owner.accountId, await state(owner, owner.accountId, shared.nodeId, shared.key),
      "leaving.md", "# private again");
    await grant(owner, reader, shared.nodeId, "directory", "read_only");
    const move = await prepareTreeMove({ vaultId: owner.accountId, signer: owner.signer,
      source: await state(owner, owner.accountId, shared.nodeId, shared.key), destination: await root(owner),
      nodeId: file, file: await fileSource(owner, file),
      thread: await threadSource(owner, file) });
    const response = await call(owner, `/api/private/tree/nodes/${file}/parent`, "PATCH", move);
    expect(response.status, await response.clone().text()).toBe(200);
    // The reader lost server access and the shared Directory key opens nothing current.
    expect((await call(reader, `/api/private/tree/files/${file}`, "POST")).status).toBe(404);
    await expect(readV2(owner, owner.accountId, file, shared.key)).rejects.toThrow();
    expect(await readV2(owner, owner.accountId, file, owner.rootKey)).toBe("# private again");
    // A replayed move is a namespace change; a rotation against another head is a File change.
    expect(await (await call(owner, `/api/private/tree/nodes/${file}/parent`, "PATCH", move)).json())
      .toEqual({ error: "namespace_changed" });
    const back = await prepareTreeMove({ vaultId: owner.accountId, signer: owner.signer, source: await root(owner),
      destination: await state(owner, owner.accountId, shared.nodeId, shared.key), nodeId: file,
      file: await fileSource(owner, file), thread: await threadSource(owner, file) });
    const otherHead = await call(owner, `/api/private/tree/nodes/${file}/parent`, "PATCH", { ...back,
      expectedHeadDigest: encodeTreeBytes(new Uint8Array(32)) });
    expect(otherHead.status).toBe(409);
    expect(await otherHead.json()).toEqual({ error: "file_changed" });
    expect(await parentOf(file)).toBe(owner.rootId);
  });

  it("refuses structural writes beneath a pending rotation barrier", async () => {
    const owner = await actor();
    const a = await directory(owner, owner.accountId, await root(owner), "A");
    const file = await legacyFile(owner, owner.accountId, await state(owner, owner.accountId, a.nodeId, a.key), "x.md");
    await env.DB.prepare("INSERT INTO rotation_barriers (owner_id, target_node_id, epoch) VALUES (?, ?, 2)")
      .bind(owner.accountId, a.nodeId).run();
    const parent = await state(owner, owner.accountId, a.nodeId, a.key);
    const move = await prepareTreeMove({ vaultId: owner.accountId, signer: owner.signer, source: parent,
      destination: await root(owner), nodeId: file });
    const response = await call(owner, `/api/private/tree/nodes/${file}/parent`, "PATCH", move);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "rotation_pending" });
    const deletion = await prepareTreeDelete({ vaultId: owner.accountId, signer: owner.signer, parent, nodeId: file });
    expect((await call(owner, `/api/private/tree/nodes/${file}`, "DELETE", deletion)).status).toBe(409);
    expect(await parentOf(file)).toBe(a.nodeId);
  });
});

async function remaining(ids: readonly string[]): Promise<Record<string, number>> {
  const json = JSON.stringify(ids);
  const counts: Record<string, number> = {};
  for (const [table, column] of [["vault_nodes", "id"], ["directories", "node_id"], ["files", "node_id"],
    ["directory_entries", "child_node_id"], ["file_representations", "file_node_id"], ["file_heads", "file_node_id"],
    ["file_device_envelopes", "file_node_id"], ["shares", "target_node_id"], ["grants", "target_node_id"],
    ["rotation_barriers", "target_node_id"], ["sharing_rotation_jobs", "target_node_id"]] as const) {
    counts[table] = (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} IN
      (SELECT value FROM json_each(?))`).bind(json).first<{ n: number }>())!.n;
  }
  return counts;
}
const none = { vault_nodes: 0, directories: 0, files: 0, directory_entries: 0, file_representations: 0,
  file_heads: 0, file_device_envelopes: 0, shares: 0, grants: 0, rotation_barriers: 0, sharing_rotation_jobs: 0 };

describe("hard deletion", () => {
  it("deletes one File with its representation, head, envelopes, Shares and Grants in one transaction", async () => {
    const owner = await actor(), recipient = await actor();
    const file = await v2File(owner, owner.accountId, await root(owner), "doomed.md");
    const keep = await legacyFile(owner, owner.accountId, await root(owner), "kept.md");
    await grant(owner, recipient, file, "file", "read_only");
    await env.DB.prepare(`INSERT INTO shares (id, owner_id, recipient_id, target_node_id, target_kind, permission, created_at)
      VALUES (?, ?, ?, ?, 'file', 'read_write', 1)`).bind(uuid7(), owner.accountId, (await actor()).accountId, file).run();
    const parent = await root(owner);
    const body = await prepareTreeDelete({ vaultId: owner.accountId, signer: owner.signer, parent, nodeId: file });
    const response = await call(owner, `/api/private/tree/nodes/${file}`, "DELETE", body);
    expect(response.status, await response.clone().text()).toBe(200);
    await budget(response);
    expect(await remaining([file])).toEqual(none);
    expect((await root(owner)).listing.entries.map((e) => e.nodeId)).toEqual([keep]);
    expect(await revisionOf(owner.rootId)).toBe(parent.listing.entriesRevision + 1);
    // Deleted and never-existing Files are indistinguishable.
    const gone = await call(owner, `/api/private/tree/files/${file}`, "POST");
    const unknown = await call(owner, `/api/private/tree/files/${uuid7()}`, "POST");
    expect(gone.status).toBe(404);
    expect(await gone.text()).toBe(await unknown.text());
    expect((await call(recipient, `/api/private/sharing/direct-files/${file}`, "POST")).status).toBe(404);
    expect(await treeIntegrity(owner.accountId)).toEqual({ broken: 0, markers: 0 });
  });

  it("drains every dependent sharing record of a bounded Directory subtree atomically", async () => {
    const owner = await actor(), writer = await actor(), invitee = await actor();
    const top = await directory(owner, owner.accountId, await root(owner), "Top");
    const nested = await directory(owner, owner.accountId, await state(owner, owner.accountId, top.nodeId, top.key), "Nested");
    const file = await v2File(owner, owner.accountId, await state(owner, owner.accountId, nested.nodeId, nested.key), "deep.md");
    const legacy = await legacyFile(owner, owner.accountId, await state(owner, owner.accountId, top.nodeId, top.key), "old.md");
    const grantId = await grant(owner, writer, nested.nodeId, "directory", "read_write");
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO grant_labels (grant_id, label_id, owner_copy, offer_bytes, offer_digest, offer_signature,
        signer_device_id) VALUES (?, ?, X'01', X'01', zeroblob(32), zeroblob(64), ?)`).bind(grantId, uuid7(), owner.deviceId),
      env.DB.prepare(`INSERT INTO grant_label_deliveries (grant_id, device_id, registry_epoch, ciphertext, digest)
        VALUES (?, ?, 1, X'01', zeroblob(32))`).bind(grantId, writer.deviceId),
      env.DB.prepare(`INSERT INTO grant_device_envelopes (grant_id, device_id, generation, registry_epoch, target_key_id,
        target_epoch, ciphertext, digest) VALUES (?, ?, 1, 1, ?, 1, X'01', zeroblob(32))`).bind(grantId, writer.deviceId, nested.nodeId),
      env.DB.prepare(`INSERT INTO provisioning_needs (grant_id, owner_id, recipient_id, device_id, generation, registry_epoch,
        created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)`).bind(grantId, owner.accountId, writer.accountId, writer.deviceId, now, now),
      env.DB.prepare("INSERT INTO rotation_barriers (owner_id, target_node_id, epoch) VALUES (?, ?, 3)").bind(owner.accountId, file),
      env.DB.prepare(`INSERT INTO sharing_rotation_jobs (owner_id, target_node_id, barrier_epoch, state, cursor, created_at,
        updated_at) VALUES (?, ?, 3, 'pending', NULL, ?, ?)`).bind(owner.accountId, file, now, now),
    ]);
    const shareId = uuid7();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO shares (id, owner_id, recipient_id, target_node_id, target_kind, permission, created_at)
        VALUES (?, ?, ?, ?, 'directory', 'read_only', 1)`).bind(shareId, owner.accountId, invitee.accountId, top.nodeId),
      env.DB.prepare(`INSERT INTO share_material (share_id, material_revision, anticipated_grant_id, target_key_id, target_epoch,
        head_digest, registry_epoch) VALUES (?, 1, ?, ?, 1, zeroblob(32), 1)`).bind(shareId, uuid7(), top.nodeId),
      env.DB.prepare(`INSERT INTO share_device_material (share_id, material_revision, device_id, registry_epoch,
        public_key_digest, ciphertext, digest) VALUES (?, 1, ?, 1, zeroblob(32), X'01', zeroblob(32))`).bind(shareId, invitee.deviceId),
      env.DB.prepare(`INSERT INTO share_offers (share_id, label_id, owner_copy, bytes, digest, signature, signer_device_id)
        VALUES (?, ?, X'01', X'01', zeroblob(32), zeroblob(64), ?)`).bind(shareId, uuid7(), owner.deviceId),
      env.DB.prepare(`INSERT INTO share_offer_labels (share_id, device_id, ciphertext, digest) VALUES (?, ?, X'01', zeroblob(32))`)
        .bind(shareId, invitee.deviceId),
    ]);
    const outsider = await legacyFile(owner, owner.accountId, await root(owner), "survivor.md");
    const body = await prepareTreeDelete({ vaultId: owner.accountId, signer: owner.signer, parent: await root(owner),
      nodeId: top.nodeId });
    const response = await call(owner, `/api/private/tree/nodes/${top.nodeId}`, "DELETE", body);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ deletedNodes: 4 });
    await budget(response);
    expect(await remaining([top.nodeId, nested.nodeId, file, legacy])).toEqual(none);
    for (const table of ["grant_labels", "grant_label_deliveries", "grant_device_envelopes", "provisioning_needs"]) {
      expect((await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE grant_id = ?`).bind(grantId)
        .first<{ n: number }>())!.n, table).toBe(0);
    }
    for (const table of ["share_material", "share_device_material", "share_offers", "share_offer_labels"]) {
      expect((await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE share_id = ?`).bind(shareId)
        .first<{ n: number }>())!.n, table).toBe(0);
    }
    expect((await root(owner)).listing.entries.map((e) => e.nodeId)).toEqual([outsider]);
    expect(await env.DB.prepare("PRAGMA foreign_key_check").all()).toMatchObject({ results: [] });
    expect(await treeIntegrity(owner.accountId)).toEqual({ broken: 0, markers: 0 });
    // Only the teardown marker authorizes node deletion; nothing else can remove a node.
    await expect(env.DB.prepare("DELETE FROM vault_nodes WHERE id = ?").bind(outsider).run()).rejects.toThrow();
    await expect(env.DB.prepare("DELETE FROM files WHERE node_id = ?").bind(outsider).run()).rejects.toThrow();
  });

  async function populate(owner: Actor, directoryId: string, count: number) {
    // Raw fixture rows: 'count' child Directories under directoryId. Content bytes are irrelevant to the cap.
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
        INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at)
        SELECT printf('%s-%04d', ?, n), 'directory', ?, ?, ?, ? FROM seq`).bind(count, directoryId, owner.accountId,
          directoryId, now, now),
      env.DB.prepare(`INSERT INTO directories (node_id, owner_id, entries_revision)
        SELECT id, owner_id, 1 FROM vault_nodes WHERE parent_node_id = ?`).bind(directoryId),
      env.DB.prepare(`INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id, name_ciphertext,
        order_ciphertext, key_envelope, encoding)
        SELECT id, owner_id, parent_node_id, X'01', X'01', X'01', 'directory' FROM vault_nodes WHERE parent_node_id = ?`)
        .bind(directoryId),
    ]);
  }

  it("changes nothing for a 501-node Directory and deletes a 500-node Directory atomically", async () => {
    const owner = await actor();
    const big = await directory(owner, owner.accountId, await root(owner), "Big");
    await populate(owner, big.nodeId, 500);
    const before = await root(owner);
    const body = await prepareTreeDelete({ vaultId: owner.accountId, signer: owner.signer, parent: before,
      nodeId: big.nodeId });
    const refused = await call(owner, `/api/private/tree/nodes/${big.nodeId}`, "DELETE", body);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "subtree_limit_exceeded", limit: 500 });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM vault_nodes WHERE id = ? OR parent_node_id = ?")
      .bind(big.nodeId, big.nodeId).first<{ n: number }>())!.n).toBe(501);
    expect(await revisionOf(owner.rootId)).toBe(before.listing.entriesRevision);

    const exact = await directory(owner, owner.accountId, await root(owner), "Exact");
    await populate(owner, exact.nodeId, 499);
    const parent = await root(owner);
    const accepted = await call(owner, `/api/private/tree/nodes/${exact.nodeId}`, "DELETE",
      await prepareTreeDelete({ vaultId: owner.accountId, signer: owner.signer, parent, nodeId: exact.nodeId }));
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect(await accepted.json()).toMatchObject({ deletedNodes: 500 });
    await budget(accepted);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM vault_nodes WHERE id = ? OR parent_node_id = ?")
      .bind(exact.nodeId, exact.nodeId).first<{ n: number }>())!.n).toBe(0);
    expect(await treeIntegrity(owner.accountId)).toEqual({ broken: 0, markers: 0 });
  });

  it("commits a same-revision concurrent deletion exactly once and signs only valid listings", async () => {
    const owner = await actor();
    const a = await legacyFile(owner, owner.accountId, await root(owner), "a.md");
    const b = await legacyFile(owner, owner.accountId, await root(owner), "b.md");
    const parent = await root(owner);
    const first = await prepareTreeDelete({ vaultId: owner.accountId, signer: owner.signer, parent, nodeId: a });
    const second = await prepareTreeDelete({ vaultId: owner.accountId, signer: owner.signer, parent, nodeId: b });
    const results = await Promise.all([
      call(owner, `/api/private/tree/nodes/${a}`, "DELETE", first),
      call(owner, `/api/private/tree/nodes/${b}`, "DELETE", second),
      call(owner, `/api/private/tree/nodes/${a}`, "DELETE", first)]);
    expect(results.map((r) => r.status).filter((s) => s === 200)).toHaveLength(1);
    expect(results.map((r) => r.status).every((s) => s === 200 || s === 409 || s === 404)).toBe(true);
    expect((await root(owner)).listing.entries).toHaveLength(1);
    // A listing head signed by another device key is rejected before any write.
    const intruder = await actor();
    const forged = { ...await prepareTreeDelete({ vaultId: owner.accountId, signer: intruder.signer,
      parent: await root(owner), nodeId: (await root(owner)).listing.entries[0]!.nodeId }) };
    expect((await call(owner, `/api/private/tree/nodes/${(await root(owner)).listing.entries[0]!.nodeId}`,
      "DELETE", forged)).status).toBe(400);
    expect(await treeIntegrity(owner.accountId)).toEqual({ broken: 0, markers: 0 });
  });
});

describe("Directory capability epochs", () => {
  it("writes and verifies a Directory at its stored epoch and refuses another epoch's contexts", async () => {
    const owner = await actor();
    const folder = await directory(owner, owner.accountId, await root(owner), "Epoch");
    const loose = await v2File(owner, owner.accountId, await root(owner), "loose.md");
    // Stands in for a completed rotation: the stored epoch alone decides every Directory context.
    await env.DB.prepare("UPDATE directories SET capability_epoch = 2 WHERE node_id = ?").bind(folder.nodeId).run();
    const current = await state(owner, owner.accountId, folder.nodeId, folder.key);
    expect(current.listing.capabilityEpoch).toBe(2);
    const stale = { ...current, listing: { ...current.listing, capabilityEpoch: 1 } };
    await expect(legacyFile(owner, owner.accountId, stale, "stale.md")).rejects.toThrow("legacy File 400");
    await expect(v2File(owner, owner.accountId, stale, "stale.md")).rejects.toThrow("v2 File 400");
    await legacyFile(owner, owner.accountId, current, "a.md");
    await v2File(owner, owner.accountId, await state(owner, owner.accountId, folder.nodeId, folder.key), "b.md");
    const move = await prepareTreeMove({ vaultId: owner.accountId, signer: owner.signer, source: await root(owner),
      destination: await state(owner, owner.accountId, folder.nodeId, folder.key), nodeId: loose,
      file: await fileSource(owner, loose), thread: await threadSource(owner, loose) });
    const moved = await call(owner, `/api/private/tree/nodes/${loose}/parent`, "PATCH", move);
    expect(moved.status, await moved.clone().text()).toBe(200);
    const after = await state(owner, owner.accountId, folder.nodeId, folder.key);
    expect(after.listing.entries.map((entry) => entry.name)).toEqual(["a.md", "b.md", "loose.md"]);
    // The signed listing head itself is sealed at epoch 2.
    const wire = await (await call(owner, `/api/private/tree/directories/${folder.nodeId}`, "POST")).json() as {
      entriesRevision: number; listingVersion: 1 | 2; entries: SealedEntry[];
      listingHead: Omit<StoredListingHead, "signerPublicKey"> & { signerPublicKey: string } };
    const head = { ...wire.listingHead, signerPublicKey: decodeTreeBytes(wire.listingHead.signerPublicKey, 65) };
    const options = { vaultId: owner.accountId, directoryId: folder.nodeId, revision: wire.entriesRevision,
      entries: wire.entries, version: wire.listingVersion, head };
    await expect(openListingHead(folder.key, { ...options, epoch: 2 })).resolves.toBeUndefined();
    await expect(openListingHead(folder.key, { ...options, epoch: 1 })).rejects.toThrow();
  });
});
