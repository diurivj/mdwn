// Framework-free contract: the very same checks run in Node, workerd and real browsers.
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import {
  createSymmetricWriter, digestEnvelope, EnvelopeError, inspectEnvelope,
  openForRecipient, openSymmetric, sealToRecipient, type EnvelopeContext,
} from "../../app/shared/crypto/enc-v1";
import {
  createRecoveryMaterial,
  generateRecoveryPhrase,
  openRecoveryCapsule,
  recoveryPhraseToSecret,
  RecoveryError,
} from "../../app/shared/crypto/vault";
import {
  createPublicationKeyPair, formatPublicationFragment, importPublicationKeyPair, parsePublicationFragment,
} from "../../app/shared/publications/capability";
import {
  openAuthorDeclaration, openPublicRepresentation, publicPresentation, sealPublicRepresentation,
} from "../../app/shared/publications/content";
import vector from "../fixtures/enc-v1.json" with { type: "json" };
import rfc from "../fixtures/rfc9180-p256-aes256.json" with { type: "json" };

export { createSymmetricWriter, inspectEnvelope, openSymmetric };

export function bytes(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}
export function hex(value: Uint8Array | ArrayBuffer): string {
  return Array.from(value instanceof Uint8Array ? value : new Uint8Array(value), (b) => b.toString(16).padStart(2, "0")).join("");
}
function assertEqual(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`Contract mismatch: expected ${expected}, got ${actual}`);
}
async function rejects(operation: Promise<unknown>, code: string) {
  try {
    await operation;
  } catch (error) {
    if (error instanceof EnvelopeError && error.code === code) return;
    throw error;
  }
  throw new Error(`Expected ${code} rejection`);
}

async function rejectsRecovery(operation: Promise<unknown>, code: string) {
  try {
    await operation;
  } catch (error) {
    if (error instanceof RecoveryError && error.code === code) return;
    throw error;
  }
  throw new Error(`Expected recovery ${code} rejection`);
}

export const baseKey = bytes(vector.baseKey);
export const context: EnvelopeContext = {
  purpose: "file-content", vaultId: "vault-1", objectId: "file-1", keyId: "key-1", keyEpoch: 2, revision: 3,
};
const grantContext: EnvelopeContext = { ...context, purpose: "grant", recipientId: "device-1" };

async function vectorKeyPair(publicHex = rfc.pkRm, privateHex = rfc.skRm): Promise<CryptoKeyPair> {
  const publicBytes = bytes(publicHex);
  const base64url = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const jwk = {
    kty: "EC", crv: "P-256", x: base64url(publicBytes.slice(1, 33)),
    y: base64url(publicBytes.slice(33)), d: base64url(bytes(privateHex)),
  };
  return {
    privateKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", publicBytes, { name: "ECDH", namedCurve: "P-256" }, true, []),
  };
}

/*
 * An independent RFC 9180 base-mode implementation built directly from WebCrypto
 * HMAC/ECDH/AES-GCM, per the documented mdwn framing. It shares no code with
 * app/shared/crypto/enc-v1, so it catches a framing, info, or AAD bug that a
 * same-library round trip cannot. The RFC KAT above cannot do this because it
 * bypasses our framing deliberately.
 */
const HPKE_SUITE_ID = concatBytes(utf8("HPKE"), u16(0x0010), u16(0x0001), u16(0x0002));
const KEM_SUITE_ID = concatBytes(utf8("KEM"), u16(0x0010));
const PURPOSE_IDS: Record<string, number> = {
  "file-content": 3, grant: 5, "device-enrollment": 6, "public-representation": 9, "publication-attribution": 21,
};

