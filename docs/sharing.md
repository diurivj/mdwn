# Shares, Grants, and server authority

Ticket 17 introduces server-authoritative account-to-account sharing, parent-free File editing and basic current-device Grant capability delivery. [ADR-0008](adr/0008-parent-free-file-capabilities.md) records the approved hierarchy and ticket split. Ticket 18 adds Comment/Public-history delivery and persistent opaque provisioning needs; ticket 20 adds [browser-driven enrollment/replacement-device fulfillment](shared-provisioning.md), and ticket 19 adds [browser-driven resumable key rotation](key-rotation.md). Comment/Publication/Import/Export endpoints retain their own operational enforcement and tests. No ciphertext or Grant possession substitutes for a current device-bound Session and Device proof.

## Interfaces

Resource routes are thin React Router actions under `app/routes/api/`. All requests require the same origin and the shared Device-proof guard. Read-only requests are bodyless POSTs, return `Cache-Control: no-store`, and never consume a proof or update device activity.

| Request | Operation |
| --- | --- |
| `POST /api/private/shares[?cursor=<opaque-id>]` | Incoming/outgoing pending Shares; outgoing rows add `recipientShareId` |
| `POST /api/private/shares/address` | Only the caller's opaque share identifier |
| `PUT /api/private/shares` | Owner invites an exact existing Account; `409 key_rotation_required` while a write seal covers the target, `409 already_shared` when that Account already has a pending Share or Grant on it |
| `POST /api/private/shares/:id/accept` | Recipient accepts; atomically creates a Grant and removes the Share |
| `POST /api/private/shares/:id/decline` | Recipient hard-deletes the pending Share |
| `DELETE /api/private/shares/:id` | Owner cancels the pending Share |
| `POST /api/private/grants[?cursor=<opaque-id>]` | Received/owned active Grants; owned rows add `recipientShareId` |
| `PATCH /api/private/grants/:id` | Owner changes permission and/or a future `expiresAt` deadline (`null` clears it), with `expectedRevision` |
| `DELETE /api/private/grants/:id` | Owner revokes with `expectedRevision` |
| `POST /api/private/grants/:id/leave` | Recipient leaves with `expectedRevision` |
| `POST /api/private/{shares,grants}/:id/keys[?cursor=<device-id>]` | Owner's scoped current device targets; active recipient's own envelope only |
| `PUT /api/private/{shares,grants}/:id/keys` | Owner submits up to 20 signed device envelopes; an active Grant's current recipient holder may forward to its own Account's devices |
| `POST /api/private/{shares,grants}/:id/comment-keys[?cursor=<object-id>]` | Required Private/retained Public-history capabilities, 20 per page |
| `POST /api/private/{shares,grants}/:id/comment-keys/:objectId[?cursor=<device-id>]` | Owner's current device targets (for a Share, plus an owned `source` when one exists, see below); active recipient's own envelope only |
| `PUT /api/private/{shares,grants}/:id/comment-keys/:objectId` | Up to 20 signed Comment envelopes, pinned to current scope/epochs; current recipient holders may forward within their Account |
| `POST /api/private/grants/:id/needs[?cursor=<device-id>]` | Owner's opaque device needs, 20 per page; recipient sees only its own |
| `PUT /api/private/grants/:id/needs` | Proof-gated, idempotent current-coverage reconciliation with an empty object body |
| `POST /api/private/grant-provisioning/next` | One current missing capability/device item this source can provision, plus expiry-cleanup status |
| `PATCH /api/private/grant-provisioning/expire` | Empty-object, proof-gated Owner expiry cleanup/rotation-handoff pass |
| `PUT /api/private/tree/files/:id/capability` | Authorized browser atomically converts a legacy File under its parent write authority |

An invitation has `{ targetId, recipient: { shareId } | { handle }, permission }`. Handles are optional, 3–32 ASCII letters/digits/underscores/hyphens, with exact case-insensitive equality. No trimming, prefixes, wildcards, fuzzy matching, Account directory, or standalone lookup endpoint exists. Only a domain-separated SHA-256 lookup token is stored; this is share addressing, not authentication. Handle assignment/profile editing is not introduced here.

