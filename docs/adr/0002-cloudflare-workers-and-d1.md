# Cloudflare Workers and D1 for the MVP

mdwn will use React Router v8 Framework Mode on Cloudflare Workers with Cloudflare D1 as its relational database. This is a deliberate choice of a free, serverless SQLite deployment over Postgres: the expected vault, sharing, publishing, and comment workload is low-concurrency, while D1 avoids a paid always-on host and fits the browser-encrypted content boundary.

## Considered options

- **Neon or another managed Postgres:** better portability and the existing Postgres preference, but adds a separate provider and scale-to-zero/network complexity.
- **Cloudflare D1:** SQLite semantics and Cloudflare coupling, but a native Worker binding, no database sleep, and a viable free tier for the MVP.
- **Self-managed Postgres or SQLite:** more operational control, but requires a paid VPS and owner-managed patching, TLS, and backups.

## Consequences

The application must keep schema and queries SQLite-compatible and use Drizzle’s D1/SQLite driver, with migrations committed and applied through Wrangler. Moving to Postgres later will require a deliberate data-layer migration. Cloudflare’s free limits and D1’s rollback window are operational constraints; D1 Time Travel and pre-change exports cover MVP rollback, while durable off-site disaster recovery remains future work. End-to-end encryption means D1 stores ciphertext and metadata rather than private Markdown plaintext.

Sources: [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/), [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), [React Router Cloudflare adapter](https://reactrouter.com/api/other-api/adapter), and [Drizzle D1 integration](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1).


## Superseded in part (2026-10-12)

The **Free-only premise** is superseded: the "deliberate choice of a free, serverless SQLite deployment", D1's "viable free tier for the MVP", and "Cloudflare's free limits" as the operational constraints. The maintainer has decided to fund Workers Paid as the intended operating baseline (whether the account is already subscribed is unconfirmed), targeting about $5 per month with $10 as an intervention boundary that no provider setting enforces. Once the subscription is confirmed, Paid D1 capacity and the 30-day Time Travel window replace the Free limits and seven-day window; Time Travel stays operational recovery. **2026-10-13:** the subscription is confirmed active, so that replacement now applies. See the [Workers Paid operating policy](../operations.md#workers-paid-operating-policy) and [Budgeted Workers Paid adoption](../workers-paid-plan.md).

Unchanged: Workers and D1, SQLite-compatible schema and queries, Drizzle, committed Wrangler migrations, Time Travel plus pre-change exports for rollback, off-site disaster recovery as future work, and D1 holding ciphertext and metadata only.
