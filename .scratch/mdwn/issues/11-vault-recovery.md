# 11: Vault recovery and replacement-Encryption-device enrollment

**What to build:** A person with no usable Encryption device restores access to their own Vault on a replacement browser using the 24-word Vault recovery phrase, gets a fresh device-bound Session, and has every prior device and Session cut off — without the phrase or any plaintext key ever reaching the service.

**Blocked by:** 04 (Vault key hierarchy, recovery secret, and capsule), 09 (Device proofs and registry epochs), 10 (Authentication recovery).

**Status:** ready-for-agent

- [x] The ceremony requires both a live normal Session with a recent Passkey assertion and the current Vault recovery phrase. If authentication is also lost, the mandatory sequence is recovery code → restricted recovery Session → replacement Passkey → fresh Passkey assertion → normal Session → Vault recovery phrase.
- [x] A rate-limited recovery-enrollment start creates a short-lived, one-use `recovery_enrollments` record bound to the Account, live Session, current capsule generation, current device-registry revision, and an opaque nonce, and returns the current opaque capsule; phrase entry and validation remain entirely in the browser.
- [x] After opening the capsule locally, the browser creates a fresh P-256 HPKE transport key pair and a separate P-256 device-assertion signing key pair; the capsule's recovery-enrollment key signs an intent bound to the Account, generation, nonce, expected registry revision, exact candidate public keys/device ID, and the digest of the next capsule metadata.
- [x] The service verifies that intent with the stored recovery-verification public key, then sends a one-use HPKE possession challenge to the exact candidate transport key; the browser decrypts it locally and signs it with the candidate device-assertion key. Changing either candidate key makes the intent or the challenge fail.
- [x] The browser creates a new phrase, salt, and recovery-enrollment key pair, then creates the next capsule with the unchanged Vault root key and the new recovery private key; the replacement phrase is displayed only after success.
- [x] One short D1 transaction consumes the enrollment record and verifies the live Session, recent assertion, current generation and registry revision, signed intent, possession proof, exact candidate keys, and next-capsule digest; it activates the exact candidate device, installs its initial Vault-root Key envelope, advances the device-registry epoch, installs the next capsule/verification key/generation, revokes every prior Encryption device, revokes every other Session, creates a fresh normal Session for the recovering browser, and writes a bounded Security event.
- [x] The transaction preserves the Vault root key, Directory capabilities, File content keys, and current representations; the MVP does not re-encrypt the whole Vault. An old device may retain already-cached data but cannot retrieve future ciphertext, envelopes, or mutations.
- [x] After commit, the replacement device traverses Account-owned content from its Vault-root and recovery envelopes; remaining device envelopes are created in bounded, idempotent `crypto_jobs` with the UI showing **Restoring your Files securely…**.
- [ ] Vault recovery never includes a Grant capability or Grant-derived Comment capability: an active Grant missing an envelope records only an opaque provisioning need and shows **Shared content is being securely provisioned** without names, plaintext, or a fragment fallback (fulfilled by ticket 20).
- [x] A crash before commit activates no device; a crash after commit resumes only this non-authorizing provisioning work. A started or failed ceremony shows no new device, and any retry requires a new rate-limited start.
- [x] Tests reject substituted candidate keys, stale capsules/generations, replayed nonces, missing transport/signing private keys, stale Sessions, and missing fresh assertions; prove old devices and Sessions revoke atomically; and distinguish a pre-commit crash from resumable post-commit provisioning.
- [x] There is no recovery proof of work, CAPTCHA, tracking, raw-IP retention, existence-revealing response, service/operator bypass, or factory reset; an Account with neither an active device nor the phrase stays retained and locked.

## Comments

- 2026-09-26: Implemented the phrase-gated replacement-device ceremony, atomic D1 cutover, and resumable owned-envelope provisioning. The Grant-needs criterion remains assigned to ticket 20, which is blocked on the later Grant model and routines.
