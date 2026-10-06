# 24: Public pseudonym update job

**What to build:** A person changes the Public pseudonym shown on their Comments and optional Publication attribution in one exclusive, resumable operation that either commits everywhere at once or leaves the old name in place everywhere.

**Blocked by:** 21 (Private Comment threads), 22 (Publish a File).

**Status:** done

- [x] Every Account has one generated, non-identifying Public pseudonym used in all Comments and optional Publication attribution; it is distinct from the share identifier/handle and from authentication identity.
- [x] The pseudonym may be changed at most once every 30 days, and the UI states the cooldown.
- [x] A change runs as an exclusive browser-driven Pseudonym-update job across all encrypted attribution contexts; normal work is blocked while the UI shows progress.
- [x] All contexts retain the old pseudonym until every update succeeds, and the new encrypted Account profile becomes current atomically — never a mixed committed attribution state.
- [x] The job is resumable: an enrolled device can continue an interrupted update without producing a partial rename.
- [x] The UI is honest that cached copies and screenshots cannot be changed.
- [x] Tests prove all-old or all-new displayed state, cooldown enforcement, resume after interruption, and that concurrent normal work is blocked during the job.

## Comments

- 2026-09-21: Dependency note from ticket 03: attribution envelopes use the `attribution` purpose in `app/crypto/enc-v1` (`docs/enc-v1.md`). The batch is resumable, so an interrupted run reuses stored bytes or re-seals with a fresh writer; nonce state is never persisted or restored.
- 2026-10-04: Implemented on `issue/24-public-pseudonym-update`. Migration `0022_giant_rafael_vega.sql` adds the `pseudonym_update` `crypto_jobs` kind (one pending job per Account via a partial unique index), the `pseudonym_update_profiles`/`pseudonym_update_items` staging tables with kind-guard triggers, and `account_profiles.pseudonym_changed_at`. The job pins the current profile revision and cooldown at start, pages up to 20 contexts with the Owner `vault-recovery` envelope or the device's signed Grant envelope, and commits the profile swap plus every staged thread attribution and Publication declaration in one D1 transaction; `next` re-reports a context whose revision or capability epoch moved, and commit refuses while any required context is unstaged. Required contexts are the attribution rows the Account can still open; a row whose last File-read path is gone is the reach limit disclosed in the UI, not a silent partial commit. New Comments and declarations are refused with `409 pseudonym_update_pending` only for the changing Account, and the Comments composers and Publish panel name the pending update. `/account/pseudonym` states the 30-day cooldown, shows resumable progress, and discloses that cached copies, screenshots, and unreachable contexts keep the old label. Protocol and bounds are in `docs/pseudonym-update.md`.
- 2026-10-04: Pinned review `0537760` (Standards + Spec, parallel sub-agents): Standards found no documented-standard violations; Spec flagged the inaccessible-context reach limit, the scoping of blocked work, a generic composer error, an unguarded commit dependent, and missing cross-device resume coverage. Corrected on `0178b57`/`69ea5a0`: both boundaries are explicit in `docs/pseudonym-update.md` and the UI; Comments and Publish surfaces name the pending update; commit dependents guard revision drift; and a second enrolled device with its own Grant envelope finishes an interrupted job. Re-reviews confirmed the fixes and no new gaps; the two disclosed boundaries remain the only divergence from the literal "all contexts / all normal work" wording.
- 2026-10-04: RR8/stack post-review gate on `69ea5a0` returned **Findings** (four internal reads missing the same-statement live Session/device/epoch guard; no SSR shell-boundary test for the new page). Fixed on `be344bd` and the gate re-run returned **Pass** on the same pinned diff.
- 2026-10-04: Verification: `npm run typecheck`; 131 Node and 320 Worker/D1 tests, including the new `tests/worker/pseudonym-update.test.ts` (all-old/all-new across owned, public-epoch and Publication-declaration contexts; cooldown; same-device and second-device resume; blocked-work scoping; malformed/stale staging; idempotent start; cancel) and `tests/worker/pseudonym-shell.test.ts`; production build; fresh and idempotent local migration smoke; bundle-secret and namespace checks; 324 Playwright scenarios across Chromium (108), Firefox (108) and WebKit (108), including `e2e/pseudonym-update.spec.ts`.

- 2026-10-06: Status reconciled to **done**: the work merged on main via PR #33 (merge `ebc610a`), and the completion evidence is recorded in the comments above. This reconciliation changed only the stale `Status:` line.
