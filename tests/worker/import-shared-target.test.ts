/**
 * Ticket 33 acceptance: shared-target Import ownership and visibility.
 *
 * The buildable spec (§12.5) requires that a read/write Directory Grant can
 * import into the Owner's Directory, that every new descendant belongs to the
 * target Directory's Owner and creates no new authority, and that uncommitted
 * Import records stay invisible to every normal query class. Existing suites
 * cover each clause in isolation; this one drives the whole protocol through a
 * Collaborator's Session and reconciles ownership, authority, and visibility.
 */

import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { signDeviceProof, sessionBindingDigest } from "../../app/shared/device/proof";
import { prepareImportPlan, type ImportPlan } from "../../app/shared/import/plan";
import { reviewImport, type ImportTarget } from "../../app/shared/import/review";
import { analyzeImportSelection, type ImportSourceFile, type RawImportInput } from "../../app/shared/import/source";
import { encodeImportChunkBody, encodeImportSessionBody } from "../../app/shared/import/staging";
import { createFileHead } from "../../app/shared/tree/file-head";
import { createListingHead } from "../../app/shared/tree/listing";
import { grant, sharingAccount, sharingRequest, treeListing, type SharingAccount } from "./sharing-fixtures";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const encoder = new TextEncoder();

function collectFiles(children: readonly { kind: string; path: readonly string[]; children?: unknown[] }[],
  files: Map<string, ImportSourceFile>): void {
  for (const child of children) {
    if (child.kind === "file") files.set(child.path.join("/"), child as unknown as ImportSourceFile);
    else collectFiles(child.children as never, files);
  }
}

async function buildPlan(actor: SharingAccount, vaultId: string, targetDirectoryId: string,
  targetKey: Uint8Array, inputs: readonly RawImportInput[]): Promise<ImportPlan> {
  const source = await analyzeImportSelection(inputs);
  const files = new Map<string, ImportSourceFile>();
  collectFiles(source.roots as never, files);
  const target: ImportTarget = { directoryId: targetDirectoryId, keyEpoch: 1, entriesRevision: 1,
    ownerAccountId: vaultId, actorAccountId: actor.accountId, label: "Shared Files", siblings: [], listing: [] };
  return prepareImportPlan({
    review: reviewImport(source, target), files, comments: source.comments, targetKey, replacements: new Map(),
    signFileHead: (identity) => createFileHead(actor.assertion.privateKey, { ...identity, deviceId: actor.deviceId }),
    signListingHead: (input) => createListingHead(input.parentKey, actor.assertion.privateKey, {
      vaultId, directoryId: input.directoryId, deviceId: actor.deviceId,
      keyEpoch: input.keyEpoch, revision: input.revision, entries: input.entries,
    }),
  });
}

/** Binary staging requests signed by the importing Collaborator's own device. */
async function send(actor: SharingAccount, path: string, method: "POST" | "PUT" | "DELETE",
  body?: Uint8Array): Promise<Response> {
  const url = `https://mdwn.test${path}`;
  const proof = await signDeviceProof(actor.assertion.privateKey, {
    sessionBinding: await sessionBindingDigest(actor.session.id), deviceId: actor.deviceId,
    registryEpoch: actor.registryEpoch, method, url, body: body ?? "",
  });
  return SELF.fetch(url, { method, headers: {
    cookie: actor.session.cookie, origin: "https://mdwn.test", "CF-Connecting-IP": "203.0.113.7",
    "X-Mdwn-Device-Proof": JSON.stringify(proof),
    ...(body ? { "content-type": "application/octet-stream" } : {}),
  }, ...(body ? { body: body as BodyInit } : {}) });
}

async function count(sql: string, ...values: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...values).first<{ n: number }>();
  return row!.n;
}

