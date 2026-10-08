# 43: Architecture deepening specification

Status: ready-for-agent
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

The approved spec was decomposed into tickets 44–50 in `8291f0d`. Tickets 44–46 have merged; ticket 47 is implemented, reviewed and locally verified on its issue branch (`ec3590a`), with current-head CI and merge still pending. Tickets 48–50 remain open (48 depends on 47; 50 depends on 49; 49 is independently unblocked). This remains the parent specification, not a single combined implementation ticket; parent completion awaits the remaining children.

## Comments

- 2026-10-06: Published after the architecture exploration and five interview rounds. The maintainer confirmed the final shared understanding and requested the spec. Reference application snapshot: `a827ab93596e58b7c140bd19b936cca4630d2a0b`. The confirmed reasoning and pinned source evidence remain in the [design record](../architecture-deepening-design.md). Documentation checks are required for this publication; application test results must be produced during implementation, not inferred from design inspection.
- 2026-10-08: Replaced the obsolete undecomposed/unimplemented next-step text with actual child-ticket delivery state. Publication lifecycle/panel changes and the Import execution extraction are merged (`bf1588d`, `58a3982`, `42de770`); the parent is not complete while the remaining corrections and Comment-dependent deletion work are open.
