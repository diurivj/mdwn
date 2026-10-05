# Retention and D1 operations

Ticket [31](../.scratch/mdwn/issues/31-retention-and-operations.md); [ADR-0002](adr/0002-cloudflare-workers-and-d1.md).

## Scheduled retention

`wrangler.jsonc` schedules the same Worker handler every 15 minutes in local,
preview, and production. `workers/app.ts` awaits every maintenance operation;
a failure propagates to the Cron outcome rather than being swallowed. Blanket
request logs/traces remain disabled under the privacy policy.

The handler removes:

- Expired counters, Security events, and category-only Public Comment reports;
  expired Network buckets are cleared even on retained Security events.
- Expired registration challenges and consumed mutation proofs.
- **Every** expired WebAuthn purpose, routine/Recovery enrollment, and Session.
  A revoked Session or a restricted Recovery Session older than five minutes is
  also unusable. Its ceremonies/staging are effectively expired even if their
  own expiry is later; they are removed before the Session's RESTRICT FK parent.
- Expired Import staging, including committed-session manifests, per-kind
  counts, records, and chunks. One atomic pass drains the three oldest eligible
  Imports (at most 120 chunks / 60 MiB / 6,000 descriptors); an expired parent
  Session remains non-authorizing until all its remaining Imports drain.
- Bounded expired-Grant envelope/provisioning dependents, **not** the Grant's
  write seal or a cryptographic job. Browser-authorized rotation still owns that
  lifecycle (`app/sharing/grant-expiry.server.ts`).

No retention statement deletes current Files, representations, envelopes,
Recovery capsules, registry/devices, passkeys, active Grants, Publications,
Comments, or Import commit markers. `import_commits` is durable visibility
metadata, not staging authority. Migration 0027 removes its FK to the ephemeral
Import session, reinstalls the immutable-marker trigger after the rebuild, and
checks its originating session/account/target with an INSERT trigger instead.
Removing staging can no longer hide committed nodes or indefinitely retain an
expired authentication Session.

One-use WebAuthn, registration, and Recovery-enrollment lifetimes are capped at
600,000 ms by INSERT **and UPDATE** guards; migration 0027 shortens any overlong
legacy records. Normal issuance uses five minutes; routine enrollment already
has a ten-minute CHECK. Expiry ends authority immediately; **physical deletion
follows the next successful Cron**, with additional passes for an Import backlog.
It is not a promise of physical erasure at the exact challenge-expiry instant.
Security-event writes reserve one 15-minute Cron interval before the 30-day
retention maximum, including the event's Network-bucket headroom. Provider Time
Travel/backups are outside application-level deletion.

### Verify maintenance

```sh
npx --no-install vitest run --config vitest.workers.config.ts \
  tests/worker/retention.test.ts tests/worker/abuse-controls.test.ts
```

These are real workerd/D1 scheduled-event tests: expired/live mixtures,
FK-dependent ceremonies and Imports, committed content and current envelopes,
proof/challenge retention, idempotence, and repeated bounded backlog progress.

On local Vite/Wrangler development only, invoke
`/cdn-cgi/local/scheduled?format=json`. This is a runtime test endpoint, **not** a
production route. In the deployed Worker's **Settings → Trigger Events → View
events**, check that the Cron outcome succeeds every 15 minutes. Cron Events
needs no request-body logging. A failed/missed run invalidates the timing
headroom; repair it immediately and check backlog counts using aggregate SQL,
never enable blanket logs or persist ciphertext/identifiers in diagnostics.

## Foreign keys and query plans

```sh
npm run db:operations -- --output /tmp/mdwn-local-plans.md
npm run db:operations -- --remote preview --output /tmp/mdwn-preview-plans.md
npm run db:operations -- --remote production --output /tmp/mdwn-production-plans.md
```

Local mode migrates a fresh **disposable** local D1 and prints its state path;
clean it up with `trash <path>` when inspection is finished. Remote mode is
**read-only** and never applies a migration. Missing post-0027/0029 schema fails
verification; do not apply unreviewed migrations to make that check pass.

Both modes require `PRAGMA foreign_keys = 1` and an empty
`PRAGMA foreign_key_check`. D1 enforces FKs by default; setting
`PRAGMA foreign_keys = OFF` cannot disable them. `defer_foreign_keys` only defers
checks inside one transaction. The migration smoke check now verifies effective
FK state as well as schema declarations. The deploy workflow runs the operations
check against preview and production after reviewed migrations land.

