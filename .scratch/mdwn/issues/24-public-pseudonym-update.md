# 24: Public pseudonym update job

**What to build:** A person changes the Public pseudonym shown on their Comments and optional Publication attribution in one exclusive, resumable operation that either commits everywhere at once or leaves the old name in place everywhere.

**Blocked by:** 21 (Private Comment threads), 22 (Publish a File).

**Status:** ready-for-agent

- [ ] Every Account has one generated, non-identifying Public pseudonym used in all Comments and optional Publication attribution; it is distinct from the share identifier/handle and from authentication identity.
- [ ] The pseudonym may be changed at most once every 30 days, and the UI states the cooldown.
- [ ] A change runs as an exclusive browser-driven Pseudonym-update job across all encrypted attribution contexts; normal work is blocked while the UI shows progress.
- [ ] All contexts retain the old pseudonym until every update succeeds, and the new encrypted Account profile becomes current atomically — never a mixed committed attribution state.
- [ ] The job is resumable: an enrolled device can continue an interrupted update without producing a partial rename.
- [ ] The UI is honest that cached copies and screenshots cannot be changed.
- [ ] Tests prove all-old or all-new displayed state, cooldown enforcement, resume after interruption, and that concurrent normal work is blocked during the job.

## Comments

- 2026-09-21: Dependency note from ticket 03: attribution envelopes use the `attribution` purpose in `app/crypto/enc-v1` (`docs/enc-v1.md`). The batch is resumable, so an interrupted run reuses stored bytes or re-seals with a fresh writer; nonce state is never persisted or restored.
