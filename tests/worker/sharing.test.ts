import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import {
  convertFixtureFile,
  grant,
  invite,
  opaqueId,
  prepareGrantKeys,
  sharingAccount,
  sharingRequest,
  treeChild,
} from "./sharing-fixtures";
import { shareHandleLookupToken } from "../../app/sharing/address";

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

it("an Owner invites an exact existing Account and acceptance creates one active Grant", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const fileId = await treeChild(owner, owner.rootId, "file");
  const pending = await invite(owner, recipient, fileId, "read_write");
  const inbox = await sharingRequest(recipient, "/api/private/shares");
  expect(inbox.status).toBe(200);
  expect(await inbox.json()).toMatchObject({
    incoming: [{ shareId: pending.shareId, targetId: fileId, permission: "read_write" }],
  });
  await prepareGrantKeys(owner, pending.shareId);
  const accepted = await sharingRequest(recipient, `/api/private/shares/${pending.shareId}/accept`, "POST", {});
  expect(accepted.status).toBe(201);
  const active = await sharingRequest(recipient, "/api/private/grants");
  expect(active.status).toBe(200);
  expect(await active.json()).toMatchObject({ received: [{ targetId: fileId, permission: "read_write" }] });
  expect(await (await sharingRequest(recipient, "/api/private/shares")).json()).toMatchObject({ incoming: [] });
});

it("keeps a pending invitation unique and lets only the Owner cancel or recipient decline", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount(),
    stranger = await sharingAccount();
  const targetId = await treeChild(owner, owner.rootId, "directory");
  const pending = await invite(owner, recipient, targetId);
  const duplicate = await sharingRequest(owner, "/api/private/shares", "PUT", {
    targetId,
    recipient: { shareId: recipient.shareId },
    permission: "read_write",
  });
  expect(duplicate.status).toBe(409);
  expect((await sharingRequest(stranger, `/api/private/shares/${pending.shareId}`, "DELETE", {})).status).toBe(404);
  expect((await sharingRequest(recipient, `/api/private/shares/${pending.shareId}`, "DELETE", {})).status).toBe(404);
  expect((await sharingRequest(owner, `/api/private/shares/${pending.shareId}`, "DELETE", {})).status).toBe(200);
  expect((await sharingRequest(recipient, `/api/private/shares/${pending.shareId}/accept`, "POST", {})).status).toBe(
    404,
  );
  const next = await invite(owner, recipient, targetId);
  expect((await sharingRequest(owner, `/api/private/shares/${next.shareId}/decline`, "POST", {})).status).toBe(404);
  expect((await sharingRequest(recipient, `/api/private/shares/${next.shareId}/decline`, "POST", {})).status).toBe(200);
  expect(await (await sharingRequest(owner, "/api/private/shares")).json()).toMatchObject({ outgoing: [] });
});

it("addresses one exact normalized handle without prefix, wildcard, or Account-directory discovery", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const targetId = await treeChild(owner, owner.rootId, "file");
  await convertFixtureFile(owner, targetId);
  await env.DB.prepare("UPDATE accounts SET share_handle_lookup_token = ? WHERE id = ?")
    .bind(await shareHandleLookupToken("Cobalt_Wren"), recipient.accountId)
    .run();
  for (const handle of ["Cobalt", "Cobalt_Wre", "Cobalt_Wren%", " Cobalt_Wren"]) {
    expect(
      (
        await sharingRequest(owner, "/api/private/shares", "PUT", {
          targetId,
          recipient: { handle },
          permission: "read_only",
        })
      ).ok,
    ).toBe(false);
  }
  const matched = await sharingRequest(owner, "/api/private/shares", "PUT", {
    targetId,
    recipient: { handle: "cobalt_wren" },
    permission: "read_only",
  });
  expect(matched.status).toBe(201);
  expect(await (await sharingRequest(recipient, "/api/private/shares")).json()).toMatchObject({
    incoming: [{ recipientId: recipient.accountId, targetId }],
  });
});

