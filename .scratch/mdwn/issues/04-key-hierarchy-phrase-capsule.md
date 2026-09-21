# 04: Vault key hierarchy, Vault recovery secret, and Recovery capsule

**What to build:** The browser-side key hierarchy that protects every private object, plus the offline phrase and service-stored capsule that can restore an Account's own Vault without ever exposing a key to the service.

**Blocked by:** 03 (`mdwn/enc-v1` envelope library).

**Status:** ready-for-agent

- [x] One Vault root key per Account for its owned content; each Directory has an independently random Directory capability key; a parent Directory capability wraps each child Directory capability.
- [x] Every persisted current File representation has a fresh, independently random File content key that encrypts the Markdown and File metadata and is wrapped by the containing Directory capability.
- [x] A 256-bit Vault recovery secret is browser-generated and represented as a checksum-protected 24-word phrase; it is never user-chosen, sent to the service, logged, or used as a password.
- [x] The browser derives a 256-bit recovery wrapping key with `HKDF-SHA-256` from that secret, a random public recovery salt, and the domain-separated `mdwn/vault-recovery-capsule/v1` context containing the Account ID and recovery generation.
- [x] A versioned AES-256-GCM `mdwn/enc-v1` Recovery capsule contains the stable Vault root key and a dedicated P-256 recovery-enrollment signing private key; the service side stores only opaque ciphertext/metadata, current generation and salt, and the matching public recovery-verification key.
- [x] Key envelope purposes exist and are tested for at least `vault-recovery` (Account-owned roots and needed owned-File/Comment auxiliary capabilities) and `device-enrollment`, with an explicit rule that a capability received only through a Grant is excluded from the Vault-recovery envelope.
- [x] Phrase and capsule validation rejects the wrong phrase, wrong generation, wrong salt, a tampered capsule, and a superseded generation; reissue produces a new generation that supersedes the prior one.
- [x] Cross-engine vectors cover capsule seal/open, phrase round-trip, and tamper rejection in Chromium, Firefox, WebKit, and the Worker test target.

Implementation note (review follow-up complete): browser-side primitives live in
`app/crypto/vault.ts`; capsule HKDF labels extend `app/crypto/enc-v1` without
changing its default writer contract. The shared recovery checks run in Node,
workerd, Chromium, Firefox, and WebKit, and a fixed independently assembled
capsule is consumed by the production recovery open path in every target.

## Comments

- Implementation review of `0da09b0`: the standards axis found no documented-rule violations and one optional duplicated-byte-helper cleanup. The spec axis confirmed that `independentRecoveryVector` tests raw WebCrypto in isolation, while application capsule coverage is only a same-implementation round trip. Add a fixed independently produced capsule consumed by the production open path, or independently open a production capsule, so a wrong production HKDF label/context or framing fails the cross-engine contract.
- Validation recorded: typecheck and build passed; Node 40 tests and Worker 12 tests passed; `npx playwright test e2e/enc-v1.spec.ts --reporter=line --workers=1` passed 36 tests. This browser command omitted the nine foundation tests in `e2e/cross-engine.spec.ts`; the unfiltered full suite remains required after the vector fix. Orchestration stopped under the maintainer's stop-on-issues instruction before PR publication or ticket 05.

- 2026-09-21: Added a fixed, independently encoded `mdwn/enc-v1` recovery capsule with a P-256 signing key; the shared case opens it through `openRecoveryCapsule` and retains the existing tamper and superseded-generation checks. Label and context mutation checks fail the independent case as expected; final unfiltered validation is recorded below after completion.

- 2026-09-21 final validation: `npm run typecheck` passed; unfiltered `npm run test:all` passed with Node 5 files/40 tests, Worker 2 files/12 tests, and all 45 Chromium/Firefox/WebKit browser tests. `npm run db:smoke` passed against a fresh local D1 and `npm run check:secrets` found no candidate secrets in 10 client bundle files.

- 2026-09-21: Dependency note from ticket 03: use `app/crypto/enc-v1` (`docs/enc-v1.md`) for the `vault-recovery` and `device-enrollment` Key envelopes and for the `recovery-capsule` envelope. This ticket must extend the module with an explicit HKDF label: `createSymmetricWriter` currently fixes the `info` label to `mdwn/enc-v1/aes-256-gcm`, so the `mdwn/vault-recovery-capsule/v1` derivation needs its own label parameter (or a capsule entry point) rather than passing the capsule key as `baseKey`.
