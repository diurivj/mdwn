import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
import { createSymmetricWriter, digestEnvelope, inspectEnvelope, openSymmetric } from "../../app/crypto/enc-v1";
import { createListingHead } from "../../app/tree/listing";
import { createFileRepresentation } from "../../app/crypto/vault";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/tree/wire";
import { grant, movePayload, opaqueId, renamePayload, sharingAccount, sharingRequest, treeChild, treeListing, type SharingAccount } from "./sharing-fixtures";

async function conversion(owner: SharingAccount, fileId: string, parentId: string) {
  const before = await (await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).json() as {
    revision: number; representationId: string; contentKeyId: string; keyEpoch: number; ciphertext: string; keyEnvelope: string;
  };
  const listing = await treeListing(owner, parentId);
  const parentKey = owner.keys.get(parentId)!;
  const contentContext = inspectEnvelope(decodeTreeBytes(before.keyEnvelope)).context;
  const contentKey = await openSymmetric(decodeTreeBytes(before.keyEnvelope), parentKey, { context: contentContext });
  const key = crypto.getRandomValues(new Uint8Array(32)), capability = { id: opaqueId(), epoch: 1 };
  const keyEnvelope = encodeTreeBytes(await (await createSymmetricWriter(parentKey)).seal(key, {
    purpose: "file-capability", vaultId: owner.accountId, objectId: fileId, keyId: capability.id, keyEpoch: 1, revision: 1,
  }));
  const representationKeyEnvelope = encodeTreeBytes(await (await createSymmetricWriter(key)).seal(contentKey, contentContext));
  const message = new TextEncoder().encode(JSON.stringify([
    "mdwn/file-head/v1", owner.accountId, fileId, capability.id, capability.epoch, before.representationId,
    before.contentKeyId, before.keyEpoch, before.revision, owner.deviceId,
    encodeTreeBytes(await digestEnvelope(decodeTreeBytes(before.ciphertext))),
    encodeTreeBytes(await digestEnvelope(decodeTreeBytes(representationKeyEnvelope))),
  ]));
  const fileHead = { digest: encodeTreeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", message))),
    signature: encodeTreeBytes(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, owner.assertion.privateKey, message))) };
  const listingHead = await createListingHead(parentKey, owner.assertion.privateKey, {
    vaultId: owner.accountId, directoryId: parentId, deviceId: owner.deviceId, revision: listing.entriesRevision + 1,
    entries: listing.entries.map((entry) => entry.nodeId === fileId ? { ...entry, keyEnvelope } : entry),
  });
  return { key, before, body: { expectedRevision: before.revision, expectedRepresentationId: before.representationId,
    expectedParentRevision: listing.entriesRevision, capability, keyEnvelope, representationKeyEnvelope, fileHead, listingHead } };
}

async function parentFreeSave(actor: SharingAccount, ownerId: string, fileId: string, capability: { id: string; epoch: number }, key: Uint8Array) {
  const current = await (await sharingRequest(actor, `/api/private/tree/files/${fileId}`)).json() as {
    revision: number; representationId: string; keyEpoch: number;
  };
  const id = opaqueId(), contentKeyId = opaqueId(), keyEpoch = current.keyEpoch + 1, revision = current.revision + 1;
  const encrypted = await createFileRepresentation(key, { markdown: "# parent-free", metadata: new Uint8Array() }, {
    vaultId: ownerId, fileId, keyId: contentKeyId, keyEpoch, revision,
  });
  const ciphertext = encodeTreeBytes(encrypted.contentEnvelope), keyEnvelope = encodeTreeBytes(encrypted.fileContentKeyEnvelope);
  const message = new TextEncoder().encode(JSON.stringify([
    "mdwn/file-head/v1", ownerId, fileId, capability.id, capability.epoch, id, contentKeyId, keyEpoch, revision, actor.deviceId,
    encodeTreeBytes(await digestEnvelope(encrypted.contentEnvelope)), encodeTreeBytes(await digestEnvelope(encrypted.fileContentKeyEnvelope)),
  ]));
  const fileHead = { digest: encodeTreeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", message))),
    signature: encodeTreeBytes(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, actor.assertion.privateKey, message))) };
  return { expectedRevision: current.revision, expectedRepresentationId: current.representationId, capability,
    representation: { id, contentKeyId, keyEpoch, revision, ciphertext, keyEnvelope, fileHead } };
}

