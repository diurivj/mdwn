# 61: Scheduled maintenance finishes an already-authorized Unpublishing teardown

**What to build:** Once an Owner's irreversible Unpublishing seal has committed, the existing 15-minute scheduled maintenance finishes deleting that Publication's Public material, even if no Owner browser ever returns. The Owner's browser may still drive batches while it is open, but it is no longer needed for completion.

**Type:** feature

**Status:** ready-for-agent

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

- [ ] A real, authorized Unpublishing seal followed only by scheduled invocations reaches final deletion, across several invocations when the backlog exceeds one invocation's bound (Workers test, real D1).
- [ ] The File, its Private comment thread and envelopes, unrelated Publications and other Owners' content survive, verified by direct D1 inspection on top of request-boundary checks.
- [ ] Interleaved browser and scheduled batches, a scheduled run after File hard deletion, and a run after a later Publication was created all leave consistent state and delete nothing extra.
- [ ] Existing security retention still runs in an invocation that also has a teardown backlog, and a failing duty does not stop the others.
- [ ] The Publish panel copy distinguishes sealed, pending cleanup and completed, and a browser test covers leaving after confirmation and later seeing cleanup complete.
- [ ] No queue, Workflow, Durable Object, new Worker, new binding or new Cron schedule.

## Comments

- 2026-10-12: Published as the first approved child of 53.
