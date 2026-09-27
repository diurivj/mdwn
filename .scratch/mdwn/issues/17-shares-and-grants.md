# 17: Shares and Grants: invite, accept or decline, effective access, permission matrix

**What to build:** An Owner invites an existing Account to read or read/write one Directory subtree or one File by exact handle or opaque identifier, the recipient accepts or declines, and server-side authorization then enforces the full permission matrix — including content a Collaborator creates, which belongs to the Owner.

**Blocked by:** 09 (Device proofs and registry epochs), 14 (Private tree).

**Status:** ready-for-agent

- [ ] A Share targets either one Directory or one File and proposes `read_only` or `read_write`; it addresses an existing Account by its unique exact-match handle or opaque share identifier, with no Account directory or fuzzy discovery.
- [ ] A pending Share is unique per Owner, recipient, and target; the Owner may cancel it, the recipient may accept or decline it, and acceptance creates one active Grant per Owner, recipient, and target.
- [ ] A Directory Grant covers the current subtree and future descendants; a direct File Grant follows File identity through Owner-controlled rename and move and exposes no path, parent, siblings, or neighbouring tree content.
- [ ] Direct File read/write permits Markdown edits only — never rename, move, delete, import targeting, or structural access.
- [ ] Every row of the permission matrix is enforced server-side: read private File/metadata in scope, edit Markdown, create a child File/Directory, rename/reorder/delete/move, use a Directory as an Import target, read/create Private Comments, edit/delete one's own Private Comment, hard-delete another author's Comment, manage Shares, manage a Publication, request a Publication, read Collaborators-only Public Comments, read and post public-audience Public Comments, and export (owned Files only).
- [ ] Effective File access is the union of active direct and inherited Grants, derived by a bounded indexed recursive CTE over ancestor Directories plus exact direct File Grants; the strongest permission controls Markdown and structural authority, while `can_read_private_comments` and `can_read_collaborators_public_comments` are independent Booleans.
- [ ] Overlapping Grants remain independent and are deduplicated when deriving effective authority, so revoking one Grant cannot remove access supplied by another; the Owner may change permission or revoke and a Collaborator may leave.
- [ ] Content a Directory read/write Collaborator creates manually or through Import belongs immediately to the target Directory's Owner, with no approval workflow, no new Share or Grant, and no ownership transfer; the initiator keeps access through the existing Directory Grant.
- [ ] Cancelled or declined Shares and revoked Grants are hard-deleted after any bounded security retention, and the MVP keeps no historical sharing-audit log.
- [ ] Tests cover the full matrix including read-only Private Comment participation and direct-File structural denial, overlapping-Grant union and independent revocation, and reviewed `EXPLAIN QUERY PLAN` output for the effective-access query.

## Comments

- Approved, **not yet implemented**, protocol amendment: [ADR-0008](../../../docs/adr/0008-file-scoped-receiving-keys-and-signed-file-heads.md) and [spec §4.3](../../../docs/buildable-spec.md#43-key-envelopes-and-revocation). Direct File read/write acceptance must wait for a write-authorized parent-capability browser to atomically migrate a v1 File's complete-entry commitment to listing v2 and its signed File head under structural and File revision guards; SQL cannot do it, and a later direct editor must never need the Owner online or receive parent ID/path/capability, siblings, or a Directory-wide target. This is a dependency for direct-write sharing, not a checked acceptance item.
