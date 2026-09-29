import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { actor, call, directory, state, uuid7, type Actor } from "./tree-fixtures";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const root = (who: Actor) => state(who, who.accountId, who.rootId, who.rootKey);

async function grant(owner: Actor, recipient: Actor, target: string, kind: "file" | "directory",
  permission: "read_only" | "read_write") {
  const id = uuid7(), now = Date.now();
  await env.DB.prepare(`INSERT INTO grants (id, owner_id, recipient_id, target_node_id, target_kind, permission,
    generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .bind(id, owner.accountId, recipient.accountId, target, kind, permission, now, now).run();
  return id;
}

async function job(ownerId: string, targetId: string) {
  return env.DB.prepare(`SELECT mode, barrier_epoch, cursor FROM sharing_rotation_jobs
    WHERE owner_id = ? AND target_node_id = ?`).bind(ownerId, targetId)
    .first<{ mode: string; barrier_epoch: number; cursor: string | null }>();
}

describe("rotation jobs", () => {
  it("records reprovision for a permission change and never weakens a pending rekey", async () => {
    const owner = await actor(), a = await actor(), b = await actor();
    const folder = await directory(owner, owner.accountId, await root(owner), "Team");
    const first = await grant(owner, a, folder.nodeId, "directory", "read_only");
    const second = await grant(owner, b, folder.nodeId, "directory", "read_only");
    expect((await call(owner, `/api/private/sharing/grants/${first}`, "PATCH", { permission: "read_write" })).status)
      .toBe(200);
    expect(await job(owner.accountId, folder.nodeId)).toMatchObject({ mode: "reprovision", cursor: null });
    expect((await call(owner, `/api/private/sharing/grants/${first}`, "DELETE")).status).toBe(200);
    expect(await job(owner.accountId, folder.nodeId)).toMatchObject({ mode: "rekey" });
    // A later permission change on another Grant keeps the rekey and restarts it at a new barrier epoch.
    const before = (await job(owner.accountId, folder.nodeId))!.barrier_epoch;
    expect((await call(owner, `/api/private/sharing/grants/${second}`, "PATCH", { permission: "read_write" })).status)
      .toBe(200);
    expect(await job(owner.accountId, folder.nodeId)).toMatchObject({ mode: "rekey", cursor: null });
    expect((await job(owner.accountId, folder.nodeId))!.barrier_epoch).toBeGreaterThan(before);
  });

  it("only advances a Directory capability epoch by one", async () => {
    const owner = await actor();
    const folder = await directory(owner, owner.accountId, await root(owner), "Epochs");
    const set = (epoch: number) => env.DB.prepare("UPDATE directories SET capability_epoch = ? WHERE node_id = ?")
      .bind(epoch, folder.nodeId).run();
    await expect(set(3)).rejects.toThrow();
    await expect(set(1)).rejects.toThrow();
    await set(2);
    await expect(set(1)).rejects.toThrow();
  });

  it("never shares the hidden root", async () => {
    const owner = await actor(), recipient = await actor();
    const response = await call(owner, "/api/private/sharing/target", "POST",
      { targetId: owner.rootId, kind: "directory", recipientId: recipient.accountId });
    expect(response.status).toBe(404);
    const folder = await directory(owner, owner.accountId, await root(owner), "Shareable");
    expect((await call(owner, "/api/private/sharing/target", "POST",
      { targetId: folder.nodeId, kind: "directory", recipientId: recipient.accountId })).status).toBe(200);
  });
});
