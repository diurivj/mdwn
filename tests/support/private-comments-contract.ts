// Public browser-crypto API exercised unchanged by Node, workerd and three actual browser engines.
import { createSymmetricWriter, inspectEnvelope } from "../../app/crypto/enc-v1";
import { createFileReceivingKey, createFileSave, openFileReceivingKey } from "../../app/crypto/file-receiving";
import {
  createPrivateThreadKey, openLegacyPrivateThreadFromDirectory, openPrivateAttribution, openPrivateComment,
  openPrivateThreadForDevice, openPrivateThreadFromFileReceiving, sealLegacyPrivateThreadForDirectory,
  sealPrivateAttribution, sealPrivateComment, sealPrivateThreadForDevice, sealPrivateThreadForFileReceiving,
} from "../../app/crypto/private-comments";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
async function failsWith(run: () => Promise<unknown>, code: string) {
  try { await run(); }
  catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === code) return;
    throw error;
  }
  throw new Error(`Expected ${code} failure`);
}
const identity = { ownerVaultId: "owner-contract", threadId: "thread-contract", threadKeyId: "thread-epoch-1",
  threadEpoch: 1, wrapRevision: 3 };

export const cases = [
  {
    name: "independent Private thread epoch recovers via verified File target and both device recipients",
    async run() {
      const directory = crypto.getRandomValues(new Uint8Array(32));
      const file = await createFileReceivingKey(directory, {
        vaultId: identity.ownerVaultId, fileId: "file-contract", receivingKeyId: "receiving-contract",
        receivingEpoch: 2, wrapRevision: 2,
      });
      const target = { vaultId: file.vaultId, fileId: file.fileId, receivingKeyId: file.receivingKeyId,
        receivingEpoch: file.receivingEpoch, publicKeyDigest: file.publicKeyDigest };
      const recipient = { ...identity, fileId: file.fileId, receivingTarget: target, receivingPublicKey: file.publicKey };
      const first = createPrivateThreadKey();
      const second = createPrivateThreadKey();
      const saved = await createFileSave({ markdown: "# Not a Comment key", metadata: new Uint8Array() },
        file.publicKey, target, { vaultId: file.vaultId, fileId: file.fileId,
          contentKeyId: "content-contract", contentEpoch: 1, revision: 2 }, []);
      assert(first.length === 32 && !same(first, second) && !same(first, saved.fileContentKey),
        "Private thread keys must be random and independent of File content keys");
      const envelope = await sealPrivateThreadForFileReceiving(first, recipient);
      const reopened = await openFileReceivingKey(file.privateKeyEnvelope, directory, file);
      assert(reopened.privateKey.extractable === false &&
        same(await openPrivateThreadFromFileReceiving(envelope, reopened, recipient), first),
      "Owner recovery must use the non-extractable File receiving pair");
      const unrelated = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      const mutablePair = { ...reopened };
      const pendingOpen = openPrivateThreadFromFileReceiving(envelope, mutablePair, recipient);
      mutablePair.publicKey = unrelated.publicKey;
      mutablePair.privateKey = unrelated.privateKey;
      assert(same(await pendingOpen, first), "Open must snapshot the File receiving pair before the first await");
      const devices = await Promise.all(["read-only-equivalent", "read-write-equivalent"].map(async (deviceId) => {
        const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
        const ciphertext = await sealPrivateThreadForDevice(first, pair.publicKey, { ...identity, deviceId });
        assert(inspectEnvelope(ciphertext).context.recipientId === deviceId, "Device recipient is mandatory");
        assert(same(await openPrivateThreadForDevice(ciphertext, pair, { ...identity, deviceId }), first),
          "Current File-read recipient can decrypt independently of Markdown permission");
        return { pair, ciphertext, deviceId };
      }));
      await failsWith(() => openPrivateThreadForDevice(devices[0].ciphertext, devices[0].pair,
        { ...identity, deviceId: devices[1].deviceId }), "context-mismatch");
      await failsWith(() => sealPrivateThreadForFileReceiving(first,
        { ...recipient, receivingTarget: { ...target, publicKeyDigest: new Uint8Array(32) } }), "context-mismatch");
    },
  },
  {
    name: "Private Comment text, retained epoch and pseudonym declaration stay purpose-bound",
    async run() {
      const key = createPrivateThreadKey();
      const device = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      const later = { ...identity, threadEpoch: 2, threadKeyId: "thread-epoch-2", wrapRevision: 4, deviceId: "device-contract" };
      const previous = await sealPrivateThreadForDevice(key, device.publicKey, { ...identity, deviceId: later.deviceId });
      assert(same(await openPrivateThreadForDevice(previous, device, { ...identity, deviceId: later.deviceId }), key),
        "Retained epoch must open with its exact trusted epoch");
      await failsWith(() => openPrivateThreadForDevice(previous, device, later), "stale-epoch");
      const laterEnvelope = await sealPrivateThreadForDevice(createPrivateThreadKey(), device.publicKey, later);
      await failsWith(() => openPrivateThreadForDevice(laterEnvelope, device,
        { ...identity, deviceId: later.deviceId }), "unexpected-epoch");
      const comment = { ownerVaultId: identity.ownerVaultId, commentId: "comment-contract",
        threadKeyId: identity.threadKeyId, threadEpoch: identity.threadEpoch, revision: 4 };
      const markup = "<h1>literal</h1>\n**not Markdown**\n\uFEFF";
      assert(await openPrivateComment(await sealPrivateComment(key, markup, comment), key, comment) === markup,
        "Markup, BOM and line breaks must remain literal");
      for (const text of ["a".repeat(2_000), "😀".repeat(2_000)]) {
        assert(await openPrivateComment(await sealPrivateComment(key, text, comment), key, comment) === text,
          "Exactly 2,000 Unicode scalars must roundtrip");
      }
      await failsWith(() => sealPrivateComment(key, "😀".repeat(2_001), comment), "malformed");
      const attribution = { ownerVaultId: identity.ownerVaultId, attributionId: "attribution-contract",
        threadKeyId: identity.threadKeyId, threadEpoch: identity.threadEpoch, revision: 1 };
      const declared = "Member 🦊";
      const pseudonym = await sealPrivateAttribution(key, { publicPseudonym: declared }, attribution);
      assert(await openPrivateAttribution(pseudonym, key, attribution) === declared,
        "Only the supplied Account-profile Public pseudonym declaration is decrypted");
      await failsWith(() => openPrivateAttribution(pseudonym, key,
        { ...attribution, attributionId: "other-attribution" }), "context-mismatch");
      const invalid = await (await createSymmetricWriter(key)).seal(new TextEncoder().encode("x".repeat(2_001)), {
        purpose: "comment-content", vaultId: comment.ownerVaultId, objectId: comment.commentId,
        keyId: comment.threadKeyId, keyEpoch: comment.threadEpoch, revision: comment.revision,
      });
      await failsWith(() => openPrivateComment(invalid, key, comment), "malformed");
    },
  },
  {
    name: "explicit legacy Directory wrapper never downgrades File/device HPKE",
    async run() {
      const key = createPrivateThreadKey();
      const directory = crypto.getRandomValues(new Uint8Array(32));
      const legacy = await sealLegacyPrivateThreadForDirectory(key, directory, identity);
      assert(legacy.kind === "legacy-directory" && same(await openLegacyPrivateThreadFromDirectory(legacy, directory, identity), key),
        "Tagged legacy parent opens only as symmetric purpose 10");
      const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      await failsWith(() => openPrivateThreadForDevice(legacy.ciphertext, pair,
        { ...identity, deviceId: "device-contract" }), "unsupported-suite");
      const hpke = await sealPrivateThreadForDevice(key, pair.publicKey, { ...identity, deviceId: "device-contract" });
      await failsWith(() => openLegacyPrivateThreadFromDirectory({ kind: "legacy-directory", ciphertext: hpke },
        directory, identity), "unsupported-suite");
    },
  },
];
