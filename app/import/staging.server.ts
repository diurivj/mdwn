/**
 * Import staging and commit (ticket 30).
 *
 * A confirmed Import is private staging plus one atomic visibility marker.
 * The browser first creates a session (encrypted staging manifest + typed
 * routing metadata), uploads 1–40 raw binary chunks, then commits once. No
 * canonical tree/File/Comment row exists before the commit transaction, so a
 * person sees the whole imported tree or nothing; cancelled, expired, failed,
 * or mismatched sessions stay unreachable and are deleted.
 *
 * The Worker validates binary framing, envelope structure, descriptor kind,
 * ranges, opaque references, digests, per-field ceilings, session state, and
 * authorization without decrypting private content. Every canonical staged
 * record carries the immutable `import_id`; committed `vault_nodes` keep it.
 */

import type { SQL } from "drizzle-orm";
import { hasEmptyBody } from "~/auth/request.server";
import { digestEnvelope, inspectEnvelope } from "~/shared/crypto/enc-v1";
import { SYMMETRIC_SUITE, HPKE_SUITE } from "~/shared/crypto/enc-v1/format";
import { atomicSqlBatch, createDb, sql } from "~/shared/db/client.server";
import { authorizePrivateRequest, commitPrivateBatch, type AuthorizedDevice } from "~/device/proof.server";
import { accessPredicate, sharingWriteBlocked } from "~/sharing/access.server";
import { verifyFileHead } from "~/shared/tree/file-head";
import { verifyListingSignature } from "~/shared/tree/listing";
import { encodeTreeBytes } from "~/shared/tree/wire";
import {
  MAX_IMPORT_CHUNK_BODY_BYTES, MAX_IMPORT_SESSION_BODY_BYTES, IMPORT_RECORD_KINDS,
  decodeImportChunkBody, decodeImportSessionBody, verifyChunkDigests,
  type DecodedDescriptor, type StagingRecordKind,
} from "../shared/import/staging";
import { MAX_STAGING_MANIFEST_BYTES } from "../shared/import/limits";

const headers = { "Cache-Control": "no-store" };
const failure = (error: string, status: number) => Response.json({ error }, { status, headers });
const invalid = () => failure("invalid_import_request", 400);
const notFound = () => failure("not_found", 404);
const changed = () => failure("import_changed", 409);
const incomplete = () => failure("import_incomplete", 409);
const expired = () => failure("import_expired", 410);
const denied = () => failure("device_proof_required", 403);

const MAX_IMPORT_AGE_MS = 86_400_000;
const PURGE_BATCH = 3;

type SessionRow = {
  id: string;
  account_id: string;
  session_id: string;
  device_id: string;
  target_directory_id: string;
  target_owner_id: string;
  reviewed_entry_revision: number;
  expected_record_count: number;
  expected_chunk_count: number;
  expected_payload_bytes: number;
  expected_comment_count: number;
  aggregate_digest: ArrayBuffer;
  state: "open" | "committed" | "failed";
  uploaded_chunks: number;
  uploaded_records: number;
  uploaded_bytes: number;
  created_at: number;
  expires_at: number;
  committed_at: number | null;
};

type ChunkRow = {
  sequence: number;
  digest: ArrayBuffer;
  descriptor_count: number;
  bytes: number;
};

type RecordRow = {
  chunk_sequence: number;
  ordinal: number;
  kind: StagingRecordKind;
  ref1: string | null;
  ref2: string | null;
  ref3: string | null;
  ref4: string | null;
  offset: number;
  length: number;
  /** Record bytes reconstructed from its chunk payload by `import_record_payloads`. */
  payload: ArrayBuffer;
  digest: ArrayBuffer;
  header_key_id: string | null;
  header_key_epoch: number | null;
  header_revision: number | null;
  expected_revision: number | null;
  head_device_id: string | null;
  signer_device_id: string | null;
};

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function fromHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesOf(value: ArrayBuffer): Uint8Array {
  return new Uint8Array(value);
}

/** Stream and count a binary body before buffering it; `null` means reject. */
async function readBinaryBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/octet-stream") return null;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); return null; }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

function parseProof(value: string | null): unknown {
  try { return JSON.parse(value ?? "null"); }
  catch { return null; }
}

/** After proof verification the recorded body digest is the body's SHA-256. */
function proofBodyDigest(proof: unknown): Uint8Array | null {
  const value = (proof as { bodyDigest?: unknown } | null)?.bodyDigest;
  if (typeof value !== "string" || value.length > 64) return null;
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - value.length % 4) % 4)), (character) => character.charCodeAt(0));
    return bytes.length === 32 ? bytes : null;
  } catch { return null; }
}

async function sessionRow(env: Env, importId: string): Promise<SessionRow | null> {
  return (await createDb(env.DB).get<SessionRow>(sql`SELECT * FROM import_sessions WHERE id = ${importId}`)) ?? null;
}

async function chunkRow(env: Env, importId: string, sequence: number): Promise<ChunkRow | null> {
  return (await createDb(env.DB).get<ChunkRow>(sql`
    SELECT sequence, digest, descriptor_count, length(payload) AS bytes FROM import_chunks
    WHERE import_id = ${importId} AND sequence = ${sequence}`)) ?? null;
}

/** Typed staged record ready for `import_records`; all fields were validated. */
type UploadRecord = {
  ordinal: number;
  kind: StagingRecordKind;
  refs: readonly (string | null)[];
  offset: number;
  length: number;
  digest: Uint8Array;
  headerKeyId: string | null;
  headerKeyEpoch: number | null;
  headerRevision: number | null;
  expectedRevision: number | null;
  headDeviceId: string | null;
  signerDeviceId: string | null;
};

/**
 * Structural validation of one descriptor range. Envelope headers are
 * inspected, never opened; the header's context must agree with the typed
 * references, the target Owner's vault, and the kind's locked purpose.
 */