Lists have a combined 100-relationship page and an explicit `nextCursor`. They return opaque identities and target kind/permission only, never tree edges or encrypted Directory names. On rows the caller owns (outgoing Shares and owned Grants) they also return `recipientShareId`, the recipient Account's opaque share identifier, so an Owner can tell Collaborators apart; the Owner already supplied it when inviting. Incoming and received rows gain nothing about the Owner beyond the existing opaque `ownerId`. Every retained Share is pending. Grant authority excludes expired deadlines at statement time; an expired Grant temporarily remains only as a write seal until bounded cleanup hands off to rotation. Unique relationship indexes and same-Owner/type target foreign keys enforce their storage contracts. No sharing audit log or inactive relationship rows are kept.

## Sharing management UI (ticket 58)

The **Sharing** page (`/account/sharing`, Account menu and Files tree footer) is browser-only: a `clientLoader` reads the caller's share identifier and both relationship lists through `app/shared/sharing/relationships-client.ts`, and server HTML contains only a public loading shell (`tests/worker/sharing-shell.test.ts`). The client follows `nextCursor` up to 20 pages, rejects a repeated or non-advancing cursor, and validates each row's exact shape and direction against the Account its proof was bound to. It shows:

- **Your share identifier**, with Copy. It addresses invitations only; it is not the Public pseudonym.
- **Invitations** (incoming Shares) as **Shared File** or **Shared folder** with the permission, and confirmed Accept or Decline. A `409 sharing_changed` on acceptance is explained as the Owner's browser still preparing secure access (or a changed invitation): try again later or refresh.
- **Shared with you** (received Grants): generic label, permission, expiry, an Open link (`/f/:id` or `/d/:id`), and confirmed Leave. Its copy says access ends now and the Owner's browser then replaces the item's keys through a secure access update, with new edits waiting until it finishes; the expiry control says the same happens when an expiry passes.
- **Shared by you**: pending outgoing Shares (target kind and open link, recipient share identifier, permission, "Waiting for acceptance", confirmed cancel) and owned Grants (recipient share identifier, confirmed permission change, set/clear expiry at the end of a chosen local day, confirmed revoke). Revoke and permission-change copy says access ends now and links to [secure access updates](key-rotation.md).

Each control submits an explicit intent (`app/shared/sharing/sharing-intents.ts`) with the relationship id and, for Grants, the `expectedRevision` the person saw; the page stays busy until revalidation reloads the lists, and 404/409 outcomes show actionable copy. Recipients see no names, because names stay encrypted from them; Owner rows show only the target kind for now, because resolving names would need tree walks.

The library sidebar's **Shared with me** section lists received Grant roots with the permission and, when invitations are pending, links "N invitations" to the Sharing page. It reads a tab-memory summary (`app/shared/sharing/shared-with-me-cache.ts`): 60 seconds, keyed by Account, refreshed after any sharing intent, primed by the Sharing page's own read, and re-read on window focus when older than 5 seconds. It is never stored or server-rendered, so remounting Files routes adds no relationship requests. It is private tab memory (see `docs/serving-and-security.md`): every clear forgets it, and a tab hidden past its timeout keeps nothing until it is visible again. Leaving a Grant also clears private tab memory in every tab, since tab memory may hold that Grant root's verified listings and keys.

### Inviting and preparing secure access

An owned File or folder has a **Share** action in the workspace (`app/sharing/share-dialog.tsx`). It is not offered for the Library root or for content shared with you, because Collaborators cannot reshare, and it waits for a File's draft to be saved. The dialog takes the recipient's exact share identifier and **Read only** or **Read & write**. On submit the Owner's browser:

1. converts a legacy File to its own File capability first, with the snapshot's parent listing and key (`convertFileCapability`);
2. invites with `PUT /api/private/shares`;
3. prepares secure access (`prepareShare`), showing progress, and then says the recipient can accept from **Sharing** in their Account menu.

A 404 means no other Account has that identifier; the dialog compares the caller's own identifier first and says you can't share with yourself (the server answers 404 for it too). `409 already_shared` — also caught before sending from this target's own rows — says that Account already has an invitation or access for this item. `409 key_rotation_required` links to [secure access updates](key-rotation.md); the server is the only authority for write seals. `409 sharing_changed` asks to try again. When an ancestor folder is shared, the dialog names that folder and its Collaborators and pending invitations, and says to manage that access on the folder, instead of claiming only the Owner can open the item. The dialog lists that target's pending Shares and owned Grants with the Sharing page's own rows, loader (`fetcher.load("/account/sharing")`) and intents. Row intents submit with `defaultShouldRevalidate: false`, so they never reload Files or an unsaved draft; the dialog re-reads only its lists.

