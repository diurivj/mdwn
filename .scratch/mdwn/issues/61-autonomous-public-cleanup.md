# 61: Scheduled maintenance finishes an already-authorized Unpublishing teardown

**What to build:** Once an Owner's irreversible Unpublishing seal has committed, the existing 15-minute scheduled maintenance finishes deleting that Publication's Public material, even if no Owner browser ever returns. The Owner's browser may still drive batches while it is open, but it is no longer needed for completion.

**Type:** feature

**Status:** done

**Blocked by:** none.

**Related:** [53: Budgeted Workers Paid adoption](53-workers-paid-plan-spec.md); [`docs/workers-paid-plan.md`](../../../docs/workers-paid-plan.md) §4 and its testing decisions; [`docs/publications.md`](../../../docs/publications.md) (Unpublishing); [49](49-shared-comment-dependent-deletion.md) and [50](50-publication-teardown-shared-dependents.md) (shared Comment-dependent deletion); `app/publications/publications.server.ts` (`teardownPublication`, `teardownStatements`); `workers/app.ts` (`scheduled`); `app/retention/retention.server.ts`.

## Scope

- Only durable sealed state starts cleanup: a Publication in `deleting` state with its `publication_teardowns` row. Scheduled work never simulates a Session, consumes a Device proof or opens a key.
- Reuse the established bounded deletion: at most the existing per-batch Comment bound per transaction, then the single final transaction that removes the thread graph, representation, attribution, requests, teardown row and Publication. The browser and scheduled paths share one statement set, so their behavior cannot drift.
- Bound the work per Publication and per scheduled invocation, and choose the oldest pending teardowns first so a backlog drains over successive runs. Run the existing retention duties first. A failure in one duty must not skip the others.
- Every batch is idempotent and safe against browser batches, other scheduled runs and concurrent File deletion. A teardown can never delete a later Publication or the File's Private thread. A failed batch stays sealed and retryable.
- The Publish panel tells three states apart: Public access has ended (sealed), Public material is still being deleted (cleanup continues automatically, even after the page closes), and deletion is complete. It never claims physical deletion before the final transaction.
- Update the Unpublishing glossary entry and `docs/publications.md`/`docs/operations.md` for the scheduled path. Failure visibility stays content-free, with no identifiers in logs.

## Acceptance criteria

- [x] A real, authorized Unpublishing seal followed only by scheduled invocations reaches final deletion, across several invocations when the backlog exceeds one invocation's bound (Workers test, real D1).
- [x] The File, its Private comment thread and envelopes, unrelated Publications and other Owners' content survive, verified by direct D1 inspection on top of request-boundary checks.
- [x] Interleaved browser and scheduled batches, a scheduled run after File hard deletion, and a run after a later Publication was created all leave consistent state and delete nothing extra.
- [x] Existing security retention still runs in an invocation that also has a teardown backlog, and a failing duty does not stop the others.
- [x] The Publish panel copy distinguishes sealed, pending cleanup and completed, and a browser test covers leaving after confirmation and later seeing cleanup complete.
- [x] No queue, Workflow, Durable Object, new Worker, new binding or new Cron schedule.

## Comments

- 2026-10-12: Published as the first approved child of 53.
- 2026-10-12: Implemented on `issue/61-62-workers-paid-slices` (awaiting orchestrator review).
  - `app/publications/publications.server.ts`: one shared statement set, `teardownBatch` (the existing `deletedCommentBatch(…, TEARDOWN_COMMENT_BATCH, marker)` or `teardownStatements(…)`), used by the browser's proof-guarded `teardownPublication` unchanged in behavior and by the new `continueSealedTeardown`. The scheduled path selects the oldest sealed teardown (`publication_teardowns.created_at`, then id) and commits one batch per invocation in one atomic D1 batch: deferred-FK pragma, a CAS anchor on the sealed row (state `deleting` plus its teardown row), and dependents gated by the Publication row still being `deleting` (true until the final statement). The code comment explains why sealed state is valid authority inside one serialized D1 transaction while the proof path needs a per-invocation token, why the marker omits the teardown row, and why the File-keyed `publication_requests` delete is safe (the partial unique index admits no later Publication while the sealed row exists).
  - `app/retention/scheduled-maintenance.server.ts` (new): ordered, isolated duties (retention first, teardown last), fixed content-free failure reports, the invocation still fails when any duty failed. The worst-case D1 budget is 41 statements in 8 calls (≤ 50 even if every batched statement counts), tabulated beside the duty list. `workers/app.ts` calls it.
  - Publish panel and `PublicationLifecycle`: sealed/pending copy ("Public access has ended. Deletion continues automatically, even after you close this page.") and a `deletionComplete` state shown only after an authoritative read finds the sealed Publication gone.
  - Docs: `CONTEXT.md` Unpublishing, `docs/publications.md` (Scheduled completion), `docs/operations.md` (duties, bounds, budget, failure visibility), `docs/buildable-spec.md` §9.6 and lists, `docs/comments.md`, `docs/acceptance.md`.
  - No queue, Workflow, Durable Object, Worker, binding, Cron schedule or migration was added.
  - Tests run: `npx vitest run --config vitest.workers.config.ts tests/worker/scheduled-teardown.test.ts` 8 passed (red first: 7/7 failed before the implementation); `npx vitest run --config vitest.config.ts tests/publication-lifecycle.test.ts` 24 passed (the two new cases failed first); `npx playwright test e2e/publications.spec.ts --workers=2` 10 passed in each of chromium, firefox and webkit; `npm run lint` pass; `npm run typecheck` pass; `npm test` Node 44 files / 419 tests passed, Workers 53 files / 394 tests passed.
