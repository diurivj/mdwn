# 25: Public-link rotation and unpublish teardown

**What to build:** An Owner replaces a Public link with a new one while the Publication itself survives, or ends the Publication permanently with a sealed, irreversible teardown that the Owner's browser finishes in bounded batches.

**Blocked by:** 22 (Publish a File), 23 (Public Comment threads and audience epochs).

**Status:** ready-for-agent

- [x] Rotation: the Owner's browser creates a fresh path identifier and capability, rewraps all public Comment epochs for the new capability, and one transaction installs the new active link and removes the old routing. The old path immediately returns the same ciphertext-free `404` as an unknown link, and the retired identifier is never reused.
- [x] Rotation preserves the logical Publication, the current Public representation, and the Public Comment thread and history; account-device epoch envelopes remain separate from the Publication-capability wrappers.
- [x] Unpublish states the irreversible effect and the current opaque Public Comment count before confirming, for example **Unpublish and permanently delete 12 Public Comments**.
- [x] The seal transaction verifies Owner authority, removes the active link, changes the Publication irreversibly to `deleting`, and creates teardown progress; every Public route and Public-thread endpoint denies access thereafter, and a deleting Publication can never become active again.
- [x] The Owner's browser then drives idempotent bounded deletion batches for the Public representation, thread and epochs and Comments, envelopes, attribution, requests, teardown state, and the Publication row, with the UI showing **Deleting public material…** and progress. Only the Owner may resume an interrupted teardown.
- [x] No new Publication is allowed for that File until cleanup completes, and a later Publication starts entirely fresh.
- [x] Public-participation limits and suspensions can never block this flow.
- [x] Tests prove interrupted teardown remains sealed and Owner-resumable, unknown, rotated, and sealed paths are indistinguishable, and no Publication row or public ciphertext survives completion.

## Comments

- 2026-09-21: Dependency note from ticket 03: rotation rewraps the Public audience-epoch wrappers with the new Publication capability. Those wrappers are symmetric envelopes, distinct from the account-device HPKE envelopes (see ticket 23), and the superseded wrappers must be removed rather than left readable.
- 2026-10-04: Implemented on `issue/25-link-rotation-and-unpublish`. Migration `0023_majestic_amphibian.sql` adds `publication_teardowns` with insert/immutability guards and replaces `publication_link_immutable` with `publication_link_rotation_guard`; sealed Publications can never gain a link, representation or Public thread, and every update/insert path is owner-gated. Rotation (`PUT …/files/:fileId/link`) regenerates the path and key pair in the Owner's browser, rebuilds the presentation from the latest saved source without needing the retired fragment, opens every public epoch capability through the Owner's device envelopes (`loadFilePublicEpochs`), and one D1 transaction replaces the link identity in place, rewraps each public epoch, replaces the representation at the same presentation revision and CASes the File revision. Authors re-declare to the new link; device envelopes are untouched. Unpublish (`POST …/unpublish`) seals in one transaction (link + wrappers removed, state `deleting`, pinned `comment_total`); the Owner's browser then drives bounded `POST …/teardown` batches (200 Comments per call) until the final batch removes the thread, epochs, Comments, attributions, envelopes, capabilities, representation, authors, requests, progress and the Publication row. Protocol and bounds are in `docs/publications.md`; `docs/comments.md` records the wrapper rotation. Hard deletion of a File mid-teardown now removes the teardown row with the Publication.
