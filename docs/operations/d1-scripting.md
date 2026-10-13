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
- **Workers Paid** (from Cloudflare's D1 documentation, checked 2026-10-11; not
  exercised by these scripts): 10 GB per database, 30-day Time Travel, and
  monthly row allowances that bill overage instead of failing. Per-statement
  and per-row limits are unchanged. See
  [operations.md](../operations.md#paid-d1-capacity-and-time-travel).

### Per-invocation queries

D1 allows **50 queries per Worker invocation on Workers Free** and **1,000 on
Workers Paid** ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
checked 2026-10-11). The documentation does not say whether each statement of a
`batch()` counts as a query, so treat **every statement as counting** until
that is verified. Budget a request or scheduled invocation by its statements,
not its D1 calls. The account's Workers Paid plan is confirmed active
(2026-10-13), so budget against the Paid figure; an unconfirmed account must
use the Free figure.

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

## Resource identities and command output

- `d1 create <name> --update-config=false` leaves the repository config alone
  and emits a binding snippet containing `database_id`. Treat only a successful
  command with one unambiguous UUID as confirmed creation. A failed command or
  missing/ambiguous identifier may have left a resource behind: report the
  attempted name for operator reconciliation, but do not resolve it from a
  later list and assume ownership.
- `d1 delete DB --config <private-config> -y` resolves a binding with a declared
  `database_id` to that UUID. Deleting by a freshly looked-up name can select a
  replacement resource. Disposable cleanup therefore uses a temporary binding
  containing the current run's confirmed UUID. Verified against the installed
  Wrangler 4.135.0 `d1` command help and `getDatabaseByNameOrBinding`/delete
  implementation; no live deletion was needed for this check.
- Wrangler export writes the `--output` file itself. The calling command must
  protect that path **before** starting Wrangler, run under a restrictive
  umask, and protect partial output on failure; chmod after a successful export
  alone leaves a disclosure window. `withSensitiveOutput` owns this boundary.
- Subprocess stdout/stderr can contain SQL, payloads, URLs or credentials.
  Shared piped runners report a command label and exit status rather than
  embedding raw output in lifecycle messages. Offline preparation errors may
  contain SQL too: unclassified error details are retained only in private
  diagnostic artifacts, never interpolated into lifecycle messages. Helpers throw; commands finish
  cleanup before setting their own exit status. Operational runners also set
  `WRANGLER_WRITE_LOGS=false` to avoid unmanaged raw debug logs in the global
  Wrangler config directory. This switch was verified against Wrangler 4.135.0
  `shouldLogToDisk`; a raw diagnostic file retained by another tool must be
  protected and lifecycle-managed like an export, not just hidden from stdout.

See [operations.md](../operations.md#operational-script-lifecycle-and-sensitive-artifacts)
for ownership, retention, failure reporting and artifact disposal.

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