- 2026-10-12 (review round 1): Applied the orchestrator's fixes.
  - Fairness: the unread in-batch anchor is replaced by a separate attempt marker (`UPDATE publications SET updated_at = <now> WHERE <sealed row>`) that commits before the batch, and the target is the least recently attempted sealed Publication (`ORDER BY p.updated_at, p.id`, still joined to its teardown row). Authority stays the sealed predicate, re-evaluated per statement in the one atomic batch. A permanently failing teardown no longer blocks later ones. The budget stays 41 statements (now 9 D1 calls).
  - `teardownStatements` takes a `SealedPublication`; one `sealedRow` helper holds the id/File/Owner/`deleting` predicate used by the final delete, both anchors and the scheduled marker.
  - Operational facts: `docs/operations/d1-scripting.md` gains the authoritative per-invocation query entry (Free 50, Paid 1,000, every batched statement counts until verified, D1 limits page cited). The maintenance module, `docs/operations.md` (three places), `docs/import.md` and `docs/acceptance.md` link to it; the per-duty table lives only beside the duty list in code; the Paid D1 section links to the reference's Free limits instead of repeating them.
  - Tests added: a poisoned teardown (a `RAISE(ABORT)` trigger scoped to one Publication, created and dropped in the test) while another sealed Publication completes; stale-target races through a D1 Proxy that runs a browser completion plus republish, or a File hard deletion, between the target SELECT and the batch; the statement-budget test now seeds an expired Grant with envelopes and counts exactly 41. A new browser journey leaves the File right after confirming (teardown requests aborted), runs scheduled maintenance, returns, and sees an unpublished File with a `404` old link; the same-page "Public material deleted" test remains. Docs now say the deleted confirmation appears only on a page that saw the seal.
  - Tests run: `npx vitest run --config vitest.workers.config.ts tests/worker/scheduled-teardown.test.ts` red first (poison case failed; the race and budget cases passed immediately as regression coverage), then 11 passed; with `publication-lifecycle` and `comment-dependent-deletion` 29 passed; `npx playwright test e2e/publications.spec.ts e2e/support.spec.ts --workers=2` 13 passed in each of chromium, firefox and webkit; `npm run lint` pass; `npm run typecheck` pass; `npm test` Node 44 files / 419 passed, Workers 53 files / 397 passed.
- 2026-10-12 (orchestrator): Integrated on `issue/53-57-58-remaining-tickets` with tickets 57, 58 and 62, and awaiting PR/merge.
  - **Review.** Diff: `git diff eaf18e4...15da673` (SHA256 `64540f92cbb18a63602a05a11a9e1b607684a5a48017bacd39f7ebcbf7573f40`). `CODING_STANDARDS.md` was read first.
    - Standards: one hard finding (the D1 per-invocation limit was restated in many places) plus smells.
    - Spec: head-of-line blocking by a poisoned teardown, overstated docs, and the `/support` copy.
    - Separate RR8/stack gate: **Pass**. No routes, loaders or actions changed; D1 access stays on `createDb`/`atomicSqlBatch`; tests use `worker.scheduled` with real D1 and the harness's `getWorker().scheduled`.
  - Fixed in `4be2e61` and verified by the orchestrator.
  - Integration: the merge kept the scheduled maintenance entry point beside ticket 57's Worker fetch changes, and all nine Publication spent-proof sites answer `device_proof_spent`.
  - Clean-head `npm run verify` passed at `e38eb71`. It covered lint, typecheck, namespace drift, 555 Node and 414 Workers tests, the build, the fresh-D1 smoke, export/restore, the bundle-secret check, and 545 browser tests across Chromium, Firefox and WebKit. The 1 existing WebKit skip remained; there were no failures and no retries. Whole-branch diff: `git diff 75e882c...e38eb71` (SHA256 `9d5ca20709f5cdf72e4bcf34ec54141e9e0977182f7a0d0589720ebc5df4fd91`).
- 2026-10-12: Completed and merged into `main` via [PR #66](https://github.com/diurivj/mdwn/pull/66), merge commit `2c0e49a1087c5c89b4fe5c6e0fa9c9a421937341`. Earlier pending PR/merge and verification notes are historical.
