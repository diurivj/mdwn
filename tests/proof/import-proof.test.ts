/**
 * Disposable remote Workers Free + D1 proof for the Import staging protocol
 * (tickets 26 and 30). Not part of `npm test`; `scripts/import-proof.mjs`
 * provisions the deployment and seeds a device-bound Session, then runs this
 * file once through `vitest.proof.config.ts`.
 *
 * The proof exercises the deployed Free-tier limits end to end: maximum legal
 * 100-node commit, the 40-chunk/20 MiB/50-record/512 KiB upload envelope with
 * one-over rejections, the 128 KiB manifest boundary, every per-kind
 * ciphertext cap, retry/mismatch, cancel/expiry, stale revision/Owner, and
 * no-visible-partial-tree reads. Because D1 Free hard-fails an invocation
 * above 50 queries and Workers Free surfaces CPU-limit errors, a clean pass on
 * a genuine Free account is the statement-budget evidence.
 */

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import type { EnvelopeContext } from "../../app/crypto/enc-v1";
import { createSymmetricWriter } from "../../app/crypto/enc-v1";
import { signDeviceProof, sessionBindingDigest } from "../../app/device/proof";
import { prepareImportPlan, type ImportPlan } from "../../app/import/plan";
import { reviewImport, type ImportTarget } from "../../app/import/review";
import { analyzeImportSelection, type ImportSourceFile, type RawImportInput } from "../../app/import/source";
import {
  IMPORT_RECORD_KINDS, MAX_IMPORT_SESSION_BODY_BYTES, encodeImportChunkBody, encodeImportSessionBody,
  type ImportSessionKindCount, type ImportSessionMetadata, type StagingRecordKind,
} from "../../app/import/staging";
import { createFileHead } from "../../app/tree/file-head";
import { createListingHead } from "../../app/tree/listing";

const env = process.env;
const baseUrl = env.PROOF_BASE_URL ?? "";
const sessionCookie = env.PROOF_SESSION_COOKIE ?? "";
const accountId = env.PROOF_ACCOUNT_ID ?? "";
const rootId = env.PROOF_ROOT_ID ?? "";
const deviceId = env.PROOF_DEVICE_ID ?? "";
const secondAccountId = env.PROOF_SECOND_ACCOUNT_ID ?? "";
const wranglerConfig = env.PROOF_WRANGLER_CONFIG ?? "wrangler.proof.jsonc";
const d1Name = env.PROOF_D1_NAME ?? "mdwn-import-proof-db";
if (!baseUrl || !sessionCookie || !accountId || !rootId || !deviceId || !env.PROOF_DEVICE_JWK) {
  throw new Error("import proof: run through scripts/import-proof.mjs (missing PROOF_* environment)");
}

const encoder = new TextEncoder();
const deviceKey = await crypto.subtle.importKey("jwk", JSON.parse(env.PROOF_DEVICE_JWK!) as JsonWebKey,
  { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
const rootKey = crypto.getRandomValues(new Uint8Array(32));
const sessionBinding = await sessionBindingDigest(env.PROOF_SESSION_ID ?? "");

/** `crypto.getRandomValues` caps at 65,536 bytes per call. */
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65_536, length)));
  }
  return bytes;
}

