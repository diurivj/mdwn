# mdwn MVP buildable specification

Status: buildable — assembled from every resolved wayfinding decision. No section waits on an open ticket; the choices still left open are explicitly implementation discretion, not product decisions.

This specification assembles every mdwn wayfinding decision resolved on the map. It defines product scope, trust boundaries, domain rules, architecture, persistence, user flows, operational policy, and acceptance criteria. Normative terms such as **Account**, **Grant**, **Publication**, and **Import session** use the meanings in [`CONTEXT.md`](../CONTEXT.md).

When this document deliberately leaves a choice open—such as source-file layout, an exact responsive breakpoint, or which maintained RFC 9180 package to use—that choice is implementation discretion, not an unresolved product decision. It must still satisfy every invariant and acceptance criterion below.

## 1. Product and MVP boundary

mdwn is a standalone, personal-first web application for writing and browsing Markdown in a normal File/Directory tree. It supports open signup, direct Account-to-Account sharing, per-File public publishing, Comments, and browser-side import/export.

The MVP must provide:

1. Passkeys-only, email-free Accounts with recovery codes and separate encrypted-content recovery.
2. A private hierarchy of Directories and Markdown Files.
3. Browser-only encryption/decryption of private Markdown, names, ordering, user-authored metadata, and Comments.
4. Read-only and read/write Shares for either a Directory subtree or one File.
5. Owner-controlled, live, per-File Public links.
6. Separate Private and Public flat Comment threads.
7. A persistent split editor/preview workspace with responsive narrow-screen behavior.
8. Browser-generated Markdown ZIP export and browser-preflighted Markdown import.
9. Hard deletion of bounded File/Directory trees and irreversible Public-material teardown.
10. Privacy-preserving abuse controls that remain within Cloudflare Workers Free and D1 Free capacity.

Signup is open. The product is never monetized: there is no billing, subscription, advertising, or paid feature tier.

### 1.1 Explicitly outside this MVP

- Monetization, billing, and subscriptions.
- Integration with or reuse of Oasis Vault.
- CLI or automatic filesystem, git, research-pipeline, or agent-output ingestion/sync.
- Real-time collaborative editing.
- User-visible version history or revisions.
- Custom public domains.
- Native mobile applications.
- Comment notifications.
- Attachment or image storage.
- Private-content full-text search.
- Public-page themes or custom styling.
- Long-term off-site backups and disaster recovery beyond D1 Time Travel and pre-change exports.
- Account deletion and account-wide export beyond owned-File export and bounded File/Directory hard deletion.
- Team or organization capabilities beyond direct Account-to-Account sharing.
- Offline/PWA behavior and persisted drafts.
- Historical audit logging.
- Jurisdiction-specific privacy notices and pre-launch legal review.
- Resumable hard deletion of Directory trees larger than 500 nodes.
- Durable queue-backed autonomous Public-material teardown.

### 1.2 Support and funding

mdwn is never monetized: there is no billing, subscription, advertising, paywall, entitlement, or paid feature tier. Revenue never enters the product.

- The only support surface is an optional, anonymous donation page linked from the site footer. It requires no Account, no session, and no personal data.
- It shows static cryptocurrency addresses with QR codes generated locally (build-time or vendored); it embeds no third-party script, widget, tracker, or analytics, respecting the no-tracking invariants in section 2.1.
- Donations grant nothing — no badge, priority, feature, storage, or service guarantee — and create no record in D1 or any operational store.
- The page states what donations cover (domain and any future paid infrastructure) and that mdwn runs identically without them; capacity exhaustion still fails closed.

Evaluated private donation options and their trade-offs are recorded in [`support-options.md`](support-options.md).

## 2. Non-negotiable invariants

### 2.1 Privacy and trust boundary

- Private Markdown and private user-authored metadata are encrypted and decrypted only in the browser. The service, operator, and managed database must not be able to read them.
- Directory names, File names, ordering, Markdown, front matter, user-authored timestamps, Comment bodies, and displayed Public pseudonyms are ciphertext at the service boundary.
- The service may know opaque IDs, node type and parent relationships, ownership and authorization relationships, ciphertext sizes, key epochs, server timestamps, Publication state, and narrowly bounded operational metadata.
- Passkeys authenticate Accounts. They never derive, contain, or replace content-encryption keys.
- mdwn has no analytics, advertising, behavioral profiling, third-party tracking, or blanket request logging.
- Requests may carry only credentials required by their dedicated protocol—for example, an opaque session cookie or one recovery-code submission—over HTTPS. Logs, referrers, errors, analytics, and persisted operational records must never capture session tokens, recovery-code values, Public-link fragments, plaintext capabilities, Markdown, Comment plaintext, or Vault recovery secrets. Recovery-code hashes and D1-backed session state are permitted only in their dedicated stores.
- Anonymous public pages are non-indexed by default and use no analytics, third-party scripts, or nonessential cookies.
- Browser-side export and application-level hard deletion are privacy guarantees. Neither can recall plaintext already downloaded or promise immediate erasure from provider-managed backups.

### 2.2 Authorization and ownership

- Every File and Directory has exactly one Owner.
- Sharing and editing never transfer ownership.
- Only an Owner can create, change, or revoke a Share for its content, or create, rotate, configure, or unpublish its Publication.
- A Collaborator cannot reshare content it does not own.
- Directory-derived access follows current containment. Direct File access follows File identity and reveals no parent or neighboring content.
- Effective File access is the union of active direct and inherited Grants; the strongest permission controls Markdown/structural authority.
- Private Comment participation depends only on current File-read access, not on read/write strength.
- Server authorization is required even when a browser still possesses old ciphertext or keys.

### 2.3 Destructive and concurrent operations

- No privacy-sensitive operation relies on generic database cascades.
- File save, structural mutation, import visibility, Publication updates, and key epochs use optimistic revisions or equivalent conditional writes. There is no silent last-write-wins.
- There is no trash, soft-delete state, restore action, or user-visible revision history.
- Security actions—hard deletion, unpublishing, session revocation, and browser export—must not be blocked by public-participation limits.

## 3. Technical architecture

### 3.1 Runtime and application framework

- TypeScript.
- React Router v8 Framework Mode.
- `@react-router/cloudflare` and `@cloudflare/vite-plugin`.
- Cloudflare Workers runtime.
- React Router loaders/actions for server interactions.
- Server rendering is limited to the application shell and non-sensitive route data. Private plaintext is never server-rendered.

### 3.2 Persistence and migrations

- Cloudflare D1 is the production relational store.
- All schema and queries remain SQLite-compatible.
- Drizzle ORM uses its SQLite/D1 driver.
- The repository contains the TypeScript schema and reviewed generated SQL migrations.
- Wrangler applies migrations. Preview/local environments use separate databases, never production D1.
- D1 batch/transaction behavior is used for short atomic business operations.
- D1 Time Travel plus a pre-change database export is the MVP recovery posture for risky migrations or manual repairs.

### 3.3 Browser UI and rendering

- Tailwind CSS with small local components.
- Radix primitives may be added only where accessibility-sensitive controls such as dialogs or menus benefit from them.
- Markdown rendering occurs in the browser with `react-markdown`, `remark-gfm`, and conservative `rehype-sanitize`.
- Arbitrary raw HTML and `rehype-raw` are not enabled.

### 3.4 Authentication and sessions

- `@simplewebauthn/server` and `@simplewebauthn/browser` v14.
- One-use WebAuthn challenges are stored in D1 and deleted after use.
- React Router `createSessionStorage` uses D1-backed CRUD. Do not use cookie-contained session state as the source of truth.
- The browser cookie contains only a signed opaque session identifier and is `Secure`, `HttpOnly`, and `SameSite=Lax`.

### 3.5 Deployment

- Wrangler is the deployment and Cloudflare-resource CLI.
- Pull requests run type checking, tests, and a production build.
- Protected `main` applies reviewed D1 migrations and deploys the Worker through GitHub Actions.
- Production values use Cloudflare Secrets. Local values use an ignored `.dev.vars` file.
- No secret may enter the client bundle.
- Capacity exhaustion fails closed; the system does not trigger automatic paid spend.

### 3.6 Security posture

The browser client is part of the trusted computing base. End-to-end content privacy does not protect against a compromised device/browser, malicious extension, XSS, malicious dependency, or a service that serves altered JavaScript. Therefore implementation requires:

- a strict Content Security Policy and secure response headers;
- no third-party scripts on cryptographic or public-reader pages;
- pinned and reviewed cryptographic/dependency versions;
- cross-browser cryptographic and recovery tests; and
- independent security review before claiming end-to-end security.

## 4. Cryptographic system

### 4.1 Key hierarchy

- The browser generates one Vault root key for an Account's owned content.
- Every Directory has an independently random Directory capability key.
- A parent Directory capability wraps each child Directory capability.
- Every File has an independently random File capability wrapped by the containing Directory capability; direct File Grants deliver that capability without parent access.
- Every persisted current File representation has a fresh independently random File content key, which encrypts Markdown/File metadata and is wrapped by the File capability.
- Each successful File save uses a fresh content key but leaves its File capability and Directory listing unchanged. File capabilities change when access-driven Key rotation requires it. Replacing a representation is not version history. Legacy parent-wrapped Files require the conditional browser conversion in section 8.3.
- An Account has a client-generated encryption identity separate from WebAuthn credentials. The identity is account-scoped and realized by its registered Encryption devices: every capability envelope that grants access targets a specific device's transport public key (or a Publication link capability for public epochs), so no separate account-wide decryption key exists.
- Each enrolled device has separate P-256 HPKE transport and device-assertion signing key pairs plus an approved-device registry entry. A current device proof—not a passkey alone—authorizes private operations. In the normal enrollment flow, an existing approved device must approve a new device through a QR-bound ceremony; the service cannot substitute an unapproved public key. Signup is the one exception: the Account-creation transaction is the trust anchor that creates the first device (section 5.2).
- A separately generated 256-bit Vault recovery secret is represented as a checksum-protected 24-word phrase. It is shown only at creation, recovery, or explicit reissue; it is never user-chosen, sent to the service, logged, or used as a password.
- The browser derives a 256-bit recovery wrapping key with `HKDF-SHA-256` from that secret, a random public recovery salt, and the domain-separated `mdwn/vault-recovery-capsule/v1` context containing the Account ID and recovery generation.
- A versioned AES-256-GCM `mdwn/enc-v1` Recovery capsule contains the stable Vault root key and a dedicated P-256 recovery-enrollment signing private key. The service stores only its opaque ciphertext/metadata, current generation and salt, and the matching public recovery-verification key.
- Every Account-owned root capability not reached through the encrypted Directory hierarchy—including the hidden root Directory capability and needed owned-File/Comment auxiliary capabilities—has a current `vault-recovery` Key envelope under the Vault root key. A capability received only through a Grant is explicitly excluded.

Authentication recovery codes and the Vault recovery phrase are separate artifacts. Recovering authentication does not itself recover encrypted content. The phrase becomes encrypted-content recovery/enrollment authority only alongside a live normal Session with a recent Passkey assertion; it never authenticates an Account.

### 4.2 Algorithms and envelope format

