# 51: Hard deletion removes imported Historical Comment envelopes

**What to build:** Hard-deleting a File or bounded Directory that carries an imported Historical Comment thread must succeed and remove that thread's `import_comment_envelopes` key envelope with it. Today the envelope's foreign key is RESTRICT and no production statement deletes the table, so the atomic batch aborts and the route returns 400 for imported content — the file cannot be deleted at all. Regression evidence comes first: a failing real-D1 test for File and Directory deletion of an imported thread, then the File-scope removal in the shared Comment-dependent module, kept out of the Publication scope.

**Type:** bug

**Status:** ready-for-agent

**Blocked by:** None. Ticket 49 delivered the shared module in `app/comments/dependents.server.ts`, merged on `main` by PR #56 (merge `58f8842`); ticket 50 (Publication teardown scope) is independent and must not gain this removal.

**Related:** [49: Shared Comment-dependent module for File and Directory Hard deletion](49-shared-comment-dependent-deletion.md); [27: Hard-deletion completeness](27-hard-deletion-completeness.md); [30: Import staging and commit](30-import-staging-and-commit.md); [43: Architecture deepening specification](43-architecture-deepening-spec.md) and `docs/architecture-deepening.md` (shared constraint 1: an existing correctness gap needs explicit regression evidence). Reference docs: `docs/comments.md` (Historical Comment envelopes), `docs/import.md`, `docs/acceptance.md` (File/Directory hard deletion removes every dependent record atomically).

## Reproduction

1. Commit an Import whose Markdown sidecar carried Historical Comments, or seed the same rows at the D1 seam: a Private `comment_threads` row (with its `comment_thread_epochs`) plus its one `import_comment_envelopes` row.
2. Send the authorized `DELETE /api/private/tree/nodes/:fileId` (and the Directory deletion containing that File) with a valid signed listing head.
3. Expected: `200`, the thread and its envelope gone, the parent listing advanced. Actual: `400 { "error": "invalid_tree_request" }` and nothing deleted, because the deferred RESTRICT check fails at batch commit.

Root cause: `import_comment_envelopes.thread_id` references `comment_threads(id) ON DELETE RESTRICT` (`drizzle/0026_wooden_roxanne_simpson.sql:23`). The table is written by the Import commit (`app/import/staging.server.ts:898`) and read by the envelope path (`app/comments/envelopes.server.ts:61`); no `DELETE` for it exists anywhere in `app/`. Reproduction evidence (2026-10-11): a real-workerd test returned 400 and left every row unchanged; see ticket 49's review notes.

- [ ] A red-before-green regression test reproduces the 400 for File and Directory deletion of an imported thread at the authorized route seam, and a real-D1 module test includes the envelope in the shared module's graph.
- [ ] File scope removes `import_comment_envelopes` for its selected threads in the existing marker-guarded atomic batch, in the module's existing foreign-key-safe position (with the other Comment dependents, before `comment_threads`).
- [ ] The removal stays File-scope-only: Publication teardown (ticket 50) must never select a Private thread or its envelopes, exactly like the `import_comment_meta` asymmetry.
- [ ] Unrelated Files, threads, envelopes and Import sessions remain unchanged; an over-cap Directory and an injected late dependent failure still leave everything unchanged.
- [ ] Existing hard-deletion completeness, import-staging Historical Comment, private-tree, Directory-cap and injected-rollback suites are retained and pass.
- [ ] `npm run verify` passes; the change lands on its issue branch with a PR and current-head `CI` green before merge, with Standards/Spec review and a separate RR8/stack result on the same pinned diff.

## Scope and pointers

- The File scope of the shared module under `app/comments/dependents.server.ts`; its caller under `app/tree/` does not change.
- This is a correctness correction, not a locality change: the route currently fails where `docs/acceptance.md` and ticket 33's acceptance suite claim every dependent record is removed atomically. Record the red test before changing behavior.
- Do not widen deletion scope beyond the selected threads, and do not touch Import staging, expiry cleanup or the Publication teardown schedule.
- Update the module doc's dependent list and the acceptance-evidence docs (`docs/comments.md`, `docs/acceptance.md`) where they enumerate the removed material.

## Comments

- 2026-10-11: Filed from ticket 49's reviewed and verified finding. Ticket 49 was a behavior-preserving refactor and intentionally preserved the 400; its module doc and the completeness test's table inventory currently overstate coverage for imported threads. The fix is small and local: one statement in the File scope of `app/comments/dependents.server.ts` plus regression coverage.
