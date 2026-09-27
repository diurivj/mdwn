import { describe, expect, it } from "vitest";
import { createSymmetricWriter, digestEnvelope } from "../../app/crypto/enc-v1";
import { createFileReceivingKey, createFileSave } from "../../app/crypto/file-receiving";
import { assertExactFileRecipientDescriptors, assertFileHeadAdvance, canonicalFileHeadBytes, parseFileHeadBytes, signFileHead,
  verifyDirectFileRecipientEnvelope, verifyFileHead, verifyFileParentEnvelope, verifyFilePublicationRepresentation,
  verifyFileReceivingTarget, verifyFileRepresentation, type FileHeadStatement } from "../../app/tree/file-head";

const hex = (byte: number) => new Uint8Array(32).fill(byte);
const base: FileHeadStatement = {
  ownerId: "owner-1", vaultId: "owner-1", fileId: "file-1", revision: 2,
  contentKey: { id: "content-2", epoch: 5 },
  receivingKey: { id: "receiving-1", epoch: 1, publicKeyDigest: hex(0x11) },
  representation: { id: "representation-2", digest: hex(0x22) },
  parentEnvelopeDigest: hex(0x33), recipientSetVersion: 1,
  recipients: [
    { accountId: "recipient-2", deviceId: "device-z", registryEpoch: 4, publicKeyDigest: hex(0x44),
      grants: [{ id: "grant-2", generation: 3 }, { id: "grant-1", generation: 2 }], envelopeDigest: hex(0x55) },
    { accountId: "recipient-1", deviceId: "device-a", registryEpoch: 7, publicKeyDigest: hex(0x66),
      grants: [{ id: "grant-3", generation: 1 }], envelopeDigest: hex(0x77) },
  ],
  publication: { status: "none" }, signerDeviceId: "signer-1",
};