function validateUploadRecord(targetOwnerId: string, deviceId: string,
  descriptor: DecodedDescriptor, payload: Uint8Array, ordinal: number): UploadRecord {
  const schema = IMPORT_RECORD_KINDS[descriptor.kind];
  if (payload.length !== descriptor.length || payload.length < schema.min || payload.length > schema.max) {
    throw new Error("record bounds");
  }
  const base = {
    ordinal, kind: descriptor.kind, refs: [...descriptor.refs] as (string | null)[],
    offset: descriptor.offset, length: descriptor.length, digest: descriptor.digest,
  };
  const structural = (): UploadRecord => ({
    ...base, headerKeyId: null, headerKeyEpoch: null, headerRevision: null, expectedRevision: null,
    headDeviceId: null, signerDeviceId: null,
  });
  if (descriptor.kind === "node-directory" || descriptor.kind === "node-file") {
    if (payload.length) throw new Error("node record payload");
    return structural();
  }
  if (descriptor.kind === "file-head") return { ...structural(), headDeviceId: deviceId };
  if (descriptor.kind === "replace") {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const expected = Number(view.getBigUint64(0));
    if (!Number.isSafeInteger(expected) || expected < 1) throw new Error("replace revision");
    return { ...structural(), expectedRevision: expected };
  }
  if (descriptor.kind === "listing-digest") {
    if (payload.length !== 32) throw new Error("listing digest");
    return structural();
  }
  if (descriptor.kind === "listing-signature") {
    if (payload.length !== 64) throw new Error("listing signature");
    return { ...structural(), signerDeviceId: deviceId };
  }
  // Every remaining kind is one complete encrypted envelope.
  const header = inspectEnvelope(payload);
  const envelopeKind = schema as { envelope: "symmetric" | "hpke"; purpose: string };
  const suite = envelopeKind.envelope === "hpke" ? HPKE_SUITE : SYMMETRIC_SUITE;
  if (header.suite !== suite || header.context.purpose !== envelopeKind.purpose ||
      header.context.vaultId !== targetOwnerId) throw new Error("envelope shape");
  const context = header.context;
  const [ref1, ref2, ref3, ref4] = descriptor.refs;
  const sameIdentity = (): boolean => {
    switch (descriptor.kind) {
      case "entry-name": case "entry-order":
        return context.objectId === ref1 && context.keyId === ref2 && context.revision === 1;
      case "directory-capability":
        return context.objectId === ref1 && context.keyId === ref1 && context.keyEpoch === 1 && context.revision === 1;
      case "file-capability":
        return context.objectId === ref1 && context.keyId === ref3 && context.keyEpoch === 1 && context.revision === 1;
      case "entry-key":
        return context.objectId === ref1;
      case "representation-key": case "representation":
        return context.objectId === ref1 && context.keyId === ref3;
      case "public-representation":
        return context.publicationId === ref1 && context.keyId === ref2;
      case "comment-thread":
        return context.objectId === ref2 && context.keyId === ref4 && context.keyEpoch === 1 && context.revision === 1;
      case "comment-body": case "comment-attribution": case "comment-meta":
        return context.objectId === ref2 && context.keyId === ref2 && context.keyEpoch === 1 && context.revision === 1;
      case "comment-key": case "comment-attribution-key":
        return context.objectId === ref2 && context.keyEpoch === 1 && context.revision === 1;
      case "listing-ciphertext":
        return context.objectId === ref1 && context.keyId === ref1;
      default:
        return false;
    }
  };
  if (!sameIdentity() || context.keyEpoch < 1 || context.revision < 1) throw new Error("envelope identity");
  return { ...base, headerKeyId: context.keyId, headerKeyEpoch: context.keyEpoch,
    headerRevision: context.revision, expectedRevision: null, headDeviceId: null, signerDeviceId: null };
}

const RECORD_COLUMNS = `import_id, chunk_sequence, ordinal, kind, ref1, ref2, ref3, ref4, offset, length, digest,
  header_key_id, header_key_epoch, header_revision, expected_revision,
  head_device_id, signer_device_id`;

/** Multi-row record inserts stay under D1's 100-bound-parameter ceiling. */
function recordInsertStatements(importId: string, sequence: number, records: readonly UploadRecord[]): SQL[] {
  const statements: SQL[] = [];
  for (let start = 0; start < records.length; start += 5) {
    const rows = records.slice(start, start + 5).map((record) => sql`(
      ${importId}, ${sequence}, ${record.ordinal}, ${record.kind},
      ${record.refs[0] ?? null}, ${record.refs[1] ?? null}, ${record.refs[2] ?? null}, ${record.refs[3] ?? null},
      ${record.offset}, ${record.length}, ${record.digest}, ${record.headerKeyId}, ${record.headerKeyEpoch}, ${record.headerRevision},
      ${record.expectedRevision}, ${record.headDeviceId}, ${record.signerDeviceId})`);
    statements.push(sql`INSERT INTO import_records (${sql.raw(RECORD_COLUMNS)}) VALUES ${sql.join(rows, sql`, `)}`);
  }
  return statements;
}

/* ---------------------------------------------------------------- staging */

/** Create the initiating-Account-bound session after the local preflight. */
async function createSession(env: Env, auth: AuthorizedDevice, body: Uint8Array): Promise<Response> {
  let decoded;
  try { decoded = decodeImportSessionBody(body); }
  catch { return invalid(); }
  const { metadata, manifest } = decoded;
  if (manifest.length < 1 || manifest.length > MAX_STAGING_MANIFEST_BYTES) return invalid();
  if (!equalBytes(await sha256(manifest), fromHex(metadata.manifestDigest))) return invalid();
  const target = await createDb(env.DB).get<{ owner_id: string; entries_revision: number }>(sql`
    SELECT d.owner_id, d.entries_revision FROM directories d
    JOIN vault_nodes n ON n.id = d.node_id AND n.owner_id = d.owner_id
    WHERE d.node_id = ${metadata.targetDirectoryId} AND n.kind = 'directory'
      AND ${accessPredicate(auth, metadata.targetDirectoryId, "create")}`);
  if (!target) return notFound();
  if (await createDb(env.DB).get(sql`SELECT 1 FROM import_sessions WHERE id = ${metadata.importId}`)) return changed();
  await purgeExpiredSessions(env, auth.accountId);
  const importId = metadata.importId;
  const now = Date.now();
  const expiresAt = now + MAX_IMPORT_AGE_MS;
  const manifestDigest = await sha256(manifest);
  const inserted = await commitPrivateBatch(env, auth, (guard) => sql`
    INSERT INTO import_sessions (id, account_id, session_id, device_id, target_directory_id, target_owner_id,
      reviewed_entry_revision, manifest_ciphertext, manifest_digest, expected_record_count, expected_chunk_count,
      expected_payload_bytes, expected_comment_count, aggregate_digest, state, created_at, expires_at)
    SELECT ${importId}, ${auth.accountId}, ${auth.sessionId}, ${auth.deviceId}, ${metadata.targetDirectoryId},
      ${target.owner_id}, ${metadata.reviewedEntryRevision}, ${manifest}, ${manifestDigest}, ${metadata.recordCount},
      ${metadata.chunkCount}, ${metadata.payloadBytes}, ${metadata.commentCount}, ${fromHex(metadata.aggregateDigest)},
      'open', ${now}, ${expiresAt}
    WHERE ${accessPredicate(auth, metadata.targetDirectoryId, "create")}
      AND EXISTS (SELECT 1 FROM directories d WHERE d.node_id = ${metadata.targetDirectoryId}
        AND d.owner_id = ${target.owner_id}) AND ${guard}`,
    (marker) => metadata.kindCounts.map((entry) => sql`
      INSERT INTO import_session_kinds (import_id, kind, expected_count)
      SELECT ${importId}, ${entry.kind}, ${entry.count} WHERE ${marker}`));
  return inserted
    ? Response.json({ importId, expiresAt, state: "open" }, { status: 201, headers })
    : changed();
}

