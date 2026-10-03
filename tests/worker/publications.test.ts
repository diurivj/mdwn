import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createSymmetricWriter } from "../../app/crypto/enc-v1";
import { createFileRepresentation } from "../../app/crypto/vault";
import {
  createPublicationKeyPair, formatPublicationFragment, importPublicationKeyPair, newPublicationIdentifier,
} from "../../app/publications/capability";
import {
  openAuthorDeclaration, openPublicRepresentation, publicPresentation, sealAuthorDeclaration, sealPublicRepresentation,
} from "../../app/publications/content";
import { createFileHead } from "../../app/tree/file-head";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/tree/wire";
import {
  deletePayload, grant, opaqueId, sharingAccount, sharingRequest, treeChild, type SharingAccount,
} from "./sharing-fixtures";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

type FileView = { revision: number; representationId: string; keyEpoch: number; ciphertext: string;
  capability: { id: string; epoch: number } | null; keyEnvelope?: string; representationKeyEnvelope?: string;
  publication?: { publicationId: string; linkId: string; publicKey: string; revision?: number;
    declaration: { declarationId: string; revision: number; current: boolean } | null } };

async function fileView(actor: SharingAccount, fileId: string): Promise<FileView> {
  const response = await sharingRequest(actor, `/api/private/tree/files/${fileId}`);
  if (!response.ok) throw new Error(`file read failed: ${response.status}`);
  return response.json() as Promise<FileView>;
}

type Published = { publicationId: string; linkId: string; keys: Awaited<ReturnType<typeof createPublicationKeyPair>>;
  fragment: string; declarationId: string };

/** The Owner's browser half of publishing: every secret stays in this object. */
async function publishBody(owner: SharingAccount, fileId: string, options: {
  markdown?: string; pseudonym?: string; revision?: number; representationId?: string;
} = {}) {
  const current = await fileView(owner, fileId);
  const keys = await createPublicationKeyPair();
  const publicationId = newPublicationIdentifier(), linkId = newPublicationIdentifier(), declarationId = newPublicationIdentifier();
  const binding = { publicationId, linkId, publicKey: keys.publicKey };
  const ciphertext = await sealPublicRepresentation({ ...binding, revision: 1 },
    publicPresentation(options.markdown ?? "---\ntitle: Diet plan\nprivate: never public\n---\n# private"));
  const author = options.pseudonym ? { declarationId, ciphertext: encodeTreeBytes(await sealAuthorDeclaration(
    { ...binding, declarationId, revision: 1 }, options.pseudonym)) } : null;
  const body = { publicationId, linkId, publicKey: encodeTreeBytes(keys.publicKey),
    expectedRevision: options.revision ?? current.revision,
    expectedRepresentationId: options.representationId ?? current.representationId,
    representation: { ciphertext: encodeTreeBytes(ciphertext) }, author };
  const published: Published = { publicationId, linkId, keys, fragment: formatPublicationFragment(keys.privateKey), declarationId };
  return { body, published };
}

async function publish(owner: SharingAccount, fileId: string, options: Parameters<typeof publishBody>[2] = {}) {
  const { body, published } = await publishBody(owner, fileId, options);
  const response = await sharingRequest(owner, `/api/private/publications/files/${fileId}`, "PUT", body);
  if (response.status !== 201) throw new Error(`publish failed: ${response.status} ${await response.text()}`);
  return published;
}

/** Any authorized editor's browser: private and Public representations from one draft. */
async function pairedSave(actor: SharingAccount, ownerId: string, fileId: string, markdown: string,
  publication: "auto" | "omit" | ((current: NonNullable<FileView["publication"]>) => Promise<object>) = "auto") {
  const current = await fileView(actor, fileId);
  const key = actor.keys.get(fileId)!, capability = current.capability!;
  const id = opaqueId(), contentKeyId = opaqueId(), keyEpoch = current.keyEpoch + 1, revision = current.revision + 1;
  const file = await createFileRepresentation(key, { markdown, metadata: new Uint8Array() },
    { vaultId: ownerId, fileId, keyId: contentKeyId, keyEpoch, revision });
  const ciphertext = encodeTreeBytes(file.contentEnvelope), keyEnvelope = encodeTreeBytes(file.fileContentKeyEnvelope);
  const fileHead = await createFileHead(actor.assertion.privateKey, { vaultId: ownerId, fileId,
    capabilityId: capability.id, capabilityEpoch: capability.epoch, representationId: id,
    contentKeyId, keyEpoch, revision, deviceId: actor.deviceId, ciphertext, keyEnvelope });
  let paired: object | undefined;
  if (current.publication && publication !== "omit") {
    paired = publication === "auto" ? {
      publicationId: current.publication.publicationId, linkId: current.publication.linkId,
      revision: current.publication.revision! + 1,
      ciphertext: encodeTreeBytes(await sealPublicRepresentation({ publicationId: current.publication.publicationId,
        linkId: current.publication.linkId, publicKey: decodeTreeBytes(current.publication.publicKey, 65),
        revision: current.publication.revision! + 1 }, publicPresentation(markdown))),
    } : await publication(current.publication);
  }
  return { expectedRevision: current.revision, expectedRepresentationId: current.representationId, capability,
    representation: { id, contentKeyId, keyEpoch, revision, ciphertext, keyEnvelope, fileHead },
    ...(paired ? { publication: paired } : {}) };
}