it("only the Owner changes a Grant permission, conditionally on its current revision", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount(),
    stranger = await sharingAccount();
  const targetId = await treeChild(owner, owner.rootId, "file");
  const active = await grant(owner, recipient, targetId);
  const path = `/api/private/grants/${active.grantId}`;
  const change = { expectedRevision: 1, permission: "read_write" };
  expect((await sharingRequest(recipient, path, "PATCH", change)).status).toBe(404);
  expect((await sharingRequest(stranger, path, "PATCH", change)).status).toBe(404);
  const proofId = opaqueId();
  expect((await sharingRequest(owner, path, "PATCH", change, proofId)).status).toBe(200);
  expect(
    (await sharingRequest(owner, path, "PATCH", { expectedRevision: 2, permission: "read_only" }, proofId)).ok,
  ).toBe(false);
  expect((await sharingRequest(owner, path, "PATCH", change)).status).toBe(409);
  expect(await (await sharingRequest(recipient, "/api/private/grants")).json()).toMatchObject({
    received: [{ grantId: active.grantId, permission: "read_write", revision: 2 }],
  });
});

it("provides a usable cursor rather than silently dropping invitations beyond the bounded page", async () => {
  const owner = await sharingAccount();
  const recipients = Array.from({ length: 101 }, () => ({
    accountId: opaqueId(),
    shareId: opaqueId(),
    id: opaqueId(),
  }));
  const values = JSON.stringify(recipients);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO accounts (id, share_id, created_at, updated_at)
      SELECT json_extract(value, '$.accountId'), json_extract(value, '$.shareId'), 1, 1 FROM json_each(?)`).bind(
      values,
    ),
    env.DB.prepare(`INSERT INTO shares (id, owner_id, recipient_id, target_id, target_kind, permission, created_at)
      SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.accountId'), ?, 'directory', 'read_only', 1 FROM json_each(?)`).bind(
      owner.accountId,
      owner.rootId,
      values,
    ),
  ]);
  const first = (await (await sharingRequest(owner, "/api/private/shares")).json()) as {
    outgoing: { shareId: string }[];
    nextCursor: string;
  };
  expect(first.outgoing).toHaveLength(100);
  const second = (await (await sharingRequest(owner, `/api/private/shares?cursor=${first.nextCursor}`)).json()) as {
    outgoing: { shareId: string }[];
    nextCursor: string | null;
  };
  expect(second.outgoing).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.outgoing, ...second.outgoing].map((row) => row.shareId)).size).toBe(101);
});