async function keys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { pair, publicBytes: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

describe("current File head", () => {
  it("pins the canonical order, allows only an explicit no-Publication state, and verifies against a trusted signer", async () => {
    const expected = JSON.stringify(["mdwn/file-head/v1", "owner-1", "owner-1", "file-1", 2,
      "content-2", 5, "receiving-1", 1, "11".repeat(32), "representation-2", "22".repeat(32),
      "33".repeat(32), 1, [
        ["recipient-1", "device-a", 7, "66".repeat(32), [["grant-3", 1]], "77".repeat(32)],
        ["recipient-2", "device-z", 4, "44".repeat(32), [["grant-1", 2], ["grant-2", 3]], "55".repeat(32)],
      ], ["none"], "signer-1"]);
    expect(new TextDecoder().decode(canonicalFileHeadBytes(base))).toBe(expected);
    expect(parseFileHeadBytes(new TextEncoder().encode(expected))).toEqual({ ...base,
      recipients: [base.recipients[1], { ...base.recipients[0], grants: [...base.recipients[0].grants].reverse() }] });
    const { pair, publicBytes } = await keys();
    const signed = await signFileHead(base, pair.privateKey);
    const verified = await verifyFileHead(signed, { ownerId: "owner-1", vaultId: "owner-1", fileId: "file-1",
      signerDeviceId: "signer-1", publicKey: publicBytes });
    expect(verified.statement.representation.id).toBe("representation-2");
    expect(verified.digest).toHaveLength(32);
    expect(() => canonicalFileHeadBytes({ ...base, publication: undefined } as unknown as FileHeadStatement))
      .toThrow();
  });

  it("rejects malformed coordinates, duplicate descriptors, extra fields and a silent Publication omission", () => {
    for (const invalid of [
      { ...base, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, ownerId: "other-owner" },
      { ...base, recipients: [base.recipients[0], base.recipients[0]] },
      { ...base, recipients: [{ ...base.recipients[0], grants: [base.recipients[0].grants[0], base.recipients[0].grants[0]] }] },
      { ...base, parentId: "private-directory" },
      { ...base, publication: { status: "active", id: "pub-1" } },
    ]) expect(() => canonicalFileHeadBytes(invalid as FileHeadStatement)).toThrow();
    const valid = new TextDecoder().decode(canonicalFileHeadBytes(base));
    expect(() => parseFileHeadBytes(new TextEncoder().encode(` ${valid}`))).toThrow();
    expect(() => parseFileHeadBytes(new TextEncoder().encode(valid.replace('"mdwn/file-head/v1"', '"mdwn/file-head/v0"')))).toThrow();
  });

  it("snapshots mutable sign/verify inputs and rejects substituted digests, identities and signatures", async () => {
    const { pair, publicBytes } = await keys();
    const input = structuredClone(base);
    const pending = signFileHead(input, pair.privateKey);
    input.representation.digest.fill(0);
    input.recipients[0].grants[0].generation = 100;
    const signed = await pending;
    const trusted = { ownerId: "owner-1", vaultId: "owner-1", fileId: "file-1", signerDeviceId: "signer-1",
      publicKey: publicBytes.slice() };
    const inFlight = verifyFileHead(signed, trusted);
    signed.bytes.fill(0);
    trusted.publicKey.fill(0);
    expect((await inFlight).statement.representation.digest).toEqual(hex(0x22));
    const another = await keys();
    const head = await signFileHead(base, pair.privateKey);
    await expect(verifyFileHead(head, { ...trusted, publicKey: another.publicBytes }))
      .rejects.toMatchObject({ code: "invalid-signature" });
    await expect(verifyFileHead(head, { ...trusted, publicKey: publicBytes, fileId: "other-file" }))
      .rejects.toMatchObject({ code: "context-mismatch" });
    await expect(verifyFileHead(head, { ...trusted, publicKey: publicBytes, digest: hex(9) }))
      .rejects.toMatchObject({ code: "digest-mismatch" });
    const signature = head.signature.slice(); signature[0] ^= 1;
    await expect(verifyFileHead({ ...head, signature }, { ...trusted, publicKey: publicBytes }))
      .rejects.toMatchObject({ code: "invalid-signature" });
    const bytes = head.bytes.slice(); bytes[bytes.length - 2] ^= 1;
    await expect(verifyFileHead({ ...head, bytes }, { ...trusted, publicKey: publicBytes }))
      .rejects.toThrow();
    const active: FileHeadStatement = { ...base, publication: { status: "active", id: "pub-1",
      representationId: "public-2", digest: hex(0xaa) } };
    expect(parseFileHeadBytes(canonicalFileHeadBytes(active)).publication).toEqual(active.publication);
  });

  it("checks exact current File-scoped bytes and external recipient descriptors, never a parent/path", async () => {
    const receiving = await createFileReceivingKey(new Uint8Array(32).fill(8), {
      vaultId: "owner-1", fileId: "file-1", receivingKeyId: "receiving-1", receivingEpoch: 1, wrapRevision: 2,
    });
    const device = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", device.publicKey));
    const save = await createFileSave({ markdown: "# hello", metadata: new Uint8Array() }, receiving.publicKey,
      { vaultId: "owner-1", fileId: "file-1", receivingKeyId: "receiving-1", receivingEpoch: 1,
        publicKeyDigest: receiving.publicKeyDigest },
      { vaultId: "owner-1", fileId: "file-1", contentKeyId: "content-2", contentEpoch: 5, revision: 2 },
      [{ deviceId: "device-a", publicKey: device.publicKey }]);
    const desc = { accountId: "recipient-1", deviceId: "device-a", registryEpoch: 7,
      publicKeyDigest: new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey)),
      grants: [{ id: "grant-3", generation: 1 }] };
    const statement: FileHeadStatement = { ...base,
      receivingKey: { id: "receiving-1", epoch: 1, publicKeyDigest: receiving.publicKeyDigest },
      representation: { id: "representation-2", digest: await digestEnvelope(save.contentEnvelope) },
      parentEnvelopeDigest: await digestEnvelope(save.parentEnvelope),
      recipients: [{ ...desc, envelopeDigest: await digestEnvelope(save.recipientEnvelopes[0].envelope) }],
    };
    const { pair, publicBytes } = await keys();
    const verified = await verifyFileHead(await signFileHead(statement, pair.privateKey), {
      ownerId: "owner-1", vaultId: "owner-1", fileId: "file-1", signerDeviceId: "signer-1", publicKey: publicBytes,
    });
    await verifyFileReceivingTarget(verified, receiving.publicKey);
    await verifyFileRepresentation(verified, "representation-2", save.contentEnvelope);
    await verifyFileParentEnvelope(verified, save.parentEnvelope);
    await verifyDirectFileRecipientEnvelope(verified, "recipient-1", "device-a", publicKey,
      save.recipientEnvelopes[0].envelope);
    assertExactFileRecipientDescriptors(verified, [desc]);
    const mutable = structuredClone(verified);
    const mutableKey = publicKey.slice();
    const mutableEnvelope = save.recipientEnvelopes[0].envelope.slice();
    const pending = verifyDirectFileRecipientEnvelope(mutable, "recipient-1", "device-a", mutableKey, mutableEnvelope);
    mutable.statement.recipients[0].publicKeyDigest.fill(0);
    mutable.statement.recipients[0].envelopeDigest.fill(0);
    mutableKey.fill(0); mutableEnvelope.fill(0);
    await expect(pending).resolves.toBeUndefined();
    expect(() => assertExactFileRecipientDescriptors(verified, [{ ...desc, registryEpoch: 8 }]))
      .toThrow();
    await expect(verifyFileReceivingTarget(verified, new Uint8Array(await crypto.subtle.exportKey("raw",
      (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])).publicKey))))
      .rejects.toMatchObject({ code: "digest-mismatch" });
    const altered = save.parentEnvelope.slice(); altered[altered.length - 1] ^= 1;
    await expect(verifyFileParentEnvelope(verified, altered)).rejects.toMatchObject({ code: "digest-mismatch" });
    await expect(verifyDirectFileRecipientEnvelope(verified, "recipient-1", "other-device", publicKey,
      save.recipientEnvelopes[0].envelope)).rejects.toMatchObject({ code: "context-mismatch" });
    const other = await createFileSave({ markdown: "other", metadata: new Uint8Array() }, receiving.publicKey,
      { vaultId: "owner-1", fileId: "file-1", receivingKeyId: "receiving-1", receivingEpoch: 1,
        publicKeyDigest: receiving.publicKeyDigest },
      { vaultId: "owner-1", fileId: "file-1", contentKeyId: "content-3", contentEpoch: 6, revision: 3 }, []);
    const crossContext = { ...verified, statement: { ...verified.statement,
      representation: { id: "representation-2", digest: await digestEnvelope(other.contentEnvelope) } } };
    await expect(verifyFileRepresentation(crossContext, "representation-2", other.contentEnvelope))
      .rejects.toMatchObject({ code: "context-mismatch" });
    await expect(verifyFilePublicationRepresentation(verified, "published", save.contentEnvelope))
      .rejects.toMatchObject({ code: "context-mismatch" });
    const publicEnvelope = await (await createSymmetricWriter(new Uint8Array(32).fill(9)))
      .seal(new TextEncoder().encode("Public view"), { purpose: "public-representation", vaultId: "owner-1",
        objectId: "file-1", keyId: "public-key", keyEpoch: 1, revision: 2, publicationId: "publication-1" });
    const active = { ...statement, publication: { status: "active" as const, id: "publication-1",
      representationId: "published", digest: await digestEnvelope(publicEnvelope) } };
    const published = await verifyFileHead(await signFileHead(active, pair.privateKey), {
      ownerId: "owner-1", vaultId: "owner-1", fileId: "file-1", signerDeviceId: "signer-1", publicKey: publicBytes,
    });
    await verifyFilePublicationRepresentation(published, "published", publicEnvelope);
    await expect(verifyFilePublicationRepresentation(published, "other-representation", publicEnvelope))
      .rejects.toMatchObject({ code: "context-mismatch" });
  });

  it("rejects rollback/forks and permits only explicit authenticated same-revision transitions", async () => {
    const { pair, publicBytes } = await keys();
    const verified = async (statement: FileHeadStatement) => verifyFileHead(await signFileHead(statement, pair.privateKey), {
      ownerId: "owner-1", vaultId: "owner-1", fileId: "file-1", signerDeviceId: "signer-1", publicKey: publicBytes,
    });
    const current = await verified(base);
    assertFileHeadAdvance(current, current);
    const fork = await verified({ ...base, representation: { id: "representation-2", digest: hex(0xbb) } });
    expect(() => assertFileHeadAdvance(current, fork)).toThrowError(/fork/);
    const targetFork = await verified({ ...base, receivingKey: { ...base.receivingKey, publicKeyDigest: hex(0xcc) } });
    expect(() => assertFileHeadAdvance(current, targetFork)).toThrowError(/fork/);
    const newer = await verified({ ...base, revision: 3, contentKey: { id: "content-3", epoch: 6 },
      representation: { id: "representation-3", digest: hex(0xaa) }, parentEnvelopeDigest: hex(0x99),
      recipients: base.recipients.map((r) => ({ ...r, envelopeDigest: hex(0xab) })) });
    // Same authorized recipient set/version, but fresh HPKE wrappers for the new File content key.
    assertFileHeadAdvance(current, newer);
    const unchangedWrappers = await verified({ ...newer.statement, recipients: base.recipients });
    expect(() => assertFileHeadAdvance(current, unchangedWrappers)).toThrowError(/transition-required/);
    const missingVersion = await verified({ ...newer.statement, recipients: [base.recipients[0]] });
    expect(() => assertFileHeadAdvance(current, missingVersion)).toThrowError(/transition-required/);
    expect(() => assertFileHeadAdvance(newer, current)).toThrowError(/rollback/);
    const staleEpoch = await verified({ ...base, revision: 3, contentKey: { id: "content-3", epoch: 4 },
      representation: { id: "representation-3", digest: hex(0xaa) } });
    expect(() => assertFileHeadAdvance(current, staleEpoch)).toThrowError(/rollback/);
    const recipientUpdate = await verified({ ...base, recipientSetVersion: 2, recipients: [base.recipients[1]] });
    expect(() => assertFileHeadAdvance(current, recipientUpdate)).toThrowError(/transition-required/);
    assertFileHeadAdvance(current, recipientUpdate, { authenticatedSameRevision: "recipient-set-update" });
    const rotation = await verified({ ...base, receivingKey: { id: "receiving-2", epoch: 2, publicKeyDigest: hex(0xf1) },
      parentEnvelopeDigest: hex(0xf2) });
    expect(() => assertFileHeadAdvance(current, rotation, { authenticatedSameRevision: "recipient-set-update" }))
      .toThrowError(/transition-required/);
    assertFileHeadAdvance(current, rotation, { authenticatedSameRevision: "receiving-rotation" });
    const combined = await verified({ ...rotation.statement, recipientSetVersion: 2, recipients: [base.recipients[1]] });
    assertFileHeadAdvance(current, combined, { authenticatedSameRevision: "both" });
    expect(() => assertFileHeadAdvance(rotation, current, { authenticatedSameRevision: "receiving-rotation" }))
      .toThrowError(/rollback/);
    const rewrittenKey = await verified({ ...base, recipientSetVersion: 2, recipients: [base.recipients[1]],
      contentKey: { id: "content-fork", epoch: 5 } });
    expect(() => assertFileHeadAdvance(current, rewrittenKey, { authenticatedSameRevision: "recipient-set-update" }))
      .toThrowError(/transition-required/);
  });
});
