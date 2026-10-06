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
 * no-visible-partial-tree reads. Ticket 33 extends the same disposable
 * deployment to the release-gate criteria: maximum-source create/save,
 * one-byte-excess rejection, staged Replace, active-Publication paired
 * updates, and stale-conflict preservation. Because D1 Free hard-fails an invocation
 * above 50 queries and Workers Free surfaces CPU-limit errors, a clean pass on
 * a genuine Free account is the statement-budget evidence.
 */

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { sealCommentEpochLink } from "../../app/shared/comments/public-content";
import type { EnvelopeContext } from "../../app/shared/crypto/enc-v1";
import { createSymmetricWriter, openSymmetric } from "../../app/shared/crypto/enc-v1";
import { FILE_SOURCE_LIMIT } from "../../app/shared/crypto/file-source";
import { createFileRepresentation, sealVaultRecoveryEnvelope } from "../../app/shared/crypto/vault";
import { signDeviceProof, sessionBindingDigest } from "../../app/shared/device/proof";
import { prepareImportPlan, type ImportPlan, type ImportReplacementDocument } from "../../app/shared/import/plan";
import { reviewImport, type ImportChoice, type ImportTarget } from "../../app/shared/import/review";
import { analyzeImportSelection, type ImportSourceFile, type RawImportInput } from "../../app/shared/import/source";
import {
  IMPORT_RECORD_KINDS, MAX_IMPORT_SESSION_BODY_BYTES, encodeImportChunkBody, encodeImportSessionBody,
  type ImportSessionKindCount, type ImportSessionMetadata, type StagingRecordKind,
} from "../../app/shared/import/staging";
import { createPublicationKeyPair, importPublicationKeyPair, newPublicationIdentifier } from "../../app/shared/publications/capability";
import { openPublicRepresentation, publicPresentation, sealPublicRepresentation } from "../../app/shared/publications/content";
import { createFileHead } from "../../app/shared/tree/file-head";
import { createListingHead } from "../../app/shared/tree/listing";
import { decodeTreeBytes, encodeTreeBytes, MAX_REPRESENTATION_BYTES } from "../../app/shared/tree/wire";

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
/** One signed request against the deployed Worker. A freshly created or
 * updated workers.dev route can briefly return its generic 404 page after a
 * deploy; the proof asserts no expected 404s, so bounded retries are safe. */
async function signedFetch(url: string, method: string, body: Uint8Array | string | undefined,
  contentType?: string): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const proof = await signDeviceProof(deviceKey, {
      sessionBinding, deviceId, registryEpoch: 1, method, url, body: body ?? "",
    });
    const response = await fetch(url, {
      method,
      headers: {
        cookie: sessionCookie,
        origin: baseUrl,
        "X-Mdwn-Device-Proof": JSON.stringify(proof),
        ...(contentType ? { "content-type": contentType } : {}),
      },
      ...(body !== undefined ? { body: body as BodyInit } : {}),
    });
    if (response.status !== 404 || attempt >= 6) return response;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
}

