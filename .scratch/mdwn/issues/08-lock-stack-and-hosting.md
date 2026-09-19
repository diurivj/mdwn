# Lock the stack and hosting

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by: 03

## Question

Using the infrastructure research (`03`), lock the concrete stack:

- Confirm **RR8 (React Router v8)** framework mode: server rendering, loaders/actions, deployment target.
- Database: Postgres vs libSQL/SQLite, and which provider, given free/cheap and privacy constraints.
- ORM/query layer (e.g. Drizzle, Prisma, raw SQL) and migration workflow.
- Styling/UI approach for a file-tree app.
- Markdown rendering + sanitisation libraries (Q8: CommonMark + GFM, sanitised).
- Auth/session libraries consistent with `02` and `04`.
- Deployment: build pipeline, secrets, backups.

Record an ADR for the database/hosting choice (hard to reverse, a real trade-off).

## Answer

**Resolution — RR8 Framework Mode on Cloudflare Workers with D1.** mdwn uses the Cloudflare-native React Router v8 adapter and Cloudflare D1 as its relational store. This keeps the MVP at the free/cheap boundary and accepts SQLite coupling as a deliberate trade-off; the workload is a low-concurrency vault tree with shares, public links, and comments, not a general-purpose multi-tenant SQL system.

### Runtime and persistence

- Use TypeScript with RR8 Framework Mode, `@react-router/cloudflare`, and `@cloudflare/vite-plugin`.
- Use loaders and actions for server interactions. Server rendering is limited to the application shell and non-sensitive route data; private Markdown plaintext is decrypted and rendered in the browser.
- Use D1’s production backend, not Postgres, libSQL, or a self-managed database. Keep the schema and queries SQLite-compatible.
- Use Drizzle ORM with the SQLite/D1 driver. Keep the TypeScript schema and generated SQL migrations in the repository; apply reviewed migrations through Wrangler. Use D1 batch operations where a business operation needs multiple statements to commit atomically.

### UI and Markdown

- Use Tailwind CSS with small local components. Add Radix primitives only for accessibility-sensitive controls such as dialogs and menus; avoid a large component framework.
- Render CommonMark plus GFM in the browser with `react-markdown`, `remark-gfm`, and conservative `rehype-sanitize`. Do not enable arbitrary raw HTML or `rehype-raw` in the MVP.

### Authentication and sessions

- Use `@simplewebauthn/server` and `@simplewebauthn/browser` v14 through RR8 loaders/actions. Store one-time WebAuthn challenges in D1 and delete them after use.
- Implement React Router `createSessionStorage` with D1-backed CRUD. The cookie contains only a signed opaque session identifier; session state remains server-tracked and revocable. Use the already-decided `Secure`, `HttpOnly`, `SameSite=Lax`, 30-day idle, and 90-day absolute session policy.
- This resolves the ambiguity in [Research: passkeys/WebAuthn implementation and recovery](02-research-passkeys.md): `createCookieSessionStorage` is not the source of truth because it stores session data in the cookie. The later [Design authentication: passkeys, recovery, open signup](04-design-auth.md) decision for server-tracked sessions governs.

### Delivery and recovery

- Use Wrangler and GitHub Actions: pull requests run typechecking, tests, and builds; protected main deploys the Worker and applies reviewed D1 migrations. Use separate local/preview databases rather than production D1 for previews.
- Store production values in Cloudflare Secrets; keep local development values in an ignored `.dev.vars` file. Never expose secrets through the client bundle.
- Use D1 Time Travel for the free-tier rollback window and export the database before risky migrations or manual repairs with Wrangler. Long-term off-site backups and disaster recovery remain the broader future concern recorded in the map’s fog.

The database/hosting decision is recorded in [ADR 0002: Cloudflare Workers and D1](../../../docs/adr/0002-cloudflare-workers-and-d1.md).