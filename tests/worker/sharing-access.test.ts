import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { directoryAccessGuard, fileAccessGuard, fileAuthorityQuery, getEffectiveDirectoryAccess,
  getEffectiveFileAccess, moveAccessGuard, structuralAccessGuard, type FileAction } from "../../app/sharing/access.server";
import type { SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { createDb, sql } from "../../app/db/client.server";
import { commitPrivateMutation } from "../../app/device/proof.server";
import { account, fixtureId, grant, node, share } from "./sharing-fixtures";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function allowed(guard: SQL): Promise<boolean> {
  return !!await createDb(env.DB).get<{ allowed: number }>(sql`SELECT 1 AS allowed WHERE ${guard}`);
}

describe("pending Shares and active Grants on migrated D1", () => {
  it("rejects duplicates, wrong target kind/Owner, self-invites, and missing recipient", async () => {
    const owner = await account(), recipient = await account(), other = await account();
    const target = await node(owner, owner.rootId, "file");
    await share(owner, recipient, target, "file", "read_only");
    await expect(share(owner, recipient, target, "file", "read_write")).rejects.toThrow();
    await expect(share(owner, recipient, target, "directory", "read_only")).rejects.toThrow();
    await expect(share(other, recipient, target, "file", "read_only")).rejects.toThrow();
    await expect(share(owner, owner, target, "file", "read_only")).rejects.toThrow();
    await expect(env.DB.prepare(`INSERT INTO shares (id, owner_id, recipient_id, target_node_id, target_kind, permission, created_at)
      VALUES (?, ?, ?, ?, 'file', 'read_only', 1)`).bind(fixtureId(), owner.accountId, fixtureId(), target).run()).rejects.toThrow();
    await grant(owner, recipient, target, "file", "read_write");
    await expect(grant(owner, recipient, target, "file", "read_only")).rejects.toThrow();
    await expect(grant(owner, recipient, target, "directory", "read_only")).rejects.toThrow();
    await expect(grant(other, recipient, target, "file", "read_only")).rejects.toThrow();
    await expect(grant(owner, owner, target, "file", "read_only")).rejects.toThrow();
    await expect(env.DB.prepare(`UPDATE grants SET generation = 0 WHERE target_node_id = ?`).bind(target).run()).rejects.toThrow();
    await expect(env.DB.prepare(`UPDATE grants SET generation = 2, permission = 'read_only' WHERE target_node_id = ?`).bind(target).run()).resolves.toBeDefined();
    await expect(env.DB.prepare(`UPDATE grants SET generation = 1 WHERE target_node_id = ?`).bind(target).run()).rejects.toThrow();
    await expect(env.DB.prepare(`UPDATE shares SET permission = 'read_write' WHERE target_node_id = ?`).bind(target).run()).rejects.toThrow();
    await expect(env.DB.prepare(`INSERT INTO grants (id, owner_id, recipient_id, target_node_id, target_kind, permission, generation, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'file', 'editor', 1, 1, 1)`)
      .bind(fixtureId(), owner.accountId, other.accountId, target).run()).rejects.toThrow();
    await env.DB.prepare(`DELETE FROM shares WHERE target_node_id = ?`).bind(target).run();
    await share(owner, recipient, target, "file", "read_write");
    await expect(env.DB.prepare(`INSERT INTO grants (id, owner_id, recipient_id, target_node_id, target_kind, permission, generation, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'file', 'read_only', 0, 1, 1)`)
      .bind(fixtureId(), owner.accountId, other.accountId, target).run()).rejects.toThrow();
    await expect(env.DB.prepare(`INSERT INTO grants (id, owner_id, recipient_id, target_node_id, target_kind, permission, generation, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'file', 'read_only', 1, 1, 1)`)
      .bind(fixtureId(), owner.accountId, other.accountId, fixtureId()).run()).rejects.toThrow();
  });
});

describe("current effective File access", () => {
  it("inherits Directory read-only, permits Comments, but not Markdown edits", async () => {
    const owner = await account(), recipient = await account();
    const directoryId = await node(owner, owner.rootId, "directory");
    const fileId = await node(owner, directoryId, "file");
    await grant(owner, recipient, directoryId, "directory", "read_only");
    const access = await getEffectiveFileAccess(env.DB, recipient.device, owner.accountId, fileId);
    expect(access?.canReadPrivateFile).toBe(true);
    expect(access?.canEditMarkdown).toBe(false);
    expect(access?.canCreatePrivateComment).toBe(true);
    const fileRead = await createDb(env.DB).get<{ id: string }>(sql`SELECT id FROM vault_nodes
      WHERE id = ${fileId} AND ${fileAccessGuard(recipient.device, owner.accountId, fileId, "file_read")}`);
    expect(fileRead?.id).toBe(fileId);
  });

  it("unions overlapping independent Grants and withdraws access only after the last path is removed", async () => {
    const owner = await account(), recipient = await account(), stranger = await account();
    const directoryId = await node(owner, owner.rootId, "directory");
    const nestedId = await node(owner, directoryId, "directory");
    const fileId = await node(owner, nestedId, "file");
    const broad = await grant(owner, recipient, directoryId, "directory", "read_only");
    const narrow = await grant(owner, recipient, nestedId, "directory", "read_write");
    const direct = await grant(owner, recipient, fileId, "file", "read_only");
    expect((await getEffectiveFileAccess(env.DB, recipient.device, owner.accountId, fileId))?.canEditMarkdown).toBe(true);
    expect(await allowed(fileAccessGuard(recipient.device, owner.accountId, fileId, "file_edit"))).toBe(true);
    await env.DB.prepare("DELETE FROM grants WHERE id = ?").bind(narrow).run();
    expect((await getEffectiveFileAccess(env.DB, recipient.device, owner.accountId, fileId))?.canEditMarkdown).toBe(false);
    await env.DB.prepare("DELETE FROM grants WHERE id = ?").bind(broad).run();
    expect((await getEffectiveFileAccess(env.DB, recipient.device, owner.accountId, fileId))?.canReadPrivateFile).toBe(true);
    await env.DB.prepare("DELETE FROM grants WHERE id = ?").bind(direct).run();
    expect(await getEffectiveFileAccess(env.DB, recipient.device, owner.accountId, fileId)).toBeNull();
    expect(await getEffectiveFileAccess(env.DB, stranger.device, owner.accountId, fileId)).toBeNull();
    expect((await getEffectiveFileAccess(env.DB, owner.device, owner.accountId, fileId))?.canEditMarkdown).toBe(true);
  });

  it("enforces Owner-only and Collaborator-only matrix rows, read-only Comment participation and direct File isolation", async () => {
    const owner = await account(), recipient = await account(), outsider = await account();
    const directory = await node(owner, owner.rootId, "directory");
    const file = await node(owner, directory, "file");
    const sibling = await node(owner, directory, "file");
    await grant(owner, recipient, file, "file", "read_only");
    const access = await getEffectiveFileAccess(env.DB, recipient.device, owner.accountId, file);
    expect(access).toMatchObject({ isOwner: false, canReadPrivateFile: true, canEditMarkdown: false,
      canReadPrivateComments: true, canCreatePrivateComment: true, canEditOwnPrivateComment: true,
      canDeleteOwnPrivateComment: true, canDeleteAnyPrivateComment: false, canManageShares: false,
      canManagePublication: false, canRequestPublication: true, canReadCollaboratorsPublicComments: true,
      canReadPublicAudienceComments: true, canPostPublicAudienceCommentViaDevice: true, canExportOwnedFile: false });
    const readActions: FileAction[] = ["file_read", "private_comment_read", "private_comment_create",
      "private_comment_edit_own", "private_comment_delete_own", "collaborators_public_comment_read",
      "public_audience_comment_read", "public_audience_comment_post_device", "publication_request"];
    for (const action of readActions) expect(await allowed(fileAccessGuard(recipient.device, owner.accountId, file, action)), action).toBe(true);
    for (const action of ["file_edit", "private_comment_delete_any", "share_manage", "publication_manage",
      "export_owned_file"] as const) expect(await allowed(fileAccessGuard(recipient.device, owner.accountId, file, action)), action).toBe(false);
    expect(await allowed(fileAccessGuard(recipient.device, owner.accountId, sibling, "file_read"))).toBe(false);
    expect(await allowed(directoryAccessGuard(recipient.device, owner.accountId, directory, "directory_read"))).toBe(false);
    expect(await allowed(structuralAccessGuard(recipient.device, owner.accountId, file, "delete"))).toBe(false);
    expect(await allowed(fileAccessGuard(outsider.device, owner.accountId, file, "public_audience_comment_read"))).toBe(false);
    const ownerAccess = await getEffectiveFileAccess(env.DB, owner.device, owner.accountId, file);
    expect(ownerAccess).toMatchObject({ isOwner: true, canEditMarkdown: true, canManageShares: true,
      canDeleteAnyPrivateComment: true, canManagePublication: true, canRequestPublication: false, canExportOwnedFile: true });
    expect(await allowed(fileAccessGuard(owner.device, owner.accountId, file, "publication_request"))).toBe(false);
    expect(await allowed(fileAccessGuard(owner.device, owner.accountId, file, "private_comment_delete_any"))).toBe(true);
  });
});

describe("Directory scope and structural confinement", () => {
  it("permits creates/import only through a Directory write Grant; rejects shared-root structural mutations", async () => {
    const owner = await account(), recipient = await account();
    const root = await node(owner, owner.rootId, "directory");
    const nested = await node(owner, root, "directory");
    const file = await node(owner, nested, "file");
    await grant(owner, recipient, root, "directory", "read_only");
    expect(await getEffectiveDirectoryAccess(env.DB, recipient.device, owner.accountId, nested))
      .toMatchObject({ canReadDirectory: true, canCreateChild: false, canUseAsImportTarget: false, canManageShares: false });
    expect(await allowed(directoryAccessGuard(recipient.device, owner.accountId, nested, "import_target"))).toBe(false);
    await env.DB.prepare(`UPDATE grants SET permission = 'read_write', generation = 2, updated_at = ? WHERE target_node_id = ?`)
      .bind(Date.now(), root).run();
    expect(await getEffectiveDirectoryAccess(env.DB, recipient.device, owner.accountId, nested))
      .toMatchObject({ canCreateChild: true, canUseAsImportTarget: true, canManageShares: false });
    expect(await allowed(directoryAccessGuard(recipient.device, owner.accountId, nested, "child_create"))).toBe(true);
    expect(await allowed(directoryAccessGuard(recipient.device, owner.accountId, nested, "import_target"))).toBe(true);
    expect(await allowed(directoryAccessGuard(recipient.device, owner.accountId, nested, "share_manage"))).toBe(false);
    expect(await getEffectiveDirectoryAccess(env.DB, owner.device, owner.accountId, owner.rootId))
      .toMatchObject({ isOwner: true, canReadDirectory: true, canCreateChild: true,
        canUseAsImportTarget: true, canManageShares: true });
    expect(await allowed(structuralAccessGuard(recipient.device, owner.accountId, file, "rename"))).toBe(true);
    expect(await allowed(structuralAccessGuard(recipient.device, owner.accountId, nested, "reorder"))).toBe(true);
    expect(await allowed(structuralAccessGuard(recipient.device, owner.accountId, root, "delete"))).toBe(false);
    expect(await allowed(structuralAccessGuard(owner.device, owner.accountId, root, "delete"))).toBe(true);
    expect(await allowed(structuralAccessGuard(owner.device, owner.accountId, owner.rootId, "delete"))).toBe(false);
    await grant(owner, recipient, file, "file", "read_only");
    expect(await allowed(structuralAccessGuard(recipient.device, owner.accountId, file, "delete"))).toBe(false);
  });

  it("requires one common read/write subtree for moves, same Owner and no cycle", async () => {
    const owner = await account(), other = await account(), recipient = await account();
    const left = await node(owner, owner.rootId, "directory");
    const right = await node(owner, owner.rootId, "directory");
    const child = await node(owner, left, "directory");
    const leftFile = await node(owner, child, "file");
    const rightFile = await node(owner, right, "file");
    const leftGrant = await grant(owner, recipient, left, "directory", "read_write");
    await grant(owner, recipient, right, "directory", "read_write");
    expect(await allowed(moveAccessGuard(recipient.device, owner.accountId, leftFile, left))).toBe(true);
    expect(await allowed(moveAccessGuard(recipient.device, owner.accountId, leftFile, right))).toBe(false);
    expect(await allowed(moveAccessGuard(recipient.device, owner.accountId, leftFile, owner.rootId))).toBe(false);
    expect(await allowed(moveAccessGuard(recipient.device, owner.accountId, child, child))).toBe(false);
    expect(await allowed(moveAccessGuard(recipient.device, owner.accountId, left, right))).toBe(false);
    expect(await allowed(moveAccessGuard(recipient.device, owner.accountId, rightFile, child))).toBe(false);
    expect(await allowed(moveAccessGuard(recipient.device, owner.accountId, leftFile, other.rootId))).toBe(false);
    expect(await allowed(moveAccessGuard(owner.device, owner.accountId, leftFile, right))).toBe(true);
    expect(await allowed(moveAccessGuard(owner.device, owner.accountId, child, child))).toBe(false);
    await env.DB.prepare(`DELETE FROM grants WHERE id = ?`).bind(leftGrant).run();
    expect(await allowed(moveAccessGuard(recipient.device, owner.accountId, leftFile, left))).toBe(false);
  });

  it("new descendants of an authorized Directory belong to its Owner and inherit the Grant", async () => {
    const owner = await account(), recipient = await account();
    const shared = await node(owner, owner.rootId, "directory");
    await grant(owner, recipient, shared, "directory", "read_write");
    const newDirectory = await node(owner, shared, "directory");
    const newFile = await node(owner, newDirectory, "file");
    const row = await env.DB.prepare("SELECT owner_id FROM vault_nodes WHERE id = ?")
      .bind(newFile).first<{ owner_id: string }>();
    expect(row?.owner_id).toBe(owner.accountId);
    expect((await getEffectiveFileAccess(env.DB, recipient.device, owner.accountId, newFile))?.canEditMarkdown).toBe(true);
    expect(await allowed(directoryAccessGuard(recipient.device, owner.accountId, newDirectory, "import_target"))).toBe(true);
  });

  it("denies more than 100 ancestor edges rather than granting a truncated path", async () => {
    const owner = await account(), recipient = await account();
    await grant(owner, recipient, owner.rootId, "directory", "read_write");
    let parent = owner.rootId;
    for (let depth = 0; depth < 101; depth++) parent = await node(owner, parent, "directory");
    const deepFile = await node(owner, parent, "file");
    expect(await getEffectiveFileAccess(env.DB, recipient.device, owner.accountId, deepFile)).toBeNull();
    expect(await allowed(moveAccessGuard(recipient.device, owner.accountId, deepFile, owner.rootId))).toBe(false);
    expect(await allowed(structuralAccessGuard(owner.device, owner.accountId, deepFile, "delete"))).toBe(false);
  });
});

describe("live authorization at the ciphertext and mutation statement", () => {
  it("rechecks Grant and device registry state in each ciphertext SELECT and guarded write", async () => {
    const owner = await account(), recipient = await account();
    const file = await node(owner, owner.rootId, "file");
    const grantId = await grant(owner, recipient, file, "file", "read_only");
    async function ciphertext() {
      return createDb(env.DB).get<{ ciphertext: ArrayBuffer }>(sql`
        SELECT r.ciphertext FROM files f JOIN file_representations r
          ON r.id = f.current_representation_id AND r.file_node_id = f.node_id
        WHERE f.node_id = ${file} AND ${fileAccessGuard(recipient.device, owner.accountId, file, "file_read")}`);
    }
    expect(new Uint8Array((await ciphertext())!.ciphertext)).toEqual(new Uint8Array([1]));
    const write = () => commitPrivateMutation(env, recipient.device, (deviceGuard) => sql`
      UPDATE vault_nodes SET updated_at = updated_at + 1 WHERE id = ${file}
        AND ${deviceGuard} AND ${fileAccessGuard(recipient.device, owner.accountId, file, "file_edit")}`);
    expect(await write()).toBe(false);
    await env.DB.prepare(`UPDATE grants SET permission = 'read_write', generation = 2, updated_at = ? WHERE id = ?`)
      .bind(Date.now(), grantId).run();
    expect(await write()).toBe(true);
    expect(await write()).toBe(false); // consumed proof cannot be reused
    await env.DB.prepare(`DELETE FROM grants WHERE id = ?`).bind(grantId).run();
    expect(await ciphertext()).toBeUndefined();
    expect(await write()).toBe(false);
    await grant(owner, recipient, file, "file", "read_write");
    expect(await ciphertext()).toBeDefined();
    await env.DB.prepare(`UPDATE encryption_devices SET state = 'revoked', revocation_reason = 'test' WHERE id = ?`)
      .bind(recipient.device.deviceId).run();
    expect(await ciphertext()).toBeUndefined();
    expect(await getEffectiveFileAccess(env.DB, recipient.device, owner.accountId, file)).toBeNull();
  });

  it("uses indexed seeks for a bounded ancestor walk and exact target/recipient Grant lookups", async () => {
    const owner = await account(), recipient = await account();
    const dir = await node(owner, owner.rootId, "directory");
    const file = await node(owner, dir, "file");
    await grant(owner, recipient, dir, "directory", "read_only");
    const { sql: statement, params } = new SQLiteAsyncDialect().sqlToQuery(
      fileAuthorityQuery(recipient.device, owner.accountId, file));
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${statement}`).bind(...params).all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);
    // Inspected plan: child/l scan only the bounded (<=101 rows) CTE; root uses
    // a transient CTE index. All sessions/devices/nodes/Grants use indexed seeks.
    expect(details.some((detail) => detail.includes("SCAN child"))).toBe(true);
    expect(details.some((detail) => detail.includes("grants_active_target_recipient_idx"))).toBe(true);
    expect(details.some((detail) => detail.includes("vault_nodes") && detail.includes("SEARCH"))).toBe(true);
    expect(details.some((detail) => /SCAN (?:g|parent|n)\b/.test(detail))).toBe(false);
  });
});
