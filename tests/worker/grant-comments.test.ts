import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import {
  createCommentKeyEnvelope,
  openCommentKeyEnvelope,
  type CommentKeyContext,
} from "../../app/shared/sharing/comment-keys";
import { newPublicationIdentifier } from "../../app/shared/publications/capability";
import { encodeTreeBytes } from "../../app/shared/tree/wire";
import {
  addSharingDevice,
  deletePayload,
  invite,
  opaqueId,
  prepareGrantKeys,
  sharingAccount,
  sharingRequest,
  treeChild,
  type SharingAccount,
} from "./sharing-fixtures";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

/** Later Comment producers register opaque capability metadata at their storage boundary. */
async function privateThread(owner: SharingAccount, fileId: string) {
  const objectId = opaqueId(),
    capabilityId = opaqueId();
  await env.DB.prepare(`INSERT INTO sharing_comment_capabilities
    (object_id, owner_id, file_id, thread_id, purpose, publication_id, capability_id, capability_epoch)
    VALUES (?, ?, ?, ?, 'private-comment-thread', NULL, ?, 1)`)
    .bind(objectId, owner.accountId, fileId, objectId, capabilityId)
    .run();
  return { objectId, capabilityId };
}

const commentKey = new Uint8Array(32).fill(73);
type Targets = CommentKeyContext & {
  devices: { deviceId: string; transportPublicKey: string }[];
  nextCursor: string | null;
};
async function deliverComment(
  owner: SharingAccount,
  recipient: SharingAccount,
  id: string,
  objectId: string,
  kind = "shares",
) {
  const path = `/api/private/${kind}/${id}/comment-keys/${objectId}`;
  const targets = await sharingRequest(owner, path);
  expect(targets.status).toBe(200);
  const context = (await targets.json()) as Targets;
  const envelope = await createCommentKeyEnvelope(
    commentKey,
    recipient.transport.publicKey,
    owner.assertion.privateKey,
    { ...context, deviceId: recipient.deviceId, signerDeviceId: owner.deviceId },
  );
  const packet = {
    capabilityId: context.capabilityId,
    capabilityEpoch: context.capabilityEpoch,
    ownerRegistryEpoch: context.ownerRegistryEpoch,
    recipientRegistryEpoch: context.recipientRegistryEpoch,
    envelopes: [envelope],
  };
  expect((await sharingRequest(owner, path, "PUT", packet)).status).toBe(200);
  return { path, context, packet };
}

async function publicEpoch(
  owner: SharingAccount,
  fileId: string,
  threadId = opaqueId(),
  publicationId = newPublicationIdentifier(),
) {
  const objectId = opaqueId(),
    capabilityId = opaqueId();
  await env.DB.prepare(`INSERT INTO sharing_comment_capabilities
    (object_id, owner_id, file_id, thread_id, purpose, publication_id, capability_id, capability_epoch)
    VALUES (?, ?, ?, ?, 'public-comment-audience-epoch', ?, ?, 1)`)
    .bind(objectId, owner.accountId, fileId, threadId, publicationId, capabilityId)
    .run();
  return { objectId, capabilityId, threadId, publicationId };
}

it("root delivery alone cannot accept a Share whose File has a required Private Comment capability", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  await privateThread(owner, fileId);
  const { shareId } = await invite(owner, recipient, directoryId);
  await prepareGrantKeys(owner, shareId);
  expect((await sharingRequest(recipient, `/api/private/shares/${shareId}/accept`, "POST", {})).status).toBe(409);
  expect(await (await sharingRequest(recipient, "/api/private/grants")).json()).toMatchObject({ received: [] });
  expect(await (await sharingRequest(recipient, "/api/private/shares")).json()).toMatchObject({
    incoming: [{ shareId }],
  });
});

it("lists only required Private and retained Public-history capabilities in the shared subtree", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount(),
    stranger = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  const hiddenId = await treeChild(owner, owner.rootId, "file");
  const privateComment = await privateThread(owner, fileId);
  const publicComment = await publicEpoch(owner, fileId);
  await privateThread(owner, hiddenId);
  const { shareId } = await invite(owner, recipient, directoryId);
  const path = `/api/private/shares/${shareId}/comment-keys`;
  const response = await sharingRequest(owner, path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    capabilities: [
      ...[privateComment, publicComment]
        .sort((a, b) => a.objectId.localeCompare(b.objectId))
        .map((item) => ({
          relationshipId: shareId,
          targetId: directoryId,
          fileId,
          objectId: item.objectId,
          capabilityId: item.capabilityId,
          capabilityEpoch: 1,
        })),
    ],
    nextCursor: null,
  });
  expect((await sharingRequest(recipient, path)).status).toBe(404);
  expect((await sharingRequest(stranger, path)).status).toBe(404);
});

