# 47: Stop Import stages and retries after cancellation or disposal

**What to build:** Cancellation or route disposal gives an Import attempt one coherent lifetime: no later stage or retry is scheduled, late UI results are ignored, and best-effort cleanup is attempted without masking the original result. Cancellation during preparation must prevent later staging — today a browser calculation can finish and start an Import the person stopped — and route disposal currently has no cleanup at all. Regression evidence comes first: a failing test for each corrected behavior, then the fix.

**Type:** bug

**Status:** in-progress

**Blocked by:** None — 46 is completed; its Import execution module owns the attempt lifetime.

**Related:** [43: Architecture deepening specification](43-architecture-deepening-spec.md); `docs/architecture-deepening.md` (Import implementation decisions 6–7 and 11, Import acceptance evidence); `.scratch/mdwn/architecture-deepening-design.md` (Import protocol facts, Q11). The spec requires regression evidence before changing this behavior.

- [x] Regression tests reproduce the current gaps first: cancellation during preparation, and route disposal during preparation, upload and commit, each showing that a later stage runs or late results land today.
- [x] After the correction, cancellation or disposal during preparation, opening, upload or commit schedules no subsequent stage or retry attempt. An in-flight browser calculation may finish and be discarded without starting an Import.
- [x] Late progress, success and refresh callbacks from a disposed or superseded attempt cannot reach a new view.
- [x] Cleanup is best effort: it never deletes committed Files to simulate cancellation and never claims guaranteed staging deletion after a network failure.
- [x] Cleanup failure cannot mask the original outcome or become a false cancellation acknowledgment.
- [x] Focused deterministic tests cover abort during preparation, upload and commit, and disposal before commit. Real-browser regression evidence is added where the behavior is user-visible.
- [x] Existing Import Worker, browser and preflight tests remain green. No new endpoint, schema, wire format, persistent attempt storage or cross-navigation/resumable Import behavior is introduced.
- [x] Before/after evidence shows the corrected lifetime at the module interface.
- [ ] `npm run verify` passes; the change lands on its issue branch with a PR and current-head `CI` green before merge, with Standards/Spec review and a separate RR8/stack result on the same pinned diff.

## Scope and pointers

- The Import execution module from ticket 46 and its React adapter.
- A browser abort is not proof of domain cancellation: the distinction between successful cancellation before commit and an existing Import commit marker is the domain meaning recorded in `CONTEXT.md`.
- Preserve bounded retry behavior; do not expand it into polling or fresh sessions.

## Comments

- 2026-10-06: Published from the approved spec (43). One of the two narrowly approved Import correctness corrections, each requiring regression evidence before the behavior changes.
- 2026-10-08: Implementation on `issue/47-import-cancellation-disposal`, based on `c28d191`. Regression evidence preceded each correction: cancellation during replacement reads, signer acquisition and encrypted planning incorrectly returned `committed`; upload/commit cancellation made a second transport attempt; late open/upload acknowledgments advanced to commit; an abort during failed cleanup replaced the original `staging-changed` rejection with `cancelled`. Real Chromium regressions reproduced route-disposed preparation starting a new session, un-aborted opening/upload, a late real commit acknowledgment refreshing the new route, and the missing Cancel Import command during encrypted preparation. Logs are local `/tmp/mdwn-47-*-red-*.log` artifacts, not committed credentials or application data.
- 2026-10-08: `ImportExecution` now checks cancellation before/after preparation and staging boundaries, and before any bounded retry. The React adapter invalidates the attempt before route-disposal cancellation, cancels a superseded execution and guards progress/outcome delivery by attempt identity. Before/after at the module seam: held preparation resumes into `cancelled` with zero open/upload calls instead of `committed`; an aborted upload/commit has one request instead of two; a late open/upload acknowledgment triggers only best-effort cleanup, never another chunk or commit. Genuine commit acknowledgments remain successful, without deleting committed Files; uncertainty classification is still ticket 48.
- 2026-10-08: Focused evidence: 20 execution-module tests; 63 retained execution/source/review/plan/codec tests; 12 real-Workers staging/shared-target tests; 32 passing browser lifetime/preflight cases across Chromium, Firefox and WebKit (one existing synthetic WebKit drop skip). Browser cases include preparation cancellation, disposal at all four stages, late committed acknowledgment with no stale refresh, and a superseded attempt unable to clear newer success. Typecheck and Biome pass. Standards/Spec review, separate RR8/stack gate, full clean-tree `npm run verify`, and PR/CI/merge evidence are still pending; the final acceptance checkbox intentionally remains open.
