import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { createListingHead } from "../../app/shared/tree/listing";
import {
  deletePayload,
  grant,
  invite,
  movePayload,
  renamePayload,
  savePayload,
  sharingAccount,
  sharingRequest,
  treeChild,
  treeListing,
} from "./sharing-fixtures";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

it("a direct File Grant exposes only the target representation, never its parent, path, or neighbours", async () => {
  const owner = await sharingAccount(),
    collaborator = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  const neighbour = await treeChild(owner, directoryId, "file");
  await grant(owner, collaborator, fileId, "read_write");
  const response = await sharingRequest(collaborator, `/api/private/tree/files/${fileId}`);
  expect(response.status).toBe(200);
  const file = await response.json();
  expect(file).toMatchObject({ fileId, ownerId: owner.accountId, revision: 1 });
  for (const field of ["parentId", "nameCiphertext", "orderCiphertext", "keyEnvelope"])
    expect(file).not.toHaveProperty(field);
  expect((await sharingRequest(collaborator, `/api/private/tree/files/${neighbour}`)).status).toBe(404);
  expect((await sharingRequest(collaborator, `/api/private/tree/directories/${directoryId}`)).status).toBe(404);
  const ancestors = await sharingRequest(collaborator, `/api/private/tree/nodes/${fileId}/ancestors`);
  expect(ancestors.status).toBe(200);
  expect(await ancestors.json()).toEqual({ ancestors: [fileId] });
});

it("a Directory read/write Collaborator creates Owner-owned descendants and inherits them without new Grants", async () => {
  const owner = await sharingAccount(),
    collaborator = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  await grant(owner, collaborator, directoryId, "read_write");
  // grant() opened the actual device-specific capability delivery.
  expect(collaborator.keys.get(directoryId)).toEqual(owner.keys.get(directoryId));
  const nestedId = await treeChild(collaborator, directoryId, "directory", owner.accountId);
  const fileId = await treeChild(collaborator, nestedId, "file", owner.accountId);
  const file = await sharingRequest(collaborator, `/api/private/tree/files/${fileId}`);
  expect(file.status).toBe(200);
  expect(await file.json()).toMatchObject({ ownerId: owner.accountId, parentId: nestedId });
  const ancestry = await sharingRequest(collaborator, `/api/private/tree/nodes/${fileId}/ancestors`);
  expect(await ancestry.json()).toEqual({ ancestors: [directoryId, nestedId, fileId] });
  expect(await (await sharingRequest(collaborator, "/api/private/grants")).json()).toMatchObject({
    received: [{ targetId: directoryId }],
  });
  expect((await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).status).toBe(200);
});

it("Directory read/write permits renaming descendants but neither read-only nor direct File Grants do", async () => {
  const owner = await sharingAccount(),
    writer = await sharingAccount(),
    reader = await sharingAccount(),
    direct = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  await grant(owner, writer, directoryId, "read_write");
  await grant(owner, reader, directoryId, "read_only");
  await grant(owner, direct, fileId, "read_write");
  for (const actor of [writer, reader, direct]) actor.keys.set(directoryId, owner.keys.get(directoryId)!);
  const path = `/api/private/tree/nodes/${fileId}/name`;
  const ownerPayload = await renamePayload(owner, owner.accountId, fileId, directoryId);
  expect((await sharingRequest(reader, path, "PATCH", ownerPayload)).status).toBe(404);
  expect((await sharingRequest(direct, path, "PATCH", ownerPayload)).status).toBe(404);
  const written = await sharingRequest(
    writer,
    path,
    "PATCH",
    await renamePayload(writer, owner.accountId, fileId, directoryId),
  );
  expect(written.status).toBe(200);
  expect((await treeListing(owner, directoryId)).entriesRevision).toBe(ownerPayload.expectedRevision + 1);
  expect(
    (
      await sharingRequest(
        writer,
        `/api/private/tree/nodes/${directoryId}/name`,
        "PATCH",
        await renamePayload(owner, owner.accountId, directoryId, owner.rootId),
      )
    ).status,
  ).toBe(404);
});

