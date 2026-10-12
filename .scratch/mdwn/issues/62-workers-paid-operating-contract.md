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

- [ ] The policy, runbook and Time Travel facts are in `docs/operations.md`, with sources, and no text claims a hard spending cap, an active subscription or measured production capacity.
- [ ] Each of the four ADRs keeps its original decision and gains a dated supersession note naming the changed premise.
- [ ] No remaining current-tense doc presents Workers Free or zero overage as the operating requirement, except as recorded history.
- [ ] Biome and the documentation-touching checks still pass. No application code, config or remote resource changes.

## Comments

- 2026-10-12: Published as the second approved child of 53.
