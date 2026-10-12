# 62: Workers Paid operating contract: budget policy, intervention runbook and ADR supersession

**What to build:** Documentation only. Record Workers Paid as mdwn's intended operating baseline without claiming a subscription is active: the $5 target, the $10 intervention boundary and the absence of any provider-enforced spending cap. Add the alert setup and intervention runbook, the Paid D1 capacity and 30-day Time Travel window, and supersession notes on the ADRs whose Free-only premises change.

**Type:** documentation

**Status:** ready-for-agent

**Blocked by:** none.

**Related:** [53: Budgeted Workers Paid adoption](53-workers-paid-plan-spec.md); [`docs/workers-paid-plan.md`](../../../docs/workers-paid-plan.md) §1–2 and §5; [Workers Paid research](../research/workers-paid-budget.md); [ADR-0002](../../../docs/adr/0002-cloudflare-workers-and-d1.md), [ADR-0005](../../../docs/adr/0005-privacy-preserving-abuse-controls.md), [ADR-0006](../../../docs/adr/0006-visible-atomic-staged-imports.md), [ADR-0007](../../../docs/adr/0007-no-monetization-anonymous-support.md); [`docs/operations.md`](../../../docs/operations.md); [`docs/buildable-spec.md`](../../../docs/buildable-spec.md).

## Scope

- In `docs/operations.md`, a short **Workers Paid operating policy**:
  - an operator checklist that first confirms the account's actual plan and usage model;
  - fixed fees, usage overages, taxes and domain costs kept separate;
  - account-wide allowances that every project on the account shares;
  - early overage warnings using the provider's own billing notifications (starting points $1 and $3);
  - an intervention runbook: inspect the meter, stop discretionary work, restrict growth-producing operations, keep data-exit and security operations available.
  - It states plainly that neither alerts nor application limits cap the invoice.
- Record Paid D1 capacity and the 30-day Time Travel window as operational recovery, not user-visible history or immediate erasure from provider backups.
- Append dated "superseded in part" notes to ADR-0002, 0005, 0006 and 0007 that name exactly which Free-only or zero-overage premise changes. Keep the historical decision text and its rationale.
- Reconcile the affected normative Free-only statements in `docs/buildable-spec.md` and other current docs. Leave unaffected contracts alone. Import limits, rate limits and the privacy model do not change.
- Mark `docs/workers-paid-plan.md` as in progress, with links to the children.

## Acceptance criteria

- [x] The policy, runbook and Time Travel facts are in `docs/operations.md`, with sources, and no text claims a hard spending cap, an active subscription or measured production capacity.
- [x] Each of the four ADRs keeps its original decision and gains a dated supersession note naming the changed premise.
- [x] No remaining current-tense doc presents Workers Free or zero overage as the operating requirement, except as recorded history.
- [x] Biome and the documentation-touching checks still pass. No application code, config or remote resource changes.

## Comments

- 2026-10-12: Published as the second approved child of 53.
- 2026-10-12: Written on `issue/61-62-workers-paid-slices` (documentation only; awaiting orchestrator review).
  - `docs/operations.md` gains the **Workers Paid operating policy**: budget ($5 target, $10 intervention boundary) with the explicit statement that neither alerts nor application limits cap the invoice; fixed fees, usage overages, taxes and domain costs kept apart with the Paid rate card; account-wide allowances; $1/$3 overage warnings through Cloudflare budget alerts; an operator checklist whose first step confirms the actual plan and usage model; the intervention runbook; and Paid D1 capacity with the 30-day Time Travel window as operational recovery only. Sources: the research note and the Cloudflare pricing, limits, Time Travel, budget-alert, Billable Usage, billing, tax and metrics pages it cites. The Time Travel rehearsal text, validated-limits note and rehearsal row-write note now distinguish Free from Paid without changing their evidence.
  - Dated "Superseded in part (2026-10-12)" sections appended to ADR-0002, 0005, 0006 and 0007, each naming the changed Free-only or fixed-cost premise and what stays; original text untouched.
  - Reconciled current-tense statements: `docs/buildable-spec.md` (§1 item 10, §3.5 capacity line, §9.8 proof gate, §10.1 posture, §12 proof wording), `docs/security-review.md`, `docs/security-review-request.md`, `docs/acceptance.md`, `docs/import.md`, `docs/testing.md`, `README.md`, `docs/operations/d1-scripting.md` (a documented, not exercised, Paid limits line) and `docs/support-options.md`. Import limits, rate limits, the 50-statement Import evidence and privacy contracts are unchanged; the import docs now note that a proof pass on a Paid account no longer demonstrates the 50-statement fit.
  - `docs/workers-paid-plan.md` status is now in progress with links to 61–65.
  - Left as recorded history: dated evidence in `docs/operations.md` and `docs/import.md`, and `docs/architecture-deepening.md` (an approved design pinned to an earlier snapshot). Open follow-up outside this documentation ticket: the `/support` page copy (`app/routes/support.tsx`, asserted by `e2e/support.spec.ts`) still says exhausted free capacity fails closed rather than triggering paid spend; `docs/support-options.md` now flags it.
  - No claim of an active subscription, configured alerts or measured production capacity. No application code, config or remote change.
  - Checks: `npm run lint` pass (Biome, operational-safety check); `npm run typecheck` pass; `npm test` Node 44 files / 419 tests passed, Workers 53 files / 394 tests passed.
- 2026-10-12 (review round 1): Applied the orchestrator's fixes.
  - `docs/buildable-spec.md` §1 item 10 no longer implies abuse controls keep spending within a budget; it says they limit misuse, are not a spending cap, and points to the operating policy.
  - ADR-0005's supersession note makes the overage statement conditional on Workers Paid being active (the subscription is unconfirmed; Free limits apply until then).
  - Small product-copy change (approved in review): the `/support` page (`app/routes/support.tsx`) drops the claim that exhausted free capacity "fails closed rather than triggering paid spend". It now says donations help cover the mdwn domain and hosting costs, grant nothing and change nothing about how mdwn runs; the meta description's "future paid infrastructure" is replaced the same way. `e2e/support.spec.ts`, `tests/worker/support-page.test.ts` (updated first, red, then green), `docs/support-options.md` and the buildable-spec support line match.
  - The per-invocation D1 limit now has one authoritative entry in `docs/operations/d1-scripting.md`; `docs/operations.md`, `docs/import.md` and `docs/acceptance.md` link to it, and the Paid D1 section no longer repeats the reference's verified Free limits.
  - Tests run: `npx vitest run --config vitest.workers.config.ts tests/worker/support-page.test.ts` 1 failed then 4 passed; `npx playwright test e2e/support.spec.ts e2e/publications.spec.ts --workers=2` 13 passed in each of chromium, firefox and webkit; `npm run lint`, `npm run typecheck` pass; `npm test` Node 419 passed, Workers 397 passed.
