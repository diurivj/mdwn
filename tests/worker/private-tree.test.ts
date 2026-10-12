import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createSymmetricWriter, inspectEnvelope, openSymmetric } from "../../app/shared/crypto/enc-v1";
import {
  createChildDirectoryCapability,
  createFileRepresentation,
  decodeFileRepresentation,
  generateDirectoryCapabilityKey,
} from "../../app/shared/crypto/vault";
import { signDeviceProof, sessionBindingDigest } from "../../app/shared/device/proof";
import { NamespaceError, canonicalizeSegment } from "../../app/shared/namespace-v1";
import { encodeBytes, decodeBytes } from "../../app/shared/signup/protocol";
import {
  createTreeChild,
  NameConflictError,
  prepareTreeCreate,
  prepareTreeRename,
  renameTreeChild,
} from "../../app/shared/tree/client";
import { RecoveryConfirmationPendingError } from "../../app/shared/signup/recovery-gate";
import {
  createListingHead,
  openListingHead,
  type SealedEntry,
  type StoredListingHead,
} from "../../app/shared/tree/listing";
import { seedNormalSession } from "./auth-fixtures";
import { encodeTreeBytes } from "../../app/shared/tree/wire";
import { createFileHead } from "../../app/shared/tree/file-head";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      SESSION_COOKIE_SECRET: string;
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

function id(): string {
  const value = crypto.randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

async function fixture() {
  const accountId = id(),
    rootId = id(),
    deviceId = id(),
    credentialId = id();
  const now = Date.now();
  const assertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(
      accountId,
      id(),
      now,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO passkeys (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at) VALUES (?, ?, X'01', 0, '[]', 'singleDevice', 0, ?, ?)",
    ).bind(credentialId, accountId, now, now),
    env.DB.prepare(
      "INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)",
    ).bind(accountId, rootId),
    env.DB.prepare(
      "INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, X'01', ?, 'active', 'signup', 1, ?)",
    ).bind(deviceId, accountId, new Uint8Array(await crypto.subtle.exportKey("raw", assertion.publicKey)), now),
  ]);
  const session = await seedNormalSession({ accountId, credentialIds: [credentialId] });
  await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(deviceId, session.id).run();
  const rootKey = generateDirectoryCapabilityKey();
  return {
    accountId,
    rootId,
    deviceId,
    assertion,
    session,
    rootKey,
    keys: new Map<string, Uint8Array>([[rootId, rootKey]]),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function expectAgreedEdges(f: Fixture) {
  const row = await env.DB.prepare(`SELECT count(*) AS broken FROM vault_nodes n
    LEFT JOIN directory_entries e ON e.child_node_id = n.id AND e.parent_node_id = n.parent_node_id
      AND e.owner_id = n.owner_id
    WHERE n.owner_id = ? AND n.parent_node_id IS NOT NULL AND e.child_node_id IS NULL`)
    .bind(f.accountId)
    .first<{ broken: number }>();
  expect(row?.broken).toBe(0);
}

async function signedRequest(
  f: Fixture,
  path: string,
  _method: "PUT" | "PATCH" | "DELETE",
  value: object,
): Promise<object> {
  const create = /^\/api\/private\/tree\/directories\/([0-9a-f-]+)\/children$/.exec(path);
  const rename = /^\/api\/private\/tree\/nodes\/([0-9a-f-]+)\/name$/.exec(path);
  const save = /^\/api\/private\/tree\/files\/([0-9a-f-]+)$/.exec(path);
  if ((!create && !rename && !save) || "listingHead" in value) return value;
  const parentId =
    create?.[1] ??
    (
      await env.DB.prepare("SELECT parent_node_id FROM vault_nodes WHERE id = ?")
        .bind((rename || save)![1])
        .first<{ parent_node_id: string }>()
    )?.parent_node_id;
  if (!parentId || !f.keys.has(parentId)) return value;
  const listingResponse = await request(f, `/api/private/tree/directories/${parentId}`, "POST");
  if (!listingResponse.ok) return value;
  const listing = (await listingResponse.json()) as { entries: SealedEntry[] };
  const input = value as {
    nodeId?: string;
    nameCiphertext: string;
    orderCiphertext: string;
    keyEnvelope?: string;
    kind?: "directory" | "file";
    expectedRevision: number;
    expectedParentRevision?: number;
    capability?: { id: string; epoch: number };
    representation?: {
      id: string;
      contentKeyId: string;
      keyEpoch: number;
      revision: number;
      ciphertext: string;
      keyEnvelope: string;
    };
  };
  if (create && input.capability && input.representation && input.nodeId) {
    const representation = input.representation;
    value = {
      ...value,
      representation: {
        ...representation,
        fileHead: await createFileHead(f.assertion.privateKey, {
          vaultId: f.accountId,
          fileId: input.nodeId,
          capabilityId: input.capability.id,
          capabilityEpoch: input.capability.epoch,
          representationId: representation.id,
          contentKeyId: representation.contentKeyId,
          keyEpoch: representation.keyEpoch,
          revision: representation.revision,
          deviceId: f.deviceId,
          ciphertext: representation.ciphertext,
          keyEnvelope: representation.keyEnvelope,
        }),
      },
    };
  }
  const entries = create
    ? [
        ...listing.entries,
        {
          nodeId: input.nodeId!,
          kind: input.kind!,
          nameCiphertext: input.nameCiphertext,
          orderCiphertext: input.orderCiphertext,
          keyEnvelope: input.keyEnvelope!,
        },
      ]
    : listing.entries.map((entry) =>
        entry.nodeId === (rename || save)![1]
          ? save
            ? { ...entry, keyEnvelope: input.keyEnvelope! }
            : { ...entry, nameCiphertext: input.nameCiphertext, orderCiphertext: input.orderCiphertext }
          : entry,
      );
  const revision = (save ? input.expectedParentRevision! : input.expectedRevision) + 1;
  if (!Number.isSafeInteger(revision) || revision < 2) return value;
  return {
    ...value,
    listingHead: await createListingHead(f.keys.get(parentId)!, f.assertion.privateKey, {
      vaultId: f.accountId,
      directoryId: parentId,
      deviceId: f.deviceId,
      revision,
      entries,
    }),
  };
}

async function request(
  f: Fixture,
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  value?: object,
  proofId?: string,
) {
  const url = `https://mdwn.test${path}`;
  const signed = value && method !== "POST" ? await signedRequest(f, path, method, value) : value;
  const body = signed === undefined ? undefined : JSON.stringify(signed);
  const proof = await signDeviceProof(f.assertion.privateKey, {
    sessionBinding: await sessionBindingDigest(f.session.id),
    deviceId: f.deviceId,
    registryEpoch: 1,
    method,
    url,
    body,
    ...(proofId ? { proofId } : {}),
  });
  const response = await SELF.fetch(url, {
    method,
    headers: {
      cookie: f.session.cookie,
      origin: "https://mdwn.test",
      "X-Mdwn-Device-Proof": JSON.stringify(proof),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body }),
  });
  if (
    response.status === 201 &&
    method === "PUT" &&
    signed &&
    "kind" in signed &&
    signed.kind === "directory" &&
    "nodeId" in signed &&
    typeof signed.nodeId === "string" &&
    "keyEnvelope" in signed &&
    typeof signed.keyEnvelope === "string"
  ) {
    const created = { nodeId: signed.nodeId, keyEnvelope: signed.keyEnvelope };
    const parentId = /^\/api\/private\/tree\/directories\/([0-9a-f-]+)\/children$/.exec(path)?.[1];
    const parentKey = parentId && f.keys.get(parentId);
    if (parentKey)
      f.keys.set(
        created.nodeId,
        await openSymmetric(decodeBytes(created.keyEnvelope), parentKey, {
          context: {
            purpose: "directory-capability",
            vaultId: f.accountId,
            objectId: created.nodeId,
            keyId: created.nodeId,
            keyEpoch: 1,
            revision: 1,
          },
        }),
      );
  }
  return response;
}

async function directoryRequest(f: Fixture, name: string, nodeId = id(), expectedRevision = 1) {
  const child = await createChildDirectoryCapability(f.rootKey, {
    vaultId: f.accountId,
    parentDirectoryId: f.rootId,
    childDirectoryId: nodeId,
  });
  const writer = await createSymmetricWriter(f.rootKey);
  const context = {
    purpose: "directory-metadata" as const,
    vaultId: f.accountId,
    objectId: nodeId,
    keyId: f.rootId,
    keyEpoch: 1,
    revision: 1,
  };
  const nameCiphertext = await writer.seal(new TextEncoder().encode(name), context);
  const orderCiphertext = await writer.seal(new TextEncoder().encode("first"), context);
  return {
    nodeId,
    expectedRevision,
    kind: "directory",
    nameCiphertext: encodeBytes(nameCiphertext),
    orderCiphertext: encodeBytes(orderCiphertext),
    keyEnvelope: encodeBytes(child.envelope),
  };
}

async function fileRequest(f: Fixture, name: string, nodeId = id(), expectedRevision = 1) {
  const writer = await createSymmetricWriter(f.rootKey);
  const context = {
    purpose: "directory-metadata" as const,
    vaultId: f.accountId,
    objectId: nodeId,
    keyId: f.rootId,
    keyEpoch: 1,
    revision: 1,
  };
  const nameCiphertext = await writer.seal(new TextEncoder().encode(name), context);
  const orderCiphertext = await writer.seal(new TextEncoder().encode("first"), context);
  const file = await createFileRepresentation(
    f.rootKey,
    { markdown: "# private", metadata: new Uint8Array() },
    { vaultId: f.accountId, fileId: nodeId },
  );
  return {
    body: {
      nodeId,
      kind: "file",
      expectedRevision,
      nameCiphertext: encodeBytes(nameCiphertext),
      orderCiphertext: encodeBytes(orderCiphertext),
      keyEnvelope: encodeBytes(file.fileContentKeyEnvelope),
      representation: {
        id: id(),
        contentKeyId: nodeId,
        keyEpoch: 1,
        revision: 1,
        ciphertext: encodeBytes(file.contentEnvelope),
      },
    },
    file,
  };
}

