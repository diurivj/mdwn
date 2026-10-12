# Workers Paid: mdwn's $5 target and $10 ceiling

Checked **2026-10-11**, using the environment's `date` and current official Cloudflare documentation. Prices are USD, before applicable tax. Scope: pricing and limits, not an implementation or architecture review. Assumed stack supplied by the maintainer: React Router 8, Workers, production and preview D1 databases, a 15-minute retention cron, no R2/Queues/Durable Objects bindings, and blanket request logs disabled.

**Implementation scope:** the maintainer-approved direction and lean verification requirements are recorded in [Budgeted Workers Paid adoption](../../../docs/workers-paid-plan.md), published as [spec ticket 53](../issues/53-workers-paid-plan-spec.md). This research also records optional future opportunities; they are not all included in that implementation effort. No new recurring remote rehearsals, monitoring service, or routine resource provisioning is required.

## Bottom line

- **$5/month is a plausible operating cost, not a spending cap.** Workers Paid costs $5 per account plus usage overages. Included allowances are separate meters, not a transferable $5 credit. It is not $5 per Worker or database. [Workers pricing][workers-pricing]
- **There is no documented hard account-wide $5/$10 spending cutoff for this pay-as-you-go setup.** Paid requests are uncapped; budget alerts explicitly do not pause or cap usage. A strict “never charge more than $10” requirement cannot be guaranteed by upgrading, setting alerts, or setting a CPU limit. [Workers limits][workers-limits] · [Budget alerts][alerts]
- Paid's relevant benefits are CPU headroom, larger D1 capacity, much larger monthly database allowances instead of daily quota outages, and longer recovery history. It does not inherently require more tracking. Aggregate usage metrics can support budgeting without enabling blanket request logs. [Workers metrics][workers-metrics] · [D1 metrics][d1-metrics]

Repository evidence, checked against the current checkout: `docs/import.md:351` records Free-plan `exceededCpu` failures during worst-case staging, subsequently optimized; `docs/operations.md:429` records D1 Free write-quota error 7500 during repeated restore rehearsals. These are concrete reasons to value headroom—not evidence that current production traffic needs Paid or will remain below $10.

## Core rate card

`M` = million; `B` = billion. Monthly quantities are per billing period, not necessarily calendar month. Production, preview, and other projects on the same account must be included in the budget; D1 explicitly sums storage across all databases. [Workers pricing][workers-pricing] · [D1 pricing][d1-pricing]

| Meter | Workers Free | Workers Paid: included, then overage |
| --- | --- | --- |
| Base subscription | $0 | $5/month/account |
| [Worker requests][workers-pricing] | 100,000/day | 10M/month; **$0.30/M** extra |
| [Worker CPU][workers-pricing] | 10 ms/invocation | 30M CPU-ms/month; **$0.02/M CPU-ms** extra |
| [Static Assets][assets] | Free, unlimited requests | Free, unlimited requests; routing caveat below |
| [D1 rows read][d1-pricing] | 5M/day | 25B/month; **$0.001/M** extra |
| [D1 rows written][d1-pricing] | 100,000/day | 50M/month; **$1/M** extra |
| [D1 stored data][d1-pricing] | 5 GB total/account, subject to per-DB cap | First 5 GB included; **$0.75/GB-month** extra |

Workers do not charge for ordinary wall-clock waiting or egress; D1 likewise has no egress charge. CPU means actual execution, not time waiting for D1/network responses. Serializing results and other Worker computation still consume CPU. [Workers pricing][workers-pricing] · [CPU limits][workers-limits] · [D1 pricing][d1-pricing]

### CPU and static-asset qualifications

- **HTTP CPU:** Free allows 10 ms/invocation. Paid defaults to **30,000 ms (30 seconds)** and permits up to **300,000 ms (5 minutes)**. Paid Standard supports a lower per-Worker `limits.cpu_ms`, such as the documentation's 100 ms example. These limits apply on Cloudflare's network, not local development; occasional overrun flexibility means they are not exact accounting cutoffs. Choose a limit from measured worst cases, not the 30-second default merely because it is available. [CPU limits][workers-limits] · [Wrangler limits][wrangler-limits]
- **This 15-minute cron:** the owning limits page specifies **30 seconds CPU** for Paid cron intervals below one hour; intervals of at least one hour get 15 minutes CPU. Cron wall-clock duration has a separate 15-minute limit. Do not apply the pricing page's generic “up to 15 minutes” summary to this schedule. Cron invocations consume Workers requests and CPU; 96 runs/day means 2,880 runs in a 30-day example. [Limits][workers-limits] · [Cron pricing example][workers-pricing]
- **Static means served without dynamic execution:** direct Static Assets requests and asset storage are free. SSR/API requests and `run_worker_first` invocations are billable even if they eventually return an asset. Additionally, current Workers pricing explicitly says requests served through the optional **Workers Caching** feature are billable, including cached assets; cache hits avoid CPU, not that request meter. Routing/configuration must be checked before assuming every JS/CSS/document request is free. [Static Assets billing][assets] · [Workers pricing, footnote 4][workers-pricing]

