# 63: Explicit Worker CPU ceiling

**What to build:** Set an explicit `limits.cpu_ms` for the preview and production Workers, chosen from workload evidence, so a runaway invocation cannot consume the large Paid default.

**Type:** configuration

**Status:** ready-for-human

**Blocked by:** the maintainer confirming that the account's Workers Paid subscription is active (Free rejects a configured CPU limit), and supplying CPU-time evidence: dashboard percentiles for authentication, ordinary private routes, the largest Import requests and the scheduled handler.

**Related:** [53](53-workers-paid-plan-spec.md); [`docs/workers-paid-plan.md`](../../../docs/workers-paid-plan.md) §1 ("Select an explicit CPU ceiling…"); [62](62-workers-paid-operating-contract.md).

## Scope

- Choose a ceiling with headroom above the observed worst case for every route class, including scheduled teardown from [61](61-autonomous-public-cleanup.md). Do not adopt the Paid default merely because it exists, and do not pick a low cap that recreates Free-tier failures.
- Configure it per environment in `wrangler.jsonc`. Document the evidence, the chosen value and how to roll it back in `docs/operations.md`.
- Use existing aggregate observations. This ticket adds no benchmark suite.

## Acceptance criteria

- [ ] The evidence and chosen value are recorded. Preview and production configs set `limits.cpu_ms`, and a config test covers it.
- [ ] Deploying to preview succeeds before production uses the limit.

## Comments

- 2026-10-12: Published as an evidence-gated child of 53.