async function saveRequest(
  f: Fixture,
  fileId: string,
  markdown = "# saved",
  expectedRevision = 1,
  expectedParentRevision = 2,
  keyEpoch = 2,
) {
  const contentKeyId = id();
  const file = await createFileRepresentation(
    f.rootKey,
    { markdown, metadata: new Uint8Array() },
    { vaultId: f.accountId, fileId, keyId: contentKeyId, keyEpoch, revision: expectedRevision + 1 },
  );
  return {
    body: {
      expectedRevision,
      expectedParentRevision,
      keyEnvelope: encodeBytes(file.fileContentKeyEnvelope),
      representation: {
        id: id(),
        contentKeyId,
        keyEpoch,
        revision: expectedRevision + 1,
        ciphertext: encodeBytes(file.contentEnvelope),
      },
    },
    file,
  };
}

async function listing(f: Fixture, directoryId: string) {
  const response = await request(f, `/api/private/tree/directories/${directoryId}`, "POST");
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    entriesRevision: number;
    entries: SealedEntry[];
    listingHead: (Omit<StoredListingHead, "signerPublicKey"> & { signerPublicKey: string }) | null;
  }>;
}

async function moveRequest(f: Fixture, nodeId: string, sourceId: string, destinationId: string, name = "moved") {
  const source = await listing(f, sourceId),
    destination = await listing(f, destinationId);
  const entry = source.entries.find((entry) => entry.nodeId === nodeId)!;
  const keyContext = inspectEnvelope(decodeBytes(entry.keyEnvelope)).context;
  const key = await openSymmetric(decodeBytes(entry.keyEnvelope), f.keys.get(sourceId)!, { context: keyContext });
  const writer = await createSymmetricWriter(f.keys.get(destinationId)!);
  const context = {
    purpose: "directory-metadata" as const,
    vaultId: f.accountId,
    objectId: nodeId,
    keyId: destinationId,
    keyEpoch: 1,
    revision: 1,
  };
  const updated = {
    ...entry,
    nameCiphertext: encodeBytes(await writer.seal(new TextEncoder().encode(name), context)),
    orderCiphertext: encodeBytes(await writer.seal(new TextEncoder().encode("last"), context)),
    keyEnvelope: encodeBytes(await writer.seal(key, keyContext)),
  };
  return {
    sourceId,
    destinationId,
    kind: entry.kind,
    expectedSourceRevision: source.entriesRevision,
    expectedDestinationRevision: destination.entriesRevision,
    nameCiphertext: updated.nameCiphertext,
    orderCiphertext: updated.orderCiphertext,
    keyEnvelope: updated.keyEnvelope,
    sourceListingHead: await createListingHead(f.keys.get(sourceId)!, f.assertion.privateKey, {
      vaultId: f.accountId,
      directoryId: sourceId,
      deviceId: f.deviceId,
      revision: source.entriesRevision + 1,
      entries: source.entries.filter((entry) => entry.nodeId !== nodeId),
    }),
    destinationListingHead: await createListingHead(f.keys.get(destinationId)!, f.assertion.privateKey, {
      vaultId: f.accountId,
      directoryId: destinationId,
      deviceId: f.deviceId,
      revision: destination.entriesRevision + 1,
      entries: [...destination.entries, updated],
    }),
  };
}

async function deleteRequest(f: Fixture, nodeId: string, parentId: string) {
  const parent = await listing(f, parentId);
  const entry = parent.entries.find((entry) => entry.nodeId === nodeId)!;
  return {
    parentId,
    kind: entry.kind,
    expectedRevision: parent.entriesRevision,
    ...(entry.kind === "directory" ? { expectedDirectoryRevision: (await listing(f, nodeId)).entriesRevision } : {}),
    listingHead: await createListingHead(f.keys.get(parentId)!, f.assertion.privateKey, {
      vaultId: f.accountId,
      directoryId: parentId,
      deviceId: f.deviceId,
      revision: parent.entriesRevision + 1,
      entries: parent.entries.filter((entry) => entry.nodeId !== nodeId),
    }),
  };
}

async function seedDeletionSubtree(f: Fixture, size: number) {
  const root = await directoryRequest(f, "bounded");
  expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", root)).status).toBe(201);
  const nestedId = id();
  const nodes = [
    { id: nestedId, kind: "directory", parent: root.nodeId },
    ...Array.from({ length: size - 2 }, (_, index) => ({
      id: id(),
      kind: "file",
      parent: index % 2 ? nestedId : root.nodeId,
    })),
  ];
  const serialized = JSON.stringify(nodes);
  // Opaque storage-boundary fixture: deletion never decrypts descendant ciphertext.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.kind'), ?, json_extract(value, '$.parent'), 1, 1 FROM json_each(?)`).bind(
      f.accountId,
      serialized,
    ),
    env.DB.prepare("INSERT INTO directories (node_id, owner_id, entries_revision) VALUES (?, ?, 1)").bind(
      nestedId,
      f.accountId,
    ),
    env.DB.prepare(`INSERT INTO files (node_id, owner_id, current_representation_id, current_revision)
      SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.id'), 1 FROM json_each(?) WHERE json_extract(value, '$.kind') = 'file'`).bind(
      f.accountId,
      serialized,
    ),
    env.DB.prepare(`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id, key_epoch, ciphertext, ciphertext_size, created_at)
      SELECT node_id, node_id, owner_id, 1, node_id, 1, X'01', 1, 1 FROM files WHERE owner_id = ?`).bind(f.accountId),
    env.DB.prepare(`INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id, name_ciphertext, order_ciphertext, key_envelope)
      SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.parent'), X'01', X'01', X'01' FROM json_each(?)`).bind(
      f.accountId,
      serialized,
    ),
    env.DB.prepare(`INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch)
      SELECT ?, 'owned-device', json_extract(value, '$.id'), ?, X'01', 1 FROM json_each(?)`).bind(
      f.accountId,
      f.deviceId,
      serialized,
    ),
  ]);
  const entries = nodes
    .filter((node) => node.parent === root.nodeId)
    .map(
      (node): SealedEntry => ({
        nodeId: node.id,
        kind: node.kind as "directory" | "file",
        nameCiphertext: "AQ",
        orderCiphertext: "AQ",
        keyEnvelope: "AQ",
      }),
    );
  const head = await createListingHead(f.keys.get(root.nodeId)!, f.assertion.privateKey, {
    vaultId: f.accountId,
    directoryId: root.nodeId,
    deviceId: f.deviceId,
    revision: 2,
    entries,
  });
  await env.DB.prepare(`UPDATE directories SET entries_revision = 2, listing_ciphertext = ?, listing_digest = ?,
    listing_signature = ?, listing_device_id = ? WHERE node_id = ?`)
    .bind(decodeBytes(head.ciphertext), decodeBytes(head.digest), decodeBytes(head.signature), f.deviceId, root.nodeId)
    .run();
  return root.nodeId;
}