### D1: what actually changes

- **Per-database capacity:** Free **500 MB** → Paid **10 GB**. Paid does not give each database 5 GB of free storage: the included 5 GB is shared. Paid's default account storage limit is 1 TB, not unlimited capacity. [D1 limits][d1-limits] · [D1 pricing][d1-pricing]
- **Query budget:** Free **50** → Paid **1,000 D1 queries per Worker invocation**. This relaxes batch-planning constraints, not the database's 30-second query/batch timeout. [D1 limits][d1-limits]
- **Unchanged payload limit:** maximum string, BLOB, or complete table row remains **2,000,000 bytes** on either plan. Paid does not enlarge this ceiling; ciphertext/encoding and other row fields must fit. mdwn's smaller 256 KiB source / 512 KiB ciphertext limits are application policies that could be reconsidered separately, with schema, browser, protocol, and performance verification. [D1 limits][d1-limits] · `.scratch/mdwn/wayfinder/23-lock-normal-file-size-and-storage.md`
- **Time Travel:** Free **7 days** → Paid **30 days**; always enabled, with no additional charge for history or restores. This also means deletion from the live database does not immediately remove its recoverable historical state. [D1 limits][d1-limits] · [Time Travel][time-travel]
- **Free fails; Paid meters:** exhausting either Free daily read/write quota prevents queries until reset at 00:00 UTC. Exhausting Free storage prevents further growth operations until space is recovered. Paid bills additional reads, writes, and storage instead of stopping at the included allowance; hard database/runtime limits still apply. [D1 pricing][d1-pricing]
- **Count scanned/changed rows, not queries or documents.** Deletes count as writes; index maintenance adds writes and indexes consume storage. Restore imports and index creation also consume allowances. Repeated retention scans, cleanup, and rehearsals count even with no human visitors. [D1 pricing][d1-pricing]

## Illustrative envelopes—not forecasts

All examples assume Paid Standard, no other account charges, and D1 totals across production **and** preview. They exclude tax and domain costs.

**A $5 envelope, over 30 days:**

- 1M dynamic HTTP requests × 10 ms average CPU = 10M CPU-ms.
- 2,880 cron invocations × 100 ms average CPU = 288,000 CPU-ms.
- Total: 1,002,880 requests and 10.288M CPU-ms, both inside the included allowances.
- D1: 2 GB stored throughout the period, 10M rows read, and 1M rows written, including cron, indexes, and preview work—all inside allowances.
- Directly served static assets add $0. **Estimated subtotal: $5.** Inputs are hypothetical, not measured mdwn usage. [Applicable rates][workers-pricing] · [D1 rates][d1-pricing]

**A $10 envelope / CPU caution:** if total requests stay at or below 10M and D1 stays wholly inside its included allowances, **280M CPU-ms** uses exactly $5 of CPU overage: `(280M − 30M) / 1M × $0.02`. Together with the subscription, that is **$10 before tax**, with no safety margin. At 10M total invocations, 20 ms average CPU gives **$8.40**, but 30 ms gives **$10.40**, despite no request overage. All invocations, including cron, must be included. [Workers pricing][workers-pricing]

Storage/writes compete for that same $5 headroom: a combined 10 GB stored for the full month adds **$3.75**; 5M writes above the 50M included allowance adds **$5**. Neither leaves the original CPU budget intact. [D1 pricing][d1-pricing]

## Practical budget guardrails and their limits

1. **Alert on overage, not the intended invoice total.** The Billable Usage dashboard shows usage overages and excludes fixed subscription fees. With only the $5 Workers subscription, a $5 overage alert already corresponds to roughly $10 before tax; a $10 alert is not a $10 total-budget alarm. Consider early $1 and $3 overage warnings, reserving room for taxes/other charges. Current alert documentation describes cumulative usage spend; alerts do not stop service. Billing visibility is daily, not a real-time circuit breaker. [Billable Usage][billable-usage] · [Budget alerts][alerts]
2. **Reduce worst-case consumption, but do not call it a hard budget.** A measured CPU cap and bounded work reduce per-invocation exposure; they do not cap invocation count, accumulated storage, or database writes. Even Workers' rate-limiting binding is local to each Cloudflare location, eventually consistent, and explicitly not an accurate accounting system. [Wrangler limits][wrangler-limits] · [Rate Limiting API][rate-limits]
3. **Use aggregate metrics while preserving the logging policy.** Reconcile account billing totals with Worker request/CPU metrics and D1 rows read/written/storage. CPU percentile charts are sampled distributions, not a substitute for billable CPU totals. D1 query counts are not billing row counts. No blanket request logging is needed for this budget check. [Workers metrics][workers-metrics] · [D1 metrics][d1-metrics] · [Billable Usage][billable-usage]

