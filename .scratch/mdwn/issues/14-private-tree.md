# 14: Private tree: Directories and Files with encrypted names, ordering, and revisions

**What to build:** A person browses their Files tree, creates Directories and Files, and renames them — with every name and ordering decrypted only in the browser, canonical collisions resolved before submission, and concurrent structural changes refused rather than silently resolved.

**Blocked by:** 05 (`mdwn/namespace-v1` canonical names), 09 (Device proofs and registry epochs).

**Status:** done

- [x] SQLite-compatible schema and reviewed migrations for `vault_nodes` (node ID, `directory | file` kind, Owner, nullable parent, nullable immutable Import ID, lifecycle metadata), `directories` (Directory node key, monotonic `entries_revision`), `files` (File node key, current representation pointer, current revision), `directory_entries` (one current parent/child edge with encrypted display name and ordering, plus the parent capability's envelope for the child Directory capability or current File key), and `file_representations` (one decoded encrypted private Markdown/File-metadata payload with content-key/epoch identity, ciphertext size, and revision).
- [x] Constraints hold: each Account has exactly one parentless hidden root Directory (partial unique index); a parent is a Directory; parent and child share an Owner; the graph has no cycles; `vault_nodes.parent_node_id` agrees with its `directory_entries` edge; `files.current_representation_id` identifies exactly the representation for its current revision; foreign keys use `ON DELETE RESTRICT`.
- [x] Directory names, File names, and ordering are ciphertext at the service boundary: no request, D1 record, error, or log contains a plaintext name, a deterministic name-equality token, or plaintext ordering.
- [x] Create and rename run `mdwn/namespace-v1` in the browser against the decrypted Directory namespace, which is one canonical case-insensitive namespace shared by child Files and Directories; a valid non-colliding request is submitted; a local collision opens the name-conflict review instead of overwriting or merging.
- [x] New nodes provision their capability/key envelopes at creation (no deferred provisioning job), and a Directory entry carries the envelope the parent capability needs for its child.
- [x] Routes are `/d/:directoryId` and `/f/:fileId` with opaque IDs and no plaintext name, path, or capability; opening a File selects it and expands all ancestor Directories; opening a Directory selects it; expanded/collapsed state outside that is a local browser preference, not deep-link state.
- [x] Inaccessible and deleted private objects receive the same non-revealing not-found treatment.
- [x] Every create and rename conditionally advances the affected `entries_revision`; on a winning concurrent structural change the Worker performs no mutation and returns nameless `409 namespace_changed`, and the authorized browser says **This folder changed on another device. Nothing was added, replaced, or overwritten.**, refreshes and decrypts the Directory, and preserves the requested name while offering Refresh and retry, Rename, or Cancel.
- [x] Wide layouts show the Files tree, breadcrumbs, editor, and preview; narrow layouts use a tree drawer — with no plaintext names in routes, titles, or logs in either.
- [x] Tests prove same-revision two-client creation commits exactly once with a `409` loser and no partial state, re-run the namespace fixtures through the real create path, and assert node/entry agreement after each mutation.

## Comments

- 2026-09-21: Dependency note from ticket 03: Directory-entry envelopes use `app/crypto/enc-v1` (`docs/enc-v1.md`) with purposes `directory-capability`, `file-content-key`, and `directory-metadata`. A listing or manifest envelope opens only against the current `entries_revision` plus an externally trusted `manifestDigest`; an older revision or a same-revision fork fails `replayed-manifest`.
- 2026-09-26: Implemented in PR #18 (`feat/14-private-tree`). Local tests passed (80 Node, 100 Worker, 180 browser), and the required CI jobs passed on implementation commit `4ff2be1`. Merge remains pending.
