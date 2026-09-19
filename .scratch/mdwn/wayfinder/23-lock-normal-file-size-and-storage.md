# Lock normal File size and representation storage

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by: 08, 09, 13, 14, 18

## Question

The settled import contract caps imported Markdown at 256 KiB per File, but ordinary create/edit/paste/autosave has no size envelope. The current schema stores one encrypted current File representation while D1 has a finite row/BLOB and request envelope. An implementation cannot safely choose an unlimited single-row File, a user-visible cap, or chunked representations without changing product and persistence behavior.

Lock the normal File storage contract:

- Choose a maximum UTF-8 Markdown-source size for normal Files, or choose a bounded chunked current-representation design. Account for ciphertext/envelope overhead and the selected Workers + D1 Free constraints.
- Decide whether the import per-File cap is the same limit or only a stricter import guardrail, and define Replace behavior when an existing File is near or above the chosen normal limit.
- Define browser/editor behavior as a draft approaches or exceeds the limit, including autosave status, `Cmd/Ctrl+S`, paste, conflict overwrite, navigation warnings, and actionable errors without draft loss.
- Preserve the conditional-save contract and the requirement that an active Publication's private and Public representations update together. If chunking is selected, define revision, manifest, atomic visibility, cleanup, export, and hard-deletion boundaries.
- Specify the schema/index changes and acceptance tests needed to prove the selected envelope on Workers Free + D1.

Do not reopen browser-only encryption, lack of version history, import atomicity, or the selected stack.

## Answer

**Resolution — bounded single-representation Files.** A **Current File representation** remains one encrypted private payload; an active Publication has one separate encrypted Public representation. mdwn does not chunk normal Files in the MVP.

### Limits and persistence

- Markdown source for every File is at most **262,144 UTF-8 bytes (256 KiB)** before encryption. The same limit applies to creates, edits, pastes, imports, and import Replace candidates; import is not a stricter per-File guardrail.
- Each decoded binary encrypted representation payload, including its `mdwn/enc-v1` framing and encrypted File metadata, is at most **524,288 bytes (512 KiB)**. D1 stores the decoded BLOB, not a base64 string. This leaves a deliberately large margin below D1's documented 2,000,000-byte row/string/BLOB ceiling: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
- Browser clients measure source bytes before encryption and after decryption; they reject an otherwise well-formed representation whose Markdown exceeds the source limit. The Worker independently rejects an oversized decoded encrypted payload, so a nonconforming client cannot consume an unbounded D1 row.
- Keep the existing `file_representations.ciphertext_size` (and the equivalent Public representation size) derived from the stored BLOB. Add a `NOT NULL` database constraint over the actual BLOB length (`length(ciphertext) <= 524288`) for both representation tables, plus matching Worker validation. This requires no chunk/manifest tables, new indexes, or client-reported plaintext-size metadata.
- A normal save still inserts the new representation(s), conditionally swaps the current private pointer/revision, refreshes required current envelopes, and removes superseded data. If a File has an active Publication, the private and Public representations must both validate and swap in that same conditional transaction; failure leaves both old pointers and revisions current.

### Editor, Replace, and recovery behavior

- The editor shows `bytes / 262,144` from **235,930 bytes (90%)** onward. At the limit it announces **File limit reached**. A keystroke, composition result, paste, or conflict-overwrite proposal that would exceed the limit is rejected as one whole edit, never truncated; the previously valid in-memory draft remains intact.
- Valid drafts retain the settled 750 ms autosave and `Cmd/Ctrl+S` immediate flush behavior. A rejected prospective edit creates no save attempt. A locally held oversized legacy or conflict draft shows **Couldn’t save** and actionable copy/download, reload/discard, and reduce-content choices; navigation or reload warns while it remains unsaved or failed.
- A legacy oversized File is readable, exportable, and reducible in the browser, but cannot save or confirm a conflict overwrite until its local source is within the limit. A preflighted import Replace with a within-limit candidate is allowed even for such a File; it replaces the current representation while retaining the existing File identity, Comment threads, and active Publication. An over-limit candidate changes nothing.

### Proof obligations

- Browser tests cover byte-exact limits (including multi-byte UTF-8), 90% feedback, typing/composition/paste rejection without draft loss, `Cmd/Ctrl+S`, navigation warnings, legacy reduction, conflict overwrite, and import Replace.
- Schema/Worker tests prove the 512 KiB BLOB bound and that malformed, oversize, or stale saves leave no new current pointer, revision, or partial private/Public update.
- A disposable remote **Workers Free + D1** deployment is a release gate whenever encryption-persistence schema changes and for release candidates (not necessarily every pull request). It proves exact-limit create/save/Replace/import behavior, one-byte excess rejection, active-Publication paired updates, stale-conflict preservation, and the D1 constraint using the deployed runtime.
