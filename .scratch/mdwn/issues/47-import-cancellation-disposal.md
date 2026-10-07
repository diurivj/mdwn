# 47: Stop Import stages and retries after cancellation or disposal

**What to build:** Cancellation or route disposal gives an Import attempt one coherent lifetime: no later stage or retry is scheduled, late UI results are ignored, and best-effort cleanup is attempted without masking the original result. Cancellation during preparation must prevent later staging — today a browser calculation can finish and start an Import the person stopped — and route disposal currently has no cleanup at all. Regression evidence comes first: a failing test for each corrected behavior, then the fix.

**Type:** bug

**Status:** ready-for-agent

**Blocked by:** 46 (Import session module owns confirmed-review execution) — the attempt lifetime lives in that module.

**Related:** [43: Architecture deepening specification](43-architecture-deepening-spec.md); `docs/architecture-deepening.md` (Import implementation decisions 6–7 and 11, Import acceptance evidence); `.scratch/mdwn/architecture-deepening-design.md` (Import protocol facts, Q11). The spec requires regression evidence before changing this behavior.

- [ ] Regression tests reproduce the current gaps first: cancellation during preparation, and route disposal during preparation, upload and commit, each showing that a later stage runs or late results land today.
- [ ] After the correction, cancellation or disposal during preparation, opening, upload or commit schedules no subsequent stage or retry attempt. An in-flight browser calculation may finish and be discarded without starting an Import.
- [ ] Late progress, success and refresh callbacks from a disposed or superseded attempt cannot reach a new view.
- [ ] Cleanup is best effort: it never deletes committed Files to simulate cancellation and never claims guaranteed staging deletion after a network failure.
- [ ] Cleanup failure cannot mask the original outcome or become a false cancellation acknowledgment.
- [ ] Focused deterministic tests cover abort during preparation, upload and commit, and disposal before commit. Real-browser regression evidence is added where the behavior is user-visible.
- [ ] Existing Import Worker, browser and preflight tests remain green. No new endpoint, schema, wire format, persistent attempt storage or cross-navigation/resumable Import behavior is introduced.
- [ ] Before/after evidence shows the corrected lifetime at the module interface.
- [ ] `npm run verify` passes; the change lands on its issue branch with a PR and current-head `CI` green before merge, with Standards/Spec review and a separate RR8/stack result on the same pinned diff.

## Scope and pointers

- The Import execution module from ticket 46 and its React adapter.
- A browser abort is not proof of domain cancellation: the distinction between successful cancellation before commit and an existing Import commit marker is the domain meaning recorded in `CONTEXT.md`.
- Preserve bounded retry behavior; do not expand it into polling or fresh sessions.

## Comments

- 2026-10-06: Published from the approved spec (43). One of the two narrowly approved Import correctness corrections, each requiring regression evidence before the behavior changes.
