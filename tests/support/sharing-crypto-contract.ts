// Public sharing crypto contract, run unchanged in Node, workerd, and real browsers.
// tsconfig.node lists only pure crypto roots; tsconfig.cloudflare typechecks the
// sharing modules. Node Vitest still runs these real public APIs.
// @ts-ignore TS6307: sharing is outside the Node composite's explicit roots.
import { inspectOfferEnvelope, offerBytes, parseOffer, signOffer, verifyOffer, type Offer } from "../../app/sharing/offer";
// @ts-ignore TS6307: sharing is outside the Node composite's explicit roots.
import { encodeShareLabel, openOwnedShareLabel, openShareLabel, sealShareLabel } from "../../app/sharing/label";
import { createSymmetricWriter, inspectEnvelope, sealToRecipient } from "../../app/crypto/enc-v1";
import { HPKE_SUITE, SYMMETRIC_SUITE } from "../../app/crypto/enc-v1/format";
import { createRecoveryMaterial, openRecoveryCapsule } from "../../app/crypto/vault";

const id = (n: number) => `019950d7-98c0-7000-8000-${n.toString(16).padStart(12, "0")}`;
const hash = (byte: string) => byte.repeat(64);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function directoryOffer(): Offer {
  const ownerId = id(1), recipientId = id(2), targetId = id(3);
  return {
    shareId: id(4), grantId: id(5), ownerId, recipientId, targetId,
    kind: "directory", permission: "read_only", materialRevision: 1,
    targetKeyId: targetId, targetEpoch: 1, contentRevision: 1, headDigest: hash("a"),
    labelId: id(6), ownerCopyDigest: hash("b"), registryEpoch: 1,
    devices: [{ accountId: recipientId, deviceId: id(7), registryEpoch: 1,
      publicKeyDigest: hash("c"), contentDigest: hash("d"), labelDigest: hash("e") }],
    candidateDigest: null, signerDeviceId: id(8),
  };
}

async function rejectsAsync(operation: Promise<unknown>, message: string) {
  let rejected = false;
  try { await operation; } catch { rejected = true; }
  assert(rejected, message);
}

function rejects(operation: () => unknown, message: string) {
  let rejected = false;
  try { operation(); } catch { rejected = true; }
  assert(rejected, message);
}

