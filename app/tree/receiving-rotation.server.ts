import type { SQL } from "drizzle-orm";
import { parseThreadRotation, ThreadRotationChangedError, threadRotationGuard, threadRotationStatements,
  type ThreadRotation } from "~/comments/comments.server";
import { sql } from "~/db/client.server";
import type { AuthorizedDevice } from "~/device/proof.server";
import { assertFileHeadCommitTransition, verifyFileHead, verifyFileParentEnvelope, verifyFileReceivingTarget,
  type SignedFileHead } from "./file-head";
import { headRow, parseHead, verified } from "./file-v2.server";
import { decodeTreeBytes, isV7, treeEnvelope } from "./wire";

/**
 * One v2 File's receiving-pair rotation: a fresh pair whose private key is wrapped under the
 * File's (new) parent capability, a same-revision `receiving-rotation` File head, and a new
 * Private thread epoch sealed to the new receiving key. Used by a move and by a subtree rekey.
 */
export const RECEIVING_ROTATION_FIELDS = ["expectedHeadDigest", "receivingKeyId", "receivingEpoch", "wrapRevision",
  "receivingPublicKey", "parentEnvelope", "signedHead", "thread"] as const;

export type CurrentReceiving = { receiving_key_id: string | null; receiving_epoch: number | null;
  wrap_revision: number | null };
export type ReceivingRotation = { expectedHeadDigest: Uint8Array; receivingKeyId: string; receivingEpoch: number;
  wrapRevision: number; publicKey: Uint8Array; parentEnvelope: Uint8Array; signed: SignedFileHead;
  keyEnvelope: Uint8Array; threadInput: unknown; thread: ThreadRotation };

export class ReceivingRotationError extends Error {
  constructor(readonly code: "invalid" | "changed" | "missing") { super(code); }
}

/** Structural parse; throws for any malformed or non-successor coordinate. */
export function parseReceivingRotation(input: Record<string, unknown>, ownerId: string, fileId: string,
  current: CurrentReceiving): ReceivingRotation {
  if (!current.receiving_key_id || !current.receiving_epoch || !current.wrap_revision ||
      !isV7(input.receivingKeyId) || input.receivingKeyId === current.receiving_key_id ||
      input.receivingEpoch !== current.receiving_epoch + 1 || input.wrapRevision !== current.wrap_revision + 1) {
    throw new ReceivingRotationError("invalid");
  }
  const receivingKeyId = input.receivingKeyId, receivingEpoch = input.receivingEpoch as number;
  const wrapRevision = input.wrapRevision as number;
  return { expectedHeadDigest: decodeTreeBytes(input.expectedHeadDigest, 32), receivingKeyId, receivingEpoch,
    wrapRevision, publicKey: decodeTreeBytes(input.receivingPublicKey, 65),
    parentEnvelope: decodeTreeBytes(input.parentEnvelope, 16_384), signed: parseHead(input.signedHead),
    keyEnvelope: treeEnvelope(input.keyEnvelope, 16_384, { purpose: "file-receiving-key", vaultId: ownerId,
      objectId: fileId, keyId: receivingKeyId, keyEpoch: receivingEpoch, revision: wrapRevision }),
    threadInput: input.thread, thread: null };
}

/** Verifies the signed head transition, new target and parent envelope, and the thread rotation. */
export async function verifyReceivingRotation(env: Env, auth: AuthorizedDevice, ownerId: string, fileId: string,
  current: CurrentReceiving, rotation: ReceivingRotation): Promise<ReceivingRotation> {
  const head = await headRow(env, auth, ownerId, fileId);
  if (!head) throw new ReceivingRotationError("missing");
  const digest = new Uint8Array(head.digest);
  if (digest.length !== rotation.expectedHeadDigest.length ||
      digest.some((byte, index) => byte !== rotation.expectedHeadDigest[index]) ||
      head.receiving_key_id !== current.receiving_key_id || head.receiving_epoch !== current.receiving_epoch) {
    throw new ReceivingRotationError("changed");
  }
  try {
    const before = await verified(head);
    const after = await verifyFileHead(rotation.signed, { ownerId, vaultId: ownerId, fileId,
      signerDeviceId: auth.deviceId, publicKey: auth.assertionPublicKey, revision: head.revision });
    assertFileHeadCommitTransition(before, after, { expectedSameRevisionTransition: "receiving-rotation" });
    if (after.statement.receivingKey.id !== rotation.receivingKeyId ||
        after.statement.receivingKey.epoch !== rotation.receivingEpoch) throw new Error("invalid receiving key");
    await verifyFileReceivingTarget(after, rotation.publicKey);
    await verifyFileParentEnvelope(after, rotation.parentEnvelope);
    return { ...rotation, thread: await parseThreadRotation(env, ownerId, fileId, rotation.threadInput,
      { keyId: rotation.receivingKeyId, epoch: rotation.receivingEpoch }) };
  } catch (error) {
    throw new ReceivingRotationError(error instanceof ThreadRotationChangedError ? "changed" : "invalid");
  }
}

/** Same-batch precondition: the File head and thread are exactly as verified. */
export function receivingRotationGuard(ownerId: string, fileId: string, current: CurrentReceiving,
  rotation: ReceivingRotation): SQL {
  return sql`EXISTS (SELECT 1 FROM file_heads h WHERE h.file_node_id = ${fileId} AND h.owner_id = ${ownerId}
      AND h.digest = ${rotation.expectedHeadDigest} AND h.receiving_key_id = ${current.receiving_key_id}
      AND h.receiving_epoch = ${current.receiving_epoch})
    AND ${threadRotationGuard(ownerId, fileId, rotation.thread)}`;
}

/** The new head and receiving target, then the thread's new epoch. */
export async function receivingRotationStatements(auth: AuthorizedDevice, ownerId: string, fileId: string,
  rotation: ReceivingRotation, now: number, live: SQL): Promise<SQL[]> {
  return [
    sql`UPDATE file_heads SET bytes = ${rotation.signed.bytes}, digest = ${rotation.signed.digest},
        signature = ${rotation.signed.signature}, signer_device_id = ${auth.deviceId},
        receiving_public_key = ${rotation.publicKey}, receiving_key_id = ${rotation.receivingKeyId},
        receiving_epoch = ${rotation.receivingEpoch}, parent_envelope = ${rotation.parentEnvelope}
      WHERE file_node_id = ${fileId} AND owner_id = ${ownerId} AND digest = ${rotation.expectedHeadDigest}
        AND ${live}`,
    ...await threadRotationStatements(rotation.thread, now, live),
  ];
}