describe("MVP acceptance: shared-target Import", () => {
  it("assigns every new descendant to the target Owner, creates no authority, and hides staging until commit", async () => {
    const owner = await sharingAccount(), collaborator = await sharingAccount();
    const ownerKey = owner.keys.get(owner.rootId)!;
    const { grantId } = await grant(owner, collaborator, owner.rootId, "read_write");
    expect(collaborator.keys.has(owner.rootId)).toBe(true);
    const grantsBefore = await count("SELECT count(*) AS n FROM grants WHERE owner_id = ?", owner.accountId);

    const plan = await buildPlan(collaborator, owner.accountId, owner.rootId,
      collaborator.keys.get(owner.rootId)!, [
        { path: "Shared Folder/plan.md", bytes: encoder.encode("# shared plan") },
        { path: "notes.md", bytes: encoder.encode("# notes") },
      ]);
    const prospectiveNodeIds = plan.records.filter((record) => record.kind === "node-file" || record.kind === "node-directory")
      .map((record) => record.refs[0]!);
    expect(prospectiveNodeIds).toHaveLength(3);
    const prospectiveFileIds = plan.records.filter((record) => record.kind === "node-file")
      .map((record) => record.refs[0]!);

    const session = await send(collaborator, "/api/private/imports", "POST",
      encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope));
    expect(session.status).toBe(201);
    const { importId } = await session.json() as { importId: string };
    for (const chunk of plan.chunks) {
      expect((await send(collaborator, `/api/private/imports/${importId}/chunks/${chunk.sequence}`, "PUT",
        encodeImportChunkBody(chunk.descriptors, chunk.payload))).status).toBe(201);
    }

    // Uncommitted records are invisible to every normal query class: no tree
    // entry for either actor, no direct File read, and nothing in the
    // Collaborator's owned-Files export scope.
    const stagedOwner = await treeListing(owner, owner.rootId);
    const stagedCollaborator = await treeListing(collaborator, owner.rootId);
    expect(stagedOwner.entries).toEqual([]);
    expect(stagedCollaborator.entries).toEqual([]);
    for (const fileId of prospectiveFileIds) {
      expect((await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).status).toBe(404);
      expect((await sharingRequest(collaborator, `/api/private/tree/files/${fileId}`)).status).toBe(404);
    }
    expect(await count("SELECT count(*) AS n FROM vault_nodes WHERE owner_id = ?", owner.accountId)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM vault_nodes WHERE owner_id = ?", collaborator.accountId)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM import_commits WHERE import_id = ?", importId)).toBe(0);

    const commit = await send(collaborator, `/api/private/imports/${importId}/commit`, "POST");
    expect(commit.status).toBe(200);
    expect(await commit.json()).toMatchObject({ committed: true, entriesRevision: 2 });

    // Every imported node belongs to the target Directory's Owner; the
    // Collaborator owns none of it and gains no new Grant.
    expect(await count("SELECT count(*) AS n FROM vault_nodes WHERE owner_id = ?", owner.accountId)).toBe(4);
    expect(await count("SELECT count(*) AS n FROM vault_nodes WHERE owner_id = ?", collaborator.accountId)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM grants WHERE owner_id = ?", owner.accountId)).toBe(grantsBefore);
    expect(await count("SELECT count(*) AS n FROM grants WHERE id = ?", grantId)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM import_records WHERE import_id = ?", importId)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM import_commits WHERE import_id = ?", importId)).toBe(1);

    const committedOwner = await treeListing(owner, owner.rootId);
    const committedCollaborator = await treeListing(collaborator, owner.rootId);
    const rootNodeIds = plan.records.filter((record) => (record.kind === "node-file" || record.kind === "node-directory") &&
      record.refs[1] === owner.rootId).map((record) => record.refs[0]!);
    expect(committedOwner.entries.map((entry) => entry.nodeId).sort()).toEqual(rootNodeIds.sort());
    expect(committedCollaborator.entries).toHaveLength(2);
    // The Collaborator reaches the committed File only through the existing
    // Directory Grant; it stays outside its owned-Files export scope.
    expect((await sharingRequest(collaborator, `/api/private/tree/files/${prospectiveFileIds[0]}`)).status).toBe(200);
    expect((await sharingRequest(owner, `/api/private/tree/files/${prospectiveFileIds[0]}`)).status).toBe(200);
    const fileRows = (await env.DB.prepare(`SELECT files.owner_id AS file_owner, file_representations.owner_id AS representation_owner
      FROM files JOIN file_representations ON file_representations.id = files.current_representation_id
      WHERE files.node_id = ?`).bind(prospectiveFileIds[0]!).first<{ file_owner: string; representation_owner: string }>())!;
    expect(fileRows).toEqual({ file_owner: owner.accountId, representation_owner: owner.accountId });
  });

  it("rejects a commit after the recipient's Grant is revoked, leaving no visible File", async () => {
    const owner = await sharingAccount(), collaborator = await sharingAccount();
    const { grantId } = await grant(owner, collaborator, owner.rootId, "read_write");
    const plan = await buildPlan(collaborator, owner.accountId, owner.rootId,
      collaborator.keys.get(owner.rootId)!, [{ path: "revoked.md", bytes: encoder.encode("# never visible") }]);
    const session = await send(collaborator, "/api/private/imports", "POST",
      encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope));
    const { importId } = await session.json() as { importId: string };
    expect((await send(collaborator, `/api/private/imports/${importId}/chunks/0`, "PUT",
      encodeImportChunkBody(plan.chunks[0]!.descriptors, plan.chunks[0]!.payload))).status).toBe(201);

    expect((await sharingRequest(owner, `/api/private/grants/${grantId}`, "DELETE", { expectedRevision: 1 })).status).toBe(200);
    // Stale target authority returns to review; nothing becomes visible.
    expect((await send(collaborator, `/api/private/imports/${importId}/commit`, "POST")).status).toBe(409);
    expect(await count("SELECT count(*) AS n FROM import_commits WHERE import_id = ?", importId)).toBe(0);
    expect((await treeListing(owner, owner.rootId)).entries).toEqual([]);
  });
});
