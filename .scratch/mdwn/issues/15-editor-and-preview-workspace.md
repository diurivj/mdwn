# 15: Editor and preview workspace: saving, conflicts, and the File source limit

**What to build:** A person edits Markdown in a persistent split editor/preview workspace, sees sanitized GFM live, and trusts that autosave either commits their draft or tells them plainly that it could not — never truncating, merging, or silently overwriting.

**Blocked by:** 14 (Private tree).

**Status:** done

- [x] Wide layouts persistently show the Files tree, breadcrumbs, Markdown editor, and live sanitized preview; narrow layouts use a tree drawer and mutually exclusive **Edit**, **Preview**, and (once ticket 21 exists) **Comments** views. A File opens in Edit, and switching views never loses the in-memory draft. There is no alternate desktop layout and no in-app document-tab strip.
- [x] Markdown rendering happens in the browser with `react-markdown`, `remark-gfm`, and conservative `rehype-sanitize`; arbitrary raw HTML and `rehype-raw` are not enabled.
- [x] Editing autosaves after a 750 ms debounce with no primary Save button; `Cmd/Ctrl+S` immediately flushes a pending save; the File header displays **Unsaved**, **Saving**, **Saved**, or **Couldn't save**; navigation first tries to flush a pending save; a close/reload warning appears only while a save is pending, unsaved, or failed; drafts live only in the current browser tab.
- [x] Every save supplies the revision that produced the draft. A stale revision stops autosave, preserves the local draft, and presents reload and discard, copy local draft, or explicitly confirm overwrite; there is no automatic merge and no silent last-write-wins.
- [x] File save is one conditional operation: it checks current effective write authority and the expected File revision, validates every submitted private (and, once ticket 22 exists, Public) representation payload before inserting a fresh private representation and content-key identity, replaces the parent-entry envelope and every active direct-Grant envelope for the fresh File key, conditionally swaps current pointers and revision, and removes the superseded representation once unreferenced. A malformed, oversize, or stale save leaves no new pointer, revision, or partial update.
- [x] The browser measures Markdown source as at most 262,144 UTF-8 bytes before encryption and again after decryption, shows `bytes / 262,144` from 235,930 bytes (90%), and announces **File limit reached** at the limit. A keystroke, composition result, paste, or conflict-overwrite proposal that would exceed the limit is rejected as one whole edit, never truncated, and the previously valid in-memory draft stays intact with no save attempt.
- [x] A locally held oversized legacy File or conflict draft shows **Couldn't save** with copy/download, reload/discard, and reduce-content choices; navigation and reload keep warning while it is unsaved or failed; the File remains readable and exportable but cannot save or confirm a conflict overwrite until reduced within the limit.
- [x] Same-browser tabs coordinate one editing lease per File: the first editing tab owns it, another tab opens read-only, **Edit here** requests a transfer, the current owner must save or explicitly discard pending work first, and the prior owner then becomes read-only.
- [x] Tests cover byte-exact limits including multi-byte UTF-8, 90% feedback, typing/composition/paste rejection without draft loss, `Cmd/Ctrl+S`, navigation warnings, legacy reduction, conflict overwrite, and a stale save that preserves the draft without mutating current state.

## Comments

- 2026-09-30: Implemented on `feat/15-editor-preview-workspace`. The full local suite passed (80 Node, 108 Worker, 210 browser); post-review regression checks passed (21 Worker and 36 browser across Chromium, Firefox, and WebKit), with typecheck and secret checks green. Review corrected composition rejection so an already-valid pending draft resumes autosave. Merge still requires green PR CI.
- The current dependency stage has owned Files but no Grant or Publication tables. Saves rotate the private representation/key and signed parent listing atomically. Tickets 17–18 must extend effective write authority and active direct-Grant envelopes before collaborator saves are enabled; ticket 22 must add paired Public representation updates.
