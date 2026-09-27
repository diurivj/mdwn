# 13: Encryption-device inventory and removal

**What to build:** A person sees the Encryption devices on their Account — labelled, dated, with coarse last use — and can remove one from a different active device, cutting off only that device's future private access without destroying their own files.

**Blocked by:** 09 (Device proofs and registry epochs), 12 (Routine Encryption-device enrollment).

**Status:** done

- [x] Device inventory stores only opaque ID, public keys, active/revoked state, approval provenance, registry epoch, Vault-root-encrypted optional label, creation time, and coarse last-successful-proof time — no browser/OS data, user agent, network address, or fingerprint.
- [x] The device-management UI displays only the decrypted label, state, creation time, and coarse last-use time.
- [x] Removal must be initiated by a *different* active device with a normal Session, a fresh Passkey assertion, a current Device proof, the expected registry epoch, and explicit destructive confirmation naming the decrypted target label.
- [x] A device cannot remove itself or the last active device; ordinary sign-out or Vault recovery is offered as the appropriate alternative.
- [x] The short removal transaction rechecks all authority and current-state conditions, tombstones the target, revokes every target-bound Session, supersedes every target-device Key envelope, cancels its pending enrollments/challenges, advances the registry epoch, and writes a bounded Security event; the operation is idempotent.
- [x] Removal rotates neither the Vault root, Directory/File capabilities, Grant epochs, nor current representations: a removed device may retain cached plaintext, keys, or ciphertext, but cannot fetch future private material or mutate state, and the UI states that limit.
- [x] Other active devices keep their Sessions but must refresh registry state and prove at the new epoch before their next private operation.
- [x] A concurrent registry change requires a refreshed proof and renewed confirmation rather than silently acting on stale authority.
- [x] Tests reject self-removal and last-device removal, prove only target Sessions and envelopes are cut off, prove other active devices continue after a proof refresh, and prove cached material is the stated (not overstated) limit.

## Comments

- 2026-09-26: The browser decrypts labels and requires the person to type the target label before a fresh Passkey assertion. The Worker receives no plaintext label: the proof-bound confirmation carries only a digest of its ciphertext and the expected registry epoch. Coarse last recorded use advances on successful mutation proofs; read proofs remain write-free under ticket 09, so read-only activity is not claimed as an exact last-use timestamp. An expired retry requires a refreshed proof and renewed confirmation; repeating a completed removal at the new epoch is harmless.