function utf8(value: string): Uint8Array<ArrayBuffer> { return new Uint8Array(new TextEncoder().encode(value)); }
function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
function u16(value: number) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, value); return b; }
function u32(value: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value); return b; }
function u64(value: number) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(value)); return b; }
function lengthPrefixed(value: string | undefined) {
  const body = value === undefined || value === "" ? new Uint8Array(0) : utf8(value);
  return concatBytes(u16(body.length), body);
}
// Hand-built from docs/enc-v1.md, not from the library's encoder.
function encodeContextLayout(context: EnvelopeContext): Uint8Array<ArrayBuffer> {
  return concatBytes(
    Uint8Array.of(PURPOSE_IDS[context.purpose]), u64(context.keyEpoch), u64(context.revision),
    lengthPrefixed(context.vaultId), lengthPrefixed(context.objectId), lengthPrefixed(context.keyId),
    lengthPrefixed(context.recipientId), lengthPrefixed(context.publicationId),
  );
}

async function independentRecoveryVector(): Promise<string> {
  const secret = new Uint8Array(32);
  const salt = bytes("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");
  const accountId = "account-fixed-vector";
  const label = utf8("mdwn/vault-recovery-capsule/v1");
  const account = utf8(accountId);
  const info = concatBytes(label, u16(account.length), account, u64(1));
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt"],
  );
  const nonce = bytes("a0a1a2a3a4a5a6a7a8a9aaab");
  const aad = utf8("mdwn/recovery-capsule-vector-aad/v1");
  const plaintext = utf8("mdwn/vault-recovery-capsule/v1\0");
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, plaintext,
  );
  return hex(ciphertext);
}

// Fixed, test-only P-256 signing material. The private key is serialized in the
// capsule plaintext; production returns it only as a non-extractable CryptoKey.
const INDEPENDENT_RECOVERY_PRIVATE_PKCS8 = bytes(
  "308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420317f915db7bc629c48fe765587897e01e282d3e8445f79f27f65d031a88082b2a14403420004abc7e49a4c6b3566d77d0304addc6ed0e98512ffccf505e6a8e3eb25c685136f853148544876de76c0f2ef99cdc3a05ccf5ded7860c7c021238f9e2073d2356c",
);
const INDEPENDENT_RECOVERY_PUBLIC_KEY = bytes(
  "04abc7e49a4c6b3566d77d0304addc6ed0e98512ffccf505e6a8e3eb25c685136f853148544876de76c0f2ef99cdc3a05ccf5ded7860c7c021238f9e2073d2356c",
);
const INDEPENDENT_RECOVERY_CAPSULE_HEX = [
  "6d64776e2f656e632d763100010800000000000000070000000000000001001b6163636f756e742d696e646570656e64",
  "656e742d63617073756c6500167661756c742d7265636f766572792d63617073756c6500167661756c742d7265636f76",
  "6572792d63617073756c65000000000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20a0",
  "a1a2a3a4a5a6a7a8a9aaab000000dd79e435a5560b43e8f2aa8ea902023fb16fb83601b3829a30e8a453d0237931b14f",
  "302cbdada9d18a5417ed7f52e471d8305235e6cf59526cf1c8577954fe952fccebb8355af954ec0c31749fd340ae591d",
  "ade6ee3e160901b212c370cecf744d21c3be6eb2df6c713002f094f2f0309d6d93aa9e3001c55469cd3ccbe70ed1317a",
  "7b03f8d09e566bc9b940587f2ed69a7d5373392a5c2c088ccdc729def98d66622d1b45ea9aa8b9c02bd7ad4ff56a9ee1",
  "45b03198547379d5f69e261bdeb9549bc0e3719b67336fb4098ac188470d383deaf3d04971511c8101186dcf",
].join("");

function independentRecoveryPrefix(accountId: string, generation: number): Uint8Array<ArrayBuffer> {
  // This is deliberately a separate encoder from app/shared/crypto/enc-v1/format.
  // Purpose 8 is the pinned recovery-capsule purpose ID in the v1 table.
  const objectId = "vault-recovery-capsule";
  return concatBytes(
    utf8("mdwn/enc-v1\0"), Uint8Array.of(1), Uint8Array.of(8),
    u64(generation), u64(1), lengthPrefixed(accountId), lengthPrefixed(objectId),
    lengthPrefixed(objectId), lengthPrefixed(undefined), lengthPrefixed(undefined),
  );
}