- Public-key key transport uses a maintained RFC 9180 HPKE implementation with `DHKEM(P-256, HKDF-SHA-256)`, `HKDF-SHA-256`, and `AES-256-GCM`.
- Do not implement a custom ECDH envelope protocol.
- Symmetric content encryption and key wrapping use AES-256-GCM, a 128-bit tag, fresh collision-free 96-bit nonces, and domain-separated HKDF labels where derivation is needed.
- Nonce allocation must remain unique for a key across tabs, devices, retries, and interrupted work.
- The versioned `mdwn/enc-v1` envelope family includes purpose, algorithm suite, protected object/key identifiers, key epoch, and ciphertext. HPKE envelopes include the encapsulated public key; AES-GCM envelopes include their nonce.
- Canonical authenticated context binds every envelope to its Vault/object, purpose, epoch, recipient where applicable, and Publication where applicable.
- Clients reject unsupported versions/suites, malformed envelopes, stale epochs, replayed manifests, context mismatch, and algorithm downgrade.

The exact maintained HPKE package and internal binary serialization are implementation choices, but the selected representation must be deterministic where authenticated context or digest comparison requires it and must pass shared browser/server test vectors.

### 4.3 Key envelopes and revocation

A Key envelope is the only persisted mechanism that grants one capability access to another key. Required purposes cover:

- parent Directory to child Directory;
- parent Directory to File capability, then File capability to fresh representation content key;
- active direct File/Directory Grant to recipient device;
- device enrollment;
- Vault recovery;
- Publication/Public representation;
- Private Comment thread;
- Public Comment audience epoch; and
- encrypted attribution.

Capability, Grant, or shared-subtree revocation first removes server authorization in a short transaction, advances the affected capability/key epoch, and blocks new writes beneath the affected root. It then creates a browser-driven, resumable, bounded Key-rotation job that rewraps current capabilities only for remaining authorized devices. It cannot recall previously downloaded plaintext, ciphertext, or keys. Routine Encryption-device removal is deliberately narrower: it supersedes only the target's Sessions and device envelopes and advances the device-registry epoch; it does not rotate Vault, Directory/File, Grant, or representation keys.

A move out of a shared subtree must complete required rekeying within its bounded operation or be rejected/deferred; it may never expose future writes under an old capability.

### 4.4 Public-link capabilities

A Publication uses a capability separate from private File keys:

- a never-reused, independently generated 256-bit random base64url Publication path identifier is sent to the service;
- a versioned read-only decryption capability stays in the URL fragment and is never sent to the service;
- the server stores a public encryption key so authorized File editors can update the encrypted Public representation without learning the fragment capability or gaining Publication-management authority;
- rotation installs a fresh identifier and capability atomically and makes the prior identifier return the same ciphertext-free `404` as an unknown link.

Possession of a complete active URL is sufficient to read its public File representation. Downloaded material cannot be recalled.

### 4.5 Comment capabilities

- Every Private Comment thread has a capability enveloped to the Owner and every currently authorized device with effective File-read access.
- A logical Public Comment thread consists of ordered, independently keyed Comment audience epochs.
- A public epoch is wrapped to the Publication capability and directly enveloped to eligible Owner/Collaborator devices.
- A Collaborators-only epoch has only direct device envelopes and is never wrapped to the Publication capability.
- Every audience change starts a new epoch. Public readers receive only epochs explicitly marked public.
- Losing the last File-read path immediately removes authenticated Public/Private Comment authorization. The current Collaborators-only epoch rotates before accepting new Comments for remaining devices.
- Publication-link rotation rewraps only public-epoch link envelopes; account-device envelopes remain separate.

## 5. Identity, authentication, recovery, and devices

### 5.1 Account identity

An Account has:

- an opaque random Account ID;
- an opaque unique share identifier;
- an optional unique share handle addressed only by exact match;
- an encrypted Account profile;
- a Public pseudonym its person chooses, separate from authentication and share addressing; and
- zero email addresses and zero passwords.

There is no Account directory or fuzzy discovery.

### 5.2 Signup

1. Before requesting the registration challenge, the browser generates every piece of local bootstrap material: client-minted UUIDv7 Account ID, hidden root Directory node ID, and device ID; a non-extractable P-256 HPKE transport key pair and a separate non-extractable P-256 device-assertion signing key pair; the Vault root key, the root Directory capability key, and that capability's `vault-recovery` Key envelope under the Vault root key; the first device's `device-enrollment` Key envelope carrying the Vault root key; the 256-bit Vault recovery secret and its phrase, the public recovery salt, the recovery-enrollment key pair, the generation-1 Recovery capsule, and the matching recovery-verification public key; the encrypted Account profile carrying the Public pseudonym the person chose (a suggestion is offered), protected under Account-owned Vault root material; and ten authentication recovery-code hashes.
2. Apply global and network registration-challenge limits before creating a challenge.
3. Create a random, registration-purpose-bound, five-minute challenge.
4. Require browser proof of work: find an 8-byte nonce for which `SHA-256(challenge-bytes || nonce)` has 18 leading zero bits.
5. A proof submission, valid or invalid, consumes the challenge atomically.
6. Reject a non-empty hidden registration honeypot generically; never persist its value.
7. Complete WebAuthn registration with attestation disabled. The registration challenge is a domain-separated digest of the canonical signup transcript—Account ID, device ID, both candidate public keys/transcript digest, capsule generation/metadata digest, recovery-verification public key, registration challenge material, proof-of-work material, and initial registry epoch—so `clientDataJSON.challenge` cannot match if any bound value changes. The browser also signs a canonical `mdwn/signup-device-binding/v1` statement with the candidate device-assertion private key, proving possession of the exact keys it registers.
8. The service verifies the binding statement, then one short D1 transaction creates all-or-nothing: the Account, the first passkey, the encryption identity/device registry at epoch 1, the first Encryption device in `active` state with opaque approval provenance `signup`, both initial Key envelopes, the generation-1 capsule, the ten-code authentication recovery set, and a normal Session already bound to that exact device. No Account may exist whose capsule or root-capability envelope is missing or deferred to a job.
9. Show the checksum-protected 24-word Vault recovery phrase with a mandatory verification step (re-entering three words), and the ten high-entropy, single-use authentication recovery codes once. Persist only code hashes and opaque recovery-capsule material. Until confirmation, a client-local gate blocks every content-creating private operation (File/Directory creation and Import); no server flag records it. The Account is empty at that point, so device loss before the phrase is ever recorded cannot lose content.
10. The signup Session is never unprovisioned and there is no grace period or bootstrap credential: its first private operation requires the ordinary `mdwn/device-proof/v1` at the current registry epoch, exactly as any later operation does.
11. Strongly encourage enrollment of a second passkey and safe offline storage of both distinct recovery artifacts. An active device may reissue the phrase later under the settled recovery-material rules; the latest displayed phrase supersedes prior ones.

The Account-creation transaction is itself the first device's trust anchor under the honest-client boundary; signup has no QR approval, pairing secret, or second ceremony. A registration response from another transcript, a substituted candidate key, a replayed or mismatched challenge, replayed proof of work, a missing candidate private key, or a swapped capsule digest fails without creating an Account. This binds the ceremony for correctness, crash safety, and post-hoc verifiability; a malicious service serving altered JavaScript remains outside the honest-client boundary stated in section 3.6.

A failed or interrupted signup leaves no partial Account—never a half-provisioned registry entry or an Account without recovery material. If the commit succeeded but its response was lost, the person signs in: the persisted device and the passkey both exist, and bind-on-sign-in (section 5.3) rebinds the Session. If the commit never happened, signup restarts; an authenticator credential orphaned by the failed attempt is the only residue and has no server state. Settled abuse controls apply unchanged: proof of work is consumed atomically with submission, a failed commit requires a fresh rate-limited start, and the bootstrap adds no identifying metadata or new counters.

Signup creates no `crypto_jobs`: an empty Account owns exactly one capability, the hidden root Directory, and the commit already envelopes it. There are no Files, Private Comment threads, or attribution contexts to provision. The only bootstrap UI states are **Creating your account…**, the phrase display and verification gate, and generic retry guidance on failure. **Setting up your Files securely…** and **Shared content is being securely provisioned** never appear during signup; they remain states for later enrollment and recovery. Later-created material—the first File or Directory, Comment threads, pseudonym changes—provisions through the settled ordinary flows; none of it is pre-created at signup.

There is no CAPTCHA, Turnstile fallback, email verification, behavioral fingerprinting, or operator bypass.

### 5.3 Routine authentication, Sessions, and Device proofs

- Passkeys are the only routine authentication factor. An Account may register multiple synced or device-bound passkeys.
- A normal Session has 30-day idle and 90-day absolute expiry; Sessions are server-tracked and individually/all-at-once revocable. Adding or removing a passkey requires a fresh assertion, and removing one revokes Sessions authenticated with that credential. The last remaining recovery path cannot be removed.
- A normal Session without a bound active Encryption device is **unprovisioned**. It may use only authentication, account-security, and enrollment routes; it cannot read or mutate private material, Key envelopes, Grants, Comments (including Public Comment posting), or Publications. A browser with an active device becomes private-capable only when its normal Session is bound to that exact device.
- Every private read or mutation requires the bound normal Session and a `mdwn/device-proof/v1` signature from the active device's assertion key. Its canonical payload binds a Session-binding digest, device ID, current device-registry epoch, HTTP method, canonical path/query, body digest, issued/expiry time of at most five minutes, and a random proof ID.
- Before any private operation, the service verifies the signature, matching bound Session, active device state, and current registry epoch. It atomically consumes proof IDs with every mutation or security-sensitive action—including enrollment, removal, and export—alongside that action's expected revision/idempotency condition. A read-only proof is request-bound and expires but is not persistently consumed; replay cannot change state and must not create a D1 write per workspace read.
- **Bind-on-sign-in.** A normal Session created by a fresh Passkey assertion may present a `mdwn/device-proof/v1` from an already-active Encryption device whose keys are persisted in that browser, and the Session becomes bound to it. It applies only at Session creation and only to an existing active device at the current registry epoch; it never activates a device, changes the registry epoch, or replaces or approves anything. A failed proof, or a revoked or tombstoned device, leaves the Session unprovisioned. This is how a single-device Account returns after sign-out, idle expiry, or a lost signup response; a browser holding no active device still has no path to private access except routine enrollment or Vault recovery.
- Every active-device membership change advances the Account's monotonic device-registry epoch. Existing non-target Sessions remain usable only after their browsers refresh registry state and make a proof at the new epoch; stale proofs return no private material. An enrollment racing a registry change fails and starts again rather than silently rebinding authority.

**Device-key persistence.** Every Encryption device generates its transport and assertion private keys with `extractable: false` and persists them as WebCrypto `CryptoKey` handles by structured clone into IndexedDB, alongside the opaque device ID and cached registry epoch; this survives tab close, sign-out, and full browser restart in Chromium, Firefox, and WebKit. Keys are never self-wrapped—`crypto.subtle.wrapKey` rejects a non-extractable key, so direct generation plus IndexedDB storage is the only supported path. Persistence is best-effort: the app requests `navigator.storage.persist()` and treats a missing, replaced, or unreadable device as device loss. WebKit's seven-day script-writable-storage eviction, private windows, quota eviction, and "clear site data" can destroy the device; an Account with no other device then uses Vault recovery. Losing device keys is never silent: the browser detects the missing device before private operations and shows the recovery/enrollment path instead of a failed private request.

### 5.4 Authentication recovery

- A non-secret recovery identifier plus one unused recovery code begins recovery.
- Rate limits apply without disclosing whether an Account or recovery record exists.
- A valid code is consumed and removed.
- Recovery creates only a short-lived restricted session that can enroll a replacement passkey.
- Enrolling the replacement passkey allows a normal session.
- Recovery revokes every active session, preserves existing passkeys, and writes a bounded Security event.
- Generating a new set invalidates the entire previous set.
- There is no support/operator override. Loss of all passkeys and all authentication recovery codes makes the Account unrecoverable.