`app/shared/sharing/share-staging-client.ts` `prepareShare(shareId)` stages, from this Owner device, the root Grant envelope and every required Comment-capability envelope for each current recipient device:

- It reads every target first — `POST …/shares/:id/keys` and `…/comment-keys` pages, then each object's device pages — and requires one consistent snapshot (relationship, target, Grant epoch and both registry epochs, one signing device) before any upload. Cursors must advance and each listing reads at most 20 pages. A pass makes at most 2,000 private requests, counting every target read, upload, owned-tree walk step and bootstrap; an imported thread's File capability is opened once per File per pass.
- The root key comes from the Owner's verified owned walk (`app/shared/sharing/owned-capabilities.ts`, shared with [shared-content provisioning](shared-provisioning.md)). Each Comment key comes from the owned `source` the share Comment-key target returns only to the Owner's authorized device (`app/sharing/owned-sources.server.ts`):
  - `{ kind: "recovery", envelope }`: the Owner's own current-epoch, unsuperseded `vault-recovery` row, the same row and helper `grant-provisioning/next` uses;
  - otherwise, for a Private thread, `{ kind: "import", envelope }`: an imported Historical thread's `import_comment_envelopes` row for that thread, capability and epoch, the row the Comments read serves in `import` mode (both use the same SQL fragments, `currentRecoveryEnvelope` and `importedThreadEnvelope`, in `app/sharing/owned-sources.server.ts`). The browser opens it under the Owner's File capability key for that File, found by the same verified walk, with the Comments client's own import opening (`openImportedThreadCapability`). **This second source is a protocol addition awaiting the maintainer's sign-off.** Existing-Grant provisioning (`grant-provisioning/next`) does not offer it yet.

  If neither source exists, the pass prepares the others and reports that access to some existing Comments can't be prepared from any device; it never fabricates a key.
- `PUT` packets carry at most 20 envelopes. An uncertain response is retried once with the same saved ciphertext bytes and a fresh Device proof; an envelope is never re-sealed for a retry.
- `409 sharing_changed` restarts the pass once with fresh targets, then fails with actionable copy. A write seal added after the invitation is reported explicitly: for Shares, the key and Comment-key targets and uploads pre-check the seal and answer `409 key_rotation_required` (each upload keeps its in-transaction seal guard), and the UI links to secure access updates. More than 20 pages of any listing is a typed limit, reported as too large rather than a retryable failure. Running a pass again is safe because pending Share envelopes upsert.

**Prepare secure access** on each pending outgoing Share (Sharing page and Share dialog) runs the same pass. When the Owner opens the Sharing page, it also prepares the 5 newest pending Shares (`selectAutomaticPreparations`) in the background, once per visit, so recipient devices enrolled after the invitation are covered without an unbounded job; failures stay quiet and the row action remains.

## Effective authority and the permission matrix

`app/sharing/access.server.ts` is the server policy seam:

- `effectiveAccess` returns current authority, or null for an inaccessible target.
- `effectiveAccessQuery` embeds the bounded query in a ciphertext SELECT or a mutation's first CAS.
- `accountAccessQuery` runs the same bounded query for another Account without the acting device's guard. Owner-side policy uses it — for example, a Publication author must hold current File-read access ([publications](publications.md)) — always alongside the actor's own Device-proof guard in the same statement.
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

Browser deep links can open a received Grant root without traversing the Owner's hidden root. A direct File view contains no parent listing; read-only controls remain read-only according to current server authority. An absent device envelope shows **Shared content is being securely provisioned**, with no decrypted names or fragment fallback. Ticket 20 consumes the delivery/needs protocol below for automatic new/replacement-device fulfillment.