/** Upload one raw binary encrypted chunk; the exact body bytes are the retry identity. */
async function uploadChunk(env: Env, auth: AuthorizedDevice, importId: string, sequence: number,
  body: Uint8Array, bodyDigest: Uint8Array): Promise<Response> {
  let chunk;
  try { chunk = decodeImportChunkBody(body, MAX_IMPORT_CHUNK_BODY_BYTES); }
  catch { return invalid(); }
  const session = await sessionRow(env, importId);
  if (!session || session.account_id !== auth.accountId) return notFound();
  const now = Date.now();
  if (session.state === "committed") {
    const committedChunk = await chunkRow(env, importId, sequence);
    return committedChunk && equalBytes(bytesOf(committedChunk.digest), bodyDigest)
      ? Response.json({ sequence, received: committedChunk.descriptor_count, retried: true }, { headers })
      : changed();
  }
  if (session.state !== "open") return changed();
  if (session.expires_at <= now) { await purgeSession(env, session); return expired(); }
  if (sequence < 0 || sequence >= session.expected_chunk_count) return invalid();
  const existing = await chunkRow(env, importId, sequence);
  if (existing) {
    if (equalBytes(bytesOf(existing.digest), bodyDigest)) {
      return Response.json({ sequence, received: existing.descriptor_count, retried: true }, { headers });
    }
    await failSession(env, auth, importId);
    return changed();
  }
  if (!await verifyChunkDigests(chunk)) return invalid();
  let records: UploadRecord[];
  try {
    records = chunk.descriptors.map((descriptor, ordinal) => validateUploadRecord(session.target_owner_id,
      auth.deviceId, descriptor, chunk.payload.subarray(descriptor.offset, descriptor.offset + descriptor.length), ordinal));
  } catch { return invalid(); }
  const payloadBytes = chunk.payload.length;
  const descriptorCount = records.length;
  const committed = await commitPrivateBatch(env, auth, (guard) => sql`
    UPDATE import_sessions SET uploaded_chunks = uploaded_chunks + 1,
      uploaded_records = uploaded_records + ${descriptorCount}, uploaded_bytes = uploaded_bytes + ${payloadBytes}
    WHERE id = ${importId} AND account_id = ${auth.accountId} AND state = 'open' AND expires_at > ${now}
      AND uploaded_chunks < expected_chunk_count
      AND uploaded_records + ${descriptorCount} <= expected_record_count
      AND uploaded_bytes + ${payloadBytes} <= expected_payload_bytes
      AND NOT EXISTS (SELECT 1 FROM import_chunks WHERE import_id = ${importId} AND sequence = ${sequence})
      AND ${guard}`,
    (marker) => [
      sql`INSERT INTO import_chunks (import_id, sequence, payload, digest, descriptor_count, received_at)
        SELECT ${importId}, ${sequence}, ${chunk.payload}, ${bodyDigest}, ${descriptorCount}, ${now}
        WHERE ${marker}`,
      ...recordInsertStatements(importId, sequence, records),
    ]);
  if (committed) return Response.json({ sequence, received: descriptorCount, bytes: payloadBytes }, { status: 201, headers });
  const raced = await chunkRow(env, importId, sequence);
  if (raced && equalBytes(bytesOf(raced.digest), bodyDigest)) {
    return Response.json({ sequence, received: raced.descriptor_count, retried: true }, { headers });
  }
  return changed();
}

/** Permanently fail a session whose accepted sequence was replayed with different
 * bytes, deleting its staged rows in the same proof-guarded batch. */
async function failSession(env: Env, auth: AuthorizedDevice, importId: string): Promise<void> {
  await commitPrivateBatch(env, auth, (guard) => sql`
    UPDATE import_sessions SET state = 'failed'
    WHERE id = ${importId} AND account_id = ${auth.accountId} AND state = 'open' AND ${guard}`,
    (marker) => [
      sql`DELETE FROM import_records WHERE import_id = ${importId} AND ${marker}`,
      sql`DELETE FROM import_chunks WHERE import_id = ${importId} AND ${marker}`,
      sql`DELETE FROM import_session_kinds WHERE import_id = ${importId} AND ${marker}`,
    ]);
}

/* ------------------------------------------------------------------ commit */

type PlanIndex = {
  of(kind: StagingRecordKind): RecordRow[];
  one(kind: StagingRecordKind, ref1: string, ref2?: string): RecordRow | null;
};

function indexRecords(records: readonly RecordRow[]): PlanIndex {
  const byKind = new Map<StagingRecordKind, RecordRow[]>();
  for (const record of records) {
    const list = byKind.get(record.kind) ?? [];
    list.push(record);
    byKind.set(record.kind, list);
  }
  return {
    of: (kind) => byKind.get(kind) ?? [],
    one: (kind, ref1, ref2) => (byKind.get(kind) ?? [])
      .find((record) => record.ref1 === ref1 && (ref2 === undefined || record.ref2 === ref2)) ?? null,
  };
}

