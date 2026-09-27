import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createSymmetricWriter, openSymmetric } from "../../app/crypto/enc-v1";
import { createChildDirectoryCapability, createFileRepresentation, decodeFileRepresentation, generateDirectoryCapabilityKey } from "../../app/crypto/vault";
import { signDeviceProof, sessionBindingDigest } from "../../app/device/proof";
import { encodeBytes, decodeBytes } from "../../app/signup/protocol";
import { NameConflictError, prepareTreeCreate } from "../../app/tree/client";
import { seedNormalSession } from "./auth-fixtures";

declare global {
  namespace Cloudflare { interface Env {
    TEST_MIGRATIONS: D1Migration[];
    SESSION_COOKIE_SECRET: string;
  } }
}

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

function id(): string {
  const value = crypto.randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

async function fixture() {
  const accountId = id(), rootId = id(), deviceId = id(), credentialId = id();
  const now = Date.now();
  const assertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(accountId, id(), now, now),
    env.DB.prepare("INSERT INTO passkeys (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at) VALUES (?, ?, X'01', 0, '[]', 'singleDevice', 0, ?, ?)").bind(credentialId, accountId, now, now),
    env.DB.prepare("INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)").bind(accountId, rootId),
    env.DB.prepare("INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, X'01', ?, 'active', 'signup', 1, ?)")
      .bind(deviceId, accountId, new Uint8Array(await crypto.subtle.exportKey("raw", assertion.publicKey)), now),
  ]);
  const session = await seedNormalSession({ accountId, credentialIds: [credentialId] });
  await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(deviceId, session.id).run();
  return { accountId, rootId, deviceId, assertion, session, rootKey: generateDirectoryCapabilityKey() };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function expectAgreedEdges(f: Fixture) {
  const row = await env.DB.prepare(`SELECT count(*) AS broken FROM vault_nodes n
    LEFT JOIN directory_entries e ON e.child_node_id = n.id AND e.parent_node_id = n.parent_node_id
      AND e.owner_id = n.owner_id
    WHERE n.owner_id = ? AND n.parent_node_id IS NOT NULL AND e.child_node_id IS NULL`)
    .bind(f.accountId).first<{ broken: number }>();
  expect(row?.broken).toBe(0);
}

async function request(f: Fixture, path: string, method: "POST" | "PUT" | "PATCH", value?: object, proofId?: string) {
  const url = `https://mdwn.test${path}`;
  const body = value === undefined ? undefined : JSON.stringify(value);
  const proof = await signDeviceProof(f.assertion.privateKey, {
    sessionBinding: await sessionBindingDigest(f.session.id), deviceId: f.deviceId,
    registryEpoch: 1, method, url, body, ...(proofId ? { proofId } : {}),
  });
  return SELF.fetch(url, { method, headers: {
    cookie: f.session.cookie, origin: "https://mdwn.test", "X-Mdwn-Device-Proof": JSON.stringify(proof),
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  }, ...(body === undefined ? {} : { body }) });
}

async function directoryRequest(f: Fixture, name: string, nodeId = id(), expectedRevision = 1) {
  const child = await createChildDirectoryCapability(f.rootKey, {
    vaultId: f.accountId, parentDirectoryId: f.rootId, childDirectoryId: nodeId,
  });
  const writer = await createSymmetricWriter(f.rootKey);
  const context = { purpose: "directory-metadata" as const, vaultId: f.accountId,
    objectId: nodeId, keyId: f.rootId, keyEpoch: 1, revision: 1 };
  const nameCiphertext = await writer.seal(new TextEncoder().encode(name), context);
  const orderCiphertext = await writer.seal(new TextEncoder().encode("first"), context);
  return { nodeId, expectedRevision, kind: "directory", nameCiphertext: encodeBytes(nameCiphertext),
    orderCiphertext: encodeBytes(orderCiphertext), keyEnvelope: encodeBytes(child.envelope) };
}

async function fileRequest(f: Fixture, name: string, nodeId = id(), expectedRevision = 1) {
  const writer = await createSymmetricWriter(f.rootKey);
  const context = { purpose: "directory-metadata" as const, vaultId: f.accountId,
    objectId: nodeId, keyId: f.rootId, keyEpoch: 1, revision: 1 };
  const nameCiphertext = await writer.seal(new TextEncoder().encode(name), context);
  const orderCiphertext = await writer.seal(new TextEncoder().encode("first"), context);
  const file = await createFileRepresentation(f.rootKey, { markdown: "# private", metadata: new Uint8Array() },
    { vaultId: f.accountId, fileId: nodeId });
  return { body: { nodeId, kind: "file", expectedRevision,
    nameCiphertext: encodeBytes(nameCiphertext), orderCiphertext: encodeBytes(orderCiphertext),
    keyEnvelope: encodeBytes(file.fileContentKeyEnvelope),
    representation: { id: id(), contentKeyId: nodeId, keyEpoch: 1, revision: 1,
      ciphertext: encodeBytes(file.contentEnvelope) } }, file };
}

