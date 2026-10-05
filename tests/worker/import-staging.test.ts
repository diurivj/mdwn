import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { generateDirectoryCapabilityKey } from "../../app/crypto/vault";
import { signDeviceProof, sessionBindingDigest } from "../../app/device/proof";
import type { HistoricalComment } from "../../app/archive/format";
import { prepareImportPlan, type ImportPlan } from "../../app/import/plan";
import { reviewImport, type ImportTarget } from "../../app/import/review";
import { analyzeImportSelection, type ImportSource, type ImportSourceFile, type RawImportInput } from "../../app/import/source";
import { encodeImportChunkBody, encodeImportSessionBody } from "../../app/import/staging";
import { createFileHead } from "../../app/tree/file-head";
import { createListingHead } from "../../app/tree/listing";
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

const encoder = new TextEncoder();

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
  return { accountId, rootId, deviceId, assertion, session, rootKey };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function send(f: Fixture, path: string, method: "POST" | "PUT" | "DELETE", body?: Uint8Array): Promise<Response> {
  const url = `https://mdwn.test${path}`;
  const proof = await signDeviceProof(f.assertion.privateKey, {
    sessionBinding: await sessionBindingDigest(f.session.id), deviceId: f.deviceId,
    registryEpoch: 1, method, url, body: body ?? "",
  });
  return SELF.fetch(url, { method, headers: {
    cookie: f.session.cookie, origin: "https://mdwn.test", "X-Mdwn-Device-Proof": JSON.stringify(proof),
    ...(body ? { "content-type": "application/octet-stream" } : {}),
  }, ...(body ? { body: body as BodyInit } : {}) });
}

function collectFiles(children: readonly { kind: string; path: readonly string[]; children?: unknown[]; markdown?: string }[], files: Map<string, ImportSourceFile>): void {
  for (const child of children) {
    if (child.kind === "file") files.set(child.path.join("/"), child as unknown as ImportSourceFile);
    else collectFiles(child.children as never, files);
  }
}

async function buildPlan(f: Fixture, inputs: readonly RawImportInput[],
  options: { comments?: ReadonlyMap<string, readonly HistoricalComment[]>; targetRevision?: number } = {}): Promise<ImportPlan> {
  const source = await analyzeImportSelection(inputs);
  const files = new Map<string, ImportSourceFile>();
  collectFiles(source.roots as never, files);
  return preparePlan(f, source, files, options);
}

async function preparePlan(f: Fixture, source: ImportSource, files: Map<string, ImportSourceFile>,
  options: { comments?: ReadonlyMap<string, readonly HistoricalComment[]>; targetRevision?: number } = {}): Promise<ImportPlan> {
  const target: ImportTarget = { directoryId: f.rootId, keyEpoch: 1, entriesRevision: options.targetRevision ?? 1,
    ownerAccountId: f.accountId, actorAccountId: f.accountId, label: "Files", siblings: [], listing: [] };
  const review = reviewImport(source, target);
  return prepareImportPlan({
    review, files, comments: options.comments ?? source.comments, targetKey: f.rootKey, replacements: new Map(),
    signFileHead: (identity) => createFileHead(f.assertion.privateKey, { ...identity, deviceId: f.deviceId }),
    signListingHead: (input) => createListingHead(input.parentKey, f.assertion.privateKey, {
      vaultId: f.accountId, directoryId: input.directoryId, deviceId: f.deviceId,
      keyEpoch: input.keyEpoch, revision: input.revision, entries: input.entries,
    }),
  });
}

/** Run confirmation: session → every chunk → commit. */
async function runImport(f: Fixture, plan: ImportPlan): Promise<{ session: Response; chunks: Response[]; commit: Response; importId: string }> {
  const session = await send(f, "/api/private/imports", "POST",
    encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope));
  if (!session.ok) return { session, chunks: [], commit: session, importId: "" };
  const { importId } = await session.json() as { importId: string };
  const chunks: Response[] = [];
  for (const chunk of plan.chunks) {
    chunks.push(await send(f, `/api/private/imports/${importId}/chunks/${chunk.sequence}`, "PUT",
      encodeImportChunkBody(chunk.descriptors, chunk.payload)));
  }
  const commit = await send(f, `/api/private/imports/${importId}/commit`, "POST");
  return { session, chunks, commit, importId };
}

