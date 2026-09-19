# 21: Private Comment threads

**What to build:** Anyone with current File-read access reads and writes plain-text Private Comments on a File, under the author/Owner rules, with bodies and displayed pseudonyms decrypted only in the browser.

**Blocked by:** 04 (Vault key hierarchy, recovery secret, and capsule), 17 (Shares and Grants).

**Status:** ready-for-agent

- [ ] Exactly one Private Comment thread exists per File; schema and migrations cover `comment_threads`, `comment_thread_epochs` (with the Private thread's current key epoch in a constrained representation), `comments`, and `thread_attributions`.
- [ ] Every Private Comment thread has a capability enveloped to the Owner and to every currently authorized device with effective File-read access; participation depends only on current File-read access, not on read/write strength.
- [ ] Comments attach to stable File identity only and form one flat ordered list: no replies, resolution/archive, reactions, attachments, mentions, embeds, or rich Markdown.
- [ ] A Comment is plain text with line breaks, at most 2,000 characters; HTML and Markdown are never interpreted.
- [ ] Every Comment displays the author's Public pseudonym; bodies and pseudonyms are ciphertext at the service boundary, and no Comment table stores plaintext or moderation-searchable text.
- [ ] Authors may edit or hard-delete their own Comments only while they retain current thread access; the Owner may hard-delete any Comment but may never edit another author's body; there is no edit history or restore.
- [ ] A read-only Collaborator sees **Read-only — you can comment** and keeps the normal Private composer.
- [ ] UI: wide layouts switch the right preview pane to the Comment inspector; narrow layouts use the Comments content view; the authenticated composer sits at the bottom of the selected thread; **Private** is the default authenticated thread; the Private and Public threads load through separate endpoints and are never combined.
- [ ] A device that loses its last File-read path immediately loses thread authorization, and no thread ciphertext is served to it afterwards.
- [ ] Tests enforce the mutation rules server-side (author identity, Owner hard-delete exception, epoch and access checks), prove read-only participation, and prove a revoked device receives no thread material.
