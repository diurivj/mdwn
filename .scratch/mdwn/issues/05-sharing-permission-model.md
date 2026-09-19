# Sharing & permission model

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by: 13

## Question

Design the account-to-account sharing mechanism (distinct from public publish links):

- A share grants an account access to a **directory**. Is it read-only or read/write? (Working assumption: read/write, since a shared diet plan is edited by both.)
- Is sharing **recursive** to the whole subtree, and does it include files added later?
- Can a share be per-file as well as per-directory?
- Who owns content created inside a shared directory? What happens on move/rename out of a shared subtree?
- Can a collaborator re-share? Can the owner revoke, and what happens to content at revoke time?
- Write the canonical domain terms (owner, collaborator, share, grant) into `CONTEXT.md`.

## Answer

**Resolution — Owner-controlled hierarchical and file sharing.** An Owner may create two independent kinds of account-to-account Share: a directory Share and an individual-file Share. Collaborators cannot reshare content they do not own.

A directory Share recursively grants access to the existing subtree and automatically picks up descendants added later. Access follows current containment: when the Owner moves content into the shared subtree, its collaborators gain access; when content moves out, directory-derived access ends. Collaborators may not delete the shared root or move content outside the subtree. A directory read/write Grant permits creating, editing, renaming, moving, and deleting files and subdirectories inside the subtree; read-only permits reading File and Directory content but no Markdown or structural changes. Regardless of Markdown permission, current File-read access permits the separate Private Comment actions settled in [Resolve Private Comment permissions for read-only Grants](19-resolve-private-comment-permissions-for-read-only-grants.md).

An individual-file Share grants access only to that file. It follows the file identity through renames and moves within the Owner’s Vault and exposes no parent directory, neighboring content, or unrelated path information. Its read/write permission allows editing the file’s Markdown content, but not renaming, moving, or deleting the file. Whether read-only or read/write, a direct File Grant also permits the separate Private Comment actions settled in [Resolve Private Comment permissions for read-only Grants](19-resolve-private-comment-permissions-for-read-only-grants.md).

The Owner of a shared Directory owns every descendant, including Files and Directories a Collaborator creates manually or through a confirmed import into a Directory covered by their current read/write Grant. That import is immediate—no Owner approval—and does not transfer ownership to its initiator. Editing or sharing never transfers ownership, and cross-owner moves are disallowed in the MVP. The Owner may share descendant directories or files independently, including objects inside an already shared subtree.

A Share addresses an existing Account by unique handle or opaque identifier and remains pending until the recipient accepts it. Pending Shares can be canceled or declined. An accepted Grant persists until the Owner revokes it or the Collaborator leaves; the Owner may change its permission. There is one persistent Grant per Owner, recipient, and target.

Overlapping Grants are independent. Effective access is the union of active Grants, with the strongest permission applying. Revoking a directory Share therefore does not remove an independent file Share, and revoking a file Share does not remove access supplied by a directory Share. Revocation blocks future server-mediated access, advances the relevant key epoch, and rewraps current keys for remaining authorized Accounts; plaintext or keys already downloaded cannot be recalled.

The canonical terms **Owner**, **Collaborator**, **Share**, and **Grant** are recorded in [`CONTEXT.md`](../../../CONTEXT.md). The deliberate boundary is recorded in [Owner-controlled sharing boundaries](../../../docs/adr/0004-owner-controlled-sharing.md).
