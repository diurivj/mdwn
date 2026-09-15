# Lock the stack and hosting

Type: grilling
Status: open
Blocked by: 03

## Question

Using the infrastructure research (`03`), lock the concrete stack:

- Confirm **RR7 (React Router v7)** framework mode: server rendering, loaders/actions, deployment target.
- Database: Postgres vs libSQL/SQLite, and which provider, given free/cheap and privacy constraints.
- ORM/query layer (e.g. Drizzle, Prisma, raw SQL) and migration workflow.
- Styling/UI approach for a file-tree app.
- Markdown rendering + sanitisation libraries (Q8: CommonMark + GFM, sanitised).
- Auth/session libraries consistent with `02` and `04`.
- Deployment: build pipeline, secrets, backups.

Record an ADR for the database/hosting choice (hard to reverse, a real trade-off).

## Answer
