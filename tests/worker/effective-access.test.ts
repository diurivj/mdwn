import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import {
  effectiveAccess,
  effectiveAccessQuery,
  permits,
  permitsPublicAudience,
  type Operation,
} from "../../app/sharing/access.server";
import { grant, sharingAccount, sharingAuthorization, sharingRequest, treeChild } from "./sharing-fixtures";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

it("a read-only Directory Grant permits Private Comment participation but not Markdown edits", async () => {
  const owner = await sharingAccount(),
    collaborator = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  await grant(owner, collaborator, directoryId);
  const access = await effectiveAccess(env, await sharingAuthorization(collaborator), fileId);
  expect(access).toMatchObject({
    ownerId: owner.accountId,
    permission: "read_only",
    canReadPrivateComments: true,
    canReadCollaboratorsPublicComments: true,
  });
  expect(permits(access, "edit_markdown")).toBe(false);
  expect(permits(access, "create_private_comment")).toBe(true);
  expect(permits(access, "edit_private_comment", { commentAuthorId: collaborator.accountId })).toBe(true);
  expect(permits(access, "delete_private_comment", { commentAuthorId: collaborator.accountId })).toBe(true);
  expect(permits(access, "edit_private_comment", { commentAuthorId: owner.accountId })).toBe(false);
});

it("unions overlapping Grants and revokes them independently without removing other access paths", async () => {
  const owner = await sharingAccount(),
    collaborator = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  const inherited = await grant(owner, collaborator, directoryId, "read_write");
  const direct = await grant(owner, collaborator, fileId, "read_only");
  const auth = await sharingAuthorization(collaborator);
  expect((await effectiveAccess(env, auth, fileId))?.permission).toBe("read_write");
  expect(
    (await sharingRequest(owner, `/api/private/grants/${inherited.grantId}`, "DELETE", { expectedRevision: 1 })).status,
  ).toBe(200);
  const remaining = await effectiveAccess(env, auth, fileId);
  expect(remaining).toMatchObject({
    permission: "read_only",
    canReadPrivateComments: true,
    canReadCollaboratorsPublicComments: true,
    directoryWriteRoots: [],
  });
  expect(permits(remaining, "edit_markdown")).toBe(false);
  expect(
    (await sharingRequest(collaborator, `/api/private/grants/${direct.grantId}/leave`, "POST", { expectedRevision: 1 }))
      .status,
  ).toBe(200);
  expect(await effectiveAccess(env, auth, fileId)).toBeNull();
  expect(await (await sharingRequest(collaborator, "/api/private/grants")).json()).toMatchObject({ received: [] });
});

