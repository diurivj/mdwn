# 03: `mdwn/enc-v1` envelope library and content-crypto primitives

**What to build:** The versioned envelope library every private object uses to seal and open ciphertext, such that a service holding only ciphertext can neither read it nor make the browser accept a substituted, replayed, downgraded, or context-shifted value.

**Blocked by:** 02 (Cross-engine test harness).

**Status:** ready-for-agent

- [ ] The `mdwn/enc-v1` envelope family carries purpose, algorithm suite, protected object/key identifiers, key epoch, and ciphertext; HPKE envelopes carry the encapsulated public key and AES-GCM envelopes carry their nonce.
- [ ] Public-key key transport uses a maintained RFC 9180 HPKE implementation with `DHKEM(P-256, HKDF-SHA-256)`, `HKDF-SHA-256`, and `AES-256-GCM`; no custom ECDH envelope protocol is implemented.
- [ ] Symmetric content encryption and key wrapping use AES-256-GCM with a 128-bit tag, fresh collision-free 96-bit nonces, and domain-separated HKDF labels wherever derivation is needed.
- [ ] Nonce allocation remains unique per key across tabs, devices, retries, and interrupted work; the strategy is stated and tested, not assumed.
- [ ] Canonical authenticated context binds every envelope to its Vault/object, purpose, epoch, recipient where applicable, and Publication where applicable; the representation is deterministic wherever authenticated context or digest comparison requires it.
- [ ] Clients reject unsupported versions/suites, malformed envelopes, stale epochs, replayed manifests, context mismatch, and algorithm downgrade.
- [ ] Shared test vectors pass in Chromium, Firefox, WebKit, and the Worker test target; the spec's selected HPKE package and internal binary serialization are chosen and pinned here.