it("all sharing routes require a current device-bound Session and same-origin proof", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const targetId = await treeChild(owner, owner.rootId, "file");
  const active = await grant(owner, recipient, targetId);
  const pendingTarget = await treeChild(owner, owner.rootId, "file");
  const pending = await invite(owner, recipient, pendingTarget);
  const routes: Array<[string, "POST" | "PUT" | "PATCH" | "DELETE", object | undefined]> = [
    ["/api/private/shares", "POST", undefined],
    ["/api/private/grants", "POST", undefined],
    ["/api/private/shares", "PUT", { targetId, recipient: { shareId: recipient.shareId }, permission: "read_only" }],
    [`/api/private/shares/${pending.shareId}/accept`, "POST", {}],
    [`/api/private/shares/${pending.shareId}/decline`, "POST", {}],
    [`/api/private/shares/${pending.shareId}`, "DELETE", {}],
    [`/api/private/grants/${active.grantId}`, "PATCH", { expectedRevision: 1, permission: "read_write" }],
    [`/api/private/grants/${active.grantId}`, "DELETE", { expectedRevision: 1 }],
    [`/api/private/grants/${active.grantId}/leave`, "POST", { expectedRevision: 1 }],
  ];
  for (const [path, method, body] of routes) {
    const response = await SELF.fetch(`https://mdwn.test${path}`, {
      method,
      headers: {
        cookie: owner.session.cookie,
        origin: "https://mdwn.test",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(response.status, `missing proof: ${path}`).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  const originFailure = await SELF.fetch("https://mdwn.test/api/private/shares", {
    method: "POST",
    headers: {
      cookie: owner.session.cookie,
      origin: "https://evil.test",
    },
  });
  expect(originFailure.status).toBe(403);
  await env.DB.prepare("UPDATE sessions SET device_id = NULL WHERE id = ?").bind(owner.session.id).run();
  for (const [path, method, body] of routes)
    expect((await sharingRequest(owner, path, method, body)).status, path).toBe(403);
});

it("a Collaborator cannot reshare, accept someone else's invitation, or target another Owner's content", async () => {
  const owner = await sharingAccount(),
    collaborator = await sharingAccount(),
    other = await sharingAccount();
  const fileId = await treeChild(owner, owner.rootId, "file");
  const pending = await invite(owner, collaborator, fileId, "read_write");
  expect((await sharingRequest(other, `/api/private/shares/${pending.shareId}/accept`, "POST", {})).status).toBe(404);
  await prepareGrantKeys(owner, pending.shareId);
  expect((await sharingRequest(collaborator, `/api/private/shares/${pending.shareId}/accept`, "POST", {})).status).toBe(
    201,
  );
  expect(
    (
      await sharingRequest(collaborator, "/api/private/shares", "PUT", {
        targetId: fileId,
        recipient: { shareId: other.shareId },
        permission: "read_write",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await sharingRequest(owner, "/api/private/shares", "PUT", {
        targetId: other.rootId,
        recipient: { shareId: collaborator.shareId },
        permission: "read_write",
      })
    ).status,
  ).toBe(404);
});

it("concurrent acceptance creates exactly one active Grant and removes the pending Share atomically", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const targetId = await treeChild(owner, owner.rootId, "file");
  const pending = await invite(owner, recipient, targetId);
  await prepareGrantKeys(owner, pending.shareId);
  const responses = await Promise.all(
    Array.from({ length: 2 }, () =>
      sharingRequest(recipient, `/api/private/shares/${pending.shareId}/accept`, "POST", {}),
    ),
  );
  expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
  expect(responses.filter((response) => response.status === 404 || response.status === 409)).toHaveLength(1);
  expect(await (await sharingRequest(recipient, "/api/private/shares")).json()).toMatchObject({ incoming: [] });
  const active = (await (await sharingRequest(recipient, "/api/private/grants")).json()) as { received: unknown[] };
  expect(active.received).toHaveLength(1);
});

it("returns only the caller's opaque share address through a replayable, read-only proof", async () => {
  const account = await sharingAccount();
  const proof = opaqueId();
  const before = await env.DB.prepare("SELECT count(*) AS total FROM device_proof_uses WHERE account_id = ?")
    .bind(account.accountId)
    .first<{ total: number }>();
  for (let read = 0; read < 2; read++) {
    const response = await sharingRequest(account, "/api/private/shares/address", "POST", undefined, proof);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shareId: account.shareId });
  }
  expect(
    await env.DB.prepare("SELECT count(*) AS total FROM device_proof_uses WHERE account_id = ?")
      .bind(account.accountId)
      .first(),
  ).toEqual(before);
});

it("lists the recipient's share identifier only on rows the caller owns, never the Owner's on recipient rows", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount(),
    stranger = await sharingAccount();
  const pendingTarget = await treeChild(owner, owner.rootId, "directory");
  const grantedTarget = await treeChild(owner, owner.rootId, "file");
  const pending = await invite(owner, recipient, pendingTarget);
  const active = await grant(owner, recipient, grantedTarget, "read_write");
  const ownerShares = (await (await sharingRequest(owner, "/api/private/shares")).json()) as Record<string, unknown>;
  expect(ownerShares).toEqual({
    incoming: [],
    outgoing: [
      {
        shareId: pending.shareId,
        ownerId: owner.accountId,
        recipientId: recipient.accountId,
        recipientShareId: recipient.shareId,
        targetId: pendingTarget,
        targetKind: "directory",
        permission: "read_only",
      },
    ],
    nextCursor: null,
  });
  const ownerGrants = (await (await sharingRequest(owner, "/api/private/grants")).json()) as Record<string, unknown>;
  expect(ownerGrants).toMatchObject({
    received: [],
    owned: [{ grantId: active.grantId, recipientShareId: recipient.shareId, targetId: grantedTarget }],
  });
  const recipientShares = await (await sharingRequest(recipient, "/api/private/shares")).text();
  const recipientGrants = await (await sharingRequest(recipient, "/api/private/grants")).text();
  for (const body of [recipientShares, recipientGrants]) {
    expect(body).not.toContain(owner.shareId);
    expect(body).not.toContain(recipient.shareId);
    expect(body).not.toContain("recipientShareId");
  }
  expect(JSON.parse(recipientShares)).toMatchObject({ incoming: [{ shareId: pending.shareId }], outgoing: [] });
  expect(JSON.parse(recipientGrants)).toMatchObject({ received: [{ grantId: active.grantId }], owned: [] });
  for (const path of ["/api/private/shares", "/api/private/grants"]) {
    const unrelated = await sharingRequest(stranger, path);
    expect(unrelated.status).toBe(200);
    expect(await unrelated.json()).toEqual(
      path.endsWith("shares")
        ? { incoming: [], outgoing: [], nextCursor: null }
        : { received: [], owned: [], nextCursor: null },
    );
  }
});
