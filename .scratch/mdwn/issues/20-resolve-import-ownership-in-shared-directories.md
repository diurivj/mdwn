# Resolve import ownership in shared Directories

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by: 05, 09, 11, 14, 18

## Question

[Lock editor and file interaction behavior](14-lock-editor-and-file-interaction.md) allows browser import to target the Files tree or a selected Directory. [Import/export format & flow](11-import-export.md) says every imported item becomes newly owned content of the importing Account. But [Sharing & permission model](05-sharing-permission-model.md) says a shared Directory Owner owns every descendant created by a Collaborator, while [Data model & schema](09-data-model-and-schema.md) requires same-owner containment and rejects cross-owner moves.

Lock the MVP rule for import into shared content:

- May a Collaborator import into a read/write shared Directory? If not, specify the target restriction and review/UI behavior.
- If it is allowed, which Account owns the new descendants, and how does that reconcile with same-owner containment, the Owner-controlled hierarchy, browser-export ownership, encryption envelopes, and later revocation?
- Does the rule differ for a direct File Grant, read-only Grant, nested owned Directory, or a Directory reachable through overlapping Grants?
- Preserve the settled review-first, all-or-nothing, collision, and Free-tier visible-atomic import contracts from [Lock import operational bounds](18-lock-import-operational-bounds.md).

Amend the conflicting sharing, import, interaction, and schema language on resolution. Do not broaden import into filesystem sync or reopen the archive format and operational bounds.

## Answer

**Resolution — immediate target-owner imports.** An Import is a batch form of creating content in its target Directory, not a transfer of the local source’s ownership or authority.

### Authority and ownership

- An **Import target** is a Directory the initiating Account owns or reaches through an active read/write Directory Grant. The server checks that authority both when staging begins and when it commits.
- When the target is owned by the initiating Account, it owns every created descendant. When a Collaborator imports through a read/write Directory Grant, every new File and Directory receives the target Directory Owner’s ownership. The contribution appears immediately: there is no Owner approval or notification workflow.
- A read-only Directory Grant and any direct File Grant—including read/write—never authorize an Import target. The app does not infer a parent Directory from a direct File Grant. Overlapping Grants allow an Import only when at least one active Grant provides read/write Directory access.
- An explicit collision **Replace** remains an edit of the existing File and is available to a Collaborator only inside an eligible read/write Directory target. It does not turn a direct File Grant into an Import target.

### User, cryptographic, and lifecycle contract

- Before confirmation, the review says that a shared target’s new nodes belong to its Owner and will not appear in the Collaborator’s **Export my Files**. Browser preflight, collision choices, Free-tier limits, private staging, and atomic visibility remain unchanged.
- The importing browser uses the target Directory capability to wrap each new child capability or File content key. This creates no new Share, Grant, special Owner envelope, or Publication authority; the Owner already reaches the new descendants through the target Directory capability.
- The fresh Private Comment thread follows current File-read access, while imported historical Comment data never restores former author authority. After commit, the imported subtree follows ordinary containment-based sharing and Key rotation. Grant revocation, a stale target, or changed target Owner causes no committed marker and exposes no partial tree.

This reconciles [Sharing & permission model](05-sharing-permission-model.md), [Import/export format & flow](11-import-export.md), [Lock editor and file interaction behavior](14-lock-editor-and-file-interaction.md), [Data model & schema](09-data-model-and-schema.md), and [Lock import operational bounds](18-lock-import-operational-bounds.md), plus the related glossary and ADRs.
