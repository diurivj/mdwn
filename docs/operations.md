# Retention and D1 operations

Ticket [31](../.scratch/mdwn/issues/31-retention-and-operations.md); [ADR-0002](adr/0002-cloudflare-workers-and-d1.md).

## Workers Paid operating policy

Ticket [62](../.scratch/mdwn/issues/62-workers-paid-operating-contract.md);
[Budgeted Workers Paid adoption](workers-paid-plan.md) §1–2 and §5; pricing
facts from the [Workers Paid research](../.scratch/mdwn/research/workers-paid-budget.md),
checked 2026-10-11 against the Cloudflare pages cited below. Prices are USD
before tax.

Workers Paid is mdwn's **operating baseline** (maintainer decision, 2026-10-12;
the account's Workers Paid plan was confirmed active on 2026-10-13). The
[Worker CPU ceiling](#worker-cpu-ceiling) below requires it: Free rejects
`limits.cpu_ms`. This document does not record configured billing alerts. Keep
every current product bound: paying changes neither the Import, rate or source
limits nor the privacy model. The
[D1 scripting reference](operations/d1-scripting.md#per-invocation-queries)
records the per-invocation query facts for each plan.

**Budget.** Target about **$5 per month**: the Workers Paid subscription with
usage inside the included allowances. **$10 per month** is the intended
maximum and the intervention boundary, not an enforced limit.

**Neither alerts nor application limits cap the invoice.** Workers Paid is
metered, and Cloudflare documents no account-wide hard spending cutoff for this
pay-as-you-go setup: Paid requests are uncapped, and budget alerts explicitly
do not pause or cap usage ([Workers limits][workers-limits],
[budget alerts][alerts]). Billing data is daily, not a real-time circuit
breaker. A CPU limit, rate limit or application rejection reduces what one
invocation or one Account can consume; it caps neither the number of
invocations nor accumulated storage or rows written, and an early rejection
can still be a billed request. Never describe an estimate, alert or
application limit as a spending cap. If an absolute billing guarantee is ever
required, stop capacity expansion and surface the mismatch instead.

### What the invoice contains

Keep these apart; the operating estimate covers only the first two.

| Part | What it is |
| --- | --- |
| Fixed fees | Workers Paid is **$5/month per account** — not per Worker or database. Other subscriptions (a zone plan, a separately started product) are further fixed fees. The Billable Usage view excludes fixed fees ([Billable Usage][billable-usage]). |
| Usage overages | Charges for each meter beyond its included monthly allowance (below). |
| Taxes | Applied by jurisdiction on top of both ([sales tax][tax]). Every figure here is before tax, so "$5" cannot promise $5 charged. |
| Domain costs | Registration and renewal are billed separately from Workers ([how billing works][billing]). |

| Meter | Included with Workers Paid | Overage |
| --- | --- | --- |
| Worker requests | 10M/month | $0.30/M |
| Worker CPU | 30M CPU-ms/month | $0.02/M CPU-ms |
| D1 rows read | 25B/month | $0.001/M |
| D1 rows written | 50M/month | $1.00/M |
| D1 stored data | 5 GB | $0.75/GB-month |

Sources: [Workers pricing][workers-pricing], [D1 pricing][d1-pricing]. Static
assets served without Worker execution are free; SSR, API and
`run_worker_first` requests are billable even when they return an asset
([Static Assets billing][assets]). D1 bills scanned and changed rows, not
queries: deletes, index maintenance, retention scans, restore imports and
rehearsals all count.

### Account-wide allowances

Included allowances belong to the **account**, shared by every Worker,
database and project on it: production and preview, both environments' Cron
(96 invocations a day each, 2,880 per 30 days), Import staging, restore
rehearsals, Import proofs, and any non-mdwn project. D1 storage is summed across
all databases. Attribute mdwn's share separately from account totals; never
compare an mdwn-only estimate against the account invoice or count one
allowance twice.

### Early warnings

Use the provider's own billing notifications; mdwn adds no billing poller or
dashboard. Starting points are **$1 and $3 of usage overage**. Because the
Billable Usage view and its alerts measure overage and exclude the $5
subscription, those correspond to roughly $6 and $8 before tax only when Workers
Paid is the account's sole subscription; adjust them for actual taxes and other
subscriptions rather than treating $6/$8 as invoice totals. A $5 overage alert
already means about $10 before tax. Alerts notify; they do not stop service
([budget alerts][alerts], [Billable Usage][billable-usage]). Creating them is an
operator change that needs explicit authorization; this document does not
claim they exist.

### Operator checklist

1. **Confirm the account's actual plan and usage model**: Free or Workers
   Paid, and current Standard pricing or a legacy model. A decision to pay is
   not evidence of a subscription. Record only the date and the result in the
   ticket, never account identifiers or billing details.
2. List other subscriptions and projects on the account that share
   allowances or add fixed fees.
3. Read current Billable Usage, Worker requests and CPU
   ([Workers metrics][workers-metrics]) and D1 rows read, rows written and
   storage ([D1 metrics][d1-metrics]) for production and preview. Aggregate
   metrics suffice; do not enable blanket request logs.
4. With authorization, create the $1 and $3 overage alerts.
5. Note the applicable tax treatment and domain renewal dates as separate
   line items.
6. Recheck each billing cycle, and before any capacity change.

### Intervention runbook

When an overage alert fires, or the month's total approaches $10:

1. **Inspect the affected meter.** Find which meter (requests, CPU, rows
   written, rows read, storage) and which Worker, database or project drives
   it, using Billable Usage and aggregate metrics. Diagnose with aggregate SQL
   counts; never enable blanket logs or persist identifiers or ciphertext.
2. **Stop discretionary work**: Import proofs, restore rehearsals, preview
   load, benchmarks and other optional remote runs.
3. **Restrict growth-producing operations** as appropriate — for example a
   reviewed change that tightens an existing rate limit or pauses new Imports
   or signups.
4. **Keep data-exit and security operations available** while the platform
   is: export, Hard deletion, Unpublishing and its scheduled teardown, Session
   revocation, sign-out and recovery.
5. Record the meter, cause and action in aggregate terms.

There is no automatic spending controller; every step is an operator decision.

### Worker CPU ceiling

Ticket [63](../.scratch/mdwn/issues/63-worker-cpu-ceiling.md). Both deployed
Workers set `limits.cpu_ms` in `wrangler.jsonc`; the never-deployed local
Worker does not. Limits are enforced only on Cloudflare's network and only on
the Standard usage model ([Wrangler configuration][wrangler-config]): local
`wrangler dev` ignores the value, and a Free account cannot configure one.

**Chosen value: 500 ms.** Evidence recorded 2026-10-13 from the production
`mdwn` Worker over the preceding 30 days: CPU time per execution p50 6.24 ms,
p90 24.73 ms, p99 58.68 ms, p99.9 71.75 ms across 38.34K invocations with no
errors. One live `wrangler tail` sample of the 15-minute scheduled handler
measured 9 ms CPU; the aggregate p99.9 already bounds every route class, so that
single sample is context rather than the basis. The largest Import
upload/commit still fits inside Workers Free's 10 ms CPU allowance (the
2026-10-05 proof in [import](import.md)), so its measured cost is below that
bound; the 50–70 ms tail is consistent with full-document SSR rather than an
API route. The dashboard reports CPU percentiles per Worker, not per route,
and this project keeps Workers Logs disabled (no blanket invocation logs), so
the aggregate p99.9 is the evidence for every route class.

500 ms is about 7x the observed p99.9, while bounding one runaway invocation to
0.5 CPU-seconds — 60x below the Paid 30 s default. For a fixed 100,000 runaway
invocations that is about $0.40 over the included 30M CPU-ms against about $59
at the default. The limit bounds each invocation, not the number of them, so a
sustained attack still needs the [intervention runbook](#intervention-runbook).
It is deliberately generous for the first weeks of real traffic.

**Rollback.** If Cloudflare reports `exceededCpu` (an invocation killed before
completion), raise the value in `wrangler.jsonc` — 1000 ms is the next step —
or delete the `limits` line, then merge and redeploy. Re-read the percentiles
after a few weeks of real traffic and tighten only against observed evidence;
the intent is a bound above the worst case, not the smallest possible number.

### Paid D1 capacity and Time Travel

What Workers Paid changes for D1:

- **10 GB per database.**
- **5 GB of storage included and shared** across the account's databases,
  then billed; 1 TB default account storage limit.
- A higher [per-invocation query limit](operations/d1-scripting.md#per-invocation-queries).
- **30 days of Time Travel.**
- Monthly row allowances that bill overage, where Free exhausts a daily quota
  and fails until 00:00 UTC.

Sources: [D1 limits][d1-limits], [D1 pricing][d1-pricing],
[Time Travel][time-travel]. The Free limits, and the per-statement, per-row and
query-duration limits that do not change, are recorded in the
[D1 scripting reference](operations/d1-scripting.md#limits).

Time Travel is always on and has no extra charge. It is **operational
recovery** for a bad migration or manual repair (see
[Migration rollback rehearsal](#migration-rollback-rehearsal)): not
user-visible File history, not a restore feature, and a restore rolls back
every intervening write. Live deletion — Hard deletion, Unpublishing teardown,
retention — does not immediately erase provider history: deleted rows stay
restorable by the operator for the plan's Time Travel window. No new backup
system is added, and the plan change alone does not require a new restore
rehearsal.

[workers-pricing]: https://developers.cloudflare.com/workers/platform/pricing/
[workers-limits]: https://developers.cloudflare.com/workers/platform/limits/
[assets]: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
[d1-pricing]: https://developers.cloudflare.com/d1/platform/pricing/
[d1-limits]: https://developers.cloudflare.com/d1/platform/limits/
[time-travel]: https://developers.cloudflare.com/d1/reference/time-travel/
[alerts]: https://developers.cloudflare.com/billing/manage/budget-alerts/
[billable-usage]: https://developers.cloudflare.com/billing/manage/billable-usage/
[billing]: https://developers.cloudflare.com/billing/understand/how-billing-works/
[tax]: https://developers.cloudflare.com/billing/understand/sales-tax/
[workers-metrics]: https://developers.cloudflare.com/workers/observability/metrics-and-analytics/
[wrangler-config]: https://developers.cloudflare.com/workers/wrangler/configuration/#limits
[d1-metrics]: https://developers.cloudflare.com/d1/observability/metrics-analytics/

## Scheduled retention

`wrangler.jsonc` schedules the same Worker handler every 15 minutes in local,
preview, and production. `workers/app.ts` calls
`app/retention/scheduled-maintenance.server.ts`, which runs each duty in order
— security retention first, then sealed Unpublishing teardown — and isolates
them: a duty that throws is reported, and the remaining duties still run. After
all duties the invocation fails if any duty failed, so the Cron outcome still
shows it. Reports are content-free: one fixed `console.error` line per failed
duty (`Scheduled maintenance duty failed: <duty>`) and a thrown
`Scheduled maintenance failed: <duties>`, never the underlying error, SQL,
identifiers, ciphertext or counts. Blanket request logs/traces remain disabled
under the privacy policy.

The handler removes:

- Expired counters, Security events, and category-only Public Comment reports;
  expired Network buckets are cleared even on retained Security events.
- Expired registration challenges and consumed mutation proofs.
- **Every** expired WebAuthn purpose, routine/Recovery enrollment, and Session.
  A revoked Session or a restricted Recovery Session older than five minutes is
  also unusable. Its ceremonies/staging are effectively expired even if their
  own expiry is later; they are removed before the Session's RESTRICT FK parent.
- Expired Import staging, including committed-session manifests, per-kind
  counts, records, and chunks. One atomic pass drains the three oldest eligible
  Imports (at most 120 chunks / 60 MiB / 6,000 descriptors); an expired parent
  Session remains non-authorizing until all its remaining Imports drain.
- Bounded expired-Grant envelope/provisioning dependents, **not** the Grant's
  write seal or a cryptographic job. Browser-authorized rotation still owns that
  lifecycle (`app/sharing/grant-expiry.server.ts`).
- One batch of an Unpublishing the Owner already sealed: the least recently
  attempted pending teardown's next bounded batch (at most 200 Public Comments, or the final
  transaction once none remain). Only a `deleting` Publication with its
  teardown row qualifies; no Session, Device proof or key is used. See
  [Publications](publications.md#scheduled-completion).

No retention statement deletes current Files, representations, envelopes,
Recovery capsules, registry/devices, passkeys, active Grants, active
Publications, Private Comments, or Import commit markers; Public Comments and
other Public material are removed only for a Publication the Owner sealed. `import_commits` is durable visibility
metadata, not staging authority. Migration 0027 removes its FK to the ephemeral
Import session, reinstalls the immutable-marker trigger after the rebuild, and
checks its originating session/account/target with an INSERT trigger instead.
Removing staging can no longer hide committed nodes or indefinitely retain an
expired authentication Session.

One-use WebAuthn, registration, and Recovery-enrollment lifetimes are capped at
600,000 ms by INSERT **and UPDATE** guards; migration 0027 shortens any overlong
legacy records. Normal issuance uses five minutes; routine enrollment already
has a ten-minute CHECK. Expiry ends authority immediately; **physical deletion
follows the next successful Cron**, with additional passes for an Import backlog.
It is not a promise of physical erasure at the exact challenge-expiry instant.
Security-event writes reserve one 15-minute Cron interval before the 30-day
retention maximum, including the event's Network-bucket headroom. Provider Time
Travel/backups are outside application-level deletion.

### Scheduled bounds and D1 budget

The account's Workers Paid plan is confirmed active (2026-10-13), so every duty
together is budgeted against the Paid
[per-invocation query limit](operations/d1-scripting.md#per-invocation-queries),
counting every batched statement. The per-duty statement table and its
worst-case total live beside the duty list in
`app/retention/scheduled-maintenance.server.ts`; raising a bound or adding a
duty must keep that total within the limit. The statement-budget test in
`tests/worker/scheduled-teardown.test.ts` counts a real worst-case invocation
(a pending final teardown transaction plus an expired Grant drain).

Teardown throughput is one batch per run (at most 200 Public Comments, or one
final transaction): a backlog eventually drains, but no deletion deadline is
promised. Each run first records an attempt on its target, which commits even
if the batch then fails, and the next run picks the least recently attempted
sealed Publication. A Publication whose batch keeps failing stays sealed and
retryable without holding up the others.

### Verify maintenance

```sh
npx --no-install vitest run --config vitest.workers.config.ts \
  tests/worker/retention.test.ts tests/worker/abuse-controls.test.ts \
  tests/worker/scheduled-teardown.test.ts
```

These are real workerd/D1 scheduled-event tests: expired/live mixtures,
FK-dependent ceremonies and Imports, committed content and current envelopes,
proof/challenge retention, idempotence, and repeated bounded backlog progress.

On local Vite/Wrangler development only, invoke
`/cdn-cgi/local/scheduled?format=json`. This is a runtime test endpoint, **not** a
production route. In the deployed Worker's **Settings → Trigger Events → View
events**, check that the Cron outcome succeeds every 15 minutes. Cron Events
needs no request-body logging. A failed/missed run invalidates the timing
headroom; repair it immediately and check backlog counts using aggregate SQL,
never enable blanket logs or persist ciphertext/identifiers in diagnostics.

## Smart Placement

The preview and production Workers set `placement: { "mode": "smart" }` in
their `env` blocks of `wrangler.jsonc` (ticket 57); the never-deployed local
Worker does not, so `npm run build` and the browser harness are unchanged.
`tests/wrangler-config.test.ts` asserts this through Wrangler's own config
resolution.

- **What it does.** Cloudflare may run the Worker's fetch handler in a
  location close to its back end, here D1 (`mdwn-db-production` is in WNAM),
  instead of the colo that received the request. Every private page makes
  several sequential D1 reads, so fewer cross-region round trips matter more
  than edge proximity. It affects fetch handlers only: the 15-minute
  `scheduled` retention handler is unchanged. On low traffic Cloudflare may not
  have enough requests to decide and reports `INSUFFICIENT_INVOCATIONS`; the
  Worker then keeps running at the receiving colo, which is today's behavior.
- **Verify after a deploy.** Responses from a placed Worker carry a
  `cf-placement` header (`local-<colo>` or `remote-<colo>`), for example
  `curl -sI https://mdwn.me/api/auth/session | grep -i cf-placement`. The
  Worker's Settings page in the dashboard shows the placement status
  (`SUCCESS`, `INSUFFICIENT_INVOCATIONS`, or an error). Compare the TTFB of a
  small API response before and after.
- **Roll back.** Remove the `placement` block from both environments, merge,
  and let the `deploy` workflow redeploy. Nothing else depends on it.

D1 read replication stays disabled (ticket 57's decision 4): a lagging replica
could still serve a read after a revocation or device removal, so it needs its
own design for consistent authorization first.

## Foreign keys and query plans

```sh
npm run db:operations -- --output /tmp/mdwn-local-plans.md
npm run db:operations -- --remote preview --output /tmp/mdwn-preview-plans.md
npm run db:operations -- --remote production --output /tmp/mdwn-production-plans.md
```

Local mode migrates a fresh **disposable** local D1 and prints its state path;
clean it up with `trash <path>` when inspection is finished. Remote mode is
**read-only** and never applies a migration. Missing post-0027/0029 schema fails
verification; do not apply unreviewed migrations to make that check pass.

Both modes require `PRAGMA foreign_keys = 1` and an empty
`PRAGMA foreign_key_check`. D1 enforces FKs by default; setting
`PRAGMA foreign_keys = OFF` cannot disable them. `defer_foreign_keys` only defers
checks inside one transaction. The migration smoke check now verifies effective
FK state as well as schema declarations. The deploy workflow runs the operations
check against preview and production after reviewed migrations land.

The reviewed [EXPLAIN output](operations/query-plans.md) covers all 22
representative metadata hot paths. SQL and expectations live in
`scripts/lib/d1-query-plans.mjs`; workerd and remote checks execute identical SQL.
The workerd gate also compiles the actual production `accountAccessQuery`.
SQLite may prefer a unique point index over a larger covering index on a small
or unanalyzed table. The artifact reports **both the actual selected plan and a
separately labelled INDEXED BY covering probe**; it does not misrepresent the
probe as the planner's choice. Primary-key payload fetches remain intentional:
512 KiB ciphertext is never duplicated into indexes.

Reviewed results:

- Child indexes begin with `parent_node_id`; `vault_nodes_parent_idx` covers
  recursive child enumeration, including the Import visibility predicate.
- Exact recipient/target/Owner Grant probes and the production recursive access
  query use `grants_recipient_target_idx`. Ancestors are bounded to 100 edges /
  101 nodes. Collaborator overflow/unrooted ancestry fails closed.
- Directory hard deletion uses the production depth-first cursor from
  `app/shared/tree/subtree.server.ts`: one indexed successor child per step, at most
  501 candidate nodes (including the root/overflow sentinel) and 1,001 cursor
  states. The recursive queue has one successor; a wide Directory cannot
  enqueue all its children before the output cap. Hidden Import candidates
  count toward the safety budget but are not descended into or deleted.
  Overflow fails closed and yields no eligible IDs in the snapshot CAS.
  Publication teardown and Grant cleanup retain their existing bounded batches.
  `tests/worker/query-plans.test.ts` covers a 2,000-child tree; supplemental
  `tests/subtree-work-bound.test.ts` instruments the identical production SQL
  against the committed migrations in SQLite and observes **500** successor
  child probes, not merely 501 output rows.
- The Public path is a unique `publication_links.id` lookup joined to the
  **current** link of an active Publication; retired links are hard-deleted, not
  retained as link history. Existing Publication lifecycle tests exercise this.
- Covering probes exercise current File representation/capability pointers,
  Directory/Comment epochs, pending Share/request and active-or-deleting
  Publication state, Recovery generation/registry epoch, unexpired
  Session/challenge/enrollment/Import authority, consumed proof markers,
  provisioning needs, and rolling counter windows. Payload reads subsequently
  use current primary-key pointers; full ciphertext/enrollment payload reads
  need not be index-only.
- CTE/worklist scans are bounded and intentional: the two recursive plans declare the only allowed
  scan tokens, and every other base-table scan (including an aliased one such
  as `SCAN n`) or automatic substitute index is rejected for representative
  queries.

## Operational script lifecycle and sensitive artifacts

`scripts/smoke-db.mjs`, `scripts/rehearse-d1-restore.mjs` and
`scripts/import-proof.mjs` choose their exit status **after** cleanup. Reusable
helpers return or throw; they never terminate the process. An operational
failure is reported separately from cleanup failures. Unexpected cleanup
failure makes the command fail even if the checks themselves passed, and does
not prevent the remaining cleanup attempts. Only explicitly classified,
content-free command errors are printed. Unclassified failures (including SQL
parser/preparation errors) keep original details in a private `0600`
`lifecycle-diagnostics.json`; messages report its path and disposal instructions,
not exported values. A diagnostic-write failure is itself reported separately
without replacing the original error.

### Remote ownership and survivors

Rehearsal/proof runs use unique resource names and a current-run ledger. Only a
successful creation with a confirmed identifier grants deletion authority.
Cleanup is in reverse dependency order: the proof Worker before its D1, and the
rehearsal target before its source. D1 deletion binds the recorded UUID rather
than looking up the name again. Shared command/provider behavior lives in the
[D1 scripting reference](operations/d1-scripting.md#resource-identities-and-command-output).

`import-proof.mjs --db-id <uuid>` (or `PROOF_D1_ID`) explicitly borrows an existing
`mdwn-import-proof-db`/`mdwn-import-proof-db-*` database. It is migrated/seeded
for the proof but **never deleted** by the run. Default proof runs create a
new database and Worker; they no longer implicitly reuse or delete fixed
resource names. No production database is an eligible proof target.

- `--keep` explicitly retains confirmed remote resources and local artifacts.
  Each retained resource is reported by name and UUID/Worker version, not data.
  Intentional retention is not a cleanup failure.
- A failed deletion reports `Cleanup failed` and `Surviving resource`, with the
  identifier needed for manual reconciliation. Remaining deletions are still
  attempted; there is no blanket “deployment deleted” message.
- A failed/ambiguous creation reports `Unresolved creation` with the attempted
  name and an unresolved identifier. Inspect the account before manual cleanup;
  the command does **not** guess ownership from a later list or delete by name.
- Borrowed resources are reported separately as left untouched, not as
  successful deletion or accidental leakage of cleanup responsibility.

The fault-injection suite exercises these outcomes with a controlled command
runner and synthetic data; it needs no Cloudflare credentials or live deletion.

### Local artifacts and disposal

Exports, prepared SQL, manifests, restore status/evidence, temporary configs,
proof seed SQL, secrets files and proof environments are sensitive. Writers
create them with mode `0600`, tighten existing files **before** overwriting, and
refuse symlinks. Wrangler-written exports are protected before the command,
including partial output on failure and permissive-umask runs. Operational
runners disable Wrangler's unmanaged disk debug logs, and lifecycle messages
never embed raw subprocess output. Do not rely on an operator's umask alone.

- On successful rehearsal/proof runs, temporary artifacts/state are removed in
  both local and remote modes. Default rehearsal evidence is temporary too.
- On failure, those artifacts are retained for diagnosis and their paths are
  reported without contents, together with `trash <path>` instructions. A
  cleanup failure also reports any retained path. Smoke-test synthetic state
  is removed on both success and operational failure.
- `--keep` retains rehearsal/proof artifacts explicitly. `--evidence <path>`
  is a deliberately retained operator output, even on success; it is `0600`.
- The restoration CLI's explicit `--out`, `--manifest`, `--status` and local
  restored-state outputs are operator-held artifacts, retained for inspection.
  Keep them local and trash them when finished; a failed restore is not verified
  and its partial state/status must not be treated as a usable restoration.

Prefer `/operational-artifacts/` for operator-chosen repository-local output
(the directory is ignored), or a private directory outside the checkout. When
using individual filenames, reserved conventions include `*.d1-export.sql`,
`*.restore.sql`, `*.restore.manifest.json`, the corresponding
`*.restore.manifest.json.status.json`, and `*.restore-status.json`.
`rehearsal-{export,prepared,seed}.sql`, `rehearsal-{manifest,status}.json`,
`rehearsal-evidence.md`, `lifecycle-diagnostics.json`, generated
`mdwn-restore-rehearsal-*.md` / `mdwn-restore-local-rehearsal-*.md` evidence,
`wrangler.proof*.jsonc`, `*.cleanup.jsonc`, `proof-{env,secrets}.json`, `proof-seed.sql`, and the
legacy `mdwn-proof-env.json` are also reserved operational outputs. Credential
files `.dev.vars*`, `.env` and `.env.local` must remain untracked;
`.dev.vars.example` and `.env.example` are intentionally synthetic and allowed.

`.gitignore` excludes these paths, and `npm run lint` independently checks the
Git index, so force-adding an ignored matching artifact still fails. This is a
check of documented output locations/names, **not** classification of arbitrary
sensitive content. Use the ignored output directory for custom filenames. Keep
synthetic fixtures distinctly named (for example `synthetic-export.sql`), never
real exports/credentials, rather than exempting every SQL/JSON file.

Never print, commit, upload or attach sensitive artifacts to a PR. Report paths
or remote identifiers only. When diagnosis/inspection is finished, run
`trash <path>` on every retained file/directory, including external evidence,
prepared/status outputs and proof environments containing a Session cookie or
private JWK. Program tests prove program-controlled cleanup, not eventual manual
disposal or provider backup erasure.

## Migration rollback rehearsal

Time Travel is the primary rollback mechanism. It retains **30 days on Workers
Paid but only seven on Workers Free**; the account's plan is confirmed Workers
Paid (2026-10-13), so 30 days apply. Capture an
exact bookmark and a protected pre-change export before a risky
migration/manual repair. An export can block queries;
choose a maintenance window. Never print its presigned download URL or include
an export containing real data in a PR, repository, or public artifact.

Rehearse on a newly created disposable remote D1 with **only synthetic data**:

1. Create a uniquely named D1, record its UUID, and create a temporary Wrangler
   config whose `DB` binding points only to that UUID. Copy migrations 0000–0026
   into its temporary `migrations_dir`; apply them, then seed
   `scripts/fixtures/retention-rehearsal.sql`. Never point this rehearsal at the
   preview/production binding or reuse an unknown existing database.
2. Capture the export and bookmark with the installed Wrangler version:

   ```sh
   umask 077
   npx --no-install wrangler d1 export DB --remote --config "$CONFIG" --output "$EXPORT"
   npx --no-install wrangler d1 time-travel info DB --config "$CONFIG" --json
   ```

3. Copy migrations 0027–0029 into that temporary directory and apply them. Verify
   FKs, all query plans, one retained Import marker, and byte-identical sentinel
   representation (`FEED`), capsule (`CAFE`), and envelope (`BEEF`). The legacy
   challenge lifetime must shorten from 900,000 to 600,000 ms; the marker must no
   longer reference staging. No Worker or test-only public endpoint is needed.
4. Restore the **disposable database only**, then verify data **and schema**:

   ```sh
   npx --no-install wrangler d1 time-travel restore DB --config "$CONFIG" --bookmark "$BOOKMARK" --json
   npx --no-install wrangler d1 execute DB --remote --config "$CONFIG" --command \
     'PRAGMA foreign_keys; PRAGMA foreign_key_check; SELECT name FROM d1_migrations ORDER BY id;'
   ```

   Record the restore's `previous_bookmark` (undo point). Pre-change sentinel
   bytes, marker, 900,000-ms lifetime, staging FK, and migration head 0026 must
   return. Restoring only Worker code does **not** roll back D1. For a real
   incident, seal traffic/stop maintenance first and pair the database restore
   with the compatible pre-change Worker; do not run post-0027 retention against
   the old staging FK. Recheck authority, FKs, and application reads before
   resuming traffic. A restore rolls back intervening writes, not just DDL.
5. Restore the saved export with the reviewed restoration tool. Raw D1 export
   order is **not** a drop-in D1 restore for this circular schema: a row can
   precede the table it references, composite foreign keys need their parent
   unique index before DML, root-materialization triggers would duplicate
   restored roots, and one max-size ciphertext INSERT exceeds D1's statement
   limit. `scripts/restore-d1-export.mjs` handles all of those; Time Travel
   remains the primary rollback mechanism and needs no export import.

   ```sh
   umask 077
   npm run db:restore -- prepare \
     --export "$EXPORT" \
     --source-name mdwn-db-production --source-uuid 20cbcf9f-0408-48d8-8e51-c8a7385435ef \
     --source-schema-head 0029_public_morg.sql \
     --out "$PREPARED" --manifest "$MANIFEST"
   ```

   `--source-schema-head` is optional and cross-checks the export's own
   `d1_migrations` head; the manifest always records that head, the migration
   list, the installed Wrangler version, the export size/SHA-256, and the
   operator-declared source name/UUID.

   `prepare` is offline and needs no credentials. It parses the export with a
   real SQL tokenizer (never line- or semicolon-splitting), emits all tables,
   then indexes (before data: SQLite rejects a composite FK at DML time unless
   the parent's unique index exists), then data, then triggers and views. It
   chunks every statement over 100,000 bytes: a >100 KB hex BLOB is inserted
   with a first chunk and completed with bounded `unhex(hex(col) || '…')`
   appends, keeping `size = length(blob)` CHECK columns in lockstep. It builds
   a row-level foreign-key graph and keeps each cycle inside one atomic
   command. Before writing anything, it proves the command-batched apply equals
   a single-transaction apply, then runs offline probes for the representation
   immutability trigger, challenge-lifetime and Import-marker guards, FK
   enforcement, root materialization, and all 22 reviewed query plans.

   ```sh
   # Fresh disposable local D1 (default; a private temp state directory).
   npm run db:restore -- restore --prepared "$PREPARED" --manifest "$MANIFEST"

   # A freshly created disposable remote D1.
   npx --no-install wrangler d1 create mdwn-restore-20261006
   npm run db:restore -- restore --prepared "$PREPARED" --manifest "$MANIFEST" \
     --target remote --target-name mdwn-restore-20261006 --target-uuid <uuid>

   # Re-run the read-only checks against an already-restored target.
   npm run db:restore -- verify --prepared "$PREPARED" --manifest "$MANIFEST" \
     --target remote --target-name mdwn-restore-20261006 --target-uuid <uuid>
   ```

   Remote mode resolves the name/UUID through `wrangler d1 info` and refuses
   the committed local, preview, and production bindings, the source database,
   any name without the `mdwn-restore-` prefix, and any nonempty target. Never
   point this at an existing preview or production database. Replacement is a
   delete-and-recreate of the disposable database, never an import over live
   contents. Each command is applied through the D1 query endpoint as one
   atomic multi-statement call. Do **not** use `d1 execute --file` for this
   schema: the import endpoint commits in internal batches, so a deferred
   foreign-key cycle that spans a batch fails even though the whole import is
   rolled back. The query endpoint commits one command atomically; the
   prepared plan never splits a cycle across commands.

   Verification is read-only and mandatory: `foreign_keys = 1`, zero
   `foreign_key_check` violations, the 222-object schema inventory, 30
   migration records and the head, per-table row counts and content digests,
   current/authority pointer invariants, and the 22 reviewed query plans. The
   tool reports success only after every check passes and writes a status JSON
   beside the manifest. Commands are individually atomic, so a failure at
   command *k* leaves the first *k*-1 commands applied: the tool creates a
   `_restore_incomplete` marker table before the first command and drops it
   after the last, so an interrupted or failed restore stays visibly
   incomplete, records `failed` with the remaining tables, and is never a
   silent partial success. The target is disposable and bound to no Worker, so
   it serves no application traffic. Restart by discarding the incomplete
   local temp state with `trash <dir>`, or deleting and recreating the
   disposable remote database, then restoring into the fresh target.

   Validated limits (Workers Free, 2026-10-06): 100 KB per statement, 2 MB per
   row/BLOB, 500 MB per database, 5 GB import file, 30 s per query, and 7 days
   of Time Travel. Workers Paid raises only the database size and Time Travel
   window ([Paid D1 capacity](#paid-d1-capacity-and-time-travel)). The tool
   uses no paid feature. Digest verification pages 20 rows at
   a time, so verification cost scales with data size. `$PREPARED` and
   `$MANIFEST` contain restored data or its digests: keep them local, never
   commit, upload, or print them, and trash them when finished.

   ```sh
   # Full remote round-trip rehearsal on two disposable databases; deletes
   # only confirmed current-run databases. --evidence retains a protected output;
   # without it, success removes the temporary evidence with other artifacts.
   npm run db:restore:rehearsal -- [--keep] [--evidence /tmp/rehearsal-evidence.md]
   ```

   The rehearsal consumes the account's D1 rows written, shared with
   production Cron writes: on Free, the daily quota, where a quota error aborts
   it before any restore and the disposable databases are still deleted; on
   Paid, the shared monthly allowance and then billed overage. Run at most one full remote
   rehearsal per day, check current usage in the Cloudflare dashboard first,
   and prefer the local round trip (`npm run db:restore:local`) while iterating
   on the tooling itself.
6. Delete only the disposable remote D1 by its recorded name/UUID; trash local
   rehearsal storage. Keep sanitized evidence, not the export, prepared SQL, or
   manifest.

### Observed evidence (2026-10-05 UTC)

Wrangler **4.135.0**, account's D1 Free, disposable remote
`mdwn-retention-rehearsal-20261006` / `0aeafa7f-a752-4db9-ab22-73b1e6fd6e3a`:

- Pre-change migrations 0000–0026 applied; full export downloaded successfully.
  Bookmark: `00000001-00000044-000050fb-c094f43a8966e5d468c042db8547dcdc`.
- Migrations 0027–0029 applied remotely. All 22 representative selected plans
  and covering probes passed. FKs were enabled with zero violations.
  Representation/capsule/envelope sentinel bytes and the marker remained unchanged; challenge lifetime
  shortened to 600,000 ms; the staging FK was absent.
- Time Travel restored that bookmark. Data assertions passed, the 900,000-ms
  lifetime and staging FK returned, and all three new migration journal entries
  disappeared. Undo bookmark:
  `00000002-ffffffff-000050fb-6ed27a052fff452c51bc3c566bf30bf6`.
- Raw export re-import initially failed on circular/forward table ordering.
  Offline SQLite restored the complete export; the explicitly reordered
  **synthetic fixture** subsequently restored to fresh local D1 with FK
  enforcement enabled, zero violations, preserved sentinel bytes/marker, and
  the original lifetime. Production-sized export re-import is **not proven**.
- The disposable remote D1 was deleted after successful verification; no
  rehearsal Worker was created. Local synthetic state is disposable.
- After the one-child traversal fix, a second disposable remote D1,
  `mdwn-retention-cursor-proof-20261005` /
  `0a234baa-9bb0-4e7a-a002-4e416f58b248`, passed all **updated** 22 plans and FK
  checks. Its synthetic 2,000-child tree produced 501 candidate visits, 1,000
  cursor states, an overflow flag, **zero** eligible deletion IDs, and 2,000
  retained children (5,001 rows read for enumeration; zero writes). This D1 was
  also deleted; no Worker was deployed. The final local artifact records the
  updated production traversal, not the former output-only cap.
- A separate **read-only production** probe reported `foreign_keys = 1`, zero
  violations, and zero writes. No production migrations or restores were run.

### Observed evidence: export restoration (2026-10-06 UTC)

Wrangler **4.135.0**, account's D1 Free, synthetic data only. The rehearsed
round trip ran through the real `wrangler d1 export` and the restoration tool:

- Source disposable remote D1
  `mdwn-restore-rehearsal-source-20261006153511-7hn61w` /
  `97062835-fb90-4707-af0e-9161044de93c` was seeded with
  `scripts/lib/restore-rehearsal-data.mjs`: 2 accounts, 2 materialized roots,
  2 max-size (512 KiB) file representations, Recovery capsules, current key and
  Grant envelopes, circular node/File/representation and thread-style
  authority pointers, and one durable Import marker whose staging session,
  chunks, records, and kinds were deleted. The export was 2,252,335 bytes
  (sha256 `2331ebed…`).
- `prepare` produced 2,255,551 bytes of prepared SQL (sha256 `5e0c4e4b…`) with
  **2 chunked statements** (the 1,048,576-character hex literals) across **25
  atomic commands**. The command-batched offline apply matched the single-
  transaction apply on every table digest, and all 29 offline behavior and
  query-plan probes passed.
- The prepared plan restored into the fresh disposable remote D1
  `mdwn-restore-debug-1791301153` / `ce0f9fa9-4aba-44c5-95cd-fe18b97b9936` in
  25 query-endpoint commands. Verification passed: `foreign_keys = 1`, zero
  `foreign_key_check` violations, all 222 schema objects matched, migration
  head `0029_public_morg.sql` with all 30 records, all 58 table row counts and
  content digests matched, all 6 current/authority pointer invariants held,
  and all 22 reviewed query plans matched. Both disposable databases were then
  deleted; no Worker was deployed and no production database was touched.
- A same-day re-run of the full orchestrated rehearsal was blocked by the
  account's D1 Free daily row-write limit (error code `7500`, shared with
  production Cron writes) before any restore ran; the rehearsal script deleted
  both databases it had created. The prepared artifacts and the verified
  status JSON from the successful run above are retained as sensitive local
  evidence only.
- After the Standards/Spec review, the tool creates a `_restore_incomplete`
  marker table before the first command and drops it after the last, rejects
  every nonempty target (replacement is delete-and-recreate, never an import
  over live contents), requires the `mdwn-restore-` name prefix, records the
  installed Wrangler version and an optional `--source-schema-head` check, and
  supports a read-only `verify` subcommand. The same retained prepared
  artifacts re-restored and verified locally through 25 atomic commands with
  the marker created and dropped; a forced mid-command failure left the marker
  and a `failed` status with the remaining table listed.
- Regression coverage: `tests/sql-dump.test.ts`,
  `tests/d1-export-restore.test.ts`, and `tests/d1-restore-rehearsal.test.ts`
  cover the tokenizer, BLOB chunking, the raw-order failure, and a
  production-representative committed-schema round trip (including both
  max-size ciphertexts) without network access.

The scheduled-event suite proves the new handler locally. Actual Cron execution
on the new deployed Worker must still be observed after merge; the deploy gate
verifies the new remote indexes/FKs, not the scheduler's wall-clock delivery.

Primary platform references (retrieved for this work): [Cron configuration](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/),
[D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/),
[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/).