## Project-specific opportunities and recommended order

These are proposals, not changes to the current product contract. No production account, application code, or Cloudflare configuration was changed.

1. **Budget safeguards before expanding features.** `wrangler.jsonc` currently has no explicit `limits.cpu_ms`; choose one only after measuring import, authentication, normal API, and maintenance workloads. Track account-wide usage, set early overage alerts, and design aggregate/per-Account ciphertext storage and expensive-operation quotas. Preserve emergency headroom for export, revocation, and deletion; do not confuse an application circuit breaker with an invoice cap. Keep blanket logs disabled.
2. **Adopt Paid as the operational baseline, not a new architecture.** Revise the Free-only commitments in ADRs 0002/0005/0006, the buildable spec, and remote proof instructions before relying on Paid. Keep Workers + D1, indexed queries, bounded batches, and the existing atomic-import design. Paid raises failure thresholds; it does not inherently execute the same code faster.
3. **Larger practical imports.** Current bounds are 100 source nodes, 8 MiB compressed, 16 MiB expanded, and 20 MiB encrypted staging (`docs/import.md`, `app/shared/import/limits.ts`). A 500–1,000-node target is worth benchmarking, not a promised safe replacement value. Coordinate staging/manifest/schema limits and browser memory tests; retain all-or-nothing visibility and retry behavior. Paid still has 128 MB Worker memory, so simply enlarging every buffer is not the solution. [Workers limits][workers-limits]
4. **Cleanup that finishes after closing the tab.** Public unpublishing currently seals access immediately, then requires an Owner browser to drive 200-Comment deletion batches (`docs/publications.md:212`). An authorized, irreversible seal could hand off physical cleanup to bounded Cron/Queue work. Directory deletion currently rejects subtrees over 500 nodes (`docs/tree-structure.md:27`); resumable sealed deletion is a separate product/protocol project, not a larger constant. Existing Cron may suffice without another service. Neither change lets the server perform key rotation, provisioning, encryption, or export: those still require browser-held keys.
5. **Revisit user-facing abuse-policy friction, cautiously.** `app/shared/security/abuse-policy.ts` permits only 5 Publication creations/rotations per Account per day, 30 public Comment mutations per Account per day, and 300 globally per day. The fixed-Free motivation can be revisited with metrics and the unchanged abuse/privacy requirements. Paid is not a reason to remove rate limits or signup protection.
6. **Better operational recovery.** Use the longer Time Travel window, routine restore rehearsals, and eventually protected scheduled database exports with a separately retained copy. This improves disaster recovery, not user-visible File history, and requires a deliberate retention/security policy (`docs/operations.md`, `docs/adr/0002-cloudflare-workers-and-d1.md`). An R2 copy in the same Cloudflare account alone is not protection against losing that account.

**Later, if wanted:** browser-encrypted attachments in R2 could fit a small budget under strict quotas. Live Comment/File change notifications could start with modest visible-tab refresh rather than adding an always-active Durable Object service. Attachments, notifications, full collaboration, and version history are currently explicit MVP exclusions (`docs/buildable-spec.md:28–48`), not features automatically unlocked by payment. R2, Queues, and SQLite Durable Objects also have Free offerings today; paying is not their universal technical prerequisite.

**Keep the privacy boundary:** browser-only content/key handling, no plaintext server-side search or SSR, no blanket request logs, explicit revocation, and hard-deletion semantics remain independent of the hosting price (`docs/adr/0001-end-to-end-content-privacy.md`, `docs/adr/0003-client-held-content-keys-and-capabilities.md`). Do not rip out staged imports merely because a larger D1 batch is now possible.

## Optional products: brief check, not a recommendation to add them

None is a binding in the supplied stack. Their availability does not mean they are necessary, nor that all usage becomes free with Paid.

