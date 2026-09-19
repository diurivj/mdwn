# Import/export format & flow

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by: 07, 13

## Question

Import/export is a **browser** feature of the app (not filesystem sync):

- What format exports a vault: a `.zip` of `.md` files mirroring the folder tree, a single JSON bundle, or both? Does front-matter or metadata come along?
- What does import accept, and how are name collisions and folder-depth handled?
- Is export the whole vault only, or per-folder/file?
- How does the privacy model (`01`) apply — if encrypted, must export be decrypted client-side?
- Does this double as the data-ownership guarantee from the privacy model?
- Do Private comment threads export with their File, and are Public comment threads omitted from vault export/import?

## Answer

**Resolution — owned-data, Markdown-first browser archive.**

### Export boundary and granularity

- Export is a browser-only operation: the browser decrypts the Account's content locally and creates the download without sending plaintext to the service.
- **Export my Files** exports all Files owned by the current Account. A selected File or Directory can also be exported, but only if the current Account owns it. Content accessible only through a Share is never included, even as a static copy.
- An export transfers content, not authority. It never carries Shares, Grants, encryption capabilities or keys, credentials, recovery material, sessions, local drafts, internal service IDs, or Publication state.

### Archive and import format

- The one portable format is a browser-generated `.zip`, not a JSON-only backup. It mirrors the selected directory hierarchy and stores each exact UTF-8 Markdown source as `.md`; YAML front matter remains part of that source and is neither interpreted nor rewritten.
- A versioned `.mdwn/manifest.json` identifies the archive format and its roots for mdwn round-tripping. It contains no live account, cryptographic, or collaboration authority.
- Import accepts a recognized mdwn archive as well as the previously settled loose `.md`/`.markdown` files and folders. An import creates new content in its **Import target**: the importing Account owns descendants created in its own Directory, while a confirmed import by a Collaborator with a current read/write Directory Grant creates descendants owned by that target Directory’s Owner. It is an immediate contribution into the Owner’s hierarchy, not an ownership transfer or recreated Share.
- A read-only Grant and a direct File Grant—including a read/write File Grant—never authorize an Import target. Overlapping Grants authorize an Import target only when their effective Directory access is read/write.

### Comment and replacement behavior

- A Private comment thread for an exported owned File is represented in a separate `.mdwn/private-comments.json` sidecar. It preserves the text, ordering, timestamp, and displayed Public pseudonym as historical data; importing creates a fresh Private thread rather than reconnecting the former authors' editing authority.
- Public comment threads, Public links, and other Publication data are omitted from both export and import.
- An explicit **Replace** collision choice updates the existing File's current representation, so its existing Private/Public comment threads and any active Publication retain their normal lifecycle. A Collaborator may choose Replace only for a File in their eligible read/write Directory Import target; a direct File Grant remains an editor permission, not an Import target. Replace is not a new File or a thread migration.

### Preflighted import

- The browser reviews and validates the whole selected input before writing. Unsupported, malformed, or over-limit input produces an actionable error and creates no Files; the MVP does not import a valid subset or leave a partial hierarchy.
- Hierarchy preservation and collision choices remain the contract set by [Lock editor and file interaction behavior](14-lock-editor-and-file-interaction.md): no silent overwrite or directory merge; users can keep both, skip, or explicitly replace.
- Exact maximum nodes, Directory depth, source bytes, and archive bytes are delegated to [Research: D1-backed encrypted import envelope](17-research-d1-import-envelope.md), then [Lock import operational bounds](18-lock-import-operational-bounds.md). The limit is a tested safety guardrail for a free/cheap encrypted system, not an intended obstacle to ordinary Markdown imports.
