# 43: Architecture deepening specification

Status: done
Type: spec

**Specification:** [Publication, Import and Comment-dependent Hard deletion](../../../docs/architecture-deepening.md).

## Purpose

Deepen three domain-specific modules so UI callers lose lifecycle protocol knowledge and deletion callers lose overlapping Comment-dependent graph knowledge, while preserving existing privacy, authorization, cryptography, storage and wire contracts.

The maintainer confirmed all twelve design decisions, test seams and consolidated acceptance criteria. The linked document is the canonical spec; this entry publishes it to the local tracker without duplicating it.

## Delivery contract

- Separate reviewed changes: Publication lifecycle first, then Import session orchestration, then Comment-dependent Hard deletion.
- Prioritization does not create artificial blocking dependencies between the candidates.
- Import cancellation/disposal and uncertain-outcome corrections require regression evidence; no new endpoint, schema or background/resumable Import feature.
- Retain real-browser and workerd/D1 evidence alongside focused interface tests.
- Each implementation change requires Standards/Spec review and a separate RR8/stack gate, followed by the repository's local preflight and PR/CI discipline.

## Next step

All seven decomposed children are delivered and merged on `main`: 44 (`bb11122`, `5fa9333`, `17b6920`), 45 (`bf1588d`), 46 (`42de770`), 47 (`8a9d633`), 48 (`815c891`), 49 (`58f8842`) and 50 (`f1147bc`). The three candidates — Publication lifecycle, Import session orchestration, and Comment-dependent Hard deletion — each landed as a separately reviewed change with its own focused evidence, Standards/Spec review, separate RR8/stack gate, clean-tree `npm run verify`, and green current-head `CI` before merge. The parent specification is complete.

[Ticket 51](51-imported-comment-envelope-deletion.md) remains open as a separately filed pre-existing correctness bug that ticket 49 disclosed and deliberately preserved: imported Historical Comment envelopes block File/Directory hard deletion. It is a follow-up to a delivered candidate, not a missing child of this specification.

## Comments

- 2026-10-06: Published after the architecture exploration and five interview rounds. The maintainer confirmed the final shared understanding and requested the spec. Reference application snapshot: `a827ab93596e58b7c140bd19b936cca4630d2a0b`. The confirmed reasoning and pinned source evidence remain in the [design record](../architecture-deepening-design.md). Documentation checks are required for this publication; application test results must be produced during implementation, not inferred from design inspection.
- 2026-10-08: Replaced the obsolete undecomposed/unimplemented next-step text with actual child-ticket delivery state. Publication lifecycle/panel changes and the Import execution extraction are merged (`bf1588d`, `58a3982`, `42de770`); the parent is not complete while the remaining corrections and Comment-dependent deletion work are open.
- 2026-10-11: Status reconciled to **done** after PR #57 (`f1147bc`) merged ticket 50. Tickets 47–50 were recorded as merged or reconciled in `80f3e99` and this update; all seven children (44–50) are delivered. Ticket 51 stays open for the pre-existing imported-envelope deletion bug and does not block this specification's completion.
