# Serving and security: shell rendering boundary, headers, secrets, deployment

This is the operationally normative companion to the buildable spec sections 3.5/3.6 and ADR-0002. It pins down the rendering boundary, the security headers, the secret plumbing, and the environment topology every later ticket builds on.

## 1. Server-rendering boundary

mdwn runs React Router v8 Framework Mode with `ssr: true`. The only thing ever server-rendered is the **application shell** and **non-sensitive route data** (spec §3.1, §2.1).

Primitive rules:

- The server renders `app/root.tsx` (`Layout`) and route shells, including Home, Sign in, and Account security. `app/entry.server.tsx` renders the `ServerRouter`; Account security uses a public `HydrateFallback` and a browser-only `clientLoader` so its Session and Passkey lists never enter the server-rendered document. Browser-only `clientAction`s run WebAuthn ceremonies and submit mutations through React Router fetchers, while the resource-route actions still verify them on the Worker.
- Private plaintext is **never** server-rendered, serialized into the document, or emitted by a loader:
  - no Markdown source, File/Directory names, ordering, front matter, user-authored timestamps, Comment bodies, displayed pseudonyms, capability/ciphertext payloads;
  - no session cookies are read server-side and re-emitted; no secret value is ever included in any loader return value.
- Server-side code that touches D1 goes through `app/shared/db/client.server.ts` (Drizzle, D1/SQLite driver, marked `.server.ts` so RR refuses to pull it into the client bundle). Nothing it returns is encrypted content.
- Signup renders only a public shell; WebCrypto, IndexedDB keys, phrase, and one-time codes stay in browser memory. `/api/private/bootstrap` is a proof-guarded, read-only **resource action**, not a document loader, so even its opaque envelopes cannot enter SSR or hydration data. It consumes no proof ID and does not write D1.
- Private Files tree/editor routes render only their public `HydrateFallback` server-side and load encrypted material through browser `clientLoader` flows. The File editor encrypts and signs its draft locally before submitting ciphertext with a React Router fetcher to its browser `clientAction`, which sends the proof-guarded File resource mutation. Save results advance only the captured revision; automatic save revalidation is disabled so a newer tab-local draft cannot be replaced. Reload/discard and lease-acquisition reads are explicit browser events, not effect-driven initial route loading. Draft plaintext and keys never enter a route submission or persistent browser storage; Web Locks coordinate lease ownership and BroadcastChannel messages contain only opaque transfer identifiers. If a private route needs server data it must remain non-sensitive by construction and be reviewed against this list.
- The anonymous Public page `/p/:linkId` server-renders only a public `HydrateFallback`. Its server loader returns no data and answers every inactive path with the same `404`; a hydrating `clientLoader` reads the read capability from `location.hash`, fetches only the opaque path's ciphertext from `/api/public/publications/:linkId` without cookies or referrer, and decrypts in the browser. No Public ciphertext, key or plaintext enters the document. See [publications](publications.md).
- The support page `/support` server-renders only operator-published static donation addresses (public `SUPPORT_*_ADDRESS` vars) and QR codes generated locally at request time from those exact strings. It reads no Session or cookie, writes no D1 row, and serves the identical public page to every visitor. See [support options](support-options.md).
- A violation of this boundary is a security bug, not a performance choice. The cross-engine suite described in [`testing.md`](testing.md) enforces the route and browser-runtime boundary.

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
| `Permissions-Policy` | `camera=(self), microphone=(), geolocation=(), interest-cohort=(), browsing-topics=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `X-Robots-Tag` | `noindex, nofollow, noarchive` (anonymous Public pages are non-indexed and unarchived by default) |
| `Cache-Control` | `no-store` when not already set |

The CSP is single-value, nonce-based, and allows first-party resources only (`script-src 'self' 'nonce-…'`, no `unsafe-inline`/`unsafe-eval` in production; `default-src 'none'`; `frame-ancestors 'none'`; `upgrade-insecure-requests`). The per-request nonce is generated in `workers/app.ts`, seeded into the load context (`app/shared/security/nonce.ts`) for `entry.server.tsx` (which stamps the React Router inline scripts) and reused by the response wrapper to build the header. Under the local dev server the CSP is relaxed for Vite HMR only (`ws:`, `unsafe-eval`); nothing relaxed is ever applied in preview or production.

The policy lives in `app/shared/security/headers.ts` (pure) and is asserted by `tests/headers.test.ts`.
Camera access is limited to this origin for the device-enrollment QR scanner and still requires browser permission.

## 3. Secrets and environment variables

- **Production/preview values** are Cloudflare Secrets, read via `env.NAME`. Never via `vars`, never shipped in the bundle. CI uploads the Session signing and abuse-control HMAC secrets together with reviewed Worker code using `wrangler deploy --secrets-file`; omitted existing secrets, including `HEALTHZ_TOKEN`, are preserved. Do not use `wrangler secret put` to prepare this release: that command immediately deploys a Worker version.
- **Public configuration** is the exception to the secrets rule: the anonymous support page's `SUPPORT_MONERO_ADDRESS`, `SUPPORT_BITCOIN_ADDRESS`, `SUPPORT_LIGHTNING_ADDRESS`, and `SUPPORT_ETHEREUM_ADDRESS` are operator-published page content and live in each environment's `vars` (or `.dev.vars` locally). They are not secrets, but they are also never invented by code: an unset value hides that asset.
- **Local values** live in the gitignored `.dev.vars` (see `.dev.vars.example`). `wrangler dev`/local builds pick them up.
- `SESSION_COOKIE_SECRET` signs only the opaque Session identifier. Provision distinct, persistent, cryptographically random 32-byte values (for example base64-encoded) as GitHub Secrets `SESSION_COOKIE_SECRET_PREVIEW` and `SESSION_COOKIE_SECRET_PRODUCTION`. CI maps the selected value to the runtime binding `SESSION_COOKIE_SECRET`. Enter values through a secure secret input or stdin, never command arguments or source files. Missing/short secrets make authentication fail closed with a generic `503`; there is no development fallback in the application. Replacing a signing secret invalidates existing Session cookies.
- `ABUSE_HMAC_SECRET` derives the short-lived, purpose/time-epoch-scoped Network and opaque Session/recovery counter buckets. Provision separate random 32-byte values as GitHub Secrets `ABUSE_HMAC_SECRET_PREVIEW` and `ABUSE_HMAC_SECRET_PRODUCTION`; never reuse a Session signing key. CI validates both values and uploads the selected one as `ABUSE_HMAC_SECRET`. Rotating it resets active HMAC-scoped counters; rotate through the reviewed deploy workflow, not `wrangler secret put`. Local development uses a distinct `.dev.vars` value.
- `/healthz` is gated in preview/production by the `HEALTHZ_TOKEN` secret via `Authorization: Bearer …`. It returns environment status, D1 connectivity, and the Worker version ID from Cloudflare's version-metadata binding — never a secret. The version ID is used to prove that the newly deployed Worker, not the previous healthy Worker, answered the smoke probe.
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
flattened `build/server/wrangler.json`. The deployment script verifies the selected Worker name/environment/version binding, checks the client bundle for secret values, and uploads that build with a mode-0600 temporary secrets file that is removed on completion or failure. In CI it records Wrangler's newly deployed version ID as a step output.
Deployment never uses `--env=`, and setting `--env=` at deploy time does not retarget
a flattened build. Migration and smoke commands do read the source `wrangler.jsonc`
per environment (`--env=preview|production`).

**Fail-closed guard:** the default (local) environment is named `mdwn-local`, never
`mdwn`, so an accidental plain `npm run build && wrangler deploy` lands on a harmless
`mdwn-local` Worker instead of overriding the production Worker on its hostname.

Migrations are reviewed SQL committed in `drizzle/` (generated by `npm run db:generate` from `app/shared/db/schema.ts`). They are applied through Wrangler:

- `npm run db:migrate` (local), `db:migrate:preview`, `db:migrate:production`;
- CI applies preview then production on reviewed `main`. Each deploy waits (at most 12 attempts, 2 seconds apart, with per-request timeouts) for `/healthz` to report **that exact version ID**, and verifies anonymous `/api/auth/session` and response headers before continuing (`deploy.yml`). A healthy response from a previous Worker cannot unlock the production stage.

The smoke test `npm run db:smoke` proves a **fresh empty D1** reaches the committed schema (tables, column types, indexes, and restrictive foreign keys) and that re-application is a no-op. `--remote preview` and `--remote production` verify the selected deployed database. Worker tests exercise the actual constraints against migrated D1. Abuse records are purged by a 15-minute Worker Cron; event and Network-bucket expiry timestamps reserve one Cron interval before the policy's 30-day/24-hour maxima.

**Operator-only Public-participation controls.** `npm run participation -- apply <local|preview|production> <accountId> <reason>` applies a Public-participation suspension — seven days for a first offense, 30 days for a repeat — after repeated technical abuse or a metadata-supported report pattern; `… clear <env> <accountId>` corrects an evident mistake and removes the escalation; `… list <env>` shows the records; and `… reports <env>` shows the aggregated unexpired category-only report patterns the decision may rely on. A suspension is evaluated against its recorded `expires_at` and stops applying automatically, and it blocks only Public Comment posting and Publication create/rotate. There is no other operator surface in the MVP, and these commands need the same Cloudflare credentials as migrations.

D1 Time Travel plus a pre-change export is the MVP rollback posture for risky migrations (ADR-0002, spec §3.2).

## 5. CI/CD

- `ci.yml` — **active**, running on the repository-scoped Mac mini (see README.md, "CI"). Every PR and push to `main`: install, lint/format, typecheck, Node/Workers tests, production build, migration smoke, local D1 export/restore, secret-leak check, and a Chromium/Firefox/WebKit browser matrix with failure artifacts. Keep the runner online and awake; `npm run verify` runs the local preflight but does not replace green CI.
- `deploy.yml` — `main` only: migrate + deploy preview, smoke it, then migrate + deploy production and smoke it. Requires `CLOUDFLARE_API_TOKEN`, `HEALTHZ_TOKEN_PREVIEW`, `HEALTHZ_TOKEN_PRODUCTION`, `SESSION_COOKIE_SECRET_PREVIEW`, `SESSION_COOKIE_SECRET_PRODUCTION`, `ABUSE_HMAC_SECRET_PREVIEW`, and `ABUSE_HMAC_SECRET_PRODUCTION` repo secrets; the account ID is fixed in the workflow. Session and abuse-control secrets are validated before either database is migrated. Each deployment scans the selected Session-signing, abuse-control, health, and API-token values before upload. `MDWN_CHECK_SECRETS` remains optional for PR CI.
- **Merge discipline.** `main` has no enforceable GitHub protection (private repo, Free plan), so the gate is a convention (see AGENTS.md): land work as a branch + PR, run local `npm run verify`, and merge only after every job in `CI` passes at the PR's current head. Queued, skipped or cancelled jobs are not passes. After pushing/opening the PR, report the commit and URL and stop; check CI when asked or immediately before merging. Deploy runs automatically on merge to `main`.
Deployment dry runs use `npm run deploy:preview -- --dry-run` or `npm run deploy:production -- --dry-run` with distinct test-only `SESSION_COOKIE_SECRET` and `ABUSE_HMAC_SECRET` values in the environment. They build and run the same pre-upload checks without uploading code or applying migrations. Live deployments remain owned by the reviewed deploy workflow.