it("Directory read/write allows descendant reordering without allowing shared-root reordering", async () => {
  const owner = await sharingAccount(),
    collaborator = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  await grant(owner, collaborator, directoryId, "read_write");
  collaborator.keys.set(directoryId, owner.keys.get(directoryId)!);
  const renamed = await renamePayload(collaborator, owner.accountId, fileId, directoryId);
  const listing = await treeListing(collaborator, directoryId);
  const body = {
    parentId: directoryId,
    expectedRevision: listing.entriesRevision,
    orders: [{ nodeId: fileId, orderCiphertext: renamed.orderCiphertext }],
    listingHead: await createListingHead(collaborator.keys.get(directoryId)!, collaborator.assertion.privateKey, {
      vaultId: owner.accountId,
      directoryId,
      deviceId: collaborator.deviceId,
      revision: listing.entriesRevision + 1,
      entries: listing.entries.map((entry) =>
        entry.nodeId === fileId ? { ...entry, orderCiphertext: renamed.orderCiphertext } : entry,
      ),
    }),
  };
  expect((await sharingRequest(collaborator, `/api/private/tree/nodes/${fileId}/order`, "PATCH", body)).status).toBe(
    200,
  );
  expect((await treeListing(owner, directoryId)).entriesRevision).toBe(3);
  expect(
    (
      await sharingRequest(collaborator, `/api/private/tree/nodes/${directoryId}/order`, "PATCH", {
        ...body,
        parentId: owner.rootId,
        orders: [{ nodeId: directoryId, orderCiphertext: renamed.orderCiphertext }],
      })
    ).status,
  ).toBe(404);
});

it("a Collaborator moves inside a common granted subtree but cannot move outside it", async () => {
  const owner = await sharingAccount(),
    collaborator = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const destinationId = await treeChild(owner, directoryId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  const outsideId = await treeChild(owner, owner.rootId, "directory");
  await grant(owner, collaborator, directoryId, "read_write");
  for (const id of [directoryId, destinationId]) collaborator.keys.set(id, owner.keys.get(id)!);
  expect(
    (
      await sharingRequest(
        collaborator,
        `/api/private/tree/nodes/${fileId}/parent`,
        "PATCH",
        await movePayload(collaborator, owner.accountId, fileId, directoryId, destinationId),
      )
    ).status,
  ).toBe(200);
  expect(await (await sharingRequest(collaborator, `/api/private/tree/nodes/${fileId}/ancestors`)).json()).toEqual({
    ancestors: [directoryId, destinationId, fileId],
  });
  expect(
    (
      await sharingRequest(
        collaborator,
        `/api/private/tree/nodes/${fileId}/parent`,
        "PATCH",
        await movePayload(owner, owner.accountId, fileId, destinationId, outsideId),
      )
    ).status,
  ).toBe(404);
});

it("defers Owner-controlled exits from a shared subtree until the required key rotation exists", async () => {
  const owner = await sharingAccount(),
    collaborator = await sharingAccount();
  const sourceId = await treeChild(owner, owner.rootId, "directory");
  const destinationId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, sourceId, "file");
  await grant(owner, collaborator, sourceId);
  const move = await sharingRequest(
    owner,
    `/api/private/tree/nodes/${fileId}/parent`,
    "PATCH",
    await movePayload(owner, owner.accountId, fileId, sourceId, destinationId),
  );
  expect(move.status).toBe(409);
  expect(await move.json()).toEqual({ error: "key_rotation_required" });
  expect((await treeListing(owner, sourceId)).entries).toHaveLength(1);
  expect((await treeListing(owner, destinationId)).entries).toHaveLength(0);
});

