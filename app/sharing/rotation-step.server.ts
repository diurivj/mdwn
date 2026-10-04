import type { SQL } from "drizzle-orm";
import { attributionKeyContext, commentKeyContext, MAX_ATTRIBUTION_KEY_ENVELOPE_BYTES,
  MAX_COMMENT_KEY_ENVELOPE_BYTES } from "~/comments/content";
import { publicAttributionKeyContext, publicCommentEnvelope, publicCommentKeyContext } from "~/comments/public-content";
import { createDb, sql } from "~/db/client.server";
import { commitPrivateBatch, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { decodeTreeBytes, isV7, treeEnvelope } from "~/tree/wire";
import { record } from "~/auth/request.server";
import { preparePromotion } from "./rotation-promote.server";
import { currentRotationCoverage, liveRotation, readRotationItem, readRotationSource, rotationCommentItems,
  rotationEntries, rotationSourceSnapshot } from "./rotation-data.server";
import { rotationResumeContext, rotationSourceVersion, type RotationItem, type RotationJob, type RotationSource } from "./rotation-wire";

const headers = { "Cache-Control": "no-store" };
const failure = (error: string, status: number) => Response.json({ error }, { status, headers });
const exact = (input: Record<string, unknown>, fields: string[]) => Object.keys(input).length === fields.length && fields.every((field) => Object.hasOwn(input, field));
const common = ["operation", "operationId", "objectId"];

async function commitStep(env: Env, auth: AuthorizedDevice, job: RotationJob, operationId: string, digest: Uint8Array,
  eligible: SQL, statements: (marker: SQL) => SQL[], promoted = false, deferForeignKeys = false) {
  return commitPrivateBatch(env, auth, (guard) => sql`UPDATE crypto_jobs SET updated_at = ${Date.now()}, progress = progress + ${promoted ? 1 : 0}
    WHERE id = ${job.jobId} AND account_id = ${auth.accountId} AND state = 'pending' AND key_epoch = ${job.keyEpoch}
      AND ${liveRotation(auth, job)} AND ${eligible} AND ${guard}
      AND NOT EXISTS (SELECT 1 FROM key_rotation_receipts WHERE job_id = ${job.jobId} AND operation_id = ${operationId})`,
    (marker) => [...statements(marker), sql`INSERT INTO key_rotation_receipts (job_id, operation_id, digest)
      SELECT ${job.jobId}, ${operationId}, ${digest} WHERE ${marker}`], { deferForeignKeys });
}

async function startItem(env: Env, auth: AuthorizedDevice, job: RotationJob, item: RotationItem, source: RotationSource,
  input: Record<string, unknown>, operationId: string, digest: Uint8Array) {
  if (!exact(input, [...common, "sourceEpoch", "sourceRevision", "targetEpoch", "capabilityId", "resumeEnvelope",
      ...(source.kind === "file" ? ["sourceRepresentationId"] : [])]) || !isV7(input.capabilityId)) return failure("invalid_rotation_request", 400);
  const { epoch: before, revision } = rotationSourceVersion(source);
  const fence = await createDb(env.DB).get<{ key_epoch: number }>(sql`SELECT key_epoch FROM sharing_write_blocks
    WHERE target_id = ${item.objectId} AND ${privateReadGuard(auth)}`);
  const targetEpoch = item.kind === "public_history" && !item.rotate ? before
    : Math.max(before + 1, fence?.key_epoch ?? 0);
  const capabilityId = source.kind === "directory" ? item.objectId : source.kind === "file" ? source.capability?.id ?? input.capabilityId : source.capabilityId;
  if (item.state !== "ready" || input.sourceEpoch !== before || input.sourceRevision !== revision || input.targetEpoch !== targetEpoch ||
      input.capabilityId !== capabilityId || source.kind === "file" && input.sourceRepresentationId !== source.representationId ||
      !Number.isSafeInteger(targetEpoch) || targetEpoch < 1) return failure("rotation_changed", 409);
  let resume: Uint8Array;
  try { resume = treeEnvelope(input.resumeEnvelope, 16_384, rotationResumeContext(auth.accountId, job.jobId, item.objectId, targetEpoch)); }
  catch { return failure("invalid_rotation_request", 400); }
  const committed = await commitStep(env, auth, job, operationId, digest,
    sql`${rotationSourceSnapshot(item, source)} AND EXISTS (SELECT 1 FROM key_rotation_items
      WHERE job_id = ${job.jobId} AND object_id = ${item.objectId} AND state = 'ready')`, (marker) => [
      sql`UPDATE key_rotation_items SET state = 'staging', source_epoch = ${before}, target_epoch = ${targetEpoch},
        capability_id = ${capabilityId}, source_revision = ${revision}, source_representation_id = ${source.kind === "file" ? source.representationId : null},
        resume_envelope = ${resume}, cursor = NULL WHERE job_id = ${job.jobId} AND object_id = ${item.objectId} AND ${marker}`,
    ]);
  return committed ? Response.json({ applied: true }, { headers }) : failure("rotation_changed", 409);
}

async function stageEntries(env: Env, auth: AuthorizedDevice, job: RotationJob, item: RotationItem, source: RotationSource,
  input: Record<string, unknown>, operationId: string, digest: Uint8Array) {
  if (source.kind !== "directory" || item.state !== "staging" || !exact(input, [...common, "cursor", "entries"]) ||
      input.cursor !== item.cursor || !Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > 20)
    return failure("invalid_rotation_request", 400);
  const expected = await rotationEntries(env, auth, job, item, item.cursor, false);
  if (expected.entries.length !== input.entries.length) return failure("rotation_changed", 409);
  // One bounded lookup keeps a full staging packet below D1 Free's 50-query
  // invocation limit, including authorization and all conditional batch writes.
  const children = await createDb(env.DB).all<{ node_id: string; kind: string; directory_epoch: number | null; capability_id: string | null;
    capability_epoch: number | null; content_key_id: string | null; key_epoch: number | null; revision: number | null }>(sql`
    SELECT n.id AS node_id, n.kind, d.key_epoch AS directory_epoch, f.capability_id, f.capability_epoch, r.content_key_id, r.key_epoch, r.revision
    FROM vault_nodes n LEFT JOIN directories d ON d.node_id = n.id LEFT JOIN files f ON f.node_id = n.id
    LEFT JOIN file_representations r ON r.id = f.current_representation_id
    WHERE n.id IN (${sql.join(expected.entries.map((entry) => sql`${entry.nodeId}`), sql`, `)})
      AND n.parent_node_id = ${item.objectId} AND n.owner_id = ${auth.accountId} AND ${privateReadGuard(auth)}`);
  const byId = new Map(children.map((child) => [child.node_id, child]));
  const entries: { nodeId: string; name: Uint8Array; order: Uint8Array; key: Uint8Array }[] = [];
  try {
    for (let index = 0; index < expected.entries.length; index++) {
      const old = expected.entries[index]!, value = record(input.entries[index]);
      if (!value || !exact(value, ["nodeId", "nameCiphertext", "orderCiphertext", "keyEnvelope"]) || value.nodeId !== old.nodeId) throw new Error();
      const child = byId.get(old.nodeId);
      if (!child) throw new Error();
      const metadata = { purpose: "directory-metadata" as const, vaultId: auth.accountId, objectId: old.nodeId,
        keyId: item.objectId, keyEpoch: item.targetEpoch!, revision: 1 };
      const keyContext = child.kind === "directory" ? { purpose: "directory-capability" as const, keyId: old.nodeId, keyEpoch: child.directory_epoch!, revision: 1 }
        : child.capability_id ? { purpose: "file-capability" as const, keyId: child.capability_id, keyEpoch: child.capability_epoch!, revision: 1 }
        : { purpose: "file-content-key" as const, keyId: child.content_key_id!, keyEpoch: child.key_epoch!, revision: child.revision! };
      entries.push({ nodeId: old.nodeId, name: treeEnvelope(value.nameCiphertext, 4096, metadata),
        order: treeEnvelope(value.orderCiphertext, 4096, metadata), key: treeEnvelope(value.keyEnvelope, 16_384,
          { ...keyContext, vaultId: auth.accountId, objectId: old.nodeId }) });
    }
  } catch { return failure("invalid_rotation_request", 400); }
  const committed = await commitStep(env, auth, job, operationId, digest,
    sql`${rotationSourceSnapshot(item, source)} AND EXISTS (SELECT 1 FROM key_rotation_items WHERE job_id = ${job.jobId}
      AND object_id = ${item.objectId} AND state = 'staging' AND cursor IS ${item.cursor}
      AND source_epoch = ${source.keyEpoch} AND source_revision = ${source.entriesRevision})`, (marker) => [
      ...entries.map((entry) => sql`INSERT INTO key_rotation_entries (job_id, directory_id, child_id, name_ciphertext, order_ciphertext, key_envelope)
        SELECT ${job.jobId}, ${item.objectId}, ${entry.nodeId}, ${entry.name}, ${entry.order}, ${entry.key} WHERE ${marker}`),
      sql`UPDATE key_rotation_items SET cursor = ${entries.at(-1)!.nodeId} WHERE job_id = ${job.jobId} AND object_id = ${item.objectId} AND ${marker}`,
    ]);
  return committed ? Response.json({ applied: true }, { headers }) : failure("rotation_changed", 409);
}

/** A Private thread stages its per-record content-key wrappers before promotion.
 * The browser opens each current wrapper with the installed thread capability
 * and reseals the unchanged content key beneath the replacement capability.
 * A record deleted between the page read and this commit simply stages nothing.
 */
async function stageCommentItems(env: Env, auth: AuthorizedDevice, job: RotationJob, item: RotationItem,
  source: RotationSource, input: Record<string, unknown>, operationId: string, digest: Uint8Array) {
  const rotatingEpoch = source.kind === "public_history" && item.rotate;
  if (source.kind !== "private_comment" && !rotatingEpoch || item.state !== "staging" || !item.capabilityId || !item.targetEpoch ||
      !exact(input, [...common, "cursor", "records"]) || input.cursor !== item.cursor ||
      !Array.isArray(input.records) || input.records.length < 1 || input.records.length > 20) {
    return failure("invalid_rotation_request", 400);
  }
  const expected = await rotationCommentItems(env, auth, job, item, item.cursor);
  if (expected.records.length !== input.records.length) return failure("rotation_changed", 409);
  const records: { recordId: string; kind: "comment" | "attribution"; revision: number; envelope: Uint8Array }[] = [];
  try {
    for (let index = 0; index < expected.records.length; index++) {
      const old = expected.records[index]!, value = record(input.records[index]);
      if (!value || !exact(value, ["recordId", "kind", "revision", "contentKeyEnvelope"]) ||
          value.recordId !== old.recordId || value.kind !== old.kind || value.revision !== old.revision) throw new Error();
      // Public Comment contexts bind the logical Publication, never the Owner Vault.
      const vaultId = source.kind === "public_history" ? source.publicationId! : auth.accountId;
      const context = old.kind === "comment"
        ? source.kind === "public_history"
          ? publicCommentKeyContext(vaultId, old.recordId, item.capabilityId, item.targetEpoch, old.revision)
          : commentKeyContext(vaultId, old.recordId, item.capabilityId, item.targetEpoch, old.revision)
        : source.kind === "public_history"
          ? publicAttributionKeyContext(vaultId, old.recordId, item.capabilityId, item.targetEpoch, old.revision)
          : attributionKeyContext(vaultId, old.recordId, item.capabilityId, item.targetEpoch, old.revision);
      const max = old.kind === "comment" ? MAX_COMMENT_KEY_ENVELOPE_BYTES : MAX_ATTRIBUTION_KEY_ENVELOPE_BYTES;
      records.push({ recordId: old.recordId, kind: old.kind, revision: old.revision,
        envelope: source.kind === "public_history"
          ? publicCommentEnvelope(value.contentKeyEnvelope, max, context)
          : treeEnvelope(value.contentKeyEnvelope, max, context) });
    }
  } catch { return failure("invalid_rotation_request", 400); }
  const committed = await commitStep(env, auth, job, operationId, digest,
    sql`${rotationSourceSnapshot(item, source)} AND EXISTS (SELECT 1 FROM key_rotation_items WHERE job_id = ${job.jobId}
      AND object_id = ${item.objectId} AND state = 'staging' AND cursor IS ${item.cursor}
      AND source_epoch = ${item.sourceEpoch} AND target_epoch = ${item.targetEpoch})`, (marker) => [
      ...records.map((entry) => sql`INSERT INTO key_rotation_comment_items (job_id, thread_id, kind, record_id, revision, content_key_envelope)
        SELECT ${job.jobId}, ${item.objectId}, ${entry.kind}, ${entry.recordId}, ${entry.revision}, ${entry.envelope}
        WHERE ${marker} AND ${entry.kind === "comment"
          ? sql`EXISTS (SELECT 1 FROM comments WHERE id = ${entry.recordId} AND ${rotatingEpoch ? sql`epoch_id = ${item.objectId}` : sql`thread_id = ${item.objectId}`} AND revision = ${entry.revision})`
          : sql`EXISTS (SELECT 1 FROM thread_attributions WHERE id = ${entry.recordId} AND ${rotatingEpoch ? sql`epoch_id = ${item.objectId}` : sql`thread_id = ${item.objectId}`} AND revision = ${entry.revision})`}`),
      sql`UPDATE key_rotation_items SET cursor = ${records.at(-1)!.recordId}
        WHERE job_id = ${job.jobId} AND object_id = ${item.objectId} AND ${marker}`,
    ]);
  return committed ? Response.json({ applied: true }, { headers }) : failure("rotation_changed", 409);
}

async function finishRotation(env: Env, auth: AuthorizedDevice, job: RotationJob, input: Record<string, unknown>, operationId: string, digest: Uint8Array) {
  if (!exact(input, ["operation", "operationId"])) return failure("invalid_rotation_request", 400);
  const committed = await commitStep(env, auth, job, operationId, digest,
    sql`EXISTS (SELECT 1 FROM key_rotation_items WHERE job_id = ${job.jobId} AND object_id = ${job.targetId} AND state = 'complete')
      AND NOT EXISTS (SELECT 1 FROM key_rotation_items WHERE job_id = ${job.jobId} AND state != 'complete')
      AND ${currentRotationCoverage(job.jobId)}`, (marker) => [
      sql`DELETE FROM sharing_write_blocks WHERE target_id = ${job.targetId} AND owner_id = ${auth.accountId} AND key_epoch = ${job.keyEpoch} AND ${marker}`,
      sql`UPDATE crypto_jobs SET state = 'complete', updated_at = ${Date.now()} WHERE id = ${job.jobId} AND ${marker}`,
    ]);
  return committed ? Response.json({ applied: true }, { headers }) : failure("rotation_changed", 409);
}

export async function stepRotation(env: Env, auth: AuthorizedDevice, job: RotationJob,
  input: Record<string, unknown> | null, raw: string): Promise<Response> {
  if (!input || !isV7(input.operationId) || typeof input.operation !== "string") return failure("invalid_rotation_request", 400);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)));
  const receipt = await createDb(env.DB).get<{ digest: ArrayBuffer }>(sql`SELECT digest FROM key_rotation_receipts
    WHERE job_id = ${job.jobId} AND operation_id = ${input.operationId} AND ${privateReadGuard(auth)}`);
  if (receipt) return job.state !== "cancelled" && new Uint8Array(receipt.digest).every((byte, index) => byte === digest[index])
    ? Response.json({ applied: true, duplicate: true }, { headers }) : failure("rotation_changed", 409);
  if (job.state !== "pending") return failure("rotation_changed", 409);
  if (input.operation === "finish") return finishRotation(env, auth, job, input, input.operationId, digest);
  if (!isV7(input.objectId)) return failure("invalid_rotation_request", 400);
  const item = await readRotationItem(env, auth, job, input.objectId);
  if (!item) return failure("not_found", 404);
  const source = await readRotationSource(env, auth, item);
  if (!source) return failure("rotation_changed", 409);
  const version = rotationSourceVersion(source);
  if (input.operation === "start") return startItem(env, auth, job, item, source, input, input.operationId, digest);
  if (input.operation === "advance" && item.state === "ready" && item.objectId === job.targetId && exact(input, common)) {
    const epoch = version.epoch + 1;
    if (!Number.isSafeInteger(epoch) || epoch <= job.keyEpoch) return failure("rotation_changed", 409);
    const committed = await commitStep(env, auth, job, input.operationId, digest, rotationSourceSnapshot(item, source), (marker) => [
      sql`UPDATE sharing_write_blocks SET key_epoch = ${epoch} WHERE target_id = ${job.targetId} AND key_epoch = ${job.keyEpoch} AND ${marker}`,
      sql`UPDATE crypto_jobs SET key_epoch = ${epoch} WHERE id = ${job.jobId} AND ${marker}`,
    ]);
    return committed ? Response.json({ applied: true }, { headers }) : failure("rotation_changed", 409);
  }
  if (input.operation === "restart" && item.state === "staging" && exact(input, common)) {
    const committed = await commitStep(env, auth, job, input.operationId, digest, rotationSourceSnapshot(item, source), (marker) => [
      sql`DELETE FROM key_rotation_entries WHERE job_id = ${job.jobId} AND directory_id = ${item.objectId} AND ${marker}`,
      sql`DELETE FROM key_rotation_comment_items WHERE job_id = ${job.jobId} AND thread_id = ${item.objectId} AND ${marker}`,
      sql`UPDATE key_rotation_items SET state = 'ready', resume_envelope = NULL, cursor = NULL, source_epoch = NULL,
        target_epoch = NULL, source_revision = NULL, source_representation_id = NULL, capability_id = NULL
        WHERE job_id = ${job.jobId} AND object_id = ${item.objectId} AND ${marker}`,
    ]);
    return committed ? Response.json({ applied: true }, { headers }) : failure("rotation_changed", 409);
  }
  if (item.state !== "staging" || version.epoch !== item.sourceEpoch || version.revision !== item.sourceRevision ||
      source.kind === "file" && source.representationId !== item.sourceRepresentationId) return failure("rotation_changed", 409);
  if (input.operation === "stage") return source.kind === "directory"
    ? stageEntries(env, auth, job, item, source, input, input.operationId, digest)
    : stageCommentItems(env, auth, job, item, source, input, input.operationId, digest);
  // Both Private threads and rotating Public epochs stage Comment wrappers.
  if (input.operation === "promote") {
    try {
      const promotion = await preparePromotion(env, auth, job, item, source, input);
      const committed = await commitStep(env, auth, job, input.operationId, digest,
        sql`${promotion.eligible} AND EXISTS (SELECT 1 FROM key_rotation_items WHERE job_id = ${job.jobId} AND object_id = ${item.objectId}
          AND state = 'staging' AND target_epoch = ${item.targetEpoch} AND source_epoch = ${item.sourceEpoch}
          AND source_revision = ${item.sourceRevision} AND cursor IS ${item.cursor})`, (marker) => [
          ...promotion.statements(marker),
          sql`DELETE FROM key_rotation_entries WHERE job_id = ${job.jobId} AND directory_id = ${item.objectId} AND ${marker}`,
          sql`DELETE FROM key_rotation_comment_items WHERE job_id = ${job.jobId} AND thread_id = ${item.objectId} AND ${marker}`,
          sql`UPDATE key_rotation_items SET state = 'complete', resume_envelope = NULL WHERE job_id = ${job.jobId} AND object_id = ${item.objectId} AND ${marker}`,
        ], true, source.kind === "file");
      return committed ? Response.json({ applied: true }, { headers }) : failure("rotation_changed", 409);
    } catch { return failure("invalid_rotation_request", 400); }
  }
  return failure("invalid_rotation_request", 400);
}
