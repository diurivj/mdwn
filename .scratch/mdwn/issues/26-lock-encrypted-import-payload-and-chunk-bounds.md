# Lock encrypted import payload and chunk bounds

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by: 17, 18

## Question

[Research: D1-backed encrypted import envelope](17-research-d1-import-envelope.md) establishes D1's 2 MB row/string/BLOB ceiling, while [Lock import operational bounds](18-lock-import-operational-bounds.md) permits a 16 MiB expanded Import selection and requires bounded encrypted staging with a remotely proven chunk plan. The buildable spec currently says only “bounded,” leaving an implementer to re-decide whether an encrypted Import chunk, manifest, sidecar, name/entry, Key envelope, or canonical row can exceed a D1 limit.

Lock the enforceable encrypted-payload envelope:

- maximum decoded encrypted size and count for staging chunks, plus the exact treatment of a manifest, historical-Private-Comment sidecar, and retry/idempotency metadata;
- maximum encoded/decoded size for every canonical encrypted payload created by an Import (including name/order entry, File representation, Key envelope, Comment body/attribution, and auxiliary metadata), and whether a large logical sidecar must be segmented before encryption/upload;
- browser and Worker validation points, D1 `CHECK`/schema constraints where applicable, and all-or-nothing failure behavior; and
- the disposable remote Workers Free + D1 proof matrix, including boundary and one-byte-over-limit cases, that validates the selected chunk plan without requiring a Paid Worker.

Do not reopen the settled 100-node, 32-segment, 256 KiB Markdown, 8 MiB compressed, 16 MiB expanded, private-staging, or visible-atomic-commit product bounds.

## Answer

**Resolution — binary, record-bounded staged Imports on Workers Free.** An Import never persists a raw ZIP, Archive manifest, or Private-Comment sidecar. It persists only bounded binary encrypted values and typed metadata; every normal query remains gated on the immutable Import commit marker.

### Staging envelope

- A confirmed Import has **1–40 Import chunks**. Each chunk has one raw binary encrypted payload of at most **524,288 bytes (512 KiB)**; the total of those payloads is at most **20,971,520 bytes (20 MiB)**. A maximum-sized Current File representation therefore occupies one chunk without an added content wrapper or fragmentation.
- A separate encrypted **Import staging manifest** is at most **131,072 bytes (128 KiB)**. It binds the review plan, expected chunk/record counts, chunk digests, and aggregate digests; it carries no raw Archive manifest, Markdown, sidecar, plaintext name, or capability. The service stores its ciphertext and SHA-256 digest alongside only the bounded routing/count metadata it needs.
- Chunk data is accompanied only by a typed descriptor list: record kind, opaque fixed-size IDs/references, offset, length, and a SHA-256 digest. It names at most **50 complete canonical records** per chunk. There is no free-form descriptor, metadata, retry, JSON, or base64 blob that can carry additional content. Every canonical encrypted payload fits in one descriptor range; a 512 KiB representation uses the whole raw payload range.
- The portable `.mdwn/manifest.json` remains local input. The browser parses it into the encrypted Import staging manifest. The historical Private-Comment sidecar also remains local input: the browser parses it into individual Historical Comments, never uploads it as one logical or physical sidecar field.
- At most **1,000 Historical Comments** may be created per Import, independently of the settled 100-node count. Their source bytes count toward the settled 16 MiB expanded-input limit. The 1,001st, a malformed record, or any record that exceeds its cap rejects the whole Import; no Comment is silently omitted. Historical Comments retain display body/order/timestamp/pseudonym data in a fresh Private thread and restore no former capability or author mutation authority.

All sizes in this resolution are decoded binary byte sizes, including `mdwn/enc-v1` framing. Stored values and upload payloads are binary `BLOB`s end-to-end; a base64/text/JSON representation is not an alternative size envelope.

### Canonical encrypted payload limits

An Import may create only the following bounded encrypted field types. A new field type needs a separately decided bound; it cannot inherit an unbounded “auxiliary metadata” exemption.

