# Private Comment threads (ticket 21)

A File has exactly one **Private comment thread** for its Owner and every Account
with current File-read access through an active Grant. Comment participation
follows File-read access, never Markdown write strength: a read-only Collaborator
reads, creates, edits and hard-deletes its own Comments with the normal composer.
Public Comment threads and audience epochs remain ticket 23.

## Data model

- `comment_threads`: one Private thread per File (`purpose = 'private'`, partial
  unique `file_id` index) and one Public thread per logical Publication. The
  thread stores the Owner, the stable File identity, the current epoch pointer and
  the next server ordering sequence. The reviewed `0019` migration adds the
  reciprocal foreign key `(current_epoch_id, id) ->
  comment_thread_epochs(id, thread_id)`, so a thread can only point at its own
  epoch; Drizzle cannot express that circular relationship.
- `comment_thread_epochs`: the constrained representation of a thread's current
  key epoch. A Private thread keeps exactly one `active` row (partial unique
  `thread_id` index) whose `key_epoch` is the thread capability epoch; Public
  threads will retain prior audience epochs. `audience` is `NULL` for Private.
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
| `POST /api/private/profile` | The current encrypted Account profile for local pseudonym resolution |

Reads are bodyless POSTs, `no-store`, and never consume a proof. The Private and
future Public threads use separate endpoints and are never combined.

## Capability delivery and authorization

The Owner's creating browser seals the random thread capability under the Vault
root key as the thread's `vault-recovery` envelope; every active Owner device can
open it with the same Vault root key, so no per-device Owner envelope is needed.
Registering the requirement fires the existing `sharing_new_comment_need` trigger,
which records opaque `(grant_id, device_id, grant_key_epoch)` needs for covering
Grants. Ticket 18/20 delivery then provisions signed `share_comment_key_envelopes`
before acceptance and `grant_comment_key_envelopes` for active Grants; a
recipient holder may forward within the same Account/Grant. A missing envelope is
a ciphertext-free `409 secure_access_preparing` (or
`owned_comment_key_missing` for the Owner), never a fragment fallback.

Every read and create re-derives current File-read access and requires the stored
thread epoch, capability identity and epoch in the same statement. Edit requires
the stored author Account; delete allows the author or the File Owner and no one
else; the Owner can never rewrite another author's body. Revocation removes
server authorization immediately and hard-deletes the relationship's envelopes;
an overlapping live Grant keeps its independent authority. A device whose proof
or registry membership fails receives no thread material.

Hard deletion stays available while a rotation seal blocks new writes. A File or
Directory hard deletion explicitly removes Comments, attributions, epochs,
threads, owned Comment recovery envelopes and rotation staging before the node.

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
old wrapper. Public history keeps its existing keys and only renews device
envelopes (ticket 23/25).

## Verification seams

`tests/worker/private-comments.test.ts` drives the signed API against real
migrated D1: one-thread constraints, ordered ciphertext reads, crossed/oversized
envelope rejection, read-only participation, author and Owner mutation rules,
idempotent create retries, revocation and revoked-device denial, missing-envelope
states, write seals, hard deletion and a full rotation that preserves body
ciphertext. `tests/comment-content.test.ts` covers the browser envelope shapes
and bounds. `e2e/private-comments.spec.ts` exercises the wide inspector and
narrow Comments view in Chromium, Firefox and WebKit.

See [enc-v1](enc-v1.md), [sharing](sharing.md), [shared provisioning](shared-provisioning.md),
and [key rotation](key-rotation.md).