describe("private tree", () => {
  it("keeps a concurrent File key replacement and move atomic with a refreshable loser", async () => {
    for (let index = 0; index < 12; index++) {
      const f = await fixture();
      const created = await fileRequest(f, "current.md");
      expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created.body)).status).toBe(
        201,
      );
      const destination = await directoryRequest(f, "target", id(), 2);
      expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", destination)).status).toBe(
        201,
      );
      const filePath = `/api/private/tree/files/${created.body.nodeId}`;
      const save = await signedRequest(
        f,
        filePath,
        "PATCH",
        (await saveRequest(f, created.body.nodeId, "# winning save", 1, 3)).body,
      );
      const move = await moveRequest(f, created.body.nodeId, f.rootId, destination.nodeId);
      const operations = [
        () => request(f, filePath, "PATCH", save),
        () => request(f, `/api/private/tree/nodes/${created.body.nodeId}/parent`, "PATCH", move),
      ];
      const responses = await Promise.all((index % 2 ? operations.reverse() : operations).map((run) => run()));
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(await responses.find((response) => response.status === 409)!.json()).toEqual({
        error: "namespace_changed",
      });
      await expectAgreedEdges(f);
    }
  });
  it("keeps concurrent target deletion and rename losers on the namespace refresh path", async () => {
    for (let index = 0; index < 12; index++) {
      const f = await fixture();
      const child = await directoryRequest(f, "before");
      expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", child)).status).toBe(201);
      const renamePath = `/api/private/tree/nodes/${child.nodeId}/name`;
      const rename = await signedRequest(
        f,
        renamePath,
        "PATCH",
        await prepareTreeRename({
          vaultId: f.accountId,
          parentId: f.rootId,
          parentKey: f.rootKey,
          nodeId: child.nodeId,
          entriesRevision: 2,
          existingNames: [],
          requestedName: "after",
          order: "first",
        }),
      );
      const deletion = await deleteRequest(f, child.nodeId, f.rootId);
      const operations = [
        () => request(f, renamePath, "PATCH", rename),
        () => request(f, `/api/private/tree/nodes/${child.nodeId}`, "DELETE", deletion),
      ];
      const responses = await Promise.all((index % 2 ? operations.reverse() : operations).map((run) => run()));
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(await responses.find((response) => response.status === 409)!.json()).toEqual({
        error: "namespace_changed",
      });
      expect((await listing(f, f.rootId)).entriesRevision).toBe(3);
      await expectAgreedEdges(f);
    }
  });
  it("fails closed on move ancestry beyond the supported path bound in both the API and D1", async () => {
    const f = await fixture();
    const file = await fileRequest(f, "bounded path.md");
    const rootPath = `/api/private/tree/directories/${f.rootId}`;
    expect((await request(f, `${rootPath}/children`, "PUT", file.body)).status).toBe(201);
    const top = await directoryRequest(f, "deep fixture", id(), 2);
    expect((await request(f, `${rootPath}/children`, "PUT", top)).status).toBe(201);
    let parent = top.nodeId;
    const chain = Array.from({ length: 101 }, () => {
      const nodeId = id(),
        node = { id: nodeId, parent };
      parent = nodeId;
      return node;
    });
    const encoded = JSON.stringify(chain);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at)
        SELECT json_extract(value, '$.id'), 'directory', ?, json_extract(value, '$.parent'), 1, 1 FROM json_each(?)`).bind(
        f.accountId,
        encoded,
      ),
      env.DB.prepare(`INSERT INTO directories (node_id, owner_id, entries_revision)
        SELECT json_extract(value, '$.id'), ?, 1 FROM json_each(?)`).bind(f.accountId, encoded),
      env.DB.prepare(`INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id, name_ciphertext, order_ciphertext, key_envelope)
        SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.parent'), X'01', X'01', X'01' FROM json_each(?)`).bind(
        f.accountId,
        encoded,
      ),
    ]);
    f.keys.set(parent, generateDirectoryCapabilityKey());
    const body = await moveRequest(f, file.body.nodeId, f.rootId, parent);
    const before = await listing(f, f.rootId);
    expect((await request(f, `/api/private/tree/nodes/${file.body.nodeId}/parent`, "PATCH", body)).status).toBe(400);
    expect(await listing(f, f.rootId)).toEqual(before);
    await expect(
      env.DB.batch([
        env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
        env.DB.prepare("UPDATE vault_nodes SET parent_node_id = ? WHERE id = ?").bind(parent, file.body.nodeId),
        env.DB.prepare("UPDATE directory_entries SET parent_node_id = ? WHERE child_node_id = ?").bind(
          parent,
          file.body.nodeId,
        ),
      ]),
    ).rejects.toThrow();
    await expectAgreedEdges(f);
  });
  it("moves the current File key after a save and preserves readable content and representation identity", async () => {
    const f = await fixture();
    const created = await fileRequest(f, "current.md");
    const root = `/api/private/tree/directories/${f.rootId}`;
    expect((await request(f, `${root}/children`, "PUT", created.body)).status).toBe(201);
    const saved = await saveRequest(f, created.body.nodeId, "# current key");
    expect((await request(f, `/api/private/tree/files/${created.body.nodeId}`, "PATCH", saved.body)).status).toBe(200);
    const destination = await directoryRequest(f, "target", id(), 3);
    expect((await request(f, `${root}/children`, "PUT", destination)).status).toBe(201);
    const body = await moveRequest(f, created.body.nodeId, f.rootId, destination.nodeId, "renamed.md");
    expect(JSON.stringify(body)).not.toContain("renamed.md");
    expect((await request(f, `/api/private/tree/nodes/${created.body.nodeId}/parent`, "PATCH", body)).status).toBe(200);
    const file = (await (await request(f, `/api/private/tree/files/${created.body.nodeId}`, "POST")).json()) as {
      parentId: string;
      representationId: string;
      revision: number;
      keyEnvelope: string;
      ciphertext: string;
    };
    expect(file).toMatchObject({
      parentId: destination.nodeId,
      representationId: saved.body.representation.id,
      revision: 2,
    });
    const key = await openSymmetric(decodeBytes(file.keyEnvelope), f.keys.get(destination.nodeId)!, {
      context: saved.file.keyContext,
    });
    expect(
      decodeFileRepresentation(
        await openSymmetric(decodeBytes(file.ciphertext), key, { context: saved.file.contentContext }),
      ).markdown,
    ).toBe("# current key");
    await expectAgreedEdges(f);
  });

  it("refuses cross-owner, cyclic, wrong-kind, hidden-root and malformed moves without changing either namespace", async () => {
    const f = await fixture();
    const source = await directoryRequest(f, "source");
    const destination = await directoryRequest(f, "destination", id(), 2);
    const root = `/api/private/tree/directories/${f.rootId}`;
    expect((await request(f, `${root}/children`, "PUT", source)).status).toBe(201);
    expect((await request(f, `${root}/children`, "PUT", destination)).status).toBe(201);
    const child = await prepareTreeCreate({
      vaultId: f.accountId,
      parentId: source.nodeId,
      parentKey: f.keys.get(source.nodeId)!,
      entriesRevision: 1,
      existingNames: [],
      requestedName: "child",
      kind: "directory",
    });
    expect((await request(f, `/api/private/tree/directories/${source.nodeId}/children`, "PUT", child)).status).toBe(
      201,
    );
    const body = await moveRequest(f, source.nodeId, f.rootId, destination.nodeId);
    const before = await listing(f, f.rootId),
      destinationBefore = await listing(f, destination.nodeId);
    const other = await fixture();
    for (const [input, status] of [
      [{ ...body, destinationId: other.rootId }, 404],
      [{ ...body, destinationId: id() }, 404],
      [{ ...body, kind: "file" }, 400],
      [{ ...body, sourceId: destination.nodeId }, 400],
      [{ ...body, expectedSourceRevision: 2 }, 409],
      [{ ...body, expectedDestinationRevision: 2 }, 409],
      [{ ...body, nameCiphertext: source.nameCiphertext }, 400],
      [
        {
          ...body,
          destinationListingHead: { ...body.destinationListingHead, signature: encodeBytes(new Uint8Array(64)) },
        },
        400,
      ],
      [{ ...body, extra: "plaintext must never be accepted" }, 400],
      [await moveRequest(f, source.nodeId, f.rootId, child.nodeId), 400],
    ] as const) {
      expect((await request(f, `/api/private/tree/nodes/${source.nodeId}/parent`, "PATCH", input)).status).toBe(status);
      expect(await listing(f, f.rootId)).toEqual(before);
      expect(await listing(f, destination.nodeId)).toEqual(destinationBefore);
      await expectAgreedEdges(f);
    }
    expect((await request(f, `/api/private/tree/nodes/${f.rootId}/parent`, "PATCH", body)).status).toBe(404);
    expect(await listing(f, f.rootId)).toEqual(before);
  });

  it("makes a destination structural winner and a reused mutation proof leave no partial source move", async () => {
    const f = await fixture();
    const source = await directoryRequest(f, "source");
    const destination = await directoryRequest(f, "destination", id(), 2);
    const root = `/api/private/tree/directories/${f.rootId}`;
    expect((await request(f, `${root}/children`, "PUT", source)).status).toBe(201);
    expect((await request(f, `${root}/children`, "PUT", destination)).status).toBe(201);
    const stale = await moveRequest(f, source.nodeId, f.rootId, destination.nodeId);
    const added = await prepareTreeCreate({
      vaultId: f.accountId,
      parentId: destination.nodeId,
      parentKey: f.keys.get(destination.nodeId)!,
      entriesRevision: 1,
      existingNames: [],
      requestedName: "winner",
      kind: "file",
    });
    expect(
      (await request(f, `/api/private/tree/directories/${destination.nodeId}/children`, "PUT", added)).status,
    ).toBe(201);
    const before = await listing(f, f.rootId),
      targetBefore = await listing(f, destination.nodeId);
    const path = `/api/private/tree/nodes/${source.nodeId}/parent`;
    const loser = await request(f, path, "PATCH", stale);
    expect(loser.status).toBe(409);
    expect(await loser.json()).toEqual({ error: "namespace_changed" });
    expect(await listing(f, f.rootId)).toEqual(before);
    expect(await listing(f, destination.nodeId)).toEqual(targetBefore);
    const fresh = await moveRequest(f, source.nodeId, f.rootId, destination.nodeId);
    const body = JSON.stringify(fresh),
      url = `https://mdwn.test${path}`;
    const proof = await signDeviceProof(f.assertion.privateKey, {
      sessionBinding: await sessionBindingDigest(f.session.id),
      deviceId: f.deviceId,
      registryEpoch: 1,
      method: "PATCH",
      url,
      body,
    });
    // A spent proof predating this invocation must not unlock any multi-row writes.
    await env.DB.prepare(
      "INSERT INTO device_proof_uses (account_id, proof_id, session_id, expires_at, commit_token) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(f.accountId, proof.proofId, f.session.id, proof.expiresAt, id())
      .run();
    expect(
      (
        await SELF.fetch(url, {
          method: "PATCH",
          body,
          headers: {
            cookie: f.session.cookie,
            origin: "https://mdwn.test",
            "content-type": "application/json",
            "X-Mdwn-Device-Proof": JSON.stringify(proof),
          },
        })
      ).status,
    ).toBe(409);
    expect(await listing(f, f.rootId)).toEqual(before);
    expect(await listing(f, destination.nodeId)).toEqual(targetBefore);
    await expectAgreedEdges(f);
    expect((await request(f, path, "PATCH", fresh)).status).toBe(200);
    await expectAgreedEdges(f);
  });

  it("requires refreshed subtree revisions for Directory deletion and keeps hidden roots and foreign objects inaccessible", async () => {
    const f = await fixture();
    const dir = await directoryRequest(f, "retained");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", dir)).status).toBe(201);
    const body = await deleteRequest(f, dir.nodeId, f.rootId);
    const child = await prepareTreeCreate({
      vaultId: f.accountId,
      parentId: dir.nodeId,
      parentKey: f.keys.get(dir.nodeId)!,
      entriesRevision: 1,
      existingNames: [],
      requestedName: "winner.md",
      kind: "file",
    });
    expect((await request(f, `/api/private/tree/directories/${dir.nodeId}/children`, "PUT", child)).status).toBe(201);
    const parentBefore = await listing(f, f.rootId),
      subtreeBefore = await listing(f, dir.nodeId);
    const stale = await request(f, `/api/private/tree/nodes/${dir.nodeId}`, "DELETE", body);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "namespace_changed" });
    const other = await fixture();
    const inaccessible = await request(other, `/api/private/tree/nodes/${dir.nodeId}`, "DELETE", {
      ...body,
      parentId: other.rootId,
      expectedRevision: 1,
    });
    const missing = await request(other, `/api/private/tree/nodes/${id()}`, "DELETE", {
      ...body,
      parentId: other.rootId,
      expectedRevision: 1,
    });
    expect(inaccessible.status).toBe(404);
    expect(await inaccessible.text()).toBe(await missing.text());
    expect((await request(f, `/api/private/tree/nodes/${f.rootId}`, "DELETE", body)).status).toBe(404);
    expect(await listing(f, f.rootId)).toEqual(parentBefore);
    expect(await listing(f, dir.nodeId)).toEqual(subtreeBefore);
    await expectAgreedEdges(f);
  });
  it("refuses an over-cap Directory without changing any node, ciphertext, revision or proof record", async () => {
    const f = await fixture();
    const rootId = await seedDeletionSubtree(f, 501);
    const payload = await deleteRequest(f, rootId, f.rootId);
    const tables = [
      "vault_nodes",
      "directories",
      "directory_entries",
      "files",
      "file_representations",
      "key_envelopes",
      "device_proof_uses",
    ];
    const state = () =>
      Promise.all(
        tables.map((table) =>
          env.DB.prepare(`SELECT * FROM ${table} WHERE
      ${table === "key_envelopes" || table === "device_proof_uses" ? "account_id" : "owner_id"} = ? ORDER BY rowid`)
            .bind(f.accountId)
            .all()
            .then((result) => result.results),
        ),
      );
    const before = await state();
    const response = await request(f, `/api/private/tree/nodes/${rootId}`, "DELETE", payload);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "directory_too_large", maxNodes: 500 });
    expect(await state()).toEqual(before);
    await expectAgreedEdges(f);
  });

  it("commits exactly one same-revision Directory delete and gives its competitor a nameless namespace conflict", async () => {
    const f = await fixture();
    const rootId = await seedDeletionSubtree(f, 6);
    const payload = await deleteRequest(f, rootId, f.rootId);
    const path = `/api/private/tree/nodes/${rootId}`;
    const responses = await Promise.all([request(f, path, "DELETE", payload), request(f, path, "DELETE", payload)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await responses.find((response) => response.status === 409)!.json()).toEqual({ error: "namespace_changed" });
    const parent = await listing(f, f.rootId);
    expect(parent.entriesRevision).toBe(3);
    expect(parent.entries).toEqual([]);
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM device_proof_uses WHERE account_id = ?")
        .bind(f.accountId)
        .first(),
    ).toEqual({ count: 2 });
    await expectAgreedEdges(f);
  });

  it("rolls back the full deletion graph and parent head if any explicit dependent step fails", async () => {
    const f = await fixture();
    const rootId = await seedDeletionSubtree(f, 8);
    const payload = await deleteRequest(f, rootId, f.rootId);
    const before = await listing(f, f.rootId);
    await env.DB.prepare(`CREATE TRIGGER test_tree_delete_abort BEFORE DELETE ON vault_nodes
      WHEN OLD.id = '${rootId}' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`).run();
    try {
      expect((await request(f, `/api/private/tree/nodes/${rootId}`, "DELETE", payload)).status).toBe(400);
      expect(await listing(f, f.rootId)).toEqual(before);
      expect(
        await env.DB.prepare("SELECT count(*) AS count FROM vault_nodes WHERE owner_id = ?").bind(f.accountId).first(),
      ).toEqual({ count: 9 });
      expect(
        await env.DB.prepare("SELECT count(*) AS count FROM file_representations WHERE owner_id = ?")
          .bind(f.accountId)
          .first(),
      ).toEqual({ count: 6 });
      expect(
        await env.DB.prepare("SELECT count(*) AS count FROM key_envelopes WHERE account_id = ?")
          .bind(f.accountId)
          .first(),
      ).toEqual({ count: 7 });
      expect(
        await env.DB.prepare("SELECT count(*) AS count FROM device_proof_uses WHERE account_id = ?")
          .bind(f.accountId)
          .first(),
      ).toEqual({ count: 1 });
      await expectAgreedEdges(f);
    } finally {
      await env.DB.exec("DROP TRIGGER test_tree_delete_abort");
    }
    expect((await request(f, `/api/private/tree/nodes/${rootId}`, "DELETE", payload)).status).toBe(200);
  });
  it("atomically hard-deletes a 500-node Directory including nested Directories and all dependent records", async () => {
    const f = await fixture();
    const rootId = await seedDeletionSubtree(f, 500);
    const response = await request(
      f,
      `/api/private/tree/nodes/${rootId}`,
      "DELETE",
      await deleteRequest(f, rootId, f.rootId),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await listing(f, f.rootId)).entries).toEqual([]);
    expect((await request(f, `/api/private/tree/directories/${rootId}`, "POST")).status).toBe(404);
    for (const table of [
      "vault_nodes",
      "directories",
      "directory_entries",
      "files",
      "file_representations",
      "key_envelopes",
    ]) {
      const owner = table === "key_envelopes" ? "account_id" : "owner_id";
      expect(
        await env.DB.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${owner} = ?`).bind(f.accountId).first(),
      ).toEqual({ count: table === "vault_nodes" || table === "directories" ? 1 : 0 });
    }
    await expectAgreedEdges(f);
  });
  it("hard-deletes a File's encrypted edge, representation and owned Key envelopes with no restore state", async () => {
    const f = await fixture();
    const created = await fileRequest(f, "delete.md");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created.body)).status).toBe(
      201,
    );
    await env.DB.prepare(`INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch)
      VALUES (?, 'owned-device', ?, ?, X'01', 1)`)
      .bind(f.accountId, created.body.nodeId, f.deviceId)
      .run();
    const path = `/api/private/tree/nodes/${created.body.nodeId}`;
    const deleted = await request(f, path, "DELETE", await deleteRequest(f, created.body.nodeId, f.rootId));
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await deleted.json()).toEqual({ entriesRevision: 3 });
    expect((await listing(f, f.rootId)).entries).toEqual([]);
    const missing = await request(f, `/api/private/tree/files/${id()}`, "POST");
    const inaccessible = await request(await fixture(), `/api/private/tree/files/${created.body.nodeId}`, "POST");
    const removed = await request(f, `/api/private/tree/files/${created.body.nodeId}`, "POST");
    expect(removed.status).toBe(404);
    expect(await removed.text()).toBe(await missing.text());
    expect(await inaccessible.text()).toBe('{"error":"not_found"}');
    // Supplemental graph/lifecycle invariants at the agreed real-D1 storage seam.
    for (const [table, column] of [
      ["vault_nodes", "id"],
      ["directory_entries", "child_node_id"],
      ["files", "node_id"],
      ["file_representations", "file_node_id"],
      ["key_envelopes", "object_id"],
    ]) {
      expect(
        await env.DB.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${column} = ?`)
          .bind(created.body.nodeId)
          .first(),
      ).toEqual({ count: 0 });
    }
    await expectAgreedEdges(f);
  });
  it("moves a Directory with its existing descendants, rewrapping its capability and advancing both namespaces", async () => {
    const f = await fixture();
    const source = await directoryRequest(f, "source");
    const destination = await directoryRequest(f, "destination", id(), 2);
    const root = `/api/private/tree/directories/${f.rootId}`;
    expect((await request(f, `${root}/children`, "PUT", source)).status).toBe(201);
    expect((await request(f, `${root}/children`, "PUT", destination)).status).toBe(201);
    const child = await prepareTreeCreate({
      vaultId: f.accountId,
      parentId: source.nodeId,
      parentKey: f.keys.get(source.nodeId)!,
      entriesRevision: 1,
      existingNames: [],
      requestedName: "nested.md",
      kind: "file",
      markdown: "# retained",
    });
    expect((await request(f, `/api/private/tree/directories/${source.nodeId}/children`, "PUT", child)).status).toBe(
      201,
    );
    const fileBefore = await (await request(f, `/api/private/tree/files/${child.nodeId}`, "POST")).json();
    const payload = await moveRequest(f, source.nodeId, f.rootId, destination.nodeId);
    const response = await request(f, `/api/private/tree/nodes/${source.nodeId}/parent`, "PATCH", payload);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ sourceEntriesRevision: 4, destinationEntriesRevision: 2 });
    expect((await listing(f, f.rootId)).entries.map((entry) => entry.nodeId)).toEqual([destination.nodeId]);
    const moved = await listing(f, destination.nodeId);
    expect(moved.entries[0]?.keyEnvelope).toBe(payload.keyEnvelope);
    const capability = await openSymmetric(decodeBytes(payload.keyEnvelope), f.keys.get(destination.nodeId)!, {
      context: {
        purpose: "directory-capability",
        vaultId: f.accountId,
        objectId: source.nodeId,
        keyId: source.nodeId,
        keyEpoch: 1,
        revision: 1,
      },
    });
    expect(capability).toEqual(f.keys.get(source.nodeId));
    await expect(
      openListingHead(f.keys.get(destination.nodeId)!, {
        vaultId: f.accountId,
        directoryId: destination.nodeId,
        revision: 2,
        entries: moved.entries,
        head: { ...moved.listingHead!, signerPublicKey: decodeBytes(moved.listingHead!.signerPublicKey) },
      }),
    ).resolves.toBeUndefined();
    expect(await (await request(f, `/api/private/tree/files/${child.nodeId}`, "POST")).json()).toEqual(fileBefore);
    expect(await (await request(f, `/api/private/tree/nodes/${child.nodeId}/ancestors`, "POST")).json()).toEqual({
      ancestors: [f.rootId, destination.nodeId, source.nodeId, child.nodeId],
    });
    await expectAgreedEdges(f);
  });
  it("reorders encrypted siblings under one revision without changing their names, keys or edges", async () => {
    const f = await fixture();
    const first = await directoryRequest(f, "one");
    const second = await directoryRequest(f, "two", id(), 2);
    const root = `/api/private/tree/directories/${f.rootId}`;
    expect((await request(f, `${root}/children`, "PUT", first)).status).toBe(201);
    expect((await request(f, `${root}/children`, "PUT", second)).status).toBe(201);
    const before = (await (await request(f, root, "POST")).json()) as { entries: SealedEntry[] };
    const orders = await Promise.all(
      [second.nodeId, first.nodeId].map(async (nodeId, index) => {
        const writer = await createSymmetricWriter(f.rootKey);
        return {
          nodeId,
          orderCiphertext: encodeBytes(
            await writer.seal(new TextEncoder().encode(String(index)), {
              purpose: "directory-metadata",
              vaultId: f.accountId,
              objectId: nodeId,
              keyId: f.rootId,
              keyEpoch: 1,
              revision: 1,
            }),
          ),
        };
      }),
    );
    const entries = before.entries.map((entry) => ({
      ...entry,
      orderCiphertext: orders.find((order) => order.nodeId === entry.nodeId)!.orderCiphertext,
    }));
    const body = {
      parentId: f.rootId,
      expectedRevision: 3,
      orders,
      listingHead: await createListingHead(f.rootKey, f.assertion.privateKey, {
        vaultId: f.accountId,
        directoryId: f.rootId,
        deviceId: f.deviceId,
        revision: 4,
        entries,
      }),
    };
    const path = `/api/private/tree/nodes/${first.nodeId}/order`;
    expect((await request(f, path, "PATCH", body)).status).toBe(200);
    const after = (await (await request(f, root, "POST")).json()) as {
      entriesRevision: number;
      entries: SealedEntry[];
    };
    expect(after).toMatchObject({ entriesRevision: 4, entries });
    await expectAgreedEdges(f);
    const stale = await request(f, path, "PATCH", body);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "namespace_changed" });
    expect(await (await request(f, root, "POST")).json()).toEqual(after);
  });
  it("validates the parent listing signature, digest and exact shape before changing File pointers", async () => {
    const f = await fixture();
    const created = await fileRequest(f, "head.md");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created.body)).status).toBe(
      201,
    );
    const path = `/api/private/tree/files/${created.body.nodeId}`;
    const save = await saveRequest(f, created.body.nodeId);
    const signed = (await signedRequest(f, path, "PATCH", save.body)) as typeof save.body & {
      listingHead: { ciphertext: string; digest: string; signature: string };
    };
    const before = await (await request(f, path, "POST")).json();
    const listingBefore = await (await request(f, `/api/private/tree/directories/${f.rootId}`, "POST")).json();
    for (const listingHead of [
      { ...signed.listingHead, unknown: true },
      { ...signed.listingHead, digest: encodeBytes(new Uint8Array(32)) },
      { ...signed.listingHead, signature: encodeBytes(new Uint8Array(64)) },
      await createListingHead(f.rootKey, f.assertion.privateKey, {
        vaultId: f.accountId,
        directoryId: f.rootId,
        deviceId: f.deviceId,
        revision: 4,
        entries: [],
      }),
    ]) {
      expect((await request(f, path, "PATCH", { ...save.body, listingHead })).status).toBe(400);
      expect(await (await request(f, path, "POST")).json()).toEqual(before);
      expect(await (await request(f, `/api/private/tree/directories/${f.rootId}`, "POST")).json()).toEqual(
        listingBefore,
      );
    }
  });

  it("rolls back all save storage when a fresh representation identity collides and rejects a spent proof", async () => {
    const f = await fixture();
    const created = await fileRequest(f, "atomic.md");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created.body)).status).toBe(
      201,
    );
    const sibling = await fileRequest(f, "sibling.md", id(), 2);
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", sibling.body)).status).toBe(
      201,
    );
    const path = `/api/private/tree/files/${created.body.nodeId}`;
    const save = await saveRequest(f, created.body.nodeId, "atomic replacement", 1, 3);
    const fileBefore = await (await request(f, path, "POST")).json();
    const listingBefore = await (await request(f, `/api/private/tree/directories/${f.rootId}`, "POST")).json();
    expect(
      (
        await request(f, path, "PATCH", {
          ...save.body,
          representation: { ...save.body.representation, id: sibling.body.representation.id },
        })
      ).status,
    ).toBe(400);
    const url = `https://mdwn.test${path}`;
    const body = JSON.stringify(await signedRequest(f, path, "PATCH", save.body));
    const proof = await signDeviceProof(f.assertion.privateKey, {
      sessionBinding: await sessionBindingDigest(f.session.id),
      deviceId: f.deviceId,
      registryEpoch: 1,
      method: "PATCH",
      url,
      body,
    });
    // Supplemental storage invariant: spend this exact proof between authorization and CAS.
    await env.DB.prepare(
      "INSERT INTO device_proof_uses (account_id, proof_id, session_id, expires_at) VALUES (?, ?, ?, ?)",
    )
      .bind(f.accountId, proof.proofId, f.session.id, proof.expiresAt)
      .run();
    const spent = await SELF.fetch(url, {
      method: "PATCH",
      body,
      headers: {
        cookie: f.session.cookie,
        origin: "https://mdwn.test",
        "content-type": "application/json",
        "X-Mdwn-Device-Proof": JSON.stringify(proof),
      },
    });
    expect(spent.status).toBe(403);
    expect(await spent.json()).toEqual({ error: "device_proof_spent" });
    expect(await (await request(f, path, "POST")).json()).toEqual(fileBefore);
    expect(await (await request(f, `/api/private/tree/directories/${f.rootId}`, "POST")).json()).toEqual(listingBefore);
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM file_representations WHERE owner_id = ?")
        .bind(f.accountId)
        .first(),
    ).toEqual({ count: 2 });
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM device_proof_uses WHERE account_id = ?")
        .bind(f.accountId)
        .first(),
    ).toEqual({ count: 3 });
    expect((await request(f, path, "PATCH", save.body)).status).toBe(200);
  });

  it("bounds the whole decoded save ciphertext and JSON body without leaving partial storage", async () => {
    const f = await fixture();
    const created = await fileRequest(f, "limit.md");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created.body)).status).toBe(
      201,
    );
    const path = `/api/private/tree/files/${created.body.nodeId}`;
    const save = await saveRequest(f, created.body.nodeId);
    const writer = await createSymmetricWriter(save.file.fileContentKey);
    const empty = await writer.seal(new Uint8Array(), save.file.contentContext);
    const bounded = await writer.seal(new Uint8Array(524288 - empty.length), save.file.contentContext);
    expect(bounded.length).toBe(524288);
    const oversized = new Uint8Array(524289);
    oversized.set(bounded);
    const before = await (await request(f, path, "POST")).json();
    const oversizedCiphertext = btoa(Array.from(oversized, (byte) => String.fromCharCode(byte)).join(""))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    for (const ciphertext of [oversizedCiphertext, "A".repeat(1536 * 1024)]) {
      expect(
        (await request(f, path, "PATCH", { ...save.body, representation: { ...save.body.representation, ciphertext } }))
          .status,
      ).toBe(400);
      expect(await (await request(f, path, "POST")).json()).toEqual(before);
    }
    expect(
      (
        await request(f, path, "PATCH", {
          ...save.body,
          representation: { ...save.body.representation, ciphertext: encodeTreeBytes(bounded) },
        })
      ).status,
    ).toBe(200);
    expect(
      await env.DB.prepare("SELECT ciphertext_size FROM file_representations WHERE file_node_id = ?")
        .bind(created.body.nodeId)
        .first(),
    ).toEqual({ ciphertext_size: 524288 });
  });

  it("requires same-origin, exact-body device proofs and current owned File authority for saves", async () => {
    const f = await fixture();
    const created = await fileRequest(f, "authority.md");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created.body)).status).toBe(
      201,
    );
    const path = `/api/private/tree/files/${created.body.nodeId}`;
    const save = await saveRequest(f, created.body.nodeId);
    const value = await signedRequest(f, path, "PATCH", save.body);
    const body = JSON.stringify(value);
    const url = `https://mdwn.test${path}`;
    const proof = await signDeviceProof(f.assertion.privateKey, {
      sessionBinding: await sessionBindingDigest(f.session.id),
      deviceId: f.deviceId,
      registryEpoch: 1,
      method: "PATCH",
      url,
      body,
    });
    const headers = {
      cookie: f.session.cookie,
      origin: "https://mdwn.test",
      "content-type": "application/json",
      "X-Mdwn-Device-Proof": JSON.stringify(proof),
    };
    const before = await (await request(f, path, "POST")).json();
    for (const init of [
      { headers: { ...headers, origin: "https://foreign.test" }, body },
      { headers: { ...headers, origin: "" }, body },
      { headers: { ...headers, "sec-fetch-site": "cross-site" }, body },
      { headers: { ...headers, "X-Mdwn-Device-Proof": "null" }, body },
      { headers: { ...headers, "X-Mdwn-Device-Proof": "{" }, body },
      { headers, body: `${body} ` },
    ]) {
      expect((await SELF.fetch(url, { method: "PATCH", ...init })).status).toBe(403);
      expect(await (await request(f, path, "POST")).json()).toEqual(before);
    }
    const other = await fixture();
    const inaccessible = await request(other, path, "PATCH", value);
    const missing = await request(other, `/api/private/tree/files/${id()}`, "PATCH", value);
    expect(inaccessible.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await inaccessible.text()).toBe(await missing.text());
    await env.DB.prepare("UPDATE sessions SET device_id = NULL WHERE id = ?").bind(f.session.id).run();
    expect((await SELF.fetch(url, { method: "PATCH", headers, body })).status).toBe(403);
    await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(f.deviceId, f.session.id).run();
    await env.DB.prepare("UPDATE encryption_devices SET state = 'revoked' WHERE id = ?").bind(f.deviceId).run();
    expect((await SELF.fetch(url, { method: "PATCH", headers, body })).status).toBe(403);
    expect(
      await env.DB.prepare("SELECT current_revision FROM files WHERE node_id = ?").bind(created.body.nodeId).first(),
    ).toEqual({ current_revision: 1 });
    expect(
      await env.DB.prepare("SELECT entries_revision FROM directories WHERE node_id = ?").bind(f.rootId).first(),
    ).toEqual({ entries_revision: 2 });
  });

  it("rejects malformed save shapes, reused identities, wrong contexts and unsafe increments without mutation", async () => {
    const f = await fixture();
    const created = await fileRequest(f, "validate.md");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created.body)).status).toBe(
      201,
    );
    const path = `/api/private/tree/files/${created.body.nodeId}`;
    const save = await saveRequest(f, created.body.nodeId);
    const before = await (await request(f, path, "POST")).json();
    const wrongContext = await saveRequest(f, id());
    const invalid = [
      { ...save.body, extra: true },
      { ...save.body, representation: { ...save.body.representation, extra: true } },
      { ...save.body, representation: { ...save.body.representation, id: created.body.representation.id } },
      {
        ...save.body,
        representation: { ...save.body.representation, contentKeyId: created.body.representation.contentKeyId },
      },
      { ...save.body, representation: { ...save.body.representation, id: crypto.randomUUID() } },
      { ...save.body, representation: { ...save.body.representation, revision: 3 } },
      { ...save.body, representation: { ...save.body.representation, keyEpoch: 1 } },
      { ...save.body, expectedRevision: 0 },
      { ...save.body, expectedRevision: 1.5 },
      { ...save.body, expectedRevision: Number.MAX_SAFE_INTEGER },
      { ...save.body, expectedParentRevision: 0 },
      { ...save.body, expectedParentRevision: Number.MAX_SAFE_INTEGER },
      { ...save.body, keyEnvelope: "not+base64" },
      { ...save.body, keyEnvelope: wrongContext.body.keyEnvelope },
      {
        ...save.body,
        representation: { ...save.body.representation, ciphertext: wrongContext.body.representation.ciphertext },
      },
    ];
    for (const body of invalid) {
      const response = await request(f, path, "PATCH", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await (await request(f, path, "POST")).json()).toEqual(before);
    }
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM file_representations WHERE file_node_id = ?")
        .bind(created.body.nodeId)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare("SELECT entries_revision FROM directories WHERE node_id = ?").bind(f.rootId).first(),
    ).toEqual({ entries_revision: 2 });
  });

  it("lets exactly one simultaneous save win without retaining the losing ciphertext", async () => {
    const f = await fixture();
    const created = await fileRequest(f, "race.md");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created.body)).status).toBe(
      201,
    );
    const path = `/api/private/tree/files/${created.body.nodeId}`;
    const first = await saveRequest(f, created.body.nodeId, "one");
    const second = await saveRequest(f, created.body.nodeId, "two");
    const responses = await Promise.all([
      request(f, path, "PATCH", first.body),
      request(f, path, "PATCH", second.body),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await responses.find((r) => r.status === 409)!.json()).toEqual({ error: "file_changed" });
    const winner = responses[0]!.status === 200 ? first : second;
    expect(await (await request(f, path, "POST")).json()).toMatchObject({
      revision: 2,
      representationId: winner.body.representation.id,
      keyEnvelope: winner.body.keyEnvelope,
    });
    expect(
      await env.DB.prepare("SELECT id FROM file_representations WHERE file_node_id = ?")
        .bind(created.body.nodeId)
        .all()
        .then((r) => r.results),
    ).toEqual([{ id: winner.body.representation.id }]);
    expect(
      await env.DB.prepare("SELECT entries_revision FROM directories WHERE node_id = ?").bind(f.rootId).first(),
    ).toEqual({ entries_revision: 3 });
  });

  it("distinguishes stale File drafts from parent changes and retries only the namespace", async () => {
    const f = await fixture();
    const created = await fileRequest(f, "edit.md");
    const root = `/api/private/tree/directories/${f.rootId}`;
    expect((await request(f, `${root}/children`, "PUT", created.body)).status).toBe(201);
    const path = `/api/private/tree/files/${created.body.nodeId}`;
    const save = await saveRequest(f, created.body.nodeId);
    const before = await (await request(f, path, "POST")).json();
    expect((await request(f, `${root}/children`, "PUT", await directoryRequest(f, "sibling", id(), 2))).status).toBe(
      201,
    );
    const staleParent = await request(f, path, "PATCH", save.body);
    expect(staleParent.status).toBe(409);
    expect(await staleParent.json()).toEqual({ error: "namespace_changed" });
    expect(await (await request(f, path, "POST")).json()).toEqual(before);
    expect((await request(f, path, "PATCH", { ...save.body, expectedParentRevision: 3 })).status).toBe(200);
    const after = await (await request(f, path, "POST")).json();
    const staleFile = await request(f, path, "PATCH", { ...save.body, expectedParentRevision: 4 });
    expect(staleFile.status).toBe(409);
    expect(await staleFile.json()).toEqual({ error: "file_changed" });
    expect(await (await request(f, path, "POST")).json()).toEqual(after);
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM file_representations WHERE file_node_id = ?")
        .bind(created.body.nodeId)
        .first(),
    ).toEqual({ count: 1 });
  });
  it("saves a fresh File key and reads the replacement through an authenticated parent listing", async () => {
    const f = await fixture();
    const created = await fileRequest(f, "edit.md");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created.body)).status).toBe(
      201,
    );
    const path = `/api/private/tree/files/${created.body.nodeId}`;
    const save = await saveRequest(f, created.body.nodeId);
    const response = await request(f, path, "PATCH", save.body);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ revision: 2, entriesRevision: 3 });
    const read = (await (await request(f, path, "POST")).json()) as {
      revision: number;
      representationId: string;
      contentKeyId: string;
      keyEpoch: number;
      keyEnvelope: string;
      ciphertext: string;
    };
    expect(read).toMatchObject({
      revision: 2,
      representationId: save.body.representation.id,
      contentKeyId: save.body.representation.contentKeyId,
      keyEpoch: 2,
    });
    const key = await openSymmetric(decodeBytes(read.keyEnvelope), f.rootKey, { context: save.file.keyContext });
    expect(key).not.toEqual(created.file.fileContentKey);
    expect(
      decodeFileRepresentation(
        await openSymmetric(decodeBytes(read.ciphertext), key, { context: save.file.contentContext }),
      ).markdown,
    ).toBe("# saved");
    const listing = (await (await request(f, `/api/private/tree/directories/${f.rootId}`, "POST")).json()) as {
      entriesRevision: number;
      entries: SealedEntry[];
      listingHead: Omit<StoredListingHead, "signerPublicKey"> & { signerPublicKey: string };
    };
    expect(listing.entriesRevision).toBe(3);
    await expect(
      openListingHead(f.rootKey, {
        vaultId: f.accountId,
        directoryId: f.rootId,
        revision: 3,
        entries: listing.entries,
        head: { ...listing.listingHead, signerPublicKey: decodeBytes(listing.listingHead.signerPublicKey) },
      }),
    ).resolves.toBeUndefined();
    expect(
      await env.DB.prepare("SELECT id FROM file_representations WHERE file_node_id = ?")
        .bind(created.body.nodeId)
        .all()
        .then((r) => r.results),
    ).toEqual([{ id: save.body.representation.id }]);
    await expectAgreedEdges(f);
  });
  it("keeps the signup recovery-confirmation gate ahead of any content-creating request", async () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => "pending" } });
    try {
      await expect(
        createTreeChild(
          {
            vaultId: id(),
            actorAccountId: id(),
            rootId: id(),
            rootKey: generateDirectoryCapabilityKey(),
            actorVaultRootKey: generateDirectoryCapabilityKey(),
          },
          id(),
          { nodeId: id(), kind: "file", expectedRevision: 1, nameCiphertext: "", orderCiphertext: "", keyEnvelope: "" },
          { directoryId: id(), entriesRevision: 1, entries: [] },
          generateDirectoryCapabilityKey(),
        ),
      ).rejects.toBeInstanceOf(RecoveryConfirmationPendingError);
      await expect(
        renameTreeChild(
          {
            vaultId: id(),
            actorAccountId: id(),
            rootId: id(),
            rootKey: generateDirectoryCapabilityKey(),
            actorVaultRootKey: generateDirectoryCapabilityKey(),
          },
          id(),
          id(),
          { expectedRevision: 1, nameCiphertext: "", orderCiphertext: "" },
          { directoryId: id(), entriesRevision: 1, entries: [] },
          generateDirectoryCapabilityKey(),
        ),
      ).rejects.toBeInstanceOf(RecoveryConfirmationPendingError);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("creates an encrypted child under the hidden root and lists it with a device proof", async () => {
    const f = await fixture();
    const created = await directoryRequest(f, "Amélie");
    const response = await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created);
    expect(response.status, await response.clone().text()).toBe(201);
    await expectAgreedEdges(f);
    const listing = await request(f, `/api/private/tree/directories/${f.rootId}`, "POST");
    expect(listing.status).toBe(200);
    const result = (await listing.json()) as {
      entriesRevision: number;
      entries: Array<{ nodeId: string; nameCiphertext: string }>;
    };
    expect(result.entriesRevision).toBe(2);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.nodeId).toBe(created.nodeId);
    expect(result).toHaveProperty("listingHead.signerDeviceId", f.deviceId);
    expect(
      new TextDecoder().decode(
        await openSymmetric(decodeBytes(result.entries[0]!.nameCiphertext), f.rootKey, {
          context: {
            purpose: "directory-metadata",
            vaultId: f.accountId,
            objectId: created.nodeId,
            keyId: f.rootId,
            keyEpoch: 1,
            revision: 1,
          },
        }),
      ),
    ).toBe("Amélie");
    const agreement = await env.DB.prepare(`SELECT n.parent_node_id AS parent, e.parent_node_id AS edge_parent
      FROM vault_nodes n JOIN directory_entries e ON e.child_node_id = n.id WHERE n.id = ?`)
      .bind(created.nodeId)
      .first<{ parent: string; edge_parent: string }>();
    expect(agreement).toEqual({ parent: f.rootId, edge_parent: f.rootId });
  });

  it("refuses altered entries against the authenticated listing head", async () => {
    const f = await fixture();
    const created = await directoryRequest(f, "Private heading");
    const route = `/api/private/tree/directories/${f.rootId}`;
    expect((await request(f, `${route}/children`, "PUT", created)).status).toBe(201);
    const result = (await (await request(f, route, "POST")).json()) as {
      entriesRevision: number;
      entries: SealedEntry[];
      listingHead: Omit<StoredListingHead, "signerPublicKey"> & { signerPublicKey: string };
    };
    const options = {
      vaultId: f.accountId,
      directoryId: f.rootId,
      revision: result.entriesRevision,
      entries: result.entries,
      head: { ...result.listingHead, signerPublicKey: decodeBytes(result.listingHead.signerPublicKey) },
    };
    await expect(openListingHead(f.rootKey, options)).resolves.toBeUndefined();
    await env.DB.prepare("UPDATE directory_entries SET name_ciphertext = X'01' WHERE child_node_id = ?")
      .bind(created.nodeId)
      .run();
    const forged = (await (await request(f, route, "POST")).json()) as { entries: SealedEntry[] };
    await expect(openListingHead(f.rootKey, { ...options, entries: forged.entries })).rejects.toMatchObject({
      code: "replayed-manifest",
    });
    await expect(
      env.DB.prepare("UPDATE directories SET listing_digest = zeroblob(32) WHERE node_id = ?").bind(f.rootId).run(),
    ).rejects.toThrow();
  });

  it("runs Unicode 17 namespace collision fixtures before the real create path", async () => {
    const f = await fixture();
    const path = `/api/private/tree/directories/${f.rootId}/children`;
    const first = await prepareTreeCreate({
      vaultId: f.accountId,
      parentId: f.rootId,
      parentKey: f.rootKey,
      entriesRevision: 1,
      existingNames: [],
      requestedName: "Amélie",
      kind: "directory",
    });
    expect(JSON.stringify(first)).not.toContain("Amélie");
    expect(JSON.stringify(first)).not.toContain("616dc3a96c6965");
    expect((await request(f, path, "PUT", first)).status).toBe(201);
    await expectAgreedEdges(f);
    for (const duplicate of ["Ame\u0301lie", "AMÉLIE"]) {
      await expect(
        prepareTreeCreate({
          vaultId: f.accountId,
          parentId: f.rootId,
          parentKey: f.rootKey,
          entriesRevision: 2,
          existingNames: ["Amélie"],
          requestedName: duplicate,
          kind: "file",
        }),
      ).rejects.toBeInstanceOf(NameConflictError);
    }
    const second = await prepareTreeCreate({
      vaultId: f.accountId,
      parentId: f.rootId,
      parentKey: f.rootKey,
      entriesRevision: 2,
      existingNames: ["Amélie"],
      requestedName: "Straße",
      kind: "directory",
    });
    expect((await request(f, path, "PUT", second)).status).toBe(201);
    await expectAgreedEdges(f);
    await expect(
      prepareTreeCreate({
        vaultId: f.accountId,
        parentId: f.rootId,
        parentKey: f.rootKey,
        entriesRevision: 3,
        existingNames: ["Amélie", "Straße"],
        requestedName: "STRASSE",
        kind: "directory",
      }),
    ).rejects.toBeInstanceOf(NameConflictError);
    const third = await prepareTreeCreate({
      vaultId: f.accountId,
      parentId: f.rootId,
      parentKey: f.rootKey,
      entriesRevision: 3,
      existingNames: ["Amélie", "Straße"],
      requestedName: "Ａ",
      kind: "directory",
    });
    expect((await request(f, path, "PUT", third)).status).toBe(201);
    await expectAgreedEdges(f);
    const fourth = await prepareTreeCreate({
      vaultId: f.accountId,
      parentId: f.rootId,
      parentKey: f.rootKey,
      entriesRevision: 4,
      existingNames: ["Amélie", "Straße", "Ａ"],
      requestedName: "A",
      kind: "file",
    });
    expect((await request(f, path, "PUT", fourth)).status).toBe(201);
    await expectAgreedEdges(f);
    let revision = 5;
    const names = ["Amélie", "Straße", "Ａ", "A"];
    for (const name of ["Σ", "I", "İ"]) {
      const payload = await prepareTreeCreate({
        vaultId: f.accountId,
        parentId: f.rootId,
        parentKey: f.rootKey,
        entriesRevision: revision,
        existingNames: names,
        requestedName: name,
        kind: "directory",
      });
      expect((await request(f, path, "PUT", payload)).status).toBe(201);
      await expectAgreedEdges(f);
      names.push(name);
      revision++;
    }
    for (const duplicate of ["ς", "σ", "i"]) {
      await expect(
        prepareTreeCreate({
          vaultId: f.accountId,
          parentId: f.rootId,
          parentKey: f.rootKey,
          entriesRevision: revision,
          existingNames: names,
          requestedName: duplicate,
          kind: "directory",
        }),
      ).rejects.toBeInstanceOf(NameConflictError);
    }
    const listingResponse = await request(f, `/api/private/tree/directories/${f.rootId}`, "POST");
    expect(await listingResponse.clone().text()).not.toContain("Amélie");
    const listing = (await listingResponse.json()) as {
      entriesRevision: number;
      entries: unknown[];
    };
    expect(listing.entriesRevision).toBe(8);
    expect(listing.entries).toHaveLength(7);
  });

  it("runs namespace-v1 segment boundary vectors through real browser preparation and create", async () => {
    const f = await fixture();
    let revision = 1;
    const names: string[] = [];
    const path = `/api/private/tree/directories/${f.rootId}/children`;
    for (const requestedName of [
      "two words",
      "e\u0301",
      "🙂",
      "emoji\uFE0F",
      "क\u200Dष",
      "\u0378",
      "é".repeat(127) + "a",
      "e\u0301".repeat(127) + "b",
    ]) {
      const payload = await prepareTreeCreate({
        vaultId: f.accountId,
        parentId: f.rootId,
        parentKey: f.rootKey,
        entriesRevision: revision,
        existingNames: names,
        requestedName,
        kind: "directory",
      });
      expect(JSON.stringify(payload)).not.toContain(requestedName);
      expect((await request(f, path, "PUT", payload)).status).toBe(201);
      names.push(canonicalizeSegment(requestedName).display);
      revision++;
      await expectAgreedEdges(f);
    }
    for (const requestedName of [
      "",
      ".",
      "..",
      "a\u0000b",
      "a/b",
      "a\\b",
      "trailing ",
      "trailing.",
      "CON",
      "con.txt",
      "a\u202Eb",
      "\uD800",
      "\uDC00",
      "a".repeat(256),
      "é".repeat(128),
    ]) {
      await expect(
        prepareTreeCreate({
          vaultId: f.accountId,
          parentId: f.rootId,
          parentKey: f.rootKey,
          entriesRevision: revision,
          existingNames: names,
          requestedName,
          kind: "file",
        }),
      ).rejects.toBeInstanceOf(NamespaceError);
    }
    expect(
      (
        (await (await request(f, `/api/private/tree/directories/${f.rootId}`, "POST")).json()) as {
          entries: unknown[];
        }
      ).entries,
    ).toHaveLength(names.length);
  });

  it("stores exactly one current File representation and returns only encrypted private material", async () => {
    const f = await fixture();
    const created = await fileRequest(f, "secret.md");
    const response = await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created.body);
    expect(response.status, await response.clone().text()).toBe(201);
    await expectAgreedEdges(f);
    const read = await request(f, `/api/private/tree/files/${created.body.nodeId}`, "POST");
    expect(read.status).toBe(200);
    const data = (await read.json()) as { revision: number; ciphertext: string; representationId: string };
    expect(data.revision).toBe(1);
    expect(data.representationId).toBe(created.body.representation.id);
    expect(
      decodeFileRepresentation(
        await openSymmetric(decodeBytes(data.ciphertext), created.file.fileContentKey, {
          context: created.file.contentContext,
        }),
      ).markdown,
    ).toBe("# private");
    const count = await env.DB.prepare(`SELECT count(*) AS count FROM file_representations WHERE file_node_id = ?`)
      .bind(created.body.nodeId)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
    await expect(
      env.DB.prepare("UPDATE file_representations SET ciphertext = X'01' WHERE id = ?")
        .bind(created.body.representation.id)
        .run(),
    ).rejects.toThrow();
    expect(await request(f, `/api/private/tree/files/${id()}`, "POST").then((r) => r.status)).toBe(404);
  });

  it("renames only after its parent's revision wins, without changing the node edge or File content", async () => {
    const f = await fixture();
    const created = await directoryRequest(f, "before");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created)).status).toBe(201);
    const context = {
      purpose: "directory-metadata" as const,
      vaultId: f.accountId,
      objectId: created.nodeId,
      keyId: f.rootId,
      keyEpoch: 1,
      revision: 1,
    };
    const rename = await prepareTreeRename({
      vaultId: f.accountId,
      parentId: f.rootId,
      parentKey: f.rootKey,
      nodeId: created.nodeId,
      entriesRevision: 2,
      existingNames: [],
      requestedName: "after",
      order: "first",
    });
    const path = `/api/private/tree/nodes/${created.nodeId}/name`;
    expect((await request(f, path, "PATCH", rename)).status).toBe(200);
    await expectAgreedEdges(f);
    const stale = await request(f, path, "PATCH", rename);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "namespace_changed" });
    const listing = (await (await request(f, `/api/private/tree/directories/${f.rootId}`, "POST")).json()) as {
      entriesRevision: number;
      entries: Array<{ nameCiphertext: string }>;
    };
    expect(listing.entriesRevision).toBe(3);
    expect(
      new TextDecoder().decode(
        await openSymmetric(decodeBytes(listing.entries[0]!.nameCiphertext), f.rootKey, { context }),
      ),
    ).toBe("after");
  });

  it("resolves opaque ancestor IDs for an owned File without disclosing another Account's path", async () => {
    const f = await fixture();
    const folder = await directoryRequest(f, "Folder");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", folder)).status).toBe(201);
    await expectAgreedEdges(f);
    const childKey = await openSymmetric(decodeBytes(folder.keyEnvelope), f.rootKey, {
      context: {
        purpose: "directory-capability",
        vaultId: f.accountId,
        objectId: folder.nodeId,
        keyId: folder.nodeId,
        keyEpoch: 1,
        revision: 1,
      },
    });
    const nested = await prepareTreeCreate({
      vaultId: f.accountId,
      parentId: folder.nodeId,
      parentKey: childKey,
      entriesRevision: 1,
      existingNames: [],
      requestedName: "nested.md",
      kind: "file",
    });
    expect((await request(f, `/api/private/tree/directories/${folder.nodeId}/children`, "PUT", nested)).status).toBe(
      201,
    );
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
    expect(
      await env.DB.prepare("SELECT node_id, entries_revision FROM directories WHERE node_id = ?")
        .bind(f.rootId)
        .first(),
    ).toEqual({ node_id: f.rootId, entries_revision: 1 });
    await expect(
      env.DB.prepare(
        "INSERT INTO vault_nodes (id, kind, owner_id, created_at, updated_at) VALUES (?, 'directory', ?, 1, 1)",
      )
        .bind(id(), f.accountId)
        .run(),
    ).rejects.toThrow();
    await expect(env.DB.prepare("DELETE FROM directories WHERE node_id = ?").bind(f.rootId).run()).rejects.toThrow();
    const folder = await directoryRequest(f, "Folder");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", folder)).status).toBe(201);
    await expect(
      env.DB.prepare("UPDATE vault_nodes SET parent_node_id = ? WHERE id = ?").bind(folder.nodeId, f.rootId).run(),
    ).rejects.toThrow();
    const created = await fileRequest(f, "file.md", id(), 2);
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", created.body)).status).toBe(
      201,
    );
    expect(
      await env.DB.prepare(`SELECT f.current_revision AS revision, r.id AS representation_id
      FROM files f JOIN file_representations r ON r.id = f.current_representation_id
      AND r.revision = f.current_revision AND r.file_node_id = f.node_id
      WHERE f.node_id = ?`)
        .bind(created.body.nodeId)
        .first(),
    ).toEqual({
      revision: 1,
      representation_id: created.body.representation.id,
    });
  });

  it("refuses a cycle formed by two new Directory nodes in one deferred-FK transaction", async () => {
    const f = await fixture();
    const a = id(),
      b = id();
    const node = (nodeId: string, parentId: string) =>
      env.DB.prepare(`INSERT INTO vault_nodes
      (id, kind, owner_id, parent_node_id, created_at, updated_at)
      VALUES (?, 'directory', ?, ?, 1, 1)`).bind(nodeId, f.accountId, parentId);
    const directory = (nodeId: string) =>
      env.DB.prepare(`INSERT INTO directories
      (node_id, owner_id, entries_revision) VALUES (?, ?, 1)`).bind(nodeId, f.accountId);
    const edge = (childId: string, parentId: string) =>
      env.DB.prepare(`INSERT INTO directory_entries
      (child_node_id, owner_id, parent_node_id, name_ciphertext, order_ciphertext, key_envelope)
      VALUES (?, ?, ?, X'01', X'01', X'01')`).bind(childId, f.accountId, parentId);
    await expect(
      env.DB.batch([node(a, b), node(b, a), directory(a), directory(b), edge(a, b), edge(b, a)]),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM vault_nodes WHERE id IN (?, ?)")
        .bind(a, b)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("keeps authenticated private names and ciphertext out of document HTML", async () => {
    const f = await fixture();
    const folder = await directoryRequest(f, "Private heading");
    expect((await request(f, `/api/private/tree/directories/${f.rootId}/children`, "PUT", folder)).status).toBe(201);
    for (const path of ["/files", `/d/${folder.nodeId}`, `/f/${folder.nodeId}`]) {
      const document = await SELF.fetch(`https://mdwn.test${path}`, { headers: { cookie: f.session.cookie } });
      expect(document.status).toBe(200);
      const html = await document.text();
      expect(html).toContain("Opening your library");
      expect(html).not.toContain("Private heading");
      expect(html).not.toContain(folder.nameCiphertext);
    }
  });

  it("requires a live bound device proof for every tree read or mutation and rejects replay", async () => {
    const f = await fixture();
    const path = `/api/private/tree/directories/${f.rootId}`;
    const missing = await SELF.fetch(`https://mdwn.test${path}`, {
      method: "POST",
      headers: {
        cookie: f.session.cookie,
        origin: "https://mdwn.test",
      },
    });
    expect(missing.status).toBe(403);
    const readProof = await signDeviceProof(f.assertion.privateKey, {
      sessionBinding: await sessionBindingDigest(f.session.id),
      deviceId: f.deviceId,
      registryEpoch: 1,
      method: "POST",
      url: `https://mdwn.test${path}`,
    });
    const read = () =>
      SELF.fetch(`https://mdwn.test${path}`, {
        method: "POST",
        headers: {
          cookie: f.session.cookie,
          origin: "https://mdwn.test",
          "X-Mdwn-Device-Proof": JSON.stringify(readProof),
        },
      });
    expect((await read()).status).toBe(200);
    expect((await read()).status).toBe(200);
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM device_proof_uses WHERE account_id = ?")
        .bind(f.accountId)
        .first(),
    ).toEqual({ count: 0 });
    const created = await directoryRequest(f, "private");
    const createPath = `${path}/children`;
    const body = JSON.stringify(await signedRequest(f, createPath, "PUT", created));
    const proof = await signDeviceProof(f.assertion.privateKey, {
      sessionBinding: await sessionBindingDigest(f.session.id),
      deviceId: f.deviceId,
      registryEpoch: 1,
      method: "PUT",
      url: `https://mdwn.test${createPath}`,
      body,
    });
    const send = () =>
      SELF.fetch(`https://mdwn.test${createPath}`, {
        method: "PUT",
        body,
        headers: {
          cookie: f.session.cookie,
          origin: "https://mdwn.test",
          "content-type": "application/json",
          "X-Mdwn-Device-Proof": JSON.stringify(proof),
        },
      });
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(409);
    const unprovisioned = await fixture();
    await env.DB.prepare("UPDATE sessions SET device_id = NULL WHERE id = ?").bind(unprovisioned.session.id).run();
    expect((await request(unprovisioned, `/api/private/tree/directories/${unprovisioned.rootId}`, "POST")).status).toBe(
      403,
    );
    expect(
      (
        await request(
          unprovisioned,
          `/api/private/tree/directories/${unprovisioned.rootId}/children`,
          "PUT",
          await directoryRequest(unprovisioned, "denied"),
        )
      ).status,
    ).toBe(403);
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
    const listing = (await (await request(f, `/api/private/tree/directories/${f.rootId}`, "POST")).json()) as {
      entriesRevision: number;
      entries: Array<{ nodeId: string }>;
    };
    expect(listing.entriesRevision).toBe(2);
    expect(listing.entries).toHaveLength(1);
    const count = await env.DB.prepare(`SELECT count(*) AS nodes FROM vault_nodes WHERE owner_id = ?`)
      .bind(f.accountId)
      .first<{ nodes: number }>();
    expect(count?.nodes).toBe(2);
  });
});