/** Complete-plan check. Throws on the first missing or inconsistent record. */
function validateCompletePlan(records: readonly RecordRow[]): void {
  const plan = indexRecords(records);
  const nodes = [...plan.of("node-directory"), ...plan.of("node-file")];
  for (const node of nodes) {
    const nodeId = node.ref1!;
    if (!plan.one("entry-name", nodeId) || !plan.one("entry-order", nodeId)) throw new Error("entry records");
    const children = nodes.filter((child) => child.ref2 === nodeId).length;
    const listing = plan.one("listing-ciphertext", nodeId);
    if ((children > 0) !== Boolean(listing)) throw new Error("listing records");
    if (listing && (!plan.one("listing-digest", nodeId) || !plan.one("listing-signature", nodeId))) {
      throw new Error("listing records");
    }
    if (listing && (listing.header_key_epoch !== 1 || listing.header_revision !== 2)) throw new Error("listing head");
  }
  for (const file of plan.of("node-file")) {
    const fileId = file.ref1!;
    if (!plan.one("file-capability", fileId) || !plan.one("representation-key", fileId) ||
        !plan.one("representation", fileId) || !plan.one("file-head", fileId)) throw new Error("file records");
  }
  const replaced = new Set<string>();
  for (const replace of plan.of("replace")) {
    const fileId = replace.ref1!;
    if (replaced.has(fileId)) throw new Error("duplicate replace");
    replaced.add(fileId);
    const representation = plan.of("representation").find((record) => record.ref1 === fileId);
    if (!representation) throw new Error("replace representation");
    const representationKey = plan.of("representation-key").find((record) => record.ref1 === fileId);
    if (!representationKey && !plan.one("entry-key", fileId)) throw new Error("replace key");
    if (representationKey && !plan.one("file-head", fileId)) throw new Error("replace head");
    if (representationKey && representation.ref2 !== representationKey.ref2) throw new Error("replace pairing");
  }
  if (plan.of("public-representation").length && !plan.of("replace").length) {
    throw new Error("publication without replace");
  }
  for (const thread of plan.of("comment-thread")) {
    const threadId = thread.ref2!;
    const bodies = plan.of("comment-body").filter((record) => record.ref1 === threadId);
    for (const body of bodies) {
      const meta = plan.one("comment-meta", threadId, body.ref2!);
      const key = plan.one("comment-key", threadId, body.ref2!);
      if (!meta || !key || key.header_key_id !== thread.ref4 || meta.header_key_id !== body.ref2) {
        throw new Error("comment records");
      }
    }
    for (const attribution of plan.of("comment-attribution").filter((record) => record.ref1 === threadId)) {
      const key = plan.one("comment-attribution-key", threadId, attribution.ref2!);
      if (!key || key.header_key_id !== thread.ref4) throw new Error("attribution records");
    }
  }
}

type StagedFileCheck = {
  ref1: string;
  ref2: string;
  expected_revision: number;
  current_revision: number;
  current_representation_id: string;
  capability_id: string | null;
  capability_epoch: number | null;
  owner_id: string;
  parent_node_id: string | null;
  import_id: string | null;
};

type PublicationCheck = {
  ref1: string;
  ref2: string;
  header_revision: number;
  state: string;
  current_link_id: string | null;
  current_representation_id: string | null;
  current_revision: number;
  file_id: string;
};

/** Device public keys needed to verify File and listing heads. */
async function assertionKeys(env: Env, ids: readonly string[]): Promise<Map<string, Uint8Array>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const list = sql.join(unique.map((id) => sql`${id}`), sql`, `);
  const rows = await createDb(env.DB).all<{ id: string; assertion_public_key: ArrayBuffer }>(sql`
    SELECT id, assertion_public_key FROM encryption_devices WHERE id IN (${list})`);
  return new Map(rows.map((row) => [row.id, bytesOf(row.assertion_public_key)]));
}

