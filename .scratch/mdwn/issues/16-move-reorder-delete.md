# 16: Move, reorder, delete, and bounded Directory hard deletion

**What to build:** A person moves, reorders, and hard-deletes Files and Directories in their tree — with cross-owner and outside-subtree moves refused, and Directory deletion either removing the whole bounded subtree or changing nothing at all.

**Blocked by:** 14 (Private tree), 15 (Editor and preview workspace).

**Status:** ready-for-agent

- [ ] Create, rename, reorder, move, and delete transactions check current authorization and the expected source/destination Directory revisions, validate node kind, same-owner containment, cycle prevention, and movement restrictions, change `vault_nodes.parent_node_id` and `directory_entries` consistently, update any required capability envelopes/rekeying, and increment every affected Directory's `entries_revision`.
- [ ] Cross-owner containment and cross-owner moves are forbidden; a Directory read/write Collaborator may mutate only inside the granted subtree, cannot delete the shared root, and cannot move content outside it.
- [ ] A move out of a shared subtree either completes its required rekeying within the bounded operation or is rejected/deferred; it may never expose future writes under an old capability.
- [ ] A winning concurrent structural change makes no mutation and returns nameless `409 namespace_changed`; the authorized browser shows the refresh message from ticket 14 and revalidates before any retry.
- [ ] File hard deletion explicitly removes its Directory entry, private representations, and Key envelopes in dependency order; no generic database cascade stands in for authorization or lifecycle checks.
- [ ] Directory hard deletion enumerates and authorizes the full subtree, proceeds only when it contains at most 500 nodes, explicitly removes every dependent graph record in one transaction, and leaves all data unchanged when over the cap while directing the user to reduce the subtree.
- [ ] There is no trash, soft-delete state, restore action, or user-visible revision history; a deleted or inaccessible object gets the same non-revealing not-found treatment.
- [ ] Tests prove over-cap Directory deletion changes nothing, a ≤500-node Directory deletes atomically, a same-revision concurrent delete commits exactly once, and node/entry agreement survives every mutation.
