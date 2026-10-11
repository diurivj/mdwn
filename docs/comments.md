# Comment threads (tickets 21, 23, and 26)

A File has exactly one **Private comment thread** for its Owner and every Account
with current File-read access through an active Grant. Comment participation
follows File-read access, never Markdown write strength: a read-only Collaborator
reads, creates, edits and hard-deletes its own Comments with the normal composer.

A logical Publication has exactly one separate **Public comment thread**, built
from ordered, independently keyed **Comment audience epochs**. Each epoch is
immutable `public` or `collaborators_only`; every audience change starts a fresh
epoch, and anonymous readers receive only epochs explicitly marked public.
Private and Public threads are separate endpoints and are never combined.

## Data model

- `comment_threads`: one Private thread per File (`purpose = 'private'`, partial
  unique `file_id` index) and one Public thread per logical Publication. The
  thread stores the Owner, the stable File identity, the current epoch pointer and
  the next server ordering sequence. The reviewed `0019` migration adds the
  reciprocal foreign key `(current_epoch_id, id) ->
  comment_thread_epochs(id, thread_id)`, so a thread can only point at its own
  epoch; Drizzle cannot express that circular relationship.
- `comment_thread_epochs`: one ordered audience epoch per Public thread
  lifecycle step. A Private thread keeps exactly one `active` row (partial unique
  `thread_id` index) whose `key_epoch` is the thread capability epoch; `audience`
  is `NULL` for Private. A Public thread keeps one `active` row and any number of
  `retained` rows, each with an immutable audience, its own capability identity
  and a unique ordinal. The reviewed `0021` migration also adds
  `public_comment_epoch_links`: the one symmetric wrapper per public epoch that
  names its Publication, link and capability epoch.
- `comments`: thread, epoch, opaque author Account, per-thread `sequence`,
  `revision`, bounded `comment-content` body ciphertext, its byte size, and the
  per-record content-key wrapper plus wrapper epoch. No plain text, displayed
  pseudonym, or moderation-searchable value exists in any Comment table.
- `thread_attributions`: one current encrypted pseudonym declaration per author
  and thread scope (`UNIQUE(thread_id, author_id)`), with the same per-record
  content-key wrapper shape. The matching device access is the thread capability
  envelope relationship (owned recovery, pending Share, or active Grant rows).
- `key_rotation_comment_items`: bounded staging for per-record wrappers during a
  thread capability rotation.

## Envelope shapes

A Comment body is a `comment-content` envelope under a fresh random per-record
content key; the content key is wrapped in a second `comment-content` envelope
beneath the current thread capability. A displayed pseudonym uses the
`attribution` purpose in the same two-layer shape. A record's own opaque identity
is its content-key identity, so every open still supplies an external expected
context and the service can validate framing and context without decrypting.
Private Comment contexts bind the Owner Vault; Public Comment contexts bind the
logical Publication instead, so an anonymous reader can open them from the
opaque link response alone. A public epoch is additionally wrapped with the
symmetric `public-comment-epoch-link` purpose (22) to the **Publication
capability**, a key derived by HKDF-SHA-256 from the fragment scalar and the
stored public point. The service stores that wrapper ciphertext but can never
derive its key.
Bodies are plain text with line feeds only: the browser normalizes CRLF/CR,
counts at most 2,000 Unicode characters, and renders React text with
`white-space: pre-wrap`; HTML and Markdown are never interpreted. The server
enforces the 16,384-byte body and wrapper column bounds.

## Endpoints

| Request | Operation |
| --- | --- |
| `POST /api/private/comments/files/:fileId[?cursor=<sequence>]` | Proof-guarded read: thread metadata, this device's envelope, ordered Comments and author attributions |
| `PUT /api/private/comments/files/:fileId` | Owner-only create-once Private thread with its `vault-recovery` envelope |
| `POST /api/private/comments/files/:fileId/entries` | Create a Comment, optionally its author's first attribution |
| `PATCH /api/private/comments/files/:fileId/entries/:commentId` | Author-only edit with expected revision |
| `DELETE /api/private/comments/files/:fileId/entries/:commentId` | Author or File-Owner hard deletion |
| `POST /api/private/comments/files/:fileId/public[?cursor=<sequence>]` | Authenticated Public-thread read: every authorized epoch with this device's envelope, ordered Comments and author attributions |
| `PUT /api/private/comments/files/:fileId/public` | Owner-only audience change, or first thread/epoch for a pre-ticket-23 Publication |
| `POST /api/private/comments/files/:fileId/public/entries` | Create a Comment in the current epoch through the File route |
| `PATCH /api/private/comments/files/:fileId/public/entries/:commentId` | Author-only edit in the Comment's own epoch |
| `DELETE /api/private/comments/files/:fileId/public/entries/:commentId` | Author or File-Owner hard deletion |
| `POST /api/private/comments/links/:linkId/entries` | Signed-in link visitor creates in the current public epoch |
| `PATCH /api/private/comments/links/:linkId/entries/:commentId` | Author-only edit through the active public link |
| `DELETE /api/private/comments/links/:linkId/entries/:commentId` | Author or File-Owner hard deletion through the active public link |
| `POST /api/private/comments/reports` | Category-only report for an opaque Public Comment ID; carries no content and grants no content access |
| `GET /api/public/publications/:linkId` | Anonymous Public data plus the public-epoch page and wrappers |
| `GET /api/public/publications/:linkId/comments?cursor=<sequence>` | Anonymous continuation page for public epochs |
| `POST /api/private/profile` | The current encrypted Account profile for local pseudonym resolution |

