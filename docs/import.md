# Import preflight, staging, and visible-atomic commit

Ticket 29 adds the browser-local half of mdwn Import, and ticket 30 adds the
private staging protocol and the visible-atomic commit. Together they mean a
person either sees the whole imported tree or sees nothing: confirmation
creates an Import session, the browser uploads encrypted chunks, and one final
commit transaction materializes the complete hierarchy and any authorized
Replace at once.

All modules live in `app/import/`; `staging.ts` is shared by the browser and
the Worker, `staging.server.ts` is Worker-only, and the rest are browser-only
except where a test target imports the pure pieces directly:

| Module | Role |
| --- | --- |
| `limits.ts` | Settled local bounds, staging envelope bounds, safe `ImportError` codes/messages |
| `staging.ts` | Binary session/chunk wire format, record-kind table, structural validation |
| `staging.server.ts` | Session, chunk, commit, cancel; completeness checks; atomic materialization |
| `staging-client.ts` | Browser session/chunk/commit/cancel calls over the private client |
| `source.ts` | Normalizes a loose selection or recognized archive into a bounded tree |
| `review.ts` | Pure collision allocation and review model |
| `plan.ts` | Encrypted record/chunk plan, Directory listing heads, Historical Comments, `import-staging-manifest` |
| `targets.ts` | Eligible Import-target derivation from the decrypted snapshot |
| `browser.ts` | File/DataTransfer inputs, Replace document reads, File/listing head signers |
| `ImportControl.tsx` | Files-chrome command, hidden inputs, drop handling, review dialog, upload/commit progress |

## Accepted input and bounds

