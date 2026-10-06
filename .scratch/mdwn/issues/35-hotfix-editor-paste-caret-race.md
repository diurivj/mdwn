# 35: Hotfix: prevent stale paste caret placement from overriding newer editing

**What to build:** Fix the editor's delayed paste caret placement so an earlier paste cannot overwrite a newer selection or interfere with a subsequent replacement. Preserve the existing whole-edit File source limit behavior and make its browser regression test reliable.

**Type:** bug

**Priority:** hotfix — address next in a separate small issue branch/PR, not as additional Grant-provisioning work.

**Status:** done

**Blocked by:** None; the editor and browser harness already exist.

**Related:** [15: Editor and preview workspace](15-editor-and-preview-workspace.md) (completed). Discovered during verification of [18: Grant envelopes and provisioning needs](18-grant-envelopes-and-provisioning-needs.md), but reproduced on its starting commit `b8617900926addbaab8c86ed178a8709b2438286` without ticket 18 changes. Do not reopen ticket 15 or fold this fix into ticket 18.

## Diagnosis

`app/tree/file-editor.tsx` schedules an unconditional `requestAnimationFrame` after an accepted paste to call `textarea.setSelectionRange(...)`. That callback can run after a subsequent select-all operation but before the replacement input arrives, restoring the previous paste's caret instead of respecting the newer selection.

The existing `e2e/editor-workspace.spec.ts` case **rejects paste and an entire composition result without draft loss or another save** exposes this ordering intermittently:

1. Fill `abc`, select `[1, 2]`, and paste `🙂`; the draft becomes `a🙂c`.
2. Immediately replace it using `fill("a".repeat(262_140))`.
3. The late paste callback can change the intended selection `[0, 4]` to `[3, 3]` before input insertion.
4. The input is inserted into the old six-byte draft, producing **262,146 UTF-8 bytes**, not the intended 262,140-byte replacement.
5. The 262,144-byte limit correctly rejects that oversized proposal, retaining `a🙂c`. The original test does not verify the replacement before saving and attempting its next paste; it later reports `a🙂c🙂x` instead of the expected large draft.

The failure therefore does **not** demonstrate broken byte-limit enforcement. It reveals a real caret-ordering race plus an insufficiently checked test setup. The failure also reproduces without saving, the second paste, or composition, so autosave/D1 are not required to trigger it.

Evidence from diagnosis:

- The original Chromium case failed identically in 3/3 no-retry runs on the starting commit. It also passed on its first attempt in PR #22's Linux Chromium CI job; it is included in CI, not skipped.
- A minimized browser probe with input-length/selection instrumentation failed in 3/10 immediate-replacement runs. Each failure recorded selection `[3, 3]` and an actual input size of 262,146 bytes. Waiting for the first paste's caret placement avoided the failure in 10/10 control runs.
- The original overflow/composition assertions, with the caret observably settled and the replacement explicitly verified, passed 15/15 no-retry runs across Chromium, Firefox, and WebKit. This control established the cause; adding a wait alone is not a substitute for fixing the stale callback.

## Acceptance criteria

- [x] An accepted paste leaves the caret immediately after the inserted text, but its caret placement cannot supersede a subsequent selection or input. Handle DOM/state commit ordering without an unconditional stale animation-frame callback.
- [x] Pending caret work cannot act after the editor's relevant lifetime ends. Preserve composition behavior, read-only/structural editing guards, and tab-local drafts.
- [x] Add a deterministic regression at the real Files editor/browser seam (`e2e/workspace-fixture.ts`): exercise the ordering between the first paste, a newer select-all/replacement, and stale caret work. The test must fail against the current implementation and pass after the fix; do not rely solely on repeated runs to happen upon the race or introduce production test endpoints.
- [x] Harden the existing limit test so it explicitly verifies the intended large replacement before saving and testing overflow. Synchronize on meaningful editor state when necessary, not arbitrary sleeps. Keep its whole-paste/whole-composition rejection, valid-draft preservation, and zero additional save-attempt assertions.
- [x] Preserve the 262,144-byte UTF-8 source limit, multi-byte accounting, normal paste selection replacement, and autosave/conflict/lease behavior. Do not relax assertions, disable the case, increase retries/timeouts to conceal failures, or treat a green retry as the fix.
- [x] Run focused editor tests across Chromium, Firefox, and WebKit without retries, typecheck, and the full suite once at the end. Complete Standards/Spec review and the separate RR8/stack post-review gate before committing/pushing the hotfix PR.