function uuid(): string {
  const value = crypto.randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

function opaque(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One request against the deployed Worker with a fresh device proof. */
async function proofFetch(path: string, method: "POST" | "PUT" | "DELETE", body?: Uint8Array): Promise<Response> {
  const url = `${baseUrl}${path}`;
  const proof = await signDeviceProof(deviceKey, {
    sessionBinding, deviceId, registryEpoch: 1, method, url, body: body ?? "",
  });
  return fetch(url, {
    method,
    headers: {
      cookie: sessionCookie,
      origin: baseUrl,
      "X-Mdwn-Device-Proof": JSON.stringify(proof),
      ...(body ? { "content-type": "application/octet-stream" } : {}),
    },
    ...(body ? { body: body as BodyInit } : {}),
  });
}

function remoteSql(command: string): { ok: boolean; output: string } {
  const result = spawnSync("npx", [
    "--no-install", "wrangler", "d1", "execute", d1Name, "--remote", "--config", wranglerConfig,
    "--json", "--command", command,
  ], { encoding: "utf8", cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

function scalar(sql: string): string {
  const result = remoteSql(sql);
  if (!result.ok) throw new Error(`remote SQL failed: ${result.output}`);
  const parsed = JSON.parse(result.output.slice(result.output.indexOf("["))) as { results?: Record<string, unknown>[] }[];
  const value = parsed[0]?.results?.[0];
  return value ? String(Object.values(value)[0]) : "";
}

function expectCheckFailure(description: string, sql: string): void {
  const result = remoteSql(sql);
  expect(result.ok, `${description} should be rejected by the deployed D1 CHECK`).toBe(false);
}

/** Seal a valid envelope whose total decoded length is exactly `target`. */
async function sealExact(key: Uint8Array, target: number, context: EnvelopeContext): Promise<Uint8Array> {
  const probe = await (await createSymmetricWriter(key)).seal(new Uint8Array(0), context);
  const plaintext = target - probe.length;
  if (plaintext < 0) throw new Error("seal target below envelope overhead");
  return (await createSymmetricWriter(key)).seal(new Uint8Array(plaintext), context);
}

function descriptor(kind: StagingRecordKind, refs: string[], bytes: Uint8Array, offset: number,
  digest?: string): Promise<{ kind: StagingRecordKind; refs: string[]; offset: number; length: number; digest: string }> {
  return sha256Hex(bytes).then((computed) => ({ kind, refs, offset, length: bytes.length, digest: digest ?? computed }));
}

async function createSession(metadata: ImportSessionMetadata, manifest: Uint8Array): Promise<Response> {
  return proofFetch("/api/private/imports", "POST", encodeImportSessionBody(metadata, manifest));
}

/** Fail with the Worker's error body so a 5xx is diagnosable. */
async function expectStatus(response: Response, status: number, label: string): Promise<void> {
  if (response.status === status) return;
  const text = await response.clone().text();
  throw new Error(`${label}: expected ${status}, got ${response.status}: ${text.slice(0, 2_000)}`);
}

/** Hand-crafted frame with an over-limit declared record length and no payload. */
function rawChunkBody(kind: StagingRecordKind, refs: string[], declaredLength: number): Uint8Array {
  const schema = IMPORT_RECORD_KINDS[kind];
  const refBytes = refs.reduce((total, ref) => total + (ref.length === 36 ? 36 : 43), 0);
  const body = new Uint8Array(21 + 1 + 1 + refBytes + 20 + 32);
  body.set(encoder.encode("mdwn/import-chunk/v1\0"), 0);
  let offset = 21;
  body[offset++] = 1;
  body[offset++] = schema.id;
  for (const ref of refs) {
    const bytes = encoder.encode(ref);
    body.set(bytes, offset);
    offset += bytes.length;
  }
  const view = new DataView(body.buffer);
  view.setBigUint64(offset, 0n);
  view.setBigUint64(offset + 8, BigInt(declaredLength));
  return body;
}

function sessionMetadata(overrides: Partial<ImportSessionMetadata> & { importId: string }): ImportSessionMetadata {
  return {
    targetDirectoryId: rootId,
    reviewedEntryRevision: 1,
    recordCount: 1,
    chunkCount: 1,
    payloadBytes: 1,
    commentCount: 0,
    aggregateDigest: "0".repeat(64),
    manifestDigest: "1".repeat(64),
    kindCounts: [{ kind: "node-file", count: 1 }],
    ...overrides,
  };
}

type PlanOptions = { targetRevision?: number; target?: Partial<ImportTarget> };

async function buildPlan(inputs: readonly RawImportInput[], options: PlanOptions = {}): Promise<ImportPlan> {
  const source = await analyzeImportSelection(inputs);
  const files = new Map<string, ImportSourceFile>();
  const collect = (children: readonly { kind: string; path: readonly string[]; children?: unknown[]; markdown?: string }[]): void => {
    for (const child of children) {
      if (child.kind === "file") files.set(child.path.join("/"), child as ImportSourceFile);
      else collect(child.children as never);
    }
  };
  collect(source.roots as never);
  const target: ImportTarget = {
    directoryId: rootId, keyEpoch: 1, entriesRevision: options.targetRevision ?? 1,
    ownerAccountId: accountId, actorAccountId: accountId, label: "Files", siblings: [], listing: [],
    ...options.target,
  };
  const review = reviewImport(source, target);
  return prepareImportPlan({
    review, files, comments: source.comments, targetKey: rootKey, replacements: new Map(),
    signFileHead: (identity) => createFileHead(deviceKey, { ...identity, deviceId }),
    signListingHead: (input) => createListingHead(input.parentKey, deviceKey, {
      vaultId: accountId, directoryId: input.directoryId, deviceId,
      keyEpoch: input.keyEpoch, revision: input.revision, entries: input.entries,
    }),
  });
}

async function listing(): Promise<{ entriesRevision: number; entries: unknown[] }> {
  const response = await proofFetch(`/api/private/tree/directories/${rootId}`, "POST");
  expect(response.status).toBe(200);
  return response.json() as Promise<{ entriesRevision: number; entries: unknown[] }>;
}

describe("disposable remote Workers Free + D1 import proof", () => {
  it("commits a maximum 100-node import with no visible partial tree", async () => {
    const inputs = Array.from({ length: 100 }, (_, index) => ({
      path: `f${String(index).padStart(3, "0")}.md`, bytes: encoder.encode(`# ${index}`),
    }));
    const plan = await buildPlan(inputs);
    expect(plan.chunks.length).toBeLessThanOrEqual(40);
    const session = await createSession(plan.manifest.metadata, plan.manifest.envelope);
    expect(session.status).toBe(201);
    const { importId } = await session.json() as { importId: string };
    for (const chunk of plan.chunks) {
      const response = await proofFetch(`/api/private/imports/${importId}/chunks/${chunk.sequence}`, "PUT",
        encodeImportChunkBody(chunk.descriptors, chunk.payload));
      expect([200, 201]).toContain(response.status);
    }
    // Staged but uncommitted: the tree still shows the empty initial revision.
    const before = await listing();
    expect(before.entriesRevision).toBe(1);
    expect(before.entries).toEqual([]);
    expect(scalar(`SELECT count(*) FROM vault_nodes WHERE owner_id = '${accountId}' AND import_id = '${importId}'`)).toBe("0");

    const commit = await proofFetch(`/api/private/imports/${importId}/commit`, "POST");
    expect(commit.status).toBe(200);
    expect(await commit.json()).toMatchObject({ committed: true, entriesRevision: 2 });
    const after = await listing();
    expect(after.entriesRevision).toBe(2);
    expect(after.entries).toHaveLength(100);
    expect(scalar(`SELECT count(*) FROM vault_nodes WHERE owner_id = '${accountId}' AND import_id = '${importId}'`)).toBe("100");
    expect(scalar(`SELECT count(*) FROM import_commits WHERE import_id = '${importId}'`)).toBe("1");
    expect(scalar(`SELECT count(*) FROM import_records WHERE import_id = '${importId}'`)).toBe("0");
  });

  it("accepts the exact 20 MiB / 40-chunk / 50-record / 512 KiB upload envelope and rejects one over", async () => {
    const fileId = uuid(), representationId = uuid(), contentKeyId = uuid();
    const context: EnvelopeContext = { purpose: "file-content", vaultId: accountId, objectId: fileId,
      keyId: contentKeyId, keyEpoch: 1, revision: 1 };
    const representation = await sealExact(crypto.getRandomValues(new Uint8Array(32)), 524_288, context);
    expect(representation.length).toBe(524_288);
    const kindCounts: ImportSessionKindCount[] = [
      { kind: "representation", count: 40 }, { kind: "node-file", count: 1_960 },
    ];
    const importId = opaque();
    const metadata = sessionMetadata({ importId, recordCount: 2_000, chunkCount: 40,
      payloadBytes: 20_971_520, kindCounts });
    const manifest = crypto.getRandomValues(new Uint8Array(64));
    const session = await createSession({ ...metadata, manifestDigest: await sha256Hex(manifest),
      aggregateDigest: "0".repeat(64) }, manifest);
    await expectStatus(session, 201, "20 MiB boundary session");
    for (let sequence = 0; sequence < 40; sequence++) {
      const descriptors = [await descriptor("representation", [fileId, representationId, contentKeyId], representation, 0)];
      for (let index = 0; index < 49; index++) {
        descriptors.push(await descriptor("node-file", [uuid(), rootId], new Uint8Array(), 524_288));
      }
      const body = encodeImportChunkBody(descriptors, representation);
      expect(body.length).toBeLessThanOrEqual(524_288 + 20_000);
      const response = await proofFetch(`/api/private/imports/${importId}/chunks/${sequence}`, "PUT", body);
      expect(response.status).toBe(201);
    }
    expect(scalar(`SELECT uploaded_chunks FROM import_sessions WHERE id = '${importId}'`)).toBe("40");
    expect(scalar(`SELECT uploaded_records FROM import_sessions WHERE id = '${importId}'`)).toBe("2000");
    expect(scalar(`SELECT uploaded_bytes FROM import_sessions WHERE id = '${importId}'`)).toBe("20971520");

    // A 41st chunk, a payload one byte over, and a 51st descriptor are rejected.
    const extra = await proofFetch(`/api/private/imports/${importId}/chunks/40`, "PUT",
      encodeImportChunkBody([await descriptor("node-file", [uuid(), rootId], new Uint8Array(), 0)], new Uint8Array()));
    expect(extra.status).toBe(400);
    const oneOverPayload = encodeImportChunkBody([await descriptor("node-file", [uuid(), rootId], new Uint8Array(), 0)], new Uint8Array());
    const appended = new Uint8Array([...oneOverPayload, 0]);
    expect((await proofFetch(`/api/private/imports/${importId}/chunks/0`, "PUT", appended)).status).toBe(400);
    const tooManyDescriptors = new Uint8Array([...encoder.encode("mdwn/import-chunk/v1\0"), 51]);
    expect((await proofFetch(`/api/private/imports/${importId}/chunks/0`, "PUT", tooManyDescriptors)).status).toBe(400);
  });

  it("accepts a manifest of exactly 131,072 bytes and rejects 131,073", async () => {
    const exact = randomBytes(131_072);
    const accepted = await createSession(sessionMetadata({ importId: opaque(), manifestDigest: await sha256Hex(exact) }), exact);
    await expectStatus(accepted, 201, "exact manifest session");
    const over = randomBytes(131_073);
    const rejected = await createSession(sessionMetadata({ importId: opaque(), manifestDigest: await sha256Hex(over) }), over);
    expect(rejected.status).toBe(400);
    expect(over.length).toBeLessThan(MAX_IMPORT_SESSION_BODY_BYTES);
  });

  it("accepts every per-kind ciphertext cap at its exact size and rejects one byte over", async () => {
    const nodeId = uuid(), parentId = uuid(), commentId = uuid(), capabilityId = uuid();
    const key = crypto.getRandomValues(new Uint8Array(32));
    const exactCases: { kind: StagingRecordKind; refs: string[]; context: EnvelopeContext }[] = [
      { kind: "entry-name", refs: [nodeId, parentId], context: { purpose: "directory-metadata", vaultId: accountId, objectId: nodeId, keyId: parentId, keyEpoch: 1, revision: 1 } },
      { kind: "directory-capability", refs: [nodeId, parentId], context: { purpose: "directory-capability", vaultId: accountId, objectId: nodeId, keyId: nodeId, keyEpoch: 1, revision: 1 } },
      { kind: "comment-body", refs: [nodeId, commentId], context: { purpose: "comment-content", vaultId: accountId, objectId: commentId, keyId: commentId, keyEpoch: 1, revision: 1 } },
      { kind: "comment-attribution", refs: [nodeId, commentId], context: { purpose: "attribution", vaultId: accountId, objectId: commentId, keyId: commentId, keyEpoch: 1, revision: 1 } },
      { kind: "comment-key", refs: [nodeId, commentId], context: { purpose: "comment-content", vaultId: accountId, objectId: commentId, keyId: capabilityId, keyEpoch: 1, revision: 1 } },
    ];
    const importId = opaque();
    const metadata = sessionMetadata({ importId, recordCount: exactCases.length, commentCount: 1,
      kindCounts: exactCases.map((item) => ({ kind: item.kind, count: 1 })), payloadBytes: 57_344 });
    const manifest = crypto.getRandomValues(new Uint8Array(32));
    const session = await createSession({ ...metadata, manifestDigest: await sha256Hex(manifest) }, manifest);
    await expectStatus(session, 201, "per-kind cap session");
    const records: { bytes: Uint8Array; offset: number }[] = [];
    const descriptors = [];
    let offset = 0;
    for (const item of exactCases) {
      const limit = IMPORT_RECORD_KINDS[item.kind].max;
      const bytes = await sealExact(key, limit, item.context);
      records.push({ bytes, offset });
      descriptors.push(await descriptor(item.kind, item.refs, bytes, offset));
      offset += bytes.length;
    }
    const payload = new Uint8Array(offset);
    for (const record of records) payload.set(record.bytes, record.offset);
    try {
      expect((await proofFetch(`/api/private/imports/${importId}/chunks/0`, "PUT",
        encodeImportChunkBody(descriptors, payload))).status).toBe(201);
    } catch (error) {
      console.error("per-kind cap lengths", descriptors.map((item) => [item.kind, item.length, item.offset]));
      throw error;
    }

    // Raw framing bypasses the browser encoder so the Worker itself must
    // reject the one-over declared length.
    for (const item of exactCases) {
      const body = rawChunkBody(item.kind, item.refs, IMPORT_RECORD_KINDS[item.kind].max + 1);
      expect((await proofFetch(`/api/private/imports/${importId}/chunks/1`, "PUT", body)).status,
        `${item.kind} one over`).toBe(400);
    }
    expect((await proofFetch(`/api/private/imports/${importId}/chunks/2`, "PUT",
      rawChunkBody("representation", [uuid(), uuid(), uuid()], 524_289))).status).toBe(400);
  });

  it("is idempotent for an exact retry and permanently fails a mismatched replay", async () => {
    const plan = await buildPlan([{ path: "draft.md", bytes: encoder.encode("# one") }]);
    const session = await createSession(plan.manifest.metadata, plan.manifest.envelope);
    const { importId } = await session.json() as { importId: string };
    const body = encodeImportChunkBody(plan.chunks[0]!.descriptors, plan.chunks[0]!.payload);
    expect((await proofFetch(`/api/private/imports/${importId}/chunks/0`, "PUT", body)).status).toBe(201);
    const retry = await proofFetch(`/api/private/imports/${importId}/chunks/0`, "PUT", body);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ retried: true });

    const other = await buildPlan([{ path: "draft.md", bytes: encoder.encode("# two") }]);
    const mismatch = await proofFetch(`/api/private/imports/${importId}/chunks/0`, "PUT",
      encodeImportChunkBody(other.chunks[0]!.descriptors, other.chunks[0]!.payload));
    expect(mismatch.status).toBe(409);
    expect(scalar(`SELECT state FROM import_sessions WHERE id = '${importId}'`)).toBe("failed");
    expect(scalar(`SELECT count(*) FROM import_chunks WHERE import_id = '${importId}'`)).toBe("0");
    expect(scalar(`SELECT count(*) FROM import_records WHERE import_id = '${importId}'`)).toBe("0");
    expect((await proofFetch(`/api/private/imports/${importId}/commit`, "POST")).status).toBe(409);
    expect(scalar(`SELECT count(*) FROM import_commits WHERE import_id = '${importId}'`)).toBe("0");
  });

  it("cancels a session and cleans every staged row", async () => {
    const plan = await buildPlan([{ path: "draft.md", bytes: encoder.encode("x") }]);
    const session = await createSession(plan.manifest.metadata, plan.manifest.envelope);
    const { importId } = await session.json() as { importId: string };
    await proofFetch(`/api/private/imports/${importId}/chunks/0`, "PUT",
      encodeImportChunkBody(plan.chunks[0]!.descriptors, plan.chunks[0]!.payload));
    expect((await proofFetch(`/api/private/imports/${importId}`, "DELETE")).status).toBe(200);
    expect(scalar(`SELECT count(*) FROM import_sessions WHERE id = '${importId}'`)).toBe("0");
    expect(scalar(`SELECT count(*) FROM import_chunks WHERE import_id = '${importId}'`)).toBe("0");
    expect(scalar(`SELECT count(*) FROM import_records WHERE import_id = '${importId}'`)).toBe("0");
  });

  it("expires an open session and returns 410 with no marker", async () => {
    const plan = await buildPlan([{ path: "draft.md", bytes: encoder.encode("x") }]);
    const session = await createSession(plan.manifest.metadata, plan.manifest.envelope);
    const { importId } = await session.json() as { importId: string };
    await proofFetch(`/api/private/imports/${importId}/chunks/0`, "PUT",
      encodeImportChunkBody(plan.chunks[0]!.descriptors, plan.chunks[0]!.payload));
    expect(remoteSql(`UPDATE import_sessions SET expires_at = created_at + 1 WHERE id = '${importId}'`).ok).toBe(true);
    expect((await proofFetch(`/api/private/imports/${importId}/commit`, "POST")).status).toBe(410);
    expect(scalar(`SELECT count(*) FROM import_sessions WHERE id = '${importId}'`)).toBe("0");
    expect(scalar(`SELECT count(*) FROM import_commits WHERE import_id = '${importId}'`)).toBe("0");
  });

  it("returns to review with no marker when the target revision is stale", async () => {
    const liveRevision = Number(scalar(`SELECT entries_revision FROM directories WHERE node_id = '${rootId}'`));
    const plan = await buildPlan([{ path: "draft.md", bytes: encoder.encode("x") }], { targetRevision: liveRevision + 1 });
    const session = await createSession(plan.manifest.metadata, plan.manifest.envelope);
    const { importId } = await session.json() as { importId: string };
    await proofFetch(`/api/private/imports/${importId}/chunks/0`, "PUT",
      encodeImportChunkBody(plan.chunks[0]!.descriptors, plan.chunks[0]!.payload));
    expect((await proofFetch(`/api/private/imports/${importId}/commit`, "POST")).status).toBe(409);
    expect(scalar(`SELECT count(*) FROM import_commits WHERE import_id = '${importId}'`)).toBe("0");
    expect(scalar(`SELECT count(*) FROM vault_nodes WHERE import_id = '${importId}'`)).toBe("0");
  });

  it("returns to review with no marker when the recorded target Owner no longer matches", async () => {
    const plan = await buildPlan([{ path: "draft.md", bytes: encoder.encode("x") }]);
    const session = await createSession(plan.manifest.metadata, plan.manifest.envelope);
    const { importId } = await session.json() as { importId: string };
    await proofFetch(`/api/private/imports/${importId}/chunks/0`, "PUT",
      encodeImportChunkBody(plan.chunks[0]!.descriptors, plan.chunks[0]!.payload));
    expect(remoteSql(`UPDATE import_sessions SET target_owner_id = '${secondAccountId}' WHERE id = '${importId}'`).ok).toBe(true);
    expect((await proofFetch(`/api/private/imports/${importId}/commit`, "POST")).status).toBe(409);
    expect(scalar(`SELECT count(*) FROM import_commits WHERE import_id = '${importId}'`)).toBe("0");
  });

  it("rejects one-unit-over rows through the deployed D1 CHECK constraints", async () => {
    const importId = opaque();
    const manifest = crypto.getRandomValues(new Uint8Array(32));
    const session = await createSession(sessionMetadata({ importId, manifestDigest: await sha256Hex(manifest) }), manifest);
    expect(session.status).toBe(201);
    expectCheckFailure("chunk payload over 512 KiB",
      `INSERT INTO import_chunks (import_id, sequence, payload, digest, descriptor_count, received_at)
       VALUES ('${importId}', 0, zeroblob(524289), zeroblob(32), 1, 0)`);
    expectCheckFailure("chunk sequence 40",
      `INSERT INTO import_chunks (import_id, sequence, payload, digest, descriptor_count, received_at)
       VALUES ('${importId}', 40, zeroblob(1), zeroblob(32), 1, 0)`);
    expectCheckFailure("51 descriptors",
      `INSERT INTO import_chunks (import_id, sequence, payload, digest, descriptor_count, received_at)
       VALUES ('${importId}', 0, zeroblob(1), zeroblob(32), 51, 0)`);
    expectCheckFailure("manifest over 128 KiB",
      `UPDATE import_sessions SET manifest_ciphertext = zeroblob(131073) WHERE id = '${importId}'`);
    expectCheckFailure("comment count over 1,000",
      `UPDATE import_sessions SET expected_comment_count = 1001 WHERE id = '${importId}'`);
    expectCheckFailure("representation record over 512 KiB",
      `INSERT INTO import_records (import_id, chunk_sequence, ordinal, kind, ref1, ref2, ref3, offset, length, digest,
         header_key_id, header_key_epoch, header_revision)
       VALUES ('${importId}', 0, 0, 'representation', '${uuid()}', '${uuid()}', '${uuid()}', 0, 524289, zeroblob(32),
         '${uuid()}', 1, 1)`);
  });
});
