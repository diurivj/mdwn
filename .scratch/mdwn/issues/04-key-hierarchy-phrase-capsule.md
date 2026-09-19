# 04: Vault key hierarchy, Vault recovery secret, and Recovery capsule

**What to build:** The browser-side key hierarchy that protects every private object, plus the offline phrase and service-stored capsule that can restore an Account's own Vault without ever exposing a key to the service.

**Blocked by:** 03 (`mdwn/enc-v1` envelope library).

**Status:** ready-for-agent

- [ ] One Vault root key per Account for its owned content; each Directory has an independently random Directory capability key; a parent Directory capability wraps each child Directory capability.
- [ ] Every persisted current File representation has a fresh, independently random File content key that encrypts the Markdown and File metadata and is wrapped by the containing Directory capability.
- [ ] A 256-bit Vault recovery secret is browser-generated and represented as a checksum-protected 24-word phrase; it is never user-chosen, sent to the service, logged, or used as a password.
- [ ] The browser derives a 256-bit recovery wrapping key with `HKDF-SHA-256` from that secret, a random public recovery salt, and the domain-separated `mdwn/vault-recovery-capsule/v1` context containing the Account ID and recovery generation.
- [ ] A versioned AES-256-GCM `mdwn/enc-v1` Recovery capsule contains the stable Vault root key and a dedicated P-256 recovery-enrollment signing private key; the service side stores only opaque ciphertext/metadata, current generation and salt, and the matching public recovery-verification key.
- [ ] Key envelope purposes exist and are tested for at least `vault-recovery` (Account-owned roots and needed owned-File/Comment auxiliary capabilities) and `device-enrollment`, with an explicit rule that a capability received only through a Grant is excluded from the Vault-recovery envelope.
- [ ] Phrase and capsule validation rejects the wrong phrase, wrong generation, wrong salt, a tampered capsule, and a superseded generation; reissue produces a new generation that supersedes the prior one.
- [ ] Cross-engine vectors cover capsule seal/open, phrase round-trip, and tamper rejection in Chromium, Firefox, WebKit, and the Worker test target.
