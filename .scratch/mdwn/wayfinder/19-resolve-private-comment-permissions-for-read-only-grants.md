# Resolve Private Comment permissions for read-only Grants

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by: 05, 07, 09

## Question

[Sharing & permission model](05-sharing-permission-model.md) says a read-only directory Grant permits reading only, while an individual-file Grant permits Markdown editing only when it is read/write. [Comments model](07-comments-model.md) instead makes the Private Comment thread writable by every active Collaborator, including one with read-only access. [Data model & schema](09-data-model-and-schema.md) must enforce the resulting rule.

Lock one consistent MVP authorization and capability policy:

- Can a Collaborator with a read-only directory Grant or direct File Grant read, create, edit, or hard-delete their own Private Comments? Can they only read?
- If effective access comes from overlapping Grants, how does the strongest effective permission affect Private Comment abilities?
- What do a read-only Collaborator's comment UI and composer show, and which server authorization checks and Comment-thread Key envelopes follow that rule?
- Confirm the File Owner's existing authority to hard-delete any Comment without editing another author's text, and preserve the settled Public Comment rules.

Update the conflicting decision and schema language when this is resolved. Do not reopen Share ownership, Markdown editing permissions, Comment audiences, or Comment format.

## Answer

**Resolution — Private Comment participation follows File-read access.**

A Collaborator with current File-read access from either a read-only directory Grant or a direct File Grant can read the Private thread, create a Comment, and edit or hard-delete their own Comment. This does not grant Markdown or structural edit authority. A File Owner may hard-delete any Private Comment but cannot alter another author’s text. After loss of all applicable Grants, the service denies reads and mutations even to the original author; previously downloaded plaintext or keys remain subject to the established revocation limit.

Overlapping Grants are independent. Private Comment participation is a Boolean derived from any active File-read Grant; the strongest effective permission controls Markdown and structural changes only. Revoking one Grant leaves Comment access in place while another active Grant still permits the File.

The read-only workspace explicitly says **Read-only — you can comment**, retains the normal Private Comment composer, and exposes edit/hard-delete controls only to the Comment’s author. The Owner additionally sees a hard-delete control on every Comment, never an edit control for another author’s text.

The server derives `can_read_private_comments` from current File-read access and requires it plus the current thread epoch for Private-thread reads and creates. Author edits and hard deletions additionally require a matching author Account; an Owner may hard-delete any Comment. The Private-thread capability has Key envelopes for currently authorized Accounts/devices independent of Grant permission; overlapping Grant paths do not provide stronger or duplicate capability authority. Losing the final applicable Grant removes server access and triggers the settled epoch-rotation/re-wrapping process for remaining authorized recipients.

This changes no Public Comment rule or capability boundary; the remaining Collaborators-only Public Comment capability details stay with [Define Collaborators-only Public Comment capabilities](21-define-collaborators-only-public-comment-capabilities.md). The reconciled sharing, Comment, schema, workspace, and glossary language now appears in [Sharing & permission model](05-sharing-permission-model.md), [Comments model](07-comments-model.md), [Data model & schema](09-data-model-and-schema.md), [Lock editor and file interaction behavior](14-lock-editor-and-file-interaction.md), and [`CONTEXT.md`](../../../CONTEXT.md).
