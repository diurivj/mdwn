# 48: Report an unconfirmed Import commit honestly

**What to build:** The Import outcome is classified from evidence. An acknowledged commit is success even when the idempotent response omits the optional listing revision. A lost commit response, or a commit that may have won a cancellation race, is an unconfirmed outcome — not success, not rollback, and not "nothing was imported". On an unconfirmed outcome the target is refreshed through the existing router/UI path while its context is active, and the person is told to inspect the latest Files before deliberately starting another Import. A refreshed Directory is not treated as proof of this attempt's outcome, and no new Import starts automatically.

**Type:** bug

**Status:** ready-for-agent

**Blocked by:** 47 (Stop Import stages and retries after cancellation or disposal) — classifying a commit that may have won a cancellation race needs the attempt lifetime that ticket introduces.

**Related:** [43: Architecture deepening specification](43-architecture-deepening-spec.md); `docs/architecture-deepening.md` (Import implementation decisions 8–11, Import acceptance evidence, outcome-evidence table); `.scratch/mdwn/architecture-deepening-design.md` (Import protocol facts, Q10). The spec requires regression evidence before changing this behavior.

- [ ] A regression test reproduces the current misclassification first: an aborted or lost commit is reported as though nothing was imported.
- [ ] An acknowledged commit succeeds even when the idempotent response omits `entriesRevision`, and revalidates the active context.
- [ ] A lost commit acknowledgment, or cancellation racing an in-flight commit, exposes an unconfirmed outcome that states the Import may have committed. It never claims success, rollback or non-commit.
- [ ] The unconfirmed path refreshes the target through the existing revalidation path and gives check-before-retry guidance. It starts no new Import, opens no new session, and adds no status endpoint, schema or wire format.
- [ ] Commit is never used as a read-only status probe.
- [ ] Explicit conflict, expiry and authority rejections still require the existing fresh review; no automatic collision repair or subset Import follows a failure.
- [ ] Cleanup failure never masks the primary outcome.
- [ ] Focused deterministic tests cover acknowledged-without-revision, lost commit response, and a commit winning a cancellation race. Real-browser evidence covers the user-visible uncertain-outcome presentation where feasible.
- [ ] Existing Worker proofs (pre-commit invisibility, exact-byte idempotency, mismatched replay failure, cleanup) and browser Import flows remain green.
- [ ] Before/after evidence shows the evidence-based outcome classification at the module interface.
- [ ] `npm run verify` passes; the change lands on its issue branch with a PR and current-head `CI` green before merge, with Standards/Spec review and a separate RR8/stack result on the same pinned diff.

## Scope and pointers

- The Import execution module from ticket 46 and its React adapter.
- The unconfirmed outcome is a presentation of uncertainty, not a new domain state: no persistent recovery mechanism, no new endpoint and no automatic retry are authorized.
- Preserve the existing Import bounds, shared-target ownership and paired Public representation updates.

## Comments

- 2026-10-06: Published from the approved spec (43). The second of the two narrowly approved Import correctness corrections. Blocked by 47 for the cancellation-race classification; the `entriesRevision` success case is otherwise independent.
