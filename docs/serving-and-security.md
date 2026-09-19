# Serving and security: shell rendering boundary, headers, secrets, deployment

This is the operationally normative companion to the buildable spec sections 3.5/3.6 and ADR-0002. It pins down the rendering boundary, the security headers, the secret plumbing, and the environment topology every later ticket builds on.

## 1. Server-rendering boundary

mdwn runs React Router v8 Framework Mode with `ssr: true`. The only thing ever server-rendered is the **application shell** and **non-sensitive route data** (spec §3.1, §2.1).

Primitive rules:

- The entire server-rendered document is produced by `app/root.tsx` (`Layout`) and `app/routes/home.tsx`. `app/entry.server.tsx` renders the `ServerRouter` — nothing else.
- Private plaintext is **never** server-rendered, serialized into the document, or emitted by a loader:
  - no Markdown source, File/Directory names, ordering, front matter, user-authored timestamps, Comment bodies, displayed pseudonyms, capability/ciphertext payloads;
  - no session cookies are read server-side and re-emitted; no secret value is ever included in any loader return value.
- Server-side code that touches D1 goes through `app/db/client.server.ts` (Drizzle, D1/SQLite driver, marked `.server.ts` so RR refuses to pull it into the client bundle). Nothing it returns is encrypted content.
- Later private routes (Files tree, editor) must render their shells server-side but obtain all ciphertext through `clientLoader`-style browser flows; if a route ever needs server data it must remain non-sensitive by construction and be reviewed against this list.
- A violation of this boundary is a security bug, not a performance choice. Ticket 02 adds the cross-engine test suite that can enforce it.

## 2. Response headers on every response

Security headers are applied at the **Workerd boundary** in `workers/app.ts`,
single source of truth, so every response — matched routes, unmatched 404s,
`.data` requests, resource routes, and error pages — carries the identical
strict policy. That file owns the one per-request CSP nonce: it is generated
there, threaded into the load context for `entry.server.tsx` (which stamps the
React Router inline scripts), and reused by the response wrapper for the CSP
header.

| Header | Value (production) |
| --- | --- |
| `Content-Security-Policy` | strict nonce policy, see below |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `no-referrer` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), interest-cohort=(), browsing-topics=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `X-Robots-Tag` | `noindex, nofollow` (anonymous public pages are non-indexed by default) |
| `Cache-Control` | `no-store` when not already set |

The CSP is single-value, nonce-based, and allows first-party resources only (`script-src 'self' 'nonce-…'`, no `unsafe-inline`/`unsafe-eval` in production; `default-src 'none'`; `frame-ancestors 'none'`; `upgrade-insecure-requests`). The per-request nonce is generated in `workers/app.ts`, seeded into the load context (`app/security/nonce.ts`) for `entry.server.tsx` (which stamps the React Router inline scripts) and reused by the response wrapper to build the header. Under the local dev server the CSP is relaxed for Vite HMR only (`ws:`, `unsafe-eval`); nothing relaxed is ever applied in preview or production.

The policy lives in `app/security/headers.ts` (pure) and is asserted by `tests/headers.test.ts`.

## 3. Secrets and environment variables

- **Production/preview values** are Cloudflare Secrets (`wrangler secret put <NAME> --env=<preview|production>`), read via `env.NAME`. Never via `vars`, never shipped in the bundle.
- **Local values** live in the gitignored `.dev.vars` (see `.dev.vars.example`). `wrangler dev`/local builds pick them up.
- `/healthz` is gated by the `HEALTHZ_TOKEN` secret via `Authorization: Bearer …`. It returns environment status and D1 connectivity only — never a secret.
- **No secret can enter the client bundle**: after every build, `npm run check:secrets` scans `build/client` against `.dev.vars` values, `MDWN_CHECK_SECRETS`, and secret-named env vars, and always rejects private-key PEM blocks. CI runs it on every pull request.
- CSP `connect-src 'self'` means a compromised/foreign script cannot exfiltrate; combined with `base-uri 'none'`/`frame-ancestors 'none'` the page is locked to the mdwn origin.

## 4. Environment and database topology

Three environments, three D1 databases; production D1 is **never** bound from preview or local (spec §3.2):

| Environment | Worker | D1 database | Deploy path |
| --- | --- | --- | --- |
| local (default env) | `mdwn-local` (never deployed) | `mdwn-db` local simulation | `npm run dev` |
| preview | `mdwn-preview` | `mdwn-db-preview` | `npm run deploy:preview` |
| production | `mdwn` | `mdwn-db-production` | `npm run deploy:production` |

With the Cloudflare Vite plugin, the environment is selected at **build time** via
`CLOUDFLARE_ENV` (`npm run build:preview` / `build:production`); the build emits a
flattened `build/server/wrangler.json` and plain `wrangler deploy` uploads it.
Deployment never uses `--env=`, and setting `--env=` at deploy time does not retarget
a flattened build. Migration and smoke commands do read the source `wrangler.jsonc`
per environment (`--env=preview|production`).

**Fail-closed guard:** the default (local) environment is named `mdwn-local`, never
`mdwn`, so an accidental plain `npm run build && wrangler deploy` lands on a harmless
`mdwn-local` Worker instead of overriding the production Worker on its hostname.

Migrations are reviewed SQL committed in `drizzle/` (generated by `npm run db:generate` from `app/db/schema.ts`). They are applied through Wrangler:

- `npm run db:migrate` (local), `db:migrate:preview`, `db:migrate:production`;
- CI applies preview then production on protected `main`, and each deploy verifies `/healthz` plus response headers (`deploy.yml`).

The smoke test `npm run db:smoke` proves a **fresh empty D1** reaches the committed schema (tables, columns, unique indexes) and that re-application is a no-op. `--remote disposable` runs the same against a throwaway remote D1.

D1 Time Travel plus a pre-change export is the MVP rollback posture for risky migrations (ADR-0002, spec §3.2).

## 5. CI/CD

- `ci.yml` — every PR and push to `main`: install, typecheck, unit tests, production build, migration smoke test, secret-leak check.
- `deploy.yml` — `main` only: migrate + deploy preview, smoke it, then migrate + deploy production and smoke it. Requires `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `HEALTHZ_TOKEN_PREVIEW`, `HEALTHZ_TOKEN_PRODUCTION`, optional `MDWN_CHECK_SECRETS` repo secrets.
- **Merge discipline.** `main` has no enforceable GitHub protection (private repo, Free plan), so the gate is a convention (see AGENTS.md): land work as a branch + PR and merge only when `ci` is green. Deploy runs automatically on merge to `main`.