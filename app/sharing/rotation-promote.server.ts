import type { SQL } from "drizzle-orm";
import { record } from "~/auth/request.server";
import { digestEnvelope } from "~/shared/crypto/enc-v1";
import { sql } from "~/shared/db/client.server";
import type { AuthorizedDevice } from "~/device/proof.server";
import { MAX_LISTING_BYTES, verifyListingSignature, type ListingHead } from "~/shared/tree/listing";
import { verifyFileHead, type FileHead } from "~/shared/tree/file-head";
import { decodeTreeBytes, isV7, treeEnvelope } from "~/shared/tree/wire";
import { readRotationSource, rotationSourceSnapshot } from "./rotation-data.server";
import { liveGrant } from "./grant-lifetime.server";
import type { RotationDirectory, RotationItem, RotationJob, RotationSource } from "../shared/sharing/rotation-wire";

const exact = (input: Record<string, unknown>, fields: string[]) =>
  Object.keys(input).length === fields.length && fields.every((field) => Object.hasOwn(input, field));
type HeadBytes = { ciphertext: Uint8Array; digest: Uint8Array; signature: Uint8Array };

/** A File replacement re-wraps every imported Historical thread envelope it read
 * under the replacement File capability key. The browser sends one entry per
 * thread it saw; the promotion CAS rejects a changed set rather than leaving a
 * thread wrapped under the replaced key. */
function rewrappedImportedThreads(value: unknown, auth: AuthorizedDevice) {
  if (!Array.isArray(value) || value.length > 20) throw new Error("invalid imported threads");
  return value.map((entry) => {
    const thread = record(entry);
    if (
      !thread ||
      !exact(thread, ["threadId", "capabilityId", "capabilityEpoch", "envelope"]) ||
      !isV7(thread.threadId) ||
      !isV7(thread.capabilityId) ||
      !Number.isSafeInteger(thread.capabilityEpoch) ||
      (thread.capabilityEpoch as number) < 1
    )
      throw new Error("invalid imported thread");
    return {
      threadId: thread.threadId as string,
      capabilityId: thread.capabilityId as string,
      capabilityEpoch: thread.capabilityEpoch as number,
      ciphertext: treeEnvelope(thread.envelope, 16_384, {
        purpose: "private-comment-thread",
        vaultId: auth.accountId,
        objectId: thread.threadId as string,
        keyId: thread.capabilityId as string,
        keyEpoch: thread.capabilityEpoch as number,
        revision: 1,
      }),
    };
  });
}

export async function rotationHead(
  value: unknown,
  auth: AuthorizedDevice,
  directoryId: string,
  epoch: number,
  revision: number,
): Promise<HeadBytes> {
  const head = record(value);
  if (!head || !exact(head, ["ciphertext", "digest", "signature"])) throw new Error("invalid head");
  const ciphertext = treeEnvelope(head.ciphertext, MAX_LISTING_BYTES, {
    purpose: "directory-metadata",
    vaultId: auth.accountId,
    objectId: directoryId,
    keyId: directoryId,
    keyEpoch: epoch,
    revision,
  });
  const digest = decodeTreeBytes(head.digest, 32),
    signature = decodeTreeBytes(head.signature, 64);
  if (
    digest.length !== 32 ||
    signature.length !== 64 ||
    !(await digestEnvelope(ciphertext)).every((byte, index) => byte === digest[index]) ||
    !(await verifyListingSignature(head as ListingHead, {
      vaultId: auth.accountId,
      directoryId,
      deviceId: auth.deviceId,
      revision,
      publicKey: auth.assertionPublicKey,
    }))
  )
    throw new Error("invalid head");
  return { ciphertext, digest, signature };
}

