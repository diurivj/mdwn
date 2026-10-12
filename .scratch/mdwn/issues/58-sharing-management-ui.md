# 58: Sharing management UI: invite, accept and manage Collaborators

**What to build:** Let people actually collaborate. The Share/Grant protocol is complete on the server and in the browser libraries (tickets 17–20 and 23), but nothing in the product lets an Owner invite someone, lets a Collaborator accept, or lets either side see or end the relationship. Today a Collaborator can open shared content only through a direct `/d/:id` or `/f/:id` link once a Grant already exists, and the browser suite creates every Share through the API.

**Type:** feature

**Status:** needs-triage

**Blocked by:** none.

**Related:** [`docs/sharing.md`](../../../docs/sharing.md) ("A sharing-management panel is not implemented by this slice"); [`docs/shared-provisioning.md`](../../../docs/shared-provisioning.md); [ADR-0004](../../../docs/adr/0004-owner-controlled-sharing.md); [56: pre-launch polish](56-pre-launch-polish.md), where the maintainer asked whether Collaborators were implemented.

## What exists

- `PUT /api/private/shares` invites an exact Account by opaque share identifier or exact handle, with a permission; accept, decline and cancel endpoints exist; Grants can be listed, have their permission or expiry changed, be revoked, or be left. Revocation and permission changes seal writes and hand off to resumable key rotation.
- Owner devices stage per-device HPKE Grant envelopes before acceptance; new and replacement recipient devices are provisioned automatically (`grant-provisioning/next`) or from **Shared access**.
- The workspace opens a received Grant root, enforces read-only versus read/write, shows Collaborators' Comments with their Public pseudonyms, and lets Collaborators request a Publication from the Owner.

## Decisions needed before building

- **Addressing:** where an Account sees and copies its own opaque share identifier, and whether share handles (exact, case-insensitive, 3–32 characters) get an editor now.
- **Invitation flow:** a Share dialog on a File or folder (target, recipient identifier/handle, read-only or read/write, optional expiry), and how the Owner's browser stages Grant envelopes for every current recipient device before acceptance can succeed (acceptance requires complete current coverage).
- **Inbox:** where pending incoming Shares appear (Account menu badge, library sidebar, Shared access page) and the accept/decline confirmation.
- **Shared with me:** how received Grant roots appear in the library sidebar, instead of requiring a direct link.
- **Management:** outgoing Shares (cancel) and active Grants (permission, expiry, revoke, leave), including copy that explains write seals and key rotation after revocation.

## Acceptance criteria (draft)

- [ ] An Owner can invite an existing Account by share identifier or handle from the workspace, and see and cancel the pending Share.
- [ ] A recipient sees pending Shares, can accept or decline, and then finds the shared root in the library without a direct link.
- [ ] Owners can change permission or expiry and revoke; Collaborators can leave; the UI explains the resulting secure access update.
- [ ] No share identifier, handle lookup or Grant list ever enters server-rendered HTML; every action stays proof-guarded.
- [ ] Browser coverage drives the whole flow through the UI in Chromium, Firefox and WebKit.

## Comments