/** Over-bound test bytes: the production encoder deliberately refuses them. */
function oversized(length: number): string {
  let binary = "";
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readPublic(linkId: string, init: RequestInit = {}) {
  return SELF.fetch(`https://mdwn.test/api/public/publications/${linkId}`, init);
}

async function openPublic(published: Published) {
  const response = await readPublic(published.linkId);
  expect(response.status).toBe(200);
  const body = await response.json() as { publicationId: string; linkId: string; publicKey: string;
    representation: { revision: number; ciphertext: string };
    authors: { declarationId: string; revision: number; ciphertext: string }[] };
  const publicKey = decodeTreeBytes(body.publicKey, 65);
  expect(publicKey).toEqual(published.keys.publicKey);
  const pair = await importPublicationKeyPair(published.keys.privateKey, publicKey);
  const binding = { publicationId: body.publicationId, linkId: published.linkId, publicKey };
  return { body, presentation: await openPublicRepresentation(decodeTreeBytes(body.representation.ciphertext, 524_288), pair,
    { ...binding, revision: body.representation.revision }),
  authors: await Promise.all(body.authors.map((author) => openAuthorDeclaration(decodeTreeBytes(author.ciphertext, 4096), pair,
    { ...binding, declarationId: author.declarationId, revision: author.revision }))) };
}

async function count(table: string, where = "1", ...values: unknown[]) {
  return (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).bind(...values).first<{ n: number }>())!.n;
}

async function publicationRows(fileId: string) {
  return env.DB.prepare(`SELECT p.id, p.state, p.current_link_id, l.public_key, r.revision, r.file_revision
    FROM publications p LEFT JOIN publication_links l ON l.id = p.current_link_id
    LEFT JOIN public_representations r ON r.id = p.current_representation_id WHERE p.file_id = ?`).bind(fileId)
    .all<{ id: string; state: string; current_link_id: string; public_key: ArrayBuffer; revision: number; file_revision: number }>();
}

