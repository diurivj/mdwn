import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { generateDirectoryCapabilityKey } from "../../app/shared/crypto/vault";
import { signDeviceProof, sessionBindingDigest } from "../../app/shared/device/proof";
import type { HistoricalComment } from "../../app/shared/archive/format";
import { prepareImportPlan, type ImportPlan, type ImportReplacementDocument } from "../../app/shared/import/plan";
import { reviewImport, type ImportChoice, type ImportTarget } from "../../app/shared/import/review";
import {
  analyzeImportSelection,
  type ImportSource,
  type ImportSourceFile,
  type RawImportInput,
} from "../../app/shared/import/source";
import { encodeImportChunkBody, encodeImportSessionBody } from "../../app/shared/import/staging";
import { createFileHead } from "../../app/shared/tree/file-head";
import { createListingHead } from "../../app/shared/tree/listing";
import { seedNormalSession } from "./auth-fixtures";

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

const encoder = new TextEncoder();

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
  return { accountId, rootId, deviceId, assertion, session, rootKey };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function send(f: Fixture, path: string, method: "POST" | "PUT" | "DELETE", body?: Uint8Array): Promise<Response> {
  const url = `https://mdwn.test${path}`;
  const proof = await signDeviceProof(f.assertion.privateKey, {
    sessionBinding: await sessionBindingDigest(f.session.id),
    deviceId: f.deviceId,
    registryEpoch: 1,
    method,
    url,
    body: body ?? "",
  });
  return SELF.fetch(url, {
    method,
    headers: {
      cookie: f.session.cookie,
      origin: "https://mdwn.test",
      "X-Mdwn-Device-Proof": JSON.stringify(proof),
      ...(body ? { "content-type": "application/octet-stream" } : {}),
    },
    ...(body ? { body: body as BodyInit } : {}),
  });
}

function collectFiles(
  children: readonly { kind: string; path: readonly string[]; children?: unknown[]; markdown?: string }[],
  files: Map<string, ImportSourceFile>,
): void {
  for (const child of children) {
    if (child.kind === "file") files.set(child.path.join("/"), child as unknown as ImportSourceFile);
    else collectFiles(child.children as never, files);
  }
}

async function buildPlan(
  f: Fixture,
  inputs: readonly RawImportInput[],
  options: PlanOptions = {},
): Promise<ImportPlan> {
  const source = await analyzeImportSelection(inputs);
  const files = new Map<string, ImportSourceFile>();
  collectFiles(source.roots as never, files);
  return preparePlan(f, source, files, options);
}

type PlanOptions = {
  comments?: ReadonlyMap<string, readonly HistoricalComment[]>;
  targetRevision?: number;
  target?: Partial<ImportTarget>;
  choices?: Record<string, ImportChoice>;
  replacements?: Map<string, ImportReplacementDocument>;
};

async function preparePlan(
  f: Fixture,
  source: ImportSource,
  files: Map<string, ImportSourceFile>,
  options: PlanOptions = {},
): Promise<ImportPlan> {
  const target: ImportTarget = {
    directoryId: f.rootId,
    keyEpoch: 1,
    entriesRevision: options.targetRevision ?? 1,
    ownerAccountId: f.accountId,
    actorAccountId: f.accountId,
    label: "Files",
    siblings: [],
    listing: [],
    ...options.target,
  };
  const review = reviewImport(source, target, options.choices ?? {});
  return prepareImportPlan({
    review,
    files,
    comments: options.comments ?? source.comments,
    targetKey: f.rootKey,
    replacements: options.replacements ?? new Map(),
    signFileHead: (identity) => createFileHead(f.assertion.privateKey, { ...identity, deviceId: f.deviceId }),
    signListingHead: (input) =>
      createListingHead(input.parentKey, f.assertion.privateKey, {
        vaultId: f.accountId,
        directoryId: input.directoryId,
        deviceId: f.deviceId,
        keyEpoch: input.keyEpoch,
        revision: input.revision,
        entries: input.entries,
      }),
  });
}

