# 53: Budgeted Workers Paid adoption specification

Status: ready-for-agent
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

Use `/to-tickets` to propose small, dependency-ordered vertical slices for maintainer approval. This is a parent specification, not a request to implement the entire effort in one session. Publish children under the existing local issue tracker; do not silently include the deferred opportunities.

## Comments

- 2026-10-11: Synthesized from the Workers Paid research and maintainer agreement. The maintainer confirmed the Worker/D1, browser, and operational test boundaries while explicitly objecting to unnecessary test time, rehearsals, and Cloudflare resource requests. The spec therefore reuses current suites and Cron, keeps remote measurement narrow and opt-in, and does not create a new verification or billing platform. No application code, account configuration, deployment, or remote resource changed during publication.
