import type { SQL } from "drizzle-orm";
import { record } from "~/auth/request.server";
import { inspectEnvelope, type EnvelopeContext } from "~/crypto/enc-v1";
import { encodeContext, HPKE_SUITE, SYMMETRIC_SUITE, type EnvelopeSuite } from "~/crypto/enc-v1/format";
import { atomicSqlBatch, createDb, sql } from "~/db/client.server";
import { commitPrivateMutation, type AuthorizedDevice } from "~/device/proof.server";
import { directoryAccessGuard, fileAccessGuard, type FileAction } from "~/sharing/access.server";
import { begin, finish, marker, proofTime, spent } from "~/sharing/sharing.server";
import { exactRecipientGuard, recipients, unblocked, type Recipient } from "~/tree/file-v2.server";
import { decodeTreeBytes, encodeTreeBytes, isV7 } from "~/tree/wire";

/** A 2,000-character plain-text body plus its canonical frame and envelope overhead. */
export const MAX_COMMENT_CIPHERTEXT = 9216;
const MAX_ATTRIBUTION_CIPHERTEXT = 2048;
const MAX_THREAD_ENVELOPE = 4096;
const PAGE = 200;

const headers = { "Cache-Control": "no-store" };
const json = (value: object, status = 200) => Response.json(value, { status, headers });
const absent = () => json({ error: "not_found" }, 404);
const invalid = () => json({ error: "invalid_comment_request" }, 400);
const threadChanged = () => json({ error: "thread_changed" }, 409);
const rotationPending = () => json({ error: "rotation_pending" }, 409);
const bytes = (value: ArrayBuffer | Uint8Array) => new Uint8Array(value);
const b64 = (value: ArrayBuffer | Uint8Array) => encodeTreeBytes(bytes(value));
const exact = (value: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
const hex = (value: Uint8Array) => Array.from(value, (n) => n.toString(16).padStart(2, "0")).join("");
const digest = async (value: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(value)));

/** Header inspection is structural: the browser authenticates plaintext with the thread key. */
export function expectEnvelope(value: unknown, max: number, suite: EnvelopeSuite, context: EnvelopeContext): Uint8Array {
  const envelope = decodeTreeBytes(value, max);
  const header = inspectEnvelope(envelope);
  const expected = encodeContext(context), actual = encodeContext(header.context);
  if (header.suite !== suite || expected.length !== actual.length || expected.some((n, i) => n !== actual[i])) {
    throw new Error("invalid comment envelope");
  }
  return envelope;
}

export function threadKeyContext(ownerId: string, threadId: string, keyId: string, epoch: number,
  recipientId?: string): EnvelopeContext {
  return { purpose: "private-comment-thread", vaultId: ownerId, objectId: threadId, keyId, keyEpoch: epoch,
    revision: 1, ...(recipientId === undefined ? {} : { recipientId }) };
}

async function fileOwner(env: Env, fileId: string): Promise<{ owner_id: string; parent_node_id: string } | null> {
  return await createDb(env.DB).get<{ owner_id: string; parent_node_id: string }>(sql`SELECT owner_id, parent_node_id
    FROM vault_nodes WHERE id = ${fileId} AND kind = 'file'`) ?? null;
}

function guard(auth: AuthorizedDevice, ownerId: string, fileId: string, action: FileAction): SQL {
  return fileAccessGuard(auth, ownerId, fileId, action);
}

type DeviceEnvelope = { deviceId: string; ciphertext: Uint8Array };
function deviceEnvelopes(value: unknown, ownerId: string, threadId: string, keyId: string, epoch: number): DeviceEnvelope[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error("invalid device envelopes");
  const result = value.map((item: unknown) => {
    const input = record(item);
    if (!input || !exact(input, ["deviceId", "ciphertext"]) || !isV7(input.deviceId)) throw new Error("invalid device envelope");
    return { deviceId: input.deviceId, ciphertext: expectEnvelope(input.ciphertext, MAX_THREAD_ENVELOPE, HPKE_SUITE,
      threadKeyContext(ownerId, threadId, keyId, epoch, input.deviceId)) };
  });
  if (new Set(result.map((item) => item.deviceId)).size !== result.length) throw new Error("duplicate device envelope");
  return result;
}

