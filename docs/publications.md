# Publications and the Public reader (ticket 22)

A **Publication** exposes exactly one File through a **Public link**. It is
independent of Shares and Grants, follows File identity through rename and move,
and always presents the latest successfully saved representation. Only the File
Owner creates, configures, rotates or unpublishes it. A Publication also owns
one Public Comment thread (ticket 23, see [comments](comments.md)).

## Link and capability

```
https://<origin>/p/<path ID>#v1.<private scalar>
```

- The **path ID** (link ID) is an independent 256-bit CSPRNG value in canonical
  unpadded base64url (43 characters). It is the only value the Public route and
  the service receive. Live path IDs are unique; a retired one is never kept, so
  "never reused" rests on independent 256-bit generation, not on a retired-link
  registry that would outlive hard deletion.
- The **read capability** is the P-256 private scalar of the link's HPKE key
  pair, versioned as `v1.` and kept entirely after `#`. Browsers never send a
  fragment; mdwn never stores, logs, echoes or requests it. The service stores
  only the 65-byte public key (`publication_links.public_key`).
- The logical **Publication ID** is another independent 256-bit value. It
  survives link rotation and is bound in envelopes, rate limits and Security
  events, but it is never routable.
- The creating browser generates the key pair with WebCrypto, exports the scalar
  once for the fragment and drops the extractable handle. A Public reader imports
  the scalar as a JWK together with the stored public point, so engines that
  validate JWK pairs reject a substituted point and every engine fails to decrypt
  with one (HPKE binds `pkR` into the KEM context). RFC 9180 `DeriveKeyPair` was
  not used: WebKit rejects the scalar-only PKCS#8 import it relies on.

The complete link exists only in the creating page's memory. Before sending
the creation mutation, the browser retains it above the dismissible Publish
panel, keyed by its logical Publication ID. All prepared candidates remain in
memory so a retry cannot discard an earlier attempt that subsequently commits.
A collapsed panel or lost response cannot discard the key of a committed
Publication; reopening reconciles the
current Publication before showing that link with **Copy link**. Failed or
superseded attempts are never shown as the active link. Leaving the creating
page discards this memory, so copy the link before leaving; mdwn cannot recover
it. Anyone holding the complete link can read the current Public representation
until the link stops being active, and copies already downloaded cannot be
recalled.

## Public representation

A Public representation is one HPKE `public-representation` envelope (purpose 9)
to the active link's public key, at most 524,288 decoded bytes, stored in
`public_representations` with the same `length(ciphertext) <= 524288` constraint
as a private representation. Its plaintext is the presentation payload:

| Field | Encoding |
| --- | --- |
| Magic | UTF-8 `mdwn/public-presentation/v1` followed by NUL |
| Title length | u32, 0 when there is no title |
| Title | UTF-8 |
| Markdown length | u32 |
| Markdown | UTF-8 body |

The original Markdown source remains subject to its 262,144-byte File source
limit. Decoding YAML escapes can expand a title, so the encoded presentation and
its final encrypted envelope are bounded independently at 524,288 bytes; the
smaller source limit is never reapplied to decoded presentation bytes.
The editor's browser builds the payload from the saved source: a leading YAML
front-matter block (`---` … `---` or `...`, with LF, CRLF or CR line endings) is
removed entirely. The pinned `yaml` parser validates the whole YAML 1.2 mapping
before selecting a top-level string `title`; plain, quoted, literal and folded
strings, quoted keys, anchored strings and explicit standard string tags are
supported. Structured, aliased, null, unsupported-tag or unparseable values
yield no title rather than raw YAML. The browser inspects the scalar directly
without expanding aliases or converting other fields to JavaScript. A title-looking line inside another field is never an
author-selected title. Raw front matter, the File name or path, user-authored
timestamps and Owner identity never enter the payload.

The envelope context names only the Publication, never the Owner's Vault, the
Account or the File:

| Field | Value |
| --- | --- |
| `vaultId`, `objectId`, `publicationId` | logical Publication ID |
| `keyId` | path ID of the link the ciphertext is encrypted to |
| `recipientId` | base64url of the stored public key |
| `keyEpoch` | 1 (each link is its own key) |
| `revision` | Publication-scoped presentation revision (1 at creation, +1 per paired save) |

The presentation revision deliberately is not the File revision, so readers do
not learn how often the private File was saved before publication. The server
keeps the matching File revision in the server-only `file_revision` column.

## Paired saves

The authenticated File response gives an editor (`can_edit`) the active
Publication's `publicationId`, `linkId`, public key and current presentation
`revision` — never the fragment and no management authority. A converted File
save that publishes adds:

```json
{ "publication": { "publicationId": "…", "linkId": "…", "revision": 4, "ciphertext": "…" } }
```

The save's first CAS checks, besides live write authority and the expected File
pointer/revision/capability, that exactly this Publication is still active on
this link at `revision - 1`. A save without `publication` requires that no
Publication is active. The marker-gated dependents insert the new private and
Public representations, move both pointers and delete both superseded rows in
the same D1 transaction. Any mismatch is `409 publication_changed`; a malformed,
mis-bound, crossed or over-bound Public envelope is `400`; neither changes either
representation or pointer. The browser adopts the re-read File when its
revision and representation are unchanged and retries; a different revision is
the ordinary conflict.

A Publication is only ever created on a File in the parent-free File-capability
format (the Owner's browser converts a legacy File first, and a migration
trigger refuses anything else). A legacy-format save sent by a stale tab after
conversion gets `409 file_converted`, which uses the same adopt-and-retry path.

## Authenticated API

All routes require the same origin, a device-bound Session and a current Device
proof. Reads are bodyless POSTs; responses are `no-store`.

| Request | Operation |
| --- | --- |
| `POST /api/private/publications/files/:fileId` | Publish-panel state: role, Publication state, authors (Owner: all; others: own), requests (Owner: all; others: own) |
| `PUT /api/private/publications/files/:fileId` | Owner creates the Publication for the exact current File representation; removes every pending request |
| `POST /api/private/publications/files/:fileId/requests` | A Collaborator with File access creates its one pending request |
| `DELETE /api/private/publications/files/:fileId/requests/:requestId` | The requester cancels or the Owner denies |
| `PUT /api/private/publications/files/:fileId/authors` | Owner selects itself (with its declaration) or an Account by exact share handle or share identifier |
| `DELETE /api/private/publications/files/:fileId/authors/:declarationId` | Owner removes an author |
| `PUT /api/private/publications/files/:fileId/authors/:declarationId/declaration` | The selected author's own device declares its pseudonym to the current link |

| `PUT /api/private/publications/files/:fileId/link` | Owner rotates to a new path and key; carries the re-encrypted representation and every rewrapped public epoch |
| `POST /api/private/publications/files/:fileId/unpublish` | Owner seals the Publication irreversibly and pins the Public Comment count |
| `POST /api/private/publications/files/:fileId/teardown` | Owner drives one idempotent bounded deletion batch; returns `done` and progress |

Creation pins `expectedRevision` and `expectedRepresentationId`, so the first
Public representation is exactly the latest saved one; a newer save returns
`409 file_changed`. The same transaction installs the Public Comment thread and
its first audience epoch: the payload's `comments` carries the epoch identity,
audience, Owner recovery envelope and — for the default `public` audience — the
symmetric link wrapper the creating browser sealed with the fragment it still
holds. Creation without that first epoch is rejected, so no active Publication
can exist without a Public thread; a pre-ticket-23 Publication gets one through
the Owner-only audience endpoint. It applies the Publication create limit (5 per Account
per 24 hours) before its transaction. A Public-participation suspension (ticket
26) is checked at the same point and refuses create and rotate with
`403 public_participation_suspended`; unpublishing and the Owner's teardown
batches never pass through it. Approval is publishing: a
Collaborator's request never creates a Publication, link, representation or
public access, and creating the Publication removes every pending request in the
same transaction.

## Author attribution