it("revocation, leave, permission change, cancellation and decline remove Comment delivery independently of retained keys", async () => {
  for (const operation of ["revoke", "leave", "permission", "cancel", "decline"] as const) {
    const owner = await sharingAccount(),
      recipient = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file");
    const thread = await privateThread(owner, fileId);
    const { shareId } = await invite(owner, recipient, fileId);
    await prepareGrantKeys(owner, shareId);
    const delivered = await deliverComment(owner, recipient, shareId, thread.objectId);
    const pending = operation === "cancel" || operation === "decline";
    if (!pending)
      expect((await sharingRequest(recipient, `/api/private/shares/${shareId}/accept`, "POST", {})).status).toBe(201);
    const path = `/api/private/${pending ? "shares" : "grants"}/${shareId}`;
    const response =
      operation === "cancel"
        ? await sharingRequest(owner, path, "DELETE", {})
        : operation === "decline"
          ? await sharingRequest(recipient, `${path}/decline`, "POST", {})
          : operation === "leave"
            ? await sharingRequest(recipient, `${path}/leave`, "POST", { expectedRevision: 1 })
            : operation === "permission"
              ? await sharingRequest(owner, path, "PATCH", { expectedRevision: 1, permission: "read_write" })
              : await sharingRequest(owner, path, "DELETE", { expectedRevision: 1 });
    expect(response.status, operation).toBe(200);
    expect((await sharingRequest(recipient, `${path}/comment-keys/${thread.objectId}`)).status).toBe(
      operation === "permission" ? 409 : 404,
    );
    expect((await sharingRequest(owner, delivered.path, "PUT", delivered.packet)).status).toBe(404);
  }
});

it("Comment packets reject cross-object, cross-purpose, stale-epoch, future-epoch and non-Owner intent", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount(),
    stranger = await sharingAccount();
  const fileId = await treeChild(owner, owner.rootId, "file");
  const thread = await privateThread(owner, fileId);
  const { shareId } = await invite(owner, recipient, fileId);
  const delivered = await deliverComment(owner, recipient, shareId, thread.objectId);
  const wrongThreadId = opaqueId();
  for (const changed of [
    { fileId: owner.rootId },
    { threadId: wrongThreadId, objectId: wrongThreadId },
    { capabilityEpoch: 2 },
    { grantKeyEpoch: 2 },
    { ownerRegistryEpoch: 2 },
    { recipientRegistryEpoch: 2 },
    { recipientId: stranger.accountId },
    { purpose: "public-comment-audience-epoch" as const, publicationId: newPublicationIdentifier() },
  ]) {
    const envelope = await createCommentKeyEnvelope(
      commentKey,
      recipient.transport.publicKey,
      owner.assertion.privateKey,
      { ...delivered.context, ...changed, deviceId: recipient.deviceId, signerDeviceId: owner.deviceId },
    );
    expect(
      (await sharingRequest(owner, delivered.path, "PUT", { ...delivered.packet, envelopes: [envelope] })).status,
    ).toBe(400);
  }
  const wrongSigner = await createCommentKeyEnvelope(
    commentKey,
    recipient.transport.publicKey,
    stranger.assertion.privateKey,
    { ...delivered.context, deviceId: recipient.deviceId, signerDeviceId: owner.deviceId },
  );
  expect(
    (await sharingRequest(owner, delivered.path, "PUT", { ...delivered.packet, envelopes: [wrongSigner] })).status,
  ).toBe(400);
  expect((await sharingRequest(owner, delivered.path, "PUT", { ...delivered.packet, capabilityEpoch: 2 })).status).toBe(
    409,
  );
  expect((await sharingRequest(recipient, delivered.path, "PUT", delivered.packet)).status).toBe(404);
});

