# Shares, Grants, and server authority

Ticket 17 introduces server-authoritative account-to-account sharing. It does not implement ticket 18's capability delivery, ticket 19's key-rotation jobs, or the Comment/Publication/Import/Export features in later tickets. No ciphertext or Grant possession substitutes for a current device-bound Session and Device proof.

## Interfaces

Resource routes are thin React Router actions under `app/routes/api/`. All requests require the same origin and the shared Device-proof guard. Read-only requests are bodyless POSTs, return `Cache-Control: no-store`, and never consume a proof or update device activity.

| Request | Operation |
| --- | --- |
| `POST /api/private/shares[?cursor=<opaque-id>]` | Incoming/outgoing pending Shares |
| `POST /api/private/shares/address` | Only the caller's opaque share identifier |
| `PUT /api/private/shares` | Owner invites an exact existing Account |
| `POST /api/private/shares/:id/accept` | Recipient accepts; atomically creates a Grant and removes the Share |
| `POST /api/private/shares/:id/decline` | Recipient hard-deletes the pending Share |
| `DELETE /api/private/shares/:id` | Owner cancels the pending Share |
| `POST /api/private/grants[?cursor=<opaque-id>]` | Received/owned active Grants |
| `PATCH /api/private/grants/:id` | Owner changes permission with `expectedRevision` |
| `DELETE /api/private/grants/:id` | Owner revokes with `expectedRevision` |
| `POST /api/private/grants/:id/leave` | Recipient leaves with `expectedRevision` |

An invitation has `{ targetId, recipient: { shareId } | { handle }, permission }`. Handles are optional, 3–32 ASCII letters/digits/underscores/hyphens, with exact case-insensitive equality. No trimming, prefixes, wildcards, fuzzy matching, Account directory, or standalone lookup endpoint exists. Only a domain-separated SHA-256 lookup token is stored; this is share addressing, not authentication. Handle assignment/profile editing is not introduced here.

Lists have a combined 100-relationship page and an explicit `nextCursor`. They return opaque identities and target kind/permission only, never tree edges or encrypted Directory names. Every retained Share is pending and every retained Grant is active; unique relationship indexes and same-Owner/type target foreign keys enforce their storage contracts. No sharing audit log or inactive relationship rows are kept.

## Effective authority and the permission matrix

`app/sharing/access.server.ts` is the server policy seam:

- `effectiveAccess` returns current authority, or null for an inaccessible target.
- `effectiveAccessQuery` embeds the bounded query in a ciphertext SELECT or a mutation's first CAS.
- `accessPredicate` and `moveAccessPredicate` integrate current access into the tree's transactions.
- `permits` specifies every private permission-matrix row, including Comment authorship, Publication requests, Import targets, and owned-File-only export. Later feature modules must apply these rules with their own stored-author/current-epoch conditions in the transaction, not cache a preflight Boolean.
- `permitsPublicAudience` specifies the separate complete-active-link audience rule. Its facts must be established by the future Publication protocol and the Device-proof guard, never taken from request JSON. It grants no private or Collaborators-only authority.

The strongest active direct/inherited Grant controls Markdown edits. Structural authority specifically requires a covering Directory read/write Grant, not a direct File Grant. Shared roots cannot be structurally changed through that Grant; an independent broader Directory read/write Grant can still supply authority. A move needs one common covering write root, not two disconnected writable islands, and cannot cross Owners. Private Comment and Collaborators-only Public Comment read authority are separate Booleans independent of Markdown permission.

The target Account remains the content Owner. Directory Collaborators sign listing changes with their own approved device while encrypting all new nodes and metadata in the content Owner's context. New descendants inherit the existing Grant with no approval, ownership transfer, or extra Grant. Listing signatures remain verifiable after the signing device or its Grant is revoked.

Direct File responses contain only the File identity, Owner vault context, current representation metadata, and ciphertext. They omit parent, name/order edge ciphertext, and parent key envelope. Their ancestry response contains only the File ID. Directory-derived ancestry stops at the broadest accessible shared root, never the Owner's hidden root above it. Direct File Grants follow identity through Owner rename/move.

## Cryptographic readiness and safety seals

**Direct-File save remains a dependency gap.** The existing fresh-key save updates a parent-wrapped File key and its signed encrypted Directory listing. A direct File editor must not receive that parent capability or listing. File write authority is derived correctly, but a parent-free save currently returns `409 shared_content_provisioning_required` without mutating anything. Ticket 18 must choose and implement a coordinated current-key persistence/read contract covering the Owner, inherited readers, and direct recipients. Reusing the old File key or storing a successor key only for the editor is not acceptable. The server does not claim such a save succeeded.

Directory read/write saves continue to replace the current representation with a fresh File content key, using the Owner's vault context and the actor's proof/signature. Read-only access never authorizes a save.

Revocation, leave, and permission changes immediately remove/change server authority in a short proof-gated transaction. That same transaction records a current `sharing_write_blocks` safety seal on the affected target; permission changes also advance the Grant epoch. The seal contains no former recipient, Grant identity, or historical audit record. Future encrypted/structural writes beneath it fail closed. Reads and hard deletion remain available, and explicit hard deletion removes all dependent Shares, Grants, and seals. Never expire or clear a seal merely to restore writes under an old key; ticket 19 must complete the rotation before unsealing.

A move that would lose any inherited Directory Grant is refused with `409 key_rotation_required`, even for the Owner or when the moving actor retains another access path. Direct File Grants and Grants on the moved Directory itself follow identity and are not lost by a move.

## Reviewed effective-access query plan

Run the diagnostic against real migrated D1/workerd:

```sh
npx vitest run --config vitest.workers.config.ts tests/worker/effective-access.test.ts \
  -t 'reviewed effective-access query plan' --reporter=verbose --disableConsoleIntercept
```

Reviewed index-bearing output:

```text
SEARCH n USING INDEX sqlite_autoindex_vault_nodes_1 (id=?)
MATERIALIZE lineage
SEARCH vault_nodes USING INDEX sqlite_autoindex_vault_nodes_1 (id=?)
RECURSIVE STEP
SCAN child
SEARCH parent USING INDEX vault_nodes_owner_target_idx (owner_id=? AND id=?)
SEARCH s USING INDEX sqlite_autoindex_sessions_1 (id=?)
SEARCH d USING INDEX sqlite_autoindex_encryption_devices_1 (id=?)
SEARCH r USING INDEX sqlite_autoindex_account_encryption_identities_1 (account_id=?)
MATERIALIZE matching
SCAN a
SEARCH g USING COVERING INDEX grants_recipient_target_idx (recipient_id=? AND target_id=? AND owner_id=?)
```

The lineage has at most 101 rows/100 edges. Scans of `child`, `a`, `lineage`, and `matching` are bounded temporary results, not scans of persisted Files or all of an Account's Grants. The unique Grant relationship gives at most one matching Grant per ancestor/target. `matching AS MATERIALIZED` computes the union once. `CROSS JOIN` fixes the bounded ancestor result as the outer loop: ordinary JOIN was observed to probe by recipient only and iterate all their Grants. The test checks the full recipient/target/Owner covering-index probe and rejects persistent node/Grant scans. Overflow/unrooted Grant ancestry fails closed; exact ownership does not require ancestor-derived authority, while Owner ancestry navigation and moves still reject over-bound paths.

References: [SQLite CROSS JOIN loop-order control](https://sqlite.org/optoverview.html#manual_control_of_query_plans_using_cross_join), [D1 transactional batch](https://developers.cloudflare.com/d1/worker-api/d1-database/).
