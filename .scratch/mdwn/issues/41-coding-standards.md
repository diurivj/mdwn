# 41: Write the coding standards through a scoped grilling session

**What to build:** A short `CODING_STANDARDS.md` that the review agent enforces on the Standards axis. The MVP ended without one: ticket 38's Standards review had no repo standards to cite and fell back on the generic smell baseline, so every finding was a judgement call with no written rule behind it.

**Type:** maintenance

**Status:** ready-for-agent

**Blocked by:** none.

**Related:** [40: retro environment improvements](40-retro-environment-improvements.md); [42: Biome adoption](42-biome-lint-format.md); [52: operational script safety checks](52-operational-script-safety-checks.md); `AGENTS.md` (Review gate, Post-review RR8 gate, Merge discipline).

## Why a grilling session

Standards are judgement calls the maintainer owns; the retro evidence can propose candidates but not ratify them. The grilling should be scoped to the few rules no deterministic check can substitute for — mechanical patterns belong in ticket 42's Biome config instead. Run `/grill-with-docs` in a fresh session, with this ticket as the starting material, then write the file and point `AGENTS.md` at it.

## Candidate rules from the MVP evidence

Original interview material; the ratified dispositions below amend these candidates.

- Split a module by reason once it carries more than one responsibility; ticket 38's 1,000-line restore library was split on review into planning and verification modules.
- Extract shared helpers across scripts instead of duplicating: the restore CLI and the rehearsal had three copies of flag parsing, the runner, and the target config before review.
- Reusable scripts clean up in `finally` and never call `process.exit`; a `process.exit` in `runWrangler` bypassed the rehearsal's cleanup and leaked disposable D1 databases.
- Scripts that create remote resources delete only the resources they created, in reverse order, and report what they kept.
- Sensitive artifacts (exports, prepared SQL, manifests, status, evidence) are written mode 0600, never committed, and trashed when finished.
- Operational D1 facts live in `docs/operations/d1-scripting.md`, not in code comments; scripts point at it.

## Ratified decisions

The maintainer accepted both recommendation rounds, including the cleanup-failure refinement:

1. **Module boundaries — amended.** Split along independent reasons to change when separation clarifies ownership or hides complexity. Keep large cohesive modules together; line count and fragmentation alone justify nothing. Recorded in `CODING_STANDARDS.md`, “Boundaries follow reasons to change.”
2. **Shared helpers — amended.** Extract logic when callers must preserve the same behavior or safety invariant, not merely similar code. No fixed duplication count; avoid generic helpers with switches disguising unrelated behavior. Recorded in “Share behavior, not resemblance.”
3. **Cleanup and exit control — amended; assigned to checks.** Require cleanup on success and failure, not literal `finally` syntax. Reusable helpers return or throw; commands own cleanup and exit status. Scoped lint/AST enforcement and failure-path tests belong to ticket 52.
4. **Remote resource lifecycle — amended; assigned to checks.** Delete only temporary resources created by the current run, in reverse dependency order. Continue cleanup after individual failures, report all survivors, and never guess ownership. Retention is explicit. Unintended cleanup failure produces a nonzero exit while preserving any original error; deliberate retention does not. Ticket 52 owns tests and operational documentation.
5. **Sensitive artifacts — amended; assigned to checks and the runbook.** Require `0600` and exclusion from version control. Permit retention for diagnosis or explicit operator needs; report retained paths without contents and trash artifacts when finished. Ticket 52 owns permissions, repository checks, lifecycle tests, and disposal instructions; manual disposal cannot be fully proved by CI.
6. **Operational facts — amended.** Shared, verified D1/Wrangler behavior is authoritative in `docs/operations/d1-scripting.md`. Inline comments may explain local reasoning and link there rather than maintain competing facts. Recorded in “Keep operational facts authoritative.”

**Review policy:** A blocking Standards finding must cite a documented rule and explain a concrete maintenance or safety consequence. Unwritten preferences and heuristic smells are advisory; correctness and security findings remain independently reportable. This procedure belongs in `AGENTS.md`'s Review gate.

**Implementation scope:** This ticket changes documentation and review guidance only. Ticket 42 is already complete, so its follow-up section routes the mechanical safeguards to ticket 52 with explicit checks. Those safeguards are not claimed as implemented by ticket 41. No domain vocabulary or hard-to-reverse architecture decision changed; no glossary or ADR is needed.

## Acceptance criteria

- [x] A grilling session with the maintainer has ratified, amended, or rejected each candidate rule.
- [x] `CODING_STANDARDS.md` exists, is short, and contains only judgement calls no check can enforce.
- [x] `AGENTS.md` points at it from the review gate.
- [x] Mechanical rules from the list are filed for deterministic enforcement rather than the standards file: ticket 52, linked from the completed ticket 42.
- [x] The next code review cites the standards file where relevant.

## Scope and pointers

- `AGENTS.md`; `docs/agents/domain.md`.
- `.scratch/mdwn/issues/38-d1-export-database-restoration.md` (review findings).
- `docs/operations/d1-scripting.md`.

## Comments

- 2026-10-06: Raised from the MVP retro. Awaiting the maintainer's grilling session; the candidate list above is the interview material, not the decision.
- 2026-10-10: Maintainer ratified the recommendations in two rounds. Added the three-rule standards document and review-gate pointer; recorded each candidate's disposition and filed ticket 52 for the remaining automated safeguards. Implementation is docs-only; pinned review and verification evidence will accompany the PR. Status advanced from `needs-info` after ratification; merge completion remains pending.
- 2026-10-10: Pinned two-axis review `120cbe1...5634c84` completed with independent Standards and Spec agents. **Standards: Pass, 0 findings** — cites `CODING_STANDARDS.md`, “Keep operational facts authoritative,” for the canonical reference and ticket 52; the module-boundary and shared-behavior rules have no implementation touchpoints in this docs-only diff. **Spec: Pass, 0 findings** — all ratified decisions, review guidance, and mechanical follow-up match the agreed scope. Ticked the final criterion on that evidence. **Separate RR8/stack: Not applicable — no RR8/stack touchpoints** on the same pinned diff; all six changed files are Markdown, with no routes, UI data consumers, resource endpoints, Worker/D1 boundaries, runtime configuration, or test changes.
- 2026-10-10: Clean-tree `npm run verify` **passed at `5634c842569c937d323a115a1db97e6713f6d9fa`**: lint, typecheck, namespace drift, 306 Node and 382 Workers tests, build, fresh-local-D1 migration smoke, local export/restore round trip, bundle-secret scan, and 431 browser tests across Chromium/Firefox/WebKit (one existing synthetic WebKit drag/drop skip). No retries or remote database operations. Log: `/tmp/mdwn-41-verify.log`. This subsequent ticket-only update records completion evidence; it does not change the verified standards, guidance, or runtime files. The ad-hoc shell Markdown link check was blocked and not rerun. Current-head green `CI` and merge remain pending; ticket 52's safeguards remain unimplemented.