function independentRecoveryInfo(accountId: string, generation: number): Uint8Array<ArrayBuffer> {
  const label = utf8("mdwn/vault-recovery-capsule/v1");
  const account = utf8(accountId);
  return concatBytes(label, u16(account.length), account, u64(generation));
}

async function independentRecoveryCapsuleFixture(): Promise<{
  accountId: string;
  generation: number;
  phrase: string;
  recoverySalt: Uint8Array<ArrayBuffer>;
  capsule: Uint8Array<ArrayBuffer>;
  vaultRootKey: Uint8Array<ArrayBuffer>;
  recoveryVerificationPublicKey: Uint8Array<ArrayBuffer>;
}> {
  const accountId = "account-independent-capsule";
  const generation = 7;
  const recoverySecret = new Uint8Array(32);
  const recoverySalt = bytes("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");
  const nonce = bytes("a0a1a2a3a4a5a6a7a8a9aaab");
  const vaultRootKey = bytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  const plaintext = concatBytes(
    utf8("mdwn/vault-recovery-capsule/v1\0"), vaultRootKey,
    u32(INDEPENDENT_RECOVERY_PRIVATE_PKCS8.length), INDEPENDENT_RECOVERY_PRIVATE_PKCS8,
  );
  const aad = concatBytes(
    independentRecoveryPrefix(accountId, generation), recoverySalt, nonce,
    u32(plaintext.length + 16),
  );
  const base = await crypto.subtle.importKey("raw", recoverySecret, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: recoverySalt, info: independentRecoveryInfo(accountId, generation) },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt"],
  );
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, plaintext,
  ));
  const capsule = concatBytes(aad, ciphertext);
  assertEqual(hex(capsule), INDEPENDENT_RECOVERY_CAPSULE_HEX);
  return {
    accountId,
    generation,
    phrase: `${"abandon ".repeat(23)}art`,
    recoverySalt,
    capsule,
    vaultRootKey,
    recoveryVerificationPublicKey: INDEPENDENT_RECOVERY_PUBLIC_KEY,
  };
}
async function hmac(key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const handle = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", handle, data));
}
async function hkdfExtract(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return hmac(salt.length ? salt : new Uint8Array(32), ikm);
}
async function hkdfExpand(prk: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number): Promise<Uint8Array<ArrayBuffer>> {
  let out: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  let block: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  for (let counter = 1; out.length < length; counter++) {
    block = await hmac(prk, concatBytes(block, info, Uint8Array.of(counter)));
    out = concatBytes(out, block);
  }
  return out.slice(0, length);
}
async function labeledExtract(suiteId: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, label: string, ikm: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return hkdfExtract(salt, concatBytes(utf8("HPKE-v1"), suiteId, utf8(label), ikm));
}
async function labeledExpand(suiteId: Uint8Array<ArrayBuffer>, prk: Uint8Array<ArrayBuffer>, label: string, info: Uint8Array<ArrayBuffer>, length: number): Promise<Uint8Array<ArrayBuffer>> {
  return hkdfExpand(prk, concatBytes(u16(length), utf8("HPKE-v1"), suiteId, utf8(label), info), length);
}

