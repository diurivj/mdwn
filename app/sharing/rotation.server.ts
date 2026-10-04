import type { SQL } from "drizzle-orm";
import { hasEmptyBody, readAuthJsonText, record } from "~/auth/request.server";
import { createDb, sql } from "~/db/client.server";
import { authorizePrivateRequest, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { newOpaqueId } from "~/opaque-id";
import { isV7 } from "~/tree/wire";
import { activeGrantCoverage, activeRootCoverage, requiredGrantComments } from "./capability-coverage.server";
import { readGrantKeys, uploadGrantKeys } from "./grant-keys.server";
import { readCommentKey, uploadCommentKeys } from "./comment-keys.server";
import { affectedRotationGrant, liveRotation, readRotationItem, readRotationJob, readRotationSource, rotationCommentItems,
  rotationDeliveryPermit, rotationEntries, rotationOrder } from "./rotation-data.server";
import { rotationSourceVersion, type RotationJob } from "./rotation-wire";
import { stepRotation } from "./rotation-step.server";
import { hasExpiredGrants, liveGrant } from "./grant-lifetime.server";

const headers = { "Cache-Control": "no-store" };
const failure = (error: string, status: number) => Response.json({ error }, { status, headers });
export type RotationTarget = { target_id: string; owner_id: string; target_kind: string };
type RotationPlan = { jobId: string; targetId: string; keyEpoch: number; materialEpoch: number; previousFence: number | null; state: "pending" };

/** The fence is current capability authority. Source ciphertext remains explicitly
 * old and readable for maintenance, never writable, until replacement is installed. */
export async function planRotation(env: Env, auth: AuthorizedDevice, target: RotationTarget): Promise<RotationPlan | null> {
  const row = await createDb(env.DB).get<{ material_epoch: number; fence: number | null }>(sql`
    SELECT CASE WHEN n.kind = 'directory' THEN d.key_epoch ELSE f.capability_epoch END AS material_epoch,
      b.key_epoch AS fence FROM vault_nodes n
    LEFT JOIN directories d ON d.node_id = n.id LEFT JOIN files f ON f.node_id = n.id
    LEFT JOIN sharing_write_blocks b ON b.target_id = n.id
    WHERE n.id = ${target.target_id} AND n.owner_id = ${target.owner_id} AND ${privateReadGuard(auth)}`);
  if (!row || !Number.isSafeInteger(row.material_epoch) || row.material_epoch < 1) return null;
  const keyEpoch = Math.max(row.material_epoch, row.fence ?? 0) + 1;
  if (!Number.isSafeInteger(keyEpoch)) return null;
  return { jobId: newOpaqueId(), targetId: target.target_id, keyEpoch,
    materialEpoch: row.material_epoch, previousFence: row.fence, state: "pending" };
}

export function rotationSnapshot(target: RotationTarget, plan: RotationPlan) {
  return sql`EXISTS (SELECT 1 FROM vault_nodes n
    LEFT JOIN directories d ON d.node_id = n.id LEFT JOIN files f ON f.node_id = n.id
    LEFT JOIN sharing_write_blocks b ON b.target_id = n.id
    WHERE n.id = ${target.target_id} AND n.owner_id = ${target.owner_id}
      AND CASE WHEN n.kind = 'directory' THEN d.key_epoch ELSE f.capability_epoch END = ${plan.materialEpoch}
      AND b.key_epoch IS ${plan.previousFence})`;
}

/** The partial unique target index permits at most one pending rotation. */
export function pendingRotationJob(targetId: string | SQL) {
  return sql`SELECT id FROM crypto_jobs WHERE kind = 'key_rotation' AND target_id = ${targetId} AND state = 'pending'`;
}

export function startRotation(auth: AuthorizedDevice, target: RotationTarget, plan: RotationPlan, marker: SQL) {
  const now = Date.now(), oldJobs = pendingRotationJob(target.target_id);
  return [
    sql`DELETE FROM key_rotation_comment_items WHERE job_id IN (${oldJobs}) AND ${marker}`,
    sql`DELETE FROM key_rotation_entries WHERE job_id IN (${oldJobs}) AND ${marker}`,
    sql`DELETE FROM key_rotation_items WHERE job_id IN (${oldJobs}) AND ${marker}`,
    sql`DELETE FROM key_rotation_receipts WHERE job_id IN (${oldJobs}) AND ${marker}`,
    sql`UPDATE crypto_jobs SET state = 'cancelled', updated_at = ${now}
      WHERE id IN (${oldJobs}) AND ${marker}`,
    sql`INSERT INTO sharing_write_blocks (target_id, owner_id, target_kind, key_epoch, created_at)
      SELECT ${target.target_id}, ${target.owner_id}, ${target.target_kind}, ${plan.keyEpoch}, ${now} WHERE ${marker}
      ON CONFLICT (target_id) DO UPDATE SET key_epoch = excluded.key_epoch`,
    sql`INSERT INTO crypto_jobs (id, account_id, device_id, kind, state, initiating_account_id,
      target_id, key_epoch, progress, created_at, updated_at)
      SELECT ${plan.jobId}, ${target.owner_id}, ${auth.deviceId}, 'key_rotation', 'pending', ${auth.accountId},
        ${target.target_id}, ${plan.keyEpoch}, 0, ${now}, ${now} WHERE ${marker}`,
    sql`INSERT INTO key_rotation_items (job_id, object_id, kind, depth, state)
      SELECT ${plan.jobId}, ${target.target_id}, ${target.target_kind}, 0, 'ready' WHERE ${marker}`,
  ];
}
export function rotationIdentity(plan: RotationPlan) {
  return { jobId: plan.jobId, targetId: plan.targetId, keyEpoch: plan.keyEpoch, state: plan.state };
}

async function nextRotation(env: Env, auth: AuthorizedDevice, job: RotationJob) {
  if (job.state === "complete") return Response.json({ job, operation: "complete" }, { headers });
  if (job.state !== "pending" || !await createDb(env.DB).get(sql`SELECT 1 WHERE ${liveRotation(auth, job)} AND ${privateReadGuard(auth)}`))
    return failure("rotation_changed", 409);
  const item = await readRotationItem(env, auth, job);
  if (item) {
    const source = await readRotationSource(env, auth, item);
    if (!source) return failure("rotation_changed", 409);
    const { epoch: sourceEpoch, revision } = rotationSourceVersion(source);
    if (item.state === "staging" && (sourceEpoch !== item.sourceEpoch || revision !== item.sourceRevision ||
        source.kind === "file" && source.representationId !== item.sourceRepresentationId))
      return Response.json({ job, item, source, operation: "restart" }, { headers });
    if (item.state === "ready") {
      if (item.objectId === job.targetId && sourceEpoch >= job.keyEpoch)
        return Response.json({ job, item, source, operation: "advance" }, { headers });
      const fence = await createDb(env.DB).get<{ key_epoch: number }>(sql`SELECT key_epoch FROM sharing_write_blocks
        WHERE target_id = ${item.objectId} AND ${privateReadGuard(auth)}`);
      // A retained Public epoch keeps its key. The current Collaborators-only
      // epoch advances in place before remaining devices post again.
      const targetEpoch = item.kind === "public_history" && !item.rotate ? sourceEpoch
        : Math.max(sourceEpoch + 1, fence?.key_epoch ?? 0);
      if (!Number.isSafeInteger(targetEpoch) || targetEpoch < 1) return failure("rotation_changed", 409);
      return Response.json({ job, item: { ...item, sourceEpoch, targetEpoch,
        capabilityId: source.kind === "directory" ? item.objectId : source.kind === "file" ? source.capability?.id ?? null : source.capabilityId },
        source, operation: "start" }, { headers });
    }
    const remaining = item.kind === "directory"
      ? (await rotationEntries(env, auth, job, item, item.cursor, false)).entries.length
      : item.kind === "private_comment" || item.kind === "public_history" && item.rotate
        ? (await rotationCommentItems(env, auth, job, item, item.cursor)).records.length : 0;
    return Response.json({ job, item, source, operation: remaining ? "stage" : "promote" }, { headers });
  }
  const missing = await createDb(env.DB).get<{ id: string }>(sql`SELECT s.id FROM grants s
    WHERE s.owner_id = ${auth.accountId} AND ${liveGrant()} AND ${affectedRotationGrant(job.jobId)} AND EXISTS (
      SELECT 1 FROM encryption_devices d WHERE d.account_id = s.recipient_id AND d.state = 'active'
        AND NOT (${activeGrantCoverage(sql`d.id`)})) AND ${privateReadGuard(auth)} ORDER BY s.id LIMIT 1`);
  if (!missing) return Response.json({ job, operation: "finish" }, { headers });
  const rootMissing = await createDb(env.DB).get(sql`SELECT 1 FROM grants s JOIN encryption_devices d
    ON d.account_id = s.recipient_id AND d.state = 'active' WHERE s.id = ${missing.id} AND ${liveGrant()}
      AND NOT (${activeRootCoverage(sql`d.id`)}) AND ${privateReadGuard(auth)} LIMIT 1`);
  const comment = !rootMissing ? await createDb(env.DB).get<{ object_id: string }>(sql`SELECT c.object_id FROM grants s
    JOIN sharing_comment_capabilities c ON c.object_id IN (SELECT object_id FROM (${requiredGrantComments()}))
    WHERE s.id = ${missing.id} AND ${liveGrant()} AND EXISTS (SELECT 1 FROM encryption_devices d WHERE d.account_id = s.recipient_id AND d.state = 'active'
      AND NOT EXISTS (SELECT 1 FROM grant_comment_key_envelopes e WHERE e.relationship_id = s.id AND e.device_id = d.id
        AND e.object_id = c.object_id AND e.capability_id = c.capability_id AND e.capability_epoch = c.capability_epoch
        AND e.grant_key_epoch = s.key_epoch)) AND ${privateReadGuard(auth)} ORDER BY c.object_id LIMIT 1`) : null;
  return Response.json({ job, operation: "deliver", grantId: missing.id, ...(comment ? { commentObjectId: comment.object_id } : {}) }, { headers });
}

/** Bodyless reads never consume proofs. Mutations carry exact bounded bytes. */
export async function rotationAction(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  const list = path === "/api/private/key-rotations";
  const next = /^\/api\/private\/key-rotations\/([0-9a-f-]+)\/next$/.exec(path);
  const step = /^\/api\/private\/key-rotations\/([0-9a-f-]+)\/step$/.exec(path);
  const entries = /^\/api\/private\/key-rotations\/([0-9a-f-]+)\/items\/([0-9a-f-]+)\/entries$/.exec(path);
  const commentItems = /^\/api\/private\/key-rotations\/([0-9a-f-]+)\/items\/([0-9a-f-]+)\/comment-items$/.exec(path);
  const sourcePath = /^\/api\/private\/key-rotations\/([0-9a-f-]+)\/comments\/([0-9a-f-]+)$/.exec(path);
  const delivery = /^\/api\/private\/key-rotations\/([0-9a-f-]+)\/grants\/([0-9a-f-]+)\/keys$/.exec(path);
  const commentDelivery = /^\/api\/private\/key-rotations\/([0-9a-f-]+)\/grants\/([0-9a-f-]+)\/comment-keys\/([0-9a-f-]+)$/.exec(path);
  const match = next || step || entries || commentItems || sourcePath || delivery || commentDelivery;
  const reading = request.method === "POST";
  if (!(reading && (list || next || entries || commentItems || sourcePath || delivery || commentDelivery) || request.method === "PATCH" && step ||
      request.method === "PUT" && (delivery || commentDelivery)) || match && match.slice(1).some((id) => !isV7(id))) return failure("not_found", 404);
  const cursor = url.searchParams.get("cursor"), staged = url.searchParams.get("staged") === "1";
  if (Array.from(url.searchParams.keys()).some((key) => !(list || entries || commentItems) || key !== "cursor" && !(entries && key === "staged")) ||
      url.searchParams.getAll("cursor").length > 1 || url.searchParams.getAll("staged").length > 1 ||
      url.searchParams.has("staged") && !staged || cursor !== null && !isV7(cursor)) return failure("invalid_rotation_request", 400);
  let proof: unknown, raw = "", value: unknown;
  try {
    if (reading) { if (!await hasEmptyBody(request)) return failure("device_proof_required", 403); }
    else { const parsed = await readAuthJsonText(request, 1536 * 1024); raw = parsed.raw; value = parsed.value; }
    proof = JSON.parse(request.headers.get("X-Mdwn-Device-Proof") ?? "null");
  } catch { return failure("invalid_rotation_request", 400); }
  const auth = await authorizePrivateRequest(request, env, proof, raw);
  if (!auth) return failure("device_proof_required", 403);
  if (list) {
    const rows = await createDb(env.DB).all<RotationJob & { runnableFlag: number }>(sql`SELECT j.id AS jobId,
      j.target_id AS targetId, j.key_epoch AS keyEpoch, j.state, j.progress,
      CASE WHEN j.key_epoch = b.key_epoch AND NOT ${hasExpiredGrants(auth)} AND ${rotationOrder()} THEN 1 ELSE 0 END AS runnableFlag
      FROM crypto_jobs j LEFT JOIN sharing_write_blocks b ON b.target_id = j.target_id
      WHERE j.account_id = ${auth.accountId} AND j.kind = 'key_rotation' AND j.state = 'pending'
        AND j.id > ${cursor ?? ""} AND ${privateReadGuard(auth)} ORDER BY j.id LIMIT 21`);
    return Response.json({ jobs: rows.slice(0, 20).map(({ runnableFlag, ...job }) => ({ ...job, runnable: runnableFlag === 1 })),
      nextCursor: rows.length > 20 ? rows[19]!.jobId : null }, { headers });
  }
  const job = await readRotationJob(env, auth, match![1]!);
  if (!job) return failure("not_found", 404);
  if (next) return nextRotation(env, auth, job);
  if (step) return stepRotation(env, auth, job, record(value), raw);
  if (job.state !== "pending") return failure("rotation_changed", 409);
  if (delivery || commentDelivery) {
    const grantId = (delivery || commentDelivery)![2]!;
    if (!await createDb(env.DB).get(sql`SELECT 1 WHERE ${rotationDeliveryPermit(auth, job.jobId, grantId)} AND ${privateReadGuard(auth)}`))
      return failure("rotation_changed", 409);
    if (delivery) return reading ? readGrantKeys(env, auth, "grants", grantId, null, true)
      : uploadGrantKeys(env, auth, "grants", grantId, value, job.jobId);
    return reading ? readCommentKey(env, auth, "grants", grantId, commentDelivery![3]!, null, true)
      : uploadCommentKeys(env, auth, "grants", grantId, commentDelivery![3]!, value, job.jobId);
  }
  if (sourcePath) {
    const c = await createDb(env.DB).get<{ file_id: string; purpose: string }>(sql`SELECT file_id, purpose FROM sharing_comment_capabilities
      WHERE object_id = ${sourcePath[2]} AND owner_id = ${auth.accountId} AND ${privateReadGuard(auth)}`);
    if (!c) return failure("not_found", 404);
    const source = await readRotationSource(env, auth, { objectId: sourcePath[2]!, kind: c.purpose === "private-comment-thread" ? "private_comment" : "public_history",
      fileId: c.file_id, depth: 0, state: "ready", sourceEpoch: null, targetEpoch: null, capabilityId: null,
      sourceRevision: null, sourceRepresentationId: null, resumeEnvelope: null, cursor: null, rotate: false });
    return source ? Response.json(source, { headers }) : failure("not_found", 404);
  }
  if (commentItems) {
    const item = await readRotationItem(env, auth, job, commentItems[2]!);
    if (!item || (item.kind !== "private_comment" && !(item.kind === "public_history" && item.rotate))) {
      return failure("not_found", 404);
    }
    return Response.json(await rotationCommentItems(env, auth, job, item, cursor), { headers });
  }
  const item = await readRotationItem(env, auth, job, entries![2]!);
  if (!item || item.kind !== "directory") return failure("not_found", 404);
  return Response.json(await rotationEntries(env, auth, job, item, cursor, staged), { headers });
}