/** One binary request against the deployed Worker with a fresh device proof. */
async function proofFetch(path: string, method: "POST" | "PUT" | "DELETE", body?: Uint8Array): Promise<Response> {
  return signedFetch(`${baseUrl}${path}`, method, body, body ? "application/octet-stream" : undefined);
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

type PlanOptions = { targetRevision?: number; target?: Partial<ImportTarget>;
  choices?: Record<string, ImportChoice>; replacements?: Map<string, ImportReplacementDocument> };

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
  const review = reviewImport(source, target, options.choices ?? {});
  return prepareImportPlan({
    review, files, comments: source.comments, targetKey: rootKey,
    replacements: options.replacements ?? new Map(),
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

/* ------------------------------------------------------------------------- *
 * Ticket 33 release-gate extension: maximum-source create/save, staged
 * Replace, and an active-Publication paired update on the same disposable
 * deployment.
 * ------------------------------------------------------------------------- */

async function proofJson(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", value: object): Promise<Response> {
  return signedFetch(`${baseUrl}${path}`, method, JSON.stringify(value), "application/json");
}

type RemoteEntry = { nodeId: string; kind: "directory" | "file";
  nameCiphertext: string; orderCiphertext: string; keyEnvelope: string };
type RemoteListing = { entriesRevision: number; entries: RemoteEntry[] };

async function remoteListing(directoryId = rootId): Promise<RemoteListing> {
  const response = await proofFetch(`/api/private/tree/directories/${directoryId}`, "POST");
  if (response.status !== 200) throw new Error(`listing failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<RemoteListing>;
}

async function openRemoteName(entry: RemoteEntry, directoryId = rootId): Promise<string> {
  return new TextDecoder().decode(await openSymmetric(decodeTreeBytes(entry.nameCiphertext), rootKey, {
    context: { purpose: "directory-metadata", vaultId: accountId, objectId: entry.nodeId,
      keyId: directoryId, keyEpoch: 1, revision: 1 },
  }));
}

type RemotePublication = { publicationId: string; linkId: string; publicKey: string; revision: number };
type RemoteFileView = { revision: number; representationId: string; contentKeyId: string; keyEpoch: number;
  capability: { id: string; epoch: number }; ciphertext: string; keyEnvelope: string;
  representationKeyEnvelope: string; publication?: RemotePublication };

async function readRemoteFile(fileId: string): Promise<RemoteFileView> {
  const response = await proofFetch(`/api/private/tree/files/${fileId}`, "POST");
  if (response.status !== 200) throw new Error(`file read failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<RemoteFileView>;
}

type SaveBody = { expectedRevision: number; expectedRepresentationId: string;
  capability: { id: string; epoch: number };
  representation: { id: string; contentKeyId: string; keyEpoch: number; revision: number;
    ciphertext: string; keyEnvelope: string; fileHead: { digest: string; signature: string } };
  publication?: { publicationId: string; linkId: string; revision: number; ciphertext: string } };

/** One converted File in the dedicated release-gate Directory whose first
 * representation carries the maximum legal Markdown source. Keeping the
 * parent listing small avoids making every request re-verify the 100-entry
 * listing the import tests left in the hidden root. */
let cappedDirectoryId: string | undefined;
async function cappedDirectory(): Promise<string> {
  if (cappedDirectoryId) return cappedDirectoryId;
  const listing = await remoteListing();
  const directoryId = uuid(), directoryKey = crypto.getRandomValues(new Uint8Array(32));
  const metadataContext: EnvelopeContext = { purpose: "directory-metadata", vaultId: accountId,
    objectId: directoryId, keyId: rootId, keyEpoch: 1, revision: 1 };
  const writer = await createSymmetricWriter(rootKey);
  const keyEnvelope = await (await createSymmetricWriter(rootKey)).seal(directoryKey,
    { purpose: "directory-capability", vaultId: accountId, objectId: directoryId, keyId: directoryId,
      keyEpoch: 1, revision: 1 });
  const listingHead = await createListingHead(rootKey, deviceKey, { vaultId: accountId, directoryId: rootId,
    deviceId, revision: listing.entriesRevision + 1,
    entries: [...listing.entries, { nodeId: directoryId, kind: "directory",
      nameCiphertext: encodeTreeBytes(await writer.seal(encoder.encode("release-gate"), metadataContext)),
      orderCiphertext: encodeTreeBytes(await writer.seal(encoder.encode("last"), metadataContext)),
      keyEnvelope: encodeTreeBytes(keyEnvelope) }] });
  const response = await proofJson(`/api/private/tree/directories/${rootId}/children`, "PUT", {
    nodeId: directoryId, kind: "directory", expectedRevision: listing.entriesRevision,
    nameCiphertext: encodeTreeBytes(await writer.seal(encoder.encode("release-gate"), metadataContext)),
    orderCiphertext: encodeTreeBytes(await writer.seal(encoder.encode("last"), metadataContext)),
    keyEnvelope: encodeTreeBytes(keyEnvelope), listingHead,
  });
  await expectStatus(response, 201, "release-gate Directory create");
  cappedDirectoryId = directoryId;
  return directoryId;
}

async function createCappedFile(): Promise<{ fileId: string; capabilityKey: Uint8Array<ArrayBuffer>; name: string; directoryId: string }> {
  const directoryId = await cappedDirectory();
  const listing = await remoteListing(directoryId);
  const fileId = uuid(), representationId = uuid(), contentKeyId = uuid();
  const capability = { id: uuid(), epoch: 1 };
  const capabilityKey = crypto.getRandomValues(new Uint8Array(32));
  const name = `cap-${fileId.slice(0, 8)}.md`;
  const metadataContext: EnvelopeContext = { purpose: "directory-metadata", vaultId: accountId,
    objectId: fileId, keyId: directoryId, keyEpoch: 1, revision: 1 };
  const writer = await createSymmetricWriter(rootKey);
  const nameCiphertext = await writer.seal(encoder.encode(name), metadataContext);
  const orderCiphertext = await writer.seal(encoder.encode("first"), metadataContext);
  const keyEnvelope = await (await createSymmetricWriter(rootKey)).seal(capabilityKey,
    { purpose: "file-capability", vaultId: accountId, objectId: fileId, keyId: capability.id, keyEpoch: 1, revision: 1 });
  const representation = await createFileRepresentation(capabilityKey,
    { markdown: "a".repeat(FILE_SOURCE_LIMIT), metadata: new Uint8Array() },
    { vaultId: accountId, fileId, keyId: contentKeyId, keyEpoch: 1, revision: 1 });
  const ciphertext = representation.contentEnvelope;
  const representationKeyEnvelope = representation.fileContentKeyEnvelope;
  const fileHead = await createFileHead(deviceKey, { vaultId: accountId, fileId,
    capabilityId: capability.id, capabilityEpoch: 1, representationId, contentKeyId, keyEpoch: 1, revision: 1,
    deviceId, ciphertext: encodeTreeBytes(ciphertext), keyEnvelope: encodeTreeBytes(representationKeyEnvelope) });
  const listingHead = await createListingHead(rootKey, deviceKey, { vaultId: accountId, directoryId,
    deviceId, revision: listing.entriesRevision + 1,
    entries: [...listing.entries, { nodeId: fileId, kind: "file", nameCiphertext: encodeTreeBytes(nameCiphertext),
      orderCiphertext: encodeTreeBytes(orderCiphertext), keyEnvelope: encodeTreeBytes(keyEnvelope) }] });
  const response = await proofJson(`/api/private/tree/directories/${directoryId}/children`, "PUT", {
    nodeId: fileId, kind: "file", expectedRevision: listing.entriesRevision,
    nameCiphertext: encodeTreeBytes(nameCiphertext), orderCiphertext: encodeTreeBytes(orderCiphertext),
    keyEnvelope: encodeTreeBytes(keyEnvelope), capability,
    representation: { id: representationId, contentKeyId, keyEpoch: 1, revision: 1,
      ciphertext: encodeTreeBytes(ciphertext), keyEnvelope: encodeTreeBytes(representationKeyEnvelope), fileHead },
    listingHead,
  });
  await expectStatus(response, 201, "maximum-source File create");
  return { fileId, capabilityKey, name, directoryId };
}

/** A fresh conditional save whose private representation carries the maximum
 * legal Markdown source, the largest a real browser can produce. */
async function cappedSaveBody(fileId: string, capabilityKey: Uint8Array<ArrayBuffer>):
  Promise<{ current: RemoteFileView; body: SaveBody }> {
  const current = await readRemoteFile(fileId);
  const representationId = uuid(), contentKeyId = uuid();
  const keyEpoch = current.keyEpoch + 1, revision = current.revision + 1;
  const representation = await createFileRepresentation(capabilityKey,
    { markdown: "a".repeat(FILE_SOURCE_LIMIT), metadata: new Uint8Array() },
    { vaultId: accountId, fileId, keyId: contentKeyId, keyEpoch, revision });
  const ciphertext = representation.contentEnvelope, keyEnvelope = representation.fileContentKeyEnvelope;
  const fileHead = await createFileHead(deviceKey, { vaultId: accountId, fileId,
    capabilityId: current.capability.id, capabilityEpoch: current.capability.epoch, representationId,
    contentKeyId, keyEpoch, revision, deviceId, ciphertext: encodeTreeBytes(ciphertext),
    keyEnvelope: encodeTreeBytes(keyEnvelope) });
  return { current, body: { expectedRevision: current.revision, expectedRepresentationId: current.representationId,
    capability: current.capability, representation: { id: representationId, contentKeyId, keyEpoch, revision,
      ciphertext: encodeTreeBytes(ciphertext), keyEnvelope: encodeTreeBytes(keyEnvelope), fileHead } } };
}

/** One byte past the canonical 512 KiB decoded-representation bound. The
 * local `encodeTreeBytes` refuses the over-limit bytes, so this proof encodes
 * them directly to exercise the Worker/D1 rejection on the wire. */
async function oversizedSaveBody(fileId: string, capabilityKey: Uint8Array<ArrayBuffer>):
  Promise<{ current: RemoteFileView; body: SaveBody }> {
  const current = await readRemoteFile(fileId);
  const representationId = uuid(), contentKeyId = uuid();
  const keyEpoch = current.keyEpoch + 1, revision = current.revision + 1;
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const context: EnvelopeContext = { purpose: "file-content", vaultId: accountId, objectId: fileId,
    keyId: contentKeyId, keyEpoch, revision };
  const ciphertext = new Uint8Array([...(await sealExact(contentKey, MAX_REPRESENTATION_BYTES, context)), 0]);
  expect(ciphertext.length).toBe(MAX_REPRESENTATION_BYTES + 1);
  const keyEnvelope = await (await createSymmetricWriter(capabilityKey)).seal(contentKey,
    { purpose: "file-content-key", vaultId: accountId, objectId: fileId, keyId: contentKeyId, keyEpoch, revision });
  const fileHead = await createFileHead(deviceKey, { vaultId: accountId, fileId,
    capabilityId: current.capability.id, capabilityEpoch: current.capability.epoch, representationId,
    contentKeyId, keyEpoch, revision, deviceId, ciphertext: encodeTreeBytes(ciphertext.subarray(0, MAX_REPRESENTATION_BYTES)),
    keyEnvelope: encodeTreeBytes(keyEnvelope) });
  return { current, body: { expectedRevision: current.revision, expectedRepresentationId: current.representationId,
    capability: current.capability, representation: { id: representationId, contentKeyId, keyEpoch, revision,
      ciphertext: Buffer.from(ciphertext).toString("base64url"), keyEnvelope: encodeTreeBytes(keyEnvelope), fileHead } } };
}

describe("disposable remote Workers Free + D1 release-gate proof (ticket 33)", () => {
  it("accepts an exact maximum-source create and save, rejects one byte over the 512 KiB bound, and preserves the stale conflict", async () => {
    const { fileId, capabilityKey } = await createCappedFile();
    expect((await readRemoteFile(fileId)).revision).toBe(1);

    const exact = await cappedSaveBody(fileId, capabilityKey);
    await expectStatus(await proofJson(`/api/private/tree/files/${fileId}`, "PATCH", exact.body), 200, "maximum-source save");
    const afterExact = await readRemoteFile(fileId);
    expect(afterExact.revision).toBe(2);

    const over = await oversizedSaveBody(fileId, capabilityKey);
    expect((await proofJson(`/api/private/tree/files/${fileId}`, "PATCH", over.body)).status).toBe(400);
    const afterOver = await readRemoteFile(fileId);
    expect(afterOver.revision).toBe(2);
    expect(afterOver.representationId).toBe(afterExact.representationId);

    // The now-stale exact body must conflict without moving the current pointer.
    expect((await proofJson(`/api/private/tree/files/${fileId}`, "PATCH", exact.body)).status).toBe(409);
    expect((await readRemoteFile(fileId)).representationId).toBe(afterExact.representationId);
    expect(scalar(`SELECT current_revision FROM files WHERE node_id = '${fileId}'`)).toBe("2");
  });

  it("stages an Import Replace that keeps the old representation current until the commit marker", async () => {
    const { fileId, capabilityKey, name, directoryId } = await createCappedFile();
    const before = await readRemoteFile(fileId);
    const listing = await remoteListing(directoryId);
    const entry = listing.entries.find((item) => item.nodeId === fileId)!;
    const displayName = await openRemoteName(entry, directoryId);
    expect(displayName).toBe(name);
    const replacement: ImportReplacementDocument = { revision: before.revision, keyEpoch: before.keyEpoch,
      contentKeyId: before.contentKeyId, representationId: before.representationId, markdown: "old",
      metadata: new Uint8Array(), capability: before.capability, capabilityKey, publication: null };
    const plan = await buildPlan([{ path: name, bytes: encoder.encode("# replaced body") }], {
      target: { directoryId, entriesRevision: listing.entriesRevision,
        siblings: [{ nodeId: fileId, kind: "file", name }], listing: listing.entries },
      choices: { [name]: { action: "replace" } },
      replacements: new Map<string, ImportReplacementDocument>([[fileId, replacement]]),
    });
    const session = await createSession(plan.manifest.metadata, plan.manifest.envelope);
    await expectStatus(session, 201, "Replace session");
    const { importId } = await session.json() as { importId: string };
    for (const chunk of plan.chunks) {
      expect((await proofFetch(`/api/private/imports/${importId}/chunks/${chunk.sequence}`, "PUT",
        encodeImportChunkBody(chunk.descriptors, chunk.payload))).status).toBe(201);
    }
    expect((await readRemoteFile(fileId)).representationId).toBe(before.representationId);
    await expectStatus(await proofFetch(`/api/private/imports/${importId}/commit`, "POST"), 200, "Replace commit");
    const after = await readRemoteFile(fileId);
    expect(after.representationId).not.toBe(before.representationId);
    expect(after.revision).toBe(before.revision + 1);
  });

  it("pairs an active Publication with the private save and rejects stale or oversized Public updates", async () => {
    const { fileId, capabilityKey } = await createCappedFile();
    const current = await readRemoteFile(fileId);
    const linkKey = await createPublicationKeyPair();
    const publicationId = newPublicationIdentifier(), linkId = newPublicationIdentifier();
    const epochId = uuid(), capabilityId = uuid(), threadId = uuid();
    const capability = crypto.getRandomValues(new Uint8Array(32));
    const recoveryEnvelope = await sealVaultRecoveryEnvelope(crypto.getRandomValues(new Uint8Array(32)),
      { scope: "owned", objectId: epochId, keyId: capabilityId, key: capability },
      { purpose: "vault-recovery", vaultId: accountId, objectId: epochId, keyId: capabilityId, keyEpoch: 1, revision: 1 });
    const linkWrapper = await sealCommentEpochLink(linkKey.privateKey, linkKey.publicKey,
      { publicationId, linkId, epochId, capabilityId, keyEpoch: 1, capability });
    const published = await proofJson(`/api/private/publications/files/${fileId}`, "PUT", {
      publicationId, linkId, publicKey: encodeTreeBytes(linkKey.publicKey),
      expectedRevision: current.revision, expectedRepresentationId: current.representationId,
      representation: { ciphertext: encodeTreeBytes(await sealPublicRepresentation(
        { publicationId, linkId, publicKey: linkKey.publicKey, revision: 1 }, publicPresentation("# Public body"))) },
      author: null,
      comments: { threadId, epochId, capabilityId, audience: "public",
        recoveryEnvelope: encodeTreeBytes(recoveryEnvelope), linkWrapper: encodeTreeBytes(linkWrapper) },
    });
    await expectStatus(published, 201, "Publication create");

    const paired = await cappedSaveBody(fileId, capabilityKey);
    const publication = paired.current.publication!;
    paired.body.publication = { publicationId: publication.publicationId, linkId: publication.linkId,
      revision: publication.revision + 1,
      ciphertext: encodeTreeBytes(await sealPublicRepresentation({ publicationId: publication.publicationId,
        linkId: publication.linkId, publicKey: decodeTreeBytes(publication.publicKey, 65),
        revision: publication.revision + 1 }, publicPresentation("# Updated public"))) };
    const saved = await proofJson(`/api/private/tree/files/${fileId}`, "PATCH", paired.body);
    await expectStatus(saved, 200, "paired save");
    expect(await saved.json()).toMatchObject({ revision: 2, publicRevision: 2 });

    // An anonymous reader decrypts the paired update locally, without the fragment.
    const publicResponse = await fetch(`${baseUrl}/api/public/publications/${linkId}`);
    expect(publicResponse.status).toBe(200);
    const publicBody = await publicResponse.json() as { publicationId: string; linkId: string; publicKey: string;
      representation: { revision: number; ciphertext: string } };
    const pair = await importPublicationKeyPair(linkKey.privateKey, decodeTreeBytes(publicBody.publicKey, 65));
    const presentation = await openPublicRepresentation(
      decodeTreeBytes(publicBody.representation.ciphertext, MAX_REPRESENTATION_BYTES), pair,
      { publicationId: publicBody.publicationId, linkId, publicKey: decodeTreeBytes(publicBody.publicKey, 65),
        revision: publicBody.representation.revision });
    expect(presentation.markdown).toBe("# Updated public");

    // A stale Public revision and an over-bound Public payload both leave both pointers current.
    const stale = await cappedSaveBody(fileId, capabilityKey);
    stale.body.publication = { publicationId: publication.publicationId, linkId: publication.linkId,
      revision: publication.revision + 1, ciphertext: encodeTreeBytes(new Uint8Array(32)) };
    const staleResponse = await proofJson(`/api/private/tree/files/${fileId}`, "PATCH", stale.body);
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toEqual({ error: "publication_changed" });
    const over = await cappedSaveBody(fileId, capabilityKey);
    over.body.publication = { publicationId: publication.publicationId, linkId: publication.linkId,
      revision: publicBody.representation.revision + 1,
      ciphertext: Buffer.from(randomBytes(MAX_REPRESENTATION_BYTES + 1)).toString("base64url") };
    expect((await proofJson(`/api/private/tree/files/${fileId}`, "PATCH", over.body)).status).toBe(400);
    expect((await readRemoteFile(fileId)).revision).toBe(2);
  });

  it("creates no marker for a missing import sequence", async () => {
    const directoryId = await cappedDirectory();
    const listing = await remoteListing(directoryId);
    const plan = await buildPlan(Array.from({ length: 100 }, (_, index) =>
      ({ path: `missing-${String(index).padStart(3, "0")}.md`, bytes: encoder.encode("x") })),
      { target: { directoryId, entriesRevision: listing.entriesRevision } });
    expect(plan.chunks.length).toBeGreaterThan(1);
    const session = await createSession(plan.manifest.metadata, plan.manifest.envelope);
    await expectStatus(session, 201, "missing-sequence session");
    const { importId } = await session.json() as { importId: string };
    const first = plan.chunks[0]!;
    expect((await proofFetch(`/api/private/imports/${importId}/chunks/${first.sequence}`, "PUT",
      encodeImportChunkBody(first.descriptors, first.payload))).status).toBe(201);
    expect((await proofFetch(`/api/private/imports/${importId}/commit`, "POST")).status).toBe(409);
    expect(scalar(`SELECT count(*) FROM import_commits WHERE import_id = '${importId}'`)).toBe("0");
  });
});
