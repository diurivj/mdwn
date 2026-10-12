# 58: Sharing management UI: invite, accept and manage Collaborators

**What to build:** Let people actually collaborate. The Share/Grant protocol is complete on the server and in the browser libraries (tickets 17–20 and 23), but nothing in the product lets an Owner invite someone, lets a Collaborator accept, or lets either side see or end the relationship. Today a Collaborator can open shared content only through a direct `/d/:id` or `/f/:id` link once a Grant already exists, and the browser suite creates every Share through the API.

**Type:** feature

**Status:** ready-for-agent

**Blocked by:** none.

**Related:** [`docs/sharing.md`](../../../docs/sharing.md) ("A sharing-management panel is not implemented by this slice"); [`docs/shared-provisioning.md`](../../../docs/shared-provisioning.md); [ADR-0004](../../../docs/adr/0004-owner-controlled-sharing.md); [56: pre-launch polish](56-pre-launch-polish.md), where the maintainer asked whether Collaborators were implemented.

## What exists

- `PUT /api/private/shares` invites an exact Account by opaque share identifier or exact handle, with a permission; accept, decline and cancel endpoints exist; Grants can be listed, have their permission or expiry changed, be revoked, or be left. Revocation and permission changes seal writes and hand off to resumable key rotation.
- Owner devices stage per-device HPKE Grant envelopes before acceptance; new and replacement recipient devices are provisioned automatically (`grant-provisioning/next`) or from **Shared access**.
- The workspace opens a received Grant root, enforces read-only versus read/write, shows Collaborators' Comments with their Public pseudonyms, and lets Collaborators request a Publication from the Owner.

## Decisions (2026-10-12)

The maintainer chose the full flow, addressed by share identifier only.

- **Addressing:** an Account sees and copies its own opaque share identifier on a new **Sharing** page (Account menu). Editing share handles is deferred, because no endpoint assigns handles; inviting by handle stays API-only.
- **Invitation flow:** a **Share** dialog on an owned File or folder takes the recipient's share identifier and read-only or read/write. It is not offered for the Library root or for content shared with you, because Collaborators cannot reshare. The Owner's browser first converts a legacy File capability when needed, then invites, then prepares (stages) the Grant envelope and every required Comment-capability envelope for each current recipient device. Preparation is resumable and safe to repeat (**Prepare secure access**). Expiry is set on an active Grant, because pending Shares have no expiry on the server.
- **Inbox:** pending incoming Shares appear on the Sharing page and as a count in the library sidebar's **Shared with me** section. Accepting or declining asks for confirmation. Accepting before preparation finishes explains that the Owner's browser is still preparing secure access.
- **Shared with me:** received Grant roots are listed in the library sidebar as **Shared File** or **Shared folder** with their permission. Names stay encrypted from recipients, as the protocol requires.
- **Management:** outgoing Shares (cancel, prepare secure access) and owned Grants (permission, expiry, revoke) appear on the Sharing page and in that target's Share dialog. Received Grants can be left. The copy explains that revoking or changing permission ends access immediately and that new edits wait for a secure access update (key rotation).
- **Protocol addition:** on rows the caller owns (outgoing Shares and owned Grants), relationship lists add the recipient's opaque share identifier, so an Owner can tell Collaborators apart. The Owner already supplied that identifier when inviting. Incoming and received rows gain nothing about the Owner.
- **Staging sources:** if share preparation needs the Owner's Comment-capability keys and the share comment-key endpoint does not provide a source, the endpoint returns the Owner's own `vault-recovery` envelope to the Owner, as `grant-provisioning/next` already does.

## Acceptance criteria

- [ ] An Owner can invite an existing Account by share identifier from the workspace, sees the pending Share, and can cancel it or prepare secure access again.
- [ ] Preparation covers every current recipient device and every required Comment capability, is resumable, and survives a lost response without re-sealing envelopes or weakening signatures.
- [x] A recipient sees pending Shares, can accept or decline, and then finds the shared root in the library sidebar without a direct link.
- [x] Owners can change permission or expiry and revoke; Collaborators can leave; the UI explains the resulting secure access update.
- [x] Owner rows show the recipient's share identifier; no Owner identity is added to recipient rows.
- [ ] No share identifier, handle lookup or Grant list ever enters server-rendered HTML; every action stays proof-guarded.
- [ ] Browser coverage drives the whole flow through the UI in Chromium, Firefox and WebKit, and Workers tests cover the list addition and any staging-source change.

## Comments

- 2026-10-12: Maintainer decisions recorded (full flow, share identifier only). This ticket is delivered together with 53's first slices and 57 in one pull request.
- 2026-10-12: Part 1 landed on `issue/58-sharing-management-ui`; **part 2 remains** (the workspace Share dialog, invitation by share identifier from an owned File or folder, legacy File conversion, and resumable **Prepare secure access** staging of Grant and Comment-capability envelopes, plus the staging-source change). Landed: `listRelationships` adds `recipientShareId` on Owner rows only (`app/sharing/sharing.server.ts`); typed, strictly validated relationship client with bounded, advancing pagination (`app/shared/sharing/relationships-client.ts`); explicit Sharing intents (`app/shared/sharing/sharing-intents.ts`); the browser-only **Sharing** page at `/account/sharing` (`app/routes/account-sharing.tsx`, rows in `app/sharing/sharing-management.tsx`, with an `OutgoingShareItem` slot for part 2's Prepare secure access action and a fixed `/account/sharing` form action a dialog can reuse); **Sharing** in the Account menu, Account navigation and Files tree footer; the library sidebar's **Shared with me** section with an "N invitations" link (`app/sharing/shared-with-me.tsx`) over a 60-second, Account-keyed tab-memory summary (`app/shared/sharing/shared-with-me-cache.ts`); `docs/sharing.md` updated. Unticked criteria need part 2: invitation from the workspace, preparation, SSR/proof coverage of the new dialog, and browser coverage without the API invitation helper. Tests: `npx vitest run --config vitest.workers.config.ts tests/worker/sharing.test.ts` 10 passed (new: Owner-row identifier, recipient rows without it, unrelated Account unchanged); `tests/worker/sharing-shell.test.ts` 1 passed (no identifiers, relationship or Account ids in SSR HTML for either side); Node `tests/relationships-client.test.ts` 8 passed, `tests/shared-with-me-cache.test.ts` 6 passed, `tests/sharing-intents.test.ts` 1 passed; `npm run lint` clean; `npm run typecheck` clean; `npm test` Node 47 files / 432 tests passed, Workers 53 files / 388 tests passed; `e2e/sharing-management.spec.ts` 5 passed in each of Chromium, Firefox and WebKit (accept from the sidebar invitation link and open from Shared with me with no extra list request, accept-before-preparation copy then decline, Owner cancel, permission change / expiry set and clear / revoke with recipient losing access, recipient leave); existing `e2e/shared-file.spec.ts` + `e2e/grant-provisioning.spec.ts` 7 passed in each of Chromium, Firefox and WebKit; `key-rotation`, `laboratorio-navigation`, `laboratorio-workspace`, `accessibility`, `provisioning-navigation`, `private-tree-shell` passed in Chromium (27 tests with the two sharing specs).
