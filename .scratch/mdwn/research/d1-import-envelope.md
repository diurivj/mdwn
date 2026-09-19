# D1 envelope for browser-preflighted, all-or-nothing imports

Researched 2026-09-16 for the new Wayfinder import research ticket. Scope: a
TypeScript React Router v8 Framework Mode application on Cloudflare Workers and
one D1 database, where the browser encrypts new content before upload. This is
research only: it does not settle the product caps or change the map/ticket.

**Method.** Cloudflare's current first-party documentation was checked. No local
capability test was run: the relevant behavior (the D1 binding's atomic batch,
and published limits) is explicitly documented, while a Miniflare test would
not prove the production service limits.

## Bottom line

- A D1 `db.batch()` is an atomic SQL transaction: if any statement fails, D1
  aborts/rolls back the whole sequence. Thus a *small, bounded* imported tree
  can be inserted atomically in one request, provided its entire insert set fits
  the per-invocation D1 query count and finishes within D1/Worker resource
  limits. [D1 binding API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- That is not a safe basis for an unbounded or merely "practical" archive import.
  Workers Free permits only **50 D1 queries per invocation** and Workers Paid
  **1,000**; D1 also applies a **30-second maximum SQL query duration to the
  entire batch call**, and operations including result serialization consume the
  Worker CPU/memory envelope. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
  [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- The Free Worker has only **10 ms CPU** and **128 MB per isolate**. Browser-side
  ZIP extraction, Markdown validation, UTF-8 decoding, encryption, and hashing
  should therefore remain browser work; the Worker should stream or accept
  already-prepared encrypted data and perform small, bounded structural checks.
  Waiting for D1 is not CPU time, but parsing/serializing/buffering is.
  [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- Recommend a product cap that deliberately keeps the first implementation in
  one atomic D1 batch (provisional envelope below), **plus** design the data
  access seam around an import-commit marker now. The marker makes later
  chunked staging possible without exposing a partial tree.

## 1. Documented Cloudflare facts

The figures in this section are service limits, not application-policy
recommendations. They are time-sensitive and all link to their owning current
Cloudflare page.

### 1.1 HTTP request and Worker execution envelope

| Constraint | Workers Free | Workers Paid | Consequence for imports |
| --- | ---: | ---: | --- |
| Dynamic Worker requests | 100,000/day | no limit | Each upload/commit request consumes a Worker invocation. |
| CPU per HTTP request | 10 ms | 5 min maximum, 30 s default | Free cannot reliably parse/encrypt/decompress a sizeable import server-side. CPU excludes network/D1 waiting. |
| Memory | 128 MB per isolate | 128 MB per isolate | Do not read a near-limit request, ZIP, decrypted text, encrypted output, and JSON representation into memory together. Stream/chunk; Workers specifically recommends streaming rather than buffering oversized bodies. |
| HTTP request duration | no hard limit while client stays connected | same | This does **not** remove the CPU, D1 query, or client-disconnect risk. Work can be cancelled after response/client disconnect unless managed with `waitUntil()`, which extends at most 30 s. |
| Incoming request body (Cloudflare Free/Pro zone) | 100 MB | 100 MB | This is a Cloudflare account-zone limit, not a Workers-plan limit. It is only an outer transport ceiling, not a safe import size. |
| D1 subrequests / queries per invocation | 50 | 1,000 | Bounds a one-batch transaction's statements in a Worker invocation. |

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

**Clarification:** D1 calls are subrequests. The D1 page publishes the more
specific `Queries per Worker invocation` limit of 50 Free / 1,000 Paid, so use
that number when sizing a D1 batch; it is not valid to infer that an arbitrary
number of SQL statements can be hidden inside one JavaScript API call.
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

### 1.2 D1 database, statement, transaction, payload, and throughput envelope

| Constraint | Published value | Consequence for this model |
| --- | ---: | --- |
| D1 database size | 500 MB Free; 10 GB Paid | Applies to one database, including indexes; not an import payload limit. |
| Account D1 storage | 5 GB Free; 1 TB Paid | An account-wide deployment quota, also including indexes. |
| Largest string, BLOB, **or table row** | 2,000,000 bytes (2 MB) | Each ciphertext/representation/key-envelope row must stay below 2 MB. A source file cannot safely map to one D1 row near that boundary because encryption/encoding and other row columns add overhead. |
| SQL statement length | 100,000 bytes | Limits generated multi-VALUES SQL text; use prepared statements/batches rather than interpolating a huge statement. |
| Bound parameters per query | 100 | Limits how many rows can be packed into one multi-row `INSERT`; actual rows/query depend on the column count. |
| SQL query duration | 30 s | The documentation says this also applies to the **entire `batch()` call**. |
| D1 queries per Worker invocation | 50 Free; 1,000 Paid | Hard planning limit for a single transaction submitted through the Worker binding. |
| Rows/table | unlimited, subject to storage | No helpful node-count ceiling. |
| Database concurrency | one query at a time per D1 database | Long commits block/queue ordinary vault operations; a full queue may produce `overloaded`. |

Source: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

D1 is SQLite-compatible and D1's `batch()` takes an array of prepared
statements. It executes the statements sequentially as a SQL transaction. If
one fails, D1 returns the error for that statement and aborts/rolls back the
whole sequence. The binding docs say D1 otherwise operates in auto-commit,
which is why individual `.run()` calls are *not* a transaction.
[D1 binding API](https://developers.cloudflare.com/d1/worker-api/d1-database/)

D1 returns `rows_read`, `rows_written`, `size_after`, and SQL duration metadata
for each prepared statement/batch result. This is suitable for logging aggregate
operational metrics, but the E2E design should not log plaintext filenames,
paths, or document content. [D1 return objects](https://developers.cloudflare.com/d1/worker-api/return-object/)

On Free, D1 also limits usage to **5 million rows read/day**, **100,000 rows
written/day**, and **5 GB total storage**. Rows written include `INSERT`,
`UPDATE`, and `DELETE`; indexed writes add an additional written row for the
index. Hitting a daily limit makes further D1 queries fail until reset at
00:00 UTC. These are account-level abuse/capacity inputs, not atomicity
mechanics. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

Cloudflare describes a D1 database as inherently single-threaded. It advises
splitting updates/deletes affecting hundreds of thousands of rows or hundreds
of MB into smaller batches (example: 1,000 rows), because a single operation
exceeds execution limits. This supports treating a large import as a staged
operation, rather than holding a long import transaction open.
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

### 1.3 What is *not* documented as a usable cap

Cloudflare does **not** publish a `batch()` array-length, total batch-request
bytes, or maximum result-size number on these pages. Do not invent one. The
practical outer constraints are the 50/1,000 D1 queries per invocation, the
30-second entire-batch SQL timeout, the 128 MB isolate, the 2 MB row value, and
HTTP request-body limit above. A production proof at the selected plan and
schema is still required before relying on any exact statement count.

## 2. Can an imported tree be atomic in one D1 transaction?

### Yes, for a deliberately small tree

**Documented fact:** `db.batch()` gives all-or-nothing SQL behavior across the
prepared statements it is passed. The hierarchy's rows can therefore be one
atomic import transaction if all statements fit the limits in §1.2.
[D1 binding API](https://developers.cloudflare.com/d1/worker-api/d1-database/)

**Model-specific sizing assumption (not a Cloudflare fact):** with one
representation and one key envelope per file, an imported directory requires at
least: `vault_nodes`, `directories`, and a `directory_entries` row (3 logical
inserts). An imported file requires at least: `vault_nodes`, `files`,
`file_representations`, `directory_entries`, and a key-envelope row (5 logical
inserts). Constraints, indexes, audit rows, per-recipient envelopes, and root
attachment can increase that number.

If inserted one logical row per statement, a tree with 10 files and 2
directories already needs a lower-bound **56 statements** (10 × 5 + 2 × 3),
before any extra records. That exceeds Free's 50-query invocation limit. This
is an arithmetic illustration based on the stated data model, not a measured
schema result.

A carefully designed multi-row prepared `INSERT` can reduce statement count,
but only up to the 100-bound-parameter limit and only when all rows share a
compatible shape. It does not remove the 2 MB row limit, total batch timeout,
or Worker memory/CPU limits. It also makes a server payload format and error
mapping more complex. The later implementation must calculate statement count
from the actual table columns/binds and reserve headroom for authorization and
idempotency checks.

### No, not as a general practical-import guarantee

The useful conclusion is not “D1 has no transactions”; it is: **a single batch
is a sound fast path only when the product's cap is derived from a worst-case
schema statement/payload budget.** It is unsafe to promise that a normal user
can import arbitrary folders or ZIPs atomically in one D1 transaction. A large
transaction competes with the single-threaded database, must finish within 30 s,
and is vulnerable to Worker request/cpu/memory failures.

## 3. Inputs for later product caps

These are recommendations, intentionally separate from documented platform
facts. They use source-byte values so that encryption overhead/base64/JSON does
not silently consume a quota intended for source data.

### Recommended first-release envelope: one-batch only

| Product decision | Recommendation | Reasoning / status |
| --- | ---: | --- |
| Maximum new nodes | **100** | Small enough to be understandable and to leave room under Paid's 1,000-query cap even if rows are one statement each (~500 base logical rows under the above file model, before extra rows); deliberately **not supported on Workers Free** with naive per-row statements. Make the production plan a precondition, or batch multi-row inserts after a proof. |
| Maximum directory depth | **32** | Not a Cloudflare limit. It bounds client traversal/path-validation/recursion and produces reasonable error UX. It should be enforced after normalizing path separators and rejecting traversal/duplicate logical paths. |
| Maximum source bytes per Markdown file | **256 KiB** | 256 KiB leaves ample headroom under D1's 2 MB row/string/BLOB limit for a single ciphertext representation plus envelope/metadata, while keeping browser parse/encrypt and Worker serialization bounded. It is a conservative app policy, not a claim that D1's limit is 256 KiB. |
| Maximum archive/input bytes | **8 MiB compressed ZIP; 16 MiB total uncompressed selected Markdown source** | Far below the 100 MB HTTP ceiling and 128 MB Worker isolate. Validate both compressed input and total expanded source before writes; the expanded cap is the ZIP-bomb control. Loose-file/folder selection uses the 16 MiB total source limit. |

**Why 100 nodes rather than treating 1,000 as the node cap:** nodes are not SQL
statements. A file expands to multiple persistence rows, and the exact
key-envelope fan-out is unresolved. At 100 files, the five-row lower bound is
already 500 inserts; normal authorization/idempotency/attachment work and any
additional envelope rows consume the remaining 500 statement budget. 100 is
therefore a tentative Paid-plan envelope pending a real schema and benchmark,
not a Free-plan promise.

**If Free must be supported initially:** choose a much smaller cap only after
measuring the actual batch statement count. With one-row-per-statement writes,
50 is the total invocation cap, so even the 10-file / 2-directory illustration
fails. Multi-row `INSERT`s can make Free viable for a modest cap, but that is an
implementation proof obligation, not an inference from `batch()` atomicity.

**Archive recognition and preflight:** recognition, file-extension policy,
UTF-8 decoding, archive central-directory inspection, path/depth/node/byte
counting, Markdown policy, encryption, and manifest construction belong in the
browser before any upload. The server must independently validate the declared
encrypted manifest's counts, account ownership, ID uniqueness, ciphertext row
sizes, and expected chunk/hash list; client preflight is UX, not a trust
boundary. These are design recommendations, not Cloudflare-documented behavior.

## 4. Minimum staged/commit design if the one-batch envelope is too small

No staging schema exists today. If a later product decision needs imports beyond
the proven one-batch envelope, the minimum design that preserves “no visible
partial hierarchy” is below.

1. **Create a private import session.** Store an opaque `import_id`, target
   account, expiry, expected encrypted-manifest digest, expected node/byte/chunk
   counts, and state `uploading`. Authenticate every request to that account.
   It must not create a visible root entry or mutate an existing visible
   directory.
2. **Upload idempotent, bounded chunks to private staging.** Every staged record
   is scoped by `import_id`; it contains only the encrypted node/representation/
   entry/envelope material and minimum necessary routing metadata. Enforce the
   same row and total budgets on every chunk. Repeated chunk requests are safe
   only if their digest and sequence match the first accepted write. On failure,
   expiry, cancellation, or disconnect, leave it uncommitted; an authenticated
   cleanup job may delete it later.
3. **Verify completion before visibility.** The final request checks that all
   expected chunks are present exactly once, their ciphertext digests/counts
   match the browser-signed/hashed manifest, every reference stays within the
   import/account, and no staged record references visible content other than the
   account's hidden root through the controlled final attachment.
4. **Make visibility one small atomic operation.** Insert an immutable
   `committed_imports(import_id, account_id, committed_at, manifest_digest)` row
   (or atomically change a single import-session commit marker) in one D1 batch
   after verification. Every vault listing/traversal/read query must require that
   commit marker and account ownership. The logical attachment to the hidden root
   must also be gated by that marker. Do **not** mark individual nodes/entries
   visible one by one.
5. **Treat staged rows as unreachable data, not a partial vault.** They are
   excluded from every normal Files/tree/search/export query and are accessible
   only through authenticated import-session operations. Before commit, the user
   sees no new File or Directory. After the one-row commit, the entire hierarchy
   becomes reachable together. A failed final commit leaves no visible content.

This is a recommendation, not a Cloudflare feature. Its core invariant is a
query invariant: a record is visible iff it is owned by the account **and** its
`import_id` has a matching committed marker (or it is legacy/non-import content
that is explicitly visible). A separate staging table is often clearest, but
canonical tables with an immutable `import_id` plus that mandatory marker can
also work. The latter avoids a massive transactional copy from staging to
canonical tables.

**Privacy conditions for staging:** the Worker/D1 should receive the same
ciphertext/envelopes it would store finally, never browser plaintext. Avoid
plaintext path/name fields and diagnostics. `import_id`, sizes, record counts,
timing, encrypted type/structural metadata where unavoidable, and ciphertext
lengths remain server-visible metadata; E2E encryption does not hide those.
Use unguessable IDs, strict account predicates, short retention, no plaintext
logs, and deletion/expiry policy. This pattern protects the product requirement
of no visible partial hierarchy; it does not make uncommitted ciphertext absent
from provider storage.

## 5. Decision checklist and open validation work

Before locking any number, a later implementation/design decision should:

1. State whether Workers Paid is a requirement. If not, benchmark the exact
   multi-row statement plan under the 50-query Free limit.
2. Turn the logical data model into a worst-case formula: directories, files,
   representations/file, key envelopes/file (including future sharing fan-out),
   entries, indexes, root attachment, and idempotency/audit rows.
3. Build a local Miniflare test and a disposable remote D1 soak test for the
   exact schema: max accepted tree, a deliberately failing final statement
   proving rollback, elapsed SQL duration, Worker CPU/memory, encoded request
   bytes, row sizes, and retry/idempotency behavior. Local success alone does
   not establish Cloudflare production performance limits.
4. Test adversarial ZIPs: duplicate paths after normalization, `..`/absolute
   paths, excessive depth, invalid UTF-8, malformed recognized bundles,
   compressed and expanded byte caps, encrypted payload expansion, and failure
   at every upload/commit boundary.
5. Adopt the commit-marker read predicate before shipping any staged path. It
   must cover Files list, directory traversal, search, direct-ID reads, sharing,
   exports, counts, and background jobs; otherwise a staged node can leak as a
   partial hierarchy.

## Sources (primary Cloudflare documentation)

- [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1 platform limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 Worker Binding API / `D1Database.batch`](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
- [D1 return objects](https://developers.cloudflare.com/d1/worker-api/return-object/)
- [D1 error list](https://developers.cloudflare.com/d1/observability/debug-d1/)