- A recognized mdwn ZIP archive (ticket 28's `.mdwn/manifest.json` format), or
  one or more UTF-8 `.md`/`.markdown` files and folders. A `.zip` selection must
  be exactly one recognized archive; archive and loose input are never mixed.
  A selected folder becomes a child Directory of the Import target and
  preserves its hierarchy, including explicitly empty dropped folders.
- At most **100** normalized source File/Directory nodes, counting implicit
  parents and every candidate later skipped or replaced.
- At most **32** normalized Directory segments in a source path.
- At most **256 KiB (262,144 UTF-8 bytes)** per Markdown source.
- At most **8 MiB** compressed for a recognized archive, checked at the ZIP
  byte boundary before a read.
- At most **16 MiB** expanded for every selection, including archive manifests
  and Private-Comment sidecars; loose input has no compressed allowance.
- At most **1,000** Historical Comments.

Every source path component runs through `mdwn/namespace-v1`: NFC 17 display
form, the exact segment profile (1–255 UTF-8 bytes, no controls, separators,
bidi controls, trailing space/dot, Windows device stems), and folded
comparison-key duplicate rejection. Absolute, traversing, empty, and malformed
components create no session and upload nothing.

## Target eligibility and ownership

An **Import target** is a Directory the actor owns or reaches through a
current read/write Directory Grant, decided from the already-decrypted snapshot
(`canCreate`, the same effective authority the tree's create path enforces). A
read-only Directory Grant and any direct File Grant are never eligible, and a
direct File Grant exposes no parent Directory to infer. A drop or command in
any other context opens a target chooser instead of a review; the chooser
covers the eligible Directories already reachable in the current decrypted
snapshot, and otherwise asks the person to open their own Files or an editable
shared folder first.

New descendants always receive the target Directory Owner's ownership. When
the target belongs to another Account, the review states that new items will
not appear in the actor's **Export my Files**.

## Collision review

Collisions never overwrite silently. For each candidate colliding with an
existing sibling (case- and canonically-equivalent spellings fold together):

- **Keep both** is the safe default; it applies the locked reservation, bytewise
  source-path sort, ` (n)` suffix starting at 2, and availability rule from
  `mdwn/namespace-v1` (the vendored `keepBothCandidate`/`comparisonKey`
  helpers), reimplemented here only so a per-candidate Skip/Replace/Rename or
  over-limit block can interleave with allocation instead of aborting it. A
  fixture test pins the result against `allocateKeepBothNames` for collisions
  without over-limit names. An explicit source `report (2).md` keeps that name
  even when a colliding `report.md` needs a suffix; literal suffixes have no
  special meaning.
- **Skip** omits the candidate; skipping a Directory omits its subtree. Skipped
  and replaced candidates still count toward the 100-node bound.
- **Replace** (existing Files only) updates that File's current representation
  while keeping its identity; the plan preserves its Private/Public threads and
  active Publication (an active Publication is paired as on an ordinary save).
- **Rename** supplies an explicit unused name.
- Directories never silently merge; a generated name that would exceed the
  255-byte segment profile is never truncated and requires Rename, Skip, or an
  authorized File Replace.

The review displays source count, create/replace/skip counts, maximum depth,
compressed/expanded sizes, target, ownership, and every generated Keep-both
name. No valid subset is ever imported automatically: every collision needs a
resolved choice before **Import** is enabled.

## Encrypted plan and staging envelope

After a conforming review, confirmation measures the complete plan locally:
canonical `mdwn/enc-v1` envelopes for Directory entry names/order, Directory
capabilities, File capabilities, representation keys, representations, signed
File heads, legacy entry keys, and paired Public representations; one signed
Directory listing head for the Import target and for every created Directory
with children; typed structural records (`node-directory`, `node-file`,
`replace`, `comment-meta`); Historical Comment records (fresh thread capability
wrapped under the File capability key, body, content-key wrapper, attribution,
attribution-key); plus one encrypted `import-staging-manifest` binding the
reviewed plan digest, chunk digests, counts, and aggregate digest. Every
canonical field is checked against its settled ceiling before chunking:

- File representation / Public representation: 524,288 bytes
- Directory-entry name/order ciphertext: 4,096 bytes each
- Key envelopes (Directory/File capability, representation key, entry key, comment key/attribution key): 16,384 bytes
- Historical Comment body ciphertext: 16,384 bytes; attribution/displayed-pseudonym ciphertext: 4,096 bytes; encrypted display-metadata ciphertext: 4,096 bytes
- File head: 96 canonical bytes; listing ciphertext: 524,288 bytes

The signed Directory listing head follows the existing `directories.listing_ciphertext`
commitment bound (`MAX_LISTING_BYTES`, 524,288) rather than the 16,384-byte
auxiliary-metadata cap: it commits the target's whole current namespace,
including pre-existing siblings that the Import did not create, and the same
bound already governs every ordinary create/rename/reorder. The listing digest
(32 bytes) and signature (64 bytes) are separate typed records.

Chunks are greedy complete-record ranges: at most 524,288 raw payload bytes and
50 descriptors each, 1–40 chunks per session, at most 20 MiB payload and 2,000
descriptors in aggregate, and a staging manifest of at most 131,072 bytes. Each
chunk's 32-byte digest is the SHA-256 of its encoded body (framing plus
payload); the plan's aggregate digest is the SHA-256 over the sequence-ordered
chunk digests, which transitively binds every payload byte while keeping the
commit recheck tiny. The manifest's canonical digest (`digestEnvelope`, the
SHA-256 of the whole envelope) and that aggregate are recorded in
server-visible routing metadata (`ImportSessionMetadata`).

Any bound violation throws an `ImportError` naming the local issue and limit
with remove/fix, re-export, or split-and-retry guidance; no session exists yet
and nothing is uploaded.

## Staging and visible-atomic commit (ticket 30)

Confirmation performs three steps, all device-proof guarded and all over the
binary protocol in `staging.ts`:

1. **Session** (`POST /api/private/imports`): the body is the browser-minted
   256-bit Import ID, target ID, reviewed revision, expected
   record/chunk/byte/comment counts, aggregate and manifest digests, per-kind
   record counts, and the encrypted manifest. The Worker verifies the manifest
   digest, the target Directory authority and Owner, rejects an excessive
   declared length, and stores `import_sessions` + `import_session_kinds`.
   Sessions expire after 24 hours.
