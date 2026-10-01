# Shares, Grants, and server authority

Ticket 17 introduces server-authoritative account-to-account sharing, parent-free File editing and basic current-device Grant capability delivery. [ADR-0008](adr/0008-parent-free-file-capabilities.md) records the approved hierarchy and ticket split. Comment/Public-history provisioning, provisioning-needs processing and enrollment/replacement-device fulfillment remain in tickets 18/20; resumable rotation remains in ticket 19. Comment/Publication/Import/Export endpoints retain their own operational enforcement and tests. No ciphertext or Grant possession substitutes for a current device-bound Session and Device proof.

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
| `POST /api/private/{shares,grants}/:id/keys[?cursor=<device-id>]` | Owner's scoped current device targets; active recipient's own envelope only |
| `PUT /api/private/{shares,grants}/:id/keys` | Owner submits up to 20 signed device envelopes under pinned registry/root epochs |
| `PUT /api/private/tree/files/:id/capability` | Authorized browser atomically converts a legacy File under its parent write authority |

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

The hierarchy is `Directory capability → File capability → fresh representation content key`. New browser-created Files use it. A File capability remains stable across ordinary saves, not across access-driven rotation. Its parent edge contains the stable capability envelope; each representation carries its own bounded content-key envelope and device-signed File head. The head binds Owner, File, capability identity/epoch, representation/content-key identities, data epoch/revision, signer and exact ciphertext/envelope digests. The browser verifies the head and keeps an epoch/revision/digest checkpoint before decrypting. Service-registry trust and fresh-device rollback limitations are the same as the Directory-head protocol.

Converted saves submit only the expected File pointer/revision, capability identity/epoch, fresh representation, content-key envelope and File head. The first File CAS independently checks live write authority, proof and absence of a write seal. Invocation-token-gated dependents install the new representation and remove the old one. Parent metadata and recipient Grant envelopes remain unchanged. Owner, inherited readers and direct recipients open the new key through the same current File capability. Direct read/write plus inherited Directory read-only works without a parent write or listing.

A browser with parent write authority converts a legacy File in one conditional request: it creates a random File capability, rewraps the existing content key beneath it and replaces the parent edge/signed listing. File ciphertext, content key, representation pointer and File revision are preserved. The additive migration retains existing pointer constraints and triggers; its only immutability exception attaches the first complete header/wrapper to a pinned legacy representation without changing any original representation field. A stale or interrupted conversion leaves wholly legacy or converted state. Legacy parent-listing saves remain supported; legacy direct editing/invitation fails closed until conversion. Conversion cannot clear a rotation seal.

For acceptance the Owner stages HPKE `grant` envelopes for every current recipient device, in 20-device pages/packets. Each envelope has independent Owner-device intent signing bound to relationship, target/root identities, both registry snapshots, Grant key epoch, exact recipient/signer and ciphertext digest. The acceptance CAS requires complete current coverage, live Owner signer/registry, recipient registry and current root. The Share ID becomes the Grant ID; pending material is copied then deleted atomically. No partial authority or proof is consumed on a losing race. Only the recipient's currently authorized device can fetch its own current Grant envelope. Registry additions do not invalidate historical accepted envelopes for unchanged active devices; revoked-device rows are removed during device removal/recovery. Grant capabilities never enter Vault-root, recovery or routine enrollment envelopes.

Browser deep links can open a received Grant root without traversing the Owner's hidden root. A direct File view contains no parent listing; read-only controls remain read-only according to current server authority. An absent device envelope shows **Shared content is being securely provisioned**, with no decrypted names or fragment fallback. A sharing-management panel, later capability kinds, opaque provisioning-needs jobs and automated new/replacement-device fulfillment are not implemented by this slice.

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
