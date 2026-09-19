# Define Collaborators-only Public Comment capabilities

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by: 06, 07, 09, 13

## Question

[Public publish model](06-public-publish-model.md) permits a Publication's Public Comment thread to be Collaborators-only, so the Owner and active Collaborators can read and post. [Comments model](07-comments-model.md) says that thread's capability is protected by the Publication capability in the Public-link fragment. [Data model & schema](09-data-model-and-schema.md) says normal File editors never receive that fragment capability or Publication-management authority. The current decisions therefore do not specify how an authorized Owner or Collaborator decrypts and writes a Collaborators-only Public Comment thread.

Lock the capability and lifecycle model without weakening the Public-link boundary:

- Which current authorized Accounts/devices receive or can derive the Public Comment-thread capability in Collaborators-only mode, and how are the needed Key envelopes provisioned without giving them Publication-management authority or the URL-fragment capability?
- How do Grant acceptance, revocation, permission changes, File moves, audience changes, Publication rotation, unpublish, a later new Publication, and Key-epoch rotation update or remove that access?
- What server authorization checks distinguish Public-thread access from Private-thread access, while preserving the rule that public readers never see Private content and the service never sees plaintext capabilities?
- What client behavior distinguishes an authenticated Collaborator-only Comment view from the anonymous Public reader without leaking a capability in routes, requests, logs, or referrers?

Update the encrypted-content, Publication, Comment, and schema decisions when resolved. Do not reopen the settled public-link path/fragment format, anonymous Markdown reading, Comment format, or Owner-controlled Publication lifecycle.

## Answer

**Resolution — audience-scoped, account-enveloped Public Comment capabilities.** A Public Comment thread remains separate from a File’s Private Comment thread and from Publication management. It is one logical thread partitioned into ordered **Comment audience epochs**; each epoch has an independently random capability and only its selected audience can obtain its ciphertext.

### Capability and provisioning

- A **public** epoch is wrapped to the Publication capability so a browser holding the URL fragment can decrypt it locally. Its creating or otherwise authorized browser also HPKE-envelopes it directly to currently eligible Owner/Collaborator devices, so authenticated history never depends on a fragment. The fragment remains absent from every request, log, and referrer.
- A **Collaborators-only** epoch is never wrapped to the Publication capability. Instead, an authorized browser HPKE-envelopes its capability to every enrolled device of the File Owner and every Account with current effective File-read access. Read-only direct and Directory Grants qualify; overlapping Grants are deduplicated and do not add authority. The same direct device envelopes let authenticated eligible Accounts read retained public epochs without receiving a Public link fragment.
- Every envelope is purpose-bound to its File, logical Publication, thread, audience epoch, recipient device or Publication link, and key epoch. The service stores recipient public keys and opaque envelopes, but never a plaintext capability. A device envelope grants Comment decryption only: it does not grant Publication management, create a Public link, or weaken Owner-only publication control.
- At Grant acceptance and approved-device enrollment, an already authorized browser provisions the newly eligible device with envelopes for retained epochs in bounded batches. The Grant otherwise follows its settled lifecycle; until its device has the relevant envelope, the authenticated UI shows that secure Public Comment access is being prepared rather than falling back to a fragment or service-held key.

### Membership, audience, and Publication lifecycle

- Public Comment eligibility follows the same effective File-read relation as Private Comment participation: the Owner plus an Account with at least one current direct or inherited File-read Grant. Markdown read/write changes alone do not change it. A File move, Grant acceptance, Grant revocation, or overlapping-Grant change recomputes that relation.
- When an Account loses its last File-read path, the server immediately denies its authenticated Public-thread reads and mutations, supersedes its envelopes, and rotates the current Collaborators-only epoch for remaining eligible devices before new Comments are accepted. Old plaintext, ciphertext, or capabilities already downloaded cannot be recalled. A general Key rotation rewraps current epoch material only for currently eligible devices.
- Every audience change starts a fresh epoch. Changing **public → Collaborators-only** stops anonymous thread delivery immediately and begins a device-enveloped epoch; authenticated eligible Accounts retain history, including prior public epochs. Changing **Collaborators-only → public** starts a fresh public epoch and never exposes a prior Collaborators-only epoch. When the public reader is enabled, it receives only epochs explicitly marked public.
- Publication-link rotation preserves the logical thread: the Owner browser replaces public-epoch wrappers for the new Publication capability, removes old-link routing, and leaves account-device envelopes and Publication-management authority unchanged. A later Publication after teardown is a new logical Publication, Public thread, epochs, capabilities, and path ID.

### Server and client boundary

- The anonymous Public route accepts only the opaque Publication path ID. While the Publication is active with a public Comment audience, it returns the current Public representation plus eligible public-epoch ciphertext and wrappers; it never returns Account-device envelopes, Private-thread data, or a fragment. A signed-in Account may post to that public epoch under the settled Publication-aware abuse limits, but the browser needs the locally held fragment capability to create meaningful ciphertext.
- An Owner or Collaborator opens the Public thread only inside the signed-in opaque File route. The authenticated endpoint requires an active Publication and current effective File-read authorization, then returns only that device’s envelopes and the authorized epochs. It never accepts or emits a Public-link fragment. The Private-thread endpoint remains separate even though both checks derive from File-read access.
- In Collaborators-only mode, an unauthenticated Public reader receives the settled sign-in notice and no thread ciphertext; signing in without a qualifying Grant does not change that result. Requests and referrers contain no capability material, and the public-reader page uses the existing no-tracking, fragment-safe policy.
- Create, edit, and delete checks remain audience-specific: public-epoch creation requires an authenticated Account and an active public Publication; Collaborators-only creation requires current File-read access; author-only edit/delete and Owner hard-delete rules apply in either thread.

### Destructive unpublish

- The Owner’s Publish panel shows an irreversible confirmation with the current Public Comment count, e.g. **“Unpublish and permanently delete 12 Public Comments.”** It states that the Public link, current Public representation, Public Comment thread, encrypted Comments, capabilities, and related Public attribution will be removed without recovery.
- Confirming first performs a short irreversible seal: it removes the active link, makes every old-link request return the same ciphertext-free `404` as an unknown link, and denies both anonymous and authenticated Public-thread reads or mutations. A transient opaque teardown marker is not an unpublished archive and cannot restore the Publication.
- The owner’s browser then drives idempotent bounded deletion batches for the sealed Public material. The UI remains in **Deleting public material…** with progress; interruption leaves the Publication sealed and lets only the Owner resume deletion. No one can read or interact with the former Public material while cleanup is incomplete. A new Publication for that File is unavailable until teardown completes, then starts fresh.
- A durable queue-backed autonomous teardown that lets the UI return immediately is beyond the MVP. As with all hard deletion, already downloaded plaintext or provider-managed backups cannot be recalled.