/** JSON relation for one INSERT: device IDs are checked by the insert trigger and join below. */
async function envelopePayload(envelopes: readonly DeviceEnvelope[], current: readonly Recipient[]): Promise<string> {
  return JSON.stringify(await Promise.all(envelopes.map(async (envelope) => {
    const device = current.find((item) => item.deviceId === envelope.deviceId)!;
    return { deviceId: envelope.deviceId, recipientId: device.accountId, registryEpoch: device.registryEpoch,
      ciphertext: hex(envelope.ciphertext), digest: hex(await digest(envelope.ciphertext)) };
  })));
}

function insertDeviceEnvelopes(threadId: string, epoch: number, payload: string, live: SQL): SQL {
  return sql`INSERT INTO comment_thread_device_envelopes (thread_id, epoch, recipient_id, device_id,
      registry_epoch, ciphertext, digest)
    SELECT ${threadId}, ${epoch}, json_extract(value, '$.recipientId'), json_extract(value, '$.deviceId'),
      json_extract(value, '$.registryEpoch'), unhex(json_extract(value, '$.ciphertext')),
      unhex(json_extract(value, '$.digest'))
    FROM json_each(${payload}) WHERE ${live}`;
}

type ThreadState = { receiving_key_id: string; receiving_epoch: number; thread_id: string | null;
  current_epoch: number | null; hierarchy: number; owner: number };

/**
 * Private thread read. File-read authority is rechecked in every ciphertext SELECT;
 * the hierarchy wrapper is returned only to parent-capability readers, and a direct
 * reader receives only its own current device envelope. Never names or plaintext.
 */
export async function readPrivateThread(env: Env, auth: AuthorizedDevice, fileId: string,
  value?: unknown): Promise<Response> {
  const input = value === undefined ? {} : record(value);
  if (!input || Object.keys(input).some((key) => key !== "cursor") ||
      (input.cursor !== undefined && !isV7(input.cursor))) return invalid();
  const node = await fileOwner(env, fileId);
  if (!node) return absent();
  const ownerId = node.owner_id;
  const readable = guard(auth, ownerId, fileId, "private_comment_read");
  const state = await createDb(env.DB).get<ThreadState>(sql`
    SELECT h.receiving_key_id, h.receiving_epoch, t.id AS thread_id, t.current_epoch,
      CASE WHEN ${directoryAccessGuard(auth, ownerId, node.parent_node_id, "directory_read")} THEN 1 ELSE 0 END AS hierarchy,
      CASE WHEN ${guard(auth, ownerId, fileId, "private_comment_delete_any")} THEN 1 ELSE 0 END AS owner
    FROM files f JOIN file_heads h ON h.file_node_id = f.node_id AND h.owner_id = f.owner_id
    LEFT JOIN comment_threads t ON t.file_node_id = f.node_id AND t.owner_id = f.owner_id AND t.audience = 'private'
    WHERE f.node_id = ${fileId} AND f.owner_id = ${ownerId} AND ${readable}`);
  if (!state) {
    // A v1 File has no receiving key yet; it stays readable, but its thread opens after migration.
    const legacy = await createDb(env.DB).get(sql`SELECT 1 AS legacy FROM files
      WHERE node_id = ${fileId} AND owner_id = ${ownerId} AND ${readable}`);
    return legacy ? json({ ownerId, fileId, legacy: true, thread: null, comments: [], attributions: [],
      directDevices: [], nextCursor: null }) : absent();
  }
  let current: Recipient[];
  try { current = await recipients(env, ownerId, fileId); } catch { return invalid(); }
  const common = { ownerId, fileId, legacy: false, canDeleteAny: state.owner === 1,
    receivingKeyId: state.receiving_key_id, receivingEpoch: state.receiving_epoch };
  if (!state.thread_id || !state.current_epoch) {
    return json({ ...common, thread: null, comments: [], attributions: [], nextCursor: null,
      directDevices: current.map((device) => ({ ...device, provisioned: false })) });
  }
  const threadId = state.thread_id;
  const epochs = await createDb(env.DB).all<{ epoch: number; key_id: string; receiving_key_id: string;
    receiving_epoch: number; receiving_wrapper: ArrayBuffer; previous_wrapper: ArrayBuffer | null }>(sql`
    SELECT epoch, key_id, receiving_key_id, receiving_epoch, receiving_wrapper, previous_wrapper
    FROM comment_thread_epochs WHERE thread_id = ${threadId} AND ${readable} ORDER BY epoch LIMIT 1001`);
  const own = await createDb(env.DB).get<{ ciphertext: ArrayBuffer }>(sql`SELECT ciphertext
    FROM comment_thread_device_envelopes WHERE thread_id = ${threadId} AND epoch = ${state.current_epoch}
      AND device_id = ${auth.deviceId} AND recipient_id = ${auth.accountId}
      AND registry_epoch = ${auth.registryEpoch} AND ${readable}`);
  // An envelope from before the recipient's latest device-registry change must be replaced.
  const provisioned = new Set((await createDb(env.DB).all<{ device_id: string; registry_epoch: number }>(sql`
    SELECT device_id, registry_epoch FROM comment_thread_device_envelopes
    WHERE thread_id = ${threadId} AND epoch = ${state.current_epoch} AND ${readable} LIMIT 257`))
    .filter((row) => current.some((device) => device.deviceId === row.device_id &&
      device.registryEpoch === row.registry_epoch)).map((row) => row.device_id));
  const cursor = (input.cursor as string | undefined) ?? null;
  const page = await createDb(env.DB).all<{ id: string; author_id: string; epoch: number; revision: number;
    ciphertext: ArrayBuffer; created_at: number; updated_at: number }>(sql`
    SELECT c.id, c.author_id, c.epoch, c.revision, c.ciphertext, c.created_at, c.updated_at
    FROM comments c WHERE c.thread_id = ${threadId} AND ${readable}
      AND (${cursor} IS NULL OR (c.created_at, c.id) > (SELECT created_at, id FROM comments
        WHERE id = ${cursor} AND thread_id = ${threadId}))
    ORDER BY c.created_at, c.id LIMIT ${PAGE + 1}`);
  const attributions = await createDb(env.DB).all<{ account_id: string; epoch: number; revision: number;
    ciphertext: ArrayBuffer }>(sql`SELECT a.account_id, a.epoch, a.revision, a.ciphertext
    FROM thread_attributions a WHERE a.thread_id = ${threadId} AND ${readable} LIMIT 1001`);
  if (!epochs.length || epochs.length > 1000 || attributions.length > 1000) return invalid();
  const comments = page.slice(0, PAGE);
  return json({ ...common,
    thread: { threadId, epoch: state.current_epoch,
      epochs: epochs.map((row) => ({ epoch: row.epoch, keyId: row.key_id, receivingKeyId: row.receiving_key_id,
        receivingEpoch: row.receiving_epoch, ...(state.hierarchy === 1 ? { receivingWrapper: b64(row.receiving_wrapper) } : {}),
        previousWrapper: row.previous_wrapper ? b64(row.previous_wrapper) : null })),
      deviceEnvelope: own ? b64(own.ciphertext) : null },
    comments: comments.map((row) => ({ commentId: row.id, authorId: row.author_id, epoch: row.epoch,
      revision: row.revision, ciphertext: b64(row.ciphertext), createdAt: row.created_at, updatedAt: row.updated_at })),
    attributions: attributions.map((row) => ({ accountId: row.account_id, epoch: row.epoch, revision: row.revision,
      ciphertext: b64(row.ciphertext) })),
    directDevices: current.map((device) => ({ ...device, provisioned: provisioned.has(device.deviceId) })),
    nextCursor: page.length > PAGE ? comments.at(-1)!.id : null });
}

