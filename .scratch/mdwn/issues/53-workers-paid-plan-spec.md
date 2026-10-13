# 53: Budgeted Workers Paid adoption specification

Status: done
Type: spec
Blocked by: none

**Specification:** [Budgeted Workers Paid adoption](../../../docs/workers-paid-plan.md).

## Purpose

Adopt Workers Paid as mdwn's operating baseline, target approximately $5 per month with intervention before the intended $10 maximum, and improve larger Imports and autonomous Public-material cleanup without changing the privacy model or creating a new infrastructure platform. Cloudflare does not provide a guaranteed account-wide spending cap for this setup.

The linked document is the canonical specification. The [pricing and opportunity research](../research/workers-paid-budget.md) remains evidence and future-option context, not permission to implement every option it discusses.

## Delivery contract

- Budget safeguards precede capacity expansion; proposed 500–1,000-node Imports remain benchmark-gated, not promised bounds.
- Keep the existing stack, staged Import design, browser-only cryptography, and no-monetization policy.
- Use existing Cron for autonomous cleanup of already-authorized irreversible Unpublishing seals; do not add a queue or another service by default.
- Reuse existing test boundaries and add only focused regression coverage. No new recurring remote rehearsal, monitoring service, benchmark pipeline, or routine Cloudflare resource creation.
- Remote capacity evidence is targeted and explicitly authorized only when existing evidence is insufficient. Retain current limits if that evidence is unavailable.
- Preserve existing review, local preflight, and PR/CI gates. Documentation publication does not claim tests or production measurements have run.

## Next step

On 2026-10-12 the maintainer approved this decomposition and asked for the first two children now. Number 60 is skipped: the open CI runner-pool pull request (#64) already claims it.

| Ticket | Slice | Status |
| --- | --- | --- |
| [61](61-autonomous-public-cleanup.md) | Scheduled maintenance finishes an already-authorized Unpublishing teardown | done |
| [62](62-workers-paid-operating-contract.md) | Paid operating policy, intervention runbook, D1 Paid capacity and Time Travel, ADR supersession | done |
| [63](63-worker-cpu-ceiling.md) | Explicit Worker CPU ceiling | done (2026-10-13) |
| [64](64-import-admission-guard.md) | Scoped Import storage/admission guard | wontfix (2026-10-12) |
| [65](65-larger-import-envelope.md) | Larger practical Import envelope | wontfix (2026-10-12) |

The deferred opportunities in the research stay deferred. No child changes the account, a subscription, alerts or any remote resource.

## Comments

- 2026-10-13: All children resolved. 61, 62 and 63 are done (63 merged via PR #70 and deployed); 64 and 65 are wontfix (2026-10-12). The Workers Paid adoption spec is complete: the operating policy and ADR supersession are documented, the CPU ceiling is live, and the larger-Import work is closed.

- 2026-10-12: 61 and 62 merged into `main` via [PR #66](https://github.com/diurivj/mdwn/pull/66), merge commit `2c0e49a1087c5c89b4fe5c6e0fa9c9a421937341`; 66 merged via [PR #67](https://github.com/diurivj/mdwn/pull/67), merge commit `da10337332041cd8a56048c485f08025c79efe84`. Only 63 remains open.

- 2026-10-12: The maintainer decided the current 100-node Import envelope is fine and closed 64 and 65 as **wontfix**; the 500–1,000-node target is not pursued. The remaining open child is [63](63-worker-cpu-ceiling.md) (`ready-for-human`, subscription and CPU evidence first). The Paid operating policy ([62](62-workers-paid-operating-contract.md)) and scheduled cleanup ([61](61-autonomous-public-cleanup.md)) stand. `docs/workers-paid-plan.md` §3 is dropped.

- 2026-10-12 (orchestrator): Children 61 and 62 are implemented, reviewed and integrated on `issue/53-57-58-remaining-tickets` with tickets 57 and 58, and are awaiting PR/merge. Clean-head `npm run verify` passed at `e38eb71`. 63 stays `ready-for-human`, and 64 and 65 stay `needs-triage`.

- 2026-10-12: The maintainer chose "cleanup + docs now". Children 61–65 are published; 61 and 62 are delivered together with tickets 57 and 58 in one pull request.

- 2026-10-11: Synthesized from the Workers Paid research and maintainer agreement. The maintainer confirmed the Worker/D1, browser, and operational test boundaries while explicitly objecting to unnecessary test time, rehearsals, and Cloudflare resource requests. The spec therefore reuses current suites and Cron, keeps remote measurement narrow and opt-in, and does not create a new verification or billing platform. No application code, account configuration, deployment, or remote resource changed during publication.
