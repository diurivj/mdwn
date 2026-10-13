# 66: Provision imported Historical Comment threads to existing Grants

**What to build:** Make `grant-provisioning/next` and the Owner's needs processing able to deliver a required Comment capability whose key exists only as an imported Historical thread envelope. That key is wrapped under the File capability key, in `import_comment_envelopes`, with no `vault-recovery` row. Without this, a Grant whose scope gains an imported thread can never reach complete Comment coverage.

**Type:** bug

**Status:** ready-for-agent

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

## Chosen design (2026-10-12)

Option 1 for provisioning, plus the rotation work the ticket's second acceptance criterion requires. The maintainer asked for this ticket, which approves the Owner-only `import` source on the existing-Grant path (the same source ticket 58 added for Shares and PR #66 listed for sign-off).

- `grant-provisioning/next` selects an Owner-side Comment need when the thread has a `vault-recovery` row or an `import_comment_envelopes` row wrapped under the current File capability epoch, and returns `{ kind: "import", envelope }`. The browser opens it with the File capability key through the verified owned walk and the Comments client's own `openImportedThreadCapability`.
- A File promotion re-wraps every imported thread envelope under the replacement File capability key in the same transaction, and its CAS requires the complete set. The thread's own rotation item then rotates the capability and installs a fresh import envelope under the current File key instead of a `vault-recovery` row, so imported threads are replaced, not excluded from coverage.

## Acceptance criteria

- [x] A Grant whose scope contains an imported thread reaches complete Comment coverage, and provisioning needs clear. Covered by Workers tests with real D1.
- [x] Key rotation after revocation still replaces imported thread keys, or the chosen design records why it need not.
- [x] No key is fabricated, and no non-Owner device receives an Owner source.

## Comments

- 2026-10-12: Found during ticket 58's review. Share preparation is fixed in 58; the existing-Grant provisioning path is left for this ticket.
- 2026-10-12: Implemented on `issue/66-imported-thread-grant-provisioning`, rebased onto the merged ticket 58 work.
  - Provisioning: the Owner-side Comment need query joins `import_comment_envelopes` through one shared owner guard (`ownedImportedThreadEnvelope` in `app/sharing/owned-sources.server.ts`) and pins the envelope's wrapping epoch to the File capability epoch; the source is returned only under `s.owner_id = auth.accountId`, and the recipient branch keeps returning the recipient's own signed envelope. A thread with neither source stays pending and no key is fabricated.
  - Rotation: `readRotationSource` exposes the File's imported envelopes and the comment's import envelope; the File promotion validates and re-wraps each under the replacement File key with a CAS requiring the complete set; the comment promotion accepts `importEnvelope` instead of `recoveryEnvelope` for an imported thread, advances the thread epoch, re-wraps the per-record content keys and installs the fresh import envelope under the current File key. Grant coverage re-delivers through the provisioning path.
  - Tests: `tests/worker/grant-provisioning.test.ts` (+2: the Owner import source opened with a real File-capability envelope and re-delivered to the recipient; no fabricated source without one), `tests/worker/key-rotation.test.ts` (+2: full rotation of an imported thread with a comment record and re-delivery to the remaining Grant; a thread that appears between the source read and the promotion fails the CAS instead of being left sealed). `tests/worker/sharing-fixtures.ts` now owns the `importedThread` fixture.
  - Docs: `docs/sharing.md`, `docs/shared-provisioning.md`, `docs/key-rotation.md`, `docs/import.md`, `docs/acceptance.md`.
  - Review: Standards round found one hard finding (the owner-scope guard duplicated three times) plus named smells; Spec round found the CAS was skipped when the client reported no imported threads (fixed, with the race test), the wrapping-epoch pin missing (added), and the triage/sign-off record missing (this section). Fixes in `e3c7bb9`. Separate RR8/stack gate: **Pass** (no route, loader, SSR, binding or migration changes).
  - Clean-head `npm run verify` passed at `e3c7bb934fb087dcebf2e9cb0f1fa80c70dd86af`: lint, typecheck, namespace drift, 555 Node and 418 Workers tests, the build, the fresh-D1 smoke, export/restore, the bundle-secret check, and the browser suite across Chromium, Firefox and WebKit.