The reviewed [EXPLAIN output](operations/query-plans.md) covers all 22
representative metadata hot paths. SQL and expectations live in
`scripts/lib/d1-query-plans.mjs`; workerd and remote checks execute identical SQL.
The workerd gate also compiles the actual production `accountAccessQuery`.
SQLite may prefer a unique point index over a larger covering index on a small
or unanalyzed table. The artifact reports **both the actual selected plan and a
separately labelled INDEXED BY covering probe**; it does not misrepresent the
probe as the planner's choice. Primary-key payload fetches remain intentional:
512 KiB ciphertext is never duplicated into indexes.

Reviewed results:

- Child indexes begin with `parent_node_id`; `vault_nodes_parent_idx` covers
  recursive child enumeration, including the Import visibility predicate.
- Exact recipient/target/Owner Grant probes and the production recursive access
  query use `grants_recipient_target_idx`. Ancestors are bounded to 100 edges /
  101 nodes. Collaborator overflow/unrooted ancestry fails closed.
- Directory hard deletion uses the production depth-first cursor from
  `app/tree/subtree.server.ts`: one indexed successor child per step, at most
  501 candidate nodes (including the root/overflow sentinel) and 1,001 cursor
  states. The recursive queue has one successor; a wide Directory cannot
  enqueue all its children before the output cap. Hidden Import candidates
  count toward the safety budget but are not descended into or deleted.
  Overflow fails closed and yields no eligible IDs in the snapshot CAS.
  Publication teardown and Grant cleanup retain their existing bounded batches.
  `tests/worker/query-plans.test.ts` covers a 2,000-child tree; supplemental
  `tests/subtree-work-bound.test.ts` instruments the identical production SQL
  against the committed migrations in SQLite and observes **500** successor
  child probes, not merely 501 output rows.
- The Public path is a unique `publication_links.id` lookup joined to the
  **current** link of an active Publication; retired links are hard-deleted, not
  retained as link history. Existing Publication lifecycle tests exercise this.
- Covering probes exercise current File representation/capability pointers,
  Directory/Comment epochs, pending Share/request and active-or-deleting
  Publication state, Recovery generation/registry epoch, unexpired
  Session/challenge/enrollment/Import authority, consumed proof markers,
  provisioning needs, and rolling counter windows. Payload reads subsequently
  use current primary-key pointers; full ciphertext/enrollment payload reads
  need not be index-only.
- CTE/worklist scans are bounded and intentional. Persistent base-table scans
  and automatic substitute indexes are rejected for representative queries.

## Migration rollback rehearsal

Time Travel is the primary rollback mechanism. **Workers Free retains seven
days, not 30** (30 is Paid); capture an exact bookmark and a protected pre-change
export before a risky migration/manual repair. An export can block queries;
choose a maintenance window. Never print its presigned download URL or include
an export containing real data in a PR, repository, or public artifact.

Rehearse on a newly created disposable remote D1 with **only synthetic data**:

1. Create a uniquely named D1, record its UUID, and create a temporary Wrangler
   config whose `DB` binding points only to that UUID. Copy migrations 0000–0026
   into its temporary `migrations_dir`; apply them, then seed
   `scripts/fixtures/retention-rehearsal.sql`. Never point this rehearsal at the
   preview/production binding or reuse an unknown existing database.
2. Capture the export and bookmark with the installed Wrangler version:

   ```sh
   umask 077
   npx --no-install wrangler d1 export DB --remote --config "$CONFIG" --output "$EXPORT"
   npx --no-install wrangler d1 time-travel info DB --config "$CONFIG" --json
   ```

3. Copy migrations 0027–0029 into that temporary directory and apply them. Verify
   FKs, all query plans, one retained Import marker, and byte-identical sentinel
   representation (`FEED`), capsule (`CAFE`), and envelope (`BEEF`). The legacy
   challenge lifetime must shorten from 900,000 to 600,000 ms; the marker must no
   longer reference staging. No Worker or test-only public endpoint is needed.
4. Restore the **disposable database only**, then verify data **and schema**:

   ```sh
   npx --no-install wrangler d1 time-travel restore DB --config "$CONFIG" --bookmark "$BOOKMARK" --json
   npx --no-install wrangler d1 execute DB --remote --config "$CONFIG" --command \
     'PRAGMA foreign_keys; PRAGMA foreign_key_check; SELECT name FROM d1_migrations ORDER BY id;'
   ```

   Record the restore's `previous_bookmark` (undo point). Pre-change sentinel
   bytes, marker, 900,000-ms lifetime, staging FK, and migration head 0026 must
   return. Restoring only Worker code does **not** roll back D1. For a real
   incident, seal traffic/stop maintenance first and pair the database restore
   with the compatible pre-change Worker; do not run post-0027 retention against
   the old staging FK. Recheck authority, FKs, and application reads before
   resuming traffic. A restore rolls back intervening writes, not just DDL.
