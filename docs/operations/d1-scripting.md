# Scripting Wrangler and D1

Reference for anyone writing a script that talks to D1 through Wrangler.
Verified against Wrangler **4.135.0** and D1 on 2026-10-06. This is not the
operator runbook — see [operations.md](../operations.md) for retention, query
plans, Time Travel, and export restoration procedures.

## Transport: which command path is atomic

| Path | Transaction behaviour |
| --- | --- |
| `d1 execute --remote --command "stmt; stmt; …"` | The D1 query endpoint commits one multi-statement command as **one transaction**. A 120-statement command containing a two-table foreign-key cycle was verified to succeed. |
| `d1 execute --remote --file path.sql` | The D1 import endpoint uploads to R2 and ingests. A failure rolls the whole import back, but ingestion commits **internal batches**, so a deferred foreign-key cycle that spans a batch fails even with `PRAGMA defer_foreign_keys=TRUE`. |
| `d1 execute --local --command/--file` | Wrangler splits the SQL and runs it as one `db.batch()`: one transaction. |

Explicit `BEGIN`/`COMMIT` inside a command is rejected: D1 asks for the
Durable Object transaction APIs instead.

Consequence: an export-restoration tool must send **bounded multi-statement
commands** through the query endpoint and keep each foreign-key cycle inside
one command. `scripts/lib/d1-export-restore.mjs` does exactly that.

## Limits

- **100,000 bytes per statement**, local and remote. Over it: `Statement too
  long` / `SQLITE_TOOBIG`. A 512 KiB ciphertext is ~1 MiB of hex, so a
  max-size BLOB cannot be inserted as one literal.
- **2,000,000 bytes per row, string, or BLOB.**
- **30 seconds per query request.** The query endpoint accepted a 120 KB
  command in testing; keep commands bounded (~128 KB) so they also fit the CLI
  argument.
- **5 GB per import file**; the file is uploaded to R2 first.
- **Workers Free:** 500 MB per database, 5 GB account storage, 7-day Time
  Travel, and 100,000 rows written / 5,000,000 rows read per day **shared
  across the account** (production Cron writes count). Error `7500` is the
  daily row-write limit; it clears at midnight UTC.

## Local persistence

- Local commands resolve persistence relative to the **Wrangler config file's
  directory** (`.wrangler/state`), or to `--persist-to` when given.
- `wrangler d1 export --local` accepts **no** `--persist-to`; it reads
  `<config dir>/.wrangler/state`. To isolate a rehearsal, point a temporary
  config at a temporary directory and run every command with `--config`.
- `wrangler d1 info` and `wrangler d1 time-travel info` act on remote
  databases and accept **no** `--remote` flag. `d1 export` accepts `--local` /
  `--remote`, `--output`, `--table`, `--no-schema`, `--no-data`, but no
  `--persist-to`.

## Statement splitting

Wrangler's local splitter keeps `CREATE TRIGGER … BEGIN … END` bodies whole,
but it can mis-split a batched recursive query containing `CASE … END`,
merging adjacent statements. When a script asserts one result per statement
(for example `EXPLAIN QUERY PLAN`), send **one statement per `--command`**.

## Node process pitfalls

`spawnSync` defaults to a 1 MB `maxBuffer`; a large JSON result (for example a
digest page of max-size ciphertexts) truncates into invalid JSON.
`scripts/lib/wrangler-targets.mjs` raises it to 64 MB for this reason. Prefer
its `spawnWrangler` helper over a fresh `spawnSync` call.

## Export shape

`wrangler d1 export` writes `PRAGMA defer_foreign_keys=TRUE;`, then each
table's `CREATE TABLE` followed immediately by one INSERT per row, then
`DELETE FROM sqlite_sequence` and its insert, then indexes, triggers, and
views. It is not a drop-in restore for this schema: rows can precede the table
they reference, composite foreign keys need their parent unique index before
DML, and a max-size ciphertext INSERT exceeds the statement limit.

## Pointers

- `docs/operations.md` — operator runbook: Time Travel, export restoration,
  failure handling.
- `scripts/lib/d1-export-restore.mjs` — statement ordering, row-level FK
  graph, atomic command planning.
- `scripts/lib/wrangler-targets.mjs` — `spawnWrangler` / `runWrangler`
  helpers and the environment triad.