async function commitImport(env: Env, auth: AuthorizedDevice, importId: string): Promise<Response> {
  const session = await sessionRow(env, importId);
  if (!session || session.account_id !== auth.accountId) return notFound();
  if (session.state === "committed") {
    return Response.json({ importId, committed: true, alreadyCommitted: true }, { headers });
  }
  if (session.state !== "open") return changed();
  const now = Date.now();
  if (session.expires_at <= now) { await purgeSession(env, session); return expired(); }
  const chunks = await createDb(env.DB).all<ChunkRow>(sql`
    SELECT sequence, digest, descriptor_count, length(payload) AS bytes FROM import_chunks
    WHERE import_id = ${importId} ORDER BY sequence`);
  if (chunks.length !== session.expected_chunk_count || chunks.some((chunk, index) => chunk.sequence !== index)) {
    return incomplete();
  }
  const totalBytes = chunks.reduce((total, chunk) => total + chunk.bytes, 0);
  if (totalBytes !== session.expected_payload_bytes) return incomplete();
  const ordered = new Uint8Array(chunks.length * 32);
  chunks.forEach((chunk, index) => ordered.set(bytesOf(chunk.digest), index * 32));
  if (!equalBytes(await sha256(ordered), bytesOf(session.aggregate_digest))) return incomplete();
  const kindRows = await createDb(env.DB).all<{ kind: StagingRecordKind; actual: number }>(sql`
    SELECT kind, count(*) AS actual FROM import_record_payloads WHERE import_id = ${importId} GROUP BY kind`);
  const expectedKinds = await createDb(env.DB).all<{ kind: StagingRecordKind; expected_count: number }>(sql`
    SELECT kind, expected_count FROM import_session_kinds WHERE import_id = ${importId}`);
  const actualKinds = new Map(kindRows.map((row) => [row.kind, row.actual]));
  if (kindRows.reduce((total, row) => total + row.actual, 0) !== session.expected_record_count) return incomplete();
  for (const expected of expectedKinds) {
    if ((actualKinds.get(expected.kind) ?? 0) !== expected.expected_count) return incomplete();
  }
  const records = await createDb(env.DB).all<RecordRow>(sql`
    SELECT * FROM import_record_payloads WHERE import_id = ${importId} ORDER BY chunk_sequence, ordinal`);
  try { validateCompletePlan(records); }
  catch { return incomplete(); }
  const plan = indexRecords(records);

  // Reviewed revisions, target authority, and Replace/Publication pairing;
  // the same conditions are pinned again in the commit anchor CAS.
  const target = await createDb(env.DB).get<{ owner_id: string; entries_revision: number; key_epoch: number }>(sql`
    SELECT d.owner_id, d.entries_revision, d.key_epoch FROM directories d
    JOIN vault_nodes n ON n.id = d.node_id AND n.owner_id = d.owner_id
    WHERE d.node_id = ${session.target_directory_id} AND n.kind = 'directory'
      AND ${accessPredicate(auth, session.target_directory_id, "create")}`);
  if (!target || target.owner_id !== session.target_owner_id ||
      target.entries_revision !== session.reviewed_entry_revision) return changed();
  if (await createDb(env.DB).get(sql`SELECT 1 WHERE ${sharingWriteBlocked(session.target_directory_id)}`)) return changed();
  const targetListing = plan.one("listing-ciphertext", session.target_directory_id);
  if (!targetListing || targetListing.header_revision !== session.reviewed_entry_revision + 1 ||
      targetListing.header_key_epoch !== target.key_epoch ||
      !plan.one("listing-digest", session.target_directory_id) ||
      !plan.one("listing-signature", session.target_directory_id)) return incomplete();

  const replaces = await createDb(env.DB).all<StagedFileCheck>(sql`
    SELECT r.ref1, r.ref2, r.expected_revision, f.current_revision, f.current_representation_id,
      f.capability_id, f.capability_epoch, f.owner_id, n.parent_node_id, n.import_id
    FROM import_record_payloads r JOIN files f ON f.node_id = r.ref1 JOIN vault_nodes n ON n.id = f.node_id
    WHERE r.import_id = ${importId} AND r.kind = 'replace'`);
  if (replaces.length !== plan.of("replace").length) return incomplete();
  for (const replace of replaces) {
    if (replace.owner_id !== session.target_owner_id || replace.parent_node_id !== session.target_directory_id ||
        replace.import_id !== null || replace.current_revision !== replace.expected_revision ||
        replace.current_representation_id !== replace.ref2) return changed();
  }
  const publications = await createDb(env.DB).all<PublicationCheck>(sql`
    SELECT r.ref1, r.ref2, r.header_revision, p.state, p.current_link_id, p.current_representation_id, p.file_id,
      pr.revision AS current_revision
    FROM import_record_payloads r JOIN publications p ON p.id = r.ref1
    LEFT JOIN public_representations pr ON pr.id = p.current_representation_id
    WHERE r.import_id = ${importId} AND r.kind = 'public-representation'`);
  if (publications.length !== plan.of("public-representation").length) return incomplete();
  for (const publication of publications) {
    if (publication.state !== "active" || publication.current_link_id !== publication.ref2 ||
        publication.current_representation_id === null || publication.current_revision + 1 !== publication.header_revision) {
      return changed();
    }
    if (!replaces.some((replace) => replace.ref1 === publication.file_id)) return incomplete();
  }

  // Verify every signed File and listing head against its recording device.
  const signingIds = records.flatMap((record) => [record.head_device_id, record.signer_device_id])
    .filter((id): id is string => Boolean(id));
  const keys = await assertionKeys(env, signingIds);
  for (const record of records) {
    if (record.kind === "listing-ciphertext") {
      const directoryId = record.ref1!;
      const digest = plan.one("listing-digest", directoryId);
      const signature = plan.one("listing-signature", directoryId);
      if (!digest || !signature || record.header_revision === null) return incomplete();
      if (!equalBytes(await digestEnvelope(bytesOf(record.payload)), bytesOf(digest.payload))) return incomplete();
      const key = keys.get(signature.signer_device_id!);
      if (!key || !await verifyListingSignature({
        ciphertext: encodeTreeBytes(bytesOf(record.payload)), digest: encodeTreeBytes(bytesOf(digest.payload)),
        signature: encodeTreeBytes(bytesOf(signature.payload)),
      }, { vaultId: session.target_owner_id, directoryId, deviceId: signature.signer_device_id!,
        revision: record.header_revision, publicKey: key })) return incomplete();
    }
    if (record.kind === "file-head") {
      const fileId = record.ref1!, representationId = record.ref2!;
      const representation = plan.one("representation", fileId, representationId);
      const representationKey = plan.one("representation-key", fileId, representationId);
      if (!representation || !representationKey) return incomplete();
      const replace = plan.one("replace", fileId);
      const fileCapability = plan.one("file-capability", fileId);
      const current = replaces.find((item) => item.ref1 === fileId);
      const capabilityId = fileCapability?.ref3 ?? current?.capability_id;
      const capabilityEpoch = fileCapability ? 1 : current?.capability_epoch;
      if (!capabilityId || !capabilityEpoch) return incomplete();
      const key = keys.get(record.head_device_id!);
      if (!key || !await verifyFileHead(key, {
        vaultId: session.target_owner_id, fileId, capabilityId, capabilityEpoch, representationId,
        contentKeyId: representationKey.ref3!, keyEpoch: representationKey.header_key_epoch!,
        revision: replace ? replace.expected_revision! + 1 : 1, deviceId: record.head_device_id!,
        ciphertext: encodeTreeBytes(bytesOf(representation.payload)),
        keyEnvelope: encodeTreeBytes(bytesOf(representationKey.payload)),
      }, { digest: encodeTreeBytes(bytesOf(record.payload).slice(0, 32)),
        signature: encodeTreeBytes(bytesOf(record.payload).slice(32, 96)) })) return incomplete();
    }
  }
  // Every staged parent is the target or another staged directory.
  const newNodeIds = new Set(plan.of("node-directory").map((record) => record.ref1!));
  for (const node of [...plan.of("node-directory"), ...plan.of("node-file")]) {
    if (node.ref2 !== session.target_directory_id && !newNodeIds.has(node.ref2!)) return incomplete();
  }

  const nowMs = Date.now();
  const committed = await commitPrivateBatch(env, auth, (guard) => sql`
    INSERT INTO import_commits (import_id, account_id, target_directory_id, committed_at)
    SELECT ${importId}, ${auth.accountId}, ${session.target_directory_id}, ${nowMs}
    WHERE ${accessPredicate(auth, session.target_directory_id, "create")}
      AND NOT ${sharingWriteBlocked(session.target_directory_id)}
      AND EXISTS (SELECT 1 FROM import_sessions s WHERE s.id = ${importId} AND s.account_id = ${auth.accountId}
        AND s.state = 'open' AND s.expires_at > ${nowMs}
        AND s.uploaded_chunks = s.expected_chunk_count AND s.uploaded_records = s.expected_record_count
        AND s.uploaded_bytes = s.expected_payload_bytes)
      AND EXISTS (SELECT 1 FROM directories d JOIN vault_nodes n ON n.id = d.node_id AND n.owner_id = d.owner_id
        WHERE d.node_id = ${session.target_directory_id} AND d.owner_id = ${session.target_owner_id}
          AND d.entries_revision = ${session.reviewed_entry_revision})
      AND NOT EXISTS (SELECT 1 FROM import_record_payloads r JOIN files f ON f.node_id = r.ref1
        JOIN vault_nodes n ON n.id = f.node_id
        WHERE r.import_id = ${importId} AND r.kind = 'replace'
          AND (f.current_revision != r.expected_revision OR f.current_representation_id != r.ref2
            OR f.owner_id != ${session.target_owner_id} OR n.parent_node_id != ${session.target_directory_id}
            OR n.import_id IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM import_record_payloads r JOIN publications p ON p.id = r.ref1
        WHERE r.import_id = ${importId} AND r.kind = 'public-representation'
          AND (p.state != 'active' OR p.current_link_id != r.ref2 OR p.current_representation_id IS NULL
            OR (SELECT pr.revision FROM public_representations pr
              WHERE pr.id = p.current_representation_id) + 1 != r.header_revision))
      AND ${guard}`,
    (marker) => [
      sql`UPDATE import_sessions SET state = 'committed', committed_at = ${nowMs}
        WHERE id = ${importId} AND state = 'open' AND ${marker}`,
      sql`INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, import_id, created_at, updated_at)
        SELECT ref1, CASE kind WHEN 'node-directory' THEN 'directory' ELSE 'file' END,
          ${session.target_owner_id}, ref2, ${importId}, ${nowMs}, ${nowMs}
        FROM import_record_payloads WHERE import_id = ${importId} AND kind IN ('node-directory', 'node-file') AND ${marker}`,
      sql`INSERT INTO directories (node_id, owner_id, entries_revision, key_epoch)
        SELECT n.ref1, ${session.target_owner_id}, 1, 1
        FROM import_record_payloads n
        WHERE n.import_id = ${importId} AND n.kind = 'node-directory' AND ${marker}`,
      sql`UPDATE directories SET entries_revision = 2,
          listing_ciphertext = (SELECT payload FROM import_record_payloads WHERE import_id = ${importId}
            AND kind = 'listing-ciphertext' AND ref1 = directories.node_id),
          listing_digest = (SELECT payload FROM import_record_payloads WHERE import_id = ${importId}
            AND kind = 'listing-digest' AND ref1 = directories.node_id),
          listing_signature = (SELECT payload FROM import_record_payloads WHERE import_id = ${importId}
            AND kind = 'listing-signature' AND ref1 = directories.node_id),
          listing_device_id = (SELECT signer_device_id FROM import_record_payloads WHERE import_id = ${importId}
            AND kind = 'listing-signature' AND ref1 = directories.node_id)
        WHERE node_id IN (SELECT ref1 FROM import_record_payloads WHERE import_id = ${importId} AND kind = 'listing-ciphertext')
          AND owner_id = ${session.target_owner_id} AND entries_revision = 1 AND ${marker}`,
      sql`INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id,
          name_ciphertext, order_ciphertext, key_envelope)
        SELECT n.ref1, ${session.target_owner_id}, n.ref2, en.payload, eo.payload, COALESCE(ec.payload, ek.payload)
        FROM import_record_payloads n
        JOIN import_record_payloads en ON en.import_id = n.import_id AND en.kind = 'entry-name' AND en.ref1 = n.ref1
        JOIN import_record_payloads eo ON eo.import_id = n.import_id AND eo.kind = 'entry-order' AND eo.ref1 = n.ref1
        LEFT JOIN import_record_payloads ec ON ec.import_id = n.import_id AND ec.kind = 'directory-capability' AND ec.ref1 = n.ref1
        LEFT JOIN import_record_payloads ek ON ek.import_id = n.import_id AND ek.kind = 'file-capability' AND ek.ref1 = n.ref1
        WHERE n.import_id = ${importId} AND n.kind IN ('node-directory', 'node-file') AND ${marker}`,
      sql`INSERT INTO files (node_id, owner_id, current_representation_id, current_revision, capability_id, capability_epoch)
        SELECT fc.ref1, ${session.target_owner_id}, rk.ref2, 1, fc.ref3, 1
        FROM import_record_payloads fc
        JOIN import_record_payloads rk ON rk.import_id = fc.import_id AND rk.kind = 'representation-key' AND rk.ref1 = fc.ref1
        WHERE fc.import_id = ${importId} AND fc.kind = 'file-capability' AND ${marker}`,
      sql`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id, key_epoch,
          ciphertext, ciphertext_size, created_at, key_envelope, head_digest, head_signature, head_device_id)
        SELECT rep.ref2, rep.ref1, ${session.target_owner_id},
          COALESCE(rep0.expected_revision + 1, 1), COALESCE(rk.ref3, rep.ref3), COALESCE(rk.header_key_epoch, rep.header_key_epoch),
          rep.payload, length(rep.payload), ${nowMs}, rk.payload,
          CASE WHEN head.payload IS NULL THEN NULL ELSE substr(head.payload, 1, 32) END,
          CASE WHEN head.payload IS NULL THEN NULL ELSE substr(head.payload, 33, 64) END,
          head.head_device_id
        FROM import_record_payloads rep
        LEFT JOIN import_record_payloads rk ON rk.import_id = rep.import_id AND rk.kind = 'representation-key'
          AND rk.ref1 = rep.ref1 AND rk.ref2 = rep.ref2
        LEFT JOIN import_record_payloads head ON head.import_id = rep.import_id AND head.kind = 'file-head'
          AND head.ref1 = rep.ref1 AND head.ref2 = rep.ref2
        LEFT JOIN import_record_payloads rep0 ON rep0.import_id = rep.import_id AND rep0.kind = 'replace' AND rep0.ref1 = rep.ref1
        WHERE rep.import_id = ${importId} AND rep.kind = 'representation' AND (rk.ref1 IS NOT NULL OR rep0.ref1 IS NOT NULL)
          AND ${marker}`,
      sql`UPDATE files SET
          current_representation_id = (SELECT rep.ref2 FROM import_record_payloads rep
            JOIN import_record_payloads rep0 ON rep0.import_id = rep.import_id AND rep0.kind = 'replace' AND rep0.ref1 = rep.ref1
            WHERE rep.import_id = ${importId} AND rep.kind = 'representation' AND rep.ref1 = files.node_id LIMIT 1),
          current_revision = (SELECT rep0.expected_revision + 1 FROM import_record_payloads rep0
            WHERE rep0.import_id = ${importId} AND rep0.kind = 'replace' AND rep0.ref1 = files.node_id)
        WHERE files.node_id IN (SELECT ref1 FROM import_record_payloads WHERE import_id = ${importId} AND kind = 'replace')
          AND files.owner_id = ${session.target_owner_id} AND ${marker}`,
      sql`DELETE FROM file_representations
        WHERE file_node_id IN (SELECT ref1 FROM import_record_payloads WHERE import_id = ${importId} AND kind = 'replace')
          AND id IN (SELECT ref2 FROM import_record_payloads WHERE import_id = ${importId} AND kind = 'replace')
          AND NOT EXISTS (SELECT 1 FROM files WHERE current_representation_id = file_representations.id)
          AND ${marker}`,
      sql`INSERT INTO public_representations (id, publication_id, link_id, revision, file_revision,
          ciphertext, ciphertext_size, created_at)
        SELECT r.ref3, r.ref1, r.ref2, r.header_revision, rep0.expected_revision + 1,
          r.payload, length(r.payload), ${nowMs}
        FROM import_record_payloads r
        JOIN publications p ON p.id = r.ref1
        JOIN import_record_payloads rep0 ON rep0.import_id = r.import_id AND rep0.kind = 'replace' AND rep0.ref1 = p.file_id
        WHERE r.import_id = ${importId} AND r.kind = 'public-representation' AND ${marker}`,
      sql`UPDATE publications SET
          current_representation_id = (SELECT r.ref3 FROM import_record_payloads r
            WHERE r.import_id = ${importId} AND r.kind = 'public-representation' AND r.ref1 = publications.id),
          updated_at = ${nowMs}
        WHERE id IN (SELECT ref1 FROM import_record_payloads WHERE import_id = ${importId} AND kind = 'public-representation')
          AND ${marker}`,
      sql`INSERT INTO comment_thread_epochs (id, thread_id, audience, key_epoch, ordinal, state, created_at)
        SELECT ref3, ref2, NULL, 1, 1, 'active', ${nowMs}
        FROM import_record_payloads WHERE import_id = ${importId} AND kind = 'comment-thread' AND ${marker}`,
      sql`INSERT INTO comment_threads (id, owner_id, file_id, purpose, publication_id, current_epoch_id,
          next_sequence, created_at)
        SELECT t.ref2, ${session.target_owner_id}, t.ref1, 'private', NULL, t.ref3,
          COALESCE((SELECT count(*) + 1 FROM import_record_payloads m
            WHERE m.import_id = t.import_id AND m.kind = 'comment-meta' AND m.ref1 = t.ref2), 1), ${nowMs}
        FROM import_record_payloads t WHERE t.import_id = ${importId} AND t.kind = 'comment-thread' AND ${marker}`,
      sql`INSERT INTO sharing_comment_capabilities (object_id, owner_id, file_id, thread_id, purpose,
          publication_id, capability_id, capability_epoch)
        SELECT t.ref2, ${session.target_owner_id}, t.ref1, t.ref2, 'private-comment-thread', NULL, t.ref4, 1
        FROM import_record_payloads t WHERE t.import_id = ${importId} AND t.kind = 'comment-thread' AND ${marker}`,
      sql`INSERT INTO import_comment_envelopes (thread_id, file_id, capability_id, capability_epoch, key_epoch, ciphertext)
        SELECT ref2, ref1, ref4, 1, 1, payload
        FROM import_record_payloads WHERE import_id = ${importId} AND kind = 'comment-thread' AND ${marker}`,
      sql`INSERT INTO comments (id, thread_id, epoch_id, author_id, sequence, revision, body_ciphertext,
          body_size, content_key_envelope, content_key_epoch, created_at, updated_at)
        SELECT b.ref2, b.ref1, t.ref3, ${auth.accountId},
          ROW_NUMBER() OVER (PARTITION BY b.ref1 ORDER BY b.chunk_sequence, b.ordinal), 1,
          b.payload, length(b.payload), k.payload, 1, ${nowMs}, ${nowMs}
        FROM import_record_payloads b
        JOIN import_record_payloads t ON t.import_id = b.import_id AND t.kind = 'comment-thread' AND t.ref2 = b.ref1
        JOIN import_record_payloads m ON m.import_id = b.import_id AND m.kind = 'comment-meta' AND m.ref1 = b.ref1 AND m.ref2 = b.ref2
        JOIN import_record_payloads k ON k.import_id = b.import_id AND k.kind = 'comment-key' AND k.ref1 = b.ref1 AND k.ref2 = b.ref2
        WHERE b.import_id = ${importId} AND b.kind = 'comment-body' AND ${marker}`,
      sql`INSERT INTO import_comment_meta (comment_id, thread_id, owner_id, ciphertext)
        SELECT ref2, ref1, ${session.target_owner_id}, payload
        FROM import_record_payloads WHERE import_id = ${importId} AND kind = 'comment-meta' AND ${marker}`,
      sql`INSERT INTO thread_attributions (id, thread_id, author_id, epoch_id, revision, ciphertext,
          content_key_envelope, content_key_epoch, created_at, updated_at)
        SELECT a.ref2, a.ref1, ${auth.accountId}, t.ref3, 1, a.payload, k.payload, 1, ${nowMs}, ${nowMs}
        FROM import_record_payloads a
        JOIN import_record_payloads t ON t.import_id = a.import_id AND t.kind = 'comment-thread' AND t.ref2 = a.ref1
        JOIN import_record_payloads k ON k.import_id = a.import_id AND k.kind = 'comment-attribution-key'
          AND k.ref1 = a.ref1 AND k.ref2 = a.ref2
        WHERE a.import_id = ${importId} AND a.kind = 'comment-attribution' AND ${marker}`,
      sql`UPDATE directory_entries SET key_envelope = (SELECT k.payload FROM import_record_payloads k
            WHERE k.import_id = ${importId} AND k.kind = 'entry-key' AND k.ref1 = directory_entries.child_node_id)
        WHERE child_node_id IN (SELECT ref1 FROM import_record_payloads WHERE import_id = ${importId} AND kind = 'entry-key')
          AND owner_id = ${session.target_owner_id} AND parent_node_id = ${session.target_directory_id}
          AND ${marker}`,
      sql`UPDATE directories SET entries_revision = ${session.reviewed_entry_revision + 1},
          listing_ciphertext = (SELECT payload FROM import_record_payloads WHERE import_id = ${importId}
            AND kind = 'listing-ciphertext' AND ref1 = ${session.target_directory_id}),
          listing_digest = (SELECT payload FROM import_record_payloads WHERE import_id = ${importId}
            AND kind = 'listing-digest' AND ref1 = ${session.target_directory_id}),
          listing_signature = (SELECT payload FROM import_record_payloads WHERE import_id = ${importId}
            AND kind = 'listing-signature' AND ref1 = ${session.target_directory_id}),
          listing_device_id = (SELECT signer_device_id FROM import_record_payloads WHERE import_id = ${importId}
            AND kind = 'listing-signature' AND ref1 = ${session.target_directory_id})
        WHERE node_id = ${session.target_directory_id} AND owner_id = ${session.target_owner_id}
          AND entries_revision = ${session.reviewed_entry_revision} AND ${marker}`,
      sql`DELETE FROM import_records WHERE import_id = ${importId} AND ${marker}`,
    ], { deferForeignKeys: true });
  return committed
    ? Response.json({ importId, committed: true, entriesRevision: session.reviewed_entry_revision + 1 }, { headers })
    : changed();
}