/** First thread creation by anyone with current File-read access; a race creates exactly one thread. */
export async function createPrivateThread(env: Env, auth: AuthorizedDevice, fileId: string,
  value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["threadId", "keyId", "receivingKeyId", "receivingEpoch", "receivingWrapper",
    "deviceEnvelopes"]) || !isV7(input.threadId) || !isV7(input.keyId) || typeof input.receivingKeyId !== "string" ||
      !Number.isSafeInteger(input.receivingEpoch)) return invalid();
  const node = await fileOwner(env, fileId);
  if (!node) return absent();
  const ownerId = node.owner_id, threadId = input.threadId, keyId = input.keyId;
  const allowed = guard(auth, ownerId, fileId, "private_comment_create");
  const head = await createDb(env.DB).get<{ receiving_key_id: string; receiving_epoch: number }>(sql`
    SELECT receiving_key_id, receiving_epoch FROM file_heads
    WHERE file_node_id = ${fileId} AND owner_id = ${ownerId} AND ${allowed}`);
  if (!head) return absent();
  if (head.receiving_key_id !== input.receivingKeyId || head.receiving_epoch !== input.receivingEpoch) {
    return json({ error: "file_changed" }, 409);
  }
  let wrapper: Uint8Array, envelopes: DeviceEnvelope[], current: Recipient[];
  try {
    wrapper = expectEnvelope(input.receivingWrapper, MAX_THREAD_ENVELOPE, HPKE_SUITE,
      threadKeyContext(ownerId, threadId, keyId, 1, head.receiving_key_id));
    envelopes = deviceEnvelopes(input.deviceEnvelopes, ownerId, threadId, keyId, 1);
    current = await recipients(env, ownerId, fileId);
  } catch { return invalid(); }
  if (envelopes.length !== current.length ||
      !current.every((device) => envelopes.some((item) => item.deviceId === device.deviceId))) {
    return json({ error: "recipients_changed" }, 409);
  }
  if (!await createDb(env.DB).get(sql`SELECT 1 AS open WHERE ${unblocked(ownerId, fileId)}`)) return rotationPending();
  const now = Date.now(), invocationId = crypto.randomUUID(), live = marker(auth, invocationId);
  try {
    const [witness] = await atomicSqlBatch(env.DB, [
      begin(auth, invocationId, sql`${allowed} AND ${unblocked(ownerId, fileId)}
        AND ${exactRecipientGuard(ownerId, fileId, current)}
        AND EXISTS (SELECT 1 FROM file_heads WHERE file_node_id = ${fileId} AND owner_id = ${ownerId}
          AND receiving_key_id = ${head.receiving_key_id} AND receiving_epoch = ${head.receiving_epoch})
        AND NOT EXISTS (SELECT 1 FROM comment_threads WHERE file_node_id = ${fileId} AND audience = 'private')`),
      sql`INSERT INTO comment_threads (id, owner_id, file_node_id, audience, current_epoch, created_at)
        SELECT ${threadId}, ${ownerId}, ${fileId}, 'private', 1, ${now} WHERE ${live}`,
      sql`INSERT INTO comment_thread_epochs (thread_id, epoch, key_id, receiving_key_id, receiving_epoch,
          receiving_wrapper, previous_wrapper, created_at)
        SELECT ${threadId}, 1, ${keyId}, ${head.receiving_key_id}, ${head.receiving_epoch}, ${wrapper}, NULL, ${now}
        WHERE ${live}`,
      insertDeviceEnvelopes(threadId, 1, await envelopePayload(envelopes, current), live),
      spent(auth, invocationId), proofTime(auth, invocationId), finish(auth, invocationId),
    ]);
    if (witness?.meta.changes === 1) return json({ threadId, epoch: 1 }, 201);
  } catch { return invalid(); }
  return threadChanged();
}

