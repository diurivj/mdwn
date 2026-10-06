import { newPublicationIdentifier } from "../../app/shared/publications/capability";
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { createCommentKeyEnvelope, openCommentKeyEnvelope, type CommentKeyContext } from "../../app/shared/sharing/comment-keys";
import { createGrantKeyEnvelope, openGrantKeyEnvelope, type GrantKeyContext } from "../../app/shared/sharing/grant-keys";
import { sessionBindingDigest, signDeviceProof } from "../../app/shared/device/proof";
import { addSharingDevice, grant, opaqueId, prepareGrantKeys, sharingAccount, sharingRequest, treeChild } from "./sharing-fixtures";

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

it.each(["next", "expire"] as const)("provisioning %s rejects missing/foreign Origin and cross-site requests even with a valid proof", async (operation) => {
  const actor = await sharingAccount(), url = `https://mdwn.test/api/private/grant-provisioning/${operation}`;
  const method = operation === "next" ? "POST" : "PATCH", body = operation === "next" ? undefined : "{}";
  for (const origin of [null, "https://elsewhere.test", "https://mdwn.test"]) {
    const proof = await signDeviceProof(actor.assertion.privateKey, { sessionBinding: await sessionBindingDigest(actor.session.id),
      deviceId: actor.deviceId, registryEpoch: actor.registryEpoch, method, url, body });
    const headers = new Headers({ cookie: actor.session.cookie, "X-Mdwn-Device-Proof": JSON.stringify(proof),
      "Content-Type": "application/json" });
    if (origin) headers.set("Origin", origin);
    if (origin === "https://mdwn.test") headers.set("Sec-Fetch-Site", "cross-site");
    const rejected = await SELF.fetch(url, { method, body, headers });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("cache-control")).toBe("no-store");
    expect(await rejected.json()).toEqual({ error: "device_proof_required" });
    headers.set("Origin", "https://mdwn.test"); headers.set("Sec-Fetch-Site", "same-origin");
    expect((await SELF.fetch(url, { method, body, headers })).status).toBe(200);
  }
});

