# 35: Hotfix: prevent stale paste caret placement from overriding newer editing

**What to build:** Fix the editor's delayed paste caret placement so an earlier paste cannot overwrite a newer selection or interfere with a subsequent replacement. Preserve the existing whole-edit File source limit behavior and make its browser regression test reliable.

**Type:** bug

**Priority:** hotfix — address next in a separate small issue branch/PR, not as additional Grant-provisioning work.

**Status:** ready-for-agent

**Blocked by:** None; the editor and browser harness already exist.

**Related:** [15: Editor and preview workspace](15-editor-and-preview-workspace.md) (completed). Discovered during verification of [18: Grant envelopes and provisioning needs](18-grant-envelopes-and-provisioning-needs.md), but reproduced on its starting commit `b8617900926addbaab8c86ed178a8709b2438286` without ticket 18 changes. Do not reopen ticket 15 or fold this fix into ticket 18.

## Diagnosis

`app/tree/FileEditor.tsx` schedules an unconditional `requestAnimationFrame` after an accepted paste to call `textarea.setSelectionRange(...)`. That callback can run after a subsequent select-all operation but before the replacement input arrives, restoring the previous paste's caret instead of respecting the newer selection.

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

- [ ] An accepted paste leaves the caret immediately after the inserted text, but its caret placement cannot supersede a subsequent selection or input. Handle DOM/state commit ordering without an unconditional stale animation-frame callback.
- [ ] Pending caret work cannot act after the editor's relevant lifetime ends. Preserve composition behavior, read-only/structural editing guards, and tab-local drafts.
- [ ] Add a deterministic regression at the real Files editor/browser seam (`e2e/workspace-fixture.ts`): exercise the ordering between the first paste, a newer select-all/replacement, and stale caret work. The test must fail against the current implementation and pass after the fix; do not rely solely on repeated runs to happen upon the race or introduce production test endpoints.
- [ ] Harden the existing limit test so it explicitly verifies the intended large replacement before saving and testing overflow. Synchronize on meaningful editor state when necessary, not arbitrary sleeps. Keep its whole-paste/whole-composition rejection, valid-draft preservation, and zero additional save-attempt assertions.
- [ ] Preserve the 262,144-byte UTF-8 source limit, multi-byte accounting, normal paste selection replacement, and autosave/conflict/lease behavior. Do not relax assertions, disable the case, increase retries/timeouts to conceal failures, or treat a green retry as the fix.
- [ ] Run focused editor tests across Chromium, Firefox, and WebKit without retries, typecheck, and the full suite once at the end. Complete Standards/Spec review and the separate RR8/stack post-review gate before committing/pushing the hotfix PR.

## Reproduction and implementation pointers

Build once, then run the existing narrow reproduction (intermittent; repetitions improve the signal):

```sh
npm run build
npx playwright test e2e/editor-workspace.spec.ts \
  -g 'rejects paste and an entire composition result' \
  --project=chromium --workers=1 --retries=0 --repeat-each=10
```

- `app/tree/FileEditor.tsx`: accepted-paste caret scheduling and controlled textarea.
- `app/tree/useFileDraft.ts`: existing draft/composition contract; avoid unrelated changes.
- `e2e/editor-workspace.spec.ts`: existing paste/composition limit case and adjacent editor regressions.
- `docs/testing.md`: real browser/Worker fixture and cross-engine test requirements.

No database migration, cryptographic protocol change, Grant/Comment delivery change, or persisted draft store is in scope. Keep diagnostic output to lengths/selection positions; remove temporary probes and instrumentation before completion.

## Comments

- Maintainer requested a separate hotfix ticket after the race was diagnosed. Ticket 15 remains completed; ticket 18's reviewed implementation remains unchanged. This ticket records the diagnosis only—the editor fix has not been implemented.
