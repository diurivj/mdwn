# Public publish model

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by: 05, 13

## Question

Design per-file **public publish** (the second, separate sharing mechanism):

- What does a published file's URL look like — random unguessable slug, readable slug from the title, or both?
- Is publishing per-file only, or can a directory be published? (Assumption: per-file only for MVP; directory publishing is a later sibling of this question.)
- Revocation: does unpublishing break the link immediately, and what does a visitor see?
- Anonymous access: what exactly is rendered, is it indexable by search engines, and does it carry identifying metadata?
- Interaction with the privacy model (`01`): if content is end-to-end encrypted, how does an anonymous reader's browser get the key? (The obvious answer is a URL fragment; confirm it.)
- Are comments allowed on published files? (Comments are MVP; see `07`.)

## Answer

**Resolution — Owner-controlled live publications with pseudonymous public participation.** A **Publication** is a deliberate, Owner-controlled public exposure of exactly one file. It is independent of account-to-account Shares and never grants Markdown edit access.

### Lifecycle and approval

- The Owner may publish, rotate, or irreversibly unpublish a File’s Publication without approval. Unpublishing follows [Define Collaborators-only Public Comment capabilities](21-define-collaborators-only-public-comment-capabilities.md): it seals Public routes before tearing down Public material and never changes File ownership. An active Collaborator with access may request publication; the request creates no link until the Owner approves it.
- There is at most one pending request per Collaborator and file. Requests are visible in the app, and the Owner may approve or deny them while the requester may cancel them. The MVP has no email notification for requests.
- There is one active Publication per file. It follows the file through rename and move and reflects the latest saved representation, including Collaborator edits. Deleting the file revokes its Publication.

### URL and public reader

- The URL contains a high-entropy opaque Publication identifier in its path and a versioned read-only decryption capability in its URL fragment. It contains no title, filename, account identifier, or readable slug. The fragment is never sent to the service.
- Rotation creates a new Publication identifier and capability and immediately invalidates the old link. Publications do not expire automatically; the Owner explicitly unpublishes or rotates them.
- The public reader receives only the current file representation. The browser decrypts it and renders sanitized GFM, including the file title when present, but not raw front matter, vault paths, breadcrumbs, user-authored timestamps, or Owner identity. There is no public version history or server-side plaintext rendering.
- Public pages are non-indexed (`noindex`, `nofollow`, and `noarchive`) in the MVP and use no analytics, third-party scripts, or nonessential cookies. New requests to an unpublished or rotated link return an indistinguishable `404` without ciphertext and must not serve stale content. Plaintext or keys already downloaded by a reader cannot be recalled.

### Author attribution

- Public author attribution is off by default and is controlled per Publication by the Owner. When enabled, the Owner selects Accounts whose public pseudonyms appear as the authors; no author list is inferred from edit activity.
- Every Account has a generated account-level public pseudonym, separate from its share-addressing identifier and authentication identity. It is stable by default, may be changed no more than once per 30 days, and changing it updates existing public comments and author attributions. A pseudonym is public but non-identifying; cached copies and screenshots cannot be changed.

### Comments

- A newly published File defaults to a **public comments** audience. Anyone with the complete Public link may read its separately encrypted public audience epochs, but posting requires a signed-in Account; anonymous posting is not allowed. The Public link remains read-only for Markdown, and comment posting is a separate authorization.
- The Owner may switch the Publication to **Collaborators only**. In that mode, only the Owner and active Collaborators may read or post; public readers receive a sign-in notice such as “Sign in to see or add comments if you have access to this file.” Signing in alone never creates a Share. Each audience change begins a new encrypted epoch, so a later public audience never exposes Comments made while Collaborators-only.
- Existing Private Collaborator Comments are never exposed automatically when a File is published. Public Comment capability, device provisioning, audience epochs, and the authenticated/public-reader boundary follow [Define Collaborators-only Public Comment capabilities](21-define-collaborators-only-public-comment-capabilities.md).

This resolution inherits the browser-only cryptographic boundary and URL-fragment capability model from [Define encrypted-content and capability model](13-define-encrypted-content-capability-model.md) and the account-sharing boundary from [Sharing & permission model](05-sharing-permission-model.md).
