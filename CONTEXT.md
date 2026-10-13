# mdwn

mdwn is a private markdown-vault application for people who write, browse, share, and selectively publish Markdown.

## Language

**Account**:
A person’s authenticated identity in mdwn, distinct from any device or passkey. Every Account has a self-chosen, changeable Public pseudonym for public attribution and comments, an opaque share identifier for direct sharing, and may have an optional unique share handle. None is an authentication identity.
_Avoid_: User profile, login, email address

**Passkey**:
A public-key credential an Account uses to authenticate; its private key remains with the user’s authenticator or its trusted sync provider. An Account may have multiple passkeys.
_Avoid_: Password, device identity

**Recovery code**:
A single-use offline secret that can restore access to an Account when its passkeys are unavailable.
_Avoid_: Backup password, content key

**Proof-of-work challenge**:
A short-lived browser calculation required to complete a registration attempt, intended to make mass account creation more costly without identifying the person.
_Avoid_: CAPTCHA, Account identity, credential

**Vault recovery secret**:
A 256-bit browser-generated offline secret, represented as a checksum-protected 24-word recovery phrase. Only alongside a recently Passkey-verified normal Account Session, it restores cryptographic access to an Account’s own Vault and authorizes Recovery enrollment of a replacement Encryption device. It is not an authentication factor, never reaches the service, and rotates after recovery or explicit reissue.
_Avoid_: Recovery code, passkey

**Recovery enrollment**:
A one-time browser-local process that uses a recently Passkey-verified normal Account Session and a Vault recovery secret to approve a fresh Encryption device. A Recovery capsule lets the browser sign a one-use enrollment statement bound to that device’s exact public keys, without revealing the secret to the service. It atomically revokes prior Encryption devices and rotates recovery material; it does not authenticate an Account.
_Avoid_: Account recovery, password reset

**Routine device enrollment**:
A QR-mediated approval ceremony that adds a fresh Encryption device without replacing other active devices. It begins after fresh Passkey authentication on both the candidate and approving device; it is distinct from Recovery enrollment.
_Avoid_: Account recovery, password reset, sign-in

**Bind-on-sign-in**:
A Session-binding rule in which a normal Session created by a fresh Passkey assertion becomes bound to an already-active Encryption device when the same browser proves possession of that device. It activates no device and changes no Device registry epoch; it is distinct from Routine device enrollment.
_Avoid_: Device enrollment, login

**Recovery capsule**:
A service-stored opaque Key envelope that only a browser holding the current Vault recovery secret can open. It carries the Account’s Vault root key and recovery-enrollment signing authority; the service retains its ciphertext, generation, and public verification key but never the secret or plaintext keys.
_Avoid_: Password verifier, service-side backup

**Encryption device**:
A browser holding an Account-specific transport key pair and device-assertion key pair. Multiple active Encryption devices may coexist; only one that is active in the current Device registry may retrieve or change private Vault material. A revoked device cannot regain that authority without Routine device enrollment or Recovery enrollment. An Account's first Encryption device is created by the signup ceremony rather than approved by another device, and is the Device registry's trust anchor.
_Avoid_: Passkey, Account, browser session

**Device registry**:
An Account’s current authorized set of Encryption devices. Its monotonic epoch changes when a device is added, removed, or replaced through Recovery enrollment, so stale device authority fails closed.
_Avoid_: Browser inventory, device fingerprint

**Device proof**:
A short-lived signature from an active Encryption device, bound to its Session, a private operation, and the current Device registry epoch. It proves device possession for private operations and is distinct from a Passkey assertion.
_Avoid_: Session cookie, passkey assertion

**Device label**:
An optional person-chosen, encrypted label for recognizing an Encryption device. It is not a browser, operating-system, network, or fingerprint record.
_Avoid_: Device fingerprint, user agent

**Shared-content provisioning**:
The end-to-end creation of a current Grant Key envelope for an active recipient Encryption device. A recovered device receives no Grant keys from Vault recovery and waits for the content Owner’s active device to provision them.
_Avoid_: Share transfer, service-side key recovery