it("enforces every permission-matrix row, including direct-File structural denial and Owner comment limits", async () => {
  const owner = await sharingAccount();
  const recipients = await Promise.all(Array.from({ length: 4 }, () => sharingAccount()));
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  await grant(owner, recipients[0]!, directoryId, "read_write");
  await grant(owner, recipients[1]!, directoryId, "read_only");
  await grant(owner, recipients[2]!, fileId, "read_write");
  await grant(owner, recipients[3]!, fileId, "read_only");
  const actors = [owner, ...recipients];
  const auth = await Promise.all(actors.map(sharingAuthorization));
  const files = await Promise.all(auth.map((actor) => effectiveAccess(env, actor, fileId)));
  const directories = await Promise.all(auth.map((actor) => effectiveAccess(env, actor, directoryId)));
  const matrix: Array<[Operation, number[]]> = [
    ["read_file", [1, 1, 1, 1, 1]],
    ["edit_markdown", [1, 1, 0, 1, 0]],
    ["create_child", [1, 1, 0, 0, 0]],
    ["rename", [1, 1, 0, 0, 0]],
    ["reorder", [1, 1, 0, 0, 0]],
    ["delete", [1, 1, 0, 0, 0]],
    ["move", [1, 1, 0, 0, 0]],
    ["import", [1, 1, 0, 0, 0]],
    ["read_private_comments", [1, 1, 1, 1, 1]],
    ["create_private_comment", [1, 1, 1, 1, 1]],
    ["edit_private_comment", [1, 1, 1, 1, 1]],
    ["delete_private_comment", [1, 1, 1, 1, 1]],
    ["delete_another_comment", [1, 0, 0, 0, 0]],
    ["manage_shares", [1, 0, 0, 0, 0]],
    ["manage_publication", [1, 0, 0, 0, 0]],
    ["request_publication", [0, 1, 1, 1, 1]],
    ["read_collaborators_public_comments", [1, 1, 1, 1, 1]],
    ["read_public_comments", [1, 1, 1, 1, 1]],
    ["post_public_comment", [1, 1, 1, 1, 1]],
    ["export", [1, 0, 0, 0, 0]],
  ];
  for (const [operation, expected] of matrix) {
    const values = operation === "create_child" || operation === "import" ? directories : files;
    expect(
      values.map((access, index) =>
        Number(
          permits(access, operation, {
            commentAuthorId: actors[index]!.accountId,
            destination: directories[index] ?? undefined,
          }),
        ),
      ),
      operation,
    ).toEqual(expected);
    expect(permits(null, operation), `no access: ${operation}`).toBe(false);
  }
  expect(directories.map((access) => Number(permits(access, "delete")))).toEqual([1, 0, 0, 0, 0]);
  expect(permits(files[0]!, "edit_private_comment", { commentAuthorId: recipients[0]!.accountId })).toBe(false);
  expect(permits(files[0]!, "delete_private_comment", { commentAuthorId: recipients[0]!.accountId })).toBe(true);
  expect(permitsPublicAudience("read", { completeActiveLink: true, privateCapableSession: false })).toBe(true);
  expect(permitsPublicAudience("post", { completeActiveLink: true, privateCapableSession: false })).toBe(false);
  expect(permitsPublicAudience("post", { completeActiveLink: true, privateCapableSession: true })).toBe(true);
  expect(permitsPublicAudience("read", { completeActiveLink: false, privateCapableSession: true })).toBe(false);
});

it("rechecks proof expiry at the read seam, even after successful preflight authorization", async () => {
  const owner = await sharingAccount();
  const fileId = await treeChild(owner, owner.rootId, "file");
  const auth = await sharingAuthorization(owner);
  const clock = vi.spyOn(Date, "now").mockReturnValue(auth.expiresAt);
  try {
    expect(await effectiveAccess(env, auth, fileId)).toBeNull();
  } finally {
    clock.mockRestore();
  }
});

it("uses exact indexed ancestor/Grant probes in the reviewed effective-access query plan", async () => {
  const owner = await sharingAccount(),
    collaborator = await sharingAccount();
  const directoryId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, directoryId, "file");
  await grant(owner, collaborator, directoryId);
  const query = new SQLiteAsyncDialect().sqlToQuery(
    effectiveAccessQuery(await sharingAuthorization(collaborator), fileId),
  );
  const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
    .bind(...query.params)
    .all<{ detail: string }>();
  const details = plan.results.map((row) => row.detail);
  console.info("Effective-access EXPLAIN QUERY PLAN:", JSON.stringify(details));
  expect(
    details.some((detail) =>
      /SEARCH g USING COVERING INDEX grants_recipient_target_idx \(recipient_id=\? AND target_id=\? AND owner_id=\?\)/.test(
        detail,
      ),
    ),
  ).toBe(true);
  expect(
    details.some((detail) =>
      /SEARCH parent USING INDEX vault_nodes_owner_target_idx \(owner_id=\? AND id=\?\)/.test(detail),
    ),
  ).toBe(true);
  expect(details.some((detail) => /SCAN (grants|vault_nodes|g|parent)\b/.test(detail))).toBe(false);
});