describe("browser-driven File capability conversion", () => {
  it("creates a capability-format File atomically under Directory collaborator authority and Owner identity", async () => {
    const owner = await sharingAccount(), collaborator = await sharingAccount();
    const parent = await treeChild(owner, owner.rootId, "directory");
    await grant(owner, collaborator, parent, "read_write");
    const fileId = await treeChild(collaborator, parent, "file", owner.accountId, true);
    const current = await (await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).json() as {
      ownerId: string; capability: { id: string; epoch: number }; fileHead: { signerDeviceId: string };
    };
    expect(current.ownerId).toBe(owner.accountId);
    expect(current.capability.epoch).toBe(1);
    expect(current.fileHead.signerDeviceId).toBe(collaborator.deviceId);
    const payload = await parentFreeSave(collaborator, owner.accountId, fileId, current.capability, collaborator.keys.get(fileId)!);
    expect((await sharingRequest(collaborator, `/api/private/tree/files/${fileId}`, "PATCH", payload)).status).toBe(200);
  });

  it("atomically converts a legacy File without replacing its content or File revision", async () => {
    const owner = await sharingAccount(), fileId = await treeChild(owner, owner.rootId, "file");
    const prepared = await conversion(owner, fileId, owner.rootId);
    const response = await sharingRequest(owner, `/api/private/tree/files/${fileId}/capability`, "PUT", prepared.body);
    expect(response.status).toBe(200);
    const after = await (await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).json() as Record<string, unknown>;
    expect(after).toMatchObject({ capability: prepared.body.capability, revision: 1,
      representationId: prepared.before.representationId, contentKeyId: prepared.before.contentKeyId,
      ciphertext: prepared.before.ciphertext, representationKeyEnvelope: prepared.body.representationKeyEnvelope });
    expect((await treeListing(owner, owner.rootId)).entriesRevision).toBe(prepared.body.expectedParentRevision + 1);
    const contentKey = await openSymmetric(decodeTreeBytes(after.representationKeyEnvelope), prepared.key, {
      context: inspectEnvelope(decodeTreeBytes(prepared.body.representationKeyEnvelope)).context,
    });
    const content = await openSymmetric(decodeTreeBytes(after.ciphertext), contentKey, {
      context: inspectEnvelope(decodeTreeBytes(prepared.before.ciphertext)).context,
    });
    expect(new TextDecoder().decode(content)).toContain("# private");
  });

  it("saves a fresh representation without requiring or modifying the parent namespace", async () => {
    const owner = await sharingAccount(), fileId = await treeChild(owner, owner.rootId, "file");
    const converted = await conversion(owner, fileId, owner.rootId);
    expect((await sharingRequest(owner, `/api/private/tree/files/${fileId}/capability`, "PUT", converted.body)).status).toBe(200);
    const payload = await parentFreeSave(owner, owner.accountId, fileId, converted.body.capability, converted.key);
    await treeChild(owner, owner.rootId, "file"); // A structural change after preparing this save is independent.
    const parentBefore = await treeListing(owner, owner.rootId);
    const response = await sharingRequest(owner, `/api/private/tree/files/${fileId}`, "PATCH", payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: 2, representationId: payload.representation.id, capability: converted.body.capability });
    expect(await treeListing(owner, owner.rootId)).toEqual(parentBefore);
    const latest = await (await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).json() as Record<string, unknown>;
    expect(latest).toMatchObject({ revision: 2, representationId: payload.representation.id,
      contentKeyId: payload.representation.contentKeyId, keyEpoch: 2, ciphertext: payload.representation.ciphertext });
    expect(latest.keyEnvelope).toBe(converted.body.keyEnvelope);
  });

  it("a direct File writer saves with its delivered capability and receives no parent capability", async () => {
    const owner = await sharingAccount(), recipient = await sharingAccount();
    const parent = await treeChild(owner, owner.rootId, "directory"), fileId = await treeChild(owner, parent, "file");
    const { grantId } = await grant(owner, recipient, fileId, "read_write");
    const before = await (await sharingRequest(recipient, `/api/private/tree/files/${fileId}`)).json() as { capability: { id: string; epoch: number } };
    const payload = await parentFreeSave(recipient, owner.accountId, fileId, before.capability, recipient.keys.get(fileId)!);
    expect(payload).not.toHaveProperty("expectedParentRevision");
    expect((await sharingRequest(recipient, `/api/private/tree/files/${fileId}`, "PATCH", payload)).status).toBe(200);
    const after = await (await sharingRequest(recipient, `/api/private/tree/files/${fileId}`)).json() as Record<string, unknown>;
    for (const field of ["parentId", "nameCiphertext", "orderCiphertext", "keyEnvelope"]) expect(after).not.toHaveProperty(field);
    expect((await sharingRequest(recipient, `/api/private/tree/directories/${parent}`)).status).toBe(404);
    expect(recipient.keys.has(parent)).toBe(false);
    expect(after).toMatchObject({ revision: 2, capability: before.capability });
    expect((await sharingRequest(recipient, `/api/private/grants/${grantId}/keys`)).status).toBe(200);
    const key = await openSymmetric(decodeTreeBytes(after.representationKeyEnvelope), recipient.keys.get(fileId)!, {
      context: inspectEnvelope(decodeTreeBytes(payload.representation.keyEnvelope)).context,
    });
    expect(new TextDecoder().decode(await openSymmetric(decodeTreeBytes(after.ciphertext), key, {
      context: inspectEnvelope(decodeTreeBytes(payload.representation.ciphertext)).context,
    }))).toContain("# parent-free");
  });

  it("direct write wins over overlapping inherited read-only without a parent write or listing", async () => {
    const owner = await sharingAccount(), recipient = await sharingAccount();
    const parent = await treeChild(owner, owner.rootId, "directory"), fileId = await treeChild(owner, parent, "file");
    await grant(owner, recipient, parent, "read_only");
    await grant(owner, recipient, fileId, "read_write");
    const current = await (await sharingRequest(recipient, `/api/private/tree/files/${fileId}`)).json() as { capability: { id: string; epoch: number } };
    const payload = await parentFreeSave(recipient, owner.accountId, fileId, current.capability, recipient.keys.get(fileId)!);
    const listing = await treeListing(owner, parent);
    expect((await sharingRequest(recipient, `/api/private/tree/files/${fileId}`, "PATCH", payload)).status).toBe(200);
    expect(await treeListing(owner, parent)).toEqual(listing);
  });

  it("a direct capability follows Owner move without changing its root key or requiring the old parent", async () => {
    const owner = await sharingAccount(), recipient = await sharingAccount();
    const source = await treeChild(owner, owner.rootId, "directory"), destination = await treeChild(owner, owner.rootId, "directory");
    const fileId = await treeChild(owner, source, "file");
    await grant(owner, recipient, fileId, "read_write");
    const current = await (await sharingRequest(recipient, `/api/private/tree/files/${fileId}`)).json() as { capability: { id: string; epoch: number } };
    const payload = await parentFreeSave(recipient, owner.accountId, fileId, current.capability, recipient.keys.get(fileId)!);
    expect((await sharingRequest(owner, `/api/private/tree/nodes/${fileId}/parent`, "PATCH", await movePayload(owner, owner.accountId, fileId, source, destination))).status).toBe(200);
    expect((await sharingRequest(recipient, `/api/private/tree/files/${fileId}`, "PATCH", payload)).status).toBe(200);
    expect(await (await sharingRequest(recipient, `/api/private/tree/nodes/${fileId}/ancestors`)).json()).toEqual({ ancestors: [fileId] });
    expect((await sharingRequest(recipient, `/api/private/tree/directories/${destination}`)).status).toBe(404);
  });

  it("read-only recipients cannot convert or save even when they know valid capability material", async () => {
    const owner = await sharingAccount(), recipient = await sharingAccount(), fileId = await treeChild(owner, owner.rootId, "file");
    const converted = await conversion(owner, fileId, owner.rootId);
    await grant(owner, recipient, fileId, "read_only");
    const current = await (await sharingRequest(recipient, `/api/private/tree/files/${fileId}`)).json() as { capability: { id: string; epoch: number } };
    const payload = await parentFreeSave(recipient, owner.accountId, fileId, current.capability, recipient.keys.get(fileId)!);
    expect((await sharingRequest(recipient, `/api/private/tree/files/${fileId}`, "PATCH", payload)).status).toBe(404);
    expect((await sharingRequest(recipient, `/api/private/tree/files/${fileId}/capability`, "PUT", converted.body)).status).toBe(404);
    expect((await (await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).json() as { revision: number }).revision).toBe(1);
  });

  it("a stale conversion changes no File wrapper, head, pointer or content", async () => {
    const owner = await sharingAccount(), fileId = await treeChild(owner, owner.rootId, "file");
    const converted = await conversion(owner, fileId, owner.rootId);
    await treeChild(owner, owner.rootId, "file");
    expect((await sharingRequest(owner, `/api/private/tree/files/${fileId}/capability`, "PUT", converted.body)).status).toBe(409);
    const after = await (await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).json();
    expect(after).not.toHaveProperty("capability");
    expect(after).not.toHaveProperty("representationKeyEnvelope");
    expect(after).toMatchObject(converted.before);
  });

  it("rejects a forged File head without changing any representation", async () => {
    const owner = await sharingAccount(), fileId = await treeChild(owner, owner.rootId, "file");
    const converted = await conversion(owner, fileId, owner.rootId);
    expect((await sharingRequest(owner, `/api/private/tree/files/${fileId}/capability`, "PUT", converted.body)).status).toBe(200);
    const payload = await parentFreeSave(owner, owner.accountId, fileId, converted.body.capability, converted.key);
    payload.representation.fileHead.signature = encodeTreeBytes(new Uint8Array(64));
    expect((await sharingRequest(owner, `/api/private/tree/files/${fileId}`, "PATCH", payload)).status).toBe(400);
    expect((await (await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).json() as { revision: number }).revision).toBe(1);
  });

  it("pins the capability epoch independently of the File revision", async () => {
    const owner = await sharingAccount(), fileId = await treeChild(owner, owner.rootId, "file");
    const converted = await conversion(owner, fileId, owner.rootId);
    expect((await sharingRequest(owner, `/api/private/tree/files/${fileId}/capability`, "PUT", converted.body)).status).toBe(200);
    const payload = await parentFreeSave(owner, owner.accountId, fileId, converted.body.capability, converted.key);
    payload.capability = { ...payload.capability, epoch: 2 };
    const response = await sharingRequest(owner, `/api/private/tree/files/${fileId}`, "PATCH", payload);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "capability_changed" });
    expect((await (await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).json() as { revision: number }).revision).toBe(1);
  });

  it("exactly one prepared File revision wins and every later winner requires fresh keys", async () => {
    const owner = await sharingAccount(), fileId = await treeChild(owner, owner.rootId, "file");
    const converted = await conversion(owner, fileId, owner.rootId);
    expect((await sharingRequest(owner, `/api/private/tree/files/${fileId}/capability`, "PUT", converted.body)).status).toBe(200);
    const first = await parentFreeSave(owner, owner.accountId, fileId, converted.body.capability, converted.key);
    const second = await parentFreeSave(owner, owner.accountId, fileId, converted.body.capability, converted.key);
    const responses = await Promise.all([first, second].map((payload) => sharingRequest(owner, `/api/private/tree/files/${fileId}`, "PATCH", payload)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const next = await parentFreeSave(owner, owner.accountId, fileId, converted.body.capability, converted.key);
    expect(next.representation.contentKeyId).not.toBe(first.representation.contentKeyId);
    expect(next.representation.contentKeyId).not.toBe(second.representation.contentKeyId);
    expect(next.representation.keyEpoch).toBe(3);
    expect((await sharingRequest(owner, `/api/private/tree/files/${fileId}`, "PATCH", next)).status).toBe(200);
  });

  it("a prepared direct save survives Owner rename but not subsequent revocation", async () => {
    const owner = await sharingAccount(), recipient = await sharingAccount(), fileId = await treeChild(owner, owner.rootId, "file");
    const { grantId } = await grant(owner, recipient, fileId, "read_write");
    const current = await (await sharingRequest(recipient, `/api/private/tree/files/${fileId}`)).json() as { capability: { id: string; epoch: number } };
    const payload = await parentFreeSave(recipient, owner.accountId, fileId, current.capability, recipient.keys.get(fileId)!);
    expect((await sharingRequest(owner, `/api/private/tree/nodes/${fileId}/name`, "PATCH", await renamePayload(owner, owner.accountId, fileId, owner.rootId))).status).toBe(200);
    expect((await sharingRequest(recipient, `/api/private/tree/files/${fileId}`, "PATCH", payload)).status).toBe(200);
    const next = await parentFreeSave(recipient, owner.accountId, fileId, current.capability, recipient.keys.get(fileId)!);
    expect((await sharingRequest(owner, `/api/private/grants/${grantId}`, "DELETE", { expectedRevision: 1 })).status).toBe(200);
    expect((await sharingRequest(recipient, `/api/private/tree/files/${fileId}`, "PATCH", next)).status).toBe(404);
    const ownerSave = await parentFreeSave(owner, owner.accountId, fileId, current.capability, owner.keys.get(fileId)!);
    const blocked = await sharingRequest(owner, `/api/private/tree/files/${fileId}`, "PATCH", ownerSave);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: "key_rotation_required" });
  });
});
