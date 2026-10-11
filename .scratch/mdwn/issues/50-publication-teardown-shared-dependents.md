# 50: Publication teardown uses the shared Comment-dependent module

**What to build:** The Publication scope of the shared module (one Publication's Public thread only) replaces the inline Comment-dependent graph in Unpublishing teardown, for both the bounded Comment batches and the final completion transaction. The File's Private comment thread is never selected. Sealing, Owner-only resumption, the 200-Comment batch limit, final completion after zero remaining Comments, and the existing scheduling remain with the Publication caller.

**Type:** refactor

**Status:** ready-for-agent

**Blocked by:** None — 49 is delivered on `main` by PR #56 (merge `58f8842`). This ticket adds the Publication scope to that module and rewires the second caller.

**Related:** [43: Architecture deepening specification](43-architecture-deepening-spec.md); `docs/architecture-deepening.md` (Comment-dependent Hard deletion implementation decisions 4–8, Hard deletion acceptance evidence); `.scratch/mdwn/architecture-deepening-design.md` (Q9, Q12).

- [ ] The teardown caller expresses Publication scope. The module selects only that Publication's Public thread and can never remove the File's Private comment thread.
- [ ] Batched Comment removal and the final dependent-removal transaction use the module's ordered, marker-guarded statements. The caller keeps its anchor update, batch limit, scheduling and completion computation.
- [ ] `import_comment_meta` is not added to Publication scope: imported Historical Comments live in Private threads, so the File-scope-only asymmetry is preserved.
- [ ] An interrupted teardown stays sealed, remains Owner-resumable, keeps earlier committed batches deleted, and removes all public material on final completion without reviving access. Finishing requires the protocol's final completion, not merely zero remaining Comments.
- [ ] A failed guard or late dependent failure leaves the attempted batch unchanged; restrictive foreign keys and explicit removal ordering are preserved.
- [ ] Unrelated Files, threads and surviving access paths remain unchanged.
- [ ] Tests prefer the existing authorized Worker routes, supplemented by real-D1 module integration for the final-completion invariant. The existing sealed/interrupted teardown and publication-lifecycle suites are retained and pass.
- [ ] Before/after evidence shows the teardown caller lost Comment-dependent graph knowledge.
- [ ] `npm run verify` passes; the change lands on its issue branch with a PR and current-head `CI` green before merge, with Standards/Spec review and a separate RR8/stack result on the same pinned diff.

## Scope and pointers

- The Publication teardown owner under `app/publications/`; the shared module from ticket 49.
- Share graph knowledge, not a scheduler: the atomic File/Directory context and the sealed bounded-batch Unpublishing context remain distinct.
- Do not change the 200-Comment batch limit, the Owner-only resumption rule or the final completion step.
- Exact exported names and file allocation fit the agreed seams without reopening scope.

## Comments

- 2026-10-06: Published from the approved spec (43). Second and final slice of the Comment-dependent Hard deletion change; completes the shared module's Publication scope.
