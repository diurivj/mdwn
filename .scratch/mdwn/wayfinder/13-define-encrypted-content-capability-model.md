# Define encrypted-content and capability model

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by: 01

## Question

Given the end-to-end content-privacy decision, define the single key/capability model that every content feature will use:

- What is encrypted, at what granularity (vault, directory, file), and which browser-native cryptography/KDF primitives and versioned envelope format are the MVP baseline?
- How does an account regain keys after registering a new passkey or device, without making a passkey itself a content-encryption key?
- How does a directory share grant/revoke another account's ability to decrypt the current subtree and newly added files, including the practical revocation boundary for content already downloaded?
- How does a per-file public link safely carry a read-only decryption capability (including URL-fragment handling, rotation, and revocation) while keeping the key out of requests and logs?
- Which metadata remains server-visible for MVP (for example hierarchy, filenames, timestamps, and ciphertext size), and which is encrypted?

Record an ADR if the cryptographic boundary and key-lifecycle decision meets the ADR tests. This ticket produces the model only, not its implementation.

## Answer

**Resolution — Client-held content keys and capabilities.** The Account’s **Vault** is its complete personal Markdown space. The browser generates and protects one Vault root key; passkeys authenticate the Account but never derive or contain content keys.

### Key hierarchy

- Each directory has an independently random directory capability key. Parent capabilities wrap child-directory keys, so a capability covers the existing subtree and descendants added later.
- Each current file representation has an independently random file content key. That key encrypts Markdown and encrypted file metadata; the containing directory capability wraps it. Each saved edit receives a fresh content key without creating user-visible version history.
- The Account has a client-generated encryption identity separate from passkeys. Each device has its own encryption key pair and an authenticated device registry. Existing devices approve new devices; the service cannot substitute an unapproved key.
- A separate high-entropy Vault recovery secret restores the Account’s own Vault key material in the browser. It is not a recovery code, never reaches the service, and cannot restore content merely received through another Account’s share.

The `mdwn/enc-v1` envelope family carries an explicit version, purpose, algorithm suite, object/key identifiers, key epoch, and ciphertext. Authenticated context binds it to the Vault/object, purpose, epoch, and publication where applicable. Unsupported suites, malformed envelopes, stale epochs, replayed manifests, and algorithm downgrades are rejected.

Use a maintained RFC 9180 HPKE implementation for public-key key transport: `DHKEM(P-256, HKDF-SHA-256)`, `HKDF-SHA-256`, and `AES-256-GCM`. Do not implement a custom ECDH envelope protocol. Symmetric content and key wrapping use AES-256-GCM with a 128-bit tag, fresh collision-free 96-bit nonces, and domain-separated HKDF labels where derivation is needed. Nonce allocation must remain unique across tabs, devices, retries, and offline work.

### Sharing and revocation

A directory share gives the recipient Account’s encryption identity an envelope for the directory capability key. The capability covers existing descendants and files added later; permission levels and onward sharing remain policy decisions in [Sharing & permission model](05-sharing-permission-model.md).

Revocation removes current server authorization, advances the directory key epoch, and rewraps current descendant keys for remaining authorized Accounts. It cannot recall plaintext or keys already downloaded by the collaborator. Future reads and writes require current authorization and epoch checks.

### Public links

A public publication is a separate read-only capability. Its opaque random publication ID is in the URL path; its decryption capability is in the URL fragment and is never sent in requests, logs, or referrers. The publication is live: ordinary edits replace the current encrypted public representation, and the same valid link shows the latest content without public version history. Explicit rotation creates a new publication ID and fragment key and immediately revokes the old publication. Anyone possessing the complete URL can read until revocation.

### Public Comment capabilities

A logical Public Comment thread is partitioned into independent **Comment audience epochs**. A public epoch is wrapped to the Publication capability in the URL fragment; a Collaborators-only epoch is instead HPKE-enveloped directly to each currently eligible Owner/Collaborator device with effective File-read access. Eligible devices also receive direct envelopes for retained public epochs so the authenticated workspace can display the thread without receiving a URL fragment or Publication-management authority.

Changing audiences starts a fresh epoch. Public readers may receive only public epochs, so a later public audience never reveals Collaborators-only Comments. Grant/device changes update device envelopes from the same effective File-read relation as Private Comments; losing the last such access immediately removes server authorization and rotates the current Collaborators-only epoch for remaining devices. Link rotation rewraps public epochs for the new Publication capability. Unpublishing seals every Public route first and then irreversibly deletes the Publication’s Public representation, thread, envelopes, and attribution in bounded owner-browser-driven batches. The complete lifecycle is resolved in [Define Collaborators-only Public Comment capabilities](21-define-collaborators-only-public-comment-capabilities.md).

### Metadata and boundary

The service may see opaque object IDs, parent relationships, object type, ciphertext sizes, server timestamps, access/share/publication records, and bounded operational security metadata. Directory and file names, Markdown, front matter, user-authored timestamps, and ordering remain encrypted.

This protects private plaintext from the service, its operators, database/storage readers, and unauthorized server-mediated access under an honest client. It does not protect against a compromised device or browser, malicious extensions, XSS, malicious dependencies, or a server serving altered JavaScript. The client therefore requires strict CSP, no third-party scripts or analytics on cryptographic/public-reader pages, pinned dependencies, secure headers, cross-browser cryptographic tests, and independent security review.

The cryptographic boundary and lifecycle are recorded in [ADR 0003: Client-held content keys and capabilities](../../../docs/adr/0003-client-held-content-keys-and-capabilities.md).