describe("import staging session, chunks, and visible-atomic commit", () => {
  it("imports a folder and File so the whole tree appears only at commit", async () => {
    const f = await fixture();
    const plan = await buildPlan(f, [{ path: "notes/draft.md", bytes: encoder.encode("# hello") }]);
    const { session, commit, importId } = await runImport(f, plan);
    expect(session.status).toBe(201);
    expect(commit.status).toBe(200);
    expect(await commit.json()).toMatchObject({ committed: true, entriesRevision: 2 });

    const listing = await send(f, `/api/private/tree/directories/${f.rootId}`, "POST");
    expect(listing.status).toBe(200);
    const body = await listing.json() as { entries: { kind: string }[]; entriesRevision: number };
    expect(body.entriesRevision).toBe(2);
    expect(body.entries.map((entry) => entry.kind)).toEqual(["directory"]);

    const nodes = await env.DB.prepare("SELECT id, kind, import_id FROM vault_nodes WHERE import_id = ? ORDER BY kind")
      .bind(importId).all<{ id: string; kind: string; import_id: string }>();
    expect(nodes.results.map((row) => row.kind)).toEqual(["directory", "file"]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM import_commits WHERE import_id = ?").bind(importId)
      .first<{ n: number }>())?.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM import_records WHERE import_id = ?").bind(importId)
      .first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare("SELECT state FROM import_sessions WHERE id = ?").bind(importId)
      .first<{ state: string }>())?.state).toBe("committed");
  });

  it("returns the original success for an exact chunk retry and fails a different body permanently", async () => {
    const f = await fixture();
    const plan = await buildPlan(f, [{ path: "draft.md", bytes: encoder.encode("# one") }]);
    const session = await send(f, "/api/private/imports", "POST",
      encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope));
    const { importId } = await session.json() as { importId: string };
    const chunkBody = encodeImportChunkBody(plan.chunks[0]!.descriptors, plan.chunks[0]!.payload);
    expect((await send(f, `/api/private/imports/${importId}/chunks/0`, "PUT", chunkBody)).status).toBe(201);
    const retry = await send(f, `/api/private/imports/${importId}/chunks/0`, "PUT", chunkBody);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ retried: true });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM import_chunks WHERE import_id = ?").bind(importId)
      .first<{ n: number }>())?.n).toBe(1);

    const other = await buildPlan(f, [{ path: "draft.md", bytes: encoder.encode("# two") }]);
    const otherBody = encodeImportChunkBody(other.chunks[0]!.descriptors, other.chunks[0]!.payload);
    expect((await send(f, `/api/private/imports/${importId}/chunks/0`, "PUT", otherBody)).status).toBe(409);
    expect((await env.DB.prepare("SELECT state FROM import_sessions WHERE id = ?").bind(importId)
      .first<{ state: string }>())?.state).toBe("failed");
    expect((await send(f, `/api/private/imports/${importId}/commit`, "POST")).status).toBe(409);
  });

  it("rejects malformed, over-limit, and over-count framing before any write", async () => {
    const f = await fixture();
    const plan = await buildPlan(f, [{ path: "draft.md", bytes: encoder.encode("x") }]);
    const session = await send(f, "/api/private/imports", "POST",
      encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope));
    const { importId } = await session.json() as { importId: string };

    const magic = encoder.encode("mdwn/import-chunk/v1\0");
    const tooMany = new Uint8Array([...magic, 51]);
    expect((await send(f, `/api/private/imports/${importId}/chunks/0`, "PUT", tooMany)).status).toBe(400);
    const overPayload = encodeImportChunkBody(plan.chunks[0]!.descriptors, plan.chunks[0]!.payload);
    const last = overPayload.at(-1)!;
    overPayload.set([last ^ 0xff], overPayload.length - 1);
    expect((await send(f, `/api/private/imports/${importId}/chunks/0`, "PUT", overPayload)).status).toBe(400);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM import_chunks WHERE import_id = ?").bind(importId)
      .first<{ n: number }>())?.n).toBe(0);
  });

  it("enforces D1 CHECK bounds on staging rows and requires the commit marker", async () => {
    const f = await fixture();
    const oversized = new Uint8Array(524_289);
    await expect(env.DB.prepare(`INSERT INTO import_chunks (import_id, sequence, payload, digest, descriptor_count, body_digest, received_at)
      VALUES ('missing', 0, ?, zeroblob(32), 1, zeroblob(32), 0)`).bind(oversized).run()).rejects.toThrow();
    await expect(env.DB.prepare(`INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, import_id, created_at, updated_at)
      VALUES (?, 'file', ?, NULL, ?, 0, 0)`).bind(id(), f.accountId, id()).run()).rejects.toThrow();
  });

  it("creates no marker or visible content for a stale target revision", async () => {
    const f = await fixture();
    const plan = await buildPlan(f, [{ path: "draft.md", bytes: encoder.encode("x") }], { targetRevision: 2 });
    const { importId } = await (async () => {
      const session = await send(f, "/api/private/imports", "POST",
        encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope));
      const parsed = await session.json() as { importId: string };
      await send(f, `/api/private/imports/${parsed.importId}/chunks/0`, "PUT",
        encodeImportChunkBody(plan.chunks[0]!.descriptors, plan.chunks[0]!.payload));
      return parsed;
    })();
    expect((await send(f, `/api/private/imports/${importId}/commit`, "POST")).status).toBe(409);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM import_commits WHERE import_id = ?").bind(importId)
      .first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM vault_nodes WHERE import_id = ?").bind(importId)
      .first<{ n: number }>())?.n).toBe(0);
  });

  it("cleans up expired and cancelled sessions without visible content", async () => {
    const f = await fixture();
    const plan = await buildPlan(f, [{ path: "draft.md", bytes: encoder.encode("x") }]);
    const session = await send(f, "/api/private/imports", "POST",
      encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope));
    const { importId } = await session.json() as { importId: string };
    await send(f, `/api/private/imports/${importId}/chunks/0`, "PUT",
      encodeImportChunkBody(plan.chunks[0]!.descriptors, plan.chunks[0]!.payload));
    expect((await send(f, `/api/private/imports/${importId}`, "DELETE")).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM import_chunks WHERE import_id = ?").bind(importId)
      .first<{ n: number }>())?.n).toBe(0);

    const second = await send(f, "/api/private/imports", "POST",
      encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope));
    const expired = (await second.json() as { importId: string }).importId;
    await send(f, `/api/private/imports/${expired}/chunks/0`, "PUT",
      encodeImportChunkBody(plan.chunks[0]!.descriptors, plan.chunks[0]!.payload));
    await env.DB.prepare("UPDATE import_sessions SET expires_at = created_at + 1 WHERE id = ?").bind(expired).run();
    expect((await send(f, `/api/private/imports/${expired}/commit`, "POST")).status).toBe(410);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM import_sessions WHERE id = ?").bind(expired)
      .first<{ n: number }>())?.n).toBe(0);
  });

  it("stages Historical Comments as a fresh Private thread readable by File access", async () => {
    const f = await fixture();
    const comments: HistoricalComment[] = [
      { sequence: 1, text: "first", pseudonym: "Old Me", createdAt: 1_000, updatedAt: 1_000 },
      { sequence: 2, text: "second", pseudonym: "Old Me", createdAt: 2_000, updatedAt: 2_000 },
    ];
    const source: ImportSource = {
      kind: "loose",
      roots: [{ kind: "file", path: ["draft.md"], name: "draft.md", markdown: "# hi", bytes: 4 }],
      nodes: [{ path: "draft.md", kind: "file", name: "draft.md" }],
      comments: new Map([["draft.md", comments]]),
      nodeCount: 1, maxDepth: 0, sourceBytes: 4, compressedBytes: null, expandedBytes: 4, commentCount: 2,
    };
    const files = new Map<string, ImportSourceFile>([["draft.md", source.roots[0] as ImportSourceFile]]);
    const plan = await preparePlan(f, source, files);
    const { commit } = await runImport(f, plan);
    expect(commit.status).toBe(200);
    const fileId = (await env.DB.prepare("SELECT id FROM vault_nodes WHERE import_id = ? AND kind = 'file'")
      .bind(plan.importId).first<{ id: string }>())!.id;

    const thread = await send(f, `/api/private/comments/files/${fileId}`, "POST");
    expect(thread.status).toBe(200);
    const body = await thread.json() as { thread: { envelope: { mode: string } } | null;
      comments: { sequence: number; createdAt: number }[] };
    expect(body.thread?.envelope.mode).toBe("import");
    expect(body.comments.map((comment) => comment.sequence)).toEqual([1, 2]);
    expect(body.comments[0]!.createdAt).toBe(1_000);
  });

  it("rejects a session body whose manifest digest does not match", async () => {
    const f = await fixture();
    const plan = await buildPlan(f, [{ path: "draft.md", bytes: encoder.encode("x") }]);
    const body = encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope);
    body[body.length - 1] = body[body.length - 1]! ^ 0xff;
    const response = await send(f, "/api/private/imports", "POST", body);
    expect(response.status).toBe(400);
  });
});