it("malformed Comment packets never replace a previously admitted signed envelope", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const fileId = await treeChild(owner, owner.rootId, "file");
  const thread = await privateThread(owner, fileId);
  const { shareId } = await invite(owner, recipient, fileId);
  const delivered = await deliverComment(owner, recipient, shareId, thread.objectId);
  const envelope = delivered.packet.envelopes[0]!;
  for (const packet of [
    { ...delivered.packet, extra: true },
    { ...delivered.packet, capabilityId: "not-an-id" },
    { ...delivered.packet, capabilityEpoch: 0 },
    { ...delivered.packet, ownerRegistryEpoch: 1.5 },
    { ...delivered.packet, recipientRegistryEpoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...delivered.packet, envelopes: [] },
    { ...delivered.packet, envelopes: Array(21).fill(envelope) },
    { ...delivered.packet, envelopes: [envelope, envelope] },
    ...[
      { extra: true },
      { deviceId: "not-an-id" },
      { ciphertext: envelope.ciphertext + "=" },
      { ciphertext: "A".repeat(22_000) },
      { signature: "AA" },
      { signature: envelope.signature + "AA" },
    ].map((change) => ({ ...delivered.packet, envelopes: [{ ...envelope, ...change }] })),
  ])
    expect((await sharingRequest(owner, delivered.path, "PUT", packet)).status).toBe(400);
  await prepareGrantKeys(owner, shareId);
  expect((await sharingRequest(recipient, `/api/private/shares/${shareId}/accept`, "POST", {})).status).toBe(201);
  expect(
    await (await sharingRequest(recipient, `/api/private/grants/${shareId}/comment-keys/${thread.objectId}`)).json(),
  ).toMatchObject({ ciphertext: envelope.ciphertext, signature: envelope.signature });
});

it("registry additions require complete current pending Comment snapshots without destroying accepted historical delivery", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const fileId = await treeChild(owner, owner.rootId, "file");
  const thread = await privateThread(owner, fileId);
  const { shareId } = await invite(owner, recipient, fileId);
  await prepareGrantKeys(owner, shareId);
  await deliverComment(owner, recipient, shareId, thread.objectId);
  const second = await addSharingDevice(recipient);
  await prepareGrantKeys(owner, shareId);
  const accept = () => sharingRequest(recipient, `/api/private/shares/${shareId}/accept`, "POST", {});
  expect((await accept()).status).toBe(409);
  const delivered = await deliverComment(owner, recipient, shareId, thread.objectId);
  expect((await accept()).status).toBe(409);
  const envelope = await createCommentKeyEnvelope(commentKey, second.transport.publicKey, owner.assertion.privateKey, {
    ...delivered.context,
    deviceId: second.deviceId,
    signerDeviceId: owner.deviceId,
  });
  expect(
    (await sharingRequest(owner, delivered.path, "PUT", { ...delivered.packet, envelopes: [envelope] })).status,
  ).toBe(200);
  expect((await accept()).status).toBe(201);
  await addSharingDevice(recipient);
  await addSharingDevice(owner);
  const active = `/api/private/grants/${shareId}/comment-keys/${thread.objectId}`;
  await deliverComment(owner, { ...recipient, ...second }, shareId, thread.objectId, "grants");
  const record = (await (await sharingRequest(recipient, active)).json()) as Parameters<
    typeof openCommentKeyEnvelope
  >[0];
  expect(record.recipientRegistryEpoch).toBe(2);
  expect(record.ownerRegistryEpoch).toBe(1);
  expect(await openCommentKeyEnvelope({ ...record, recipient: recipient.transport })).toEqual(commentKey);
});

