# 40: MVP retro environment improvements

**What to build:** Apply the environment fixes from the MVP implementation retrospective. The retro reviewed the ticket 38 session (`01a1118f`, 352 tool calls / 226 bash / 341k output tokens) plus the 12 most recent sessions, and found chronic steering, navigation, and check gaps rather than code defects.

**Type:** maintenance

**Status:** done

**Blocked by:** none.

**Related:** [38: D1 export restoration](38-d1-export-database-restoration.md); [41: coding standards](41-coding-standards.md); [42: Biome adoption](42-biome-lint-format.md); `docs/operations/d1-scripting.md`; `docs/operations.md`.

## Findings and fixes

1. **Agents block on CI.** `gh pr checks --watch` appears in 9 sessions, once with a 2400s timeout, and the maintainer pushed back ("dont watch for it"). The self-hosted runner executes the four jobs sequentially (~25 min per PR), so watching buys nothing. Fix: a positive rule in `AGENTS.md` — after pushing/opening the PR, report the commit and URL and stop; check CI when the user asks or once immediately before merging.
2. **Wrong `gh` account for this repo.** `Could not resolve to a Repository` appears in 22 session files (36 occurrences); ticket 37 worked around it with `GH_TOKEN=$(gh auth token --user diurivj)`. Fix: a user-wide rule in `~/.pi/agent/AGENTS.md` mapping `~/oasis` to `eldiegallo` and every other directory to `diurivj`, with the `gh auth switch` step before the first `gh` command. This also replaces the vestigial 16-byte global file.
3. **No CI-executable end-to-end for the real export/restore path.** `db:smoke` proves fresh migrations only; ticket 38's local round trip was hand-built and manual. Fix: `npm run db:restore:local` (`scripts/rehearse-d1-restore.mjs --local`) runs migrate → seed → real `wrangler d1 export` → prepare → restore into a second fresh local state → verify source and target, with no Cloudflare auth; wire it into the `CI` workflow and `npm run verify` beside `db:smoke`.
4. **No navigation pointers in `AGENTS.md`.** Ticket 38 spent calls rediscovering the schema, wrangler helpers, and prior evidence, and read Wrangler's bundle to learn transport semantics. Fix: a short "Reference docs" block in `AGENTS.md` plus `docs/operations/d1-scripting.md`, the verified Wrangler/D1 reference for script authors (query endpoint atomicity, import batching, statement/row limits, local persistence, flag quirks, splitting hazard, Free quota).
5. **D1 Free quota is invisible.** Four rehearsal attempts spent the shared daily row-write quota before it blocked the final remote run. Fix: document "at most one full remote rehearsal per day; check usage first; prefer the local round trip".
6. **Tool economy.** 46 wrangler invocations printed banners/migration tables; `npm run typecheck` ran ~38 times and rebuilds generated types. Fix: `runWranglerJson` in `scripts/lib/wrangler-targets.mjs` (banner-free JSON, raised `maxBuffer`), adopted by the restore CLI/runner, and a fast `npm run typecheck:node` documented in `docs/testing.md`.

## Acceptance criteria

- [x] `AGENTS.md` carries the CI-watch rule and the reference-docs pointers.
- [x] `AGENTS.md` points to `CODING_STANDARDS.md` (implemented by ticket 41).
- [x] `~/.pi/agent/AGENTS.md` maps `~/oasis` to `eldiegallo` and everywhere else to `diurivj`, with the `gh auth switch` step.
- [x] `docs/operations/d1-scripting.md` records the verified Wrangler/D1 semantics and is pointed to from `AGENTS.md`.
- [x] `npm run db:restore:local` passes locally and in CI, leaves no temp state on success, and keeps it on failure for inspection.
- [x] `runWranglerJson` exists and is used by the restore CLI/runner; `npm run typecheck:node` exists and is documented.
- [x] Quota guidance is in `docs/operations.md`.
- [ ] Focused tests, `npm run typecheck`, the full suite, and the clean-head `npm run verify` gate pass; Standards/Spec and the RR8 gate report on the diff.

## Scope and pointers

- `AGENTS.md`; `~/.pi/agent/AGENTS.md`.
- `docs/operations.md`, `docs/operations/d1-scripting.md`, `docs/testing.md`.
- `scripts/rehearse-d1-restore.mjs`, `scripts/lib/wrangler-targets.mjs`, `scripts/lib/restore-cli-support.mjs`, `scripts/restore-d1-export.mjs`.
- `.github/workflows/ci.yml`, `scripts/verify-local.mjs`, `package.json`.

## Comments

- 2026-10-06: Raised from the MVP retro. Implemented on `chore/retro-environment-improvements`; see the PR for the verification evidence. The grilling session for ticket 41 and the Biome rollout in ticket 42 are deliberately separate.
- 2026-10-07: Status reconciled to **done**: PR #49 merged as `31a4ccf`. Ticked the six evidenced criteria (AGENTS.md CI-watch rule and reference pointers, the user-wide `gh` mapping, `docs/operations/d1-scripting.md`, `db:restore:local` in CI and `npm run verify`, `runWranglerJson`/`typecheck:node`, quota guidance). The `CODING_STANDARDS.md` pointer from the first bullet remains pending ticket 41, which is still open. The final bullet stays unticked for the same reason as ticket 36: no in-repo record of a Standards/Spec/RR8 report was found for PR #49.
- 2026-10-08: Split the composite first criterion so the still-missing `CODING_STANDARDS.md` pointer is visibly unchecked rather than hidden inside a checked bullet. Ticket 41 still needs maintainer ratification and has no standards artifact. This is a pending follow-up/evidence gap, not pending implementation merge or CI for PR #49.
- 2026-10-10: Ticket 41's maintainer grilling ratified the standards and added the `AGENTS.md` Review gate pointer. Ticked that follow-up criterion; the historical PR #49 review-evidence gap remains unchanged.
