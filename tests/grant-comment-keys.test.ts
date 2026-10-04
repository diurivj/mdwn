import { beforeAll, expect, test } from "vitest";
import { createCommentKeyEnvelope, openCommentKeyEnvelope, verifyCommentKeySignature,
  type CommentKeyContext } from "../app/sharing/comment-keys";
import { encodeTreeBytes } from "../app/tree/wire";
import { createSymmetricWriter, sealToRecipient, type EnvelopeContext } from "../app/crypto/enc-v1";
import { newPublicationIdentifier } from "../app/publications/capability";

async function signedPacket(ciphertext: Uint8Array, expected = context) {
  const digest = encodeTreeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(ciphertext))));
  const statement = new TextEncoder().encode(JSON.stringify(["mdwn/grant-comment-key-envelope", 1,
    expected.relationshipId, expected.ownerId, expected.recipientId, expected.targetId, expected.targetKind,
    expected.capabilityId, expected.capabilityEpoch, expected.grantKeyEpoch, expected.ownerRegistryEpoch,
    expected.recipientRegistryEpoch, expected.deviceId, expected.signerDeviceId, expected.purpose,
    expected.fileId, expected.threadId, expected.objectId, expected.publicationId, digest]));
  return { ...expected, ciphertext: encodeTreeBytes(ciphertext), signature: encodeTreeBytes(new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.privateKey, statement))) };
}


const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const context: CommentKeyContext & { deviceId: string; signerDeviceId: string } = {
  relationshipId: id(1), ownerId: id(2), recipientId: id(3), targetId: id(4), targetKind: "directory",
  capabilityId: id(5), capabilityEpoch: 2, grantKeyEpoch: 3, ownerRegistryEpoch: 4,
  recipientRegistryEpoch: 5, deviceId: id(6), signerDeviceId: id(7),
  purpose: "private-comment-thread", fileId: id(8), threadId: id(9), objectId: id(9), publicationId: null,
};
const publicContext: typeof context = { ...context, purpose: "public-comment-audience-epoch",
  publicationId: newPublicationIdentifier(), objectId: id(11) };
const literalKey = Uint8Array.from([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
]);
let recipient: CryptoKeyPair;
let signer: CryptoKeyPair;
let signerPublicKey: string;
beforeAll(async () => {
  recipient = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  signer = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  signerPublicKey = encodeTreeBytes(new Uint8Array(await crypto.subtle.exportKey("raw", signer.publicKey)));
});

test("a recipient opens the literal Private comment thread key signed by an independent Owner device", async () => {
  const envelope = await createCommentKeyEnvelope(literalKey, recipient.publicKey, signer.privateKey, context);
  expect(envelope.deviceId).toBe(context.deviceId);
  expect(await openCommentKeyEnvelope({ ...context, ...envelope, signerPublicKey, recipient })).toEqual(literalKey);
});

test("a recipient opens the literal Public audience epoch key with its Publication binding", async () => {
  const envelope = await createCommentKeyEnvelope(literalKey, recipient.publicKey, signer.privateKey, publicContext);
  expect(await openCommentKeyEnvelope({ ...publicContext, ...envelope, signerPublicKey, recipient })).toEqual(literalKey);
});

test("even a valid Owner signature cannot endorse a crossed suite, purpose, object or capability epoch", async () => {
  const hpke: EnvelopeContext = { purpose: "private-comment-thread", vaultId: context.ownerId,
    objectId: context.objectId, keyId: context.capabilityId, keyEpoch: 2, revision: 3, recipientId: context.deviceId };
  for (const changed of [{ purpose: "grant" as const }, { objectId: id(17) }, { keyEpoch: 1 }, { keyEpoch: 3 }]) {
    const ciphertext = await sealToRecipient(literalKey, recipient.publicKey, { ...hpke, ...changed });
    expect(await verifyCommentKeySignature(await signedPacket(ciphertext), signerPublicKey)).toBe(false);
  }
  const symmetric = await (await createSymmetricWriter(literalKey)).seal(literalKey, hpke);
  expect(await verifyCommentKeySignature(await signedPacket(symmetric), signerPublicKey)).toBe(false);
});

