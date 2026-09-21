// Framework-free contract: the very same checks run in Node, workerd and real browsers.
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import {
  createSymmetricWriter, digestEnvelope, EnvelopeError, inspectEnvelope,
  openForRecipient, openSymmetric, sealToRecipient, type EnvelopeContext,
} from "../../app/crypto/enc-v1";
import {
  createRecoveryMaterial,
  generateRecoveryPhrase,
  openRecoveryCapsule,
  recoveryPhraseToSecret,
  RecoveryError,
} from "../../app/crypto/vault";
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
 * app/crypto/enc-v1, so it catches a framing, info, or AAD bug that a
 * same-library round trip cannot. The RFC KAT above cannot do this because it
 * bypasses our framing deliberately.
 */
const HPKE_SUITE_ID = concatBytes(utf8("HPKE"), u16(0x0010), u16(0x0001), u16(0x0002));
const KEM_SUITE_ID = concatBytes(utf8("KEM"), u16(0x0010));
const PURPOSE_IDS: Record<string, number> = {
  "file-content": 3, grant: 5, "device-enrollment": 6,
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

/** Independently seals `plaintext` to `recipientPublicKey` using the documented mdwn/enc-v1 layout. */
async function independentHpkeSeal(plaintext: Uint8Array<ArrayBuffer>, context: EnvelopeContext): Promise<CryptoKeyPair & { envelope: Uint8Array<ArrayBuffer> }> {
  const recipient = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  // Keep the private handle non-extractable, as production requires.
  const recipientKeyPair: CryptoKeyPair = {
    privateKey: await crypto.subtle.importKey("jwk", await crypto.subtle.exportKey("jwk", recipient.privateKey), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", await crypto.subtle.exportKey("raw", recipient.publicKey), { name: "ECDH", namedCurve: "P-256" }, true, []),
  };
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const enc = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const pkRm = new Uint8Array(await crypto.subtle.exportKey("raw", recipientKeyPair.publicKey));
  const info = concatBytes(utf8("mdwn/enc-v1\u0000"), Uint8Array.of(2), encodeContextLayout(context));
  const aad = concatBytes(info, enc, u32(plaintext.length + 16));

  const dh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeral.publicKey }, recipientKeyPair.privateKey, 256));
  const eaePrk = await labeledExtract(KEM_SUITE_ID, new Uint8Array(0), "eae_prk", dh);
  const sharedSecret = await labeledExpand(KEM_SUITE_ID, eaePrk, "shared_secret", concatBytes(enc, pkRm), 32);
  const pskIdHash = await labeledExtract(HPKE_SUITE_ID, new Uint8Array(0), "psk_id_hash", new Uint8Array(0));
  const infoHash = await labeledExtract(HPKE_SUITE_ID, new Uint8Array(0), "info_hash", info);
  const keyScheduleContext = concatBytes(Uint8Array.of(0), pskIdHash, infoHash);
  const secret = await labeledExtract(HPKE_SUITE_ID, sharedSecret, "secret", new Uint8Array(0));
  const key = await crypto.subtle.importKey("raw", await labeledExpand(HPKE_SUITE_ID, secret, "key", keyScheduleContext, 32), "AES-GCM", false, ["encrypt"]);
  const baseNonce = await labeledExpand(HPKE_SUITE_ID, secret, "base_nonce", keyScheduleContext, 12);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: baseNonce, additionalData: aad, tagLength: 128 }, key, plaintext));
  return { ...recipientKeyPair, envelope: concatBytes(aad, ciphertext) };
}

export const cases = [
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
    name: "round-trips the Vault recovery phrase and capsule across engines",
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
