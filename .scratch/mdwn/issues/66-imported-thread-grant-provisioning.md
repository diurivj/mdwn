# 66: Provision imported Historical Comment threads to existing Grants

**What to build:** Make `grant-provisioning/next` and the Owner's needs processing able to deliver a required Comment capability whose key exists only as an imported Historical thread envelope. That key is wrapped under the File capability key, in `import_comment_envelopes`, with no `vault-recovery` row. Without this, a Grant whose scope gains an imported thread can never reach complete Comment coverage.

**Type:** bug

**Status:** needs-triage

**Blocked by:** none. Ticket 58's share-preparation `import` source should land first, so this path can reuse it.

**Related:**
- [58: Sharing management UI](58-sharing-management-ui.md): review round 1 found the gap for Shares and added an Owner-only `import` source to the share Comment-key endpoint.
- [`docs/import.md`](../../../docs/import.md) (Historical Comments), [`docs/sharing.md`](../../../docs/sharing.md) (Comment capability coverage).
- `app/sharing/provisioning.server.ts`, `app/comments/envelopes.server.ts` (`import` read mode), `app/sharing/capability-coverage.server.ts` (`requiredGrantComments`).

## The gap

Import commit registers each Historical thread in `sharing_comment_capabilities`, so `requiredGrantComments()` counts it for Grant coverage. Collaborators already read such a thread through current File-read access, in `import` mode. Even so:
- Provisioning items for the Owner require a `vault-recovery` row (`k.ciphertext IS NOT NULL`), so imported threads never become provisionable items.
- Coverage-dependent states stay pending: acceptance, provisioning needs and rotation completeness.

## Options for the maintainer

1. Deliver the key the way share preparation now does: the Owner's device opens the `import` envelope with the File capability key and stages Grant Comment envelopes.
2. Exclude a thread from Grant coverage while its `import` envelope matches the current thread capability epoch. This must first be checked against Key rotation's use of `requiredGrantComments()`, because rotation must still replace thread keys after a revocation.

## Acceptance criteria

- [ ] A Grant whose scope contains an imported thread reaches complete Comment coverage, and provisioning needs clear. Covered by Workers tests with real D1.
- [ ] Key rotation after revocation still replaces imported thread keys, or the chosen design records why it need not.
- [ ] No key is fabricated, and no non-Owner device receives an Owner source.

## Comments

- 2026-10-12: Found during ticket 58's review. Share preparation is fixed in 58; the existing-Grant provisioning path is left for this ticket.
