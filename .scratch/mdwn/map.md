# mdwn — markdown vault web app

> Wayfinder map. Canonical artifact for this effort. Child tickets live in `issues/`.

## Destination

A **buildable spec + locked technical decisions** for *mdwn*: a standalone web app that is a private markdown vault you write in and browse like a normal folder tree, with account-to-account directory sharing (e.g. diet plans with your wife), per-file public publish links, comments, and browser-side import/export. Personal-first, multi-user-capable, **open signup**, **never monetized**. Reaching the end = every decision ticket resolved and the spec assembled (`issues/12-assemble-buildable-spec.md`).

## Notes

- **This repo**: `/Users/diurivj/coding/mdwn` is the project directory for the web app. It is *only* the project — no ingestion from other repos, agent output, or local folders is in scope.
- **Oasis is out of scope**: do not consult `~/oasis` or its vault code.
- **Tracker**: local markdown. Map = this file; tickets = `issues/NN-<slug>.md`; blocking via the ticket's `Blocked by:` line.
- **Standing preferences**: RR7 (React Router v7) over Next.js. TypeScript. Postgres-family database. Start on free/cheap infrastructure — budget is a hard constraint. Privacy is the stated core value: resolve `issues/01-define-privacy-model.md` before assuming the server can read content.
- **Never monetize**: no billing, ever.
- **Skills to consult**: `grilling` + `domain-modeling` for decision tickets; `research` for research tickets; `prototype` for UX tickets.

## Decisions so far

<!-- One line per resolved ticket: name (link) + gist. Detail lives in the ticket. -->

## Not yet specified

<!-- Fog: in-scope questions not yet sharp enough to ticket. Graduates as the frontier advances. -->

- Attachment/image storage (object storage) — deferred past MVP.
- Full-text search — only if it falls out of the database nearly free.
- Public page theming / custom styling.
- Comment notifications.
- Backups and disaster recovery.
- Account deletion and full data export (privacy follow-through).
- Abuse/rate limiting once open signup meets the public internet.
- Team/org features beyond two-person directory sharing.
- Offline / PWA behaviour.
- Audit logging.

## Out of scope

<!-- Beyond the destination; never graduates. Closed, not part of Decisions so far. -->

- Monetization, billing, subscriptions — *never*, by explicit decision.
- Integrating with or reusing Oasis Vault — explicitly excluded.
- Automatic ingestion/sync from local folders, git repos, or agent output — excluded; import/export happens in the browser instead.
- Real-time collaborative editing.
- Version history / revisions.
- Custom public domains.
- Native mobile apps.
