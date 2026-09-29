import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createSymmetricWriter, openSymmetric } from "../../app/crypto/enc-v1";
import { createChildDirectoryCapability, createFileRepresentation, decodeFileRepresentation, generateDirectoryCapabilityKey } from "../../app/crypto/vault";
import { signDeviceProof, sessionBindingDigest } from "../../app/device/proof";
import { NamespaceError, canonicalizeSegment } from "../../app/namespace-v1";
import { encodeBytes, decodeBytes } from "../../app/signup/protocol";
import { createTreeChild, NameConflictError, prepareTreeCreate, prepareTreeRename, renameTreeChild } from "../../app/tree/client";
import { RecoveryConfirmationPendingError } from "../../app/signup/recovery-gate";
import { createListingHead, openListingHead, type SealedEntry, type StoredListingHead } from "../../app/tree/listing";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/tree/wire";
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
  const rootKey = generateDirectoryCapabilityKey();
  return { accountId, rootId, deviceId, assertion, session, rootKey,
    keys: new Map<string, Uint8Array>([[rootId, rootKey]]) };
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

async function signedRequest(f: Fixture, path: string, method: "PUT" | "PATCH", value: object): Promise<object> {
  const create = /^\/api\/private\/tree\/directories\/([0-9a-f-]+)\/children$/.exec(path);
  const rename = /^\/api\/private\/tree\/nodes\/([0-9a-f-]+)\/name$/.exec(path);
  if (!create && !rename) return value;
  const parentId = create?.[1] ?? (await env.DB.prepare("SELECT parent_node_id FROM vault_nodes WHERE id = ?")
    .bind(rename![1]).first<{ parent_node_id: string }>())?.parent_node_id;
  if (!parentId || !f.keys.has(parentId)) return value;
  const listingResponse = await request(f, `/api/private/tree/directories/${parentId}`, "POST");
  if (!listingResponse.ok) return value;
  const listing = await listingResponse.json() as { entries: SealedEntry[] };
  const input = value as { nodeId?: string; nameCiphertext: string; orderCiphertext: string;
    keyEnvelope?: string; kind?: "directory" | "file"; expectedRevision: number };
  const entries = create ? [...listing.entries, {
    nodeId: input.nodeId!, kind: input.kind!, nameCiphertext: input.nameCiphertext,
    orderCiphertext: input.orderCiphertext, keyEnvelope: input.keyEnvelope!,
  }] : listing.entries.map((entry) => entry.nodeId === rename![1]
    ? { ...entry, nameCiphertext: input.nameCiphertext, orderCiphertext: input.orderCiphertext } : entry);
  return { ...value, listingHead: await createListingHead(f.keys.get(parentId)!, f.assertion.privateKey, { epoch: 1,
    vaultId: f.accountId, directoryId: parentId, deviceId: f.deviceId,
    revision: input.expectedRevision + 1, entries,
  }) };
}