it("hard deletion removes Comment envelopes and needs for deleted Files while preserving ancestor Grants", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const { shareId } = await invite(owner, recipient, directoryId);
  await prepareGrantKeys(owner, shareId);
  expect((await sharingRequest(recipient, `/api/private/shares/${shareId}/accept`, "POST", {})).status).toBe(201);
  const fileId = await treeChild(owner, directoryId, "file");
  const thread = await privateThread(owner, fileId);
  await publicEpoch(owner, fileId);
  await deliverComment(owner, recipient, shareId, thread.objectId, "grants");
  expect(await (await sharingRequest(owner, `/api/private/grants/${shareId}/needs`)).json()).toMatchObject({
    needs: [{ grantId: shareId }],
  });
  const deletion = await deletePayload(owner, owner.accountId, fileId, directoryId);
  expect((await sharingRequest(owner, `/api/private/tree/nodes/${fileId}`, "DELETE", deletion)).status).toBe(200);
  expect((await sharingRequest(recipient, `/api/private/tree/files/${fileId}`)).status).toBe(404);
  expect(
    (await sharingRequest(recipient, `/api/private/grants/${shareId}/comment-keys/${thread.objectId}`)).status,
  ).toBe(404);
  expect(await (await sharingRequest(owner, `/api/private/grants/${shareId}/needs`)).json()).toEqual({
    needs: [],
    nextCursor: null,
  });
  expect((await sharingRequest(recipient, `/api/private/grants/${shareId}/keys`)).status).toBe(200);
});

it("atomically accepts only complete Private and retained Public-history device coverage and opens each literal key", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const fileId = await treeChild(owner, owner.rootId, "file");
  const privateComment = await privateThread(owner, fileId);
  const publicComment = await publicEpoch(owner, fileId);
  const retained = await publicEpoch(owner, fileId, publicComment.threadId, publicComment.publicationId);
  const { shareId } = await invite(owner, recipient, fileId);
  await prepareGrantKeys(owner, shareId);
  await deliverComment(owner, recipient, shareId, privateComment.objectId);
  await deliverComment(owner, recipient, shareId, publicComment.objectId);
  const acceptPath = `/api/private/shares/${shareId}/accept`;
  expect((await sharingRequest(recipient, acceptPath, "POST", {})).status).toBe(409);
  await deliverComment(owner, recipient, shareId, retained.objectId);
  expect((await sharingRequest(recipient, acceptPath, "POST", {})).status).toBe(201);
  for (const comment of [privateComment, publicComment, retained]) {
    const path = `/api/private/grants/${shareId}/comment-keys/${comment.objectId}`;
    const response = await sharingRequest(recipient, path);
    expect(response.status).toBe(200);
    const envelope = (await response.json()) as Parameters<typeof openCommentKeyEnvelope>[0];
    expect(await openCommentKeyEnvelope({ ...envelope, recipient: recipient.transport })).toEqual(commentKey);
    expect(
      (await sharingRequest(owner, `/api/private/shares/${shareId}/comment-keys/${comment.objectId}`)).status,
    ).toBe(404);
  }
});

it("share Comment targets give only the Owner its own current vault-recovery source", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount(),
    stranger = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const current = await privateThread(owner, await treeChild(owner, directoryId, "file"));
  const stale = await privateThread(owner, await treeChild(owner, directoryId, "file"));
  const missing = await privateThread(owner, await treeChild(owner, directoryId, "file"));
  await env.DB.prepare("UPDATE sharing_comment_capabilities SET capability_epoch = 2 WHERE object_id = ?")
    .bind(stale.objectId)
    .run();
  const recovery = (account: SharingAccount, objectId: string, keyEpoch: number, bytes: number) =>
    env.DB.prepare(`INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch)
      VALUES (?, 'vault-recovery', ?, 'vault-root', ?, ?)`)
      .bind(account.accountId, objectId, new Uint8Array(48).fill(bytes), keyEpoch)
      .run();
  await recovery(owner, current.objectId, 1, 1);
  // A superseded epoch, and another Account's row for the same object, are never a source.
  await recovery(owner, stale.objectId, 1, 2);
  await recovery(stranger, missing.objectId, 1, 3);
  const { shareId } = await invite(owner, recipient, directoryId);
  const target = (objectId: string) => `/api/private/shares/${shareId}/comment-keys/${objectId}`;

  const response = await sharingRequest(owner, target(current.objectId));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { source?: { kind: string; envelope: string } };
  expect(body.source).toEqual({ kind: "recovery", envelope: encodeTreeBytes(new Uint8Array(48).fill(1)) });
  for (const objectId of [stale.objectId, missing.objectId]) {
    const other = await sharingRequest(owner, target(objectId));
    expect(other.status).toBe(200);
    expect(await other.json()).not.toHaveProperty("source");
  }
  for (const account of [recipient, stranger]) {
    const denied = await sharingRequest(account, target(current.objectId));
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain(encodeTreeBytes(new Uint8Array(48).fill(1)));
  }
});