/* --------------------------------------------------------------- cleanup */

function deleteStatements(importId: string, includeSession: boolean): SQL[] {
  const statements = [
    sql`DELETE FROM import_records WHERE import_id = ${importId}`,
    sql`DELETE FROM import_chunks WHERE import_id = ${importId}`,
    sql`DELETE FROM import_session_kinds WHERE import_id = ${importId}`,
  ];
  if (includeSession) statements.push(sql`DELETE FROM import_sessions WHERE id = ${importId} AND state != 'committed'`);
  return statements;
}

/** Delete one unreachable session's staged rows; a committed session keeps its marker row. */
async function purgeSession(env: Env, session: SessionRow): Promise<void> {
  await atomicSqlBatch(env.DB, deleteStatements(session.id, session.state !== "committed"));
}

/** Bounded lazy cleanup of this Account's expired staging; never touches committed nodes. */
async function purgeExpiredSessions(env: Env, accountId: string): Promise<void> {
  const now = Date.now();
  const rows = await createDb(env.DB).all<{ id: string; state: SessionRow["state"] }>(sql`
    SELECT id, state FROM import_sessions
    WHERE account_id = ${accountId} AND state != 'committed' AND (state = 'failed' OR expires_at <= ${now})
    UNION ALL
    SELECT id, state FROM import_sessions
    WHERE account_id = ${accountId} AND state = 'committed' AND expires_at <= ${now}
      AND NOT EXISTS (SELECT 1 FROM import_chunks WHERE import_id = import_sessions.id)
    LIMIT ${PURGE_BATCH}`);
  if (!rows.length) return;
  await atomicSqlBatch(env.DB, rows.flatMap((row) => deleteStatements(row.id, row.state !== "committed")));
}

