# 41: Write the coding standards through a scoped grilling session

**What to build:** A short `CODING_STANDARDS.md` that the review agent enforces on the Standards axis. The MVP ended without one: ticket 38's Standards review had no repo standards to cite and fell back on the generic smell baseline, so every finding was a judgement call with no written rule behind it.

**Type:** maintenance

**Status:** needs-info

**Blocked by:** none.

**Related:** [40: retro environment improvements](40-retro-environment-improvements.md); [42: Biome adoption](42-biome-lint-format.md); `AGENTS.md` (Post-review RR8 gate, Merge discipline).

## Why a grilling session

Standards are judgement calls the maintainer owns; the retro evidence can propose candidates but not ratify them. The grilling should be scoped to the few rules no deterministic check can substitute for — mechanical patterns belong in ticket 42's Biome config instead. Run `/grill-with-docs` in a fresh session, with this ticket as the starting material, then write the file and point `AGENTS.md` at it.

## Candidate rules from the MVP evidence

- Split a module by reason once it carries more than one responsibility; ticket 38's 1,000-line restore library was split on review into planning and verification modules.
- Extract shared helpers across scripts instead of duplicating: the restore CLI and the rehearsal had three copies of flag parsing, the runner, and the target config before review.
- Reusable scripts clean up in `finally` and never call `process.exit`; a `process.exit` in `runWrangler` bypassed the rehearsal's cleanup and leaked disposable D1 databases.
- Scripts that create remote resources delete only the resources they created, in reverse order, and report what they kept.
- Sensitive artifacts (exports, prepared SQL, manifests, status, evidence) are written mode 0600, never committed, and trashed when finished.
- Operational D1 facts live in `docs/operations/d1-scripting.md`, not in code comments; scripts point at it.

## Acceptance criteria

- [ ] A grilling session with the maintainer has ratified, amended, or rejected each candidate rule.
- [ ] `CODING_STANDARDS.md` exists, is short, and contains only judgement calls no check can enforce.
- [ ] `AGENTS.md` points at it from the review gate.
- [ ] Mechanical rules from the list are filed into ticket 42's Biome config or a deterministic check rather than the standards file.
- [ ] The next code review cites the standards file where relevant.

## Scope and pointers

- `AGENTS.md`; `docs/agents/domain.md`.
- `.scratch/mdwn/issues/38-d1-export-database-restoration.md` (review findings).
- `docs/operations/d1-scripting.md`.

## Comments

- 2026-10-06: Raised from the MVP retro. Awaiting the maintainer's grilling session; the candidate list above is the interview material, not the decision.
