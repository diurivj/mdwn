import {
  EnvelopeError,
  inspectEnvelope,
  openForRecipient,
  sealToRecipient,
  type EnvelopeContext,
} from "~/shared/crypto/enc-v1";
import { isPublicationIdentifier } from "~/shared/publications/capability";
import { decodeTreeBytes, encodeTreeBytes, isV7 } from "~/shared/tree/wire";
import type { GrantKeyContext } from "./grant-keys";

export type CommentKeyContext = GrantKeyContext & {
  purpose: "private-comment-thread" | "public-comment-audience-epoch";
  fileId: string;
  threadId: string;
  objectId: string;
  publicationId: string | null;
};
type AddressedContext = CommentKeyContext & { deviceId: string; signerDeviceId: string };
type SignedEnvelope = AddressedContext & { ciphertext: string; signature: string };

function validate(context: AddressedContext) {
  if (
    ![
      context.relationshipId,
      context.ownerId,
      context.recipientId,
      context.targetId,
      context.capabilityId,
      context.deviceId,
      context.signerDeviceId,
      context.fileId,
      context.threadId,
      context.objectId,
    ].every(isV7) ||
    ![context.capabilityEpoch, context.grantKeyEpoch, context.ownerRegistryEpoch, context.recipientRegistryEpoch].every(
      (epoch) => Number.isSafeInteger(epoch) && epoch > 0,
    ) ||
    (context.targetKind !== "directory" && context.targetKind !== "file")
  )
    throw new Error("invalid comment key context");
  if (context.purpose === "private-comment-thread") {
    if (context.publicationId !== null || context.objectId !== context.threadId)
      throw new Error("invalid comment key context");
  } else if (context.purpose !== "public-comment-audience-epoch" || !isPublicationIdentifier(context.publicationId)) {
    throw new Error("invalid comment key context");
  }
}
function hpkeContext(context: AddressedContext): EnvelopeContext {
  return {
    purpose: context.purpose,
    vaultId: context.ownerId,
    objectId: context.objectId,
    keyId: context.capabilityId,
    keyEpoch: context.capabilityEpoch,
    revision: context.grantKeyEpoch,
    recipientId: context.deviceId,
    ...(context.publicationId === null ? {} : { publicationId: context.publicationId }),
  };
}
async function transcript(context: AddressedContext, ciphertext: Uint8Array) {
  validate(context);
  const digest = encodeTreeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(ciphertext))));
  return new TextEncoder().encode(
    JSON.stringify([
      "mdwn/grant-comment-key-envelope",
      1,
      context.relationshipId,
      context.ownerId,
      context.recipientId,
      context.targetId,
      context.targetKind,
      context.capabilityId,
      context.capabilityEpoch,
      context.grantKeyEpoch,
      context.ownerRegistryEpoch,
      context.recipientRegistryEpoch,
      context.deviceId,
      context.signerDeviceId,
      context.purpose,
      context.fileId,
      context.threadId,
      context.objectId,
      context.publicationId,
      digest,
    ]),
  );
}

export async function verifyCommentKeySignature(record: SignedEnvelope, signerPublicKey: string): Promise<boolean> {
  record = { ...record };
  try {
    const ciphertext = decodeTreeBytes(record.ciphertext, 16_384),
      signature = decodeTreeBytes(record.signature, 64);
    const envelope = inspectEnvelope(ciphertext),
      expected = hpkeContext(record);
    if (
      signature.length !== 64 ||
      envelope.suite !== "HPKE-P256/HKDF-SHA-256/AES-256-GCM" ||
      Object.keys(envelope.context).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, value]) => envelope.context[key as keyof EnvelopeContext] !== value)
    )
      return false;
    const key = await crypto.subtle.importKey(
      "raw",
      decodeTreeBytes(signerPublicKey, 65),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      await transcript(record, ciphertext),
    );
  } catch {
    return false;
  }
}

export async function createCommentKeyEnvelope(
  key: Uint8Array,
  recipientPublicKey: CryptoKey,
  assertionPrivateKey: CryptoKey,
  context: AddressedContext,
): Promise<{ deviceId: string; ciphertext: string; signature: string }> {
  context = { ...context };
  validate(context);
  if (key.length !== 32) throw new Error("invalid comment key");
  const ciphertext = await sealToRecipient(new Uint8Array(key), recipientPublicKey, hpkeContext(context));
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      assertionPrivateKey,
      await transcript(context, ciphertext),
    ),
  );
  return { deviceId: context.deviceId, ciphertext: encodeTreeBytes(ciphertext), signature: encodeTreeBytes(signature) };
}

/** Successful cryptography is not live Grant or Device registry authorization. */
export async function openCommentKeyEnvelope(
  record: SignedEnvelope & {
    signerPublicKey: string;
    recipient: CryptoKeyPair;
  },
): Promise<Uint8Array<ArrayBuffer>> {
  record = { ...record, recipient: { ...record.recipient } };
  validate(record);
  const header = inspectEnvelope(decodeTreeBytes(record.ciphertext, 16_384));
  // Header inspection never establishes authority or selects a key. These
  // bounded failures must not turn an impossible future epoch into a re-key.
  if (header.context.keyEpoch < record.capabilityEpoch) throw new EnvelopeError("stale-epoch");
  if (header.context.keyEpoch > record.capabilityEpoch) throw new EnvelopeError("unexpected-epoch");
  if (!(await verifyCommentKeySignature(record, record.signerPublicKey)))
    throw new Error("invalid comment key signature");
  const key = await openForRecipient(decodeTreeBytes(record.ciphertext, 16_384), record.recipient, {
    context: hpkeContext(record),
  });
  if (key.length !== 32) throw new Error("invalid comment key");
  return key;
}
