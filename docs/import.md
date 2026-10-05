# Import preflight and review

Ticket 29 adds the browser-local half of mdwn Import: the **Import** command in
the Files chrome, drag-and-drop and file/folder selection, the bounded source
preflight, the collision review with deterministic **Keep-both** names, target
eligibility, and the measured encrypted record/chunk plan. It creates no Import
session and uploads nothing; staging upload, the atomic Import commit marker,
and Historical Comment records are ticket 30's work.

All modules live in `app/import/` and are browser-only except where a test
target imports the pure pieces directly:

| Module | Role |
| --- | --- |
| `limits.ts` | Settled local bounds, staging envelope bounds, safe `ImportError` codes/messages |
| `source.ts` | Normalizes a loose selection or recognized archive into a bounded tree |
| `review.ts` | Pure collision allocation and review model |
| `plan.ts` | Encrypted record/chunk plan and `import-staging-manifest` measurement |
| `targets.ts` | Eligible Import-target derivation from the decrypted snapshot |
| `browser.ts` | File/DataTransfer inputs, Replace document reads, File-head signer |
| `ImportControl.tsx` | Files-chrome command, hidden inputs, drop handling, review dialog |

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
any other context opens a target chooser instead of a review.

New descendants always receive the target Directory Owner's ownership. When
the target belongs to another Account, the review states that new items will
not appear in the actor's **Export my Files**.

## Collision review

Collisions never overwrite silently. For each candidate colliding with an
existing sibling (case- and canonically-equivalent spellings fold together):

- **Keep both** is the safe default; it uses the locked reservation, bytewise
  source-path sort, ` (n)` suffix starting at 2, and availability rule from
  `mdwn/namespace-v1`. An explicit source `report (2).md` keeps that name even
  when a colliding `report.md` needs a suffix; literal suffixes have no special
  meaning.
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
File heads, legacy entry keys, and paired Public representations; plus one
encrypted `import-staging-manifest` binding the reviewed plan digest, chunk
digests, counts, and aggregate digest. Every canonical field is checked against
its settled ceiling before chunking:

- File representation / Public representation: 524,288 bytes
- Directory-entry name/order ciphertext: 4,096 bytes each
- Key envelopes (Directory/File capability, representation key, entry key): 16,384 bytes
- File head: 4,096 bytes

Chunks are greedy complete-record ranges: at most 524,288 raw payload bytes and
50 descriptors each, 1–40 chunks per session, at most 20 MiB payload and 2,000
descriptors in aggregate, and a staging manifest of at most 131,072 bytes. The
manifest ciphertext's SHA-256 and the sequence-ordered aggregate payload digest
are recorded in server-visible routing metadata (`ImportStagingMetadata`).
Any bound violation throws an `ImportError` naming the local issue and limit
with remove/fix, re-export, or split-and-retry guidance; no session exists yet
and nothing is uploaded.

Ticket 30 extends this plan with Historical Comment records and binds the
chunks to an Import session and commit marker. Until then, the review's
terminal state is the measured plan; the UI says explicitly that no content has
been uploaded.

## Failure behavior

`ImportError` carries only a code and safe local detail — item name, measured
value, configured limit — never file content. `importProblemMessage` maps each
code to a concrete next step. Unsupported, invalid, ambiguous, or over-limit
input fails before review; a blocked collision keeps the review open until the
person resolves it.

## Verification seams

- `tests/import-source.test.ts` — loose/archive acceptance, hierarchy,
  UTF-8/path/duplicate rejection, every settled bound at the limit and one
  over, implicit-parent counting, compressed-before-read, Historical Comments.
- `tests/import-review.test.ts` — deterministic Keep-both ordering, literal
  suffixes, folded/Unicode collisions, Skip/Replace/Rename, over-limit
  generated names, duplicate-source-path rejection, counts, empty plans.
- `tests/import-plan.test.ts` — record kinds, descriptor offsets/digests,
  chunk bounds for a 100-node selection, manifest contents, Replace and
  Publication pairing, fail-closed Replace cases.
- `tests/import-targets.test.ts` — owned/read-write/read-only/direct-File
  eligibility and ownership.
- `tests/import-browser.test.ts` — File and DataTransfer input reading,
  empty-folder preservation, fallback to `DataTransfer.files`, expanded guard.
- `e2e/import-preflight.spec.ts` — the Files-chrome command, loose files,
  folder selection, archive recognition, synthetic drop, unsupported input,
  deterministic Keep-both names, measured plan, and zero Import or tree writes
  across Chromium, Firefox, and WebKit.