**Session**:
A time-limited, revocable authenticated access grant between a browser and an Account. An unprovisioned normal Session may complete enrollment but cannot access private material; a private-capable normal Session is bound to one active Encryption device and requires its Device proof. Recovery enrollment requires a recent Passkey assertion, revokes every other Session on success, and gives the recovering browser a fresh Session.
_Avoid_: Login, credential

**Network bucket**:
A short-lived, purpose-specific anti-abuse counter derived from a connecting network. It is pseudonymous operational data, not an Account identity, and never retains the raw network address.
_Avoid_: IP profile, anonymous identifier

**Security event**:
A bounded record of an abuse or security decision, containing only the metadata necessary to enforce or correct it and never content, browser capabilities, or direct request identifiers.
_Avoid_: Audit trail, analytics event, request log

**Public reader**:
A person who views a file through a Public link without authenticating as an Account.
_Avoid_: Guest account, anonymous user account

**Public-participation suspension**:
A temporary service restriction on an Account's ability to create public Comments or create or rotate Publications for technical abuse. It preserves the Account's private Files, Shares, export, recovery, and ownership; it is not content moderation or account deletion.
_Avoid_: Vault lockout, content-based ban

**Public Comment report**:
A signed-in Account's category-only signal naming an opaque Public Comment ID. It carries no plaintext and grants no content access, expires after 30 days, and is never evidence the service can read; it is a pattern signal the operator may weigh, not a deletion or a verdict.
_Avoid_: Moderation queue, complaint text, content takedown

**Public pseudonym**:
An account-level label its person chooses, or keeps from a suggestion, used for public attribution and in every Comment thread. It is pseudonymous rather than private, is not unique, is separate from share-addressing identity, and may be changed subject to a cooldown.
_Avoid_: Real name, anonymous commenter, share identifier

**Owner**:
The Account that controls a file or directory and decides its account-to-account sharing; ownership is not transferred by editing or sharing.
_Avoid_: Administrator, publisher

**Collaborator**:
An Account granted access to content owned by another Account through a Share; a collaborator does not become an owner.
_Avoid_: Member, guest

**Share**:
An account-to-account access relationship for one directory subtree or one file, with a permission level, separate from a Public link.
_Avoid_: Public link, publication capability

**Grant**:
The permission-bearing authorization created by a Share for a Collaborator.
_Avoid_: Ownership, Public link

**Vault**:
An Account’s entire private Markdown space: its hierarchy of Files and Directories, including content it can access through a Share. This is a technical/domain term only.
_User-facing_: Library for the owned root and the workspace that shows it; Files for its contents in prose (“Export my Files”). Never render “Vault” in UI labels, browser titles, routes, or user documentation.
_Avoid_: Workspace, repository

**Vault root key**:
The cryptographic root of an Account’s Vault. Recovering it restores access to the Account’s own content, not content merely shared by another Account.
_Avoid_: Passkey, recovery code

**Directory namespace**:
The single shared set of child File and Directory names within one Directory; siblings have distinct canonical names regardless of case or canonically equivalent Unicode spelling.
_Avoid_: Filename index, folder table

**Name collision**:
A requested File or Directory name that is indistinguishable from an existing sibling in its Directory namespace. It requires an explicit user-visible resolution and never silently overwrites or merges content.
_Avoid_: Duplicate filename, automatic merge

**Directory capability**:
Cryptographic authority to decrypt a directory subtree, including descendants added later. It grants access without transferring ownership.
_Avoid_: Public link, ownership

**File capability**:
Client-held cryptographic authority to decrypt one File and its current representation keys without access to its containing Directory. It remains stable across ordinary saves, but changes when access changes require Key rotation.
_Avoid_: File content key, Directory capability, permanent key

**File content key**:
A fresh cryptographic key that protects one current representation of one File, wrapped by its File capability. It is distinct from a Directory capability, a Passkey, and a Public link.
_Avoid_: Vault root key, recovery code