async function request(f: Fixture, path: string, method: "POST" | "PUT" | "PATCH", value?: object, proofId?: string) {
  const url = `https://mdwn.test${path}`;
  const signed = value && method !== "POST" ? await signedRequest(f, path, method, value) : value;
  const body = signed === undefined ? undefined : JSON.stringify(signed);
  const proof = await signDeviceProof(f.assertion.privateKey, {
    sessionBinding: await sessionBindingDigest(f.session.id), deviceId: f.deviceId,
    registryEpoch: 1, method, url, body, ...(proofId ? { proofId } : {}),
  });
  const response = await SELF.fetch(url, { method, headers: {
    cookie: f.session.cookie, origin: "https://mdwn.test", "X-Mdwn-Device-Proof": JSON.stringify(proof),
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  }, ...(body === undefined ? {} : { body }) });
  if (response.status === 201 && method === "PUT" && signed && "kind" in signed && signed.kind === "directory" &&
      "nodeId" in signed && typeof signed.nodeId === "string" &&
      "keyEnvelope" in signed && typeof signed.keyEnvelope === "string") {
    const created = { nodeId: signed.nodeId, keyEnvelope: signed.keyEnvelope };
    const parentId = /^\/api\/private\/tree\/directories\/([0-9a-f-]+)\/children$/.exec(path)?.[1];
    const parentKey = parentId && f.keys.get(parentId);
    if (parentKey) f.keys.set(created.nodeId, await openSymmetric(decodeBytes(created.keyEnvelope), parentKey,
      { context: { purpose: "directory-capability", vaultId: f.accountId, objectId: created.nodeId,
        keyId: created.nodeId, keyEpoch: 1, revision: 1 } }));
  }
  return response;
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
  it("keeps the signup recovery-confirmation gate ahead of any content-creating request", async () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => "pending" } });
    try {
      await expect(createTreeChild({ vaultId: id(), rootId: id(), rootKey: generateDirectoryCapabilityKey() },
        id(), { nodeId: id(), kind: "file", expectedRevision: 1, nameCiphertext: "", orderCiphertext: "",
          keyEnvelope: "" }, { directoryId: id(), entriesRevision: 1, capabilityEpoch: 1, entries: [] },
        generateDirectoryCapabilityKey())).rejects.toBeInstanceOf(RecoveryConfirmationPendingError);
      await expect(renameTreeChild({ vaultId: id(), rootId: id(), rootKey: generateDirectoryCapabilityKey() },
        id(), id(), { expectedRevision: 1, nameCiphertext: "", orderCiphertext: "" },
        { directoryId: id(), entriesRevision: 1, capabilityEpoch: 1, entries: [] }, generateDirectoryCapabilityKey()))
        .rejects.toBeInstanceOf(RecoveryConfirmationPendingError);
    } finally { vi.unstubAllGlobals(); }
  });

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
    expect(result).toHaveProperty("listingHead.signerDeviceId", f.deviceId);
    expect(new TextDecoder().decode(await openSymmetric(decodeBytes(result.entries[0]!.nameCiphertext), f.rootKey,
      { context: { purpose: "directory-metadata", vaultId: f.accountId, objectId: created.nodeId,
        keyId: f.rootId, keyEpoch: 1, revision: 1 } }))).toBe("Amélie");
    const agreement = await env.DB.prepare(`SELECT n.parent_node_id AS parent, e.parent_node_id AS edge_parent
      FROM vault_nodes n JOIN directory_entries e ON e.child_node_id = n.id WHERE n.id = ?`)
      .bind(created.nodeId).first<{ parent: string; edge_parent: string }>();
    expect(agreement).toEqual({ parent: f.rootId, edge_parent: f.rootId });
  });

  it("refuses altered entries against the authenticated listing head", async () => {
    const f = await fixture();
    const created = await directoryRequest(f, "Private heading");
    const route = `/api/private/tree/directories/${f.rootId}`;
    expect((await request(f, `${route}/children`, "PUT", created)).status).toBe(201);
    const result = await (await request(f, route, "POST")).json() as {
      entriesRevision: number; entries: SealedEntry[];
      listingHead: Omit<StoredListingHead, "signerPublicKey"> & { signerPublicKey: string };
    };
    const options = { vaultId: f.accountId, directoryId: f.rootId, epoch: 1, revision: result.entriesRevision,
      entries: result.entries, head: { ...result.listingHead,
        signerPublicKey: decodeBytes(result.listingHead.signerPublicKey) } };
    await expect(openListingHead(f.rootKey, options)).resolves.toBeUndefined();
    await env.DB.prepare("UPDATE directory_entries SET name_ciphertext = X'01' WHERE child_node_id = ?")
      .bind(created.nodeId).run();
    const forged = await (await request(f, route, "POST")).json() as { entries: SealedEntry[] };
    await expect(openListingHead(f.rootKey, { ...options, entries: forged.entries }))
      .rejects.toMatchObject({ code: "replayed-manifest" });
    await expect(env.DB.prepare("UPDATE directories SET listing_digest = zeroblob(32) WHERE node_id = ?")
      .bind(f.rootId).run()).rejects.toThrow();
  });

  it("runs Unicode 17 namespace collision fixtures before the real create path", async () => {
    const f = await fixture();
    const path = `/api/private/tree/directories/${f.rootId}/children`;
    const first = await prepareTreeCreate({ parentEpoch: 1, vaultId: f.accountId, parentId: f.rootId, parentKey: f.rootKey,
      entriesRevision: 1, existingNames: [], requestedName: "Amélie", kind: "directory" });
    expect(JSON.stringify(first)).not.toContain("Amélie");
    expect(JSON.stringify(first)).not.toContain("616dc3a96c6965");
    expect((await request(f, path, "PUT", first)).status).toBe(201);
    await expectAgreedEdges(f);
    for (const duplicate of ["Ame\u0301lie", "AMÉLIE"]) {
      await expect(prepareTreeCreate({ parentEpoch: 1, vaultId: f.accountId, parentId: f.rootId, parentKey: f.rootKey,
        entriesRevision: 2, existingNames: ["Amélie"], requestedName: duplicate, kind: "file" }))
        .rejects.toBeInstanceOf(NameConflictError);
    }
    const second = await prepareTreeCreate({ parentEpoch: 1, vaultId: f.accountId, parentId: f.rootId, parentKey: f.rootKey,
      entriesRevision: 2, existingNames: ["Amélie"], requestedName: "Straße", kind: "directory" });
    expect((await request(f, path, "PUT", second)).status).toBe(201);
    await expectAgreedEdges(f);
    await expect(prepareTreeCreate({ parentEpoch: 1, vaultId: f.accountId, parentId: f.rootId, parentKey: f.rootKey,
      entriesRevision: 3, existingNames: ["Amélie", "Straße"], requestedName: "STRASSE", kind: "directory" }))
      .rejects.toBeInstanceOf(NameConflictError);
    const third = await prepareTreeCreate({ parentEpoch: 1, vaultId: f.accountId, parentId: f.rootId, parentKey: f.rootKey,
      entriesRevision: 3, existingNames: ["Amélie", "Straße"], requestedName: "Ａ", kind: "directory" });
    expect((await request(f, path, "PUT", third)).status).toBe(201);
    await expectAgreedEdges(f);
    const fourth = await prepareTreeCreate({ parentEpoch: 1, vaultId: f.accountId, parentId: f.rootId, parentKey: f.rootKey,
      entriesRevision: 4, existingNames: ["Amélie", "Straße", "Ａ"], requestedName: "A", kind: "file" });
    expect((await request(f, path, "PUT", fourth)).status).toBe(201);
    await expectAgreedEdges(f);
    let revision = 5;
    const names = ["Amélie", "Straße", "Ａ", "A"];
    for (const name of ["Σ", "I", "İ"]) {
      const payload = await prepareTreeCreate({ parentEpoch: 1, vaultId: f.accountId, parentId: f.rootId, parentKey: f.rootKey,
        entriesRevision: revision, existingNames: names, requestedName: name, kind: "directory" });
      expect((await request(f, path, "PUT", payload)).status).toBe(201);
      await expectAgreedEdges(f);
      names.push(name);
      revision++;
    }
    for (const duplicate of ["ς", "σ", "i"]) {
      await expect(prepareTreeCreate({ parentEpoch: 1, vaultId: f.accountId, parentId: f.rootId, parentKey: f.rootKey,
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

  it("runs namespace-v1 segment boundary vectors through real browser preparation and create", async () => {
    const f = await fixture();
    let revision = 1;
    const names: string[] = [];
    const path = `/api/private/tree/directories/${f.rootId}/children`;
    for (const requestedName of ["two words", "e\u0301", "🙂", "emoji\uFE0F", "क\u200Dष", "\u0378",
      "é".repeat(127) + "a", "e\u0301".repeat(127) + "b"]) {
      const payload = await prepareTreeCreate({ parentEpoch: 1, vaultId: f.accountId, parentId: f.rootId, parentKey: f.rootKey,
        entriesRevision: revision, existingNames: names, requestedName, kind: "directory" });
      expect(JSON.stringify(payload)).not.toContain(requestedName);
      expect((await request(f, path, "PUT", payload)).status).toBe(201);
      names.push(canonicalizeSegment(requestedName).display);
      revision++;
      await expectAgreedEdges(f);
    }
    for (const requestedName of ["", ".", "..", "a\u0000b", "a/b", "a\\b", "trailing ", "trailing.",
      "CON", "con.txt", "a\u202Eb", "\uD800", "\uDC00", "a".repeat(256), "é".repeat(128)]) {
      await expect(prepareTreeCreate({ parentEpoch: 1, vaultId: f.accountId, parentId: f.rootId, parentKey: f.rootKey,
        entriesRevision: revision, existingNames: names, requestedName, kind: "file" }))
        .rejects.toBeInstanceOf(NamespaceError);
    }
    expect((await (await request(f, `/api/private/tree/directories/${f.rootId}`, "POST")).json() as {
      entries: unknown[];
    }).entries).toHaveLength(names.length);
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
    await expect(env.DB.prepare("UPDATE file_representations SET ciphertext = X'01' WHERE id = ?")
      .bind(created.body.representation.id).run()).rejects.toThrow();
    expect(await request(f, `/api/private/tree/files/${id()}`, "POST").then((r) => r.status)).toBe(404);
  });

  it("atomically saves a fresh File key and signed parent listing, and rejects stale or malformed saves", async () => {
    const f = await fixture();
    const created = await fileRequest(f, "notes.md");
    const fileId = created.body.nodeId;
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created.body)).status).toBe(201);
    const path = `/api/private/tree/files/${fileId}`;
    const before = await (await request(f, path, "POST")).json() as { revision: number; representationId: string; keyEnvelope: string };
    const listing = await (await request(f, `/api/private/tree/directories/${f.rootId}`, "POST")).json() as {
      entriesRevision: number; entries: SealedEntry[];
    };
    const freshKeyId = id(), freshId = id();
    const fresh = await createFileRepresentation(f.rootKey,
      { markdown: "# saved secret", metadata: new Uint8Array() },
      { vaultId: f.accountId, fileId, keyId: freshKeyId, revision: 2 });
    const keyEnvelope = encodeBytes(fresh.fileContentKeyEnvelope);
    const head = await createListingHead(f.rootKey, f.assertion.privateKey, { epoch: 1,
      vaultId: f.accountId, directoryId: f.rootId, deviceId: f.deviceId,
      revision: listing.entriesRevision + 1,
      entries: listing.entries.map((entry) => entry.nodeId === fileId ? { ...entry, keyEnvelope } : entry),
    });
    const value = { expectedRevision: 1, expectedEntriesRevision: listing.entriesRevision,
      keyEnvelope, listingHead: head, representation: {
        id: freshId, contentKeyId: freshKeyId, keyEpoch: 1, revision: 2,
        ciphertext: encodeBytes(fresh.contentEnvelope),
      } };
    const saved = await request(f, path, "PATCH", value);
    expect(saved.status, await saved.clone().text()).toBe(200);
    const current = await (await request(f, path, "POST")).json() as {
      revision: number; representationId: string; ciphertext: string; keyEnvelope: string;
    };
    expect(current.revision).toBe(2);
    expect(current.representationId).toBe(freshId);
    expect(decodeFileRepresentation(await openSymmetric(decodeBytes(current.ciphertext), fresh.fileContentKey,
      { context: fresh.contentContext })).markdown).toBe("# saved secret");
    const afterListing = await (await request(f, `/api/private/tree/directories/${f.rootId}`, "POST")).json() as {
      entriesRevision: number; entries: SealedEntry[]; listingHead: StoredListingHead & { signerPublicKey: string };
    };
    await expect(openListingHead(f.rootKey, { epoch: 1, vaultId: f.accountId, directoryId: f.rootId,
      revision: afterListing.entriesRevision, entries: afterListing.entries,
      head: { ...afterListing.listingHead, signerPublicKey: decodeBytes(afterListing.listingHead.signerPublicKey) },
    })).resolves.toBeUndefined();
    expect(afterListing.entries.find((entry) => entry.nodeId === fileId)?.keyEnvelope).toBe(keyEnvelope);
    const stale = await request(f, path, "PATCH", value);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "file_changed" });
    const malformed = await request(f, path, "PATCH", { ...value, expectedRevision: 2,
      expectedEntriesRevision: afterListing.entriesRevision, representation: { ...value.representation,
        id: id(), revision: 3, ciphertext: "bad" } });
    expect(malformed.status).toBe(400);
    expect((await (await request(f, path, "POST")).json() as { representationId: string }).representationId).toBe(freshId);
    expect((await env.DB.prepare("SELECT count(*) AS count FROM file_representations WHERE file_node_id = ?")
      .bind(fileId).first<{ count: number }>())?.count).toBe(1);
    expect(before.representationId).not.toBe(freshId);

    // Explicitly confirming an overwrite must first fetch the latest revision
    // and independently encrypt under yet another File key.
    const overwriteKeyId = id();
    const replacement = await createFileRepresentation(f.rootKey,
      { markdown: "# explicitly overwritten", metadata: new Uint8Array() },
      { vaultId: f.accountId, fileId, keyId: overwriteKeyId, revision: 3 });
    const replacementEnvelope = encodeBytes(replacement.fileContentKeyEnvelope);
    const replacementHead = await createListingHead(f.rootKey, f.assertion.privateKey, { epoch: 1,
      vaultId: f.accountId, directoryId: f.rootId, deviceId: f.deviceId,
      revision: afterListing.entriesRevision + 1,
      entries: afterListing.entries.map((entry) => entry.nodeId === fileId
        ? { ...entry, keyEnvelope: replacementEnvelope } : entry),
    });
    const overwritten = await request(f, path, "PATCH", { expectedRevision: 2,
      expectedEntriesRevision: afterListing.entriesRevision, keyEnvelope: replacementEnvelope,
      listingHead: replacementHead, representation: { id: id(), contentKeyId: overwriteKeyId,
        keyEpoch: 1, revision: 3, ciphertext: encodeBytes(replacement.contentEnvelope) } });
    expect(overwritten.status, await overwritten.clone().text()).toBe(200);
    const replaced = await (await request(f, path, "POST")).json() as { ciphertext: string; revision: number };
    expect(replaced.revision).toBe(3);
    expect(decodeFileRepresentation(await openSymmetric(decodeBytes(replaced.ciphertext), replacement.fileContentKey,
      { context: replacement.contentContext })).markdown).toBe("# explicitly overwritten");
  });

  it("refuses a legacy save that would leave an active direct File Grant without an envelope", async () => {
    const f = await fixture(), recipient = await fixture();
    const created = await fileRequest(f, "shared.md");
    const fileId = created.body.nodeId;
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created.body)).status).toBe(201);
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO grants (id, owner_id, recipient_id, target_node_id, target_kind, permission,
      generation, created_at, updated_at) VALUES (?, ?, ?, ?, 'file', 'read_only', 1, ?, ?)`)
      .bind(id(), f.accountId, recipient.accountId, fileId, now, now).run();
    const listing = await (await request(f, `/api/private/tree/directories/${f.rootId}`, "POST")).json() as {
      entriesRevision: number; entries: SealedEntry[] };
    const keyId = id();
    const fresh = await createFileRepresentation(f.rootKey, { markdown: "# must migrate", metadata: new Uint8Array() },
      { vaultId: f.accountId, fileId, keyId, revision: 2 });
    const keyEnvelope = encodeBytes(fresh.fileContentKeyEnvelope);
    const response = await request(f, `/api/private/tree/files/${fileId}`, "PATCH", { expectedRevision: 1,
      expectedEntriesRevision: listing.entriesRevision, keyEnvelope,
      listingHead: await createListingHead(f.rootKey, f.assertion.privateKey, { epoch: 1, vaultId: f.accountId,
        directoryId: f.rootId, deviceId: f.deviceId, revision: listing.entriesRevision + 1,
        entries: listing.entries.map((entry) => entry.nodeId === fileId ? { ...entry, keyEnvelope } : entry) }),
      representation: { id: id(), contentKeyId: keyId, keyEpoch: 1, revision: 2,
        ciphertext: encodeBytes(fresh.contentEnvelope) } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "migration_required" });
    expect(await env.DB.prepare("SELECT current_revision FROM files WHERE node_id = ?").bind(fileId)
      .first()).toEqual({ current_revision: 1 });
    expect(await env.DB.prepare("SELECT entries_revision FROM directories WHERE node_id = ?").bind(f.rootId)
      .first()).toEqual({ entries_revision: listing.entriesRevision });
  });

  it("rejects an oversized encrypted File save without advancing either current pointer or signed listing", async () => {
    const f = await fixture();
    const created = await fileRequest(f, "bounded.md");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created.body)).status).toBe(201);
    const listing = await (await request(f, `/api/private/tree/directories/${f.rootId}`, "POST")).json() as {
      entriesRevision: number; entries: SealedEntry[];
    };
    const contentKeyId = id();
    const fresh = await createFileRepresentation(f.rootKey, new Uint8Array(32), {
      vaultId: f.accountId, fileId: created.body.nodeId, keyId: contentKeyId, revision: 2,
    });
    const keyEnvelope = encodeBytes(fresh.fileContentKeyEnvelope);
    const listingHead = await createListingHead(f.rootKey, f.assertion.privateKey, { epoch: 1,
      vaultId: f.accountId, directoryId: f.rootId, deviceId: f.deviceId,
      revision: 3, entries: listing.entries.map((entry) => ({ ...entry, keyEnvelope })),
    });
    // No browser producer can encode this through encodeTreeBytes; adversarial
    // request bytes still reach the Worker size validator independently.
    const oversizedBytes = new Uint8Array(524_289);
    oversizedBytes.set(fresh.contentEnvelope);
    const binary = Array.from({ length: Math.ceil(oversizedBytes.length / 8192) }, (_, index) =>
      String.fromCharCode(...oversizedBytes.subarray(index * 8192, (index + 1) * 8192))).join("");
    const ciphertext = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const response = await request(f, `/api/private/tree/files/${created.body.nodeId}`, "PATCH", {
      expectedRevision: 1, expectedEntriesRevision: 2, keyEnvelope, listingHead,
      representation: { id: id(), contentKeyId, keyEpoch: 1, revision: 2, ciphertext },
    });
    expect(response.status).toBe(400);
    expect((await (await request(f, `/api/private/tree/files/${created.body.nodeId}`, "POST")).json() as {
      revision: number;
    }).revision).toBe(1);
    const unchanged = await (await request(f, `/api/private/tree/directories/${f.rootId}`, "POST")).json() as {
      entriesRevision: number; entries: SealedEntry[];
    };
    expect(unchanged.entriesRevision).toBe(2);
    expect(unchanged.entries[0]?.keyEnvelope).toBe(created.body.keyEnvelope);
    expect((await env.DB.prepare("SELECT count(*) AS count FROM file_representations WHERE file_node_id = ?")
      .bind(created.body.nodeId).first<{ count: number }>())?.count).toBe(1);
  });

  it("rolls back a failed insertion after the parent CAS, leaving both signed listing and File unchanged", async () => {
    const f = await fixture();
    const first = await fileRequest(f, "one.md");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", first.body)).status).toBe(201);
    const second = await fileRequest(f, "two.md", id(), 2);
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", second.body)).status).toBe(201);
    const listing = await (await request(f, `/api/private/tree/directories/${f.rootId}`, "POST")).json() as {
      entriesRevision: number; entries: SealedEntry[];
    };
    const freshKeyId = id();
    const fresh = await createFileRepresentation(f.rootKey,
      { markdown: "# should not commit", metadata: new Uint8Array() },
      { vaultId: f.accountId, fileId: first.body.nodeId, keyId: freshKeyId, revision: 2 });
    const keyEnvelope = encodeBytes(fresh.fileContentKeyEnvelope);
    const head = await createListingHead(f.rootKey, f.assertion.privateKey, { epoch: 1,
      vaultId: f.accountId, directoryId: f.rootId, deviceId: f.deviceId,
      revision: 4, entries: listing.entries.map((entry) => entry.nodeId === first.body.nodeId
        ? { ...entry, keyEnvelope } : entry),
    });
    const response = await request(f, `/api/private/tree/files/${first.body.nodeId}`, "PATCH", {
      expectedRevision: 1, expectedEntriesRevision: listing.entriesRevision, keyEnvelope,
      listingHead: head, representation: { id: second.body.representation.id,
        contentKeyId: freshKeyId, keyEpoch: 1, revision: 2,
        ciphertext: encodeBytes(fresh.contentEnvelope) },
    });
    expect(response.status).toBe(400);
    const unchanged = await (await request(f, `/api/private/tree/directories/${f.rootId}`, "POST")).json() as {
      entriesRevision: number; entries: SealedEntry[];
    };
    expect(unchanged.entriesRevision).toBe(3);
    expect(unchanged.entries).toEqual(listing.entries);
    for (const original of [first, second]) {
      const data = await (await request(f, `/api/private/tree/files/${original.body.nodeId}`, "POST")).json() as {
        revision: number; representationId: string;
      };
      expect(data.revision).toBe(1);
      expect(data.representationId).toBe(original.body.representation.id);
    }
  });

  it("keeps an oversized legacy File readable and permits only a reduced-source replacement", async () => {
    const f = await fixture();
    const created = await fileRequest(f, "legacy.md");
    const fileId = created.body.nodeId;
    const legacySource = "🙂".repeat(65_537); // 262,148 UTF-8 bytes.
    const markdown = new TextEncoder().encode(legacySource);
    const magic = new TextEncoder().encode("mdwn/file-representation/v1\0");
    const plain = new Uint8Array(magic.length + 4 + markdown.length + 4);
    plain.set(magic);
    new DataView(plain.buffer).setUint32(magic.length, markdown.byteLength);
    plain.set(markdown, magic.length + 4);
    const legacy = await createFileRepresentation(f.rootKey, plain, { vaultId: f.accountId, fileId });
    const body = { ...created.body, keyEnvelope: encodeBytes(legacy.fileContentKeyEnvelope),
      representation: { ...created.body.representation, ciphertext: encodeTreeBytes(legacy.contentEnvelope) } };
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", body)).status).toBe(201);
    const path = `/api/private/tree/files/${fileId}`;
    const readable = await (await request(f, path, "POST")).json() as { ciphertext: string; revision: number };
    expect(decodeFileRepresentation(await openSymmetric(decodeTreeBytes(readable.ciphertext, 524_288), legacy.fileContentKey,
      { context: legacy.contentContext })).markdown).toBe(legacySource);
    await expect(createFileRepresentation(f.rootKey, { markdown: legacySource, metadata: new Uint8Array() },
      { vaultId: f.accountId, fileId, keyId: id(), revision: 2 })).rejects.toThrow();
    expect((await (await request(f, path, "POST")).json() as { revision: number }).revision).toBe(1);
    const listing = await (await request(f, `/api/private/tree/directories/${f.rootId}`, "POST")).json() as {
      entries: SealedEntry[]; entriesRevision: number;
    };
    const reduced = await createFileRepresentation(f.rootKey,
      { markdown: "🙂".repeat(65_536), metadata: new Uint8Array() },
      { vaultId: f.accountId, fileId, keyId: id(), revision: 2 });
    const keyEnvelope = encodeBytes(reduced.fileContentKeyEnvelope);
    const head = await createListingHead(f.rootKey, f.assertion.privateKey, { epoch: 1,
      vaultId: f.accountId, directoryId: f.rootId, deviceId: f.deviceId, revision: 3,
      entries: listing.entries.map((entry) => ({ ...entry, keyEnvelope })),
    });
    const saved = await request(f, path, "PATCH", { expectedRevision: 1, expectedEntriesRevision: 2,
      keyEnvelope, listingHead: head, representation: { id: id(),
        contentKeyId: reduced.contentContext.keyId, keyEpoch: 1, revision: 2,
        ciphertext: encodeTreeBytes(reduced.contentEnvelope) } });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const current = await (await request(f, path, "POST")).json() as { ciphertext: string; revision: number };
    expect(current.revision).toBe(2);
    expect(decodeFileRepresentation(await openSymmetric(decodeTreeBytes(current.ciphertext, 524_288), reduced.fileContentKey,
      { context: reduced.contentContext })).markdown).toBe("🙂".repeat(65_536));
  });

  it("renames only after its parent's revision wins, without changing the node edge or File content", async () => {
    const f = await fixture();
    const created = await directoryRequest(f, "before");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created)).status).toBe(201);
    const context = { purpose: "directory-metadata" as const, vaultId: f.accountId,
      objectId: created.nodeId, keyId: f.rootId, keyEpoch: 1, revision: 1 };
    const rename = await prepareTreeRename({ parentEpoch: 1, vaultId: f.accountId, parentId: f.rootId, parentKey: f.rootKey,
      nodeId: created.nodeId, entriesRevision: 2, existingNames: [], requestedName: "after", order: "first" });
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
    const nested = await prepareTreeCreate({ parentEpoch: 1, vaultId: f.accountId, parentId: folder.nodeId, parentKey: childKey,
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

  it("refuses a cycle formed by two new Directory nodes in one deferred-FK transaction", async () => {
    const f = await fixture();
    const a = id(), b = id();
    const node = (nodeId: string, parentId: string) => env.DB.prepare(`INSERT INTO vault_nodes
      (id, kind, owner_id, parent_node_id, created_at, updated_at)
      VALUES (?, 'directory', ?, ?, 1, 1)`).bind(nodeId, f.accountId, parentId);
    const directory = (nodeId: string) => env.DB.prepare(`INSERT INTO directories
      (node_id, owner_id, entries_revision) VALUES (?, ?, 1)`).bind(nodeId, f.accountId);
    const edge = (childId: string, parentId: string) => env.DB.prepare(`INSERT INTO directory_entries
      (child_node_id, owner_id, parent_node_id, name_ciphertext, order_ciphertext, key_envelope)
      VALUES (?, ?, ?, X'01', X'01', X'01')`).bind(childId, f.accountId, parentId);
    await expect(env.DB.batch([
      node(a, b), node(b, a), directory(a), directory(b), edge(a, b), edge(b, a),
    ])).rejects.toThrow();
    expect(await env.DB.prepare("SELECT count(*) AS count FROM vault_nodes WHERE id IN (?, ?)")
      .bind(a, b).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("keeps authenticated private names and ciphertext out of document HTML", async () => {
    const f = await fixture();
    const folder = await directoryRequest(f, "Private heading");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", folder)).status).toBe(201);
    for (const path of [`/d/${folder.nodeId}`, `/f/${folder.nodeId}`]) {
      const document = await SELF.fetch(`https://mdwn.test${path}`, { headers: { cookie: f.session.cookie } });
      expect(document.status).toBe(200);
      const html = await document.text();
      expect(html).toContain("Opening Files");
      expect(html).not.toContain("Private heading");
      expect(html).not.toContain(folder.nameCiphertext);
    }
  });

  it("requires a live bound device proof for every tree read or mutation and rejects replay", async () => {
    const f = await fixture();
    const path = `/api/private/tree/directories/${f.rootId}`;
    const missing = await SELF.fetch(`https://mdwn.test${path}`, { method: "POST", headers: {
      cookie: f.session.cookie, origin: "https://mdwn.test",
    } });
    expect(missing.status).toBe(403);
    const readProof = await signDeviceProof(f.assertion.privateKey, {
      sessionBinding: await sessionBindingDigest(f.session.id), deviceId: f.deviceId,
      registryEpoch: 1, method: "POST", url: `https://mdwn.test${path}`,
    });
    const read = () => SELF.fetch(`https://mdwn.test${path}`, { method: "POST", headers: {
      cookie: f.session.cookie, origin: "https://mdwn.test", "X-Mdwn-Device-Proof": JSON.stringify(readProof),
    } });
    expect((await read()).status).toBe(200);
    expect((await read()).status).toBe(200);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM device_proof_uses WHERE account_id = ?")
      .bind(f.accountId).first()).toEqual({ count: 0 });
    const created = await directoryRequest(f, "private");
    const createPath = `${path}/children`;
    const body = JSON.stringify(await signedRequest(f, createPath, "PUT", created));
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