## Reproduction and implementation pointers

Build once, then run the existing narrow reproduction (intermittent; repetitions improve the signal):

```sh
npm run build
npx playwright test e2e/editor-workspace.spec.ts \
  -g 'rejects paste and an entire composition result' \
  --project=chromium --workers=1 --retries=0 --repeat-each=10
```

- `app/tree/file-editor.tsx`: accepted-paste caret scheduling and controlled textarea.
- `app/tree/use-file-draft.ts`: existing draft/composition contract; avoid unrelated changes.
- `e2e/editor-workspace.spec.ts`: existing paste/composition limit case and adjacent editor regressions.
- `docs/testing.md`: real browser/Worker fixture and cross-engine test requirements.

No database migration, cryptographic protocol change, Grant/Comment delivery change, or persisted draft store is in scope. Keep diagnostic output to lengths/selection positions; remove temporary probes and instrumentation before completion.

## Comments

- Maintainer requested a separate hotfix ticket after the race was diagnosed. Ticket 15 remains completed; ticket 18's reviewed implementation remains unchanged. This ticket records the diagnosis only—the editor fix has not been implemented.
- 2026-10-04: Implemented the hotfix separately on `issue/35-editor-paste-caret-race` from `main` at `030a84a`, after the same Chromium failure was reported during ticket 22 verification. The report's artifact contained `a🙂c🙂x`; the original case reproduced in 2/10 no-retry runs. The minimized frame-controlled regression failed 3/3 with `[3,3]` instead of the newer `[0,4]` selection, while advancing only the old frame before selecting passed 3/3. A green ticket-22 GitHub CI run therefore did not contradict the local failure.
- 2026-10-04: `FileEditor` now applies the accepted value and caret synchronously inside `onPaste`; it schedules no paste caret callback. The subsequent matching controlled-textarea commit preserves selection (verified against installed React DOM 19.3.0). This also handles unchanged-value pastes without relying on another render and leaves no pending paste work after newer editing or unmount. `useFileDraft`, composition/lease/structural guards and the 262,144-byte source limit are unchanged.
- 2026-10-04: Added real-Worker/browser regressions for newer select-all/replacement, immediate multibyte and unchanged-value paste carets, and late work after navigation unmount. All three failed against the old implementation. The lifetime case holds only cancellation-aware animation frames so real navigation readiness timers remain live, and restores the temporary browser scheduler in `finally`. The original limit case now explicitly verifies the near-limit replacement before saving; whole-paste/composition rejection and zero additional save assertions remain.
- 2026-10-04: Verification passed: typecheck; 94 Node + 237 Worker/D1 tests; production build; migration smoke/idempotency; secret/namespace checks; 126 editor scenarios (three repetitions across all three engines, no retries); and a final full `test:all` run with all 309 browser scenarios passing at the automatic seven-worker local default. No test retries, timeouts or production endpoints were added; temporary diagnostic controls were removed.
- 2026-10-04: Independent **Standards: Pass, 0 findings** and **Spec: Pass, 0 findings**, followed by a separate **RR8/stack: Pass** on the same pinned code scope `030a84a...155c415` (frozen patch SHA256 `c8f5472f89aa14cc82e879d58b4f399012518ed93067aaa4eed92d9cb087f074`). Checked the local accepted-input lifecycle and unchanged browser-only File loader/SSR fallback, encrypted fetcher/clientAction, draft-safe revalidation and proof-guarded Worker save path; no route, Worker, schema, protocol or dependency changes. Ticket 22's PR #29 was not modified.

- 2026-10-06: Status reconciled to **done**: the work merged on main via PR #30 (merge `9d939d3`), and the completion evidence is recorded in the comments above. This reconciliation changed only the stale `Status:` line.