**Private content**:
Markdown source intended only for accounts authorised by its owner or a share; it remains unreadable to the service operator.
_Avoid_: Secret data, encrypted-at-rest content

**Publication**:
An Owner-controlled public exposure of one file through a Public link. It is separate from account-to-account Shares and can be rotated without changing file ownership; unpublishing begins irreversible teardown of its public material without changing File ownership.
_Avoid_: Public share, published folder

**Unpublishing**:
An Owner-initiated irreversible teardown of a Publication. It seals all Public routes immediately, then hard-deletes its Public representation, Public Comment thread, Comments, capabilities, and attribution in bounded batches driven by the Owner's browser or by scheduled maintenance; interruption never restores access.
_Avoid_: Archive, hide, pause

**Publication request**:
A Collaborator’s pending request for the Owner to create a Publication. It grants no public access and cannot publish on its own.
_Avoid_: Publish permission, Share

**Publication capability**:
The read-only cryptographic authority carried by a Public link. It is separate from an Account share and may be rotated without changing file ownership.
_Avoid_: Account permission, share

**Public link**:
A deliberately issued, anonymous, read-only capability to view the current contents of one published file. Ordinary edits appear through the same link while it remains valid; it has no public version history and is separate from an account-to-account share.
_Avoid_: Share link, public share

**Owner link copy**:
The active Public link's read capability sealed under the Owner's Vault root key, so any of the Owner's Encryption devices can show the complete link again. The service stores it but cannot open it, and only the Owner receives it. It is replaced with the link on rotation and removed with it; a link created without one never gains one later.
_Avoid_: Saved link, stored fragment, link backup

**Comment**:
A short, authored annotation in one Comment thread for a File. It is not Markdown content and has no line or selection anchor in the MVP.
_Avoid_: Inline annotation, review thread

**Historical Comment**:
A Comment created from an Import archive’s Private-Comment sidecar. It preserves historic display data in a fresh Private comment thread but restores neither its former author’s authority nor any former capability. An Import accepts at most 1,000 Historical Comments.
_Avoid_: Restored Comment, transferred author

**Comment thread**:
A flat, ordered collection of Comments attached to one File. Its private and public forms are separate and never expose Comments to the other audience.
_Avoid_: Chat, discussion board

**Comment thread capability**:
Client-held cryptographic authority to decrypt one Comment thread. A Private comment thread capability follows current File-read access regardless of the Grant’s Markdown permission. A Public comment thread capability is independently random for each Comment audience epoch: public epochs are wrapped to the Publication capability, while eligible Owner and Collaborator devices receive direct envelopes for all retained epochs; Collaborators-only epochs have no Publication-capability wrapper.
_Avoid_: File content key, Share, Public link

**Comment audience epoch**:
An encrypted segment of a Public comment thread with one explicitly selected audience. Each audience change starts a new epoch; authenticated Owners and Collaborators retain the thread’s history, while Public readers receive only explicitly public epochs.
_Avoid_: Revision history, access log, visibility toggle

**Private comment thread**:
A File’s Comment thread for its Owner and every Account with current File-read access through an active Grant. A read-only Grant permits reading, creating, editing, and hard-deleting the author’s own Comments without permitting Markdown edits; the File Owner may hard-delete any Comment but cannot edit another author’s text. Its Comments show each author’s Public pseudonym.
_Avoid_: Shared Markdown, public comments

**Public comment thread**:
A Publication’s separate Comment thread, visible under its selected comment audience. It follows its active Publication through link rotation, is hard-deleted on unpublish, and never exposes a File’s Private comment thread or revives with a later Publication.
_Avoid_: Public share, file content

**Current File representation**:
The one persisted encrypted Markdown and File-metadata state of a File. Replacing it is conditional on the immediately prior representation and creates no user-visible version history.
_Avoid_: Revision history, draft

