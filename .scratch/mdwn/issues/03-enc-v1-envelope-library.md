# 03: `mdwn/enc-v1` envelope library and content-crypto primitives

**What to build:** The versioned envelope library every private object uses to seal and open ciphertext, such that a service holding only ciphertext can neither read it nor make the browser accept a substituted, replayed, downgraded, or context-shifted value.

**Blocked by:** 02 (Cross-engine test harness).

**Status:** done

- [x] The `mdwn/enc-v1` envelope family carries purpose, algorithm suite, protected object/key identifiers, key epoch, and ciphertext; HPKE envelopes carry the encapsulated public key and AES-GCM envelopes carry their nonce.
- [x] Public-key key transport uses a maintained RFC 9180 HPKE implementation with `DHKEM(P-256, HKDF-SHA-256)`, `HKDF-SHA-256`, and `AES-256-GCM`; no custom ECDH envelope protocol is implemented.
- [x] Symmetric content encryption and key wrapping use AES-256-GCM with a 128-bit tag, fresh collision-free 96-bit nonces, and domain-separated HKDF labels wherever derivation is needed.
- [x] Nonce allocation remains unique per key across tabs, devices, retries, and interrupted work; the strategy is stated and tested, not assumed.
- [x] Canonical authenticated context binds every envelope to its Vault/object, purpose, epoch, recipient where applicable, and Publication where applicable; the representation is deterministic wherever authenticated context or digest comparison requires it.
- [x] Clients reject unsupported versions/suites, malformed envelopes, stale epochs, replayed manifests, context mismatch, and algorithm downgrade.
- [x] Shared test vectors pass in Chromium, Firefox, WebKit, and the Worker test target; the spec's selected HPKE package and internal binary serialization are chosen and pinned here.

## Comments

- 2026-09-21: Added `app/crypto/enc-v1` (canonical `mdwn/enc-v1` binary framing, AES-256-GCM/HKDF symmetric writer, RFC 9180 HPKE base-mode grant transport via `@hpke/core` 1.9.0 pinned exact), `docs/enc-v1.md` contract, independent RFC/CFRG and app-generated vectors, and shared contract tests run in Node, workerd, Chromium, Firefox, and WebKit. Nonce strategy: fresh random 256-bit HKDF namespace per ephemeral writer, synchronous counter reservation, `2^32` message and `2^30` authenticated-byte budgets, no persisted/resumable counter. Freshness: external expected context on every open plus a caller-owned trusted manifest head; a fresh device cannot detect a whole-history rollback without one.
- Scope note: manifests in this ticket are purposes/framing plus rollback checks; the persistent trusted-head protocol belongs to ticket 09 (device-registry revision), ticket 14 (`entries_revision`), and ticket 30 (Import session state). Forward notes were added to tickets 04, 14, 18, 19, 20, 21, 22, 23, 24, 25, 29, 30, and 33, and the consumer map and open decisions are in `docs/enc-v1.md`.
- Forward note for 04/11: the symmetric HKDF label is pinned to `mdwn/enc-v1/aes-256-gcm`. The `mdwn/vault-recovery-capsule/v1` derivation must extend this module with its own label instead of passing a capsule key as `baseKey`.
- Independent verification: besides the CFRG KAT (which bypasses our framing on purpose), the shared contract now seals with a hand-written RFC 9180 base-mode implementation built from raw WebCrypto HMAC/ECDH/AES-GCM and opens the result through `openForRecipient`, so a framing/info/AAD bug cannot pass on a same-library round trip. Older envelope epochs fail as `stale-epoch`; a newer-than-current epoch fails as `unexpected-epoch`.
