# Private tree structural operations

Ticket 16 adds encrypted sibling reordering, same-Owner moves, and irreversible hard deletion through the existing proof-guarded tree resource action. The browser opens names/order and checks `mdwn/namespace-v1` collisions; no plaintext name, comparison token, capability key, or ordering value enters a resource request, URL, error, or SSR document.

## Current dependency stage

Ticket 17 extends both preflight and **transactional** authorization through the bounded indexed access query; see [Shares, Grants, and server authority](sharing.md).

- A Directory read/write Collaborator may mutate only inside a covering granted subtree, never its shared root or outside that scope. A direct File Grant cannot authorize structural operations.
- Owner-controlled exits from any shared subtree are explicitly deferred until ticket 19 supplies completed bounded rekeying. Moves between disconnected Collaborator write scopes are denied.
- Revocation/leave/permission changes create current safety seals; future encrypted and structural writes beneath sealed targets fail closed until rotation. Reads and hard deletion remain available.
- Direct File Grants follow identity without disclosing a parent/path. Their parent-free fresh-key save protocol remains a ticket-18 dependency gap; the existing parent-capability save is never exposed to them.
- Shares, Grants, and safety seals are now explicitly removed during hard deletion. Ticket 27 must extend that list when Publication or Comment records are introduced.

## Protocol and concurrency

All operations use fresh Device proofs bound to the exact request body and current Session/device registry. Namespace heads are encrypted member commitments signed by the active Encryption device. Reorder replaces only encrypted order values and the parent head. Move supplies expected source/destination revisions, re-encrypted destination metadata, a rewrapped child key, and replacement heads for both Directories. File moves preserve the current representation/key identity; Directory moves preserve descendants.

Rename now pins the expected parent ID as well as its revision. Structural preflight errors recheck the authorized namespace revisions so a target disappearing or a File key advancing between reads still produces nameless `409 namespace_changed`, not misleading not-found/invalid-request errors. File saves similarly pin their original parent through the submitted listing-head context.

The multi-Directory/bulk mutation helper checks all revisions, eligibility, and live authority before its first CAS. A freshly generated, server-only `device_proof_uses.commit_token` gates every dependent statement; an old spent proof cannot unlock writes, and zero/many-row deletion counts cannot break the guard. D1 `batch()` supplies the transaction. Reciprocal foreign keys remain `ON DELETE RESTRICT`; `PRAGMA defer_foreign_keys = ON` defers them only until this batch commits, after explicit updates/deletions restore agreement. The migration preserves immutable ownership, kinds, Import IDs, and hidden roots, and adds bounded update-time ancestry/cycle checks matching the existing private-path bound.

References: [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/), [D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/).

## Hard deletion

The 500-node cap includes the selected Directory. Enumeration reads at most 501 nodes, authorizes each node/edge, and pins every parent relationship, Directory revision, and File pointer. The transaction rechecks the complete snapshot and bounded membership count, then explicitly removes:

1. Pending Shares, active Grants, and current sharing safety seals targeting the selected nodes;
2. Directory entries and their parent capability envelopes;
3. object-addressed Key envelopes;
4. private File representations;
5. File and Directory records;
6. Vault nodes.

A late failure rolls back heads, proof use, and every dependent record. An over-cap request changes nothing and directs the person to reduce the subtree; it never deletes a valid subset. Hidden roots cannot be renamed, moved, reordered, or deleted. Deleted/inaccessible objects share the same non-revealing not-found response. There is no trash, restore state, or retained representation history. Deletion cannot recall downloads or guarantee provider-managed backup-erasure timing.

## Browser behavior and verification

The browser requires a saved, non-composing File before structural actions and freezes all custom editing handlers while a structural dialog/operation is active. Moving a File remounts its parent-bound editor after releasing the previous editing lease. Structural and chooser requests use a page-scoped abort signal, and every asynchronous UI/navigation continuation checks that lifetime. The Router's existing File draft blocker synchronously invalidates it at navigation intent; Directory views use a non-blocking observer at the same boundary. Only one blocker is mounted, including during the editor handoff. Cancellation must precede a slow destination loader, not merely unmount: a completed deletion must never redirect over newer pending or completed Back navigation. Cancellation still cannot recall a database commit. Namespace conflicts preserve the requested name, show the ticket-14 refresh message, and reload/decrypt affected listings before any retry; deletion requires renewed destructive consent.

API tests use `SELF.fetch` and real migrated D1; graph/rollback checks supplement the public protocol seam. Browser tests cover real encrypted move/reorder/delete, canonical collisions, source/destination conflicts, over-cap guidance, draft protection, custom paste during a delayed move/delete, and pending/completed Back navigation with held successful File/Directory deletion responses across Chromium, Firefox, and WebKit.