| Product | Current allowances and rates | Budget risk |
| --- | --- | --- |
| **R2 Standard** | Separate R2 subscription/checkout, free to start independently of Workers Paid. Monthly free tier: **10 GB-month**, **1M Class A**, **10M Class B** operations. Above it: **$0.015/GB-month**, **$4.50/M Class A**, **$0.36/M Class B**. Direct R2 egress is free. [R2 setup][r2-setup] · [R2 pricing][r2-pricing] | Writes/listing are Class A; reads/HEAD are Class B. Free egress does not mean free requests or free Worker execution. These allowances are for Standard, not Infrequent Access. |
| **Queues** | Available on **Free: 10,000 operations/day**, fixed 24-hour retention. **Paid: 1M operations/month**, then **$0.40/M**; retention defaults to 4 days, configurable up to 14. [Queues pricing][queues-pricing] | A normally delivered message fitting one 64 KB chunk costs **3 ops**: write/read/delete. Chunk size includes metadata; batches do not discount per-message operations. Retries add reads. Consumer Worker requests/CPU are additional meters. [Consumer billing][queue-consumers] |
| **SQLite Durable Objects: compute** | Available on **Free: 100,000 requests/day and 13,000 GB-s/day**. **Paid: 1M requests/month**, then **$0.15/M**; **400,000 GB-s/month**, then **$12.50/M GB-s**. [DO pricing][do-pricing] | Duration is active/non-hibernatable wall-clock time at the allocated 128 MB, not Workers-style CPU-only billing. Current pricing rounds excess duration up to a million GB-s: a duration overage can therefore add **$12.50**, breaking this budget by itself. |
| **SQLite Durable Objects: storage** | Free/Paid row-read and row-write allowances/rates match the D1 row figures above. **5 GB** included storage; Paid excess storage is **$0.20/GB-month**. Free supports SQLite-backed DOs; legacy KV-backed DOs require Paid. [DO pricing][do-pricing] | Storage/compute/request meters are separate. Workers calling DOs also incur their normal Worker costs. |

**Hibernating sockets:** an idle, hibernation-eligible DO incurs no duration charge while retaining its sockets. Ordinary WebSocket `accept()` can keep duration billing active for the entire connection. Hibernation does not waive active handling, storage, or request charges: incoming WebSocket messages use a 20:1 billing ratio; outgoing messages are free. [DO pricing][do-pricing]

Workflows is not germane to the supplied ordinary retention cron, so it is not budgeted here. AI inference is separately usage-priced, not unlimited with the $5 upgrade; model prices are outside this note's scope.

## What the $5 upgrade does not buy—and what remains unknown

Workers Paid is separate from zone plans such as Pro/Business and from other product subscriptions. It does not require upgrading the site's zone plan. Domain registration/renewal and applicable taxes must be budgeted separately; $5 before tax cannot promise $5 actually charged. [Workers plan separation][workers-pricing] · [Billing structure][billing] · [Sales tax][tax]

Without account access and actual metrics, this research cannot establish:

- Whether the account uses current Standard pricing or a legacy Workers model, or what other subscriptions/projects consume shared allowances.
- Actual total requests/CPU, import and cron worst cases, D1 scans/index writes, combined database storage/growth, or which asset requests invoke billable execution.
- The applicable tax, domain renewal charges, and remaining billing-cycle headroom.
- That any per-request cap is safe for mdwn, that Free will avoid quota outages, or that Paid will never exceed $5/$10 under abuse or unexpected load.

**Decision boundary:** $5 is a credible measured operating target; $10 is a monitoring/intervention target, not a Cloudflare-enforced account spending ceiling.

[workers-pricing]: https://developers.cloudflare.com/workers/platform/pricing/
[workers-limits]: https://developers.cloudflare.com/workers/platform/limits/
[wrangler-limits]: https://developers.cloudflare.com/workers/wrangler/configuration/#limits
[assets]: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
[d1-pricing]: https://developers.cloudflare.com/d1/platform/pricing/
[d1-limits]: https://developers.cloudflare.com/d1/platform/limits/
[time-travel]: https://developers.cloudflare.com/d1/reference/time-travel/
[alerts]: https://developers.cloudflare.com/billing/manage/budget-alerts/
[billable-usage]: https://developers.cloudflare.com/billing/manage/billable-usage/
[billing]: https://developers.cloudflare.com/billing/understand/how-billing-works/
[tax]: https://developers.cloudflare.com/billing/understand/sales-tax/
[workers-metrics]: https://developers.cloudflare.com/workers/observability/metrics-and-analytics/
[d1-metrics]: https://developers.cloudflare.com/d1/observability/metrics-analytics/
[rate-limits]: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
[r2-pricing]: https://developers.cloudflare.com/r2/pricing/
[r2-setup]: https://developers.cloudflare.com/r2/get-started/
[queues-pricing]: https://developers.cloudflare.com/queues/platform/pricing/
[queue-consumers]: https://developers.cloudflare.com/queues/configuration/consumer-concurrency/
[do-pricing]: https://developers.cloudflare.com/durable-objects/platform/pricing/
