# 65: Larger practical Import envelope

**What to build:** Raise the aggregate Import bounds (nodes, expanded bytes, encrypted staging) only as far as evidence supports. 500–1,000 nodes is a target to investigate, not a promise.

**Type:** feature

**Status:** needs-triage

**Blocked by:** [63](63-worker-cpu-ceiling.md), [64](64-import-admission-guard.md), and authorized, targeted capacity evidence if existing measurements are insufficient.

**Related:** [53](53-workers-paid-plan-spec.md); [`docs/workers-paid-plan.md`](../../../docs/workers-paid-plan.md) §3 and "Production-capacity evidence"; [`docs/import.md`](../../../docs/import.md); [ADR-0006](../../../docs/adr/0006-visible-atomic-staged-imports.md).

## Scope

- Keep browser preflight, review, encryption, bounded chunks and visible-atomic commit. Keep the per-File source and representation limits unchanged.
- Before any remote check, state its workload, target (never production), resource ownership and cleanup, footprint and stop condition, and get explicit authorization. Without that, keep the current 100-node, 8 MiB compressed, 16 MiB expanded and 20 MiB staging limits.
- Keep browser validation, Worker validation, persistence constraints, guidance and boundary tests consistent.

## Acceptance criteria

- [ ] The evidence and selected envelope are recorded. Workers tests cover acceptance at the new bound, rejection one over it, and atomic visibility.
- [ ] Existing cancellation, retry, conflict and unconfirmed-commit regressions still pass.

## Comments

- 2026-10-12: Published as an evidence-gated child of 53.