test("opens reject older and impossible future epochs distinctly without adopting the envelope header", async () => {
  for (const [keyEpoch, code] of [[1, "stale-epoch"], [3, "unexpected-epoch"]] as const) {
    const ciphertext = await sealToRecipient(literalKey, recipient.publicKey, { purpose: "private-comment-thread",
      vaultId: context.ownerId, objectId: context.objectId, keyId: context.capabilityId,
      keyEpoch, revision: 3, recipientId: context.deviceId });
    await expect(openCommentKeyEnvelope({ ...await signedPacket(ciphertext), signerPublicKey, recipient })).rejects.toMatchObject({ code });
  }
});

test("capability envelopes carry exactly a 32-byte key on creation and opening", async () => {
  for (const length of [0, 31, 33]) {
    await expect(createCommentKeyEnvelope(new Uint8Array(length), recipient.publicKey, signer.privateKey, context)).rejects.toThrow();
  }
  const ciphertext = await sealToRecipient(new Uint8Array(31), recipient.publicKey, { purpose: "private-comment-thread",
    vaultId: context.ownerId, objectId: context.objectId, keyId: context.capabilityId,
    keyEpoch: 2, revision: 3, recipientId: context.deviceId });
  await expect(openCommentKeyEnvelope({ ...await signedPacket(ciphertext), signerPublicKey, recipient })).rejects.toThrow();
});

test("asynchronous sealing and opening snapshot the caller's signed context", async () => {
  const mutable = { ...context }, sourceKey = new Uint8Array(literalKey);
  const sealing = createCommentKeyEnvelope(sourceKey, recipient.publicKey, signer.privateKey, mutable);
  mutable.fileId = id(15);
  sourceKey.fill(99);
  const envelope = await sealing;
  const record = { ...context, ...envelope, signerPublicKey, recipient };
  const opening = openCommentKeyEnvelope(record);
  record.fileId = id(16);
  expect(await opening).toEqual(literalKey);
});

test("creation rejects invalid Grant target kinds and crossed Private/Public contexts", async () => {
  await expect(createCommentKeyEnvelope(literalKey, recipient.publicKey, signer.privateKey,
    // @ts-expect-error Exercise the runtime boundary, not just the TypeScript union.
    { ...context, targetKind: "other" })).rejects.toThrow("invalid comment key context");
  const invalidContexts: typeof context[] = [
    { ...context, publicationId: id(10) }, { ...context, objectId: id(11) },
    { ...publicContext, publicationId: null }, { ...publicContext, publicationId: "not-an-id" },
  ];
  for (const invalid of invalidContexts) {
    await expect(createCommentKeyEnvelope(literalKey, recipient.publicKey, signer.privateKey, invalid))
      .rejects.toThrow("invalid comment key context");
  }
  await expect(createCommentKeyEnvelope(literalKey, recipient.publicKey, signer.privateKey,
    // @ts-expect-error Unknown purposes must fail closed at runtime.
    { ...context, purpose: "grant" })).rejects.toThrow("invalid comment key context");
});

test("creation rejects invalid UUIDv7 identities and non-positive or unsafe epochs", async () => {
  const ids = ["relationshipId", "ownerId", "recipientId", "targetId", "capabilityId", "deviceId",
    "signerDeviceId", "fileId", "threadId", "objectId"] as const;
  const epochs = ["capabilityEpoch", "grantKeyEpoch", "ownerRegistryEpoch", "recipientRegistryEpoch"] as const;
  for (const field of ids) {
    for (const value of ["not-an-id", "01900000-0000-4000-8000-000000000001"]) {
      await expect(createCommentKeyEnvelope(literalKey, recipient.publicKey, signer.privateKey,
        { ...context, [field]: value })).rejects.toThrow("invalid comment key context");
    }
  }
  for (const field of epochs) {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      await expect(createCommentKeyEnvelope(literalKey, recipient.publicKey, signer.privateKey,
        { ...context, [field]: value })).rejects.toThrow("invalid comment key context");
    }
  }
});