/** Run confirmation: session → every chunk → commit. */
async function runImport(
  f: Fixture,
  plan: ImportPlan,
): Promise<{ session: Response; chunks: Response[]; commit: Response; importId: string }> {
  const session = await send(
    f,
    "/api/private/imports",
    "POST",
    encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope),
  );
  if (!session.ok) return { session, chunks: [], commit: session, importId: "" };
  const { importId } = (await session.json()) as { importId: string };
  const chunks: Response[] = [];
  for (const chunk of plan.chunks) {
    chunks.push(
      await send(
        f,
        `/api/private/imports/${importId}/chunks/${chunk.sequence}`,
        "PUT",
        encodeImportChunkBody(chunk.descriptors, chunk.payload),
      ),
    );
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
    const body = (await listing.json()) as { entries: { kind: string }[]; entriesRevision: number };
    expect(body.entriesRevision).toBe(2);
    expect(body.entries.map((entry) => entry.kind)).toEqual(["directory"]);

    const nodes = await env.DB.prepare("SELECT id, kind, import_id FROM vault_nodes WHERE import_id = ? ORDER BY kind")
      .bind(importId)
      .all<{ id: string; kind: string; import_id: string }>();
    expect(nodes.results.map((row) => row.kind)).toEqual(["directory", "file"]);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM import_commits WHERE import_id = ?")
          .bind(importId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM import_records WHERE import_id = ?")
          .bind(importId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (await env.DB.prepare("SELECT state FROM import_sessions WHERE id = ?").bind(importId).first<{ state: string }>())
        ?.state,
    ).toBe("committed");
  });

  it("returns the original success for an exact chunk retry and fails a different body permanently", async () => {
    const f = await fixture();
    const plan = await buildPlan(f, [{ path: "draft.md", bytes: encoder.encode("# one") }]);
    const session = await send(
      f,
      "/api/private/imports",
      "POST",
      encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope),
    );
    const { importId } = (await session.json()) as { importId: string };
    const chunkBody = encodeImportChunkBody(plan.chunks[0]!.descriptors, plan.chunks[0]!.payload);
    expect((await send(f, `/api/private/imports/${importId}/chunks/0`, "PUT", chunkBody)).status).toBe(201);
    const retry = await send(f, `/api/private/imports/${importId}/chunks/0`, "PUT", chunkBody);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ retried: true });
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM import_chunks WHERE import_id = ?")
          .bind(importId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);

    const other = await buildPlan(f, [{ path: "draft.md", bytes: encoder.encode("# two") }]);
    const otherBody = encodeImportChunkBody(other.chunks[0]!.descriptors, other.chunks[0]!.payload);
    expect((await send(f, `/api/private/imports/${importId}/chunks/0`, "PUT", otherBody)).status).toBe(409);
    expect(
      (await env.DB.prepare("SELECT state FROM import_sessions WHERE id = ?").bind(importId).first<{ state: string }>())
        ?.state,
    ).toBe("failed");
    // The failed session's staged payload is deleted immediately, not at expiry.
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM import_records WHERE import_id = ?")
          .bind(importId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM import_chunks WHERE import_id = ?")
          .bind(importId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect((await send(f, `/api/private/imports/${importId}/commit`, "POST")).status).toBe(409);
  });

  it("rejects malformed, over-limit, and over-count framing before any write", async () => {
    const f = await fixture();
    const plan = await buildPlan(f, [{ path: "draft.md", bytes: encoder.encode("x") }]);
    const session = await send(
      f,
      "/api/private/imports",
      "POST",
      encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope),
    );
    const { importId } = (await session.json()) as { importId: string };

    const magic = encoder.encode("mdwn/import-chunk/v1\0");
    const tooMany = new Uint8Array([...magic, 51]);
    expect((await send(f, `/api/private/imports/${importId}/chunks/0`, "PUT", tooMany)).status).toBe(400);
    const overPayload = encodeImportChunkBody(plan.chunks[0]!.descriptors, plan.chunks[0]!.payload);
    const last = overPayload.at(-1)!;
    overPayload.set([last ^ 0xff], overPayload.length - 1);
    expect((await send(f, `/api/private/imports/${importId}/chunks/0`, "PUT", overPayload)).status).toBe(400);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM import_chunks WHERE import_id = ?")
          .bind(importId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  it("enforces D1 CHECK bounds on staging rows and requires the commit marker", async () => {
    const f = await fixture();
    const plan = await buildPlan(f, [{ path: "draft.md", bytes: encoder.encode("x") }]);
    const { importId } = await (async () => {
      const session = await send(
        f,
        "/api/private/imports",
        "POST",
        encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope),
      );
      return (await session.json()) as { importId: string };
    })();
    const bind = (sql: string, ...values: unknown[]) => env.DB.prepare(sql).bind(...(values as never[]));
    // One unit over a 512 KiB chunk payload, a 51st descriptor, sequence 40,
    // and a 128 KiB+1 manifest are all rejected by the schema itself.
    await expect(
      bind(
        `INSERT INTO import_chunks (import_id, sequence, payload, digest, descriptor_count, received_at)
      VALUES (?, 0, ?, zeroblob(32), 1, 0)`,
        importId,
        new Uint8Array(524_289),
      ).run(),
    ).rejects.toThrow();
    await expect(
      bind(
        `INSERT INTO import_chunks (import_id, sequence, payload, digest, descriptor_count, received_at)
      VALUES (?, 0, zeroblob(1), zeroblob(32), 51, 0)`,
        importId,
      ).run(),
    ).rejects.toThrow();
    await expect(
      bind(
        `INSERT INTO import_chunks (import_id, sequence, payload, digest, descriptor_count, received_at)
      VALUES (?, 40, zeroblob(1), zeroblob(32), 1, 0)`,
        importId,
      ).run(),
    ).rejects.toThrow();
    await expect(
      bind(`UPDATE import_sessions SET manifest_ciphertext = zeroblob(131073) WHERE id = ?`, importId).run(),
    ).rejects.toThrow();
    expect(
      (
        await env.DB.prepare(`SELECT length(manifest_ciphertext) AS n FROM import_sessions WHERE id = ?`)
          .bind(importId)
          .first<{ n: number }>()
      )?.n,
    ).toBeLessThanOrEqual(131_072);
    await expect(
      bind(
        `INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, import_id, created_at, updated_at)
      VALUES (?, 'file', ?, NULL, ?, 0, 0)`,
        id(),
        f.accountId,
        id(),
      ).run(),
    ).rejects.toThrow();
  });

  it("rejects a commit whose recorded target Owner no longer matches", async () => {
    const f = await fixture();
    const plan = await buildPlan(f, [{ path: "draft.md", bytes: encoder.encode("x") }]);
    const { importId } = await (async () => {
      const session = await send(
        f,
        "/api/private/imports",
        "POST",
        encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope),
      );
      const parsed = (await session.json()) as { importId: string };
      await send(
        f,
        `/api/private/imports/${parsed.importId}/chunks/0`,
        "PUT",
        encodeImportChunkBody(plan.chunks[0]!.descriptors, plan.chunks[0]!.payload),
      );
      return parsed;
    })();
    const other = id(),
      at = Date.now();
    await env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(other, id(), at, at)
      .run();
    await env.DB.prepare("UPDATE import_sessions SET target_owner_id = ? WHERE id = ?").bind(other, importId).run();
    expect((await send(f, `/api/private/imports/${importId}/commit`, "POST")).status).toBe(409);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM import_commits WHERE import_id = ?")
          .bind(importId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  it("creates no marker or visible content for a stale target revision", async () => {
    const f = await fixture();
    const plan = await buildPlan(f, [{ path: "draft.md", bytes: encoder.encode("x") }], { targetRevision: 2 });
    const { importId } = await (async () => {
      const session = await send(
        f,
        "/api/private/imports",
        "POST",
        encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope),
      );
      const parsed = (await session.json()) as { importId: string };
      await send(
        f,
        `/api/private/imports/${parsed.importId}/chunks/0`,
        "PUT",
        encodeImportChunkBody(plan.chunks[0]!.descriptors, plan.chunks[0]!.payload),
      );
      return parsed;
    })();
    expect((await send(f, `/api/private/imports/${importId}/commit`, "POST")).status).toBe(409);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM import_commits WHERE import_id = ?")
          .bind(importId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM vault_nodes WHERE import_id = ?")
          .bind(importId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  it("cleans up expired and cancelled sessions without visible content", async () => {
    const f = await fixture();
    const plan = await buildPlan(f, [{ path: "draft.md", bytes: encoder.encode("x") }]);
    const session = await send(
      f,
      "/api/private/imports",
      "POST",
      encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope),
    );
    const { importId } = (await session.json()) as { importId: string };
    await send(
      f,
      `/api/private/imports/${importId}/chunks/0`,
      "PUT",
      encodeImportChunkBody(plan.chunks[0]!.descriptors, plan.chunks[0]!.payload),
    );
    expect((await send(f, `/api/private/imports/${importId}`, "DELETE")).status).toBe(200);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM import_chunks WHERE import_id = ?")
          .bind(importId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);

    const second = await send(
      f,
      "/api/private/imports",
      "POST",
      encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope),
    );
    const expired = ((await second.json()) as { importId: string }).importId;
    await send(
      f,
      `/api/private/imports/${expired}/chunks/0`,
      "PUT",
      encodeImportChunkBody(plan.chunks[0]!.descriptors, plan.chunks[0]!.payload),
    );
    await env.DB.prepare("UPDATE import_sessions SET expires_at = created_at + 1 WHERE id = ?").bind(expired).run();
    expect((await send(f, `/api/private/imports/${expired}/commit`, "POST")).status).toBe(410);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM import_sessions WHERE id = ?")
          .bind(expired)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  it("leaves a staged Replace current until the commit, then moves it atomically", async () => {
    const f = await fixture();
    const fileId = id(),
      representationId = id(),
      capabilityId = id(),
      contentKeyId = id();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at) VALUES (?, 'file', ?, ?, ?, ?)",
      ).bind(fileId, f.accountId, f.rootId, now, now),
      env.DB.prepare(
        "INSERT INTO files (node_id, owner_id, current_representation_id, current_revision, capability_id, capability_epoch) VALUES (?, ?, ?, 1, ?, 1)",
      ).bind(fileId, f.accountId, representationId, capabilityId),
      env.DB.prepare(`INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id, name_ciphertext, order_ciphertext, key_envelope)
        VALUES (?, ?, ?, X'01', X'02', X'03')`).bind(fileId, f.accountId, f.rootId),
      env.DB.prepare(`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id, key_epoch,
        ciphertext, ciphertext_size, created_at) VALUES (?, ?, ?, 1, ?, 1, X'01', 1, ?)`).bind(
        representationId,
        fileId,
        f.accountId,
        contentKeyId,
        now,
      ),
    ]);
    const source = await analyzeImportSelection([{ path: "draft.md", bytes: encoder.encode("# replaced") }]);
    const files = new Map<string, ImportSourceFile>();
    collectFiles(source.roots as never, files);
    const document: ImportReplacementDocument = {
      revision: 1,
      keyEpoch: 1,
      contentKeyId,
      representationId,
      markdown: "old",
      metadata: new Uint8Array(),
      capability: { id: capabilityId, epoch: 1 },
      capabilityKey: crypto.getRandomValues(new Uint8Array(32)),
      publication: null,
    };
    const plan = await preparePlan(f, source, files, {
      target: { siblings: [{ nodeId: fileId, kind: "file", name: "draft.md" }] },
      choices: { "draft.md": { action: "replace" } },
      replacements: new Map([[fileId, document]]),
    });
    const session = await send(
      f,
      "/api/private/imports",
      "POST",
      encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope),
    );
    const { importId } = (await session.json()) as { importId: string };
    for (const chunk of plan.chunks) {
      expect(
        (
          await send(
            f,
            `/api/private/imports/${importId}/chunks/${chunk.sequence}`,
            "PUT",
            encodeImportChunkBody(chunk.descriptors, chunk.payload),
          )
        ).status,
      ).toBe(201);
    }
    const before = await env.DB.prepare("SELECT current_representation_id FROM files WHERE node_id = ?")
      .bind(fileId)
      .first<{ current_representation_id: string }>();
    expect(before?.current_representation_id).toBe(representationId);
    expect((await send(f, `/api/private/imports/${importId}/commit`, "POST")).status).toBe(200);
    const after = await env.DB.prepare(
      "SELECT current_revision, current_representation_id FROM files WHERE node_id = ?",
    )
      .bind(fileId)
      .first<{ current_revision: number; current_representation_id: string }>();
    expect(after?.current_revision).toBe(2);
    expect(after?.current_representation_id).not.toBe(representationId);
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
      nodeCount: 1,
      maxDepth: 0,
      sourceBytes: 4,
      compressedBytes: null,
      expandedBytes: 4,
      commentCount: 2,
    };
    const files = new Map<string, ImportSourceFile>([["draft.md", source.roots[0] as ImportSourceFile]]);
    const plan = await preparePlan(f, source, files);
    const { commit } = await runImport(f, plan);
    expect(commit.status).toBe(200);
    const fileId = (await env.DB.prepare("SELECT id FROM vault_nodes WHERE import_id = ? AND kind = 'file'")
      .bind(plan.importId)
      .first<{ id: string }>())!.id;

    const thread = await send(f, `/api/private/comments/files/${fileId}`, "POST");
    expect(thread.status).toBe(200);
    const body = (await thread.json()) as {
      thread: { envelope: { mode: string } } | null;
      comments: { sequence: number; createdAt: number; metaCiphertext: string | null }[];
    };
    expect(body.thread?.envelope.mode).toBe("import");
    expect(body.comments.map((comment) => comment.sequence)).toEqual([1, 2]);
    // Historical display timestamps are sealed ciphertext, never plaintext D1 values.
    expect(
      body.comments.every((comment) => typeof comment.metaCiphertext === "string" && comment.metaCiphertext.length > 0),
    ).toBe(true);
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