it("a Directory writer hard-deletes descendants and their sharing records, never the shared root", async () => {
  const owner = await sharingAccount(),
    writer = await sharingAccount(),
    direct = await sharingAccount(),
    pending = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  await grant(owner, writer, directoryId, "read_write");
  await grant(owner, direct, fileId);
  await invite(owner, pending, fileId);
  writer.keys.set(directoryId, owner.keys.get(directoryId)!);
  const deleted = await sharingRequest(
    writer,
    `/api/private/tree/nodes/${fileId}`,
    "DELETE",
    await deletePayload(writer, owner.accountId, fileId, directoryId),
  );
  expect(deleted.status).toBe(200);
  expect((await sharingRequest(direct, `/api/private/tree/files/${fileId}`)).status).toBe(404);
  expect(await (await sharingRequest(direct, "/api/private/grants")).json()).toMatchObject({ received: [] });
  expect(await (await sharingRequest(pending, "/api/private/shares")).json()).toMatchObject({ incoming: [] });
  expect(
    (
      await sharingRequest(
        writer,
        `/api/private/tree/nodes/${directoryId}`,
        "DELETE",
        await deletePayload(owner, owner.accountId, directoryId, owner.rootId),
      )
    ).status,
  ).toBe(404);
});

it("Directory read/write saves Markdown under the Owner identity while read-only cannot save", async () => {
  const owner = await sharingAccount(),
    writer = await sharingAccount(),
    reader = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  await grant(owner, writer, directoryId, "read_write");
  await grant(owner, reader, directoryId);
  writer.keys.set(directoryId, owner.keys.get(directoryId)!);
  const body = await savePayload(writer, owner.accountId, fileId, directoryId);
  expect((await sharingRequest(reader, `/api/private/tree/files/${fileId}`, "PATCH", body)).status).toBe(404);
  expect((await sharingRequest(writer, `/api/private/tree/files/${fileId}`, "PATCH", body)).status).toBe(200);
  const current = await sharingRequest(owner, `/api/private/tree/files/${fileId}`);
  expect(await current.json()).toMatchObject({ ownerId: owner.accountId, revision: 2, keyEpoch: 2 });
});

it("revocation ends server access immediately and seals future writes until key rotation", async () => {
  const owner = await sharingAccount(),
    collaborator = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  const active = await grant(owner, collaborator, directoryId, "read_write");
  const save = await savePayload(owner, owner.accountId, fileId, directoryId);
  expect(
    (await sharingRequest(owner, `/api/private/grants/${active.grantId}`, "DELETE", { expectedRevision: 1 })).status,
  ).toBe(200);
  expect((await sharingRequest(collaborator, `/api/private/tree/files/${fileId}`)).status).toBe(404);
  const blocked = await sharingRequest(owner, `/api/private/tree/files/${fileId}`, "PATCH", save);
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toEqual({ error: "key_rotation_required" });
  expect(await (await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).json()).toMatchObject({
    revision: 1,
  });
  // Hard deletion is a privacy/security action, not a new encrypted write.
  expect(
    (
      await sharingRequest(
        owner,
        `/api/private/tree/nodes/${directoryId}`,
        "DELETE",
        await deletePayload(owner, owner.accountId, directoryId, owner.rootId),
      )
    ).status,
  ).toBe(200);
});

