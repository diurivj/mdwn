# 01: Project foundation: RR8 + Workers + D1 + Drizzle + Tailwind + CSP + CI

**What to build:** A deployed mdwn application shell that a person can load in a browser, served by React Router v8 Framework Mode on Cloudflare Workers, backed by a migrated Cloudflare D1 database, with the security posture and PR pipeline every later ticket builds on.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] TypeScript + React Router v8 Framework Mode app running on the Cloudflare Workers runtime via `@react-router/cloudflare` and `@cloudflare/vite-plugin`.
- [ ] Server rendering is limited to the application shell and non-sensitive route data; the layout and its rendering rules are explicit enough that private plaintext is never server-rendered.
- [ ] D1 bound for local, preview, and production as separate databases (production D1 is never used from preview or local); Drizzle ORM uses its SQLite/D1 driver, the TypeScript schema is the source of truth, and reviewed generated SQL migrations are committed.
- [ ] Wrangler applies migrations, and a smoke test proves a fresh empty D1 reaches the committed schema.
- [ ] Strict Content Security Policy plus secure response headers on every response; Tailwind CSS with small local components; no secret can enter the client bundle (enforced by build-time and header checks).
- [ ] Pull requests run type checking, tests, and a production build; protected `main` applies reviewed migrations and deploys the Worker through CI.
- [ ] Production values come from Cloudflare Secrets, local values from an ignored `.dev.vars`.
- [ ] A deployed preview environment is reachable and serves the shell over HTTPS, so every later ticket has somewhere to stand.
