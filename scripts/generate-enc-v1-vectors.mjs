// Test-data generator only. No production framing/crypto imports. Prints JSON;
// never automatically replaces accepted vectors. Review changes as protocol changes.
import { createCipheriv, createHash, hkdfSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";

/** @param {number} value @param {2 | 4 | 8} width */
function uint(value, width) {
  const b = Buffer.alloc(width);
  if (width === 8) b.writeBigUInt64BE(BigInt(value));
  else b.writeUIntBE(value, 0, width);
  return b;
}
/** @param {string} value */
function text(value) {
  const b = Buffer.from(value);
  return Buffer.concat([uint(b.length, 2), b]);
}
/** @param {1 | 2} suite @param {number} purpose @param {string} recipient */
function prefix(suite, purpose, recipient) {
  return Buffer.concat([
    Buffer.from("mdwn/enc-v1\0"), Buffer.from([suite, purpose]), uint(2, 8), uint(3, 8),
    text("vault-1"), text("file-1"), text("key-1"), text(recipient), text(""),
  ]);
}

const baseKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const salt = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 32));
const nonce = Buffer.alloc(12);
nonce.writeUInt32BE(7, 8);
const plaintext = Buffer.from("mdwn/enc-v1 interop 🌍");
const aad = Buffer.concat([prefix(1, 3, ""), salt, nonce, uint(plaintext.length + 16, 4)]);
const cipher = createCipheriv("aes-256-gcm", Buffer.from(hkdfSync("sha256", baseKey, salt, "mdwn/enc-v1/aes-256-gcm", 32)), nonce);
cipher.setAAD(aad);
const symmetric = Buffer.concat([aad, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

const rfc = JSON.parse(await readFile(new URL("../tests/fixtures/rfc9180-p256-aes256.json", import.meta.url), "utf8"));
const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const recipientPublicKey = await crypto.subtle.importKey("raw", Buffer.from(rfc.pkRm, "hex"), { name: "ECDH", namedCurve: "P-256" }, true, []);
const info = prefix(2, 5, "device-1");
// RFC debugging material ONLY in this generator: no deterministic ephemeral input in our public interface.
const sender = await suite.createSenderContext({ recipientPublicKey, info, ekm: Buffer.from(rfc.ikmE, "hex") });
if (Buffer.from(sender.enc).toString("hex") !== rfc.enc) throw new Error("Unexpected RFC encapsulation");
const hpkeAad = Buffer.concat([info, Buffer.from(sender.enc), uint(baseKey.length + 16, 4)]);
const hpke = Buffer.concat([hpkeAad, Buffer.from(await sender.seal(baseKey, hpkeAad))]);
console.log(JSON.stringify({
  generator: "node scripts/generate-enc-v1-vectors.mjs",
  baseKey: baseKey.toString("hex"),
  plaintext: plaintext.toString("hex"),
  symmetric: symmetric.toString("hex"),
  symmetricDigest: createHash("sha256").update(symmetric).digest("hex"),
  hpke: hpke.toString("hex"),
  hpkeDigest: createHash("sha256").update(hpke).digest("hex"),
}, null, 2));
