# enc-v1 HPKE dependency research

## Decision

Use exact `"@hpke/core": "1.9.0"`, not `hpke-js`: the required WebCrypto suite needs no extension. [npm metadata](https://registry.npmjs.org/@hpke/core/1.9.0) declares transitive `@hpke/common: ^1.10.0`; commit an exact lockfile resolution (the README’s “no external dependencies” is not literally zero npm dependencies). [Release history](https://github.com/dajiaji/hpke-js/blob/main/packages/core/CHANGES.md) records 1.9.0 on 2026-03-08 and active compatibility/security maintenance.

## Exact API

```ts
import { CipherSuite, DhkemP256HkdfSha256, HkdfSha256,
  Aes256Gcm } from "@hpke/core";
const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(), aead: new Aes256Gcm(),
});
const keys = await crypto.subtle.generateKey(
  { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
const { enc, ct } = await suite.seal(
  { recipientPublicKey: keys.publicKey, info }, plaintext, aad);
const plaintextAgain = await suite.open(
  { recipientKey: keys, enc, info }, ct, aad);
```

`info`, `aad`, and plaintext are byte buffers/views; outputs are ArrayBuffers. Omit PSK/sender-authentication parameters for base mode. Crucially, retain and pass the **CryptoKeyPair**, containing the non-extractable private key and matching exportable public key. [Decapsulation source](https://github.com/dajiaji/hpke-js/blob/main/packages/common/src/kems/dhkem.ts) serializes the recipient public key into KEM context. Passing only a non-extractable private key invokes public-key recovery; its [fallback](https://github.com/dajiaji/hpke-js/blob/main/packages/common/src/kems/dhkemPrimitives/ec.ts) canonicalizes Y parity and can recover the wrong encoded point. Library `generateKeyPair()` makes private keys extractable; use WebCrypto directly above.

[One-shot implementation](https://github.com/dajiaji/hpke-js/blob/f9fbe3d5a6404f516df859e472c078c0d08e8057/packages/core/src/cipherSuiteNative.ts) creates a fresh context per call: one ciphertext, sequence zero. Never reuse deterministic ephemeral material in production. Multi-message contexts require ordered state; upstream caps sequence numbers at `2^53-1`.

## Compatibility/security

[Upstream](https://github.com/dajiaji/hpke-js#supported-environments) lists Chrome, Firefox, Safari and Cloudflare Workers; [Workers docs](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) support the required primitives. Actual Chromium/Firefox/WebKit/workerd cross-runtime vector tests remain the acceptance gate; not executed here. Library is **not formally audited**. [Nonce-reuse advisory](https://github.com/dajiaji/hpke-js/security/advisories/GHSA-73g8-5h73-26h4) affects core ≤1.7.4, fixed 1.7.5. [RFC 9180](https://www.rfc-editor.org/rfc/rfc9180.html#section-9) base mode does not authenticate senders or prevent replay; application context and freshness checks remain essential.

## Independent vector

Use the RFC’s immutable [CFRG JSON](https://raw.githubusercontent.com/cfrg/draft-irtf-cfrg-hpke/5f503c564da00b0687b3de75f1dfbdfc4079ad31/test-vectors.json), selecting `mode===0 && kem_id===16 && kdf_id===1 && aead_id===2`. Verified that entry exists. Hex-decode `info`, `pkRm`, `skRm`, `enc`, and `encryptions[0].{aad,pt,ct}`. Import recipient private JWK from `skRm` plus X/Y from `pkRm` with extractable=false; supply the corresponding public key. For deterministic sealing only in tests, `ekm: ikmE` is the supported debugging hook. First ciphertext starts `58c61a45059d0c57`; nonce is `9bc50980832a7b4b58c40161`. Printed RFC Appendix A.3 instead uses AES-128-GCM: do not substitute it.
