import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { createCommentKeyEnvelope, type CommentKeyContext } from "../../app/shared/sharing/comment-keys";
import {
  addSharingDevice,
  grant,
  opaqueId,
  prepareGrantKeys,
  sharingAccount,
  sharingRequest,
  treeChild,
} from "./sharing-fixtures";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

it("an approved new device creates only an opaque active-Grant provisioning need without invalidating existing envelopes", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount(),
    stranger = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const { grantId } = await grant(owner, recipient, directoryId);
  const device = await addSharingDevice(recipient);
  const path = `/api/private/grants/${grantId}/needs`;
  const response = await sharingRequest(owner, path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    needs: [{ grantId, deviceId: device.deviceId, grantKeyEpoch: 1 }],
    nextCursor: null,
  });
  expect((await sharingRequest(recipient, `/api/private/grants/${grantId}/keys`)).status).toBe(200);
  expect(await (await sharingRequest(recipient, path)).json()).toEqual({ needs: [], nextCursor: null });
  expect((await sharingRequest(stranger, path)).status).toBe(404);
});

it("revoke and leave cancel pending device needs before any later delivery can resurrect authorization", async () => {
  for (const operation of ["revoke", "leave"] as const) {
    const owner = await sharingAccount(),
      recipient = await sharingAccount();
    const directoryId = await treeChild(owner, owner.rootId, "directory");
    const { grantId } = await grant(owner, recipient, directoryId);
    await addSharingDevice(recipient);
    const path = `/api/private/grants/${grantId}`;
    expect(
      (
        await sharingRequest(
          operation === "revoke" ? owner : recipient,
          `${path}${operation === "leave" ? "/leave" : ""}`,
          operation === "revoke" ? "DELETE" : "POST",
          { expectedRevision: 1 },
        )
      ).status,
    ).toBe(200);
    expect((await sharingRequest(owner, `${path}/needs`)).status).toBe(404);
    expect((await sharingRequest(owner, `${path}/keys`)).status).toBe(404);
    expect((await sharingRequest(recipient, `${path}/keys`)).status).toBe(404);
  }
});

it("permission changes replace pending work with the exact new Grant epoch while rotation still seals delivery", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const { grantId } = await grant(owner, recipient, directoryId);
  await addSharingDevice(recipient);
  const path = `/api/private/grants/${grantId}`;
  expect((await sharingRequest(owner, path, "PATCH", { expectedRevision: 1, permission: "read_write" })).status).toBe(
    200,
  );
  const needs = (await (await sharingRequest(owner, `${path}/needs`)).json()) as { needs: { grantKeyEpoch: number }[] };
  expect(needs.needs).toHaveLength(2);
  expect(needs.needs.map((need) => need.grantKeyEpoch)).toEqual([2, 2]);
  expect((await sharingRequest(recipient, `${path}/keys`)).status).toBe(409);
});

it("new Comment material records preparation needs and root-only delivery cannot mark retained history complete", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const fileId = await treeChild(owner, owner.rootId, "file");
  const { grantId } = await grant(owner, recipient, fileId);
  const objectId = opaqueId(),
    capabilityId = opaqueId();
  await env.DB.prepare(`INSERT INTO sharing_comment_capabilities
    (object_id, owner_id, file_id, thread_id, purpose, publication_id, capability_id, capability_epoch)
    VALUES (?, ?, ?, ?, 'private-comment-thread', NULL, ?, 1)`)
    .bind(objectId, owner.accountId, fileId, objectId, capabilityId)
    .run();
  const path = `/api/private/grants/${grantId}`;
  expect(await (await sharingRequest(owner, `${path}/needs`)).json()).toMatchObject({
    needs: [{ deviceId: recipient.deviceId }],
  });
  expect(await (await sharingRequest(recipient, `${path}/comment-keys/${objectId}`)).json()).toEqual({
    error: "secure_access_preparing",
  });
  await prepareGrantKeys(owner, grantId, "grants");
  expect(await (await sharingRequest(owner, `${path}/needs`)).json()).toMatchObject({
    needs: [{ deviceId: recipient.deviceId }],
  });
  const context = (await (await sharingRequest(owner, `${path}/comment-keys/${objectId}`)).json()) as CommentKeyContext;
  const envelope = await createCommentKeyEnvelope(
    new Uint8Array(32).fill(81),
    recipient.transport.publicKey,
    owner.assertion.privateKey,
    { ...context, deviceId: recipient.deviceId, signerDeviceId: owner.deviceId },
  );
  const packet = {
    capabilityId,
    capabilityEpoch: 1,
    ownerRegistryEpoch: 1,
    recipientRegistryEpoch: 1,
    envelopes: [envelope],
  };
  expect((await sharingRequest(owner, `${path}/comment-keys/${objectId}`, "PUT", packet)).status).toBe(200);
  expect(await (await sharingRequest(owner, `${path}/needs`)).json()).toEqual({ needs: [], nextCursor: null });
  await env.DB.prepare("UPDATE sharing_comment_capabilities SET capability_epoch = 2 WHERE object_id = ?")
    .bind(objectId)
    .run();
  expect(await (await sharingRequest(owner, `${path}/needs`)).json()).toMatchObject({
    needs: [{ deviceId: recipient.deviceId }],
  });
  expect((await sharingRequest(recipient, `${path}/comment-keys/${objectId}`)).status).toBe(409);
  expect((await sharingRequest(owner, `${path}/comment-keys/${objectId}`, "PUT", packet)).status).toBe(409);
});

it("proof-gated reconciliation removes completed or inactive needs and cannot create work for an unrelated Account", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount(),
    stranger = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const { grantId } = await grant(owner, recipient, directoryId);
  const device = await addSharingDevice(recipient);
  await env.DB.prepare("INSERT INTO provisioning_needs (grant_id, device_id, grant_key_epoch) VALUES (?, ?, 1)")
    .bind(grantId, recipient.deviceId)
    .run();
  await env.DB.prepare("UPDATE encryption_devices SET state = 'revoked' WHERE id = ?").bind(device.deviceId).run();
  const path = `/api/private/grants/${grantId}/needs`;
  expect((await sharingRequest(stranger, path, "PUT", {})).status).toBe(404);
  expect((await sharingRequest(owner, path, "PUT", { name: "not allowed" })).status).toBe(400);
  expect((await sharingRequest(owner, path, "PUT", {}, "reconcile")).status).toBe(200);
  expect(await (await sharingRequest(owner, path)).json()).toEqual({ needs: [], nextCursor: null });
  expect((await sharingRequest(owner, path, "PUT", {}, "reconcile")).status).toBe(409);
  expect((await sharingRequest(owner, path, "PUT", {})).status).toBe(200);
});

it("current complete delivery retires a need atomically and a repeated pass leaves it complete", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const { grantId } = await grant(owner, recipient, directoryId);
  await addSharingDevice(recipient);
  const path = `/api/private/grants/${grantId}/needs`;
  expect(await (await sharingRequest(owner, path)).json()).toMatchObject({ needs: [{ grantId }] });
  await prepareGrantKeys(owner, grantId, "grants");
  expect(await (await sharingRequest(owner, path)).json()).toEqual({ needs: [], nextCursor: null });
  await prepareGrantKeys(owner, grantId, "grants");
  expect(await (await sharingRequest(owner, path)).json()).toEqual({ needs: [], nextCursor: null });
});
