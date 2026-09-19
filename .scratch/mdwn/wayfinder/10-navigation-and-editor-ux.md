# Navigation & editor UX prototype

Type: prototype
Status: resolved
Assignee: diurivj
Blocked by:

## Question

Raise the fidelity of the core interaction so it can be reacted to, not described:

- File-tree navigation: sidebar tree, breadcrumbs, and the URL scheme for folders/files.
- The editor: split pane vs toggle preview, autosave vs explicit save, conflict/tab handling, keyboard shortcuts.
- Where sharing and publishing actions live in the UI.
- Upload: drag-and-drop into a folder, single vs multiple files, overwrite behaviour.

Deliver a rough, throwaway prototype (wireframe or static/local mock) linked from this issue. Don't build the product.

## Prototype

The full three-variant prototype is captured on throwaway branch `prototype/navigation-editor-ux` at commit `9f2301b`. Inspect it with `git show prototype/navigation-editor-ux:.scratch/mdwn/prototype/navigation-editor-ux.html`; append `?variant=a`, `?variant=b`, or `?variant=c` when opening the extracted file. The fixed switcher also responds to the left/right arrow keys.

## Answer

**Resolution — Variant A selected as the baseline.** Human review preferred the **Persistent split workspace**: a persistent vault tree with breadcrumbs, editor and preview visible together, Import/Export in the vault chrome, and Share/Publish beside the document title. The artifact remains a throwaway design reference, not production code.

The exact URL, save/conflict/shortcut, and upload/collision contract was deliberately not guessed from “with some tweaks”; it is captured in [Lock editor and file interaction behavior](14-lock-editor-and-file-interaction.md).