| Canonical encrypted value | Maximum decoded binary bytes |
| --- | ---: |
| Private File representation (and the identically bounded Public representation infrastructure) | 524,288 (512 KiB) |
| Directory-entry display-name/order ciphertext, excluding its separate Key envelope | 4,096 (4 KiB) |
| Key envelope ciphertext | 16,384 (16 KiB) |
| Historical Comment body ciphertext | 16,384 (16 KiB) |
| Historical Comment attribution / displayed-pseudonym ciphertext | 4,096 (4 KiB) |
| Any other Import-created auxiliary encrypted record | 16,384 (16 KiB) |

The already settled 256 KiB Markdown source limit, 2,000-character Comment limit, and normal File representation behavior remain unchanged. A large logical sidecar is segmented into the bounded Comment/attribution records above before encryption and upload; it is never encrypted as one “auxiliary” value.

### Validation, schema, retry, and visibility

- **Browser:** after the settled local source preflight and before opening an Import session, the browser constructs the complete encrypted record/chunk plan and measures every field, descriptor count, chunk, manifest, total payload, and Historical Comment count. A nonconforming plan creates no session or upload.
- **Worker:** the upload route rejects an excessive declared length and streams/counts the raw body before buffering it. It validates the binary envelope/header, descriptor kind/range/count, opaque references, digest, per-field size, session state, and authorization without decrypting private content. It never accepts plaintext names, Markdown, Comments, capabilities, or a free-form metadata payload.
- **D1:** schema constraints mirror the limits: `length()` checks on every canonical ciphertext column in the table above; `import_sessions` checks for the 128 KiB manifest, at most 40 chunks, 20 MiB aggregate payload, at most 2,000 records, and at most 1,000 Historical Comments; and `import_chunks` checks for a 0-based sequence below 40, a 512 KiB payload, 1–50 records, and a 32-byte SHA-256 digest. `(import_id, sequence)` is unique. Aggregate byte/count values are computed and conditionally maintained by the service rather than trusted from the client.
- **Retry:** the sole idempotency identity is `(import_id, sequence, SHA-256(payload))`. A repeat of the exact bytes returns the original success and creates no duplicate record. A different body/digest for an accepted sequence permanently fails that Import session; the browser must re-preflight and start a new session for a changed or re-encrypted plan. There is no arbitrary retry-metadata field.
- **Atomic visibility:** valid encrypted canonical rows are staged with their immutable Import ID and remain excluded from every normal tree, File, direct-read, Share, export, count, and background query. A Replace candidate is import-scoped and leaves the old current representation visible until the marker commits. The final short transaction rechecks every expected sequence/digest/count, expiry, target Owner, current import authority, reviewed revisions, and collision actions, then writes the one immutable Import commit marker. Any failed upload, mismatch, cancellation, expiry, disconnect, stale target, lost Grant, or failed commit leaves no marker and therefore no visible partial create or Replace; cleanup deletes the unreachable staged material.

### Disposable Workers Free + D1 proof gate

A disposable remote deployment with the real migrations is a release gate for encryption-persistence changes and release candidates. It must use Workers Free and D1 Free only—no paid fallback—and prove all of the following:

1. Exact-boundary acceptance and one-byte/one-record-over rejection for the 128 KiB staging manifest, 512 KiB chunk, 20 MiB chunk aggregate, 40-chunk count, 50-record chunk count, every canonical ciphertext cap, and 1,000 Historical Comment count.
2. A browser-built maximum legal expanded-input selection and, separately, legal high-node/high-Historical-Comment selections; synthetic protocol tests cover the exact chunk/count boundaries that a particular source distribution may not reach.
3. The deployed Worker performs every permitted worst-case upload and commit inside the 50-statement D1 Free invocation limit, including authorization and validation work. A failed proof requires a smaller bounded plan or a more efficient Free-compatible write plan, never a paid plan.
4. Exact duplicate retry is idempotent; a mismatched retry, missing sequence, malformed descriptor, cancellation, expiry, disconnect, stale revision, lost authority, and failed commit create no marker and expose nothing through any normal query class. A staged Replace continues to show the old representation.
5. A successful marker makes the complete hierarchy and authorized replacements visible together, and direct schema-constraint tests prove that malformed/oversized values cannot bypass Worker checks.