Reads are bodyless POSTs, `no-store`, and never consume a proof. They return at
most 50 Comments per page with an explicit sequence cursor; the browser loads up
to ten bounded pages and continues the flat list on demand. The Private and
Public threads use separate endpoints and are never combined.

## Capability delivery and authorization

The Owner's creating browser seals the random thread capability under the Vault
root key as the thread's `vault-recovery` envelope; every active Owner device can
open it with the same Vault root key, so no per-device Owner envelope is needed.
An Owner device ensures the thread whenever it opens the File: a ciphertext-free
`?probe=1` read reports presence, and an idempotent create runs only when the
thread is absent, so a Collaborator never waits for the Owner to open the
Comments inspector. Registering the requirement fires the existing `sharing_new_comment_need` trigger,
which records opaque `(grant_id, device_id, grant_key_epoch)` needs for covering
Grants. Ticket 18/20 delivery then provisions signed `share_comment_key_envelopes`
before acceptance and `grant_comment_key_envelopes` for active Grants; a
recipient holder may forward within the same Account/Grant. A missing envelope is
a ciphertext-free `409 secure_access_preparing` (or
`owned_comment_key_missing` for the Owner), never a fragment fallback.

Every read and create re-derives current File-read access and requires the stored
thread epoch, capability identity and epoch in the same statement. Each
ciphertext SELECT (thread envelope, Comments, attributions, rotation staging)
rechecks that authority itself, so a revocation between statements cannot serve
material. The read response carries the complete signed envelope context the
client opens, never a partial object. Edit requires
the stored author Account; delete allows the author or the File Owner and no one
else; the Owner can never rewrite another author's body. Revocation removes
server authorization immediately and hard-deletes the relationship's envelopes;
an overlapping live Grant keeps its independent authority. A device whose proof
or registry membership fails receives no thread material.

Hard deletion stays available while a rotation seal blocks new writes. A File or
Directory hard deletion explicitly removes both Comment threads with their
Comments, attributions and Public Comment reports, plus staged pseudonym
declarations, epochs, threads, owned Comment recovery envelopes and rotation
staging before the node, with no database cascade to fall back on.

## Public audience epochs

- A **public** epoch is wrapped to the Publication capability and directly
  enveloped to eligible devices: the Owner's active devices open the epoch's
  `vault-recovery` envelope under the Vault root key, and every Account with
  current effective File-read access receives a signed HPKE
  `public-comment-audience-epoch` (11) device envelope through the ticket 18/20
  requirement registry. Creating an epoch fires the delivery need immediately;
  an already authorized browser fulfills it in bounded packets, and until it
  does the authenticated UI reports that secure access is being prepared. The
  fragment is never needed in the authenticated workspace.
- A **collaborators_only** epoch has only those device envelopes and no link
  wrapper. The anonymous route returns no thread ciphertext while the current
  audience is collaborators-only, including retained public history.
- `public -> collaborators_only` starts a fresh device-enveloped epoch in the
  same statement that moves the thread pointer, so anonymous delivery stops
  immediately. `collaborators_only -> public` starts a fresh public epoch with a
  new wrapper; prior Collaborators-only epochs are never returned anonymously,
  while prior public epochs remain public as they always were.
- Losing the last File-read path immediately fails the File route's authority
  predicate and the link route's audience check. The next rotation rotates the
  current Collaborators-only epoch in place for remaining devices; a create in
  the sealed window is a ciphertext-free `409 key_rotation_required`.
- Every create edits only the thread's current epoch; edit and delete operate on
  the Comment's own retained epoch with that epoch's capability. Through the
  File route an eligible Account may still author those retained epochs; through
  the link route, edit and delete are additionally refused while the current
  audience is Collaborators-only, so a closed audience cannot be mutated
  anonymously even by a past author. Author identity, Owner hard-delete, the
  2,000-character plain-text bound and the 50-Comment page apply to both
  threads. Public create and edit consume the `public_comment.mutate` counters
  before acceptance; a suspended Account is refused before any counter is
  consumed, and reports consume the separate `public_comment.report` limit.
- The Public reader page renders only public epochs under the document, with no
  Private/Public selector. In Collaborators-only mode an unauthenticated reader
  receives **Sign in to see or add comments if you have access to this file** and
  no thread ciphertext. A signed-in visitor posts through a private-capable,
  device-bound Session plus the fragment capability held locally; an
  unprovisioned Session cannot post. The public data request stays cookie-free;
  the page makes one cookie-carrying `/api/device/state` check only when the
  current audience is public, to decide whether to offer the composer.

## Rotation