/** Any current thread reader may envelope the current key to direct devices that still lack it. */
export async function provisionThreadDevices(env: Env, auth: AuthorizedDevice, fileId: string,
  value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["threadId", "epoch", "deviceEnvelopes"]) || !isV7(input.threadId) ||
      !Number.isSafeInteger(input.epoch) || (input.epoch as number) < 1) return invalid();
  const node = await fileOwner(env, fileId);
  if (!node) return absent();
  const ownerId = node.owner_id, threadId = input.threadId, epoch = input.epoch as number;
  const readable = guard(auth, ownerId, fileId, "private_comment_read");
  const thread = await createDb(env.DB).get<{ key_id: string }>(sql`SELECT e.key_id FROM comment_threads t
    JOIN comment_thread_epochs e ON e.thread_id = t.id AND e.epoch = t.current_epoch
    WHERE t.id = ${threadId} AND t.file_node_id = ${fileId} AND t.owner_id = ${ownerId}
      AND t.current_epoch = ${epoch} AND ${readable}`);
  if (!thread) return threadChanged();
  let envelopes: DeviceEnvelope[], current: Recipient[];
  try {
    envelopes = deviceEnvelopes(input.deviceEnvelopes, ownerId, threadId, thread.key_id, epoch);
    current = await recipients(env, ownerId, fileId);
  } catch { return invalid(); }
  if (!envelopes.length || envelopes.some((item) => !current.some((device) => device.deviceId === item.deviceId))) {
    return json({ error: "recipients_changed" }, 409);
  }
  const ids = JSON.stringify(envelopes.map((item) => item.deviceId));
  const kept = JSON.stringify(current.map((device) => device.deviceId));
  const invocationId = crypto.randomUUID(), live = marker(auth, invocationId);
  try {
    const [witness] = await atomicSqlBatch(env.DB, [
      begin(auth, invocationId, sql`${readable} AND EXISTS (SELECT 1 FROM comment_threads WHERE id = ${threadId}
          AND current_epoch = ${epoch}) AND ${exactRecipientGuard(ownerId, fileId, current)}
        AND NOT EXISTS (SELECT 1 FROM comment_thread_device_envelopes e
          JOIN account_encryption_identities r ON r.account_id = e.recipient_id
          WHERE e.thread_id = ${threadId} AND e.epoch = ${epoch} AND e.registry_epoch = r.registry_epoch
            AND e.device_id IN (SELECT value FROM json_each(${ids})))`),
      // Replaces registry-stale envelopes and drops those of devices outside the exact current set.
      sql`DELETE FROM comment_thread_device_envelopes WHERE thread_id = ${threadId} AND ${live}
        AND (device_id IN (SELECT value FROM json_each(${ids}))
          OR device_id NOT IN (SELECT value FROM json_each(${kept})))`,
      insertDeviceEnvelopes(threadId, epoch, await envelopePayload(envelopes, current), live),
      spent(auth, invocationId), proofTime(auth, invocationId), finish(auth, invocationId),
    ]);
    if (witness?.meta.changes === 1) return json({ provisioned: envelopes.length });
  } catch { return invalid(); }
  return threadChanged();
}