export async function preparePromotion(
  env: Env,
  auth: AuthorizedDevice,
  job: RotationJob,
  item: RotationItem,
  source: RotationSource,
  input: Record<string, unknown>,
): Promise<{ eligible: SQL; statements(marker: SQL): SQL[] }> {
  const common = ["operation", "operationId", "objectId"];
  if (source.kind === "private_comment" || source.kind === "public_history") {
    const imported = source.kind === "private_comment" && source.importEnvelope !== null;
    if (!exact(input, [...common, imported ? "importEnvelope" : "recoveryEnvelope"]))
      throw new Error("invalid comment promotion");
    // An imported Historical thread has no vault-recovery row: its key is
    // wrapped under the File capability key, so its replacement is a fresh
    // import envelope and the File's current capability epoch is its wrapper.
    const replacement = imported
      ? treeEnvelope(input.importEnvelope, 16_384, {
          purpose: "private-comment-thread",
          vaultId: auth.accountId,
          objectId: item.objectId,
          keyId: item.capabilityId!,
          keyEpoch: item.targetEpoch!,
          revision: 1,
        })
      : treeEnvelope(input.recoveryEnvelope, 16_384, {
          purpose: "vault-recovery",
          vaultId: auth.accountId,
          objectId: item.objectId,
          keyId: item.capabilityId!,
          keyEpoch: item.targetEpoch!,
          revision: 1,
        });
    const capabilityStatements = (marker: SQL): SQL[] => [
      sql`UPDATE sharing_comment_capabilities SET capability_epoch = ${item.targetEpoch}
        WHERE object_id = ${item.objectId} AND owner_id = ${auth.accountId} AND ${marker}`,
      ...(imported
        ? [
            sql`UPDATE import_comment_envelopes SET ciphertext = ${replacement}, capability_epoch = ${item.targetEpoch},
              key_epoch = (SELECT capability_epoch FROM files WHERE node_id = ${item.fileId})
              WHERE thread_id = ${item.objectId} AND file_id = ${item.fileId} AND capability_id = ${item.capabilityId}
                AND capability_epoch = ${item.sourceEpoch} AND ${marker}`,
          ]
        : [
            sql`UPDATE key_envelopes SET superseded_at = ${Date.now()} WHERE account_id = ${auth.accountId}
              AND object_id = ${item.objectId} AND purpose = 'owned-device' AND key_epoch != ${item.targetEpoch} AND superseded_at IS NULL AND ${marker}`,
            sql`INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch)
              SELECT ${auth.accountId}, 'vault-recovery', ${item.objectId}, 'vault-root', ${replacement}, ${item.targetEpoch} WHERE ${marker}
              ON CONFLICT (account_id, purpose, object_id, recipient_id) DO UPDATE SET ciphertext = excluded.ciphertext,
                key_epoch = excluded.key_epoch, superseded_at = NULL`,
          ]),
      sql`DELETE FROM share_comment_key_envelopes WHERE object_id = ${item.objectId}
        AND capability_epoch != ${item.targetEpoch} AND ${marker}`,
      sql`DELETE FROM grant_comment_key_envelopes WHERE object_id = ${item.objectId}
        AND capability_epoch != ${item.targetEpoch} AND ${marker}`,
    ];
    // A retained Public Comment audience epoch keeps its key: only the current
    // Collaborators-only epoch advances in place, because a revoked device may
    // still hold that key. A revoked device never receives the replacement.
    if (source.kind === "public_history" && !item.rotate) {
      return { eligible: rotationSourceSnapshot(item, source), statements: capabilityStatements };
    }
    // A Private thread or a rotating Public epoch promotes only once every
    // current body and pseudonym wrapper is staged; deletion during staging is
    // allowed and simply drops the staged row, while an advanced revision blocks.
    const scope = (table: string) =>
      source.kind === "public_history"
        ? sql`${sql.raw(table)}.epoch_id = ${item.objectId}`
        : sql`${sql.raw(table)}.thread_id = ${item.objectId}`;
    const staged = (kind: "comment" | "attribution", table: string) => sql`EXISTS (
      SELECT 1 FROM key_rotation_comment_items staged WHERE staged.job_id = ${job.jobId}
        AND staged.thread_id = ${item.objectId} AND staged.kind = ${kind} AND staged.record_id = ${sql.raw(table)}.id
        AND staged.revision = ${sql.raw(table)}.revision)`;
    const complete = (kind: "comment" | "attribution", table: string) => sql`NOT EXISTS (
      SELECT 1 FROM ${sql.raw(table)} WHERE ${scope(table)} AND NOT (${staged(kind, table)}))`;
    const rewrap = (marker: SQL, kind: "comment" | "attribution", table: string) => sql`UPDATE ${sql.raw(table)} SET
      content_key_envelope = (SELECT staged.content_key_envelope FROM key_rotation_comment_items staged
        WHERE staged.job_id = ${job.jobId} AND staged.thread_id = ${item.objectId} AND staged.kind = ${kind}
          AND staged.record_id = ${sql.raw(table)}.id),
      content_key_epoch = ${item.targetEpoch}
      WHERE ${scope(table)} AND ${marker} AND ${staged(kind, table)}`;
    const epochScope =
      source.kind === "public_history"
        ? sql`id = ${item.objectId} AND state = 'active'`
        : sql`thread_id = ${item.objectId} AND state = 'active'`;
    return {
      eligible: sql`${rotationSourceSnapshot(item, source)}
      AND ${complete("comment", "comments")} AND ${complete("attribution", "thread_attributions")}`,
      statements: (marker) => [
        rewrap(marker, "comment", "comments"),
        rewrap(marker, "attribution", "thread_attributions"),
        sql`UPDATE comment_thread_epochs SET key_epoch = ${item.targetEpoch}
          WHERE ${epochScope} AND ${marker}`,
        ...capabilityStatements(marker),
      ],
    };
  }
  if (
    !exact(input, [
      ...common,
      "keyEnvelope",
      "parent",
      "recoveryEnvelope",
      ...(source.kind === "directory"
        ? ["listingHead"]
        : ["representationId", "representationKeyEnvelope", "fileHead", "importedThreads"]),
    ])
  )
    throw new Error("invalid promotion");
  const imported = source.kind === "file" ? rewrappedImportedThreads(input.importedThreads, auth) : [];
  const parentId = source.parentId;
  let parent: RotationDirectory | null = null,
    parentHead: HeadBytes | null = null;
  if (parentId) {
    const p = record(input.parent);
    if (!p || !exact(p, ["directoryId", "expectedRevision", "keyEpoch", "listingHead"]) || p.directoryId !== parentId)
      throw new Error("invalid parent");
    const read = await readRotationSource(env, auth, { ...item, objectId: parentId, kind: "directory" });
    if (
      !read ||
      read.kind !== "directory" ||
      p.expectedRevision !== read.entriesRevision ||
      p.keyEpoch !== read.keyEpoch
    )
      throw new Error("changed parent");
    parent = read;
    parentHead = await rotationHead(p.listingHead, auth, parentId, parent.keyEpoch, parent.entriesRevision + 1);
  } else if (input.parent !== null) throw new Error("invalid root");
  const recovery = treeEnvelope(input.recoveryEnvelope, 16_384, {
    purpose: "vault-recovery",
    vaultId: auth.accountId,
    objectId: item.objectId,
    keyId: item.capabilityId!,
    keyEpoch: item.targetEpoch!,
    revision: 1,
  });
  const keyEnvelope = parentId
    ? treeEnvelope(input.keyEnvelope, 16_384, {
        purpose: source.kind === "directory" ? "directory-capability" : "file-capability",
        vaultId: auth.accountId,
        objectId: item.objectId,
        keyId: item.capabilityId!,
        keyEpoch: item.targetEpoch!,
        revision: 1,
      })
    : recovery;
  if (!parentId && input.keyEnvelope !== input.recoveryEnvelope) throw new Error("invalid root envelope");
  const eligible = sql`${rotationSourceSnapshot(item, source)} AND ${parent ? rotationSourceSnapshot({ ...item, objectId: parent.objectId }, parent) : sql`1`}`;
  const parentStatements = (marker: SQL): SQL[] =>
    parent && parentHead
      ? [
          sql`UPDATE directory_entries SET key_envelope = ${keyEnvelope} WHERE child_node_id = ${item.objectId}
      AND parent_node_id = ${parent.objectId} AND owner_id = ${auth.accountId} AND ${marker}`,
          sql`UPDATE directories SET entries_revision = entries_revision + 1, listing_ciphertext = ${parentHead.ciphertext},
      listing_digest = ${parentHead.digest}, listing_signature = ${parentHead.signature}, listing_device_id = ${auth.deviceId}
      WHERE node_id = ${parent.objectId} AND entries_revision = ${parent.entriesRevision} AND key_epoch = ${parent.keyEpoch} AND ${marker}`,
        ]
      : [];
  const recoveryStatements = (marker: SQL): SQL[] => [
    sql`UPDATE key_envelopes SET superseded_at = ${Date.now()} WHERE account_id = ${auth.accountId} AND object_id = ${item.objectId}
      AND purpose = 'owned-device' AND superseded_at IS NULL AND ${marker}`,
    sql`INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch)
      SELECT ${auth.accountId}, 'vault-recovery', ${item.objectId}, 'vault-root', ${recovery}, ${item.targetEpoch}
      WHERE ${marker} AND (${parentId === null ? 1 : 0} = 1 OR EXISTS (SELECT 1 FROM key_envelopes
        WHERE account_id = ${auth.accountId} AND object_id = ${item.objectId} AND purpose = 'vault-recovery' AND recipient_id = 'vault-root'))
      ON CONFLICT (account_id, purpose, object_id, recipient_id) DO UPDATE SET ciphertext = excluded.ciphertext,
        key_epoch = excluded.key_epoch, superseded_at = NULL`,
  ];
  const grantStatements = (marker: SQL): SQL[] => [
    sql`DELETE FROM share_key_envelopes WHERE relationship_id IN (SELECT id FROM shares WHERE target_id = ${item.objectId}) AND ${marker}`,
    sql`DELETE FROM grant_key_envelopes WHERE relationship_id IN (SELECT id FROM grants WHERE target_id = ${item.objectId}) AND ${marker}`,
    sql`DELETE FROM grant_comment_key_envelopes WHERE relationship_id IN (SELECT id FROM grants WHERE target_id = ${item.objectId}) AND ${marker}`,
    sql`DELETE FROM provisioning_needs WHERE grant_id IN (SELECT id FROM grants WHERE target_id = ${item.objectId}) AND ${marker}`,
    sql`UPDATE grants SET key_epoch = key_epoch + 1 WHERE target_id = ${item.objectId} AND owner_id = ${auth.accountId} AND ${marker}`,
    sql`INSERT INTO provisioning_needs (grant_id, device_id, grant_key_epoch) SELECT s.id, d.id, s.key_epoch
      FROM grants s JOIN encryption_devices d ON d.account_id = s.recipient_id AND d.state = 'active'
      WHERE s.target_id = ${item.objectId} AND s.owner_id = ${auth.accountId} AND ${liveGrant()} AND ${marker}`,
  ];
  if (source.kind === "directory") {
    const head = await rotationHead(
      input.listingHead,
      auth,
      item.objectId,
      item.targetEpoch!,
      source.entriesRevision + 1,
    );
    const completeEntries = sql`(SELECT count(*) FROM key_rotation_entries WHERE job_id = ${job.jobId} AND directory_id = ${item.objectId})
      = (SELECT count(*) FROM directory_entries WHERE parent_node_id = ${item.objectId})
      AND NOT EXISTS (SELECT 1 FROM directory_entries e WHERE e.parent_node_id = ${item.objectId} AND NOT EXISTS (
        SELECT 1 FROM key_rotation_entries staged WHERE staged.job_id = ${job.jobId}
          AND staged.directory_id = e.parent_node_id AND staged.child_id = e.child_node_id))`;
    return {
      eligible: sql`${eligible} AND ${completeEntries}`,
      statements: (marker) => [
        sql`UPDATE directory_entries SET name_ciphertext = (SELECT name_ciphertext FROM key_rotation_entries staged
          WHERE staged.job_id = ${job.jobId} AND staged.directory_id = ${item.objectId} AND staged.child_id = directory_entries.child_node_id),
        order_ciphertext = (SELECT order_ciphertext FROM key_rotation_entries staged
          WHERE staged.job_id = ${job.jobId} AND staged.directory_id = ${item.objectId} AND staged.child_id = directory_entries.child_node_id),
        key_envelope = (SELECT key_envelope FROM key_rotation_entries staged
          WHERE staged.job_id = ${job.jobId} AND staged.directory_id = ${item.objectId} AND staged.child_id = directory_entries.child_node_id)
        WHERE parent_node_id = ${item.objectId} AND owner_id = ${auth.accountId} AND ${marker}`,
        sql`UPDATE directories SET key_epoch = ${item.targetEpoch}, entries_revision = entries_revision + 1,
        listing_ciphertext = ${head.ciphertext}, listing_digest = ${head.digest}, listing_signature = ${head.signature}, listing_device_id = ${auth.deviceId}
        WHERE node_id = ${item.objectId} AND key_epoch = ${item.sourceEpoch} AND entries_revision = ${item.sourceRevision} AND ${marker}`,
        ...parentStatements(marker),
        ...recoveryStatements(marker),
        ...grantStatements(marker),
        sql`INSERT INTO key_rotation_items (job_id, object_id, kind, file_id, depth, state)
        SELECT ${job.jobId}, n.id, n.kind, CASE WHEN n.kind = 'file' THEN n.id ELSE NULL END, ${item.depth + 1}, 'ready'
        FROM vault_nodes n WHERE n.parent_node_id = ${item.objectId} AND n.owner_id = ${auth.accountId} AND ${marker}
        ON CONFLICT (job_id, object_id) DO NOTHING`,
      ],
    };
  }
  if (!isV7(input.representationId) || input.representationId === source.representationId)
    throw new Error("invalid representation");
  const wrapper = treeEnvelope(input.representationKeyEnvelope, 16_384, {
    purpose: "file-content-key",
    vaultId: auth.accountId,
    objectId: item.objectId,
    keyId: source.contentKeyId,
    keyEpoch: source.keyEpoch,
    revision: source.revision,
  });
  const head = record(input.fileHead);
  if (
    !head ||
    !exact(head, ["digest", "signature"]) ||
    !(await verifyFileHead(
      auth.assertionPublicKey,
      {
        vaultId: auth.accountId,
        fileId: item.objectId,
        capabilityId: item.capabilityId!,
        capabilityEpoch: item.targetEpoch!,
        representationId: input.representationId,
        contentKeyId: source.contentKeyId,
        keyEpoch: source.keyEpoch,
        revision: source.revision,
        deviceId: auth.deviceId,
        ciphertext: source.ciphertext,
        keyEnvelope: input.representationKeyEnvelope as string,
      },
      head as FileHead,
    ))
  )
    throw new Error("invalid File head");
  const content = decodeTreeBytes(source.ciphertext, 524_288);
  // Every imported Historical thread on the File must be re-wrapped in this
  // promotion: an omitted thread would stay sealed under the replaced key.
  const importedCoverage = imported.length
    ? sql` AND (SELECT count(*) FROM import_comment_envelopes i WHERE i.file_id = ${item.objectId}) = ${imported.length}
      AND ${sql.join(
        imported.map(
          (thread) => sql`EXISTS (SELECT 1 FROM import_comment_envelopes i WHERE i.file_id = ${item.objectId}
            AND i.thread_id = ${thread.threadId} AND i.capability_id = ${thread.capabilityId}
            AND i.capability_epoch = ${thread.capabilityEpoch})`,
        ),
        sql` AND `,
      )}`
    : sql``;
  return {
    eligible: sql`${eligible}${importedCoverage}`,
    statements: (marker) => [
      sql`UPDATE files SET current_representation_id = ${input.representationId}, capability_id = ${item.capabilityId}, capability_epoch = ${item.targetEpoch}
      WHERE node_id = ${item.objectId} AND owner_id = ${auth.accountId} AND ${marker}`,
      sql`DELETE FROM file_representations WHERE id = ${source.representationId} AND file_node_id = ${item.objectId} AND ${marker}`,
      sql`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id, key_epoch,
      ciphertext, ciphertext_size, created_at, key_envelope, head_digest, head_signature, head_device_id)
      SELECT ${input.representationId}, ${item.objectId}, ${auth.accountId}, ${source.revision}, ${source.contentKeyId}, ${source.keyEpoch},
        ${content}, ${content.length}, ${Date.now()}, ${wrapper}, ${decodeTreeBytes(head.digest, 32)}, ${decodeTreeBytes(head.signature, 64)}, ${auth.deviceId} WHERE ${marker}`,
      ...imported.map(
        (
          thread,
        ) => sql`UPDATE import_comment_envelopes SET ciphertext = ${thread.ciphertext}, key_epoch = ${item.targetEpoch}
          WHERE thread_id = ${thread.threadId} AND file_id = ${item.objectId} AND capability_id = ${thread.capabilityId}
            AND capability_epoch = ${thread.capabilityEpoch} AND ${marker}`,
      ),
      ...parentStatements(marker),
      ...recoveryStatements(marker),
      ...grantStatements(marker),
      sql`INSERT INTO key_rotation_items (job_id, object_id, kind, file_id, depth, state)
      SELECT ${job.jobId}, c.object_id, CASE WHEN c.purpose = 'private-comment-thread' THEN 'private_comment' ELSE 'public_history' END,
        c.file_id, ${item.depth + 1}, 'ready' FROM sharing_comment_capabilities c
      WHERE c.file_id = ${item.objectId} AND c.owner_id = ${auth.accountId} AND ${marker} ON CONFLICT (job_id, object_id) DO NOTHING`,
    ],
  };
}