Authentication recovery alone never grants encrypted-content access. An unprovisioned browser must complete the separate Vault-recovery ceremony below.

### 5.5 Vault recovery and replacement-device enrollment

This ceremony is for an Account with no usable active Encryption device. It requires both a live normal Session with a recent Passkey assertion and the current Vault recovery phrase. If Account authentication is also lost, the mandatory sequence is: recovery code → restricted recovery Session → replacement Passkey → fresh Passkey assertion → normal Session → Vault recovery phrase. An active Encryption device may explicitly reissue a lost phrase.

1. A rate-limited recovery-enrollment start creates a short-lived, one-use `recovery_enrollments` record bound to the Account, live Session, current capsule generation, current device-registry revision, and opaque nonce. It returns the current opaque capsule. Phrase entry and validation remain entirely in the browser.
2. After locally opening the capsule, the browser creates a fresh P-256 HPKE transport key pair and a separate P-256 device-assertion signing key pair. The capsule's recovery-enrollment key signs an intent bound to the Account, generation, nonce, expected registry revision, exact candidate public keys/device ID, and digest of the next capsule metadata.
3. The service verifies that intent with the stored recovery-verification public key, then sends a one-use HPKE possession challenge to the exact candidate transport key. The browser decrypts it locally and signs it with the candidate device-assertion key. Changing either candidate key makes the intent or challenge fail.
4. The browser creates a new recovery phrase, salt, and recovery-enrollment key pair, then creates the next capsule with the unchanged Vault root key and new recovery private key. It displays the replacement phrase only after success.
5. One short D1 transaction consumes the enrollment record; verifies the live Session, recent assertion, current generation and registry revision, signed intent, possession proof, exact candidate keys, and next-capsule digest; creates the exact candidate Encryption device as active; installs its initial Vault-root Key envelope; advances the device-registry epoch; installs the next capsule/verification key/generation; revokes every prior Encryption device; revokes every other Session; creates a fresh normal Session for the recovering browser; and writes a bounded Security event. Revoked devices remain tombstoned and their device-targeted envelopes are superseded.
6. The transaction preserves the Vault root key, Directory/File capabilities, File content keys, and current representations: the MVP does not re-encrypt the entire Vault. An old device may retain data it already cached, but cannot retrieve future ciphertext, envelopes, or mutations because private endpoints require a normal Session plus a current device assertion from an active device at the current registry epoch.
7. After commit, the replacement device uses the Vault root and recovery envelopes to traverse Account-owned content. Remaining device envelopes are created in bounded, idempotent `crypto_jobs`; the UI may show **Restoring your Files securely…** while they finish. A crash before commit activates no device; a crash after commit resumes only this non-authorizing provisioning work.

Vault recovery never includes a Grant capability or Grant-derived Comment capability. For an active Grant missing an envelope for the replacement device, the service records only an opaque provisioning need. An already authorized source browser—normally the File or Directory Owner's browser—provisions the current Grant/Comment capability when it next processes that need. Until then the recipient sees **Shared content is being securely provisioned**, without names, plaintext, or a URL-fragment fallback. A revoked or expired Grant cancels its need and can never provision an old capability.

A started or failed ceremony has no visible new device and consumes or expires according to the recovery-ceremony limits. A start permits only its own bounded internal challenge steps; any retry requires a new rate-limited start. There is no recovery proof of work, CAPTCHA, tracking, raw-IP retention, existence-revealing response, service/operator bypass, or factory reset. If an Account has neither an active Encryption device nor the phrase, its owned encrypted data remains retained and locked until the phrase is found; if the necessary authentication artifacts are also genuinely lost, recovery is impossible.

### 5.6 Routine Encryption-device enrollment and removal

Routine enrollment adds an Encryption device while retaining other active devices. It is distinct from Vault recovery, which is the all-device cutover when no usable active device remains. A synced passkey may authenticate the same Account in another browser but gives that browser no private-content authority until routine enrollment completes.

1. The candidate browser establishes an unprovisioned normal Session with a fresh Passkey assertion, generates an opaque device ID, P-256 HPKE transport and separate P-256 device-assertion signing key pairs, a 256-bit random pairing secret, and optionally an encrypted device label. The service stores a `device_enrollments` record bound to that candidate Session with the exact canonical public-key transcript/digest, pairing-secret hash, expected device-registry epoch, one-use lifecycle state, and expiry of at most ten minutes. It stores no raw pairing secret, private key, Vault key, capability, or plaintext label.
2. The QR code transfers the canonical candidate transcript and raw pairing secret directly to an existing active Encryption device; the service never receives the raw secret. The approving browser fetches the pending record and rejects it unless Account, device ID, both public keys, transcript digest, and secret hash match the QR byte-for-byte. That local comparison prevents service key substitution.
3. The approver needs its own normal Session, fresh Passkey assertion, and current Device proof. It encrypts a Vault-root Key envelope to the exact candidate transport public key with `device-enrollment` purpose, then signs a canonical `mdwn/device-enrollment-approval/v1` statement binding the Account, enrollment ID, pairing-secret hash, candidate device ID and both keys/digest, enrollment-envelope digest, approving device ID, expected registry epoch, and expiry.
4. After verifying that the approver remains active at that epoch, the service issues a one-use HPKE challenge to the exact candidate transport key. The candidate decrypts it locally and signs the challenge/transcript with its candidate assertion private key. Changed keys, altered approval/envelope digests, stale epochs, expired or replayed enrollment/challenge material, missing fresh Passkey assertion, inactive approver, and missing candidate private keys all fail without activating a device.
5. One short D1 transaction verifies all live/unused/current conditions above, consumes the enrollment and challenge, creates the active device with its opaque approval provenance, persists the initial Vault-root envelope, advances the registry epoch, and replaces the candidate's unbound Session with a new device-bound normal Session. It creates opaque idempotent provisioning work. A crash before commit activates no candidate; a crash after it may resume only non-authorizing provisioning work.
6. The initial envelope lets the candidate restore Account-owned material through the existing owned hierarchy and recovery envelopes. Remaining Account-owned device envelopes are created in bounded resumable `crypto_jobs`, with **Setting up your Files securely…** while they finish. Grant-derived Directory/File/Comment capabilities are never put in the Vault-root envelope: an active device that already holds a current Grant capability may envelope it to the candidate; otherwise the service creates an opaque provisioning need and the UI says **Shared content is being securely provisioned**. A revoked or expired Grant cancels its need and cannot provision afterward.

Device inventory stores only opaque ID, public keys, active/revoked state, approval provenance, registry epoch, Vault-root-encrypted optional label, creation time, and coarse last-successful-proof time—not browser/OS data, user agent, network address, or fingerprint. The device-management UI displays only decrypted label, state, creation time, and coarse last-use time.

Normal removal is targeted containment, not recovery. A *different* active device must initiate it with a normal Session, fresh Passkey assertion, current Device proof, expected registry epoch, and explicit destructive confirmation naming the decrypted target label. A device cannot remove itself or the last active device; ordinary sign-out or Vault recovery is the appropriate alternative. Its short transaction rechecks all authority/current-state conditions, tombstones the target, revokes every target-bound Session, supersedes every target-device Key envelope, cancels its pending enrollments/challenges, advances the registry epoch, and writes a bounded Security event. It rotates neither the Vault root, Directory/File capabilities, Grant epochs, nor current representations: a removed device may retain cached plaintext, keys, or ciphertext, but cannot fetch future private material or mutate state. The operation is idempotent; a concurrent registry change requires a refreshed proof and renewed confirmation. Other active devices keep their Sessions but must refresh and prove at the new epoch.

The UI distinguishes **Scan this QR code**, **Waiting for approval**, **Setting up your Files securely…**, and **Shared content is being securely provisioned**. Expired, replayed, or stale enrollment gives generic restart guidance without revealing a pending Account or key value.

### 5.7 Public readers

A Public reader has no Account or session identity. Infrastructure may necessarily observe transient network request metadata, but mdwn persists only the short-lived purpose-scoped network buckets allowed by the abuse policy.

## 6. Domain and authorization model

### 6.1 Private hierarchy

- Each Account has exactly one hidden root Directory.
- The user-facing product calls the private hierarchy **Files**; “Vault” is technical vocabulary only and never appears in UI text, browser titles, routes, or user documentation.
- Files and Directories form an adjacency-list tree.
- A Directory has one canonical, case-insensitive namespace shared by child Files and Directories. The browser decrypts names and enforces that namespace; no request, D1 record, error, or log contains a plaintext name or deterministic name-equality token.
- Cross-owner containment and cross-owner moves are forbidden.
- A Share does not copy another Account's nodes into the recipient's tree.

#### Canonical namespace and path profile

