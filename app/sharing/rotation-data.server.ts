import type { SQL } from "drizzle-orm";
import { createDb, sql } from "~/db/client.server";
import { privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { encodeTreeBytes } from "~/tree/wire";
import type { RotationEntries, RotationItem, RotationJob, RotationSource } from "./rotation-wire";
import { activeGrantCoverage, requiredGrantComments } from "./capability-coverage.server";
import { hasExpiredGrants, liveGrant } from "./grant-lifetime.server";

export const ROTATION_PAGE = 20;
const encoded = (value: ArrayBuffer | null) => value ? encodeTreeBytes(new Uint8Array(value)) : null;

export type RotationCommentRecord = { recordId: string; kind: "comment" | "attribution"; revision: number; contentKeyEnvelope: string };

export async function readRotationJob(env: Env, auth: AuthorizedDevice, jobId: string) {
  return createDb(env.DB).get<RotationJob>(sql`SELECT id AS jobId, target_id AS targetId, key_epoch AS keyEpoch, state, progress
    FROM crypto_jobs WHERE id = ${jobId} AND account_id = ${auth.accountId} AND kind = 'key_rotation' AND ${privateReadGuard(auth)}`);
}

function rotationAncestor(ancestor: SQL, descendant: SQL) {
  return sql`EXISTS (WITH RECURSIVE lineage(id, parent_node_id, depth) AS (
    SELECT id, parent_node_id, 0 FROM vault_nodes WHERE id = ${descendant}
    UNION ALL SELECT n.id, n.parent_node_id, a.depth + 1 FROM lineage a JOIN vault_nodes n ON n.id = a.parent_node_id WHERE a.depth < 100
  ) SELECT 1 FROM lineage WHERE id = ${ancestor} AND depth > 0)`;
}

function rotationUnblocked(job: SQL) {
  return sql`NOT EXISTS (SELECT 1 FROM crypto_jobs ancestor WHERE ancestor.account_id = ${job}.account_id
    AND ancestor.kind = 'key_rotation' AND ancestor.state = 'pending' AND ancestor.id != ${job}.id
    AND ${rotationAncestor(sql`ancestor.target_id`, sql`${job}.target_id`)})`;
}

/** Relationship alias j. Ancestor seals preempt even older descendant jobs:
 * a replacement child may never be promoted under a newly compromised parent.
 * Only ancestor-unblocked jobs serialize by ID, so unrelated work cannot wait on
 * a preempted descendant and deadlock the ancestor that must replace its parent. */
export function rotationOrder() {
  return sql`${rotationUnblocked(sql`j`)}
    AND NOT EXISTS (SELECT 1 FROM crypto_jobs earlier WHERE earlier.account_id = j.account_id
      AND earlier.kind = 'key_rotation' AND earlier.state = 'pending' AND earlier.id < j.id
      AND ${rotationUnblocked(sql`earlier`)})`;
}

/** Serialize work, not devices. Revocation itself is never held by this predicate. */
export function liveRotation(auth: AuthorizedDevice, job: RotationJob) {
  return sql`EXISTS (SELECT 1 FROM crypto_jobs j JOIN sharing_write_blocks b ON b.target_id = j.target_id
    WHERE j.id = ${job.jobId} AND j.account_id = ${auth.accountId} AND j.kind = 'key_rotation' AND j.state = 'pending'
      AND j.key_epoch = ${job.keyEpoch} AND b.key_epoch = j.key_epoch
      AND NOT ${hasExpiredGrants(auth)} AND ${rotationOrder()})`;
}

export async function readRotationItem(env: Env, auth: AuthorizedDevice, job: RotationJob, objectId?: string) {
  const row = await createDb(env.DB).get<Omit<RotationItem, "resumeEnvelope"> & { resume: ArrayBuffer | null }>(sql`
    SELECT object_id AS objectId, kind, file_id AS fileId, depth, state, source_epoch AS sourceEpoch,
      target_epoch AS targetEpoch, capability_id AS capabilityId, source_revision AS sourceRevision,
      source_representation_id AS sourceRepresentationId, resume_envelope AS resume, cursor
    FROM key_rotation_items WHERE job_id = ${job.jobId}
      AND ${objectId ? sql`object_id = ${objectId}` : sql`state != 'complete'`}
      AND ${privateReadGuard(auth)} ORDER BY depth, object_id LIMIT 1`);
  if (!row) return null;
  const { resume, ...item } = row;
  return { ...item, resumeEnvelope: encoded(resume) };
}

export async function readRotationSource(env: Env, auth: AuthorizedDevice, item: RotationItem): Promise<RotationSource | null> {
  const db = createDb(env.DB), guard = privateReadGuard(auth);
  if (item.kind === "directory") {
    const row = await db.get<{ parent_node_id: string | null; key_epoch: number; entries_revision: number;
      listing_ciphertext: ArrayBuffer | null; listing_digest: ArrayBuffer | null; listing_signature: ArrayBuffer | null;
      listing_device_id: string | null; public_key: ArrayBuffer | null }>(sql`
      SELECT n.parent_node_id, d.*, signer.assertion_public_key AS public_key FROM directories d
      JOIN vault_nodes n ON n.id = d.node_id AND n.owner_id = d.owner_id
      LEFT JOIN encryption_devices signer ON signer.id = d.listing_device_id
      WHERE d.node_id = ${item.objectId} AND d.owner_id = ${auth.accountId} AND ${guard}`);
    if (!row) return null;
    return { kind: "directory", objectId: item.objectId, parentId: row.parent_node_id, keyEpoch: row.key_epoch,
      entriesRevision: row.entries_revision, listingHead: row.listing_ciphertext && row.listing_digest && row.listing_signature && row.public_key && row.listing_device_id ? {
        ciphertext: encoded(row.listing_ciphertext)!, digest: encoded(row.listing_digest)!, signature: encoded(row.listing_signature)!,
        signerDeviceId: row.listing_device_id, signerPublicKey: encoded(row.public_key)!,
      } : null };
  }
  if (item.kind === "file") {
    const row = await db.get<{ parent_node_id: string; capability_id: string | null; capability_epoch: number | null;
      current_revision: number; current_representation_id: string; content_key_id: string; key_epoch: number; ciphertext: ArrayBuffer;
      key_envelope: ArrayBuffer | null; parent_envelope: ArrayBuffer; head_digest: ArrayBuffer | null; head_signature: ArrayBuffer | null;
      head_device_id: string | null; public_key: ArrayBuffer | null }>(sql`
      SELECT n.parent_node_id, f.*, r.content_key_id, r.key_epoch, r.ciphertext, r.key_envelope,
        e.key_envelope AS parent_envelope, r.head_digest, r.head_signature, r.head_device_id,
        signer.assertion_public_key AS public_key FROM files f
      JOIN vault_nodes n ON n.id = f.node_id AND n.owner_id = f.owner_id
      JOIN file_representations r ON r.id = f.current_representation_id AND r.file_node_id = f.node_id AND r.owner_id = f.owner_id
      JOIN directory_entries e ON e.child_node_id = n.id AND e.parent_node_id = n.parent_node_id
      LEFT JOIN encryption_devices signer ON signer.id = r.head_device_id
      WHERE f.node_id = ${item.objectId} AND f.owner_id = ${auth.accountId} AND ${guard}`);
    if (!row) return null;
    return { kind: "file", objectId: item.objectId, parentId: row.parent_node_id,
      capability: row.capability_id ? { id: row.capability_id, epoch: row.capability_epoch! } : null,
      revision: row.current_revision, representationId: row.current_representation_id, contentKeyId: row.content_key_id,
      keyEpoch: row.key_epoch, ciphertext: encoded(row.ciphertext)!, keyEnvelope: encoded(row.parent_envelope)!,
      representationKeyEnvelope: encoded(row.key_envelope), fileHead: row.head_digest && row.head_signature && row.head_device_id && row.public_key ? {
        digest: encoded(row.head_digest)!, signature: encoded(row.head_signature)!, signerDeviceId: row.head_device_id,
        signerPublicKey: encoded(row.public_key)!,
      } : null };
  }
  const row = await db.get<{ file_id: string; capability_id: string; capability_epoch: number; purpose: "private-comment-thread" | "public-comment-audience-epoch";
    thread_id: string; publication_id: string | null; ciphertext: ArrayBuffer | null }>(sql`
    SELECT c.*, k.ciphertext FROM sharing_comment_capabilities c LEFT JOIN key_envelopes k
      ON k.account_id = c.owner_id AND k.object_id = c.object_id AND k.purpose = 'vault-recovery'
        AND k.recipient_id = 'vault-root' AND k.key_epoch = c.capability_epoch AND k.superseded_at IS NULL
    WHERE c.object_id = ${item.objectId} AND c.owner_id = ${auth.accountId} AND c.file_id = ${item.fileId} AND ${guard}`);
  return row ? { kind: item.kind, objectId: item.objectId, fileId: row.file_id, capabilityId: row.capability_id,
    capabilityEpoch: row.capability_epoch, purpose: row.purpose, threadId: row.thread_id,
    publicationId: row.publication_id, recoveryEnvelope: encoded(row.ciphertext) } : null;
}

export function rotationSourceSnapshot(item: RotationItem, source: RotationSource): SQL {
  if (source.kind === "directory") return sql`EXISTS (SELECT 1 FROM directories d JOIN vault_nodes n ON n.id = d.node_id
    WHERE d.node_id = ${item.objectId} AND d.key_epoch = ${source.keyEpoch} AND d.entries_revision = ${source.entriesRevision}
      AND n.parent_node_id IS ${source.parentId})`;
  if (source.kind === "file") return sql`EXISTS (SELECT 1 FROM files f JOIN vault_nodes n ON n.id = f.node_id
    WHERE f.node_id = ${item.objectId} AND f.current_revision = ${source.revision} AND f.current_representation_id = ${source.representationId}
      AND f.capability_id IS ${source.capability?.id ?? null} AND f.capability_epoch IS ${source.capability?.epoch ?? null}
      AND n.parent_node_id = ${source.parentId})`;
  return sql`EXISTS (SELECT 1 FROM sharing_comment_capabilities c WHERE c.object_id = ${item.objectId}
    AND c.file_id = ${source.fileId} AND c.capability_id = ${source.capabilityId} AND c.capability_epoch = ${source.capabilityEpoch})`;
}

/** One bounded page of a Private thread's current per-record content-key
 * wrappers. The browser rewraps each beneath the replacement thread capability;
 * body and pseudonym ciphertext are never opened by the service.
 */
export async function rotationCommentItems(env: Env, auth: AuthorizedDevice, job: RotationJob, item: RotationItem,
  cursor: string | null): Promise<{ records: RotationCommentRecord[]; nextCursor: string | null }> {
  const rows = await createDb(env.DB).all<{ record_id: string; kind: "comment" | "attribution"; revision: number;
    content_key_envelope: ArrayBuffer }>(sql`SELECT * FROM (
      SELECT id AS record_id, 'comment' AS kind, revision, content_key_envelope FROM comments
        WHERE thread_id = ${item.objectId} AND id > ${cursor ?? ""} AND ${privateReadGuard(auth)}
      UNION ALL
      SELECT id AS record_id, 'attribution' AS kind, revision, content_key_envelope FROM thread_attributions
        WHERE thread_id = ${item.objectId} AND id > ${cursor ?? ""} AND ${privateReadGuard(auth)}
    ) ORDER BY record_id LIMIT ${ROTATION_PAGE + 1}`);
  return { records: rows.slice(0, ROTATION_PAGE).map((row) => ({ recordId: row.record_id, kind: row.kind,
    revision: row.revision, contentKeyEnvelope: encoded(row.content_key_envelope)! })),
    nextCursor: rows.length > ROTATION_PAGE ? rows[ROTATION_PAGE - 1]!.record_id : null };
}

export async function rotationEntries(env: Env, auth: AuthorizedDevice, job: RotationJob, item: RotationItem,
  cursor: string | null, staged: boolean): Promise<RotationEntries> {
  const rows = await createDb(env.DB).all<{ child_id: string; kind: "file" | "directory"; key_epoch: number | null;
    name_ciphertext: ArrayBuffer; order_ciphertext: ArrayBuffer; key_envelope: ArrayBuffer }>(sql`
    SELECT ${staged ? sql`e.child_id` : sql`e.child_node_id`} AS child_id, n.kind, d.key_epoch,
      e.name_ciphertext, e.order_ciphertext, e.key_envelope FROM ${staged ? sql`key_rotation_entries` : sql`directory_entries`} e
    JOIN vault_nodes n ON n.id = ${staged ? sql`e.child_id` : sql`e.child_node_id`}
    LEFT JOIN directories d ON d.node_id = n.id
    WHERE ${staged ? sql`e.job_id = ${job.jobId} AND e.directory_id = ${item.objectId}` : sql`e.parent_node_id = ${item.objectId} AND e.owner_id = ${auth.accountId}`}
      AND ${staged ? sql`e.child_id` : sql`e.child_node_id`} > ${cursor ?? ""} AND ${privateReadGuard(auth)}
    ORDER BY child_id LIMIT ${ROTATION_PAGE + 1}`);
  return { entries: rows.slice(0, ROTATION_PAGE).map((row) => ({ nodeId: row.child_id, kind: row.kind,
    ...(row.kind === "directory" ? { keyEpoch: row.key_epoch! } : {}),
    nameCiphertext: encoded(row.name_ciphertext)!, orderCiphertext: encoded(row.order_ciphertext)!, keyEnvelope: encoded(row.key_envelope)! })),
    nextCursor: rows.length > ROTATION_PAGE ? rows[ROTATION_PAGE - 1]!.child_id : null };
}

/** Relationship alias s. Include ancestor Grants with affected Comment history. */
export function affectedRotationGrant(jobId: string) {
  return sql`(EXISTS (SELECT 1 FROM key_rotation_items i WHERE i.job_id = ${jobId} AND i.object_id = s.target_id
      AND i.kind IN ('directory', 'file')) OR EXISTS (SELECT 1 FROM (${requiredGrantComments()}) c
      JOIN key_rotation_items i ON i.object_id = c.object_id WHERE i.job_id = ${jobId}))`;
}
export function currentRotationCoverage(jobId: string) {
  return sql`NOT EXISTS (SELECT 1 FROM grants s JOIN encryption_devices d ON d.account_id = s.recipient_id AND d.state = 'active'
    WHERE ${liveGrant()} AND ${affectedRotationGrant(jobId)} AND NOT (${activeGrantCoverage(sql`d.id`)}))`;
}
export function rotationDeliveryPermit(auth: AuthorizedDevice, jobId: string, relationshipId: string) {
  return sql`EXISTS (SELECT 1 FROM crypto_jobs j JOIN sharing_write_blocks b ON b.target_id = j.target_id
    JOIN grants s ON s.id = ${relationshipId} AND s.owner_id = j.account_id
    WHERE j.id = ${jobId} AND j.account_id = ${auth.accountId} AND j.kind = 'key_rotation' AND j.state = 'pending'
      AND b.key_epoch = j.key_epoch AND ${liveGrant()} AND NOT ${hasExpiredGrants(auth)} AND ${affectedRotationGrant(jobId)}
      AND NOT EXISTS (SELECT 1 FROM key_rotation_items i WHERE i.job_id = j.id AND i.state != 'complete')
      AND ${rotationOrder()})`;
}
