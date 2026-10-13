# 63: Explicit Worker CPU ceiling

**What to build:** Set an explicit `limits.cpu_ms` for the preview and production Workers, chosen from workload evidence, so a runaway invocation cannot consume the large Paid default.

**Type:** configuration

**Status:** ready-for-agent

**Blocked by:** the maintainer confirming that the account's Workers Paid subscription is active (Free rejects a configured CPU limit), and supplying CPU-time evidence: dashboard percentiles for authentication, ordinary private routes, the largest Import requests and the scheduled handler.

**Related:** [53](53-workers-paid-plan-spec.md); [`docs/workers-paid-plan.md`](../../../docs/workers-paid-plan.md) §1 ("Select an explicit CPU ceiling…"); [62](62-workers-paid-operating-contract.md).

## Scope

- Choose a ceiling with headroom above the observed worst case for every route class, including scheduled teardown from [61](61-autonomous-public-cleanup.md). Do not adopt the Paid default merely because it exists, and do not pick a low cap that recreates Free-tier failures.
- Configure it per environment in `wrangler.jsonc`. Document the evidence, the chosen value and how to roll it back in `docs/operations.md`.
- Use existing aggregate observations. This ticket adds no benchmark suite.

## Acceptance criteria

- [x] The evidence and chosen value are recorded. Preview and production configs set `limits.cpu_ms`, and a config test covers it.
- [ ] Deploying to preview succeeds before production uses the limit.

## Comments

- 2026-10-12: Published as an evidence-gated child of 53.
- 2026-10-13: Evidence supplied and implemented. The maintainer confirmed the account's **Workers Paid** plan is active (R2 Paid and Image Stream Basic are separate subscriptions), and supplied the production `mdwn` CPU-time percentiles for the preceding 30 days: p50 6.24 ms, p90 24.73 ms, p99 58.68 ms, p99.9 71.75 ms across 38.34K invocations with no errors. A live `wrangler tail` sample of the 15-minute scheduled handler measured 9 ms CPU. The largest Import upload/commit remains inside Workers Free's 10 ms CPU allowance (2026-10-05 proof, `docs/import.md`), so the 50–70 ms tail is consistent with full-document SSR rather than an API route.
  - Chosen value: **500 ms** in `wrangler.jsonc` for `preview` and `production`; the never-deployed local Worker has no limit. `tests/wrangler-config.test.ts` covers it per environment. Evidence, rationale and the rollback are recorded in `docs/operations.md#worker-cpu-ceiling`.
  - The deploy workflow runs preview (migrate, deploy, smoke-test) before production on merge, which is the acceptance criterion's preview-first order; the deploy itself remains a maintainer action.
