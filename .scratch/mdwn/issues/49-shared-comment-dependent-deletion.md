# 49: Shared Comment-dependent module for File and Directory Hard deletion

**What to build:** A Worker-side module owns the applicable Comment-dependent selection and removal ordering for File and bounded-Directory Hard deletion, emitting statements guarded by the caller's existing transaction marker. The tree deletion caller stops enumerating the overlapping Comment-dependent graph; authorization, selected-graph validation, the atomic batch and the broader File/Publication/Share/Grant/Key-rotation lifecycle stay with their current owner. Behavior is unchanged, including the 500-node cap, over-cap refusal without mutation, explicit foreign-key-safe removal, and rollback on a failed guard or late dependent failure.

**Type:** refactor

**Status:** ready-for-agent

**Blocked by:** None (can start immediately).

**Related:** [43: Architecture deepening specification](43-architecture-deepening-spec.md); `docs/architecture-deepening.md` (Comment-dependent Hard deletion implementation decisions, Hard deletion acceptance evidence); `.scratch/mdwn/architecture-deepening-design.md` (Q9, Q12). This is the third of the spec's three separately reviewed changes.

- [ ] The module accepts a domain scope (selected Files), not table lists, caller-authored recipes or audience-selection flags, and produces ordered removal statements guarded by the caller's existing transaction marker.
- [ ] File and Directory deletion remove their relevant Private and Public Comment dependents: reports, Comments, thread attributions, staged Pseudonym update items, retained Comment audience epochs with their applicable Key envelopes, Historical Comment metadata, and Comment-related sharing/Key-rotation staging — in the existing foreign-key-safe order.
- [ ] The tree caller no longer names those Comment-dependent tables or their ordering. Broader File/Publication/Share/Grant lifecycle statements remain with the current owner.
- [ ] The 500-node Directory cap and no-mutation over-cap refusal are unchanged, as is deferral of the cycle-resolving foreign keys for the atomic batch.
- [ ] Unrelated Files, threads, staging and surviving access paths remain unchanged.
- [ ] A failed authorization/transaction guard or an injected late dependent-removal failure leaves the attempted atomic batch unchanged; no partial graph removal and no partially deleted hierarchy.
- [ ] Historical Comment metadata (`import_comment_meta`) stays File-scope-only: imported Historical Comments are always created in a Private thread, so Publication scope must not gain that removal.
- [ ] Tests prefer the existing authorized Worker routes as the highest seam, supplemented by real-D1 module integration tests for atomic storage invariants and failure injection. No mocked SQL and no test-only production routes.
- [ ] Existing hard-deletion completeness, private-tree, Directory-cap and injected late-failure rollback suites are retained and pass, including suspension-independent deletion.
- [ ] Before/after evidence shows the tree deletion caller lost dependent-graph knowledge.
- [ ] `npm run verify` passes; the change lands on its issue branch with a PR and current-head `CI` green before merge, with Standards/Spec review and a separate RR8/stack result on the same pinned diff.

## Scope and pointers

- The tree deletion owner under `app/tree/`; the shared module sits beside the existing Comment and Pseudonym dependent helpers, which it may absorb as implementation details where that improves locality.
- Do not introduce a generic deletion scheduler, generic database cascades, a generic repository or an alternative database adapter. Authorization, transaction execution and scheduling stay with their existing owners.
- The two existing execution contexts stay distinct: atomic File/bounded-Directory deletion here, immediately sealed Unpublishing with bounded Comment batches in ticket 50.
- Exact exported names and file allocation fit the agreed seams without reopening scope.

## Comments

- 2026-10-06: Published from the approved spec (43). This is a locality change, not a claim that current deletion is incomplete; the existing completeness and rollback coverage is substantial.