async function cancelImport(env: Env, auth: AuthorizedDevice, importId: string): Promise<Response> {
  const cancelled = await commitPrivateBatch(env, auth, (guard) => sql`
    UPDATE import_sessions SET state = 'failed'
    WHERE id = ${importId} AND account_id = ${auth.accountId} AND state = 'open' AND ${guard}`,
    (marker) => [
      sql`DELETE FROM import_records WHERE import_id = ${importId} AND ${marker}`,
      sql`DELETE FROM import_chunks WHERE import_id = ${importId} AND ${marker}`,
      sql`DELETE FROM import_session_kinds WHERE import_id = ${importId} AND ${marker}`,
      sql`DELETE FROM import_sessions WHERE id = ${importId} AND state = 'failed' AND ${marker}`,
    ]);
  return cancelled ? Response.json({ importId, cancelled: true }, { headers }) : notFound();
}

/* ------------------------------------------------------------------- route */

/** Resource-only Import staging API; every request is device-proof guarded. */
export async function importAction(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  const chunk = /^\/api\/private\/imports\/([A-Za-z0-9_-]{43})\/chunks\/(\d{1,2})$/.exec(path);
  const commit = /^\/api\/private\/imports\/([A-Za-z0-9_-]{43})\/commit$/.exec(path);
  const session = /^\/api\/private\/imports\/([A-Za-z0-9_-]{43})$/.exec(path);
  const collection = /^\/api\/private\/imports$/.exec(path);
  if (!(collection && request.method === "POST") &&
      !(chunk && request.method === "PUT") &&
      !(commit && request.method === "POST") &&
      !(session && request.method === "DELETE")) return notFound();
  if (request.method === "DELETE" || commit) {
    if (!await hasEmptyBody(request)) return denied();
    const auth = await authorizePrivateRequest(request, env, parseProof(request.headers.get("X-Mdwn-Device-Proof")), "");
    if (!auth) return denied();
    return commit ? await commitImport(env, auth, commit[1]!) : await cancelImport(env, auth, session![1]!);
  }
  const body = await readBinaryBody(request, collection ? MAX_IMPORT_SESSION_BODY_BYTES : MAX_IMPORT_CHUNK_BODY_BYTES);
  if (!body || !body.length) return invalid();
  const proof = parseProof(request.headers.get("X-Mdwn-Device-Proof"));
  const auth = await authorizePrivateRequest(request, env, proof, body);
  if (!auth) return denied();
  if (collection) return await createSession(env, auth, body);
  const bodyDigest = proofBodyDigest(proof);
  if (!bodyDigest) return denied();
  return await uploadChunk(env, auth, chunk![1]!, Number(chunk![2]), body, bodyDigest);
}