**File source limit**:
The maximum UTF-8 byte length of Markdown source accepted in one Current File representation. For the MVP it is 262,144 bytes (256 KiB), measured before encryption and applied equally to imported, created, edited, pasted, and replacement source. A legacy oversized File remains readable/exportable until a within-limit save or replacement brings it back into bounds.
_Avoid_: Ciphertext-row limit, character limit, upload-size limit

**Key envelope**:
A versioned ciphertext that grants a parent capability, authorized Account/device, recovery mechanism, or Publication capability access to another key without exposing that key to the service.
_Avoid_: Password, plaintext key

**Key rotation**:
A browser-driven replacement of an affected capability’s key epoch and current envelopes after a revocation or scope change. Server authorization ends first, and new writes under the affected root wait until the rotation completes.
_Avoid_: Deletion, account recovery

**Public representation**:
The single current encrypted presentation payload for an active Publication. It is separately protected by the Publication capability, is hard-deleted on unpublish, and never exposes a File’s private representation or content key.
_Avoid_: Public version, private File content

**Pseudonym update**:
An exclusive, browser-driven batch operation that replaces an Account’s Public pseudonym across its encrypted Comment and Publication attributions. Until it commits, all views retain the old pseudonym; the initiating UI shows progress and blocks normal work.
_Avoid_: Background rename, partial pseudonym change

**Hard deletion**:
Irreversible removal of a File, Directory, or Publication’s application-level dependent records, with no trash, restore action, soft-delete state, or recoverable archive. A transient sealed teardown marker cannot restore access and is not a soft delete. It does not recall data already downloaded by a client or promise immediate erasure from provider-managed backups.
_Avoid_: Archive, trash, soft delete

**Owned Files export**:
A browser-created data-ownership archive of the Files owned by one Account. It excludes content accessible only through a Share, as well as live Grants, capabilities, keys, credentials, local drafts, and Publication state.
_Avoid_: Vault backup, shared-content export

**Import target**:
An eligible Directory selected for a browser import. It is owned by the importing Account or covered by their active read/write Directory Grant. All created descendants belong to the target Directory’s Owner; direct File Grants and read-only Grants are never Import targets.
_Avoid_: Share transfer, File target, directory path inferred from a File Grant

**Import archive**:
A portable Markdown-first artifact that creates Files in an Import target. It transfers no active cryptographic or collaboration authority; any carried Private Comment history becomes bounded Historical Comments rather than a continuation of its former thread.
_Avoid_: Share migration, account backup restore

**Archive manifest**:
The versioned portable `.mdwn/manifest.json` within an Import archive. It identifies the archive format and roots without carrying live authority or becoming Import staging state.
_Avoid_: Import staging manifest, capability manifest

**Import staging manifest**:
An encrypted, Import-session-bound description of exactly one reviewed Import. It binds the expected bounded Import chunks and prospective encrypted records without carrying plaintext into the service; it is not a raw Archive manifest or Private-Comment sidecar. In the MVP it is one binary payload of at most 128 KiB.
_Avoid_: Archive manifest, upload list

**Import chunk**:
One bounded binary unit of encrypted prospective Import data, identified within an Import session by its sequence and digest. It is private staging data rather than normal Vault content. In the MVP its binary payload is at most 512 KiB, it carries at most 50 complete typed canonical records, and an Import session has at most 40 chunks.
_Avoid_: File chunk, partial File

**Import session**:
A short-lived, initiating-Account-bound private staging operation for one preflighted import, binding an Import target and holding only encrypted prospective records; an exact sequence-and-digest retry is idempotent, while a mismatched retry fails the session. Atomic commit creates an owned hierarchy for the target Directory’s Owner; expiry or successful cancellation before commit creates no Files, and cancellation cannot undo an existing Import commit marker.
_Avoid_: Draft tree, partial import, upload session

**Import commit marker**:
The immutable marker that makes every valid staged record of one Import session visible together. Until it exists, normal reads retain only previously committed state, including for an Import Replace candidate.
_Avoid_: Partial commit, staged File, import status flag
