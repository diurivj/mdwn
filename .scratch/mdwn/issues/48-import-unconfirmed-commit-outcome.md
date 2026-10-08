# 48: Report an unconfirmed Import commit honestly

**What to build:** The Import outcome is classified from evidence. An acknowledged commit is success even when the idempotent response omits the optional listing revision. A lost commit response, or a commit that may have won a cancellation race, is an unconfirmed outcome — not success, not rollback, and not "nothing was imported". On an unconfirmed outcome the target is refreshed through the existing router/UI path while its context is active, and the person is told to inspect the latest Files before deliberately starting another Import. A refreshed Directory is not treated as proof of this attempt's outcome, and no new Import starts automatically.

**Type:** bug

**Status:** in-progress

**Implementation:** implemented; Standards/Spec review, RR8/stack gate and full local verification pending.

**Blocked by:** None — 47's attempt lifetime is delivered on `main` by PR #54 (`8a9d633`).

**Related:** [43: Architecture deepening specification](43-architecture-deepening-spec.md); `docs/architecture-deepening.md` (Import implementation decisions 8–11, Import acceptance evidence, outcome-evidence table); `.scratch/mdwn/architecture-deepening-design.md` (Import protocol facts, Q10). The spec requires regression evidence before changing this behavior.

- [x] A regression test reproduces the current misclassification first: an aborted or lost commit is reported as though nothing was imported.
- [x] An acknowledged commit succeeds even when the idempotent response omits `entriesRevision`, and revalidates the active context.
- [x] A lost commit acknowledgment, or cancellation racing an in-flight commit, exposes an unconfirmed outcome that states the Import may have committed. It never claims success, rollback or non-commit.
- [x] The unconfirmed path refreshes the target through the existing revalidation path and gives check-before-retry guidance. It starts no new Import, opens no new session, and adds no status endpoint, schema or wire format.
- [x] Commit is never used as a read-only status probe.
- [x] Explicit conflict, expiry and authority rejections still require the existing fresh review; no automatic collision repair or subset Import follows a failure.
- [x] Cleanup failure never masks the primary outcome.
- [x] Focused deterministic tests cover acknowledged-without-revision, lost commit response, and a commit winning a cancellation race. Real-browser evidence covers the user-visible uncertain-outcome presentation where feasible.
- [x] Existing Worker proofs (pre-commit invisibility, exact-byte idempotency, mismatched replay failure, cleanup) and browser Import flows remain green.
- [x] Before/after evidence shows the evidence-based outcome classification at the module interface.
- [ ] `npm run verify` passes; the change lands on its issue branch with a PR and current-head `CI` green before merge, with Standards/Spec review and a separate RR8/stack result on the same pinned diff.

## Scope and pointers

- The Import execution module from ticket 46 and its React adapter.
- The unconfirmed outcome is a presentation of uncertainty, not a new domain state: no persistent recovery mechanism, no new endpoint and no automatic retry are authorized.
- Preserve the existing Import bounds, shared-target ownership and paired Public representation updates.

## Comments

- 2026-10-06: Published from the approved spec (43). The second of the two narrowly approved Import correctness corrections. Blocked by 47 for the cancellation-race classification; the `entriesRevision` success case is otherwise independent.
- 2026-10-08: Reconciled the four already-delivered acceptance criteria against ticket 46 (`e85d3d1`/`4a5a428`, merged in PR #53 at `42de770`): acknowledged optional-revision success plus active-view revalidation, no commit-as-status probe, explicit rejection without plan repair, and cleanup preserving the primary failure. Ticket 47 additionally freezes the primary outcome before asynchronous cleanup and guards inactive-view delivery. The core uncertain-outcome presentation, active-target refresh/guidance and its regression evidence remain unimplemented, so this ticket stays open and dependent on 47's delivery.
- 2026-10-08: Implementation on `issue/48-import-unconfirmed-commit-outcome`, based on `8a9d633` (ticket 47 merged in PR #54). Red-before-green evidence at the approved execution seam: two lost commit responses returned `{ status: "failed", error: null }`; an aborted in-flight commit returned `cancelled`; an explicit commit rejection racing cancellation was hidden by `cancelled`; and a rejected retry incorrectly dismissed an earlier unacknowledged commitment. Real Chromium regressions showed “Nothing was uploaded” after a real Worker commit, and malformed/503 acknowledgments incorrectly said the upload stopped before the final step and could be retried safely. Logs are local `/tmp/mdwn-48-*-red.log` artifacts, not committed application data.
- 2026-10-08: Before/after at the module interface: those lost or aborted commit cases now return `{ status: "unconfirmed" }`; an acknowledged commit still returns `committed` without requiring `entriesRevision`; explicit non-ambiguous rejections remain `failed`. Uncertainty from an earlier request survives a rejected retry, failed cleanup and later cancellation. Commit is tracked only when its operation starts, so cancellation just before commit remains `cancelled` without sending it. The React adapter renders the separate may-have-committed/check-before-retry message and requests the existing router refresh, guarded by the unchanged active-attempt identity. Refreshed Files never promote uncertainty to success, and dismissal opens no new session.
- 2026-10-08: Focused evidence: 29 execution tests; 80 retained execution/source/review/plan/codec/target/browser-input Node tests; 12 real-Workers staging/shared-target tests; and 56 passing lifetime/preflight/outcome browser cases across Chromium, Firefox and WebKit (one existing synthetic WebKit-drop skip, no retries). All three engines cover lost/malformed/503 acknowledgments, real commit winning cancellation with lost or genuine acknowledgment, optional-revision idempotent success, explicit real-Worker authority rejection, and disposed-view uncertainty without a stale refresh. Biome and typecheck pass. No Worker mutation, schema, bound, wire format, status endpoint or persistent recovery mechanism changed; the disposable remote proof is not retriggered by this browser-only correction. Standards/Spec review, separate RR8/stack and full clean-tree `npm run verify` remain pending.