2. **Chunks** (`PUT /api/private/imports/:id/chunks/:sequence`): each body is
   `magic || descriptorCount || descriptors || payload`. Descriptors are typed
   (kind, opaque fixed-size references, offset, length, digest) and every byte
   of the body is covered by exactly one descriptor range. The Worker streams
   and counts the body, reuses the device proof's authenticated body digest as
   the chunk identity, verifies every record digest (one cached digest for
   empty records), inspects envelope headers (purpose, vault, identity refs,
   suite) without decrypting, parses the fixed structural records, and inserts
   `import_chunks` plus one typed `import_records` row per descriptor under
   server-maintained aggregate counters. Record bytes are stored once, in the
   chunk payload: `import_records` carries only the chunk-relative
   `offset`/`length`, and the `import_record_payloads` view reassembles a
   record's bytes for commit-time structural checks. Exact retries return the
   original success; a different body for an accepted `(import_id, sequence)`
   permanently fails the session.
3. **Commit** (`POST /api/private/imports/:id/commit`): rechecks initiator,
   target Owner, live target authority and reviewed `entries_revision`, expiry,
   every expected sequence/digest/count, per-kind counts, plan completeness,
   Replace pairing against the current File revision/representation, Publication
   link/revision pairing, and the File/listing head signatures. The final
   transaction writes the immutable `import_commits` marker and, in the same
   transaction, materializes `vault_nodes` (each carrying the immutable
   `import_id`), `directories`, `directory_entries`, `files`,
   `file_representations`, `public_representations`, Replace pointer updates,
   and the fresh Historical Comment thread rows; the target listing head and
   revision advance together. Commit is idempotent for an already-committed
   session.

No canonical tree/File/Comment row exists before that transaction, so every
normal tree, File, direct-read, Share, export, count, and background query
naturally sees either a non-Import record or a committed one;
`committedNodeVisible` in `app/sharing/access.server.ts` adds the literal
commit-marker predicate to the shared access query as defense in depth. A
cancelled (`DELETE /api/private/imports/:id`), expired, failed, or mismatched
session stays unreachable, and lazy bounded cleanup deletes its staged rows; a
committed session keeps its marker and loses only its staging records.

Historical Comments are the local sidecar, parsed per record and never
uploaded as a sidecar. They start one fresh Private thread per imported File
whose thread key is wrapped under the File capability key, so the thread
follows current File-read access and restores no former author authority; the
read path serves its envelope as a distinct `import` mode. The body, the
displayed pseudonym, and the historical display timestamps are all encrypted
`mdwn/enc-v1` records; timestamps are sealed under each Comment's own content
key, so a thread-capability rotation rewraps the wrapper and leaves them
readable, and no user-authored timestamp is ever plaintext at rest. Comments
are numbered server-side in sidecar order. All historical comments belong to
the importing Account, so one thread attribution keeps the sidecar's displayed
pseudonym for the history; a sidecar whose comments carry different pseudonyms
displays the first one, because the thread model holds one attribution per
author.

The preflight counts Historical Comments only for Files the review will create:
a skipped or replaced candidate contributes none. A replaced candidate that
carries Comment history fails closed with a named error (`historical-comments-replace`)
rather than silently dropping it or merging into the existing thread, because
Replace preserves that File's current Private/Public thread.

## Failure behavior

`ImportError` carries only a code and safe local detail — item name, measured
value, configured limit — never file content. `importProblemMessage` maps each
code to a concrete next step. Unsupported, invalid, ambiguous, or over-limit
input fails before review; a blocked collision keeps the review open until the
person resolves it; an interrupted upload cancels the session and tells the
person to check the folder before retrying.

## Verification seams

- `tests/import-source.test.ts` — loose/archive acceptance, hierarchy,
  UTF-8/path/duplicate rejection, every settled bound at the limit and one
  over, implicit-parent counting, compressed-before-read, Historical Comments.
- `tests/import-review.test.ts` — deterministic Keep-both ordering, literal
  suffixes, folded/Unicode collisions, Skip/Replace/Rename, over-limit
  generated names, duplicate-source-path rejection, counts, empty plans.