Attribution is off by default: a Publication has no `publication_authors` row
until the Owner selects one, and edits never add one. The Owner may select
itself or an Account with current File-read access (addressed exactly, like a
Share; an unknown address and an Account without access get the same `404`).
Each author's pseudonym is a separate HPKE `publication-attribution` envelope
(purpose 21) to the link key, bound to the Publication, link, recipient key and
an opaque 256-bit declaration ID, with plaintext
`mdwn/publication-author/v1\0 || u16 length || pseudonym`. Only that author's
own device writes it, from its own encrypted Account profile; until then the
selection is pending and nothing is shown. A credited author's browser declares
when it next opens the File. Pseudonym updates (ticket 24) re-declare through the
same endpoint, and a rotated link (ticket 25) needs re-declaration because a
declaration is served only for the link it was encrypted to.

## Link rotation

The Owner's browser may replace the active link without ending the Publication.
It generates a fresh path ID and key pair, re-encrypts the current Public
representation to the new public key from the current saved source, and rewraps
every public Comment epoch's symmetric link wrapper to the new Publication
capability. The epoch capabilities themselves and every device envelope are
unchanged. Each submitted wrapper is bounded at 4 KiB, so a maximal 100-epoch
rotation fits the shared authenticated-JSON body cap alongside the Public
representation. One D1 transaction replaces the link identity in place, moves the
Publication pointer, replaces the Public representation at the same
presentation revision and rewrites the wrappers; `publication_links` refuses any
other update. The retired identifier stops routing immediately and is never kept
or reused, and the old path returns the same ciphertext-free `404` as an unknown
one.

The rotation CAS pins the expected active link, the presentation revision and
the exact File revision/representation the payload was rebuilt from; any move is
`409 publication_changed` or `409 file_changed`, and mismatched or mis-bound
wrappers are refused before the transaction. The logical Publication, Public
Comment thread and all history survive, so a new link shows the same document
and Comments. Author declarations are served only for the link they were sealed
to: after rotation each selected author's device re-declares on its next File
open. Rotation consumes the `publication.mutate` limit, is refused while a
Public-participation suspension is active, and waits out an active
key-rotation write seal (`409 key_rotation_required`). The new complete link is
retained in page memory by the same rule as creation, so a lost response never
loses the replacement capability.

## Unpublishing

Unpublishing is permanent and is never blocked by Public-participation limits or
suspensions. The confirmation states the irreversible effect and the current
opaque count, for example **Unpublish and permanently delete 12 Public
Comments**. The seal transaction verifies Owner authority, deletes the active
link and its wrappers, flips the Publication irreversibly to `deleting`, nulls
its pointers and writes the pinned count to `publication_teardowns`. Every Public
route and Public-thread endpoint denies access from that moment, and triggers
forbid a sealed Publication from gaining a link, representation, thread or
`active` state again.

