# mdwn

A private markdown-vault application for people who write, browse, share, and
selectively publish Markdown. End-to-end-encrypted, passkeys-only, never
monetized. Technical decisions and the MVP buildable spec live in
[`docs/buildable-spec.md`](docs/buildable-spec.md); the domain glossary is
[`CONTEXT.md`](CONTEXT.md).

## Stack

React Router v8 Framework Mode on Cloudflare Workers (`@react-router/cloudflare`
+ `@cloudflare/vite-plugin`), Cloudflare D1, Drizzle ORM (SQLite/D1), Tailwind
CSS with small local components. See [`docs/serving-and-security.md`](docs/serving-and-security.md).

## Development

```sh
npm install
npm run dev          # local Workers runtime + D1 simulation + Tailwind
```

## Useful scripts

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | wrangler types + react-router typegen + `tsc -b` |
| `npm test` | Node unit tests + Workers-runtime tests |
| `npm run test:all` | unit/Worker tests, production build, and Chromium/Firefox/WebKit browser tests |
| `npm run test:e2e` | browser tests against the built Worker (all three engines) |
| `npm run verify` | local merge gate: every CI check, then all three browser engines (see AGENTS.md) |
| `npm run build` | production build into `build/` |
| `npm run db:generate` | generate a migration from `app/db/schema.ts` into `drizzle/` |
| `npm run db:migrate[:preview\|:production]` | apply migrations via Wrangler |
| `npm run db:smoke` | fresh-D1 schema and foreign-key smoke test |
| `npm run db:operations [-- --remote preview\|production]` | read-only remote FK/query-plan verification, or disposable local verification |
| `npm run check:secrets` | assert no secret leaked into `build/client` |
| `npm run deploy:preview` / `:production` | build + deploy that environment |

Secrets: local values in gitignored `.dev.vars` (see `.dev.vars.example`);
remote values as Cloudflare Secrets per environment.

Scheduled retention, reviewed D1 query plans, and the Time Travel/pre-change
export rollback rehearsal are documented in [`docs/operations.md`](docs/operations.md).

## Repo layout

- `app/` — React Router framework app (routes, security modules, Drizzle client/schema)
- `workers/app.ts` — Workers entry that delegates to the React Router handler
- `drizzle/` — committed, reviewed SQL migrations
- `scripts/` — migration apply, D1 smoke, bundle secret check
- `tests/` — Node unit tests and Workers-runtime tests
- `e2e/` — Playwright cross-engine tests against the built Worker
- `.scratch/mdwn/` — issue tracker and wayfinding map (local markdown)
- `docs/` — buildable spec, ADRs, serving/security policy
