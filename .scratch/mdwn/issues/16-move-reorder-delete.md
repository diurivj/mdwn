# 16: Move, reorder, delete, and bounded Directory hard deletion

**What to build:** A person moves, reorders, and hard-deletes Files and Directories in their tree — with cross-owner and outside-subtree moves refused, and Directory deletion either removing the whole bounded subtree or changing nothing at all.

**Blocked by:** 14 (Private tree), 15 (Editor and preview workspace).

**Status:** ready-for-human

- [x] Create, rename, reorder, move, and delete transactions check current authorization and the expected source/destination Directory revisions, validate node kind, same-owner containment, cycle prevention, and movement restrictions, change `vault_nodes.parent_node_id` and `directory_entries` consistently, update any required capability envelopes/rekeying, and increment every affected Directory's `entries_revision`.
- [ ] Cross-owner containment and cross-owner moves are forbidden; a Directory read/write Collaborator may mutate only inside the granted subtree, cannot delete the shared root, and cannot move content outside it.
- [ ] A move out of a shared subtree either completes its required rekeying within the bounded operation or is rejected/deferred; it may never expose future writes under an old capability.
- [x] A winning concurrent structural change makes no mutation and returns nameless `409 namespace_changed`; the authorized browser shows the refresh message from ticket 14 and revalidates before any retry.
- [x] File hard deletion explicitly removes its Directory entry, private representations, and Key envelopes in dependency order; no generic database cascade stands in for authorization or lifecycle checks.
- [x] Directory hard deletion enumerates and authorizes the full subtree, proceeds only when it contains at most 500 nodes, explicitly removes every dependent graph record in one transaction, and leaves all data unchanged when over the cap while directing the user to reduce the subtree.
- [x] There is no trash, soft-delete state, restore action, or user-visible revision history; a deleted or inaccessible object gets the same non-revealing not-found treatment.
- [x] Tests prove over-cap Directory deletion changes nothing, a ≤500-node Directory deletes atomically, a same-revision concurrent delete commits exactly once, and node/entry agreement survives every mutation.

## Comments

- Implemented the owned, unshared dependency stage on `feat/16-move-reorder-delete`; details and integration contracts are in `docs/tree-structure.md`. Cross-owner requests fail closed. The two unchecked shared-subtree/rekey acceptance items require the Share/Grant and rotation records from tickets 17–19. Owner-controlled exits need the same transactional rotation gate as Collaborator exits before sharing is enabled; merely relaxing `owner_id` checks is unsafe. Ticket 27 must extend explicit deletion dependencies before Grants, Publications, and Comments exist. This limitation is intentional, not claimed as tested Collaborator support.
- Final verification: the full suite with Playwright `--workers=1` passed all 80 Node, 122 Worker, and 252 browser tests. This includes 35 private-tree Worker tests and 39 structural browser checks across Chromium/Firefox/WebKit. Typecheck, production build, migration smoke, bundle-secret checks, and diff checks pass. Earlier higher-concurrency runs timed out in existing WebKit signup/camera checks; each passed its isolated retry and the final complete serial run. No device-enrollment code was changed. Review corrections cover bounded move ancestry, paste during a frozen structural operation, preflight/saved-key races producing the required namespace conflict, and synchronous navigation-intent cancellation before a slow destination loader (not just unmount). Held successful File/Directory deletions cannot override pending or completed Back navigation.