/**
 * Key state only, for a parent-capability reader that is about to rotate the File's
 * receiving pair (a move): the current thread epoch, its hierarchy wrapper and the
 * current direct devices. No Comment or attribution ciphertext.
 */
export async function readThreadKey(env: Env, auth: AuthorizedDevice, fileId: string): Promise<Response> {
  const node = await fileOwner(env, fileId);
  if (!node) return absent();
  const ownerId = node.owner_id;
  const hierarchy = sql`${guard(auth, ownerId, fileId, "private_comment_read")}
    AND ${directoryAccessGuard(auth, ownerId, node.parent_node_id, "directory_read")}`;
  const state = await createDb(env.DB).get<{ receiving_key_id: string; receiving_epoch: number;
    thread_id: string | null; current_epoch: number | null; key_id: string | null;
    receiving_wrapper: ArrayBuffer | null; wrapper_key_id: string | null }>(sql`
    SELECT h.receiving_key_id, h.receiving_epoch, t.id AS thread_id, t.current_epoch, e.key_id,
      e.receiving_wrapper, e.receiving_key_id AS wrapper_key_id
    FROM file_heads h
    LEFT JOIN comment_threads t ON t.file_node_id = h.file_node_id AND t.owner_id = h.owner_id AND t.audience = 'private'
    LEFT JOIN comment_thread_epochs e ON e.thread_id = t.id AND e.epoch = t.current_epoch
    WHERE h.file_node_id = ${fileId} AND h.owner_id = ${ownerId} AND ${hierarchy}`);
  if (!state) return absent();
  let current: Recipient[];
  try { current = await recipients(env, ownerId, fileId); } catch { return invalid(); }
  return json({ ownerId, fileId, receivingKeyId: state.receiving_key_id, receivingEpoch: state.receiving_epoch,
    thread: state.thread_id && state.current_epoch && state.key_id && state.receiving_wrapper ? {
      threadId: state.thread_id, epoch: state.current_epoch, keyId: state.key_id,
      receivingKeyId: state.wrapper_key_id, receivingWrapper: b64(state.receiving_wrapper) } : null,
    directDevices: current });
}

export class ThreadRotationChangedError extends Error {}
export type ThreadRotation = null | { ownerId: string; fileId: string; threadId: string; epoch: number;
  keyId: string; receivingKeyId: string; receivingEpoch: number; receivingWrapper: Uint8Array;
  previousWrapper: Uint8Array; envelopes: DeviceEnvelope[]; current: Recipient[] };

/**
 * A File receiving-key rotation starts a new Private thread epoch in the same batch:
 * a fresh key sealed to the NEW receiving key, the previous key chained under it, and
 * one envelope per current direct device. `null` is valid only while no thread exists.
 * Throws ThreadRotationChangedError for a stale thread or recipient set.
 */
