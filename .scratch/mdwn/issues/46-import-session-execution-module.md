# 46: Import session module owns confirmed-review execution

**What to build:** A browser module owns execution from the confirmed Import review through replacement reads, signing, complete encrypted plan preparation, session opening, chunk upload, commit and cleanup. The Import control keeps selection, target choice and collision controls and becomes an adapter that reports progress and outcomes; it no longer assembles the staging sequence. Behavior is preserved: invalid preparation opens no session and uploads nothing; retries stay bounded and reuse exact prepared bytes and the Import identity; the browser retains the known Import ID before the open response arrives; explicit conflict/expiry/authority rejections keep their fresh-review behavior.

**Type:** refactor

**Status:** ready-for-agent

**Blocked by:** None (can start immediately).

**Related:** [43: Architecture deepening specification](43-architecture-deepening-spec.md); `docs/architecture-deepening.md` (Import implementation decisions 1–13, Import acceptance evidence); `.scratch/mdwn/architecture-deepening-design.md` (Q8, Import protocol facts). This is the second of the spec's three separately reviewed changes.

- [ ] One module owns the confirmed-review execution path and the attempt's abort/lifetime; callers provide the confirmed review, not staging steps.
- [ ] Preparation completes replacement reads, signing, validation and complete encryption planning before any session opens. Invalid or nonconforming preparation opens no session, uploads nothing, and never imports a valid subset or rebuilds a different plan.
- [ ] The browser-known Import ID is retained before the open acknowledgment. A lost acknowledgment leads to best-effort cleanup using that ID and never an automatic open retry; expiry cleanup remains the fallback.
- [ ] Chunk retries reuse identical prepared bytes and the same Import identity. Retry stays at the existing single automatic retry at eligible failure points while the attempt is active — no indefinite polling, fresh encryption, new sessions or silent conflict repair.
- [ ] An acknowledged commit refreshes the active view through its existing revalidation path. Explicit stale-target, Grant, Owner, expiry and revision responses keep their existing fresh-review behavior.
- [ ] Staging and Replace visibility remain all-or-nothing, and target-Owner assignment, Historical Comment and paired Publication behavior are unchanged.
- [ ] Deterministic tests cross the module interface with controlled outcomes at one internal operations seam: preparation rejection, lost open acknowledgment with cleanup, exact-byte chunk retry, and cleanup ordering. The tests exercise production orchestration, not a separate test-only open/upload/commit sequence.
- [ ] Existing source/review/plan/codec Node tests, Worker staging tests (pre-commit invisibility, retry identity, target owner, atomic Replace/Publication pairing, Historical Comments, expiry) and browser preflight flows are retained and pass.
- [ ] Before/after evidence shows the Import control no longer names staging stages.
- [ ] `npm run verify` passes; the change lands on its issue branch with a PR and current-head `CI` green before merge, with Standards/Spec review and a separate RR8/stack result on the same pinned diff.

## Scope and pointers

- The Import control under `app/import/`; the execution module belongs in `app/shared/import/` beside the existing shared planning, source, review and staging modules, which the Node test target already compiles (`docs/testing.md`).
- Keep the substantive source, review, planning and cryptographic implementations; do not flatten them into orchestration or move selection/collision choices out of the UI.
- No new endpoint, schema, wire format or background/resumable Import feature.
- Exact exported names and file allocation fit the agreed seams without reopening scope.

## Comments

- 2026-10-06: Published from the approved spec (43). Behavior-preserving extraction; the agreed Import correctness corrections are tickets 47 and 48, which depend on this module.
