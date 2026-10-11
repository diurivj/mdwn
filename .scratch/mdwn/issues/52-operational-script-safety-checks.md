# 52: Enforce operational script lifecycle and artifact safeguards

**What to build:** Deterministic checks for the operational contracts ratified in ticket 41: cleanup-safe helpers, owned-resource cleanup, accurate failure/retention reporting, and sensitive-artifact handling. Fix the checked scripts as needed to make those checks pass. These are implementation safeguards, not additional prose rules in `CODING_STANDARDS.md`.

**Type:** maintenance

**Status:** ready-for-agent

**Blocked by:** none.

**Related:** [41: coding standards](41-coding-standards.md); [42: Biome adoption](42-biome-lint-format.md); [38: D1 restoration](38-d1-export-database-restoration.md); [40: retro improvements](40-retro-environment-improvements.md).

## Ratified contracts and enforcement

### Cleanup and exit control

Reusable helpers return or throw; the command owns cleanup and exit status. The contract is cleanup on success and failure, not the literal presence of `finally`.

- Add a scoped lint/AST check against process-exit calls in reusable `scripts/lib/` modules. Use Biome if it can enforce the scope precisely; otherwise use a repository check.
- Exercise entrypoint cleanup through injected subprocess failures, including helpers inside `scripts/smoke-db.mjs` that can currently exit across a cleanup-bearing scope.
- Attempt remaining cleanup after one cleanup operation fails. Unexpected cleanup failure makes the command fail, while preserving any original operational error and reporting cleanup errors separately. Explicitly requested retention is not a failure.

### Temporary remote resources

Delete only resources known to have been created by the current run, in reverse dependency order. A reused or caller-supplied resource is not owned by the run. Retention must be explicit; report every survivor using resource identifiers, not sensitive contents. An ambiguous creation result is a reportable unresolved outcome, not permission to guess an identity and delete it.

Test partial creation, reused resources, dependency ordering, failed deletion with continued cleanup, explicit retention, and survivor reporting. Tests use a controlled command runner; no Cloudflare credentials or live deletion are needed.

### Sensitive artifacts

Exports, prepared SQL, manifests, status/evidence containing sensitive material, and credential-bearing files require mode `0600` and exclusion from version control. Retention is permitted for diagnosis or explicit operator needs; report retained paths without contents and give instructions to trash artifacts when finished.

- Add filesystem tests for the actual writers and command-created artifacts, including overwrites and the permissive-umask case. Protect raw Wrangler output as well as artifacts written by `writeSensitive`.
- Add a tracked-artifact check for documented operational output paths/patterns, plus appropriate ignore rules. Prove that a tracked matching artifact fails even if an ignore rule exists. Keep deliberately synthetic fixtures distinct from operational output; do not ban all SQL/JSON files or claim arbitrary sensitive content can be classified by filename.
- Test default success cleanup, failure retention, explicit retention, reported paths, and absence of artifact contents from lifecycle messages. Update `docs/operations.md` with the matching lifecycle and disposal instructions. Tests cover program-controlled cleanup, not eventual manual disposal of operator-held files.

## Starting evidence (2026-10-10)

These are known gaps, not guarantees already enforced:

- `scripts/lib/wrangler-targets.mjs`: exported `runWrangler` calls `process.exit`; `scripts/smoke-db.mjs` also exits from helpers called inside a cleanup-bearing scope.
- `scripts/rehearse-d1-restore.mjs`: creation ledger and reverse-order deletion exist, but deletion failure is logged without contributing to the final exit status. The raw export relies on the operator's umask rather than explicit file-mode handling.
- `scripts/import-proof.mjs`: accepts existing databases but cleans up fixed Worker/database names without a current-run ownership ledger, ignores deletion results, and reports deletion success regardless. Its temporary proof environment contains a Session cookie and private JWK and is written without an explicit mode.
- `scripts/lib/restore-cli-support.mjs`: `writeSensitive` already writes/chmods prepared artifacts to `0600`; extend coverage rather than duplicate this helper.
- `.gitignore` has no restore-artifact patterns. `scripts/check-bundle-secrets.mjs` checks browser bundles, not tracked operational exports.

## Acceptance criteria

- [ ] Reusable process-exit calls are deterministically rejected, and affected command boundaries return failure only after cleanup has run.
- [ ] Fault-injection tests prove owned-only, reverse-dependency cleanup, continued cleanup after failure, preserved original errors, truthful survivor reporting, and nonzero exit for unexpected cleanup failure.
- [ ] Retention is explicit for remote resources; borrowed resources are never deleted. Intentional retention is distinguishable from cleanup failure.
- [ ] Sensitive-artifact writers and command output paths have permission and lifecycle coverage; tracked operational artifacts fail a repository check even when ignored.
- [ ] `docs/operations.md` describes retention/disposal and failure reporting. Shared provider behavior stays authoritative in `docs/operations/d1-scripting.md`; touched script comments link there and retain only local reasoning.
- [ ] New checks run through the existing lint/test commands or are wired into both `CI` and `npm run verify`. Focused tests run without remote resources; the local restore round trip continues to pass.
- [ ] Standards/Spec review and a separate RR8/stack gate cover the pinned diff; clean-head `npm run verify` passes before opening the PR. Current-head green `CI` is required before merge.

## Scope and pointers

- `scripts/lib/wrangler-targets.mjs`, its callers, `scripts/lib/restore-cli-support.mjs`.
- `scripts/smoke-db.mjs`, `scripts/rehearse-d1-restore.mjs`, `scripts/import-proof.mjs`.
- `tests/`, `biome.json`, `.gitignore`, `package.json`, `.github/workflows/ci.yml`, `scripts/verify-local.mjs`.
- `docs/operations.md`, `docs/operations/d1-scripting.md`, `docs/testing.md`.

No application feature changes, production operations, blanket complexity limits, duplication-count rules, or paid/live remote rehearsal are required. Keep ticket 42's completed Biome rollout intact.

## Comments

- 2026-10-10: Filed from ticket 41's maintainer grilling. All lifecycle policies above were ratified there; implementation and checks remain open in this ticket. A docs-only ticket 41 does not claim these gaps are fixed.