export async function parseThreadRotation(env: Env, ownerId: string, fileId: string, value: unknown,
  receiving: { keyId: string; epoch: number }): Promise<ThreadRotation> {
  const thread = await createDb(env.DB).get<{ id: string; current_epoch: number; key_id: string }>(sql`
    SELECT t.id, t.current_epoch, e.key_id FROM comment_threads t
    JOIN comment_thread_epochs e ON e.thread_id = t.id AND e.epoch = t.current_epoch
    WHERE t.file_node_id = ${fileId} AND t.owner_id = ${ownerId} AND t.audience = 'private'`);
  if (value === null) {
    if (thread) throw new ThreadRotationChangedError();
    return null;
  }
  const input = record(value);
  if (!input || !exact(input, ["threadId", "epoch", "keyId", "receivingWrapper", "previousWrapper",
    "deviceEnvelopes"]) || !isV7(input.threadId) || !isV7(input.keyId) || !Number.isSafeInteger(input.epoch)) {
    throw new Error("invalid thread rotation");
  }
  if (!thread || thread.id !== input.threadId || thread.current_epoch + 1 !== input.epoch) {
    throw new ThreadRotationChangedError();
  }
  const threadId = input.threadId, keyId = input.keyId, epoch = input.epoch as number;
  if (keyId === thread.key_id) throw new Error("invalid thread rotation");
  const receivingWrapper = expectEnvelope(input.receivingWrapper, MAX_THREAD_ENVELOPE, HPKE_SUITE,
    threadKeyContext(ownerId, threadId, keyId, epoch, receiving.keyId));
  const previousWrapper = expectEnvelope(input.previousWrapper, MAX_THREAD_ENVELOPE, SYMMETRIC_SUITE,
    threadKeyContext(ownerId, threadId, thread.key_id, thread.current_epoch));
  const envelopes = deviceEnvelopes(input.deviceEnvelopes, ownerId, threadId, keyId, epoch);
  const current = await recipients(env, ownerId, fileId);
  if (envelopes.length !== current.length ||
      !current.every((device) => envelopes.some((item) => item.deviceId === device.deviceId))) {
    throw new ThreadRotationChangedError();
  }
  return { ownerId, fileId, threadId, epoch, keyId, receivingKeyId: receiving.keyId,
    receivingEpoch: receiving.epoch, receivingWrapper, previousWrapper, envelopes, current };
}

/** Same-batch precondition: the thread (or its absence) and direct recipients are as parsed. */
export function threadRotationGuard(ownerId: string, fileId: string, rotation: ThreadRotation): SQL {
  if (!rotation) return sql`NOT EXISTS (SELECT 1 FROM comment_threads WHERE owner_id = ${ownerId}
    AND file_node_id = ${fileId} AND audience = 'private')`;
  return sql`EXISTS (SELECT 1 FROM comment_threads WHERE id = ${rotation.threadId}
      AND current_epoch = ${rotation.epoch - 1})
    AND ${exactRecipientGuard(ownerId, fileId, rotation.current)}`;
}

/** Epoch row, then the forward-only thread epoch, then a wholesale device-envelope replacement. */
export async function threadRotationStatements(rotation: ThreadRotation, now: number, live: SQL): Promise<SQL[]> {
  if (!rotation) return [];
  const { threadId, epoch } = rotation;
  return [
    sql`INSERT INTO comment_thread_epochs (thread_id, epoch, key_id, receiving_key_id, receiving_epoch,
        receiving_wrapper, previous_wrapper, created_at)
      SELECT ${threadId}, ${epoch}, ${rotation.keyId}, ${rotation.receivingKeyId}, ${rotation.receivingEpoch},
        ${rotation.receivingWrapper}, ${rotation.previousWrapper}, ${now} WHERE ${live}`,
    sql`UPDATE comment_threads SET current_epoch = ${epoch}
      WHERE id = ${threadId} AND current_epoch = ${epoch - 1} AND ${live}`,
    sql`DELETE FROM comment_thread_device_envelopes WHERE thread_id = ${threadId} AND ${live}`,
    insertDeviceEnvelopes(threadId, epoch, await envelopePayload(rotation.envelopes, rotation.current), live),
  ];
}

type CommentTarget = { thread_id: string; current_epoch: number; key_id: string;
  attribution_epoch: number | null; attribution_revision: number | null };
type Attribution = { revision: number; ciphertext: Uint8Array } | null;

function attributionInput(value: unknown, ownerId: string, auth: AuthorizedDevice, target: CommentTarget): Attribution {
  const needed = target.attribution_epoch !== target.current_epoch;
  if (value === null) {
    if (needed) throw new Error("attribution required");
    return null;
  }
  const input = record(value);
  const revision = (target.attribution_revision ?? 0) + 1;
  if (!input || !exact(input, ["revision", "ciphertext"]) || input.revision !== revision) throw new Error("invalid attribution");
  return { revision, ciphertext: expectEnvelope(input.ciphertext, MAX_ATTRIBUTION_CIPHERTEXT, SYMMETRIC_SUITE,
    { purpose: "attribution", vaultId: ownerId, objectId: auth.accountId, keyId: target.key_id,
      keyEpoch: target.current_epoch, revision }) };
}