- `mdwn/namespace-v1`, vendored with Unicode **17.0.0** data, is the sole implementation of private-name canonicalization. Its versioned code/data run unchanged in Chromium, Firefox, WebKit, and the Worker test target. A Unicode-data or package-version upgrade is a separate namespace-migration decision, never an incidental dependency update.
- A display segment is `NFC_17(input)`. Its sibling comparison key is `NFC_17(default-full-case-fold_17(NFD_17(display)))`. The full/default Unicode CaseFolding mappings include multi-code-point mappings and exclude optional Turkic (`T`) mappings. Locale-sensitive `toLowerCase`, `toLocaleLowerCase`, host ICU behavior, and host `normalize()` are not the contract.
- This is deliberately NFC, not NFKC/NFKC_Casefold: canonically equivalent spellings and case variants collide, while compatibility variants such as full-width `Ａ` and ASCII `A` remain distinct.
- A valid segment is a Unicode scalar-value string whose NFC display form is 1–255 UTF-8 bytes. Reject empty names; `.` and `..`; C0/C1 controls; `/`, `\\`, `<`, `>`, `:`, `"`, `|`, `?`, or `*`; an ASCII space or `.` at the end; Unicode `Bidi_Control` code points; and malformed scalar strings such as unpaired UTF-16 surrogates. Reject case-insensitive Windows device stems (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`), checking text before the first ASCII `.` after stripping trailing ASCII spaces/dots from that stem.
- Do not trim, collapse, transliterate, confusable-fold, or otherwise repair a valid segment beyond NFC. Ordinary international letters, combining marks, ordinary whitespace, punctuation not listed above, emoji, variation selectors, and joiners remain valid.
- Importers split a source path before validation and reject absolute, traversing, or empty components. They validate each component independently and never split a validated segment. The Worker test target may run `mdwn/namespace-v1`, but Worker request handlers receive neither a display segment nor its comparison key.

#### Collision allocation and concurrent structural changes

- The browser rejects two source paths whose component comparison keys are equal. It reserves every non-colliding requested sibling name before allocating generated names, so an explicit source name such as `report (2).md` wins over a generated suffix for `report.md`.
- For each colliding requested name, candidates in one target Directory are allocated in bytewise ascending order of NFC source-relative path and then NFC requested display name. Split at the last ASCII `.` only when it is neither first nor last; otherwise the whole name is the base. Starting with the smallest unused decimal `n` at 2, propose `base + " (" + n + ")" + extension`, NFC-normalize and validate it, then test its comparison key against decrypted existing siblings, direct source reservations, and earlier generated names. Thus `draft.md` becomes `draft (2).md`, `archive.tar.gz` becomes `archive.tar (2).gz`, `.env` becomes `.env (2)`, and `draft.` becomes `draft. (2)`.
- A generated name that fails the segment profile, including a name over 255 bytes, is never truncated. The review requires Rename, Skip, or an otherwise authorized File Replace. Directories receive a different name or are skipped; they never silently merge.
- Every create, rename, move, delete, and final Import commit conditionally advances the affected `entries_revision`. On a winning concurrent structural change, the Worker performs no mutation and returns nameless `409 namespace_changed`; it never picks a suffix or overwrites. The authorized browser says **This folder changed on another device. Nothing was added, replaced, or overwritten.** and refreshes/decrypts the Directory. For create, rename, or move, it preserves the requested name and offers Refresh and retry, Rename, or Cancel. An Import revalidates the full plan, highlights changed collisions, and requires new review/confirmation.

### 6.2 Permissions matrix

| Capability | Owner | Directory read/write Grant | Directory read-only Grant | Direct File read/write Grant | Direct File read-only Grant | Complete active Public link |
| --- | --- | --- | --- | --- | --- | --- |
| Read private File/metadata in scope | Yes | Yes | Yes | Target File only | Target File only | No |
| Edit Markdown | Yes | Yes | No | Target File only | No | No |
| Create child File/Directory | Yes | Inside granted subtree | No | No | No | No |
| Rename/reorder/delete/move | Yes | Inside subtree, except shared root or move outside | No | No | No | No |
| Use Directory as Import target | Yes | Yes | No | No | No | No |
| Read/create Private Comments | Yes | Yes | Yes | Yes | Yes | No |
| Edit/delete own Private Comment | Yes | Yes | Yes | Yes | Yes | No |
| Hard-delete another author's Comment | Yes | No | No | No | No | No |
| Manage Shares | Yes | No | No | No | No | No |
| Manage Publication | Yes | No | No | No | No | No |
| Request Publication | N/A | Yes | Yes | Yes | Yes | No |
| Read Collaborators-only Public Comments | Yes | Yes | Yes | Yes | Yes | No |
| Read public-audience Public Comments | Yes | Yes | Yes | Yes | Yes | Yes |
| Post public-audience Comment | Yes, via device epoch envelope | Yes, via device epoch envelope | Yes, via device epoch envelope | Yes, via device epoch envelope | Yes, via device epoch envelope | Yes, signed-in private-capable Session holding the local fragment |
| Export content | Owned Files only | No shared-only content | No | No | No | No |

A Collaborator can edit or hard-delete only their own Comment. The Owner may hard-delete any Comment but may never edit another author's body.

### 6.3 Shares and Grants

- A Share targets either one Directory or one File and proposes `read_only` or `read_write` permission.
- A Share addresses an existing Account by its unique exact-match handle or opaque share identifier.
- A pending Share is unique per Owner, recipient, and target. The Owner may cancel it; the recipient may accept or decline it.
- Acceptance creates one active Grant per Owner, recipient, and target and provisions the required recipient-device Key envelopes.
- A Directory Grant covers the current subtree and future descendants.
- A direct File Grant follows File identity through Owner-controlled rename/move and exposes no path or parent.
- Direct File read/write permits Markdown edits, but never rename, move, delete, import targeting, or structural access.
- Overlapping Grants remain independent and are deduplicated when deriving effective authority.
- The Owner may change permission or revoke. A Collaborator may leave.
- Cancelled/declined Shares and revoked Grants are hard-deleted after any bounded security retention. The MVP has no historical sharing audit log.

### 6.4 Ownership of Collaborator-created content

A Directory read/write Collaborator may create content manually or through Import. Every created descendant belongs immediately to the target Directory's Owner. There is no Owner approval/notification workflow and no new Share, Grant, or ownership transfer. The initiating Collaborator reaches the new content through the existing Directory Grant.

### 6.5 Publications

- A Publication exposes exactly one File and is independent of Shares.
- Only the File Owner may create, configure, rotate, or unpublish it.
- An active Collaborator with File access may create one pending Publication request; the Owner may approve/deny it and the requester may cancel it. Denial or cancellation removes the pending request.
- At most one active-or-deleting Publication exists per File.
- A Publication follows File identity through rename/move and presents the latest successfully saved representation.
- A File editor updates the Public representation in the same conditional save as the private representation, without receiving the Public-link fragment.
- The Owner may opt into selected pseudonymous author attribution; attribution is off by default and is never inferred from edit activity.
- Public pages show rendered sanitized GFM and, if present, the File title. They do not show raw front matter, path/breadcrumbs, user-authored timestamps, or Owner identity.
- Public pages send `noindex`, `nofollow`, and `noarchive` directives.
- Deleting the File revokes and deletes its Publication as part of File hard deletion.

### 6.6 Comments

- Comments attach to stable File identity only.
- Every File has one Private thread. An active Publication has a separate Public thread.
- Threads are flat ordered lists. There are no replies, resolution/archive, reactions, attachments, mentions, embeds, or rich Markdown.
- A Comment is plain text with line breaks, at most 2,000 characters. HTML and Markdown are not interpreted.
- Every Comment displays the author's Public pseudonym.
- Authors may edit or hard-delete their own Comments only while they retain current thread access.
- There is no edit history or restore.

Public-thread audience behavior:

- New Publications default to `public` Comments.
- In `public`, anyone with the complete link can read public epochs. A signed-in link visitor posts through a private-capable, device-bound Session plus the locally held fragment capability; an unprovisioned Session cannot post. An eligible Owner/Collaborator device may instead read and post through its direct epoch envelope and authenticated File route without receiving or retaining that fragment.
- In `collaborators_only`, only the Owner and Accounts with effective File-read access can read/post through the authenticated File route.
- In Collaborators-only mode, an unauthenticated Public reader receives **Sign in to see or add comments if you have access to this file** and no thread ciphertext.
- Signing in without a qualifying Grant never reveals Collaborators-only ciphertext.
- The authenticated workspace can read retained authorized history through device envelopes and never receives a URL-fragment capability.
- Private Comments are never copied or exposed when publishing.

### 6.7 Public pseudonym

- Every Account has one Public pseudonym used in all Comments and optional Publication attribution. Its person writes it at signup and on each change, or keeps a suggestion such as “Quiet Heron 27”. The browser normalizes it (NFC, trimmed, single spaces) and accepts 2–32 characters without control, format, private-use or unassigned characters, keeping the zero-width joiners. It is not unique, and need not be identifying; the service only stores it encrypted, so it cannot check it.
- It is distinct from the share identifier/handle and authentication identity.
- It may be changed at most once every 30 days.
- A change runs as an exclusive browser-driven Pseudonym-update job across all encrypted attribution contexts. Normal work is blocked while the UI shows progress.
- All contexts retain the old pseudonym until every update succeeds and the new encrypted Account profile becomes current atomically.
- An enrolled device can resume an interrupted job. Cached copies and screenshots cannot be changed.

## 7. Workspace and route contract

### 7.1 Private routes and navigation

- Private File routes are `/f/:fileId`.
- Private Directory routes are `/d/:directoryId`.
- IDs are opaque; routes contain no plaintext name, path, or capability.
- Opening a File selects it and expands all ancestor Directories.
- Opening a Directory selects it.
- Other expanded/collapsed tree state is a local browser preference, not deep-link state.
- Inaccessible and deleted private objects receive the same non-revealing not-found treatment.
- A direct File Grant never reveals a parent route, path, siblings, or neighboring tree content.

The exact static prefix of the Public route is implementation discretion. Its path must contain only the opaque Publication identifier, and the read capability must be entirely after `#`.

### 7.2 Wide and narrow workspace

Wide layouts persistently show:

- the Files tree;
- breadcrumbs;
- Markdown editor; and
- live sanitized preview.

Narrow layouts use a tree drawer and mutually exclusive **Edit**, **Preview**, and—when available—**Comments** views. A File opens in Edit. Switching views never loses the in-memory draft. Exact breakpoints and splitter dimensions are visual-tuning choices.

There is no alternate desktop layout and no in-app document-tab strip.

### 7.3 Saving and conflicts

- Editing autosaves after a 750 ms debounce.
- There is no primary Save button.
- `Cmd/Ctrl+S` immediately flushes a pending save.
- The File header displays **Unsaved**, **Saving**, **Saved**, or **Couldn't save**.
- Navigation first tries to flush a pending save.
- Close/reload warning appears only while a save is pending/unsaved or failed.
- Drafts live only in the current browser tab.

Same-browser tabs coordinate one editing lease per File:

1. The first editing tab owns the lease.
2. Another tab opens read-only.
3. **Edit here** requests transfer.
4. The current owner must save or explicitly discard pending work before transfer.
5. The prior owner then becomes read-only.

Every save supplies the revision that produced the draft. A stale revision stops autosave, preserves the local draft, and presents:

- reload and discard local draft;
- copy local draft; or
- explicitly confirm overwrite.

There is no automatic merge or silent last-write-wins.

A Current File representation is one bounded private encrypted payload; mdwn does not chunk normal Files in the MVP. Markdown source is at most **262,144 UTF-8 bytes (256 KiB)** before encryption for creates, edits, pastes, imports, and Replace candidates. The browser measures source bytes before encryption and after decryption, shows `bytes / 262,144` from **235,930 bytes (90%)**, and announces **File limit reached** at the limit. A keystroke, composition result, paste, or conflict-overwrite proposal that would exceed the limit is rejected as one whole edit, never truncated; the previously valid in-memory draft remains intact.

Valid drafts keep the 750 ms autosave and immediate `Cmd/Ctrl+S` flush behavior. A rejected prospective edit makes no save attempt. A locally held oversized legacy File or conflict draft shows **Couldn't save** with copy/download, reload/discard, and reduce-content choices; navigation/reload continues to warn while it is unsaved or failed. A legacy oversized File remains readable and exportable, but cannot save or confirm a conflict overwrite until reduced within the limit. A within-limit Import Replace may replace that File's current representation while retaining its identity, Comment threads, and active Publication; an over-limit candidate changes nothing.

### 7.4 Contextual actions and Comments

- A File Owner sees **Share** and **Publish** next to the File title.
- A Directory Owner sees **Share** in its contextual header/menu.
- A Collaborator sees **Request publication** instead of Publish.
- Share and Publish panels preserve the selected workspace context.
- Wide layouts switch the right preview pane to the Comment inspector.
- Narrow layouts use the Comments content view.
- The authenticated composer sits at the bottom of the selected thread.
- **Private** is the default authenticated thread. **Public** appears only for an active Publication and states `Public` or `Collaborators only` audience.
- The two threads load through separate endpoints and are never combined.
- A read-only Collaborator sees **Read-only — you can comment** and retains the normal Private composer.
- A Public reader sees only eligible public epochs under the rendered document, with no Private/Public selector.

### 7.5 Import and export entry points

- **Import** and **Export** live in the Files chrome.
- Import drag-and-drop targets eligible Directories.
- An Import target is initially selected only when the current context is an eligible Directory or a File within one. A direct File Grant never reveals or infers a parent Directory as a target.
- A drop in any other context is rejected before review and prompts the Account to choose an eligible Directory.
- Both the Import command and a valid drop open the settled preflight/review flow rather than inserting content into the editor.
- Export exposes **Export my Files** plus selected owned File/Directory export under the ownership boundary in section 9.7.

## 8. Persistence contract

Physical table factoring may vary only if all relationships, constraints, visibility rules, and transaction boundaries below remain enforceable. Opaque internal IDs may use an implementation-selected collision-resistant `TEXT` encoding; application-visible Account, File, and Directory IDs are canonical UUIDv7 `TEXT` values.

### 8.1 Storage conventions

- Public path identifiers are independent 256-bit random base64url values and are never reused.
- Server timestamps, monotonic revisions, counters, and epochs use `INTEGER`.
- Ciphertext and `mdwn/enc-v1` envelopes use `BLOB`.
- Each decoded binary private or Public representation payload—including `mdwn/enc-v1` framing and encrypted File metadata—is at most 524,288 bytes (512 KiB). D1 stores the decoded BLOB, never a base64 encoding; both representation tables enforce `ciphertext BLOB NOT NULL CHECK (length(ciphertext) <= 524288)`, and the Worker validates the same bound.
- D1's documented 2 MB row/string/BLOB ceiling never becomes a product limit: every Import staging and canonical encrypted field has a smaller binary BLOB/count bound enforced by browser validation, Worker validation, and D1 `CHECK`/aggregate constraints. Raw ZIPs, Archive manifests, and Historical-Comment sidecars are never persisted as a single encrypted or plaintext field.
- Foreign keys use `ON DELETE RESTRICT`.
- `CHECK` constraints and partial unique indexes enforce row-local state.
- No table contains plaintext Markdown, File/Directory name, Comment body, displayed pseudonym, front matter, user-authored timestamp, or private ordering.

### 8.2 Required relational records

#### Accounts and authentication

- `accounts`: Account ID, unique opaque share identifier, optional unique normalized share-handle lookup token, and server lifecycle timestamps. No email, password, plaintext handle, or plaintext pseudonym.
- `account_profiles`: encrypted current Account-facing profile, revision/epoch, and lifecycle data.
- `passkeys`: Account, credential identifier/public material, signature counter, backup/sync metadata, and lifecycle state.
- `webauthn_challenges`: purpose, challenge material/digest as required by the library, expiry, and one-use state; delete after ceremony.
- `recovery_codes`: Account/set association and one-way code hash; consume by deletion.
- `sessions`: opaque session identity, Account, purpose (`normal` or restricted `recovery`), associated credential where applicable, an optional exact active Encryption-device binding for private-capable normal Sessions, idle/absolute expiry, and revocation state.
- `security_events`: only the bounded fields allowed in the abuse policy.

#### Encryption identities and work

- `encryption_identities`: Account encryption public identity plus current device-registry lifecycle/epoch.
- `encryption_devices`: Account/device HPKE transport and device-assertion signing public keys, active/revoked/tombstoned state, opaque approval provenance (`signup` for the first device), registry epoch, Vault-root-encrypted optional label, creation time, coarse last-successful-device-proof time, and server lifecycle metadata. It contains no browser/OS, user-agent, network, or fingerprint data.
- `device_enrollments`: short-lived one-use Account/candidate-normal-Session-bound routine-enrollment record with candidate device ID, exact canonical public-key transcript/digest, pairing-secret hash, expected registry epoch, approval/envelope and HPKE-challenge state/digests, expiry, and consumed lifecycle state. It contains no raw pairing secret, plaintext label, private key, Vault key, or capability.
- `device_proof_uses`: short-lived opaque consumed proof IDs plus the minimum binding/expiry state needed to reject mutation/security-action replays; read-only proofs have no row.
- `recovery_capsules`: Account, current recovery generation, public recovery salt, opaque versioned capsule ciphertext/metadata, and the matching P-256 recovery-verification public key. It never contains a recovery phrase or plaintext key.
- `recovery_enrollments`: short-lived one-use Account/normal-Session-bound recovery start, current generation, expected device-registry revision, opaque nonce, expiry, and consumed state. It contains no phrase, private key, or plaintext content.
- `key_envelopes`: protected object/key identity, purpose, recipient/parent identity, epoch, envelope version/ciphertext, and current/superseded lifecycle state, including `vault-recovery` envelopes for Account-owned roots.
- `provisioning_needs`: opaque active-Grant/new-or-replacement-device provisioning need whose resolution authorizes an existing capability holder to envelope current Grant/Comment material; it contains no object name, plaintext, or capability.
- `crypto_jobs`: opaque browser-driven Key-rotation, Pseudonym-update, or post-enrollment/recovery owned-key-provisioning job, bounded cursor/progress, initiating/authorized Account, target/epoch, and lifecycle state. It contains no plaintext key/content.

#### Private hierarchy

- `vault_nodes`: node ID, `directory | file` kind, Owner Account, nullable parent node, nullable immutable Import ID, and lifecycle metadata.
- `directories`: Directory node key and monotonic `entries_revision`.
- `files`: File node key, current representation pointer/revision, and File capability identity/epoch; an explicitly legacy File has no File capability until browser conversion.
- `directory_entries`: one current parent/child edge with encrypted display name and ordering plus the parent capability's envelope for the child Directory or File capability. Legacy Files retain parent-wrapped content keys until conditional browser conversion.
- `file_representations`: one decoded encrypted private Markdown/File-metadata payload, content-key/epoch identity, bounded File-capability-wrapped content-key envelope, signed File head, ciphertext size, revision, and lifecycle metadata. It has no chunk or manifest rows, and its stored BLOB is at most 524,288 bytes. The browser measures decrypted source against 262,144 UTF-8 bytes; an over-limit legacy source remains readable/exportable but is ineligible for save or conflict overwrite until reduced within the limit.

Required constraints:

- each Account has exactly one parentless hidden root Directory, enforced by a partial unique index;
- a parent is a Directory;
- parent and child have the same Owner;
- the graph has no cycles;
- `vault_nodes.parent_node_id` agrees with its `directory_entries` edge;
- `files.current_representation_id` identifies exactly the representation for its current revision;
- private and Public representation ciphertext fields are `BLOB NOT NULL CHECK (length(ciphertext) <= 524288)`; and
- normal reads exclude uncommitted imported records.

Because names are encrypted, namespace uniqueness is enforced by browser precondition plus the parent Directory's conditional `entries_revision`, not by a server plaintext/deterministic-name index.

#### Account sharing

- `shares`: Owner, recipient Account, target node/type, proposed permission, and pending lifecycle data. A pending row is unique per Owner/recipient/target.
- `grants`: Owner, recipient Account, target node/type, active permission, and lifecycle/epoch data. An active row is unique per Owner/recipient/target.

Effective File access uses a bounded indexed recursive CTE over ancestor Directories plus exact direct File Grants. The query derives the strongest Markdown permission and independent Boolean `can_read_private_comments` / `can_read_collaborators_public_comments` authority.

#### Publications

- `publications`: File, Owner, `active | deleting` state, active link/current Public-representation pointers while active, current Comment audience, and lifecycle timestamps.
- `publication_links`: active opaque path ID and public encryption key; no fragment capability.
- `public_representations`: one decoded encrypted current presentation payload, revision/epoch, ciphertext size, and lifecycle data, with the same 524,288-byte BLOB bound as a private representation.
- `publication_requests`: requester, File, and pending lifecycle; one pending request per Collaborator/File.
- `publication_authors`: selected Account and encrypted attribution declaration for the Publication.
- `publication_teardowns`: sealed Publication/Owner reference and bounded deletion cursor/progress only.

A partial unique constraint allows at most one active-or-deleting Publication per File. A deleting Publication is sealed and can never become active again.

#### Comments

- `comment_threads`: exactly one Private thread per File and one Public thread per logical Publication.
- `comment_thread_epochs`: Public thread, immutable `public | collaborators_only` audience, key epoch, order, and lifecycle state. The Private thread also tracks its current key epoch in a constrained representation.
- `comments`: thread, audience epoch when Public, opaque author Account, encrypted plain-text body and displayed pseudonym, server ordering sequence/timestamps, ciphertext size, and lifecycle metadata.
- `thread_attributions`: encrypted current pseudonym declaration and matching author/device envelope relationship for a thread scope.

No Comment table stores plaintext or moderation-searchable text.

#### Import

- `import_sessions`: unguessable ID, initiating Account, target Directory, expected target Owner, reviewed target revision, expiry/state, aggregate counters, and one binary encrypted Import staging manifest of at most **131,072 bytes (128 KiB)** with its SHA-256 digest. The manifest binds the reviewed plan, expected chunk/record counts, chunk digests, and aggregate digests; it contains no raw Archive manifest, Markdown, sidecar, plaintext name, or capability.
- `import_chunks`: `(import_id, sequence)` is unique; sequence is 0-based and below 40. Each row holds one raw binary encrypted payload of at most **524,288 bytes (512 KiB)**, its 32-byte SHA-256 digest, and 1–50 complete canonical-record descriptors. A session accepts **1–40** chunks and at most **20,971,520 bytes (20 MiB)** of chunk payload / **2,000** descriptors in aggregate.
- A descriptor contains only record kind, opaque fixed-size IDs/references, offset, length, and digest. Each canonical encrypted payload occupies exactly one descriptor range; a maximum-size representation may occupy a whole chunk. There is no free-form descriptor, metadata, retry, JSON, or base64 field that can carry additional content.
- `import_commits`: immutable Import ID visibility marker and commit metadata. Every canonical staged record carries that immutable Import ID; every normal tree/File/direct-read/Share/export/count/background query requires either a non-Import record or a matching commit marker.
- The portable `.mdwn/manifest.json` and `.mdwn/private-comments.json` remain local input. The browser parses the former into the staging manifest and the latter into individual Historical Comment records; neither sidecar/archive value is uploaded as one logical or physical field. An Import creates at most **1,000 Historical Comments**; the 1,001st, malformed record, or oversized record rejects the entire Import without omission.

Every encrypted canonical Import field is decoded binary bytes including `mdwn/enc-v1` framing and must fit one of these D1-enforced limits:

| Canonical encrypted value | Maximum decoded binary bytes |
| --- | ---: |
| Private File representation (and Public representation infrastructure) | 524,288 (512 KiB) |
| Directory-entry display-name/order ciphertext, excluding its Key envelope | 4,096 (4 KiB) |
| Key envelope ciphertext | 16,384 (16 KiB) |
| Historical Comment body ciphertext | 16,384 (16 KiB) |
| Historical Comment attribution/displayed-pseudonym ciphertext | 4,096 (4 KiB) |
| Any other Import-created auxiliary encrypted record | 16,384 (16 KiB) |

Schema `CHECK` constraints mirror every field bound above. `import_sessions` constrains the manifest, chunk/count aggregates, and Historical-Comment count; `import_chunks` constrains sequence, payload, descriptor count, and digest length. The Worker, not the client, conditionally maintains aggregate counts/bytes. A new encrypted Import field type needs its own decided bound; it cannot use an unbounded auxiliary-metadata exemption.

#### Abuse controls

D1 must persist the following logical records, whether in one or several physical tables:

- rolling-window counters keyed by purpose, scope (`global`, Account, Publication, Account+Publication, Session, recovery identifier, or Network bucket), time epoch, count, and expiry;
- category-only Public Comment reports keyed to reporter Account and opaque Public Comment ID;
- temporary Public-participation suspension start/end and fixed reason metadata; and
- bounded Security events.

No abuse-control record contains content, a fragment/capability, raw IP, full URL, headers/body, cookie/session token, credential payload, user agent, or behavioral fingerprint.

### 8.3 Required transaction boundaries

#### Signup bootstrap

One short D1 transaction verifies the transcript-bound registration challenge and the `mdwn/signup-device-binding/v1` statement, then creates all-or-nothing: the Account, first passkey, encryption identity/device registry at epoch 1, first active Encryption device with `signup` approval provenance, both initial Key envelopes, generation-1 Recovery capsule, authentication recovery-code set, and a normal Session already bound to that exact device. It creates no `crypto_jobs` row or provisioning need. Any failure creates no partial Account.

#### Structural mutation

A create, rename, reorder, delete, or move transaction:

1. checks current authorization and expected source/destination Directory revisions;
2. validates node kind, same-owner containment, cycle prevention, and movement restrictions;
3. changes `vault_nodes.parent_node_id` and `directory_entries` consistently;
4. updates any required capability envelopes/rekeying; and
5. increments every affected Directory's `entries_revision`.

#### File save

Before submission, the browser checks the 262,144-byte UTF-8 Markdown source bound. After decryption it measures the source too: an over-limit legacy representation remains readable/exportable but cannot save or confirm a conflict overwrite until reduced within the limit. The Worker independently rejects an oversized decoded representation BLOB, and D1 enforces the 524,288-byte `CHECK` bound. A File save transaction:

1. checks current effective write authority, expected File pointer/revision, current File capability identity/epoch, and absence of a pending-rotation write seal;
2. validates every submitted private/Public representation payload, the fresh content-key identity/epoch and the device-signed File head before inserting a fresh private representation;
3. installs its content-key envelope under the unchanged File capability; ordinary saves neither change a Directory listing nor replace recipient-device Grant envelopes;
4. when a Publication is active, conditionally installs the matching freshly encrypted Public representation in the same operation;
5. conditionally swaps both current pointers/revision; and
6. removes the superseded private/Public representation after it is no longer referenced.

A malformed, oversize, or stale save changes no current pointer or revision and leaves no partial private/Public update. A stale revision returns the conflict needed by the UI. Direct File editors require no parent capability or listing, even when a separate inherited Directory Grant is read-only. New Files use this format. An authorized browser converts a legacy File by wrapping its existing content key beneath a random File capability and replacing the parent edge/signed listing atomically, pinned to the original File pointer/revision and Directory revision. Conversion preserves content ciphertext and does not complete access-driven rotation. Until conversion, legacy parent-listing saves remain supported only with Directory write authority; legacy direct editing fails closed. See [ADR-0008](adr/0008-parent-free-file-capabilities.md).

#### Share acceptance/revocation

Acceptance verifies pending state and recipient, creates/activates the Grant, and installs constrained recipient-device envelopes. Revocation/leave removes server authority and supersedes affected envelopes in a short transaction, advances the relevant epoch, cancels any affected provisioning need, and starts required browser-driven rotation.

#### Recovery enrollment

A recovery start creates only an expiring, one-use record bound to the live normal Session, capsule generation, and device-registry revision. Its final transaction requires the recent Passkey assertion, exact candidate keys/capsule digest, current generation/revision, recovery-enrollment signature, and HPKE/device-possession proof. It then atomically consumes the record, activates the candidate device and initial Vault-root envelope, rotates capsule/verification material and the registry epoch, tombstones all prior Encryption devices and their device envelopes, revokes all other Sessions, creates the recovering browser's fresh normal Session, and records a bounded Security event. Follow-up owned-key provisioning is an idempotent `crypto_jobs` process and cannot grant a device authority before this commit.

#### Routine device enrollment

A routine-enrollment final transaction verifies the live candidate Session and fresh assertion; unused/unexpired enrollment and challenge; byte-exact candidate keys/transcript, pairing-secret hash, approval/envelope digests, possession signature, expected registry epoch, and active approving device/Device proof. It then atomically consumes the one-use state, activates only the proven candidate, persists its initial `device-enrollment` Vault-root envelope and encrypted label metadata, advances the registry epoch, replaces the unbound candidate Session with a device-bound normal Session, and creates idempotent non-authorizing provisioning work. Any failure leaves no active candidate.

#### Device removal

A removal transaction requires a different active initiating device, fresh Passkey assertion, current consumed Device proof, expected registry epoch, and destructive confirmation of the decrypted target label. It rejects self/last-device removal. It atomically tombstones only the target device, revokes its Sessions, supersedes its device-targeted envelopes, cancels its pending enrollment/challenge state, advances the registry epoch, and records a bounded Security event; it does not rotate broader content or Grant keys.

#### Comment mutation

Every read/create checks active thread/Publication state, current audience authorization, and epoch. Edit/delete additionally checks author identity; Owner hard-delete is the only author exception. Public participation counters are consumed atomically with accepted Public Comment create/edit/report operations.

#### Pseudonym update

All encrypted attribution updates are staged/resumable under one exclusive job. The Account profile pointer changes only after every required context is ready, producing all-old or all-new displayed pseudonym state.

#### Unpublish seal

The initial short transaction verifies Owner authority, obtains the opaque Public Comment count for confirmation, removes the active link, changes the Publication irreversibly to `deleting`, and creates teardown progress. All Public routes and Public-thread endpoints deny access thereafter.

#### Hard deletion

File and bounded Directory deletion explicitly enumerate and remove dependent envelopes, Shares/Grants, representations, Publication data, Comments, entries, and nodes in dependency order. No generic cascade stands in for authorization or lifecycle checks.

### 8.4 Query and index requirements

- Child traversal indexes begin with `parent_node_id`.
- Active-Grant lookup indexes support exact target and recipient plus ancestor-recursive access checks.
- Publication path lookup is unique and reveals no retired link state.
- Current representation, current epoch, pending Share/request, active-or-deleting Publication, current recovery capsule/device registry, unexpired session/challenge/routine-or-recovery-enrollment/import, consumed mutation-proof, outstanding provisioning need, and counter-window lookups have covering indexes appropriate to their hot path.
- Representative tree/access queries are validated with `EXPLAIN QUERY PLAN`.
- Recursive traversal and deletion are explicitly bounded.

## 9. Core user and system flows

### 9.1 Create, rename, move, and delete content

- The browser chooses opaque IDs, encrypts names/order and capabilities, and submits expected Directory revisions.
- Every private name and source path uses the `mdwn/namespace-v1` Unicode-17 canonicalization, segment profile, and browser-only comparison-key contract in section 6.1.
- A locally visible collision is presented as a name conflict. A concurrent structural change returns nameless `409 namespace_changed`, makes no mutation, and refreshes/revalidates before a user may retry; neither the Worker nor a client silently chooses a suffix or overwrites.
- A Directory Collaborator may mutate only inside a read/write granted subtree, cannot delete the shared root, and cannot move content outside it.
- Cross-owner moves are rejected.

File hard deletion explicitly removes its Directory entry, private representations, Key envelopes, Shares/Grants, Publication requests/links/representations/teardown state, and both Comment threads before the node.

Directory hard deletion:

1. enumerates and authorizes the full subtree;
2. proceeds only when it contains at most 500 nodes;
3. explicitly removes every dependent graph record in one transaction; and
4. leaves all data unchanged when over the cap.

### 9.2 Share a Directory or File

1. Owner selects Share in the current context.
2. Resolve the recipient by exact unique handle or opaque identifier without discovery.
3. Owner selects read-only/read-write and sends the pending Share.
4. Recipient accepts or declines.
5. On acceptance, current recipient devices receive purpose-bound envelope material.
6. The active Grant controls server access; cryptographic material alone is insufficient.
7. New Directory descendants inherit access through the Directory capability.
8. Owner permission change/revoke or Collaborator leave updates authorization immediately and starts required rotation.

A newly eligible device may display **secure access is being prepared** while an already authorized browser provisions retained Comment/Public-history envelopes. It must not fall back to a Public-link fragment or service-held key.

### 9.3 Publish and update a File

1. Owner opens Publish.
2. Browser creates the Publication capability/path material and encrypted Public representation.
3. Owner selects optional pseudonymous authors and initial/default public Comment audience.
4. Service atomically creates the active Publication records.
5. Any authorized File editor subsequently creates both private and Public representations and saves them under one File-revision condition, using the stored public encryption key rather than the fragment.
6. A Public reader requests only the opaque path, decrypts locally from the fragment, and renders sanitized GFM.

A Collaborator's Publication request never creates public access until Owner approval.

### 9.4 Rotate a Public link

1. Owner browser creates a fresh path identifier/capability.
2. It rewraps all public Comment epochs for the new capability.
3. One transaction installs the new active link and removes old routing.
4. The old path immediately returns a ciphertext-free `404`.
5. The logical Publication, current Public representation, and Public Comment thread/history remain.

### 9.5 Change Public Comment audience

- `public -> collaborators_only`: stop anonymous thread delivery immediately and create a fresh device-enveloped epoch.
- `collaborators_only -> public`: create a fresh public epoch wrapped to the Publication capability and eligible devices.
- Prior Collaborators-only epochs are never returned by the anonymous route.
- Eligible authenticated Accounts retain authorized history across epochs.

### 9.6 Unpublish

1. Publish panel states the irreversible effect and current opaque Public Comment count, for example **Unpublish and permanently delete 12 Public Comments**.
2. Owner confirms.
3. The seal transaction removes the link and denies every anonymous/authenticated Public route.
4. The Owner's browser drives idempotent bounded deletion batches for the Public representation, thread/epochs/Comments, envelopes, attribution, requests, teardown state, and Publication row.
5. UI shows **Deleting public material…** and progress. Only the Owner may resume after interruption.
6. No new Publication is allowed until cleanup completes.
7. A later Publication is entirely fresh.

Public-participation limits must never block this flow.

### 9.7 Export

- **Export my Files** includes every File owned by the current Account.
- A selected owned File or owned Directory may also be exported.
- Shared-only content is never included, even as a static copy.
- The browser decrypts locally and creates one ZIP without sending plaintext to the service.
- Directory hierarchy is mirrored with UTF-8 `.md` files containing exact Markdown source. YAML front matter remains uninterpreted source.
- `.mdwn/manifest.json` is versioned and identifies roots/format without live authority.
- `.mdwn/private-comments.json` preserves historical Private Comment text, order, timestamp, and displayed Public pseudonym for exported owned Files.
- Public Comments and all Publication state are omitted.
- Shares, Grants, capabilities/keys, credentials/recovery material, sessions, service IDs, and local drafts are omitted.

### 9.8 Import

Accepted input:

- a recognized mdwn ZIP archive; or
- one or more UTF-8 `.md` / `.markdown` files and folders.

A selected folder becomes a child Directory and preserves hierarchy. Unsupported inputs fail before upload.

#### Bounds

- At most 100 normalized source File/Directory nodes; skipped/replaced collision candidates still count.
- At most 32 normalized Directory segments in a source path.
- At most 256 KiB (262,144 UTF-8 bytes) per Markdown source.
- At most 8 MiB (8,388,608 bytes) compressed for a recognized archive.
- At most 16 MiB (16,777,216 bytes) expanded for every selection; manifests and Private-Comment sidecars count.
- Loose input has no compressed allowance and uses the same expanded limit.
- At most 1,000 Historical Comments may result from the local sidecar. Every source byte still counts toward the expanded-input limit.

#### Preflight and review

Before opening an Import session or uploading anything, the browser validates format/manifest, UTF-8, safe source paths, the exact `mdwn/namespace-v1` segment profile, duplicate normalized paths, node/depth/source/archive/expanded-input limits, Historical-Comment count, and every collision choice. It then constructs the complete encrypted record/chunk plan and measures every canonical field, descriptor count, chunk, staging manifest, aggregate payload, and digest. A nonconforming plan creates no session and uploads nothing.

The review displays source count, create/replace/skip counts, maximum depth, compressed/expanded sizes, target, and every generated Keep-both name. Collisions never overwrite silently:

- **Keep both** uses the deterministic reservation, sort, suffix, and availability algorithm in section 6.1; it never repairs a duplicate source path.
- **Skip** omits the candidate.
- **Replace** updates an existing File's current representation and preserves its existing Private/Public threads and active Publication.
- Directories never silently merge. A generated name that exceeds the segment profile requires Rename, Skip, or an authorized File Replace; it is never truncated.

Unsupported, invalid, or oversized input identifies the safe local item/problem and configured limit where relevant, uploads nothing, creates no File, and suggests remove/fix, re-export, or split-and-retry. No valid subset is automatically imported.

#### Target and ownership

- An Import target is an owned Directory or a Directory reached by a current read/write Directory Grant.
- A direct File Grant or read-only Directory Grant is never eligible.
- The review explicitly states when new nodes will belong to another Account and will not appear in **Export my Files**.
- Every new node belongs to the target Directory Owner.
- Replace is available to a Collaborator only for a File inside an eligible read/write Directory target.

#### Private staging and visible-atomic commit

1. Confirmation creates an unguessable, initiating-Account-bound Import session with 24-hour expiry and the browser's encrypted staging manifest (at most 128 KiB), its digest, expected record/chunk counts, and aggregate digests.
2. The browser uploads **1–40** raw binary encrypted chunks. Each is at most 512 KiB, has a 32-byte SHA-256 digest, and contains 1–50 typed complete-record descriptors; session chunk payloads total at most 20 MiB. A normal maximum-size Current File representation fits one chunk without a content wrapper or fragmentation.
3. The Worker rejects an excessive declared length and streams/counts the raw body before buffering it. Without decrypting private content, it validates binary envelope/header, descriptor kind/range/count, opaque references, digest, per-field limit, session state, and authorization. It persists no plaintext path, name, Markdown, Comment, capability, raw Archive manifest, raw ZIP, sidecar, free-form metadata, or alternate base64/JSON payload.
4. The only retry identity is `(import_id, sequence, SHA-256(payload))`. The exact same bytes return the original success without duplicate records; a different body/digest for an accepted sequence permanently fails that session, requiring a new preflight/session for a changed or re-encrypted plan.
5. Before commit, recheck initiator, target Owner, current target authority, expiry, every expected sequence/digest/count exactly once, structural/key constraints, collision actions, canonical field bounds, and reviewed revisions. A stale target/Grant/Owner/revision returns to review and creates no commit marker.
6. The final small transaction writes the immutable commit marker. Every normal query's commit-marker predicate makes the complete hierarchy and any authorized Replace visible together; a staged Replace leaves the old representation current until that marker exists.
7. Cancelled, expired, disconnected, mismatched, or failed sessions create no visible content and are cleaned up. Imported historical Private Comment data starts in a fresh thread as historical display data; it does not reinstate former capabilities or author mutation authority.

A disposable remote Workers Free + D1 proof is a release gate for this plan. It must validate exact and one-unit-over limits, retries/mismatches, expiry/failure/stale-authority cases, no-visible-partial-tree behavior, and that every permitted worst-case upload/commit fits the 50-statement D1 Free invocation limit. If the proof fails, reduce the bounded plan or make it more efficient; never silently require a paid plan.

### 9.9 Recover Vault content onto a replacement Encryption device

1. The Account establishes a live normal Session with a fresh Passkey assertion. If necessary, it first uses a recovery code to enroll a replacement Passkey and then makes that fresh assertion.
2. The browser starts the rate-limited ceremony and receives the opaque Recovery capsule. It validates the 24-word phrase and opens the capsule locally; neither phrase nor plaintext key reaches the service.
3. The browser creates the candidate transport/device-assertion key pairs, signs the exact enrollment intent with the capsule's recovery-enrollment key, completes the bound HPKE/device-possession challenge, and prepares a rotated replacement phrase/capsule.
4. The atomic commit activates only the proven candidate device, rotates recovery material and the device registry, tombstones former devices, revokes other Sessions, and creates the recovering browser's fresh Session. It does not re-encrypt the Vault.
5. The replacement device traverses owned material from its Vault-root/recovery envelopes and resumes idempotent provisioning. It can read neither content nor Comment material received solely through another Account's Grant until an authorized source browser fulfills the opaque provisioning need.
6. The UI distinguishes **Restoring your Files securely…** for owned-key work from **Shared content is being securely provisioned** for Grant-derived content. Failed or interrupted starts expose no candidate device; revoked/expired Grants never provision after recovery.

### 9.10 Add an Encryption device

1. On the candidate browser, the Account makes a fresh Passkey assertion, creates an unprovisioned normal Session, generates its two candidate key pairs, opaque device ID, pairing secret, and optional label, then sees **Scan this QR code**.
2. The person scans the QR from an existing active device. The approver locally verifies the candidate transcript and pairing-secret hash against the pending record, makes its own fresh Passkey assertion and Device proof, creates the candidate-specific Vault-root envelope, and signs the canonical approval. The candidate shows **Waiting for approval**.
3. The service verifies the active approver/current epoch, then sends the candidate's one-use HPKE challenge. The candidate proves possession with its assertion key. Exact binding and one-use checks reject substituted material or a stale/replayed ceremony without activation.
4. The atomic commit activates the candidate only, advances the registry epoch, binds its Session, and starts idempotent provisioning. It does not revoke other devices or rotate recovery material. The candidate can recover owned material through its Vault-root envelope; it shows **Setting up your Files securely…** while remaining owned envelopes are created and **Shared content is being securely provisioned** while any Grant holder provisions current shared material.

### 9.11 Remove an Encryption device

1. From a different active device, the Account makes a fresh Passkey assertion, refreshes its Device proof, selects a decrypted device label, and explicitly confirms removal at the current registry epoch.
2. The atomic operation rejects self or last-device removal; otherwise it tombstones only the target, revokes only target-bound Sessions, supersedes its device envelopes and pending enrollment state, and advances the registry epoch.
3. Other active devices refresh their proof before later private operations. Removal does not erase data already cached by the target or rotate broader Vault/File/Grant keys; it prevents future private reads and mutations. Ordinary sign-out remains non-destructive, and an Account without another active device uses Vault recovery instead.

## 10. Abuse, rate limits, and operational data

### 10.1 Infrastructure posture

- Workers Free plus D1 Free only.
- No automatic paid upgrade, Durable Object counter service, Turnstile, CAPTCHA, tracking, or visitor-identifying cookie.
- One Free WAF rule is a coarse registration-route circuit breaker: 30 requests per 10 seconds with 10-second mitigation.
- D1 application checks are the policy source of truth.
- Registration and Public Comment forms each contain one static, genuinely hidden, non-autofillable honeypot. A non-empty value creates no Account or Comment, produces only a generic failure, and is neither logged nor persisted; if an operational event is necessary, it records only `honeypot-filled`. Do not use CSS-only/focusable traps, dynamic tracking fields, or honeypots on sign-in/recovery.

### 10.2 Rolling-window limits

Check the global bucket first so a rejected request does not create a Network-bucket row.

| Surface | Limits |
| --- | --- |
| Registration challenge | Network: 3 / 15 min, 10 / 24 h; global: 30 / 10 min |
| Successful registration | Network: 2 / 24 h; global: 100 / 24 h |
| WebAuthn sign-in ceremony | Network: 10 / 15 min, 50 / 24 h; Account once known: same; global: 120 / 10 min |
| Recovery ceremony/code attempt | Network and recovery identifier: 3 / h, 10 / 24 h; global: 30 / 10 min |
| Session refresh | 12 / h per Session |
| Public Comment create/edit | Account: 5 / 10 min, 30 / 24 h; Publication: 10 / 10 min, 100 / 24 h; Account+Publication: 3 / 10 min, 20 / 24 h; Network: 10 / 10 min, 50 / 24 h; global: 30 / min, 300 / 24 h |
| Public Comment report | 3 / 24 h per Account |
| Publication create/rotate | 5 / 24 h per Account |

A Network bucket is a purpose/time-epoch-scoped HMAC of normalized edge IP using a rotatable key. Discard raw IP immediately. Counter rows expire within 24 hours.

Rate/quota denial returns a generic `429` with `Retry-After` without confirming Account/recovery-record existence. The browser retains an unsent Comment draft.

### 10.3 Logging and retention

- One-use challenges live at most 10 minutes.
- A Security event may contain timestamp, action class, allow/deny reason, necessary opaque Account/Publication ID, fixed size class, proof/counter state, retry time, and short-lived Network bucket.
- Security events are operator-only, automatically purged, and retained at most 30 days.
- Purging is covered by a scheduled integration test or operational verification.

### 10.4 Public abuse response

- File Owner hard deletion is the primary unwanted-Comment control.
- A signed-in Account may submit a rate-limited category-only report for an opaque Public Comment ID. It conveys no plaintext and grants no content access.
- Repeated technical abuse or metadata-supported report patterns may trigger a Public-participation suspension: seven days initially, 30 days for a repeat.
- A suspension blocks Public Comment posting and Publication create/rotate only. It preserves private Files, Shares, export, recovery, ownership, hard deletion, and unpublishing.
- Suspensions expire automatically. The operator may correct an evident metadata-supported mistake.
- There is no permanent Account deletion, private-vault lockout, plaintext moderation, or formal appeal process in the MVP.

## 11. Deletion and retention behavior

### 11.1 Hard-deletion guarantees

Hard deletion removes application-level live records and leaves no app-visible trash/archive/restore path. It does not recall client downloads or make a guarantee about provider-managed backup erasure timing.

- File deletion is explicit and includes all private/public/comment/share/key dependents.
- Directory deletion is all-or-nothing up to 500 nodes.
- Over-cap Directory deletion changes nothing and directs the user to reduce the subtree; resumable large deletion is outside the MVP.
- Publication unpublish seals synchronously and tears down in bounded Owner-browser batches.
- Cancelled/expired Import sessions become unreachable and are purged.
- One-use WebAuthn challenges and recovery codes are deleted on use.
- Short-lived counters and Security events expire under the bounds above.

### 11.2 Data that intentionally persists

- Current ciphertext and metadata required for active Files, Shares, Grants, Publications, Comments, sessions, and imports.
- Server timestamps and bounded revisions/epochs required for consistency.
- Provider-managed D1 rollback data for its normal Time Travel window.
- Plaintext/capabilities already downloaded by authorized clients remain outside server recall.

## 12. Acceptance criteria

The MVP is conformant only when automated tests plus required manual/security checks demonstrate all of the following.

### 12.1 Privacy and cryptography

- No private name, Markdown, front matter, Comment body, or displayed pseudonym reaches Worker/D1 plaintext in integration tests.
- Passkeys cannot derive/decrypt content.
- Shared/public/private envelope contexts reject cross-purpose, cross-object, stale-epoch, malformed, and downgrade attempts.
- Nonce uniqueness strategy survives concurrent tabs, devices, retries, and interrupted jobs.
- Public fragments never appear in requests, logs, errors, analytics, referrers, or server state.
- Anonymous routes never return private or Collaborators-only ciphertext/envelopes.
- Cross-browser vectors cover encryption/decryption, device approval, sharing, rotation, and Publication reading.
- Chromium, Firefox, and WebKit prove the full normal-authentication-plus-phrase recovery path without exposing the phrase or plaintext keys to requests, service state, logs, or telemetry; recovery-code-only access cannot read content before replacement-Passkey enrollment, a fresh assertion, and Vault recovery.
- Those recovery tests reject substituted candidate keys, stale capsules/generations, replayed nonces, missing transport/signing private keys, stale Sessions, and missing fresh assertions; prove all old devices/Sessions revoke atomically; distinguish a pre-commit crash from resumable post-commit provisioning; and prove Grant-derived content remains unavailable until active-Grant provisioning and never provisions after revocation.
- Chromium, Firefox, and WebKit prove that a browser authenticated by a synced passkey cannot access private content before QR-approved routine enrollment; then prove multiple normally enrolled devices and their device-bound Sessions coexist with Account-owned and provisioned Grant authority.
- Routine-enrollment tests reject QR/pending-record mismatch, substituted candidate key, altered approval or envelope digest, stale epoch, expired/replayed enrollment or challenge, missing fresh Passkey, inactive approver, and missing candidate private key without activation. They prove all-or-nothing activation, pre-commit crash versus resumable post-commit provisioning, and that only active Grant holders can provision shared material.
- Every private endpoint rejects missing, mismatched, expired, stale, or invalid Device proofs. Mutation/security proof replay is atomically rejected, while a replayed read proof cannot change state. Removal rejects self/last-device attempts, atomically cuts off only target Sessions/envelopes, preserves other active devices after proof refresh, and leaves cached material as the stated limit.

### 12.2 Authentication and abuse

- Signup requires valid one-use fixed-difficulty proof of work and WebAuthn; replay fails.
- All exact rate-limit windows/scopes and generic failures are tested.
- Recovery code consumption, set replacement, restricted recovery session, global session revocation, and no-override failure are tested.
- Signup bootstrap tests in Chromium, Firefox, and WebKit prove one transaction creates the Account, first passkey, registry epoch 1, first active device, both initial Key envelopes, generation-1 capsule, recovery-code set, and device-bound Session; no failure mode leaves an Account without its capsule or root-capability envelope; and signup creates no `crypto_jobs` row or provisioning state.
- Signup rejects a substituted candidate key, altered transcript/capsule digest, replayed or mismatched registration challenge, replayed proof of work, missing candidate private key, and invalid binding statement without creating an Account.
- The first private operation from the signup browser fails without a current `mdwn/device-proof/v1` and succeeds with it; no unprovisioned signup Session ever exists on the origin browser.
- The phrase gate blocks File/Directory creation and Import until verification; an empty Account survives device loss through phrase recovery or device reissue without exposing the phrase or plaintext keys to requests, service state, logs, or telemetry.
- A lost commit response followed by passkey sign-in plus Device proof binds the Session with no QR, no registry-epoch change, and no duplicate Account; a failed proof leaves the Session unprovisioned; non-extractable keys persisted in IndexedDB still prove possession after a full browser restart in all three engines; and eviction, private-mode loss, or a missing device routes to recovery/enrollment rather than an unrecoverable error.
- Session idle/absolute expiry and passkey-linked revocation are tested.
- Raw IP and prohibited request/content fields never persist.
- Scheduled retention purge is exercised.

### 12.3 Hierarchy, sharing, and concurrency

- Same-owner containment, root uniqueness, cycle prevention, node kind, and entry/node agreement are enforced.
- Immutable `mdwn/namespace-v1` fixtures assert display/comparison-key bytes in Chromium, Firefox, WebKit, and the Worker test target for composed/decomposed `Amélie`, `Straße`/`STRASSE`, Greek sigma/final-sigma, default `I`/`i` versus distinct `İ`, and intentionally distinct full-width `Ａ` versus ASCII `A`. A package/UCD version mismatch fails CI.
- Tests reject every unsafe segment/path boundary, including traversal, slash/backslash, Bidi controls, device stems, unpaired surrogates, and a one-byte-over-limit name; Unicode 17 normalization conformance vectors run in CI.
- Tests cover deterministic suffix placement, literal suffixes, folded collisions, source-duplicate rejection, direct-name reservation, and a generated over-limit name. A same-revision two-client mutation proves exactly one commit; the loser gets `409 namespace_changed`, no visible partial Import, and must refresh/review before retrying.
- Direct File Grants reveal no tree/path data.
- The complete permission matrix is covered, including read-only Private Comment participation and direct-File structural denial.
- Overlapping Grant union/revocation behaves independently.
- Revocation denies server access before rotation and blocks affected new writes until safe.
- File saves and active Public updates are one conditional operation; stale saves preserve the local draft and do not mutate current state.
- Browser tests cover byte-exact source limits including multi-byte UTF-8, 90% feedback, typing/composition/paste rejection without draft loss, `Cmd/Ctrl+S`, navigation warnings, legacy reduction, conflict overwrite, and Import Replace.
- Schema/Worker tests prove the 512 KiB BLOB bound; malformed, oversize, or stale saves leave no new pointer, revision, or partial private/Public update.

### 12.4 Publications and Comments

- Unknown, rotated, and sealed Publication paths return indistinguishable ciphertext-free `404` responses.
- Public pages expose only the current Public representation and allowed public epochs.
- Audience transitions never disclose Collaborators-only history publicly.
- Signed-in but unauthorized Accounts receive no Collaborators-only data.
- Owner/author Comment mutation rules are enforced server-side.
- Link rotation preserves the logical Public thread; unpublish destroys it and a later Publication starts fresh.
- Interrupted teardown remains sealed and is Owner-resumable.
- Pseudonym update presents all-old or all-new state, never mixed committed attribution.

### 12.5 Import, export, and deletion

- Export plaintext is produced only in the browser and includes only owned content and defined historical Private Comment data.
- Every local import bound/preflight failure—including source/archive limits, Unicode namespace profile, manifest, field, descriptor, chunk, aggregate, and Historical-Comment limits—creates no session, upload, or visible row.
- The remote Workers Free + D1 proof covers exact-boundary acceptance and one-byte/one-record-over rejection for the 128 KiB staging manifest, 512 KiB chunk, 20 MiB aggregate, 40 chunks, 50 records per chunk, every canonical ciphertext cap, and 1,000 Historical Comments. It uses browser-built maximum legal expanded input plus legal high-node/high-Historical-Comment cases, with synthetic protocol tests for chunk/count boundaries a source distribution cannot reach.
- The same remote proof shows every permitted worst-case upload and commit fits the 50-statement D1 Free invocation limit; exact duplicate retries are idempotent; mismatched retries, missing sequences, malformed descriptors, cancellation, expiry, disconnect, stale authority/revision, and failed commit create no marker or visible data; and a staged Replace retains the old representation until a successful marker.
- Shared-target imports assign every new descendant to the target Owner and never create authority.
- Uncommitted Import records are excluded from every normal query class.
- File and <=500-node Directory hard deletion remove every dependent application record atomically.
- >500-node Directory deletion changes nothing.
- Public-participation limits cannot block export, hard deletion, unpublish, or session revocation.

### 12.6 Delivery quality

- Type checking, unit tests, integration tests, migration validation, and production build pass in pull requests.
- D1 foreign-key checks are enabled and representative recursive/access queries have reviewed `EXPLAIN QUERY PLAN` output.
- Migration rollback posture is rehearsed on non-production data.
- Accessibility-sensitive controls are keyboard/screen-reader usable.
- An independent security review occurs before end-to-end-security claims.
- A disposable remote Workers Free + D1 deployment is a release gate whenever encryption-persistence schema changes and for release candidates (not necessarily every pull request). It proves exact-limit create/save/Replace/import behavior, one-byte-excess rejection, active-Publication paired updates, stale-conflict preservation, and the deployed D1 constraint.

## 13. Recommended dependency order

This sequence minimizes rework; it does not change the normative behavior above.

1. Worker/RR8/Drizzle foundation, migrations, secure headers, and CI.
2. Accounts, WebAuthn, sessions, rate-limit primitives, device identity/proofs, the signup first-device bootstrap, recovery codes/capsules, routine enrollment/removal, and replacement-device enrollment.
3. Key-envelope library and cross-browser vectors.
4. Private tree, vendored Unicode-17 namespace package/vectors, encrypted names/representations, revisions, editor/preview, and bounded hard deletion.
5. Shares/Grants, effective-access query, device provisioning, and Key rotation.
6. Private Comments and Public-pseudonym attribution.
7. Publications, Public representations, Public Comment epochs, rotation, and teardown.
8. Browser export and the record-bounded, staged atomic Import protocol.
9. Full abuse/suspension policy, retention jobs, end-to-end acceptance suite, and security review.

## 14. Source decisions

This specification consolidates, without replacing the detailed rationale in:

- [Define the privacy model](../.scratch/mdwn/wayfinder/01-define-privacy-model.md)
- [Research: passkeys/WebAuthn implementation and recovery](../.scratch/mdwn/wayfinder/02-research-passkeys.md)
- [Research: free/cheap Postgres and RR7 hosting landscape](../.scratch/mdwn/wayfinder/03-research-infra.md)
- [Design authentication: passkeys, recovery, open signup](../.scratch/mdwn/wayfinder/04-design-auth.md)
- [Sharing & permission model](../.scratch/mdwn/wayfinder/05-sharing-permission-model.md)
- [Public publish model](../.scratch/mdwn/wayfinder/06-public-publish-model.md)
- [Comments model](../.scratch/mdwn/wayfinder/07-comments-model.md)
- [Lock the stack and hosting](../.scratch/mdwn/wayfinder/08-lock-stack-and-hosting.md)
- [Data model & schema](../.scratch/mdwn/wayfinder/09-data-model-and-schema.md)
- [Navigation & editor UX prototype](../.scratch/mdwn/wayfinder/10-navigation-and-editor-ux.md)
- [Import/export format & flow](../.scratch/mdwn/wayfinder/11-import-export.md)
- [Define encrypted-content and capability model](../.scratch/mdwn/wayfinder/13-define-encrypted-content-capability-model.md)
- [Lock editor and file interaction behavior](../.scratch/mdwn/wayfinder/14-lock-editor-and-file-interaction.md)
- [Research: privacy-preserving abuse controls on Cloudflare](../.scratch/mdwn/wayfinder/15-research-privacy-preserving-abuse-controls-on-cloudflare.md)
- [Lock abuse and rate-limit policy](../.scratch/mdwn/wayfinder/16-lock-abuse-and-rate-limit-policy.md)
- [Research: D1-backed encrypted import envelope](../.scratch/mdwn/wayfinder/17-research-d1-import-envelope.md)
- [Lock import operational bounds](../.scratch/mdwn/wayfinder/18-lock-import-operational-bounds.md)
- [Resolve Private Comment permissions for read-only Grants](../.scratch/mdwn/wayfinder/19-resolve-private-comment-permissions-for-read-only-grants.md)
- [Resolve import ownership in shared Directories](../.scratch/mdwn/wayfinder/20-resolve-import-ownership-in-shared-directories.md)
- [Define Collaborators-only Public Comment capabilities](../.scratch/mdwn/wayfinder/21-define-collaborators-only-public-comment-capabilities.md)
- [Define Vault recovery and replacement-device enrollment](../.scratch/mdwn/wayfinder/22-define-vault-recovery-device-enrollment.md)
- [Lock normal File size and representation storage](../.scratch/mdwn/wayfinder/23-lock-normal-file-size-and-storage.md)
- [Define routine Encryption-device enrollment and revocation](../.scratch/mdwn/wayfinder/24-define-routine-encryption-device-enrollment-and-revocation.md)
- [Lock canonical namespace normalization and import collision naming](../.scratch/mdwn/wayfinder/25-lock-canonical-namespace-normalization-and-import-collision-naming.md)
- [Lock encrypted import payload and chunk bounds](../.scratch/mdwn/wayfinder/26-lock-encrypted-import-payload-and-chunk-bounds.md)
- [Define first Encryption-device bootstrap at signup](../.scratch/mdwn/wayfinder/27-define-first-encryption-device-bootstrap.md)

Architectural rationale is retained in [`docs/adr`](adr/), and canonical terminology is in [`CONTEXT.md`](../CONTEXT.md).