Two drivers then run the same idempotent bounded batches, built from one
statement set (`teardownBatch`): the Owner's browser through
`POST …/teardown` while the page is open, and the 15-minute scheduled
maintenance (see [scheduled duties](operations.md#scheduled-retention)) whether
or not any browser returns. Each batch hard-deletes at most 200 Public
Comments; once none remain, one transaction
removes the thread and its epochs, Comments, attributions and reports, staged
pseudonym-update items, Owner and device envelopes, capabilities, link
wrappers, Public representations, author
declarations, requests, teardown progress and finally the Publication row. The
File's Private thread and its Comments, attributions and envelopes are never
selected, and the shared Comment-dependent module owns that Public-thread
selection and removal order for teardown and File deletion alike. A
lost response or interrupted browser is resumed by any Owner device; no other
Account can read progress or delete anything. The File's partial unique index
keeps it unpublished until cleanup completes, and a later Publication starts
entirely fresh with new identifiers and an empty thread.

### Scheduled completion

Only durable sealed state authorizes scheduled cleanup: a `deleting`
Publication with its `publication_teardowns` row, which only the Owner's
proof-guarded seal creates. Scheduled maintenance never simulates a Session,
consumes a Device proof or opens a key.

Each run picks the least recently attempted sealed Publication (its
`updated_at`, which the seal sets and every scheduled or browser attempt
advances, then id) and first records the attempt in a statement of its own.
That attempt marker carries no authority and commits even if the batch then
fails, so a Publication whose batch keeps failing moves behind the others
instead of blocking them. The run then commits one batch in one atomic D1
batch. Authority is the sealed predicate itself — the Publication row with that
id, File and Owner still `deleting` — re-evaluated by every statement; it stays
true until the batch's own last statement removes the row. The browser path
keeps its Device-proof anchor and per-invocation token. Because every statement
is keyed by the Publication's id, File and Owner, interleaved browser and
scheduled batches, a run after File hard deletion (which already removed the
rows) and a later Publication of the same File all fail the predicate and
delete nothing. A failed batch rolls back, the Publication stays sealed and a
later run retries; access never reopens and nothing claims completion. There
is no deletion deadline: a backlog drains one batch per run.

The Publish panel distinguishes the three states. While sealed it shows
**Deleting public material…** with progress and says Public access has ended
and deletion continues automatically, even after the page closes; **Continue
deleting** appears when this page's own batch failed. Only a page that saw
the seal, and then an authoritative read without the sealed Publication, says
**Public material deleted**; it never claims physical deletion before the final
transaction. An Owner who leaves and returns after cleanup simply sees the File
as unpublished: Hard deletion keeps no record that a Publication existed.

## Public reader

- `GET /p/:linkId` server-renders only the public shell. Its loader returns a
  `404` for any path that is not an active link — unknown, malformed, rotated
  and sealed paths take the same code path — and otherwise returns no data.
  The browser `clientLoader` (`hydrate = true`) reads `location.hash`, fetches
  `GET /api/public/publications/:linkId` with `credentials: "omit"`,
  `referrerPolicy: "no-referrer"` and `cache: "no-store"`, decrypts locally and
  renders sanitized GFM (`react-markdown`, `remark-gfm`, `rehype-sanitize`)
  with the title and declared authors only. Messages for a missing key or an
  unreadable link never echo the fragment. Hash-only navigation (including
  back/forward) triggers `useRevalidator`, because React Router otherwise skips
  loaders; a changed fragment hides the old document until the browser loader
  finishes, and cancellation prevents stale decryptions from winning.
- The reader and the editor Preview share one renderer
  (`app/tree/markdown-preview.tsx`) and its `.prose-markdown` typography, sized
  relative to the container so the larger reader keeps the same hierarchy
  ([ticket 67](../.scratch/mdwn/issues/67-mobile-public-reader.md)):
  - A `#…` link never navigates, because the fragment is the read capability.
    The renderer scrolls to and focuses its sanitized target in place (GFM
    footnotes and their back-references). Other links open in a new tab with
    `noopener noreferrer`.
  - mdwn stores no images and the CSP admits only first-party ones, so a
    Markdown image renders as an "Image not shown" note with its description.
    A web address becomes an "Open image" link the reader may follow, unless
    the image is already a link; the page never requests it.
  - Wide tables and code blocks scroll inside the text column, never the page,
    and words in table cells are not split. While one overflows it is a
    focusable region named "Scrollable table" or "Scrollable code", so the
    keyboard can scroll it, with an edge shade on each side that hides content.
  - `e2e/public-reader-mobile.spec.ts` checks this at phone widths in every
    engine.
- `GET /api/public/publications/:linkId` returns the Publication ID, the link's
  public key, the current Public representation, current-link author declarations
  and the eligible Public Comment epochs — never a File, Owner or Account ID,
  private representation, Key envelope, device envelope, Private Comment or
  Collaborators-only material. Each public epoch carries its symmetric
  Publication-capability wrapper, never its plaintext capability. A
  Collaborators-only current audience returns no epoch ciphertext at all. Every
  inactive path gets the byte-identical `{"error":"not_found"}` `404`.
- Every response carries `X-Robots-Tag: noindex, nofollow, noarchive` and
  `Referrer-Policy: no-referrer`; the page also emits the matching robots and
  referrer `<meta>` tags. The Public route sets no cookie and its data request
  sends none. CSP permits only first-party scripts and images, so the page has
  no analytics or third-party code.

## Storage and deletion

`publications` has a partial unique index on `file_id` for `active` and
`deleting` rows, a state/pointer `CHECK`, and reciprocal deferred FKs from its
current link and Public representation pointers. Triggers make a Publication
start `active` on a converted File, keep its identity immutable, make the
`deleting` seal irreversible, and forbid rewriting links, Public representations,
requests or author identities in place — the one exception is the in-place
rotation of the active link identity, which must already be the Publication's
current pointer. A `deleting` Publication's `publication_teardowns` row is
insert-only and immutable until the final batch deletes it with the Publication.
File and Directory hard deletion explicitly remove Public Comment reports,
staged pseudonym-update items, author rows, requests, Public representations,
links and the Publication in the tree's deletion transaction, so deleting a
File revokes its Publication.

## Trust limits

HPKE base mode does not authenticate the sender: anyone holding the public key —
the service, every editor, and an editor who has since lost access — could
encrypt a well-formed Public representation. The service accepts uploads only
from current editors in the paired-save transaction, but a Public reader cannot
detect a malicious service that substitutes or rolls back the served ciphertext,
or that distributes a substituted public key to editors so it can read later
presentations. This is the same service-distributed key trust as Grant device
keys and stays within the honest-client boundary of ADR-0003; it is not a
signature scheme. Public readers keep no rollback checkpoint because the Public
page persists nothing in the browser.

## Verification

`tests/publication-content.test.ts` covers presentation parsing and framing
(including private multiline YAML, quoted/block titles and all line endings),
the fragment format, key import and envelope bindings. The shared contract in
`tests/support/enc-v1-contract.ts` opens an independently framed Public
representation and author declaration from a fixed link fragment, and a fresh
link, in Node, workerd, Chromium, Firefox and WebKit.
`tests/worker/publications.test.ts` drives the signed API against real migrated
D1: Owner-only creation, requests, attribution, paired-save atomicity and
rollback, indistinguishable `404`s, anonymous responses, storage constraints,
hard deletion, fragment absence from every table and the reviewed query plans.
`tests/worker/publication-lifecycle.test.ts` proves in-place rotation (the old
path is byte-identical to unknown, the new fragment opens the same presentation
and Comments, every public epoch is rewrapped, Collaborators-only epochs and
device envelopes are untouched, stale/mis-bound material changes nothing) and
the sealed, Owner-resumable teardown (pinned count, bounded 200-Comment
batches, idempotent completion after zero remaining Comments, non-Owner
denial, no participation-limit
blocking, every public row and ciphertext removed, the File's Private thread
untouched, and a fresh later
Publication). `tests/worker/scheduled-teardown.test.ts` seals real
Publications and runs the Worker's `scheduled` entry point: completion across
several bounded runs with no browser call, survival of the File, its Private
thread and other Publications and Owners by direct D1 inspection, interleaved
browser batches, File hard deletion, a later Publication, a stale target
whose Publication is completed and replaced or whose File is deleted between
selection and batch, a permanently failing teardown that does not block
others, security retention beside a backlog, isolated duty failures and the
worst-case per-invocation D1 statement budget. `e2e/publications.spec.ts` publishes from the Publish panel, reads the link in a
fresh anonymous context and proves the fragment never reaches a request,
header, cookie, console message or D1 row while saves keep the link live. It
also covers fragment-only navigation, adversarial front-matter presentation,
collapsed panels/lost responses after the real Worker commits creation, retries
that lose to an earlier pending commit, paired saves with expanded titles, link
rotation with a surviving Comment, an unpublish whose counted confirmation,
bounded progress and fresh later Publication are asserted, an unpublish whose
page never drives teardown, which scheduled maintenance completes while the
panel shows pending and then completed deletion, and an Owner who leaves right
after confirming and later returns to an unpublished File whose old link is
`404`.

See [enc-v1](enc-v1.md), [serving and security](serving-and-security.md),
[sharing](sharing.md), [public pseudonym update](pseudonym-update.md) and [tree structure](tree-structure.md).