it("the bounded provisioning resource returns only current opaque work to an Owner or current capability holder", async () => {
  const owner = await sharingAccount(), recipient = await sharingAccount(), stranger = await sharingAccount();
  const targetId = await treeChild(owner, owner.rootId, "directory");
  const { grantId } = await grant(owner, recipient, targetId);
  const candidate = await addSharingDevice(recipient);
  const path = "/api/private/grant-provisioning/next";
  const response = await sharingRequest(recipient, path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const next = await response.json() as { item: { context: GrantKeyContext; device: { deviceId: string }; source: unknown } };
  expect(next.item.context).toMatchObject({ relationshipId: grantId, targetId, recipientRegistryEpoch: 2 });
  expect(next.item.device.deviceId).toBe(candidate.deviceId);
  expect(next.item.source).toMatchObject({ kind: "grant" });
  expect(await (await sharingRequest(stranger, path)).json()).toEqual({ item: null, pending: false });
  await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(candidate.deviceId, recipient.session.id).run();
  expect(await (await sharingRequest({ ...recipient, ...candidate }, path)).json()).toEqual({ item: null, pending: true });
});

it("a current Comment holder fulfills retained private and public history without completing root-only work early", async () => {
  const owner = await sharingAccount(), recipient = await sharingAccount();
  const targetId = await treeChild(owner, owner.rootId, "file");
  const { grantId } = await grant(owner, recipient, targetId);
  const paths: string[] = [];
  for (const purpose of ["private-comment-thread", "public-comment-audience-epoch"] as const) {
    const objectId = opaqueId(), capabilityId = opaqueId();
    await env.DB.prepare(`INSERT INTO sharing_comment_capabilities
      (object_id, owner_id, file_id, thread_id, purpose, publication_id, capability_id, capability_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).bind(objectId, owner.accountId, targetId, objectId, purpose,
        purpose === "private-comment-thread" ? null : newPublicationIdentifier(), capabilityId).run();
    const path = `/api/private/grants/${grantId}/comment-keys/${objectId}`;
    const context = await (await sharingRequest(owner, path)).json() as CommentKeyContext;
    const envelope = await createCommentKeyEnvelope(new Uint8Array(32).fill(81), recipient.transport.publicKey,
      owner.assertion.privateKey, { ...context, deviceId: recipient.deviceId, signerDeviceId: owner.deviceId });
    expect((await sharingRequest(owner, path, "PUT", { capabilityId, capabilityEpoch: 1,
      ownerRegistryEpoch: 1, recipientRegistryEpoch: 1, envelopes: [envelope] })).status).toBe(200);
    paths.push(path);
  }
  const candidate = await addSharingDevice(recipient);
  await prepareGrantKeys(owner, grantId, "grants");
  for (let index = 0; index < 2; index++) {
    const next = await (await sharingRequest(recipient, "/api/private/grant-provisioning/next")).json() as {
      item: { context: CommentKeyContext; source: { kind: string; envelope: Parameters<typeof openCommentKeyEnvelope>[0] } } };
    expect(next.item).not.toBeNull();
    const { context, source } = next.item;
    expect(source.kind).toBe("grant");
    const key = await openCommentKeyEnvelope({ ...source.envelope, recipient: recipient.transport });
    expect(Array.from(key)).toEqual(Array(32).fill(81));
    const envelope = await createCommentKeyEnvelope(key, candidate.transport.publicKey, recipient.assertion.privateKey,
      { ...context, deviceId: candidate.deviceId, signerDeviceId: recipient.deviceId });
    expect((await sharingRequest(recipient, `/api/private/grants/${grantId}/comment-keys/${context.objectId}`, "PUT", {
      capabilityId: context.capabilityId, capabilityEpoch: context.capabilityEpoch,
      ownerRegistryEpoch: context.ownerRegistryEpoch, recipientRegistryEpoch: context.recipientRegistryEpoch, envelopes: [envelope],
    })).status).toBe(200);
  }
  expect(await (await sharingRequest(owner, `/api/private/grants/${grantId}/needs`)).json()).toEqual({ needs: [], nextCursor: null });
  await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(candidate.deviceId, recipient.session.id).run();
  for (const path of paths) {
    const delivered = await (await sharingRequest({ ...recipient, ...candidate }, path)).json() as Parameters<typeof openCommentKeyEnvelope>[0];
    expect(Array.from(await openCommentKeyEnvelope({ ...delivered, recipient: candidate.transport }))).toEqual(Array(32).fill(81));
  }
});

it("a device missing the current capability and an unrelated Account cannot provision, even with valid envelope bytes", async () => {
  const owner = await sharingAccount(), recipient = await sharingAccount(), stranger = await sharingAccount();
  const targetId = await treeChild(owner, owner.rootId, "directory");
  const { grantId } = await grant(owner, recipient, targetId);
  const candidate = await addSharingDevice(recipient);
  const path = `/api/private/grants/${grantId}/keys`;
  const context = await (await sharingRequest(owner, path)).json() as GrantKeyContext;
  await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(candidate.deviceId, recipient.session.id).run();
  for (const source of [{ ...recipient, ...candidate }, stranger]) {
    const envelope = await createGrantKeyEnvelope(owner.keys.get(targetId)!, candidate.transport.publicKey,
      source.assertion.privateKey, { ...context, deviceId: candidate.deviceId, signerDeviceId: source.deviceId });
    expect((await sharingRequest(source, path, "PUT", { capabilityId: context.capabilityId,
      capabilityEpoch: context.capabilityEpoch, ownerRegistryEpoch: context.ownerRegistryEpoch,
      recipientRegistryEpoch: context.recipientRegistryEpoch, envelopes: [envelope] })).status).toBe(404);
  }
  expect((await sharingRequest({ ...recipient, ...candidate }, path)).status).toBe(409);
  expect(await (await sharingRequest(owner, `/api/private/grants/${grantId}/needs`)).json())
    .toMatchObject({ needs: [{ deviceId: candidate.deviceId }] });
});

it("revocation cancels prepared work and rejects both the holder and Owner's deferred uploads", async () => {
  const owner = await sharingAccount(), recipient = await sharingAccount();
  const targetId = await treeChild(owner, owner.rootId, "directory");
  const { grantId } = await grant(owner, recipient, targetId);
  const candidate = await addSharingDevice(recipient);
  const path = `/api/private/grants/${grantId}/keys`;
  const context = await (await sharingRequest(owner, path)).json() as GrantKeyContext;
  const packets = await Promise.all([owner, recipient].map(async (source) => ({
    capabilityId: context.capabilityId, capabilityEpoch: context.capabilityEpoch,
    ownerRegistryEpoch: context.ownerRegistryEpoch, recipientRegistryEpoch: context.recipientRegistryEpoch,
    envelopes: [await createGrantKeyEnvelope(source.keys.get(targetId)!, candidate.transport.publicKey,
      source.assertion.privateKey, { ...context, deviceId: candidate.deviceId, signerDeviceId: source.deviceId })],
  })));
  expect((await sharingRequest(owner, `/api/private/grants/${grantId}`, "DELETE", { expectedRevision: 1 })).status).toBe(200);
  for (const [index, source] of [owner, recipient].entries()) {
    expect((await sharingRequest(source, path, "PUT", packets[index]!)).status).toBe(404);
    expect(await (await sharingRequest(source, "/api/private/grant-provisioning/next")).json()).toEqual({ item: null, pending: false });
  }
  expect((await sharingRequest(recipient, `/api/private/tree/directories/${targetId}`)).status).toBe(404);
});

it("a twenty-device holder packet is bounded, retires needs and exact retries preserve the delivered bytes", async () => {
  const owner = await sharingAccount(), recipient = await sharingAccount();
  const targetId = await treeChild(owner, owner.rootId, "directory");
  const { grantId } = await grant(owner, recipient, targetId);
  const candidates = [];
  for (let index = 0; index < 20; index++) candidates.push(await addSharingDevice(recipient));
  const path = `/api/private/grants/${grantId}/keys`;
  const context = await (await sharingRequest(owner, path)).json() as GrantKeyContext;
  const envelopes = await Promise.all(candidates.map((candidate) => createGrantKeyEnvelope(recipient.keys.get(targetId)!,
    candidate.transport.publicKey, recipient.assertion.privateKey,
    { ...context, deviceId: candidate.deviceId, signerDeviceId: recipient.deviceId })));
  const packet = { capabilityId: context.capabilityId, capabilityEpoch: context.capabilityEpoch,
    ownerRegistryEpoch: context.ownerRegistryEpoch, recipientRegistryEpoch: context.recipientRegistryEpoch, envelopes };
  expect((await sharingRequest(recipient, path, "PUT", packet)).status).toBe(200);
  expect((await sharingRequest(recipient, path, "PUT", packet)).status).toBe(200);
  const resealed = await createGrantKeyEnvelope(recipient.keys.get(targetId)!, candidates[0]!.transport.publicKey,
    recipient.assertion.privateKey, { ...context, deviceId: candidates[0]!.deviceId, signerDeviceId: recipient.deviceId });
  expect((await sharingRequest(recipient, path, "PUT", { ...packet, envelopes: [resealed] })).status).toBe(200);
  expect((await sharingRequest(recipient, path, "PUT", { ...packet, envelopes: [...envelopes, envelopes[0]!] })).status).toBe(400);
  expect(await (await sharingRequest(owner, `/api/private/grants/${grantId}/needs`)).json()).toEqual({ needs: [], nextCursor: null });
  const candidate = candidates[0]!;
  await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(candidate.deviceId, recipient.session.id).run();
  expect(await (await sharingRequest({ ...recipient, ...candidate }, path)).json()).toMatchObject(envelopes[0]!);
});

it("an active recipient holding the current Grant can provision another enrolled device of the same Account", async () => {
  const owner = await sharingAccount(), recipient = await sharingAccount();
  const targetId = await treeChild(owner, owner.rootId, "directory");
  const { grantId } = await grant(owner, recipient, targetId);
  const candidate = await addSharingDevice(recipient);
  const path = `/api/private/grants/${grantId}/keys`;
  const context = await (await sharingRequest(owner, path)).json() as GrantKeyContext;
  const envelope = await createGrantKeyEnvelope(recipient.keys.get(targetId)!, candidate.transport.publicKey,
    recipient.assertion.privateKey, { ...context, deviceId: candidate.deviceId, signerDeviceId: recipient.deviceId });
  const packet = { capabilityId: context.capabilityId, capabilityEpoch: context.capabilityEpoch,
    ownerRegistryEpoch: context.ownerRegistryEpoch, recipientRegistryEpoch: context.recipientRegistryEpoch, envelopes: [envelope] };
  expect((await sharingRequest(recipient, path, "PUT", packet)).status).toBe(200);
  expect(await (await sharingRequest(owner, `/api/private/grants/${grantId}/needs`)).json()).toEqual({ needs: [], nextCursor: null });
  // Bind the fixture Session to the independently approved candidate at the authentication boundary.
  await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(candidate.deviceId, recipient.session.id).run();
  const receiving = { ...recipient, ...candidate };
  const delivered = await (await sharingRequest(receiving, path)).json() as Parameters<typeof openGrantKeyEnvelope>[0];
  expect(Array.from(await openGrantKeyEnvelope({ ...delivered, recipient: candidate.transport })))
    .toEqual(Array.from(recipient.keys.get(targetId)!));
});