- `tests/import-plan.test.ts` — record kinds, descriptor offsets/digests,
  chunk bounds, manifest contents, Replace and Publication pairing, listing
  heads, fail-closed Replace cases.
- `tests/import-targets.test.ts` — owned/read-write/read-only/direct-File
  eligibility and ownership.
- `tests/import-browser.test.ts` — File and DataTransfer input reading,
  empty-folder preservation, fallback to `DataTransfer.files`, expanded guard.
- `tests/worker/import-staging.test.ts` — full session → chunks → commit flow,
  tree visibility, exact-retry idempotency, mismatched-retry permanent
  failure, malformed/over-count framing, D1 `CHECK` bounds (including the
  visible-atomic node guard), stale target revision, cancel and expiry
  cleanup, Historical Comment thread read, manifest-digest rejection.
- `e2e/import-preflight.spec.ts` — the Files-chrome command (including a
  `.zip` selection), loose files, folder selection, archive recognition,
  synthetic drop, unsupported input, deterministic Keep-both names, and a
  complete browser Import (session, chunks, commit) across Chromium, Firefox,
  and WebKit. The synthetic drop is skipped in WebKit because its constructed
  `FileSystemEntry` cannot produce a File; the `DataTransfer.files` fallback is
  covered in unit tests.

## Release gate: disposable remote proof

Ticket 26 requires a disposable remote Workers Free + D1 proof before release
whenever encryption-persistence schema changes and for release candidates. It
must cover exact-boundary acceptance and one-unit-over rejection (128 KiB
manifest, 512 KiB chunk, 20 MiB aggregate, 40 chunks, 50 records per chunk,
every canonical ciphertext cap, 1,000 Historical Comments), retries and
mismatches, expiry/failure/stale-authority, no-visible-partial-tree, and that
every worst-case upload and commit fits the 50-statement D1 Free invocation
limit. Ticket 33 extends the same run to its release-gate criteria: a maximum
262,144-byte-source File create and save, one-byte-over rejection of the
canonical 512 KiB bound, a staged Import Replace that stays invisible until
the marker, an active-Publication paired update, stale-conflict preservation,
and a missing-sequence rejection — plus every check above.

Run it with a Cloudflare login:

```sh
npx wrangler login
node scripts/import-proof.mjs          # provision, prove, tear down
node scripts/import-proof.mjs --keep   # keep the deployment for inspection
```

`scripts/import-proof.mjs` creates a throwaway `mdwn-import-proof` Worker and
`mdwn-import-proof-db` D1, applies the committed migrations, seeds one
device-bound Session directly through `wrangler d1 execute` (no test-only
production endpoints), and runs `tests/proof/import-proof.test.ts` through
`vitest.proof.config.ts` against the deployed URL. The proof exercises the
100-node commit, the exact 20 MiB/40-chunk/50-record/512 KiB envelope and its
one-over rejections, the 128 KiB manifest boundary, every per-kind ciphertext
cap at its exact size and one byte over, exact/mismatched retries, cancel and
expiry, stale revision and Owner, no-visible-partial-tree reads, direct
deployed-`CHECK` one-over rows, and (ticket 33) a maximum-source create/save,
staged Replace invisibility, paired active-Publication saves, stale-conflict
preservation, and a missing-sequence rejection. Because D1 Free hard-fails an
invocation above 50 queries and Workers Free reports `exceededCpu` for
over-budget invocations, a clean pass on a Free account is the budget evidence.

Executed 2026-10-05 on a Workers Free account: the first run exposed two
`exceededCpu` 503s on the largest invocations, so staging was made more
efficient (record bytes stored once and range-sliced from the chunk payload,
the proof's authenticated body digest reused as the chunk identity, the
aggregate taken over chunk digests, and empty-record digests cached). Two
subsequent full runs passed 10/10 with zero failed invocations across 91
observed requests, including the worst-case upload and commit, then deleted
the disposable Worker and D1. Re-run it after any change to the staging
schema, bounds, or commit path; if it fails, reduce the bounded plan or make
the commit more efficient — never require a paid plan.