A Private thread capability rotation stages every current Comment and attribution
wrapper in bounded pages (20 records) through
`POST /api/private/key-rotations/:job/items/:object/comment-items` and
`PATCH /api/private/key-rotations/:job/step` with `operation: "stage"`. The
browser opens each wrapper with the installed thread capability and reseals the
unchanged content key beneath the replacement capability. Promotion requires a
staged wrapper at the current revision for every live record, then rewraps all
wrappers, advances `comment_thread_epochs.key_epoch` and
`sharing_comment_capabilities.capability_epoch`, deletes superseded envelopes and
installs the replacement `vault-recovery` envelope in one transaction. Body and
pseudonym ciphertext never change. A Comment deleted during staging simply drops
its staged row; a revision that advanced blocks promotion instead of reusing an
old wrapper. Retained public history keeps its existing key and only renews
device envelopes. A **current Collaborators-only** epoch rotates in place the
same way as a Private thread (same staging endpoint, epoch-scoped records), so a
revoked device's key can never decrypt what remains; a public epoch never
rewrites its link wrapper on revocation because anyone with the link could
already read it. A **link rotation** (ticket 25) rewraps every public epoch's
link wrapper to the replacement Publication capability in the same transaction
that swaps the active link; the epoch capabilities and the device envelopes are
untouched, and a Collaborators-only epoch has no wrapper to rotate.

## Reports and Public-participation suspension (ticket 26)

A signed-in Account may report one opaque Public Comment ID with one fixed
category — `spam`, `abuse`, or `other` — through
`POST /api/private/comments/reports`. A report conveys no plaintext and grants
no content access: the reporter needs no fragment, capability, or thread read,
and the stored row is only `(reporter Account, Comment ID, category,
created_at, expires_at)`. The proof-guarded request consumes the
`public_comment.report` limit (3 per Account per 24 hours) before any lookup,
so an unknown Comment ID cannot be probed for free; an idempotent repeat stores
no second row but still counts against the window. Reports expire
after 30 days and are purged by the same 15-minute Cron. A Comment deletion
removes its reports in the same explicit transaction — the Comment foreign key
is `RESTRICT`, never a cascade — so the author's hard delete, File or Directory
hard deletion, and unpublish/teardown all remove the signal too.

Reports are operator-only pattern metadata, never evidence the service can
read. File Owner hard deletion remains the primary unwanted-Comment control and
is surfaced as such in the report control itself.

Repeated technical abuse or a metadata-supported report pattern may trigger an
operator-applied **Public-participation suspension**: the first lasts seven days
and any later one 30 days, whether or not the earlier one expired. The suspended
Account is refused Public Comment create and edit and Publication create/rotate
with `403 { error: "public_participation_suspended", suspendedUntil }`. The
check reads `expires_at` live, so a suspension stops applying automatically at
its recorded end without any cleanup, and the operator can clear a mistaken
record (see [serving and security](serving-and-security.md)), which also removes
the escalation. Nothing else is blocked: private Files and Shares, export,
recovery, ownership, Private Comments, Comment hard deletion, unpublishing and
teardown, and session revocation stay available. The UI states only the fixed
reason and automatic end; there is no appeal flow, content moderation, or
account deletion.

## Verification seams

`tests/worker/private-comments.test.ts` drives the signed API against real
migrated D1: one-thread constraints, ordered ciphertext reads, crossed/oversized
envelope rejection, read-only participation, author and Owner mutation rules,
idempotent create retries, revocation and revoked-device denial, missing-envelope
states, write seals, hard deletion and a full rotation that preserves body
ciphertext. `tests/worker/public-comments.test.ts` covers creation defaults, the
anonymous page, signed-in visitor posting, audience transitions in both
directions, retained history for eligible devices, unauthorized signed-in
denial, Private-thread absence and the revocation rotation of a current
Collaborators-only epoch. `tests/worker/hard-deletion-completeness.test.ts`
drives File and Directory deletion of rich Comment graphs through the
authorized routes, and `tests/worker/comment-dependent-deletion.test.ts` pins
the shared Comment-dependent module's File and Publication scope containment,
transaction-marker guard, rollback and bounded-batch/final-completion behavior
in real D1. `tests/worker/publication-lifecycle.test.ts` covers
link rotation and the sealed, Owner-resumable teardown with bounded batches
that removes only the Publication's Public thread and leaves the File's Private
thread readable. `tests/comment-content.test.ts` and
`tests/public-comment-content.test.ts` cover the browser envelope shapes, link
wrappers and bounds. `tests/worker/public-abuse-response.test.ts` proves the
report shape and limit, the suspension enforcement boundary (create, edit,
create/rotate blocked; private read, hard deletion, unpublish/teardown and
sign-out available), automatic expiry, repeat escalation, operator correction,
and report retention. `e2e/private-comments.spec.ts` exercises the wide inspector
and narrow Comments view, and `e2e/public-comments.spec.ts` posts from a public
page and closes and reopens the audience in Chromium, Firefox and WebKit.

See [enc-v1](enc-v1.md), [sharing](sharing.md), [shared provisioning](shared-provisioning.md),
[public pseudonym update](pseudonym-update.md), and [key rotation](key-rotation.md).