export const cases = [{
  name: "a detached offer signature never authenticates different parsed bytes across an await",
  async run() {
    const signer = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", signer.publicKey));
    const offerA = directoryOffer();
    const offerB: Offer = { ...offerA, headDigest: hash("f") };
    const unsignedA = await signOffer(offerA, signer.privateKey);
    const signedB = await signOffer(offerB, signer.privateKey);
    assert(unsignedA.bytes.length === signedB.bytes.length, "race requires equal-length canonical offers");
    const pending = verifyOffer(unsignedA.bytes, unsignedA.digest, signedB.signature, publicKey);
    unsignedA.bytes.set(signedB.bytes);
    let accepted: Offer | undefined;
    try { accepted = await pending; } catch { /* expected: unsigned A was not signed */ }
    assert(accepted === undefined, "parsed offer A must not be authenticated by signature B");
  },
}, {
  name: "Shared-as seals the original device list and owned root despite caller mutation",
  async run() {
    const deviceA = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const deviceB = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const root = crypto.getRandomValues(new Uint8Array(32)), savedRoot = root.slice();
    const deviceId = id(7);
    const recipients = [{ deviceId, publicKey: deviceA.publicKey }];
    const pending = sealShareLabel("Folder.md", id(1), id(3), id(6), recipients, root);
    root.fill(0); recipients[0]!.deviceId = id(9); recipients[0]!.publicKey = deviceB.publicKey;
    recipients.push({ deviceId: id(10), publicKey: deviceB.publicKey });
    const result = await pending;
    assert(result.deliveries.length === 1 && result.deliveries[0]!.deviceId === deviceId,
      "delivery must be for the original device only");
    assert(await openShareLabel(result.deliveries[0]!.envelope, deviceA, id(1), id(3), id(6), deviceId) === "Folder.md",
      "original device must open its original snapshot");
    assert(await openOwnedShareLabel(result.ownerCopy, savedRoot, id(1), id(3), id(6)) === "Folder.md",
      "Owner's original Vault root must open its saved snapshot");
  },
}, {
  name: "HPKE Shared-as sealing requires an extractable imported P-256 public key",
  async run() {
    const ownerId = id(1), directoryId = id(3), labelId = id(6), deviceId = id(7);
    const vaultRoot = crypto.getRandomValues(new Uint8Array(32));
    const recipient = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const rawPublicKey = await crypto.subtle.exportKey("raw", recipient.publicKey);
    const nonExtractablePublicKey = await crypto.subtle.importKey("raw", rawPublicKey,
      { name: "ECDH", namedCurve: "P-256" }, false, []);
    assert(nonExtractablePublicKey.type === "public" && !nonExtractablePublicKey.extractable,
      "first import exactly matches the original resolved-device caller");
    await rejectsAsync(sealShareLabel("Directory", ownerId, directoryId, labelId,
      [{ deviceId, publicKey: nonExtractablePublicKey }], vaultRoot),
      "HPKE cannot serialize a non-extractable recipient public key");
    const resolvedPublicKey = await crypto.subtle.importKey("raw", rawPublicKey,
      { name: "ECDH", namedCurve: "P-256" }, true, []);
    assert(resolvedPublicKey.type === "public" && resolvedPublicKey.extractable,
      "the corrected caller imports only the public recipient key as extractable");
    const sealed = await sealShareLabel("Directory", ownerId, directoryId, labelId,
      [{ deviceId, publicKey: resolvedPublicKey }], vaultRoot);
    assert(sealed.deliveries.length === 1 && sealed.deliveries[0]!.deviceId === deviceId,
      "resolved device receives a Shared-as envelope");
    assert(await openShareLabel(sealed.deliveries[0]!.envelope, recipient,
      ownerId, directoryId, labelId, deviceId) === "Directory",
      "resolved device opens its Shared-as envelope");
  },
}, {
  name: "offer encoding refuses wrong identities, device counters and inconsistent material",
  async run() {
    const base = directoryOffer();
    assert(parseOffer(offerBytes(base)).shareId === base.shareId, "canonical offer round trip");
    const second = { ...base.devices[0]!, deviceId: id(9) };
    const sorted = { ...base, devices: [second, base.devices[0]!] };
    assert(parseOffer(offerBytes(sorted)).devices.map((device) => device.deviceId).join(",") === `${id(7)},${id(9)}`,
      "canonical wire sorts recipients by opaque device ID");
    assert(parseOffer(offerBytes({ ...base, devices: [] })).devices.length === 0,
      "preparing an Owner offer does not fabricate a recipient-device minimum");
    const reordered: unknown[] = JSON.parse(new TextDecoder().decode(offerBytes(sorted)));
    const members = reordered[16];
    assert(Array.isArray(members), "canonical device array");
    members.reverse();
    rejects(() => parseOffer(new TextEncoder().encode(JSON.stringify(reordered))), "unsorted wire is noncanonical");
    const cases: [Offer, string][] = [
      [{ ...base, shareId: "not-an-opaque-id" }, "share identity"],
      [{ ...base, ownerId: base.recipientId }, "Owner and recipient must differ"],
      [{ ...base, targetKeyId: "bad-key" }, "target key identity"],
      [{ ...base, labelId: `${"x".repeat(260)}` }, "oversized label identity"],
      [{ ...base, candidateDigest: hash("a") }, "Directory candidate"],
      [{ ...base, devices: [{ ...base.devices[0]!, accountId: base.ownerId }] }, "device Account"],
      [{ ...base, devices: [{ ...base.devices[0]!, registryEpoch: 1.5 }] }, "fractional device epoch"],
      [{ ...base, devices: [{ ...base.devices[0]!, registryEpoch: 2 }] }, "stale device epoch"],
      [{ ...base, devices: [{ ...base.devices[0]!, deviceId: "bad" }] }, "invalid device ID"],
      [{ ...base, devices: [base.devices[0]!, base.devices[0]!] }, "duplicate device"],
      [{ ...base, headDigest: "A".repeat(64) }, "noncanonical hex digest"],
      [{ ...base, kind: "file", candidateDigest: null }, "File missing candidate"],
      [{ ...base, materialRevision: Number.MAX_SAFE_INTEGER + 1 }, "unsafe material revision"],
      [{ ...base, contentRevision: 0 }, "nonpositive content revision"],
      [{ ...base, devices: Array.from({ length: 257 }, (_, index) =>
        ({ ...base.devices[0]!, deviceId: id(index + 100) })) }, "device capacity"],
    ];
    for (const [offer, failure] of cases) rejects(() => offerBytes(offer), failure);
    const invalid = { ...base };
    Reflect.set(invalid, "devices", { length: 0 });
    rejects(() => offerBytes(invalid), "nonarray devices");
    Reflect.set(invalid, "devices", [base.devices[0]!]);
    Reflect.set(invalid, "permission", "owner");
    rejects(() => offerBytes(invalid), "unknown permission");
    Reflect.set(invalid, "permission", "read_only");
    Reflect.set(invalid, "uncommittedName", "not signed");
    rejects(() => offerBytes(invalid), "no unsigned offer fields accepted");
    const fractional = { ...base, devices: [{ ...base.devices[0]! }] };
    Reflect.set(fractional.devices[0]!, "registryEpoch", Infinity);
    rejects(() => parseOffer(new TextEncoder().encode(JSON.stringify([
      "mdwn/share-offer/v1", base.shareId, base.grantId, base.ownerId, base.recipientId,
      base.targetId, base.kind, base.permission, base.materialRevision, base.targetKeyId,
      base.targetEpoch, base.contentRevision, base.headDigest, base.labelId, base.ownerCopyDigest,
      base.registryEpoch, [[fractional.devices[0]!.accountId, fractional.devices[0]!.deviceId,
        fractional.devices[0]!.registryEpoch, fractional.devices[0]!.publicKeyDigest,
        fractional.devices[0]!.contentDigest, fractional.devices[0]!.labelDigest]],
      base.candidateDigest, base.signerDeviceId,
    ]))), "non-finite device epoch in received wire");
  },
}, {
  name: "Owned Shared-as rejects noncanonical plaintext even when encryption authenticates it",
  async run() {
    const root = crypto.getRandomValues(new Uint8Array(32));
    const context = { purpose: "share-root-label" as const, vaultId: id(1), objectId: id(3),
      keyId: id(6), keyEpoch: 1, revision: 1 };
    const writer = await createSymmetricWriter(root);
    const canonical = encodeShareLabel("Report.md");
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...canonical]);
    await rejectsAsync(openOwnedShareLabel(await writer.seal(bom, context), root, id(1), id(3), id(6)),
      "BOM-prefixed plaintext is not the canonical two-element namespace-v1 snapshot");
    for (const bad of [new Uint8Array([0xff]), new TextEncoder().encode(` ["mdwn/share-root-label/namespace-v1","Report.md"]`),
      new TextEncoder().encode(JSON.stringify(["mdwn/share-root-label/namespace-v1", "Cafe\u0301.md"]))]) {
      await rejectsAsync(openOwnedShareLabel(await writer.seal(bad, context), root, id(1), id(3), id(6)),
        "malformed UTF-8, JSON, or non-NFC snapshot must be rejected");
    }
  },
}, {
  name: "Owned recovery opens its own Shared-as copy; two recipients open isolated immutable snapshots",
  async run() {
    const ownerId = id(1), targetId = id(3), labelId = id(6);
    const root = crypto.getRandomValues(new Uint8Array(32));
    const [a, b] = await Promise.all([1, 2].map(() =>
      crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])));
    const delivered = await sealShareLabel("Cafe\u0301.md", ownerId, targetId, labelId,
      [{ deviceId: id(7), publicKey: a.publicKey }, { deviceId: id(9), publicKey: b.publicKey }], root);
    assert(delivered.ownerCopy.length <= 4096 && delivered.deliveries.length === 2 &&
      delivered.deliveries.every((d) => d.envelope.length <= 4096 && d.envelope[13] === 21),
      "all purpose-21 envelopes are bounded independently");
    const ownedHeader = inspectEnvelope(delivered.ownerCopy);
    assert(ownedHeader.suite === SYMMETRIC_SUITE && ownedHeader.context.purpose === "share-root-label" &&
      ownedHeader.context.recipientId === undefined && ownedHeader.context.vaultId === ownerId &&
      ownedHeader.context.objectId === targetId && ownedHeader.context.keyId === labelId &&
      ownedHeader.context.keyEpoch === 1 && ownedHeader.context.revision === 1 &&
      Object.keys(ownedHeader.context).length === 6, "Owner metadata contains no parent, path or File revision");
    const recovery = await createRecoveryMaterial(ownerId, { vaultRootKey: root });
    const restored = await openRecoveryCapsule(recovery.record, recovery.phrase, {
      accountId: ownerId, generation: recovery.generation, recoverySalt: recovery.record.recoverySalt,
    });
    assert(await openOwnedShareLabel(delivered.ownerCopy, restored.vaultRootKey, ownerId, targetId, labelId) === "Café.md",
      "recovered owned Vault root opens the immutable Shared-as copy");
    for (const [index, pair, deviceId] of [[0, a, id(7)], [1, b, id(9)]] as const) {
      const envelope = delivered.deliveries[index]!.envelope;
      const header = inspectEnvelope(envelope);
      assert(header.suite === HPKE_SUITE && header.context.recipientId === deviceId &&
        Object.keys(header.context).length === 7, "recipient metadata is only Owner/target/label/device");
      assert(await openShareLabel(envelope, pair, ownerId, targetId, labelId, deviceId) === "Café.md",
        "current recipient opens exact canonical Shared-as spelling");
    }
    await rejectsAsync(openShareLabel(delivered.deliveries[0]!.envelope, b, ownerId, targetId, labelId, id(7)),
      "other recipient cannot open this device's ciphertext");
    const renamed = await sealShareLabel("Renamed.md", ownerId, targetId, id(10), [], root);
    assert(renamed.deliveries.length === 0 &&
      await openOwnedShareLabel(renamed.ownerCopy, root, ownerId, targetId, id(10)) === "Renamed.md" &&
      await openOwnedShareLabel(delivered.ownerCopy, root, ownerId, targetId, labelId) === "Café.md",
      "zero-current-device Owner copy works and a later rename cannot rewrite the old snapshot");
    assert(inspectEnvelope(renamed.ownerCopy).salt!.some((byte, i) => byte !== ownedHeader.salt![i]),
      "each Owner copy uses a fresh writer/key domain");
  },
}, {
  name: "Shared-as refuses malformed names, inputs, and delivery sets",
  async run() {
    const root = crypto.getRandomValues(new Uint8Array(32));
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const signer = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    for (const name of ["", "../secret", "CON.md", "x".repeat(256), "bad\ud800"]) {
      rejects(() => encodeShareLabel(name), "invalid namespace-v1 segment rejected");
    }
    const seal = (recipients: { deviceId: string; publicKey: CryptoKey }[], owner = id(1), key = root) =>
      sealShareLabel("Valid.md", owner, id(3), id(6), recipients, key);
    await rejectsAsync(seal([{ deviceId: id(7), publicKey: pair.publicKey },
      { deviceId: id(7), publicKey: pair.publicKey }]), "duplicate device IDs");
    await rejectsAsync(seal([{ deviceId: "bad", publicKey: pair.publicKey }]), "invalid device ID");
    await rejectsAsync(seal([{ deviceId: id(7), publicKey: signer.publicKey }]), "wrong key handle type");
    await rejectsAsync(seal([], "invalid-id"), "invalid Owner context");
    await rejectsAsync(seal([], id(1), new Uint8Array(31)), "Vault root is exactly 32 bytes");
    await rejectsAsync(seal(Array.from({ length: 257 }, (_, index) =>
      ({ deviceId: id(index + 100), publicKey: pair.publicKey }))), "bounded delivery set");
  },
}, {
  name: "Shared-as rejects substituted context, purpose, suite, ciphertext, and 4KiB overflow",
  async run() {
    const root = crypto.getRandomValues(new Uint8Array(32));
    const device = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const sealed = await sealShareLabel("Valid.md", id(1), id(3), id(6),
      [{ deviceId: id(7), publicKey: device.publicKey }], root);
    const owned = sealed.ownerCopy, recipient = sealed.deliveries[0]!.envelope;
    for (const [ownerId, targetId, labelId, deviceId] of [
      [id(2), id(3), id(6), id(7)], [id(1), id(4), id(6), id(7)],
      [id(1), id(3), id(5), id(7)], [id(1), id(3), id(6), id(9)],
    ]) {
      await rejectsAsync(openShareLabel(recipient, device, ownerId!, targetId!, labelId!, deviceId!),
        "recipient label context cannot be substituted");
    }
    await rejectsAsync(openOwnedShareLabel(owned, root, id(1), id(4), id(6)), "Owner target mismatch");
    await rejectsAsync(openOwnedShareLabel(recipient, root, id(1), id(3), id(6)), "Owner copy suite pinned");
    await rejectsAsync(openShareLabel(owned, device, id(1), id(3), id(6), id(7)), "recipient suite pinned");
    const tampered = recipient.slice(); tampered[tampered.length - 1] ^= 1;
    await rejectsAsync(openShareLabel(tampered, device, id(1), id(3), id(6), id(7)), "ciphertext tag tamper");
    await rejectsAsync(openShareLabel(new Uint8Array(4097), device, id(1), id(3), id(6), id(7)),
      "4KiB recipient ciphertext ceiling");
    await rejectsAsync(openOwnedShareLabel(new Uint8Array(4097), root, id(1), id(3), id(6)),
      "4KiB Owner ciphertext ceiling");
    const base = { purpose: "share-root-label" as const, vaultId: id(1), objectId: id(3),
      keyId: id(6), keyEpoch: 1, revision: 1, recipientId: id(7) };
    for (const context of [{ ...base, keyEpoch: 2 }, { ...base, revision: 2 },
      { ...base, purpose: "grant" as const }]) {
      await rejectsAsync(openShareLabel(await sealToRecipient(encodeShareLabel("Valid.md"), device.publicKey,
        context), device, id(1), id(3), id(6), id(7)), "epoch/revision/purpose pinned");
    }
  },
}, {
  name: "verified offers use original caller bytes and reject malformed/noncanonical wire",
  async run() {
    const signer = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", signer.publicKey));
    const file = { ...directoryOffer(), kind: "file" as const, targetKeyId: id(11),
      candidateDigest: hash("f"), permission: "read_write" as const };
    const signed = await signOffer(file, signer.privateKey);
    const input = { bytes: signed.bytes.slice(), digest: signed.digest.slice(),
      signature: signed.signature.slice(), key: publicKey.slice() };
    const pending = verifyOffer(input.bytes, input.digest, input.signature, input.key);
    input.bytes.fill(0); input.digest.fill(0); input.signature.fill(0); input.key.fill(0);
    const opened = await pending;
    assert(opened.targetId === file.targetId && opened.kind === "file" && opened.permission === "read_write" &&
      opened.candidateDigest === hash("f"), "verified caller mutation returns the originally signed file offer");
    await rejectsAsync(verifyOffer(signed.bytes, signed.digest, signed.signature, new Uint8Array(65)),
      "wrong signer key is not proof of integrity");
    const modified = signed.bytes.slice(); modified[modified.length - 3] ^= 1;
    await rejectsAsync(verifyOffer(modified, signed.digest, signed.signature, publicKey), "modified canonical offer");
    const encoder = new TextEncoder();
    for (const wire of [encoder.encode(new TextDecoder().decode(signed.bytes) + " "),
      new Uint8Array([0xff]), encoder.encode("[]"), new Uint8Array(131073)]) {
      rejects(() => parseOffer(wire), "malformed, noncanonical or oversized wire rejected");
    }
    // Noncanonical JSON escaping must never be a second signature spelling.
    const escaping = encoder.encode(new TextDecoder().decode(signed.bytes).replace("mdwn/share-offer/v1", "mdwn\\/share-offer/v1"));
    rejects(() => parseOffer(escaping), "noncanonical escaped wire");
  },
}, {
  name: "offer envelope inspection is bounded structural metadata, not sender authority",
  async run() {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const recipient = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const context = { purpose: "share-root-label" as const, vaultId: id(1), objectId: id(3),
      keyId: id(6), keyEpoch: 1, revision: 1, recipientId: id(7) };
    const label = await sealToRecipient(encodeShareLabel("Valid.md"), recipient.publicKey, context);
    inspectOfferEnvelope(label, context);
    const ownerContext = { purpose: "share-root-label" as const, vaultId: id(1), objectId: id(3),
      keyId: id(6), keyEpoch: 1, revision: 1 };
    const owned = await (await createSymmetricWriter(key)).seal(encodeShareLabel("Valid.md"), ownerContext);
    inspectOfferEnvelope(owned, ownerContext, SYMMETRIC_SUITE);
    const grantContext = { ...context, purpose: "grant" as const };
    const grant = await sealToRecipient(key, recipient.publicKey, grantContext);
    inspectOfferEnvelope(grant, grantContext);
    rejects(() => inspectOfferEnvelope(label, { ...context, recipientId: id(9) }), "recipient mismatch");
    rejects(() => inspectOfferEnvelope(label, { ...context, keyEpoch: 2 }), "epoch mismatch");
    rejects(() => inspectOfferEnvelope(label, { ...context, purpose: "grant" }), "purpose mismatch");
    const writer = await createSymmetricWriter(key);
    const wrongSuiteGrant = await writer.seal(key, { ...context, purpose: "grant" });
    rejects(() => inspectOfferEnvelope(wrongSuiteGrant, { ...context, purpose: "grant" }, SYMMETRIC_SUITE),
      "Grant offers can only deliver HPKE ciphertext");
    const overlong = await sealToRecipient(new Uint8Array(4096), recipient.publicKey, context);
    rejects(() => inspectOfferEnvelope(overlong, context), "label ciphertext exceeds 4KiB");
  },
}];