5. Exercise the saved export independently in disposable local storage. Raw
   D1 export order is **not** a drop-in D1 restore for this circular schema:
   forward table references fail even with deferred checks, and preinstalled
   root-materialization triggers would duplicate restored roots. For this
   known synthetic fixture, the following Node 24 preparation was rehearsed:

   ```js
   import { DatabaseSync } from "node:sqlite";
   import { readFileSync, writeFileSync } from "node:fs";
   import assert from "node:assert/strict";
   const input = readFileSync(process.argv[2], "utf8");
   // FK disabling is OFFLINE SQLite only, never a D1 pragma/workaround.
   const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
   db.exec(input);
   db.exec("PRAGMA foreign_keys = ON");
   assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
   assert.equal(db.prepare("SELECT hex(ciphertext) AS value FROM file_representations").get().value, "FEED");
   const schema = db.prepare("SELECT type, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
   const ddl = type => schema.filter(row => row.type === type).map(row => row.sql + ";");
   // KNOWN FIXTURE ONLY: its INSERTs are single-line and its BLOBs are tiny.
   const data = input.split("\n").filter(line => /^INSERT INTO |^DELETE FROM sqlite_sequence;/.test(line));
   writeFileSync(process.argv[3], ["PRAGMA defer_foreign_keys = ON;",
     ...ddl("table"), ...ddl("index"), ...data, ...ddl("view"), ...ddl("trigger")].join("\n"), { flag: "wx" });
   db.close();
   ```

   Import the prepared SQL with `d1 execute DB --local --config "$CONFIG"
   --persist-to "$FRESH_LOCAL_STATE" --file "$ORDERED_FIXTURE"`, then require
   `foreign_keys = 1`, zero FK violations, the pre-change schema and sentinel
   bytes. **This is not a general production dump transformer.** Multiline SQL,
   large BLOB statements, and real-data migration/import batching need their
   own reviewed restore plan. Time Travel avoids those export-import hazards.
6. Delete only the disposable remote D1 by its recorded name/UUID; trash local
   rehearsal storage. Keep sanitized evidence, not the fixture export or
   temporary account credentials.

### Observed evidence (2026-10-05 UTC)

Wrangler **4.135.0**, account's D1 Free, disposable remote
`mdwn-retention-rehearsal-20261006` / `0aeafa7f-a752-4db9-ab22-73b1e6fd6e3a`:

- Pre-change migrations 0000–0026 applied; full export downloaded successfully.
  Bookmark: `00000001-00000044-000050fb-c094f43a8966e5d468c042db8547dcdc`.
- Migrations 0027–0029 applied remotely. All 22 representative selected plans
  and covering probes passed. FKs were enabled with zero violations.
  Representation/capsule/envelope sentinel bytes and the marker remained unchanged; challenge lifetime
  shortened to 600,000 ms; the staging FK was absent.
- Time Travel restored that bookmark. Data assertions passed, the 900,000-ms
  lifetime and staging FK returned, and all three new migration journal entries
  disappeared. Undo bookmark:
  `00000002-ffffffff-000050fb-6ed27a052fff452c51bc3c566bf30bf6`.
- Raw export re-import initially failed on circular/forward table ordering.
  Offline SQLite restored the complete export; the explicitly reordered
  **synthetic fixture** subsequently restored to fresh local D1 with FK
  enforcement enabled, zero violations, preserved sentinel bytes/marker, and
  the original lifetime. Production-sized export re-import is **not proven**.
- The disposable remote D1 was deleted after successful verification; no
  rehearsal Worker was created. Local synthetic state is disposable.
- After the one-child traversal fix, a second disposable remote D1,
  `mdwn-retention-cursor-proof-20261005` /
  `0a234baa-9bb0-4e7a-a002-4e416f58b248`, passed all **updated** 22 plans and FK
  checks. Its synthetic 2,000-child tree produced 501 candidate visits, 1,000
  cursor states, an overflow flag, **zero** eligible deletion IDs, and 2,000
  retained children (5,001 rows read for enumeration; zero writes). This D1 was
  also deleted; no Worker was deployed. The final local artifact records the
  updated production traversal, not the former output-only cap.
- A separate **read-only production** probe reported `foreign_keys = 1`, zero
  violations, and zero writes. No production migrations or restores were run.

The scheduled-event suite proves the new handler locally. Actual Cron execution
on the new deployed Worker must still be observed after merge; the deploy gate
verifies the new remote indexes/FKs, not the scheduler's wall-clock delivery.

Primary platform references (retrieved for this work): [Cron configuration](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/),
[D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/),
[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/).
