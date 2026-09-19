# 19: Key rotation on revoke, leave, permission change, and move out of a shared subtree

**What to build:** Revoking access, leaving a Share, changing a Grant's permission, or moving content out of a shared subtree immediately removes server authorization and makes the new state cryptographically true for future writes, through a resumable browser-driven rotation that never overpromises recall.

**Blocked by:** 16 (Move, reorder, delete, and bounded Directory hard deletion), 18 (Grant capability envelopes and shared-content provisioning).

**Status:** ready-for-agent

- [ ] Revocation of a Grant, a leave, a permission change, or a shared-subtree revocation first removes server authorization in a short transaction, advances the affected capability/key epoch, and blocks new writes beneath the affected root.
- [ ] It then creates a browser-driven, resumable, bounded Key-rotation job that rewraps current capabilities only for the remaining authorized devices.
- [ ] The `crypto_jobs` record holds only opaque job identity, bounded cursor/progress, initiating/authorized Account, target/epoch, and lifecycle state — no plaintext key or content.
- [ ] Rotation cannot recall previously downloaded plaintext, ciphertext, or keys, and the UI communicates that limit rather than implying deletion.
- [ ] Routine Encryption-device removal (ticket 13) is deliberately narrower and does not rotate Vault, Directory/File, Grant, or representation keys.
- [ ] A move out of a shared subtree completes its required rekeying within the bounded operation or is rejected/deferred; it may never leave future writes under an old capability.
- [ ] The job is idempotent and resumable from an enrolled device after interruption, with observable progress and no duplicate rewrapping.
- [ ] Tests prove server access is denied before rotation finishes, new writes under the affected root are blocked until it is safe, remaining authorized devices keep or regain current access after a proof refresh, no old-epoch envelope remains current, and an interrupted job resumes.
