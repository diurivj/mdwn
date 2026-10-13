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
| `npm run verify` | local preflight: every CI check, then all three browser engines (see AGENTS.md) |
| `npm run build` | production build into `build/` |
| `npm run db:generate` | generate a migration from `app/shared/db/schema.ts` into `drizzle/` |
| `npm run db:migrate[:preview\|:production]` | apply migrations via Wrangler |
| `npm run db:smoke` | fresh-D1 schema and foreign-key smoke test |
| `npm run db:operations [-- --remote preview\|production]` | read-only remote FK/query-plan verification, or disposable local verification |
| `npm run check:secrets` | assert no secret leaked into `build/client` |
| `node scripts/import-proof.mjs` | disposable Workers + D1 release-gate proof (requires `wrangler login`) |
| `npm run deploy:preview` / `:production` | build + deploy that environment |

Secrets: local values in gitignored `.dev.vars` (see `.dev.vars.example`);
remote values as Cloudflare Secrets per environment.

The acceptance evidence map and release-candidate gate are in
[`docs/acceptance.md`](docs/acceptance.md); the independent security review
brief is [`docs/security-review.md`](docs/security-review.md).

Scheduled retention, reviewed D1 query plans, and the Time Travel/pre-change
export rollback rehearsal are documented in [`docs/operations.md`](docs/operations.md).

## CI

CI runs on a bounded pool of repository-scoped, native ARM64 Mac mini runners
labelled `mini-m4pro-ci`. Keep the mini awake and the configured services online;
otherwise jobs queue. Each independent runner executes one verification or
browser job; the host-wide active-listener budget controls aggregate capacity
across repositories. See [pool operation and qualification](docs/ci-runner-pool.md).
Deployment remains on GitHub-hosted Linux and still uses hosted-runner minutes.

Prefer a dedicated runner account without personal or deployment credentials.
The maintainer chose to reuse the existing personal account for this host; this
explicitly retains CI's access to that account's files and credentials.
Self-hosted jobs execute repository code with that account's filesystem and
network access; a separate account is not a sandbox. The workflow skips fork
pull requests, but workflow edits can change that guard, so only trusted code
and contributors belong on this runner. See AGENTS.md for the merge gate.

## Repo layout

- `app/` — React Router framework app (routes, security modules, Drizzle client/schema)
- `workers/app.ts` — Workers entry that delegates to the React Router handler
- `drizzle/` — committed, reviewed SQL migrations
- `scripts/` — migration apply, D1 smoke, bundle secret check
- `tests/` — Node unit tests and Workers-runtime tests
- `e2e/` — Playwright cross-engine tests against the built Worker
- `.scratch/mdwn/` — issue tracker and wayfinding map (local markdown)
- `docs/` — buildable spec, ADRs, serving/security policy