function upsertAttribution(auth: AuthorizedDevice, target: CommentTarget, attribution: Attribution, now: number,
  live: SQL): SQL[] {
  if (!attribution) return [];
  // Two guarded statements, not an UPSERT: the insert trigger admits only revision 1.
  return [sql`UPDATE thread_attributions SET epoch = ${target.current_epoch}, revision = ${attribution.revision},
      ciphertext = ${attribution.ciphertext}, updated_at = ${now}
    WHERE thread_id = ${target.thread_id} AND account_id = ${auth.accountId}
      AND revision = ${attribution.revision - 1} AND ${live}`,
  sql`INSERT INTO thread_attributions (thread_id, account_id, epoch, revision, ciphertext, updated_at)
    SELECT ${target.thread_id}, ${auth.accountId}, ${target.current_epoch}, 1, ${attribution.ciphertext}, ${now}
    WHERE ${attribution.revision} = 1 AND ${live}`];
}

function attributionGuard(auth: AuthorizedDevice, target: CommentTarget): SQL {
  return sql`${target.attribution_revision} IS (SELECT revision FROM thread_attributions
    WHERE thread_id = ${target.thread_id} AND account_id = ${auth.accountId})`;
}

async function commentTarget(env: Env, auth: AuthorizedDevice, fileId: string, ownerId: string,
  action: FileAction): Promise<CommentTarget | undefined> {
  return createDb(env.DB).get<CommentTarget>(sql`SELECT t.id AS thread_id, t.current_epoch, e.key_id,
      a.epoch AS attribution_epoch, a.revision AS attribution_revision
    FROM comment_threads t JOIN comment_thread_epochs e ON e.thread_id = t.id AND e.epoch = t.current_epoch
    LEFT JOIN thread_attributions a ON a.thread_id = t.id AND a.account_id = ${auth.accountId}
    WHERE t.file_node_id = ${fileId} AND t.owner_id = ${ownerId} AND t.audience = 'private'
      AND ${guard(auth, ownerId, fileId, action)}`);
}

/** Read-only and read/write participants alike: participation follows current File-read access. */
export async function createPrivateComment(env: Env, auth: AuthorizedDevice, fileId: string,
  value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["commentId", "threadId", "epoch", "ciphertext", "attribution"]) ||
      !isV7(input.commentId) || !isV7(input.threadId) || !Number.isSafeInteger(input.epoch)) return invalid();
  const node = await fileOwner(env, fileId);
  if (!node) return absent();
  const ownerId = node.owner_id, commentId = input.commentId;
  const target = await commentTarget(env, auth, fileId, ownerId, "private_comment_create");
  if (!target) return absent();
  if (target.thread_id !== input.threadId || target.current_epoch !== input.epoch) return threadChanged();
  let ciphertext: Uint8Array, attribution: Attribution;
  try {
    ciphertext = expectEnvelope(input.ciphertext, MAX_COMMENT_CIPHERTEXT, SYMMETRIC_SUITE, { purpose: "comment-content",
      vaultId: ownerId, objectId: commentId, keyId: target.key_id, keyEpoch: target.current_epoch, revision: 1 });
    attribution = attributionInput(input.attribution, ownerId, auth, target);
  } catch { return invalid(); }
  if (!await createDb(env.DB).get(sql`SELECT 1 AS open WHERE ${unblocked(ownerId, fileId)}`)) return rotationPending();
  const now = Date.now(), invocationId = crypto.randomUUID(), live = marker(auth, invocationId);
  try {
    const [witness] = await atomicSqlBatch(env.DB, [
      begin(auth, invocationId, sql`${guard(auth, ownerId, fileId, "private_comment_create")}
        AND ${unblocked(ownerId, fileId)} AND ${attributionGuard(auth, target)}
        AND EXISTS (SELECT 1 FROM comment_threads WHERE id = ${target.thread_id}
          AND current_epoch = ${target.current_epoch})`),
      ...upsertAttribution(auth, target, attribution, now, live),
      sql`INSERT INTO comments (id, thread_id, author_id, epoch, revision, ciphertext, created_at, updated_at)
        SELECT ${commentId}, ${target.thread_id}, ${auth.accountId}, ${target.current_epoch}, 1, ${ciphertext},
          ${now}, ${now} WHERE ${live}`,
      spent(auth, invocationId), proofTime(auth, invocationId), finish(auth, invocationId),
    ]);
    if (witness?.meta.changes === 1) return json({ commentId, revision: 1, createdAt: now }, 201);
  } catch { return invalid(); }
  return threadChanged();
}

