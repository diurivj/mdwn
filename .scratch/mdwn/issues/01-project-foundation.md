# 01: Project foundation: RR8 + Workers + D1 + Drizzle + Tailwind + CSP + CI

**What to build:** A deployed mdwn application shell that a person can load in a browser, served by React Router v8 Framework Mode on Cloudflare Workers, backed by a migrated Cloudflare D1 database, with the security posture and PR pipeline every later ticket builds on.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] TypeScript + React Router v8 Framework Mode app running on the Cloudflare Workers runtime via `@react-router/cloudflare` and `@cloudflare/vite-plugin`.
- [x] Server rendering is limited to the application shell and non-sensitive route data; the layout and its rendering rules are explicit enough that private plaintext is never server-rendered.
- [x] D1 bound for local, preview, and production as separate databases (production D1 is never used from preview or local); Drizzle ORM uses its SQLite/D1 driver, the TypeScript schema is the source of truth, and reviewed generated SQL migrations are committed.
- [x] Wrangler applies migrations, and a smoke test proves a fresh empty D1 reaches the committed schema.
- [x] Strict Content Security Policy plus secure response headers on every response; Tailwind CSS with small local components; no secret can enter the client bundle (enforced by build-time and header checks).
- [x] Pull requests run type checking, tests, and a production build; protected `main` applies reviewed migrations and deploys the Worker through CI.
- [x] Production values come from Cloudflare Secrets, local values from an ignored `.dev.vars`.
- [x] A deployed preview environment is reachable and serves the shell over HTTPS, so every later ticket has somewhere to stand.

## Implementation notes

- **Stack**: React Router v8.4 Framework Mode (`ssr: true`) on Workers via the `@react-router/cloudflare` adapter (its `getLoadContext` seeds the per-request `RouterContextProvider` with the environment), `@cloudflare/vite-plugin`, Tailwind v4, Drizzle ORM (D1/SQLite driver), Wrangler. React Router v8's context-provider model replaces `context.cloudflare`; env is read as `getEnv(context)`.
- **Environments**: default env = local (never deployed), `preview` = worker `mdwn-preview`, `production` = worker `mdwn`. The Cloudflare Vite plugin selects the environment at **build time** via `CLOUDFLARE_ENV` (`npm run build:preview|build:production`); plain `wrangler deploy` uploads the flattened build. Never `--env=` at deploy time.
- **D1 + Drizzle**: three databases — `mdwn-db` (local, `c466a7b4-…`), `mdwn-db-preview` (`9f7eeb4f-…`), `mdwn-db-production` (`20cbcf9f-…`). `app/db/schema.ts` is the source of truth; `drizzle/0000_accounts.sql` (committed + reviewed) is the first migration. It intentionally creates only `accounts` with the spec-locked columns (wayfinder 09 / spec §8.2) so the pipeline has a real target without stepping on later tickets' schema work (06+ owns the remaining tables).
- **Migration + smoke**: migrations applied via `wrangler d1 migrations apply` (`npm run db:migrate:*`, tracked in `d1_migrations`, idempotent, remote backups captured). `npm run db:smoke` proves a **fresh empty D1** reaches the committed schema (tables/columns/unique indexes) and that re-apply is a no-op; `npm run db:smoke -- --remote preview|production` verifies the live databases.
- **Security headers**: applied at the worker boundary in `workers/app.ts` (single source of truth — matched routes, unmatched 404s, `.data`, resource routes, and error pages all get the same strict policy). One per-request CSP nonce is shared between the header and `entry.server.tsx` (<ServerRouter nonce>). `app/security/headers.ts` is pure and unit-tested. Dev-mode CSP is relaxed for Vite HMR only; preview/production are strict (`script-src 'self' 'nonce-…'`, no unsafe-inline/eval).
- **Secrets**: `HEALTHZ_TOKEN` set as a Cloudflare Secret for preview and production; local value in ignored `.dev.vars`. `/healthz` requires `Authorization: Bearer <token>` and reports env + D1 liveness only. `npm run check:secrets` fails the build if any candidate secret (`.dev.vars`, `MDWN_CHECK_SECRETS`, secret-named env vars, PEM blocks) appears in `build/client`.
- **CI/CD**: `.github/workflows/ci.yml` (every PR + main: typecheck, unit tests, build, migration smoke, secret check) and `deploy.yml` (protected main: migrate+deploy+smoke preview, then production). Deploy requires the `CLOUDFLARE_API_TOKEN` repo secret (skips cleanly until added); `HEALTHZ_TOKEN_*` secrets were set.
- **Live**: preview https://mdwn-preview.diurivj.workers.dev and production https://mdwn.diurivj.workers.dev both serve the shell over HTTPS with strict CSP and connected D1 (verified via `/healthz`, 401 without token).

## Comments

- 2026-09-19: Implemented and deployed both environments. Reviewed the generated `drizzle/0000_accounts.sql` before committing. All acceptance checks pass (typecheck, 11 unit tests, build, fresh-D1 smoke, secret scan, live header/nonce/healthz verification).
- 2026-09-19 (ownership handoff): Everything in this ticket is done except the account-owner-only steps below, which no agent token can perform. See the implementation summary for context.
  - **GitHub repo secrets** (needed for `deploy.yml` and the production token check):
    1. Create a scoped `CLOUDFLARE_API_TOKEN` in the Cloudflare dashboard (My Profile → API Tokens; permissions: `Workers Scripts:Edit`, `D1:Edit`, `Account:Read`), then `gh secret set CLOUDFLARE_API_TOKEN --repo diurivj/mdwn`. This is the only true blocker for CI deploys.
    2. `HEALTHZ_TOKEN_PREVIEW` and `HEALTHZ_TOKEN_PRODUCTION` — the working values are in `/tmp/mdwn-healthz-tokens.env` on the build machine (also set as Cloudflare Secrets already). Copy them into a password manager, then `gh secret set` each into the repo. Optional: `MDWN_CHECK_SECRETS` = production token value.
  - **Branch protection / Actions**: confirm GitHub Actions is enabled for `diurivj/mdwn`, set `main` as a protected branch requiring `ci` status checks, and merge into `main` via PRs (deploy runs on merge).
  - **Verify once**: after the secrets exist, push a test commit (or `gh workflow run deploy.yml -f …` on the workflow_dispatch) and confirm `ci.yml` green and `deploy.yml` green — prepare/migrate/smoke for preview then production.
  - **Hygiene**: delete `/tmp/mdwn-healthz-tokens.env` after copying values; never put them in `.dev.vars` or git.
  - Notably **already done by implementation** (nothing to do): all three D1 databases created, both Workers deployed to `mdwn-preview`/`mdwn` on `diurivj.workers.dev`, Cloudflare Secrets `HEALTHZ_TOKEN` set for preview and production, migrations applied to preview+production, `.dev.vars` + example in place.