Revocation, leave, and permission changes immediately remove/change server authority in a short proof-gated transaction. That same transaction records a current `sharing_write_blocks` safety seal/next-key fence and an Owner-resumable rotation job on the affected target; permission changes also advance the Grant epoch. The seal contains no former recipient, Grant identity, or historical audit record. Future encrypted/structural writes beneath it fail closed. Reads and hard deletion remain available, and explicit hard deletion removes all dependent Shares, Grants, and seals. Never expire or clear a seal merely to restore writes under an old key; [rotation](key-rotation.md) must replace affected capabilities and cover current retained Grant/Comment requirements before unsealing.

A move that would lose any inherited Directory Grant is refused with `409 key_rotation_required`, even for the Owner or when the moving actor retains another access path. Direct File Grants and Grants on the moved Directory itself follow identity and are not lost by a move.

## Comment capability coverage and provisioning needs (ticket 18)

`sharing_comment_capabilities` is a current opaque requirement registry, not a Comment thread or Publication implementation. Ticket 21 registers each Private thread **in the same transaction** as its creation (see [comments](comments.md)); ticket 23 registers every retained Public audience epoch the same way. The registry binds Owner, File, thread, object/epoch, purpose, logical Publication (Public only), capability identity and exact key epoch. Context identities are immutable; key rotations advance the epoch. Both Public and Collaborators-only retained epochs qualify for authenticated delivery. Audience/link wrappers and the actual Comment/Publication lifecycle remain in tickets 21–25; no anonymous route or Publication capability is introduced here.

The producer must remove all pending/active Comment envelope dependents and registry requirements in its irreversible teardown/seal transaction, then reconcile affected needs. In particular, unpublish must remove the requirements at the seal, not leave Grant-key endpoints serving a sealed Publication while later batches delete bodies. A later Publication registers fresh identities. Rotation must pin the current required set and use `activeGrantCoverage` before considering a device complete; root-only coverage is insufficient. These are integration contracts for the later lifecycle producers, not a second storage path for Comments or keys.

`app/shared/sharing/comment-keys` signs a domain-separated `mdwn/grant-comment-key-envelope`, version 1 transcript. It binds the root Grant target, File/thread/epoch, purpose, Publication where applicable, both registry snapshots, Grant and capability epochs, exact signer/recipient and whole-envelope SHA-256 digest. The `enc-v1` HPKE context binds Owner Vault, Comment object, capability, exact epochs, recipient, and optional Publication. Grant delivery accepts only HPKE, never a symmetric link wrapper, an enrollment envelope, a root Grant envelope, or another object's envelope. Header inspection and successful opening establish no authorization. Older/future epochs fail distinctly and never start rotation.

Acceptance's first CAS checks complete current-device coverage of the root **and every registered requirement in the current subtree** with live Owner signers and current registry snapshots. It copies only current scoped material and deletes all pending material atomically. Registered requirements added after staging prevent acceptance until covered. Once accepted, unrelated registry additions preserve historical envelopes for unchanged active devices and current object/Grant epochs. Only the recipient's current proof-bound device can retrieve its own material. Permission changes, revoke and leave invalidate/remove the relationship's Comment envelopes immediately, independently of cached keys or overlapping Grants.

`provisioning_needs` contains exactly `(grant_id, device_id, grant_key_epoch)`, no names, ciphertext, keys, capabilities or free-form progress. Active device insertion records needs inside routine/recovery cutover; new/rotated Comment requirements record needs for currently covering Grants. Reconciliation removes completed/inactive/stale work and records missing current coverage without opening keys. Each successful active delivery retires only needs with complete root plus retained Comment coverage, in the same invocation-token-gated transaction. Exact ciphertext retries with fresh proofs are harmless; a lost/invalid proof cannot unlock dependents. Permission changes replace work with the new Grant epoch but do not clear rotation seals. Revoke, leave, device removal, recovery and hard deletion explicitly cancel affected work/envelopes. No Grant material enters `key_envelopes`, Vault recovery or routine enrollment.

A missing root keeps the Files page at **Shared content is being securely provisioned**, with no names, plaintext or fragment fallback. Missing Comment-only material returns ciphertext-free `409 secure_access_preparing`; later Comment consumers may show **secure access is being prepared** without withholding a separately provisioned File. Owner devices can process the paginated needs and delivery endpoints. [Ticket 20 fulfillment](shared-provisioning.md) also lets a recipient device with a current envelope forward that capability to another active device of the same Account/Grant; this does not permit resharing.

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