/** Independently seals `plaintext` to a fresh recipient using the documented mdwn/enc-v1 layout. */
async function independentHpkeSeal(plaintext: Uint8Array<ArrayBuffer>, context: EnvelopeContext): Promise<CryptoKeyPair & { envelope: Uint8Array<ArrayBuffer> }> {
  const recipient = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  // Keep the private handle non-extractable, as production requires.
  const recipientKeyPair: CryptoKeyPair = {
    privateKey: await crypto.subtle.importKey("jwk", await crypto.subtle.exportKey("jwk", recipient.privateKey), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", await crypto.subtle.exportKey("raw", recipient.publicKey), { name: "ECDH", namedCurve: "P-256" }, true, []),
  };
  return { ...recipientKeyPair, envelope: await independentHpkeSealTo(plaintext, context, recipientKeyPair.publicKey) };
}

/** Sender-only: any holder of a public key (a Publication editor) can do this. */
async function independentHpkeSealTo(plaintext: Uint8Array<ArrayBuffer>, context: EnvelopeContext,
  recipientPublicKey: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const enc = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const pkRm = new Uint8Array(await crypto.subtle.exportKey("raw", recipientPublicKey));
  const info = concatBytes(utf8("mdwn/enc-v1\u0000"), Uint8Array.of(2), encodeContextLayout(context));
  const aad = concatBytes(info, enc, u32(plaintext.length + 16));

  const dh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: recipientPublicKey }, ephemeral.privateKey, 256));
  const eaePrk = await labeledExtract(KEM_SUITE_ID, new Uint8Array(0), "eae_prk", dh);
  const sharedSecret = await labeledExpand(KEM_SUITE_ID, eaePrk, "shared_secret", concatBytes(enc, pkRm), 32);
  const pskIdHash = await labeledExtract(HPKE_SUITE_ID, new Uint8Array(0), "psk_id_hash", new Uint8Array(0));
  const infoHash = await labeledExtract(HPKE_SUITE_ID, new Uint8Array(0), "info_hash", info);
  const keyScheduleContext = concatBytes(Uint8Array.of(0), pskIdHash, infoHash);
  const secret = await labeledExtract(HPKE_SUITE_ID, sharedSecret, "secret", new Uint8Array(0));
  const key = await crypto.subtle.importKey("raw", await labeledExpand(HPKE_SUITE_ID, secret, "key", keyScheduleContext, 32), "AES-GCM", false, ["encrypt"]);
  const baseNonce = await labeledExpand(HPKE_SUITE_ID, secret, "base_nonce", keyScheduleContext, 12);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: baseNonce, additionalData: aad, tagLength: 128 }, key, plaintext));
  return concatBytes(aad, ciphertext);
}

function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Hand-built from docs/publications.md: presentation and author plaintext framing. */
function independentPresentation(title: string, markdown: string): Uint8Array<ArrayBuffer> {
  const titleBytes = utf8(title), markdownBytes = utf8(markdown);
  return concatBytes(utf8("mdwn/public-presentation/v1\u0000"), u32(titleBytes.length), titleBytes, u32(markdownBytes.length), markdownBytes);
}
function independentAuthor(pseudonym: string): Uint8Array<ArrayBuffer> {
  const body = utf8(pseudonym);
  return concatBytes(utf8("mdwn/publication-author/v1\u0000"), u16(body.length), body);
}

