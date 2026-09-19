# Lock editor and file interaction behavior

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by: 07

## Question

Using the selected **Persistent split workspace** baseline from [Navigation & editor UX prototype](10-navigation-and-editor-ux.md), lock the remaining interaction contract needed for a buildable spec:

- What URL shape represents folders and files, and should a deep link restore the selected document and folder expansion?
- Is the editor split view the default, and how do edit/preview toggles work on narrow screens?
- Is saving explicit, autosaved, or both? Define dirty indicators, keyboard shortcuts, tab handling, and the MVP behavior when the same file is open in two tabs or a write conflicts.
- Confirm where sharing and publishing actions live and what each action opens.
- Where do the flat Comment list and authenticated composer appear in the split workspace, and how does the UI distinguish Private from Public audience without exposing one to the other?
- Define browser import/upload behavior: drag-and-drop target, single versus multiple files, folder creation, and name-collision/overwrite policy.

The answer should separate MVP behavior from later polish; it should not redesign the selected layout.

## Answer

**Resolution — responsive Files workspace with coordinated autosave.** The selected Persistent split workspace remains the MVP baseline; this decision specifies its interaction contract rather than introducing a new layout.

### Navigation, terminology, and routes

- **Vault** remains a technical/domain term only. No user-facing UI, browser title, route, or user documentation uses it; the app calls the private root **Files**.
- Private File and Directory routes use opaque identifiers only: `/f/:fileId` and `/d/:directoryId`. They contain no plaintext name, path, or capability material.
- Opening a File route selects that File and expands its ancestor Directories. Opening a Directory route selects that Directory. Other expanded/collapsed branches are a local browser preference, not deep-link state.
- An inaccessible or deleted private target has the same non-revealing not-found treatment as any other inaccessible private object. Public Publication routes remain governed by [Public publish model](06-public-publish-model.md).

### Workspace and responsive behavior

- At wide available widths, the workspace persistently shows the Files tree, breadcrumbs, Markdown editor, and live sanitized preview. There is no second desktop layout for the MVP; exact responsive breakpoints and splitter sizing are visual-tuning details.
- On narrow screens, the tree becomes a drawer and the content area has mutually exclusive **Edit**, **Preview**, and, when available, **Comments** views. It opens in Edit mode; changing views never loses the current in-memory draft.

### Save, tabs, and conflicts

- Editing autosaves after a 750 ms debounce. There is no primary Save button; `Cmd/Ctrl+S` flushes a save immediately. The File header shows **Unsaved**, **Saving**, **Saved**, or **Couldn’t save**. Navigation first attempts to flush a pending save, and closing/reloading warns only while a save remains unsaved or failed.
- MVP drafts exist only in the live browser tab. Persisted drafts, offline editing, and PWA recovery are later work.
- There is no in-app document-tab strip. Same-browser tabs coordinate one editable instance per File: the first editing tab holds the edit lease, and another tab opens read-only. A user may request **Edit here**; the current editor must save or explicitly discard pending work before the lease transfers and it becomes read-only.
- Every save conditionally targets the File revision that supplied the draft. A changed revision—whether from another device, browser, or missed tab-coordination event—stops autosave and opens a conflict state. It preserves the local draft and offers explicit reload/discard, copy-local-draft, or confirmed overwrite choices. MVP has neither silent last-write-wins nor automatic three-way merging, and this does not create user-visible version history.

### Contextual Share and Publish actions

- An Owner sees **Share** and **Publish** beside a selected File title. A selected Directory exposes **Share** in its contextual header/menu. A Collaborator cannot share content it does not own and sees **Request publication** rather than Publish.
- Share opens contextual account-to-account Grant management: address an Account, choose the settled permission, and manage pending and active Grants. Publish opens contextual Publication management: create/copy the Public link, set public attribution and comment audience, and rotate or unpublish. Unpublish requires an irreversible confirmation naming the current Public Comment count and deletion of the link, Public representation, Public thread, and related Public material; the panel shows bounded deletion progress until it completes. These panels preserve the selected workspace context rather than navigating away.

### Comments

- A File-level **Comments** action switches the right-hand preview pane to a flat comment inspector on wide screens. On narrow screens, Comments is the third content view alongside Edit and Preview. The authenticated composer sits at the bottom of the selected thread.
- A read-only Collaborator sees disabled Markdown editing controls and an explicit **Read-only — you can comment** cue. They receive the normal Private-thread composer and author-only edit/hard-delete controls while current File-read access remains; a File Owner also receives hard-delete controls on every Comment, never an edit control for another author’s text.
- Inside the authenticated workspace, **Private** is the default thread. A separate **Public** thread appears only for an active Publication and visibly states whether its audience is public or Collaborators-only. It uses the signed-in File route and device envelopes; it never displays or receives a Public-link fragment. The UI loads and presents the two threads separately.
- A Public reader sees only public audience epochs below the rendered public document, never a Private/Public selector, Collaborators-only ciphertext, or Private-thread content. The opaque Public route receives no fragment; the browser uses it locally. Posting and audience rules follow [Define Collaborators-only Public Comment capabilities](21-define-collaborators-only-public-comment-capabilities.md).

### Browser import

- The Files chrome provides **Import** and drag-and-drop targets eligible Directories. An **Import target** is a Directory the Account owns or reaches through a current read/write Directory Grant; it is initially selected only when the current context is that Directory or a File within it. A direct File Grant never exposes or infers a parent Directory as a target. A drop in any other context is rejected before review with a prompt to choose an eligible Directory. Both paths open a review flow rather than inserting content into the editor.
- MVP accepts one or many UTF-8 Markdown files (`.md` or `.markdown`) and folders. Loose Files import directly into the target Directory; each selected folder becomes a child Directory and preserves its hierarchy. Unsupported inputs are rejected before import.
- The review states when the target is shared: all new nodes will immediately belong to that Directory’s Owner and will not appear in the Collaborator’s **Export my Files**. It creates no Owner approval or notification workflow. A read-only or direct File Grant cannot bypass this target rule.
- Imports never overwrite silently. For a colliding File or Directory, the default is **Keep both** with a deterministic ` (2)`-style rename; the review can choose Skip or explicit Replace per collision or apply a chosen policy to the remaining collisions. In an eligible shared target, Replace is available only for Files the Collaborator’s read/write Directory Grant can edit. Directories do not silently merge.

### Later polish

Persistent/offline drafts, app-level document tabs, automatic three-way merging, and breakpoint/splitter refinements are outside the MVP interaction contract.