describe("creating a Publication", () => {
  it("publishes the exact saved representation, satisfies requests and stores only opaque public material", async () => {
    const owner = await sharingAccount(), collaborator = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    await grant(owner, collaborator, fileId, "read_only");
    expect((await sharingRequest(collaborator, `/api/private/publications/files/${fileId}/requests`, "POST", {})).status).toBe(201);
    const { body, published } = await publishBody(owner, fileId);
    const response = await sharingRequest(owner, `/api/private/publications/files/${fileId}`, "PUT", body);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ publicationId: published.publicationId, linkId: published.linkId, revision: 1 });
    const rows = (await publicationRows(fileId)).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: published.publicationId, state: "active", current_link_id: published.linkId,
      revision: 1, file_revision: 1 });
    expect(new Uint8Array(rows[0]!.public_key)).toEqual(published.keys.publicKey);
    // Approval is publishing: the pending request is gone.
    expect(await count("publication_requests", "file_id = ?", fileId)).toBe(0);
    const opened = await openPublic(published);
    // Raw front matter never reaches a Public reader; only its title does.
    expect(opened.presentation).toEqual({ title: "Diet plan", markdown: "# private" });
    expect(opened.authors).toEqual([]);
    // The Owner's File response gives the editor-side key, never a fragment.
    expect((await fileView(owner, fileId)).publication).toEqual({ publicationId: published.publicationId,
      linkId: published.linkId, publicKey: encodeTreeBytes(published.keys.publicKey), revision: 1, declaration: null });
  });

  it("lets only the File Owner publish a current, converted File exactly once", async () => {
    const owner = await sharingAccount(), editor = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    await grant(owner, editor, fileId, "read_write");
    const collaboratorAttempt = await publishBody(editor, fileId);
    expect((await sharingRequest(editor, `/api/private/publications/files/${fileId}`, "PUT", collaboratorAttempt.body)).status).toBe(404);
    const stale = await publishBody(owner, fileId, { revision: 7 });
    const staleResponse = await sharingRequest(owner, `/api/private/publications/files/${fileId}`, "PUT", stale.body);
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toEqual({ error: "file_changed" });
    expect(await count("publications", "file_id = ?", fileId)).toBe(0);
    await publish(owner, fileId);
    const again = await sharingRequest(owner, `/api/private/publications/files/${fileId}`, "PUT", (await publishBody(owner, fileId)).body);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "publication_exists" });
    const legacy = await treeChild(owner, owner.rootId, "file");
    const legacyResponse = await sharingRequest(owner, `/api/private/publications/files/${legacy}`, "PUT",
      (await publishBody(owner, legacy)).body);
    expect(legacyResponse.status).toBe(409);
    expect(await legacyResponse.json()).toEqual({ error: "file_capability_required" });
    expect(await count("publications", "file_id IN (?, ?)", fileId, legacy)).toBe(1);
  });

  it("rejects crossed, symmetric, oversized or mis-bound public material before creating anything", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const { body } = await publishBody(owner, fileId);
    const other = await publishBody(owner, fileId);
    const symmetric = encodeTreeBytes(await (await createSymmetricWriter(new Uint8Array(32).fill(3))).seal(new Uint8Array(8), {
      purpose: "public-representation", vaultId: body.publicationId, objectId: body.publicationId, keyId: body.linkId,
      keyEpoch: 1, revision: 1, publicationId: body.publicationId }));
    for (const invalid of [
      { ...body, representation: other.body.representation },
      { ...body, representation: { ciphertext: symmetric } },
      { ...body, representation: { ciphertext: oversized(524_289) } },
      { ...body, publicKey: encodeTreeBytes(new Uint8Array(65).fill(4)) },
      { ...body, linkId: body.publicationId },
      { ...body, linkId: opaqueId() },
      { ...body, author: { declarationId: body.linkId, ciphertext: "AQ" } },
      { ...body, extra: true },
    ]) {
      const response = await sharingRequest(owner, `/api/private/publications/files/${fileId}`, "PUT", invalid);
      expect(response.status, JSON.stringify(Object.keys(invalid))).toBe(400);
    }
    expect(await count("publications", "file_id = ?", fileId)).toBe(0);
    expect(await count("publication_links", "id = ?", body.linkId)).toBe(0);
  });

  it("enforces one active-or-deleting Publication per File and an irreversible seal in storage", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const published = await publish(owner, fileId);
    const now = Date.now(), second = newPublicationIdentifier(), link = newPublicationIdentifier(), representation = opaqueId();
    await expect(env.DB.batch([
      env.DB.prepare(`INSERT INTO publications (id, file_id, owner_id, state, current_link_id, current_representation_id,
        created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`).bind(second, fileId, owner.accountId, link, representation, now, now),
      env.DB.prepare("INSERT INTO publication_links (id, publication_id, public_key, created_at) VALUES (?, ?, ?, ?)")
        .bind(link, second, published.keys.publicKey, now),
      env.DB.prepare(`INSERT INTO public_representations (id, publication_id, link_id, revision, file_revision, ciphertext,
        ciphertext_size, created_at) VALUES (?, ?, ?, 1, 1, X'01', 1, ?)`).bind(representation, second, link, now),
    ])).rejects.toThrow();
    // The seal is irreversible even for a direct storage write.
    await env.DB.batch([
      env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
      env.DB.prepare("UPDATE publications SET state = 'deleting', current_link_id = NULL, current_representation_id = NULL WHERE id = ?")
        .bind(published.publicationId),
    ]);
    expect((await publicationRows(fileId)).results[0]!.state).toBe("deleting");
    await expect(env.DB.prepare(`UPDATE publications SET state = 'active', current_link_id = ?,
      current_representation_id = (SELECT id FROM public_representations WHERE publication_id = ?) WHERE id = ?`)
      .bind(published.linkId, published.publicationId, published.publicationId).run()).rejects.toThrow();
    // A deleting Publication still occupies the File: no new Publication until teardown completes.
    const blocked = await sharingRequest(owner, `/api/private/publications/files/${fileId}`, "PUT", (await publishBody(owner, fileId)).body);
    expect(blocked.status).toBe(409);
  });

  it("applies the five-per-day Publication create limit per Account", async () => {
    const owner = await sharingAccount();
    for (let index = 0; index < 5; index++) await publish(owner, await treeChild(owner, owner.rootId, "file", owner.accountId, true));
    const sixth = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const response = await sharingRequest(owner, `/api/private/publications/files/${sixth}`, "PUT", (await publishBody(owner, sixth)).body);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await count("publications", "file_id = ?", sixth)).toBe(0);
  });
});

