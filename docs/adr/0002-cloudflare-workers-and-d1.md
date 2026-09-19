# Cloudflare Workers and D1 for the MVP

mdwn will use React Router v8 Framework Mode on Cloudflare Workers with Cloudflare D1 as its relational database. This is a deliberate choice of a free, serverless SQLite deployment over Postgres: the expected vault, sharing, publishing, and comment workload is low-concurrency, while D1 avoids a paid always-on host and fits the browser-encrypted content boundary.

## Considered options

- **Neon or another managed Postgres:** better portability and the existing Postgres preference, but adds a separate provider and scale-to-zero/network complexity.
- **Cloudflare D1:** SQLite semantics and Cloudflare coupling, but a native Worker binding, no database sleep, and a viable free tier for the MVP.
- **Self-managed Postgres or SQLite:** more operational control, but requires a paid VPS and owner-managed patching, TLS, and backups.

## Consequences

The application must keep schema and queries SQLite-compatible and use Drizzle’s D1/SQLite driver, with migrations committed and applied through Wrangler. Moving to Postgres later will require a deliberate data-layer migration. Cloudflare’s free limits and D1’s rollback window are operational constraints; D1 Time Travel and pre-change exports cover MVP rollback, while durable off-site disaster recovery remains future work. End-to-end encryption means D1 stores ciphertext and metadata rather than private Markdown plaintext.

Sources: [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/), [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), [React Router Cloudflare adapter](https://reactrouter.com/api/other-api/adapter), and [Drizzle D1 integration](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1).