type CommentRow = { thread_id: string; file_node_id: string; owner_id: string; author_id: string; revision: number };
async function comment(env: Env, commentId: string): Promise<CommentRow | undefined> {
  return createDb(env.DB).get<CommentRow>(sql`SELECT c.thread_id, t.file_node_id, t.owner_id, c.author_id, c.revision
    FROM comments c JOIN comment_threads t ON t.id = c.thread_id WHERE c.id = ${commentId}`);
}

/** An author re-encrypts their own body under the current epoch; nobody edits another author's text. */
export async function editPrivateComment(env: Env, auth: AuthorizedDevice, commentId: string,
  value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["expectedRevision", "epoch", "ciphertext", "attribution"]) ||
      !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1 ||
      !Number.isSafeInteger(input.epoch)) return invalid();
  const row = await comment(env, commentId);
  // Another author's Comment is indistinguishable from a missing one.
  if (!row || row.author_id !== auth.accountId) return absent();
  const ownerId = row.owner_id, fileId = row.file_node_id, expectedRevision = input.expectedRevision as number;
  const target = await commentTarget(env, auth, fileId, ownerId, "private_comment_edit_own");
  if (!target) return absent();
  if (target.current_epoch !== input.epoch || row.revision !== expectedRevision) return threadChanged();
  let ciphertext: Uint8Array, attribution: Attribution;
  try {
    ciphertext = expectEnvelope(input.ciphertext, MAX_COMMENT_CIPHERTEXT, SYMMETRIC_SUITE, { purpose: "comment-content",
      vaultId: ownerId, objectId: commentId, keyId: target.key_id, keyEpoch: target.current_epoch,
      revision: expectedRevision + 1 });
    attribution = attributionInput(input.attribution, ownerId, auth, target);
  } catch { return invalid(); }
  if (!await createDb(env.DB).get(sql`SELECT 1 AS open WHERE ${unblocked(ownerId, fileId)}`)) return rotationPending();
  const now = Date.now(), invocationId = crypto.randomUUID(), live = marker(auth, invocationId);
  try {
    const [witness] = await atomicSqlBatch(env.DB, [
      begin(auth, invocationId, sql`${guard(auth, ownerId, fileId, "private_comment_edit_own")}
        AND ${unblocked(ownerId, fileId)} AND ${attributionGuard(auth, target)}
        AND EXISTS (SELECT 1 FROM comments WHERE id = ${commentId} AND author_id = ${auth.accountId}
          AND thread_id = ${target.thread_id} AND revision = ${expectedRevision})
        AND EXISTS (SELECT 1 FROM comment_threads WHERE id = ${target.thread_id}
          AND current_epoch = ${target.current_epoch})`),
      ...upsertAttribution(auth, target, attribution, now, live),
      sql`UPDATE comments SET epoch = ${target.current_epoch}, revision = ${expectedRevision + 1},
          ciphertext = ${ciphertext}, updated_at = ${now}
        WHERE id = ${commentId} AND author_id = ${auth.accountId} AND revision = ${expectedRevision} AND ${live}`,
      spent(auth, invocationId), proofTime(auth, invocationId), finish(auth, invocationId),
    ]);
    if (witness?.meta.changes === 1) return json({ commentId, revision: expectedRevision + 1, updatedAt: now });
  } catch { return invalid(); }
  return threadChanged();
}

/** Hard delete: the author while they keep File-read access, or the Owner for any Comment. */
export async function deletePrivateComment(env: Env, auth: AuthorizedDevice, commentId: string): Promise<Response> {
  const row = await comment(env, commentId);
  if (!row) return absent();
  const { owner_id: ownerId, file_node_id: fileId } = row;
  const allowed = sql`((${row.author_id} = ${auth.accountId}
      AND ${guard(auth, ownerId, fileId, "private_comment_delete_own")})
    OR ${guard(auth, ownerId, fileId, "private_comment_delete_any")})`;
  try {
    const deleted = await commitPrivateMutation(env, auth, (proof) => sql`DELETE FROM comments
      WHERE id = ${commentId} AND thread_id = ${row.thread_id} AND author_id = ${row.author_id}
        AND ${allowed} AND ${proof}`);
    return deleted ? json({ deleted: true }) : absent();
  } catch { return invalid(); }
}