it("direct File authority follows Owner rename/move but exposes no structural endpoint", async () => {
  const owner = await sharingAccount(),
    collaborator = await sharingAccount();
  const sourceId = await treeChild(owner, owner.rootId, "directory");
  const destinationId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, sourceId, "file");
  await grant(owner, collaborator, fileId, "read_write");
  const rename = await renamePayload(owner, owner.accountId, fileId, sourceId);
  expect((await sharingRequest(collaborator, `/api/private/tree/nodes/${fileId}/name`, "PATCH", rename)).status).toBe(
    404,
  );
  expect(
    (
      await sharingRequest(collaborator, `/api/private/tree/nodes/${fileId}/order`, "PATCH", {
        parentId: sourceId,
        expectedRevision: rename.expectedRevision,
        orders: [{ nodeId: fileId, orderCiphertext: rename.orderCiphertext }],
        listingHead: rename.listingHead,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await sharingRequest(
        collaborator,
        `/api/private/tree/nodes/${fileId}`,
        "DELETE",
        await deletePayload(owner, owner.accountId, fileId, sourceId),
      )
    ).status,
  ).toBe(404);
  const move = await movePayload(owner, owner.accountId, fileId, sourceId, destinationId);
  expect((await sharingRequest(collaborator, `/api/private/tree/nodes/${fileId}/parent`, "PATCH", move)).status).toBe(
    404,
  );
  expect((await sharingRequest(owner, `/api/private/tree/nodes/${fileId}/name`, "PATCH", rename)).status).toBe(200);
  expect(
    (
      await sharingRequest(
        owner,
        `/api/private/tree/nodes/${fileId}/parent`,
        "PATCH",
        await movePayload(owner, owner.accountId, fileId, sourceId, destinationId),
      )
    ).status,
  ).toBe(200);
  const result = await sharingRequest(collaborator, `/api/private/tree/files/${fileId}`);
  expect(result.status).toBe(200);
  const file = await result.json();
  expect(file).toMatchObject({ fileId, revision: 1 });
  expect(file).not.toHaveProperty("parentId");
  const save = await savePayload(collaborator, owner.accountId, fileId, destinationId);
  const saved = await sharingRequest(collaborator, `/api/private/tree/files/${fileId}`, "PATCH", save);
  expect(saved.status).toBe(200);
  expect(save).not.toHaveProperty("expectedParentRevision");
  expect(await (await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).json()).toMatchObject({
    revision: 2,
  });
});

it("a File-only revocation seal also blocks reordering that File, not unrelated sibling creation", async () => {
  const owner = await sharingAccount(),
    collaborator = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  const active = await grant(owner, collaborator, fileId);
  expect(
    (await sharingRequest(owner, `/api/private/grants/${active.grantId}`, "DELETE", { expectedRevision: 1 })).status,
  ).toBe(200);
  const listing = await treeListing(owner, directoryId);
  const order = (await renamePayload(owner, owner.accountId, fileId, directoryId)).orderCiphertext;
  const reorder = await sharingRequest(owner, `/api/private/tree/nodes/${fileId}/order`, "PATCH", {
    parentId: directoryId,
    expectedRevision: listing.entriesRevision,
    orders: [{ nodeId: fileId, orderCiphertext: order }],
    listingHead: await createListingHead(owner.keys.get(directoryId)!, owner.assertion.privateKey, {
      vaultId: owner.accountId,
      directoryId,
      deviceId: owner.deviceId,
      revision: listing.entriesRevision + 1,
      entries: listing.entries.map((entry) => (entry.nodeId === fileId ? { ...entry, orderCiphertext: order } : entry)),
    }),
  });
  expect(reorder.status).toBe(409);
  expect(await reorder.json()).toEqual({ error: "key_rotation_required" });
  expect(await treeChild(owner, directoryId, "file")).toBeTypeOf("string");
});

it("a prepared move whose File was deleted returns a namespace conflict, not a misleading not-found", async () => {
  const owner = await sharingAccount();
  const sourceId = await treeChild(owner, owner.rootId, "directory");
  const destinationId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, sourceId, "file");
  const move = await movePayload(owner, owner.accountId, fileId, sourceId, destinationId);
  expect(
    (
      await sharingRequest(
        owner,
        `/api/private/tree/nodes/${fileId}`,
        "DELETE",
        await deletePayload(owner, owner.accountId, fileId, sourceId),
      )
    ).status,
  ).toBe(200);
  const stale = await sharingRequest(owner, `/api/private/tree/nodes/${fileId}/parent`, "PATCH", move);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ error: "namespace_changed" });
  expect((await treeListing(owner, destinationId)).entries).toEqual([]);
});