export const cases = [
  {
    name: "reads an independently sealed Public representation and author declaration from a fixed link fragment",
    async run() {
      // The CFRG recipient pair stands in for a link key; its scalar is the fragment capability.
      const publicKey = bytes(rfc.pkRm), fragment = `v1.${base64url(bytes(rfc.skRm))}`;
      const publicationId = base64url(Uint8Array.from({ length: 32 }, (_, index) => index));
      const linkId = base64url(Uint8Array.from({ length: 32 }, (_, index) => 255 - index));
      const declarationId = base64url(Uint8Array.from({ length: 32 }, (_, index) => index * 3));
      const recipientId = base64url(publicKey);
      const recipient = await crypto.subtle.importKey("raw", publicKey, { name: "ECDH", namedCurve: "P-256" }, true, []);
      const shared = { vaultId: publicationId, keyId: linkId, keyEpoch: 1, recipientId, publicationId };
      const representation = await independentHpkeSealTo(independentPresentation("Plan ☕", "# Week\n\n**Bold**"),
        { ...shared, purpose: "public-representation", objectId: publicationId, revision: 4 }, recipient);
      const declaration = await independentHpkeSealTo(independentAuthor("Member Vector"),
        { ...shared, purpose: "publication-attribution", objectId: declarationId, revision: 2 }, recipient);
      const scalar = parsePublicationFragment(`#${fragment}`);
      if (!scalar) throw new Error("Contract mismatch: fragment rejected");
      const pair = await importPublicationKeyPair(scalar, publicKey);
      assertEqual(pair.privateKey.extractable, false);
      const binding = { publicationId, linkId, publicKey };
      const opened = await openPublicRepresentation(representation, pair, { ...binding, revision: 4 });
      assertEqual(opened.title, "Plan ☕");
      assertEqual(opened.markdown, "# Week\n\n**Bold**");
      assertEqual(await openAuthorDeclaration(declaration, pair, { ...binding, declarationId, revision: 2 }), "Member Vector");
      await rejects(openPublicRepresentation(representation, pair, { ...binding, linkId: publicationId, revision: 4 }), "context-mismatch");
      await rejects(openPublicRepresentation(declaration, pair, { ...binding, revision: 2 }), "context-mismatch");
    },
  },
  {
    name: "opens a fresh Publication link key only through its own fragment",
    async run() {
      const keys = await createPublicationKeyPair();
      const publicationId = base64url(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
      const linkId = base64url(Uint8Array.from({ length: 32 }, (_, index) => index + 2));
      const binding = { publicationId, linkId, publicKey: keys.publicKey, revision: 1 };
      const envelope = await sealPublicRepresentation(binding, publicPresentation("---\ntitle: Fresh\nsecret: no\n---\nBody"));
      const scalar = parsePublicationFragment(formatPublicationFragment(keys.privateKey));
      if (!scalar) throw new Error("Contract mismatch: fragment rejected");
      const opened = await openPublicRepresentation(envelope, await importPublicationKeyPair(scalar, keys.publicKey), binding);
      assertEqual(opened.title, "Fresh");
      assertEqual(opened.markdown, "Body");
    },
  },
  {
    name: "opens an envelope produced by an independent RFC 9180 WebCrypto implementation",
    async run() {
      const sealed = await independentHpkeSeal(baseKey, grantContext);
      const opened = await openForRecipient(sealed.envelope, { privateKey: sealed.privateKey, publicKey: sealed.publicKey }, { context: grantContext });
      assertEqual(hex(opened), vector.baseKey);
      await rejects(openForRecipient(sealed.envelope, { privateKey: sealed.privateKey, publicKey: sealed.publicKey }, { context: { ...grantContext, recipientId: "other-device" } }), "context-mismatch");
    },
  },
  {
    name: "opens the independently generated symmetric envelope and digest",
    async run() {
      const envelope = bytes(vector.symmetric);
      assertEqual(hex(await openSymmetric(envelope, baseKey, { context })), vector.plaintext);
      assertEqual(hex(await digestEnvelope(envelope)), vector.symmetricDigest);
    },
  },
  {
    name: "matches the CFRG P-256 / HKDF-SHA-256 / AES-256-GCM vector",
    async run() {
      const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
      const recipientKey = await vectorKeyPair();
      // Supply the RFC's complete ephemeral pair: WebKit rejects the upstream seed
      // helper's scalar-only PKCS8 import. Production never accepts deterministic material.
      const ephemeral = await vectorKeyPair(rfc.enc, rfc.skEm);
      const sealed = await suite.seal(
        { recipientPublicKey: recipientKey.publicKey, info: bytes(rfc.info), ekm: ephemeral },
        bytes(rfc.encryption.pt), bytes(rfc.encryption.aad),
      );
      assertEqual(hex(sealed.enc), rfc.enc);
      assertEqual(hex(sealed.ct), rfc.encryption.ct);
      const opened = await suite.open(
        { recipientKey, info: bytes(rfc.info), enc: bytes(rfc.enc) },
        bytes(rfc.encryption.ct), bytes(rfc.encryption.aad),
      );
      assertEqual(hex(opened), rfc.encryption.pt);
      assertEqual(recipientKey.privateKey.extractable, false);
    },
  },
  {
    name: "opens the fixed HPKE Grant envelope and digest with non-extractable keys",
    async run() {
      const envelope = bytes(vector.hpke);
      assertEqual(hex(await openForRecipient(envelope, await vectorKeyPair(), { context: grantContext })), vector.baseKey);
      assertEqual(hex(await digestEnvelope(envelope)), vector.hpkeDigest);
    },
  },
  {
    name: "rejects malformed, downgraded, tampered, and context-shifted ciphertext",
    async run() {
      const symmetric = bytes(vector.symmetric);
      const hpke = bytes(vector.hpke);
      const recipient = await vectorKeyPair();
      const tampered = hpke.slice();
      tampered[tampered.length - 1] ^= 1;
      await rejects(openForRecipient(tampered, recipient, { context: grantContext }), "authentication-failed");
      await rejects(openForRecipient(hpke, recipient, { context: { ...grantContext, recipientId: "other-device" } }), "context-mismatch");
      await rejects(openSymmetric(symmetric, baseKey, { context: { ...context, keyEpoch: 3 } }), "stale-epoch");
      await rejects(openSymmetric(symmetric, baseKey, { context: { ...context, publicationId: "other-publication" } }), "context-mismatch");
      await rejects(openSymmetric(hpke, baseKey, { context: grantContext }), "unsupported-suite");
      await rejects(openForRecipient(symmetric, recipient, { context }), "unsupported-suite");
      await rejects(openSymmetric(symmetric.slice(0, -1), baseKey, { context }), "malformed");
      symmetric[10] = 50;
      await rejects(openSymmetric(symmetric, baseKey, { context }), "unsupported-version");
      symmetric[10] = 49;
      symmetric[12] = 255;
      await rejects(openSymmetric(symmetric, baseKey, { context }), "unsupported-suite");
    },
  },
  {
    name: "seals content and transports keys using fresh real cryptography",
    async run() {
      const writer = await createSymmetricWriter(baseKey);
      const envelope = await writer.seal(bytes(vector.plaintext), context);
      assertEqual(hex(await openSymmetric(envelope, baseKey, { context })), vector.plaintext);
      const recipient = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      const transported = await sealToRecipient(baseKey, recipient.publicKey, grantContext);
      assertEqual(hex(await openForRecipient(transported, recipient, { context: grantContext })), vector.baseKey);
      // Each HPKE envelope must use fresh ephemeral material (one message per base-mode context).
      const again = await sealToRecipient(baseKey, recipient.publicKey, grantContext);
      assertEqual(hex(inspectEnvelope(transported).enc!) === hex(inspectEnvelope(again).enc!), false);
      assertEqual(hex(transported) === hex(again), false);
    },
  },
  {
    name: "rejects old and same-revision manifests using an external trusted head",
    async run() {
      const writer = await createSymmetricWriter(baseKey);
      const head: EnvelopeContext = { ...context, purpose: "import-staging-manifest" };
      const current = await writer.seal(baseKey, head);
      const previous = await writer.seal(baseKey, { ...head, revision: 2 });
      const fork = await writer.seal(new Uint8Array(32), head);
      const expected = { context: head, manifestDigest: await digestEnvelope(current) };
      assertEqual(hex(await openSymmetric(current, baseKey, expected)), vector.baseKey);
      await rejects(openSymmetric(previous, baseKey, expected), "replayed-manifest");
      await rejects(openSymmetric(fork, baseKey, expected), "replayed-manifest");
      await rejects(openSymmetric(current, baseKey, { context: head }), "replayed-manifest");
    },
  },
  {
    name: "bounds aggregate authenticated GCM bytes per derived key",
    async run() {
      const message = bytes("00112233445566778899aabbccddeeff");
      const writer = await createSymmetricWriter(baseKey, { maxAuthenticatedBytes: 144 });
      await writer.seal(message, context);
      await rejects(writer.seal(message, context), "nonce-exhausted");
      await rejects(createSymmetricWriter(baseKey, { maxAuthenticatedBytes: 2 ** 30 + 1 }), "malformed");
    },
  },
  {
    name: "allocates bounded concurrent nonces and starts a new key domain on restart",
    async run() {
      const writer = await createSymmetricWriter(baseKey, { maxMessages: 2 });
      const [a, b] = await Promise.all([writer.seal(baseKey, context), writer.seal(baseKey, context)]);
      const first = inspectEnvelope(a);
      const second = inspectEnvelope(b);
      assertEqual(hex(first.salt!), hex(second.salt!));
      assertEqual(hex(first.nonce!), "000000000000000000000000");
      assertEqual(hex(second.nonce!), "000000000000000000000001");
      await rejects(writer.seal(baseKey, context), "nonce-exhausted");
      const restarted = await (await createSymmetricWriter(baseKey)).seal(baseKey, context);
      assertEqual(hex(inspectEnvelope(restarted).salt!) === hex(first.salt!), false);
      assertEqual(hex(await openSymmetric(restarted, baseKey, { context })), vector.baseKey);
    },
  },
  {
    name: "opens an independent recovery capsule and round-trips across engines",
    async run() {
      // BIP-39 English test vector: 32 zero entropy bytes encode as 23x
      // `abandon` followed by `art` (the checksum word).
      const zeroPhrase = `${"abandon ".repeat(23)}art`;
      assertEqual(generateRecoveryPhrase(new Uint8Array(32)), zeroPhrase);
      assertEqual(hex(recoveryPhraseToSecret(zeroPhrase)), "00".repeat(32));
      assertEqual(
        await independentRecoveryVector(),
        "105d91dd324a6b2f706e852771d0de27d61c1f373a07bb5af0ec0fe1a1cd3dd3a5feb5c34a27c3073c7e92e359ec7b",
      );
      const independent = await independentRecoveryCapsuleFixture();
      const independentlyOpened = await openRecoveryCapsule({
        accountId: independent.accountId,
        generation: independent.generation,
        recoverySalt: independent.recoverySalt,
        capsule: independent.capsule,
        recoveryVerificationPublicKey: independent.recoveryVerificationPublicKey,
      }, independent.phrase, {
        accountId: independent.accountId,
        generation: independent.generation,
        recoverySalt: independent.recoverySalt,
      });
      assertEqual(hex(independentlyOpened.vaultRootKey), hex(independent.vaultRootKey));

      const material = await createRecoveryMaterial("account-cross-engine", { vaultRootKey: baseKey });
      assertEqual(material.phrase.split(" ").length, 24);
      assertEqual(generateRecoveryPhrase(material.recoverySecret), material.phrase);
      const opened = await openRecoveryCapsule(material.record, material.phrase, {
        accountId: material.accountId,
        generation: material.generation,
        recoverySalt: material.record.recoverySalt,
      });
      assertEqual(hex(opened.vaultRootKey), vector.baseKey);

      const tampered = material.record.capsule.slice();
      tampered[tampered.length - 1] ^= 1;
      await rejectsRecovery(openRecoveryCapsule({ ...material.record, capsule: tampered }, material.phrase, {
        accountId: material.accountId,
        generation: material.generation,
        recoverySalt: material.record.recoverySalt,
      }), "authentication-failed");
      await rejectsRecovery(openRecoveryCapsule(material.record, material.phrase, {
        accountId: material.accountId,
        generation: material.generation + 1,
        recoverySalt: material.record.recoverySalt,
      }), "superseded-generation");
    },
  },
];