describe("the anonymous Public route", () => {
  async function notFoundShape(response: Response) {
    return { status: response.status, contentType: response.headers.get("content-type"),
      cacheControl: response.headers.get("cache-control"), robots: response.headers.get("x-robots-tag"),
      cookie: response.headers.get("set-cookie"), body: await response.text() };
  }

  it("returns the same ciphertext-free 404 for unknown, malformed, rotated and sealed paths", async () => {
    const owner = await sharingAccount();
    const rotatedFile = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const sealedFile = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const rotated = await publish(owner, rotatedFile), sealed = await publish(owner, sealedFile);
    // Rotation and unpublish arrive in ticket 25; simulate their routing outcomes at the storage boundary.
    const replacement = newPublicationIdentifier(), representation = opaqueId(), now = Date.now();
    await env.DB.batch([
      env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
      env.DB.prepare("DELETE FROM public_representations WHERE publication_id = ?").bind(rotated.publicationId),
      env.DB.prepare("DELETE FROM publication_links WHERE publication_id = ?").bind(rotated.publicationId),
      env.DB.prepare("INSERT INTO publication_links (id, publication_id, public_key, created_at) VALUES (?, ?, ?, ?)")
        .bind(replacement, rotated.publicationId, rotated.keys.publicKey, now),
      env.DB.prepare(`INSERT INTO public_representations (id, publication_id, link_id, revision, file_revision, ciphertext,
        ciphertext_size, created_at) VALUES (?, ?, ?, 2, 1, X'01', 1, ?)`).bind(representation, rotated.publicationId, replacement, now),
      env.DB.prepare("UPDATE publications SET current_link_id = ?, current_representation_id = ? WHERE id = ?")
        .bind(replacement, representation, rotated.publicationId),
      env.DB.prepare("UPDATE publications SET state = 'deleting', current_link_id = NULL, current_representation_id = NULL WHERE id = ?")
        .bind(sealed.publicationId),
      env.DB.prepare("DELETE FROM publication_links WHERE publication_id = ?").bind(sealed.publicationId),
    ]);
    const paths = [newPublicationIdentifier(), "not-a-path", rotated.linkId, sealed.linkId];
    const api = await Promise.all(paths.map(async (path) => notFoundShape(await readPublic(path))));
    const expected = { status: 404, contentType: "application/json", cacheControl: "no-store",
      robots: "noindex, nofollow, noarchive", cookie: null, body: JSON.stringify({ error: "not_found" }) };
    for (const shape of api) expect(shape).toEqual(expected);
    const documents = await Promise.all(paths.map(async (path) => {
      const response = await SELF.fetch(`https://mdwn.test/p/${path}`);
      // Only the per-request nonce and the requester's own path differ.
      const html = (await response.text()).replace(/nonce="[^"]+"/g, 'nonce=""').replaceAll(path, "PATH")
        .replace(/"version": "[^"]+"/g, '"version": ""');
      return { status: response.status, cookie: response.headers.get("set-cookie"), html };
    }));
    for (const document of documents) {
      expect(document.status).toBe(404);
      expect(document.cookie).toBeNull();
      expect(document.html).toBe(documents[0]!.html);
      expect(document.html).not.toMatch(/ciphertext|publicKey/);
    }
  });

  it("serves only the current Public representation, without cookies, Owner, File or private material", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const published = await publish(owner, fileId, { markdown: "# Shared plan" });
    const signedIn = await readPublic(published.linkId, { headers: { cookie: owner.session.cookie } });
    const anonymous = await readPublic(published.linkId);
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("set-cookie")).toBeNull();
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    expect(anonymous.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    const text = await anonymous.text();
    expect(await signedIn.text()).toBe(text);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["authors", "linkId", "publicKey", "publicationId", "representation"]);
    const privateRow = await env.DB.prepare(`SELECT r.ciphertext, r.key_envelope, e.key_envelope AS edge
      FROM file_representations r JOIN files f ON f.current_representation_id = r.id
      JOIN directory_entries e ON e.child_node_id = f.node_id WHERE f.node_id = ?`).bind(fileId)
      .first<{ ciphertext: ArrayBuffer; key_envelope: ArrayBuffer; edge: ArrayBuffer }>();
    for (const forbidden of [owner.accountId, fileId, owner.rootId, encodeTreeBytes(new Uint8Array(privateRow!.ciphertext)),
      encodeTreeBytes(new Uint8Array(privateRow!.key_envelope)), encodeTreeBytes(new Uint8Array(privateRow!.edge))]) {
      expect(text).not.toContain(forbidden);
    }
    expect((await openPublic(published)).presentation).toEqual({ title: null, markdown: "# Shared plan" });
    const page = await SELF.fetch(`https://mdwn.test/p/${published.linkId}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive"/>');
    expect(html).not.toContain(encodeTreeBytes(new Uint8Array(privateRow!.ciphertext)).slice(0, 64));
    expect(html).not.toContain((body.representation as { ciphertext: string }).ciphertext.slice(0, 64));
  });

  it("creates no public access for a pending Publication request", async () => {
    const owner = await sharingAccount(), collaborator = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    await grant(owner, collaborator, fileId, "read_write");
    const request = await sharingRequest(collaborator, `/api/private/publications/files/${fileId}/requests`, "POST", {});
    expect(request.status).toBe(201);
    expect(await count("publication_requests", "file_id = ?", fileId)).toBe(1);
    expect(await count("publications", "file_id = ?", fileId)).toBe(0);
    const state = await (await sharingRequest(collaborator, `/api/private/publications/files/${fileId}`)).json() as {
      publication: unknown; requests: { own: boolean }[] };
    expect(state.publication).toBeNull();
    expect(state.requests).toEqual([expect.objectContaining({ own: true })]);
    expect((await fileView(collaborator, fileId)).publication).toBeUndefined();
    // Nothing routable exists: a request has no path ID or key.
    expect((await readPublic(newPublicationIdentifier())).status).toBe(404);
  });
});

describe("paired saves", () => {
  it("lets the Owner and a read/write Collaborator advance both pointers under one File revision", async () => {
    const owner = await sharingAccount(), editor = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    await grant(owner, editor, fileId, "read_write");
    const published = await publish(owner, fileId);
    const ownerSave = await sharingRequest(owner, `/api/private/tree/files/${fileId}`, "PATCH",
      await pairedSave(owner, owner.accountId, fileId, "---\ntitle: Week two\n---\nOwner edit"));
    expect(ownerSave.status).toBe(200);
    expect(await ownerSave.json()).toMatchObject({ revision: 2, publicRevision: 2 });
    expect((await openPublic(published)).presentation).toEqual({ title: "Week two", markdown: "Owner edit" });
    // The editor never receives the fragment, only the stored public key.
    const editorView = await fileView(editor, fileId);
    expect(editorView.publication).toEqual({ publicationId: published.publicationId, linkId: published.linkId,
      publicKey: encodeTreeBytes(published.keys.publicKey), revision: 2, declaration: null });
    const editorSave = await sharingRequest(editor, `/api/private/tree/files/${fileId}`, "PATCH",
      await pairedSave(editor, owner.accountId, fileId, "Collaborator edit"));
    expect(editorSave.status).toBe(200);
    expect((await openPublic(published)).presentation).toEqual({ title: null, markdown: "Collaborator edit" });
    const row = (await publicationRows(fileId)).results[0]!;
    expect(row).toMatchObject({ revision: 3, file_revision: 3 });
    expect(await count("public_representations", "publication_id = ?", published.publicationId)).toBe(1);
    expect((await env.DB.prepare("SELECT current_revision FROM files WHERE node_id = ?").bind(fileId).first())).toEqual({ current_revision: 3 });
  });

  it("changes nothing when a save omits, misnames or misversions the active Publication", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const published = await publish(owner, fileId);
    const before = { file: await env.DB.prepare("SELECT current_revision, current_representation_id FROM files WHERE node_id = ?").bind(fileId).first(),
      publication: (await publicationRows(fileId)).results[0] };
    const variants: Parameters<typeof pairedSave>[4][] = [
      "omit",
      async (current) => ({ publicationId: newPublicationIdentifier(), linkId: current.linkId, revision: current.revision! + 1,
        ciphertext: encodeTreeBytes(new Uint8Array(32)) }),
      async (current) => ({ publicationId: current.publicationId, linkId: newPublicationIdentifier(), revision: current.revision! + 1,
        ciphertext: encodeTreeBytes(new Uint8Array(32)) }),
      async (current) => ({ publicationId: current.publicationId, linkId: current.linkId, revision: current.revision! + 2,
        ciphertext: encodeTreeBytes(new Uint8Array(32)) }),
    ];
    for (const variant of variants) {
      const response = await sharingRequest(owner, `/api/private/tree/files/${fileId}`, "PATCH",
        await pairedSave(owner, owner.accountId, fileId, "never saved", variant));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "publication_changed" });
    }
    expect(await env.DB.prepare("SELECT current_revision, current_representation_id FROM files WHERE node_id = ?").bind(fileId).first())
      .toEqual(before.file);
    expect((await publicationRows(fileId)).results[0]).toEqual(before.publication);
    expect((await openPublic(published)).presentation.markdown).toBe("# private");
  });

  it("rolls back the private save when the Public representation is malformed or oversized", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const published = await publish(owner, fileId);
    const other = await createPublicationKeyPair();
    const variants: Parameters<typeof pairedSave>[4][] = [
      async (current) => ({ publicationId: current.publicationId, linkId: current.linkId, revision: current.revision! + 1,
        ciphertext: oversized(524_289) }),
      async (current) => ({ publicationId: current.publicationId, linkId: current.linkId, revision: current.revision! + 1,
        // Encrypted to another key: its recipient binding no longer names the stored link key.
        ciphertext: encodeTreeBytes(await sealPublicRepresentation({ publicationId: current.publicationId, linkId: current.linkId,
          publicKey: other.publicKey, revision: current.revision! + 1 }, { title: null, markdown: "x" })) }),
      async (current) => ({ publicationId: current.publicationId, linkId: current.linkId, revision: current.revision! + 1,
        ciphertext: encodeTreeBytes(await sealAuthorDeclaration({ publicationId: current.publicationId, linkId: current.linkId,
          publicKey: decodeTreeBytes(current.publicKey, 65), declarationId: current.publicationId, revision: current.revision! + 1 }, "Crossed")) }),
    ];
    for (const variant of variants) {
      const response = await sharingRequest(owner, `/api/private/tree/files/${fileId}`, "PATCH",
        await pairedSave(owner, owner.accountId, fileId, "never saved", variant));
      expect(response.status).toBe(400);
    }
    expect(await env.DB.prepare("SELECT current_revision FROM files WHERE node_id = ?").bind(fileId).first()).toEqual({ current_revision: 1 });
    expect(await count("file_representations", "file_node_id = ?", fileId)).toBe(1);
    expect(await count("public_representations", "publication_id = ?", published.publicationId)).toBe(1);
  });

  it("commits exactly one of two racing paired saves with agreeing pointers", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const published = await publish(owner, fileId);
    const [first, second] = await Promise.all([pairedSave(owner, owner.accountId, fileId, "first"),
      pairedSave(owner, owner.accountId, fileId, "second")]);
    const responses = await Promise.all([first, second].map((body) =>
      sharingRequest(owner, `/api/private/tree/files/${fileId}`, "PATCH", body)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = responses[0]!.status === 200 ? "first" : "second";
    expect((await openPublic(published)).presentation.markdown).toBe(winner);
    expect((await publicationRows(fileId)).results[0]).toMatchObject({ revision: 2, file_revision: 2 });
    expect(await count("public_representations", "publication_id = ?", published.publicationId)).toBe(1);
    expect(await count("file_representations", "file_node_id = ?", fileId)).toBe(1);
  });

  it("rejects an over-bound Public representation in the same D1 transaction as the private pointer", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const published = await publish(owner, fileId);
    const current = await env.DB.prepare(`SELECT f.current_representation_id AS id, r.content_key_id, r.key_epoch
      FROM files f JOIN file_representations r ON r.id = f.current_representation_id WHERE f.node_id = ?`)
      .bind(fileId).first<{ id: string; content_key_id: string; key_epoch: number }>();
    const next = opaqueId(), now = Date.now();
    await expect(env.DB.batch([
      env.DB.prepare(`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id, key_epoch,
        ciphertext, ciphertext_size, created_at) VALUES (?, ?, ?, 2, ?, 2, X'01', 1, ?)`).bind(next, fileId, owner.accountId, opaqueId(), now),
      env.DB.prepare("UPDATE files SET current_revision = 2, current_representation_id = ? WHERE node_id = ?").bind(next, fileId),
      env.DB.prepare(`INSERT INTO public_representations (id, publication_id, link_id, revision, file_revision, ciphertext,
        ciphertext_size, created_at) VALUES (?, ?, ?, 2, 2, zeroblob(524289), 524289, ?)`)
        .bind(opaqueId(), published.publicationId, published.linkId, now),
    ])).rejects.toThrow();
    expect(await env.DB.prepare("SELECT current_revision, current_representation_id FROM files WHERE node_id = ?").bind(fileId).first())
      .toEqual({ current_revision: 1, current_representation_id: current!.id });
    expect(await count("file_representations", "id = ?", next)).toBe(0);
    // Exactly 524,288 bytes is within the shared bound.
    const edge = opaqueId();
    await env.DB.batch([env.DB.prepare(`INSERT INTO public_representations (id, publication_id, link_id, revision, file_revision,
      ciphertext, ciphertext_size, created_at) VALUES (?, ?, ?, 9, 1, zeroblob(524288), 524288, ?)`)
      .bind(edge, published.publicationId, published.linkId, now)]);
    expect(await count("public_representations", "id = ?", edge)).toBe(1);
  });

  it("asks a stale legacy-format tab to refresh after its File was converted", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const response = await sharingRequest(owner, `/api/private/tree/files/${fileId}`, "PATCH", {
      expectedRevision: 1, expectedParentRevision: 2, keyEnvelope: "AQ",
      representation: { id: opaqueId(), contentKeyId: opaqueId(), keyEpoch: 2, revision: 2, ciphertext: "AQ" },
      listingHead: { ciphertext: "AQ", digest: "AQ", signature: "AQ" } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "file_converted" });
  });

  it("never gives a read-only Collaborator the Publication key", async () => {
    const owner = await sharingAccount(), reader = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    await grant(owner, reader, fileId, "read_only");
    await publish(owner, fileId);
    expect((await fileView(reader, fileId)).publication).toBeUndefined();
    const state = await (await sharingRequest(reader, `/api/private/publications/files/${fileId}`)).json() as Record<string, unknown>;
    expect(JSON.stringify(state)).not.toMatch(/publicKey|linkId/);
    expect(state).toMatchObject({ isOwner: false, canEdit: false, publication: { state: "active", authors: [] }, requests: [] });
  });
});

describe("author attribution", () => {
  it("is off by default and shows only Owner-selected authors, each declared by its own device", async () => {
    const owner = await sharingAccount(), collaborator = await sharingAccount(), editor = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    await grant(owner, collaborator, fileId, "read_only");
    await grant(owner, editor, fileId, "read_write");
    const published = await publish(owner, fileId);
    // Editing activity never infers an author.
    expect((await sharingRequest(editor, `/api/private/tree/files/${fileId}`, "PATCH",
      await pairedSave(editor, owner.accountId, fileId, "edited"))).status).toBe(200);
    expect((await openPublic(published)).authors).toEqual([]);
    const binding = { publicationId: published.publicationId, linkId: published.linkId, publicKey: published.keys.publicKey };
    const selfId = newPublicationIdentifier();
    const self = await sharingRequest(owner, `/api/private/publications/files/${fileId}/authors`, "PUT", {
      publicationId: published.publicationId, declarationId: selfId, account: { self: true },
      declaration: { linkId: published.linkId, ciphertext: encodeTreeBytes(await sealAuthorDeclaration(
        { ...binding, declarationId: selfId, revision: 1 }, "Member Owner")) } });
    expect(self.status).toBe(201);
    const collaboratorId = newPublicationIdentifier();
    const added = await sharingRequest(owner, `/api/private/publications/files/${fileId}/authors`, "PUT", {
      publicationId: published.publicationId, declarationId: collaboratorId, account: { shareId: collaborator.shareId }, declaration: null });
    expect(added.status).toBe(201);
    // A pending selection shows nothing until the author's own device declares it.
    expect((await openPublic(published)).authors).toEqual(["Member Owner"]);
    const view = await fileView(collaborator, fileId);
    expect(view.publication).toEqual({ publicationId: published.publicationId, linkId: published.linkId,
      publicKey: encodeTreeBytes(published.keys.publicKey), declaration: { declarationId: collaboratorId, revision: 0, current: false } });
    const declaration = { publicationId: published.publicationId, linkId: published.linkId, revision: 1,
      ciphertext: encodeTreeBytes(await sealAuthorDeclaration({ ...binding, declarationId: collaboratorId, revision: 1 }, "Member Reader")) };
    // Nobody else can write that author's declaration.
    expect((await sharingRequest(editor, `/api/private/publications/files/${fileId}/authors/${collaboratorId}/declaration`, "PUT",
      declaration)).status).toBe(404);
    expect((await sharingRequest(collaborator, `/api/private/publications/files/${fileId}/authors/${collaboratorId}/declaration`, "PUT",
      declaration)).status).toBe(200);
    expect((await openPublic(published)).authors).toEqual(["Member Owner", "Member Reader"]);
    expect((await fileView(collaborator, fileId)).publication?.declaration).toEqual({ declarationId: collaboratorId, revision: 1, current: true });
    // Removing an author removes its public attribution.
    expect((await sharingRequest(owner, `/api/private/publications/files/${fileId}/authors/${selfId}`, "DELETE", {})).status).toBe(200);
    expect((await openPublic(published)).authors).toEqual(["Member Reader"]);
  });

  it("lets only the Owner select authors, and only Accounts with current File access", async () => {
    const owner = await sharingAccount(), editor = await sharingAccount(), stranger = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    await grant(owner, editor, fileId, "read_write");
    const published = await publish(owner, fileId);
    const select = (actor: SharingAccount, shareId: string) => sharingRequest(actor, `/api/private/publications/files/${fileId}/authors`,
      "PUT", { publicationId: published.publicationId, declarationId: newPublicationIdentifier(), account: { shareId }, declaration: null });
    expect((await select(editor, editor.shareId)).status).toBe(404);
    expect((await select(owner, stranger.shareId)).status).toBe(404);
    expect((await select(owner, "unknown-share-id")).status).toBe(404);
    expect((await select(owner, editor.shareId)).status).toBe(201);
    const duplicate = await select(owner, editor.shareId);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "author_exists" });
    expect(await count("publication_authors", "publication_id = ?", published.publicationId)).toBe(1);
  });
});

describe("Publication requests", () => {
  it("allows one pending request that the requester cancels or the Owner denies", async () => {
    const owner = await sharingAccount(), first = await sharingAccount(), second = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    await grant(owner, first, fileId, "read_only");
    await grant(owner, second, fileId, "read_write");
    const path = `/api/private/publications/files/${fileId}/requests`;
    const created = await (await sharingRequest(first, path, "POST", {})).json() as { requestId: string; created: boolean };
    expect(created.created).toBe(true);
    expect(await (await sharingRequest(first, path, "POST", {})).json()).toEqual({ requestId: created.requestId, created: false });
    const other = await (await sharingRequest(second, path, "POST", {})).json() as { requestId: string };
    // A Collaborator cannot remove another requester's request; the Owner sees both.
    expect((await sharingRequest(second, `${path}/${created.requestId}`, "DELETE", {})).status).toBe(404);
    const ownerView = await (await sharingRequest(owner, `/api/private/publications/files/${fileId}`)).json() as { requests: { requestId: string }[] };
    expect(ownerView.requests.map((request) => request.requestId).sort()).toEqual([created.requestId, other.requestId].sort());
    expect((await sharingRequest(first, `${path}/${created.requestId}`, "DELETE", {})).status).toBe(200);
    expect((await sharingRequest(owner, `${path}/${other.requestId}`, "DELETE", {})).status).toBe(200);
    expect(await count("publication_requests", "file_id = ?", fileId)).toBe(0);
    // The Owner never requests; an Account without access gets the same 404.
    expect((await sharingRequest(owner, path, "POST", {})).status).toBe(404);
    expect((await sharingRequest(await sharingAccount(), path, "POST", {})).status).toBe(404);
    await publish(owner, fileId);
    const published = await sharingRequest(first, path, "POST", {});
    expect(published.status).toBe(409);
    expect(await published.json()).toEqual({ error: "publication_exists" });
  });
});

describe("fragment privacy and hard deletion", () => {
  it("never stores the fragment capability in any table", async () => {
    const owner = await sharingAccount(), editor = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    await grant(owner, editor, fileId, "read_write");
    const published = await publish(owner, fileId, { pseudonym: "Member Owner" });
    await sharingRequest(editor, `/api/private/tree/files/${fileId}`, "PATCH", await pairedSave(editor, owner.accountId, fileId, "next"));
    const scalar = published.keys.privateKey;
    const needles = [published.fragment, encodeTreeBytes(scalar), Array.from(scalar, (byte) => byte.toString(16).padStart(2, "0")).join("")];
    const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
      .all<{ name: string }>()).results.map((row) => row.name);
    expect(tables).toContain("publication_links");
    for (const table of tables) {
      const rows = (await env.DB.prepare(`SELECT * FROM "${table}"`).all<Record<string, unknown>>()).results;
      for (const row of rows) for (const value of Object.values(row)) {
        if (typeof value === "string") for (const needle of needles) expect(value.includes(needle), table).toBe(false);
        if (value instanceof ArrayBuffer) {
          const bytes = new Uint8Array(value);
          const found = bytes.length >= scalar.length && bytes.some((_, index) =>
            index + scalar.length <= bytes.length && scalar.every((byte, offset) => bytes[index + offset] === byte));
          expect(found, table).toBe(false);
        }
      }
    }
  });

  it("removes every Publication record when the published File or its Directory is hard-deleted", async () => {
    const owner = await sharingAccount(), collaborator = await sharingAccount();
    const directoryId = await treeChild(owner, owner.rootId, "directory");
    const nested = await treeChild(owner, directoryId, "file", owner.accountId, true);
    const requested = await treeChild(owner, directoryId, "file", owner.accountId, true);
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    await grant(owner, collaborator, directoryId, "read_write");
    const first = await publish(owner, fileId, { pseudonym: "Member Owner" });
    const second = await publish(owner, nested, { pseudonym: "Member Owner" });
    expect((await sharingRequest(collaborator, `/api/private/publications/files/${requested}/requests`, "POST", {})).status).toBe(201);
    const owned = "publication_id IN (SELECT id FROM publications WHERE owner_id = ?)";
    expect(await count("publications", "owner_id = ?", owner.accountId)).toBe(2);
    expect((await sharingRequest(owner, `/api/private/tree/nodes/${fileId}`, "DELETE",
      await deletePayload(owner, owner.accountId, fileId, owner.rootId))).status).toBe(200);
    // Deleting the File revoked its Publication without a separate unpublish.
    expect((await readPublic(first.linkId)).status).toBe(404);
    expect((await readPublic(second.linkId)).status).toBe(200);
    expect((await sharingRequest(owner, `/api/private/tree/nodes/${directoryId}`, "DELETE",
      await deletePayload(owner, owner.accountId, directoryId, owner.rootId))).status).toBe(200);
    expect((await readPublic(second.linkId)).status).toBe(404);
    expect(await count("publications", "owner_id = ?", owner.accountId)).toBe(0);
    for (const id of [first.publicationId, second.publicationId]) {
      for (const table of ["publication_links", "public_representations", "publication_authors"]) {
        expect(await count(table, "publication_id = ?", id), table).toBe(0);
      }
    }
    expect(await count("publication_requests", "owner_id = ?", owner.accountId)).toBe(0);
    expect(owned).toContain("publication_id");
  });
});

describe("query plans", () => {
  it("resolves a Public path and a File's Publication through their unique indexes", async () => {
    const plan = async (query: string, ...values: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${query}`).bind(...values)
      .all<{ detail: string }>()).results.map((row) => row.detail).join("\n");
    const path = await plan(`SELECT 1 FROM publication_links l
      JOIN publications p ON p.id = l.publication_id AND p.current_link_id = l.id AND p.state = 'active' WHERE l.id = ?`, "x");
    expect(path).toMatch(/SEARCH l USING (?:INDEX sqlite_autoindex_publication_links_1|PRIMARY KEY) \(id=\?\)/);
    expect(path).not.toMatch(/SCAN/);
    const byFile = await plan(`SELECT 1 FROM publications p WHERE p.file_id = ? AND p.state IN ('active', 'deleting')`, "x");
    expect(byFile).toContain("publications_file_idx");
    expect(byFile).not.toMatch(/SCAN/);
  });
});
