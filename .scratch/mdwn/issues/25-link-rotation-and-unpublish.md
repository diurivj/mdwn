# 25: Public-link rotation and unpublish teardown

**What to build:** An Owner replaces a Public link with a new one while the Publication itself survives, or ends the Publication permanently with a sealed, irreversible teardown that the Owner's browser finishes in bounded batches.

**Blocked by:** 22 (Publish a File), 23 (Public Comment threads and audience epochs).

**Status:** ready-for-agent

- [ ] Rotation: the Owner's browser creates a fresh path identifier and capability, rewraps all public Comment epochs for the new capability, and one transaction installs the new active link and removes the old routing. The old path immediately returns the same ciphertext-free `404` as an unknown link, and the retired identifier is never reused.
- [ ] Rotation preserves the logical Publication, the current Public representation, and the Public Comment thread and history; account-device epoch envelopes remain separate from the Publication-capability wrappers.
- [ ] Unpublish states the irreversible effect and the current opaque Public Comment count before confirming, for example **Unpublish and permanently delete 12 Public Comments**.
- [ ] The seal transaction verifies Owner authority, removes the active link, changes the Publication irreversibly to `deleting`, and creates teardown progress; every Public route and Public-thread endpoint denies access thereafter, and a deleting Publication can never become active again.
- [ ] The Owner's browser then drives idempotent bounded deletion batches for the Public representation, thread and epochs and Comments, envelopes, attribution, requests, teardown state, and the Publication row, with the UI showing **Deleting public material…** and progress. Only the Owner may resume an interrupted teardown.
- [ ] No new Publication is allowed for that File until cleanup completes, and a later Publication starts entirely fresh.
- [ ] Public-participation limits and suspensions can never block this flow.
- [ ] Tests prove interrupted teardown remains sealed and Owner-resumable, unknown, rotated, and sealed paths are indistinguishable, and no Publication row or public ciphertext survives completion.
