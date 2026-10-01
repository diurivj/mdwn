# Client-held content keys and capabilities

mdwn will use one client-generated cryptographic key hierarchy for private files, account shares, and public publications. Passkeys authenticate an Account but never derive, contain, or replace content keys.

## Decision

An Account has one logical **Vault**: its complete personal Markdown space. The browser generates and protects a Vault root key. The service stores only encrypted key envelopes and ciphertext for private content.

The hierarchy is:

- Each directory has an independently random directory capability key. A parent directory capability wraps child-directory keys, so a capability covers the existing subtree and descendants added later.
- Each File has an independently random File capability, wrapped by its containing Directory capability. Each current representation has a fresh independently random File content key wrapped by that File capability. Direct File Grants transport only the File capability, never a parent capability. Ordinary saves replace the representation key without changing a Directory listing. File capabilities change on access-driven Key rotation, not on ordinary saves. Existing parent-wrapped representations are converted by an authorized browser, never by the service. See [ADR-0008](0008-parent-free-file-capabilities.md). This does not create user-visible version history.
- The Account has a client-generated encryption identity separate from its passkeys. Each device has its own encryption key pair, and an authenticated device registry controls enrollment and removal. An existing device approves a new device; the service cannot substitute an unapproved public key.
- A separate high-entropy Vault recovery secret unwraps the Account’s own Vault key material in the browser. It is not a recovery code, is never sent to the service, and cannot restore content merely received through another Account’s share.

Key transport uses a maintained implementation of RFC 9180 HPKE with `DHKEM(P-256, HKDF-SHA-256)`, `HKDF-SHA-256`, and `AES-256-GCM`; mdwn will not implement a custom ECDH envelope protocol. Symmetric content and key wrapping use AES-256-GCM with a 128-bit authentication tag, fresh collision-free 96-bit nonces, and domain-separated HKDF labels where derivation is required. The implementation must guarantee nonce uniqueness per key across tabs, devices, retries, and offline work.

The `mdwn/enc-v1` envelope family carries an explicit version, purpose, algorithm suite, object/key identifiers, key epoch, and ciphertext; HPKE envelopes also carry the HPKE encapsulated public key, while AES-GCM envelopes carry their nonce. Canonical authenticated context binds the envelope to its Vault/object, purpose, epoch, and publication where applicable. Unsupported suites, malformed envelopes, stale epochs, replayed manifests, and algorithm downgrades are rejected.

## Sharing and revocation

A directory share gives the recipient Account’s encryption identity an envelope for the directory capability key. The capability covers existing descendants and files added later. Permission levels and onward sharing remain policy decisions in the sharing ticket; this decision defines the cryptographic authority only.

Revocation removes the Account’s current server authorization, advances the directory key epoch, and rewraps current descendant keys for remaining authorized Accounts. Old downloaded plaintext or keys cannot be recalled. The MVP does not promise cryptographic erasure of data that a collaborator already downloaded; all future object access must pass current server authorization and epoch checks.

## Public links

A public publication is a separate read-only capability. Its opaque random publication ID is in the URL path, while its decryption capability is in the URL fragment and is never sent in HTTP requests, logs, or referrers. The publication is live: ordinary edits replace the current encrypted public representation, and the same valid link shows the latest content without exposing public version history. Explicit rotation creates a new publication ID and fragment key and immediately revokes the old publication. Anyone possessing the full URL can read until revocation; downloaded content cannot be recalled.

## Public Comment capabilities

A logical Public Comment thread has independent random capabilities per Comment audience epoch. A public epoch is wrapped to the Publication capability in the Public-link fragment; a Collaborators-only epoch is direct-HPKE-enveloped to each eligible Owner/Collaborator device with current File-read access. Device envelopes allow the authenticated workspace to read retained public epochs without disclosing a URL fragment or Publication-management authority.

Audience changes begin fresh epochs: anonymous Public readers receive only public epochs, never Comments created while Collaborators-only. Effective File-read changes add or remove device envelopes; loss of the last access path immediately ends server access and rotates the current Collaborators-only epoch. Link rotation rewraps public epochs for the new Publication capability. Unpublishing seals every Public route before bounded, irreversible teardown of its Public representation, thread, Comments, capabilities, and attribution; a later Publication is fresh. See [Define Collaborators-only Public Comment capabilities](../../.scratch/mdwn/wayfinder/21-define-collaborators-only-public-comment-capabilities.md) for the lifecycle contract.

## Server-visible metadata and threat boundary

The service may see opaque object IDs, parent relationships, object type, ciphertext sizes, server timestamps, access/share/publication records, and bounded operational security metadata. Directory and file names, Markdown, front matter, user-authored timestamps, and ordering remain encrypted.

This protects private plaintext from the service, its operators, database/storage readers, and unauthorized server-mediated access under an honest client. It does not protect against a compromised device or browser, malicious extensions, XSS, malicious dependencies, or a server that serves altered JavaScript. The app therefore requires a strict CSP, no third-party scripts or analytics on cryptographic/public-reader pages, pinned dependencies, secure headers, cross-browser cryptographic tests, and an independent security review before claiming end-to-end security.

## Consequences

The browser must perform encryption, decryption, key provisioning, public republishing, and recovery. Server-side rendering and server-side full-text search over private Markdown are not available. Sharing and revocation require key epochs and authenticated manifests. Public-link fragments are bearer secrets and may leak through copying, browser history, screenshots, or a compromised client. Recovery must be tested as a cryptographic restore path rather than treated as ordinary Account authentication.

Sources: [RFC 9180: Hybrid Public Key Encryption](https://www.rfc-editor.org/rfc/rfc9180), [RFC 5869: HKDF](https://www.rfc-editor.org/rfc/rfc5869), [Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/), and [NIST SP 800-38D: GCM and GMAC](https://csrc.nist.gov/pubs/sp/800/38/d/final).
