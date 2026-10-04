# Publications and the Public reader (ticket 22)

A **Publication** exposes exactly one File through a **Public link**. It is
independent of Shares and Grants, follows File identity through rename and move,
and always presents the latest successfully saved representation. Only the File
Owner creates or configures it; link rotation and unpublishing arrive in ticket 25
and keep that Owner-only rule. Public Comment threads are ticket 23.

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

Creation pins `expectedRevision` and `expectedRepresentationId`, so the first
Public representation is exactly the latest saved one; a newer save returns
`409 file_changed`. It applies the Publication create limit (5 per Account per
24 hours) before its transaction. Public-participation suspensions (ticket 26)
will add their check at the same point. Approval is publishing: a Collaborator's
request never creates a Publication, link, representation or public access, and
creating the Publication removes every pending request in the same transaction.

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
- `GET /api/public/publications/:linkId` returns, in one statement, the
  Publication ID, the link's public key, the current Public representation and
  current-link author declarations — never a File, Owner or Account ID, private
  representation, Key envelope, Comment, Comment capability or
  Collaborators-only material. Every inactive path gets the byte-identical
  `{"error":"not_found"}` `404`.
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
requests or author identities in place. Ticket 25 owns the seal and teardown
transactions. File and Directory hard deletion explicitly remove author rows,
requests, Public representations, links and the Publication in the tree's
deletion transaction, so deleting a File revokes its Publication.

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
`e2e/publications.spec.ts` publishes from the Publish panel, reads the link in a
fresh anonymous context and proves the fragment never reaches a request,
header, cookie, console message or D1 row while saves keep the link live. It
also covers fragment-only navigation, adversarial front-matter presentation,
collapsed panels/lost responses after the real Worker commits creation, retries
that lose to an earlier pending commit, and paired saves with expanded titles.

See [enc-v1](enc-v1.md), [serving and security](serving-and-security.md),
[sharing](sharing.md) and [tree structure](tree-structure.md).