describe("private tree", () => {
  it("creates an encrypted child under the hidden root and lists it with a device proof", async () => {
    const f = await fixture();
    const created = await directoryRequest(f, "Amélie");
    const response = await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created);
    expect(response.status, await response.clone().text()).toBe(201);
    await expectAgreedEdges(f);
    const listing = await request(f, `/api/private/tree/directories/${f.rootId}`, "POST");
    expect(listing.status).toBe(200);
    const result = await listing.json() as { entriesRevision: number; entries: Array<{ nodeId: string; nameCiphertext: string }> };
    expect(result.entriesRevision).toBe(2);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.nodeId).toBe(created.nodeId);
    expect(new TextDecoder().decode(await openSymmetric(decodeBytes(result.entries[0]!.nameCiphertext), f.rootKey,
      { context: { purpose: "directory-metadata", vaultId: f.accountId, objectId: created.nodeId,
        keyId: f.rootId, keyEpoch: 1, revision: 1 } }))).toBe("Amélie");
    const agreement = await env.DB.prepare(`SELECT n.parent_node_id AS parent, e.parent_node_id AS edge_parent
      FROM vault_nodes n JOIN directory_entries e ON e.child_node_id = n.id WHERE n.id = ?`)
      .bind(created.nodeId).first<{ parent: string; edge_parent: string }>();
    expect(agreement).toEqual({ parent: f.rootId, edge_parent: f.rootId });
  });

  it("runs Unicode 17 namespace collision fixtures before the real create path", async () => {
    const f = await fixture();
    const path = `/api/private/tree/directories/${f.rootId}/children`;
    const first = await prepareTreeCreate({ vaultId: f.accountId, parentId: f.rootId, parentKey: f.rootKey,
      entriesRevision: 1, existingNames: [], requestedName: "Amélie", kind: "directory" });
    expect(JSON.stringify(first)).not.toContain("Amélie");
    expect(JSON.stringify(first)).not.toContain("616dc3a96c6965");
    expect((await request(f, path, "PUT", first)).status).toBe(201);
    await expectAgreedEdges(f);
    for (const duplicate of ["Ame\u0301lie", "AMÉLIE"]) {
      await expect(prepareTreeCreate({ vaultId: f.accountId, parentId: f.rootId, parentKey: f.rootKey,
        entriesRevision: 2, existingNames: ["Amélie"], requestedName: duplicate, kind: "file" }))
        .rejects.toBeInstanceOf(NameConflictError);
    }
    const second = await prepareTreeCreate({ vaultId: f.accountId, parentId: f.rootId, parentKey: f.rootKey,
      entriesRevision: 2, existingNames: ["Amélie"], requestedName: "Straße", kind: "directory" });
    expect((await request(f, path, "PUT", second)).status).toBe(201);
    await expectAgreedEdges(f);
    await expect(prepareTreeCreate({ vaultId: f.accountId, parentId: f.rootId, parentKey: f.rootKey,
      entriesRevision: 3, existingNames: ["Amélie", "Straße"], requestedName: "STRASSE", kind: "directory" }))
      .rejects.toBeInstanceOf(NameConflictError);
    const third = await prepareTreeCreate({ vaultId: f.accountId, parentId: f.rootId, parentKey: f.rootKey,
      entriesRevision: 3, existingNames: ["Amélie", "Straße"], requestedName: "Ａ", kind: "directory" });
    expect((await request(f, path, "PUT", third)).status).toBe(201);
    await expectAgreedEdges(f);
    const fourth = await prepareTreeCreate({ vaultId: f.accountId, parentId: f.rootId, parentKey: f.rootKey,
      entriesRevision: 4, existingNames: ["Amélie", "Straße", "Ａ"], requestedName: "A", kind: "file" });
    expect((await request(f, path, "PUT", fourth)).status).toBe(201);
    await expectAgreedEdges(f);
    let revision = 5;
    const names = ["Amélie", "Straße", "Ａ", "A"];
    for (const name of ["Σ", "I", "İ"]) {
      const payload = await prepareTreeCreate({ vaultId: f.accountId, parentId: f.rootId, parentKey: f.rootKey,
        entriesRevision: revision, existingNames: names, requestedName: name, kind: "directory" });
      expect((await request(f, path, "PUT", payload)).status).toBe(201);
      await expectAgreedEdges(f);
      names.push(name);
      revision++;
    }
    for (const duplicate of ["ς", "σ", "i"]) {
      await expect(prepareTreeCreate({ vaultId: f.accountId, parentId: f.rootId, parentKey: f.rootKey,
        entriesRevision: revision, existingNames: names, requestedName: duplicate, kind: "directory" }))
        .rejects.toBeInstanceOf(NameConflictError);
    }
    const listingResponse = await request(f, `/api/private/tree/directories/${f.rootId}`, "POST");
    expect(await listingResponse.clone().text()).not.toContain("Amélie");
    const listing = await listingResponse.json() as {
      entriesRevision: number; entries: unknown[];
    };
    expect(listing.entriesRevision).toBe(8);
    expect(listing.entries).toHaveLength(7);
  });

  it("stores exactly one current File representation and returns only encrypted private material", async () => {
    const f = await fixture();
    const created = await fileRequest(f, "secret.md");
    const response = await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created.body);
    expect(response.status, await response.clone().text()).toBe(201);
    await expectAgreedEdges(f);
    const read = await request(f, `/api/private/tree/files/${created.body.nodeId}`, "POST");
    expect(read.status).toBe(200);
    const data = await read.json() as { revision: number; ciphertext: string; representationId: string };
    expect(data.revision).toBe(1);
    expect(data.representationId).toBe(created.body.representation.id);
    expect(decodeFileRepresentation(await openSymmetric(decodeBytes(data.ciphertext), created.file.fileContentKey,
      { context: created.file.contentContext })).markdown).toBe("# private");
    const count = await env.DB.prepare(`SELECT count(*) AS count FROM file_representations WHERE file_node_id = ?`)
      .bind(created.body.nodeId).first<{ count: number }>();
    expect(count?.count).toBe(1);
    expect(await request(f, `/api/private/tree/files/${id()}`, "POST").then((r) => r.status)).toBe(404);
  });

  it("renames only after its parent's revision wins, without changing the node edge or File content", async () => {
    const f = await fixture();
    const created = await directoryRequest(f, "before");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created)).status).toBe(201);
    const writer = await createSymmetricWriter(f.rootKey);
    const context = { purpose: "directory-metadata" as const, vaultId: f.accountId,
      objectId: created.nodeId, keyId: f.rootId, keyEpoch: 1, revision: 1 };
    const rename = { expectedRevision: 2,
      nameCiphertext: encodeBytes(await writer.seal(new TextEncoder().encode("after"), context)),
      orderCiphertext: encodeBytes(await writer.seal(new TextEncoder().encode("first"), context)) };
    const path = `/api/private/tree/nodes/${created.nodeId}/name`;
    expect((await request(f, path, "PATCH", rename)).status).toBe(200);
    await expectAgreedEdges(f);
    const stale = await request(f, path, "PATCH", rename);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "namespace_changed" });
    const listing = await (await request(f, `/api/private/tree/directories/${f.rootId}`, "POST")).json() as {
      entriesRevision: number; entries: Array<{ nameCiphertext: string }>;
    };
    expect(listing.entriesRevision).toBe(3);
    expect(new TextDecoder().decode(await openSymmetric(decodeBytes(listing.entries[0]!.nameCiphertext),
      f.rootKey, { context }))).toBe("after");
  });

  it("resolves opaque ancestor IDs for an owned File without disclosing another Account's path", async () => {
    const f = await fixture();
    const folder = await directoryRequest(f, "Folder");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", folder)).status).toBe(201);
    await expectAgreedEdges(f);
    const childKey = await openSymmetric(decodeBytes(folder.keyEnvelope), f.rootKey, { context: {
      purpose: "directory-capability", vaultId: f.accountId, objectId: folder.nodeId,
      keyId: folder.nodeId, keyEpoch: 1, revision: 1,
    } });
    const nested = await prepareTreeCreate({ vaultId: f.accountId, parentId: folder.nodeId, parentKey: childKey,
      entriesRevision: 1, existingNames: [], requestedName: "nested.md", kind: "file" });
    expect((await request(f, `/api/private/tree/directories/${folder.nodeId}/children`, "PUT", nested)).status).toBe(201);
    await expectAgreedEdges(f);
    const route = `/api/private/tree/nodes/${nested.nodeId}/ancestors`;
    const own = await request(f, route, "POST");
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ ancestors: [f.rootId, folder.nodeId, nested.nodeId] });
    const other = await fixture();
    const forbidden = await request(other, route, "POST");
    const missing = await request(other, `/api/private/tree/nodes/${id()}/ancestors`, "POST");
    expect(forbidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await forbidden.text()).toBe(await missing.text());
  });

  it("enforces parent/edge agreement, root identity, immutable ancestry and current File pointer in D1", async () => {
    const f = await fixture();
    expect(await env.DB.prepare("SELECT node_id, entries_revision FROM directories WHERE node_id = ?")
      .bind(f.rootId).first()).toEqual({ node_id: f.rootId, entries_revision: 1 });
    await expect(env.DB.prepare("INSERT INTO vault_nodes (id, kind, owner_id, created_at, updated_at) VALUES (?, 'directory', ?, 1, 1)")
      .bind(id(), f.accountId).run()).rejects.toThrow();
    await expect(env.DB.prepare("DELETE FROM directories WHERE node_id = ?")
      .bind(f.rootId).run()).rejects.toThrow();
    const folder = await directoryRequest(f, "Folder");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", folder)).status).toBe(201);
    await expect(env.DB.prepare("UPDATE vault_nodes SET parent_node_id = ? WHERE id = ?")
      .bind(folder.nodeId, f.rootId).run()).rejects.toThrow();
    const created = await fileRequest(f, "file.md", id(), 2);
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created.body)).status).toBe(201);
    expect(await env.DB.prepare(`SELECT f.current_revision AS revision, r.id AS representation_id
      FROM files f JOIN file_representations r ON r.id = f.current_representation_id
      AND r.revision = f.current_revision AND r.file_node_id = f.node_id
      WHERE f.node_id = ?`).bind(created.body.nodeId).first()).toEqual({
      revision: 1, representation_id: created.body.representation.id,
    });
  });

  it("requires a live bound device proof for every tree read or mutation and rejects replay", async () => {
    const f = await fixture();
    const path = `/api/private/tree/directories/${f.rootId}`;
    const missing = await SELF.fetch(`https://mdwn.test${path}`, { method: "POST", headers: {
      cookie: f.session.cookie, origin: "https://mdwn.test",
    } });
    expect(missing.status).toBe(403);
    const created = await directoryRequest(f, "private");
    const createPath = `${path}/children`;
    const body = JSON.stringify(created);
    const proof = await signDeviceProof(f.assertion.privateKey, { sessionBinding: await sessionBindingDigest(f.session.id),
      deviceId: f.deviceId, registryEpoch: 1, method: "PUT", url: `https://mdwn.test${createPath}`, body });
    const send = () => SELF.fetch(`https://mdwn.test${createPath}`, { method: "PUT", body,
      headers: { cookie: f.session.cookie, origin: "https://mdwn.test", "content-type": "application/json",
        "X-Mdwn-Device-Proof": JSON.stringify(proof) } });
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(409);
    const unprovisioned = await fixture();
    await env.DB.prepare("UPDATE sessions SET device_id = NULL WHERE id = ?").bind(unprovisioned.session.id).run();
    expect((await request(unprovisioned, `/api/private/tree/directories/${unprovisioned.rootId}`, "POST")).status).toBe(403);
    expect((await request(unprovisioned, `/api/private/tree/directories/${unprovisioned.rootId}/children`, "PUT",
      await directoryRequest(unprovisioned, "denied"))).status).toBe(403);
  });

  it("lets exactly one of two same-revision clients commit; the loser is nameless and leaves no partial node", async () => {
    const f = await fixture();
    const first = await directoryRequest(f, "one");
    const second = await directoryRequest(f, "two");
    const path = `/api/private/tree/directories/${f.rootId}/children`;
    const responses = await Promise.all([request(f, path, "PUT", first), request(f, path, "PUT", second)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    await expectAgreedEdges(f);
    expect(await responses.find((response) => response.status === 409)!.json()).toEqual({ error: "namespace_changed" });
    const listing = await (await request(f, `/api/private/tree/directories/${f.rootId}`, "POST")).json() as {
      entriesRevision: number; entries: Array<{ nodeId: string }>;
    };
    expect(listing.entriesRevision).toBe(2);
    expect(listing.entries).toHaveLength(1);
    const count = await env.DB.prepare(`SELECT count(*) AS nodes FROM vault_nodes WHERE owner_id = ?`)
      .bind(f.accountId).first<{ nodes: number }>();
    expect(count?.nodes).toBe(2);
  });
});
