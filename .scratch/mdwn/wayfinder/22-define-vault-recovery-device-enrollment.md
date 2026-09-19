# Define Vault recovery and replacement-device enrollment

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by: 04, 13

## Question

The settled cryptographic model says an existing approved encryption device approves each new device, while a separate offline Vault recovery secret restores an Account's owned Vault material. It does not define the security path when an authenticated Account has no usable approved encryption device and must recover onto a replacement browser/device.

Lock one buildable recovery and enrollment contract:

- Does proving possession of the Vault recovery secret authorize enrollment of the replacement encryption device? If so, what browser-side proof/envelope transition and authenticated server checks prevent an unapproved or substituted device key from being installed?
- Does recovery preserve or rotate the Vault root key, device/encryption-identity epochs, and envelopes? Which old device records are revoked?
- How does the replacement device regain the Account's owned Directory/File keys without sending the Vault recovery secret or plaintext keys to the service?
- Confirm that Vault recovery cannot restore content merely received through another Account's Grant. How is that shared content reprovisioned, and what does the UI show while it is unavailable?
- Keep authentication recovery codes separate: define the sequence when both Account authentication and encrypted-content recovery are needed, including failure when the required artifacts are lost.
- Identify the required persistence state, resumability/atomicity boundary, abuse checks, and cross-browser acceptance tests.

Do not reopen the settled algorithms, passkeys-only authentication policy, or the rule that the Vault recovery secret never reaches the service.

## Answer

**Resolution — authenticated, rotating recovery enrollment.** Possession of the Vault recovery secret authorizes a replacement Encryption device only in combination with a recently Passkey-verified normal Session. It is encrypted-content recovery authority, never an Account-login factor.

### Recovery material

- At Vault creation, the browser generates a 256-bit random Vault recovery secret and presents it as a checksum-protected 24-word recovery phrase. It is shown only at creation, recovery, or explicit reissue; it is never user-chosen, sent to the service, logged, or treated as a password.
- The browser derives a 256-bit wrapping key with `HKDF-SHA-256` from that high-entropy secret, a random public recovery salt, and a domain-separated `mdwn/vault-recovery-capsule/v1` context containing the Account ID and recovery generation. It encrypts a versioned `mdwn/enc-v1` Recovery capsule with AES-256-GCM and authenticated context for that Account, purpose, and generation.
- The capsule contains the stable Vault root key and a dedicated P-256 recovery-enrollment signing private key. The service stores only opaque capsule ciphertext/metadata, the current generation and salt, and the matching public recovery-verification key. It never stores a recovery secret, a plaintext Vault key, or a plaintext signing key.
- Every Account-owned root capability that is not reached by the encrypted Directory hierarchy has a current `vault-recovery` Key envelope under the Vault root key. This includes the hidden root Directory capability and Account-owned auxiliary capabilities needed to resume the owned Files/Comments model. Received Grant capabilities are explicitly excluded.

### Replacement-device ceremony

1. The person establishes a normal Session and makes a fresh Passkey assertion. If Account authentication is also lost, the required sequence is recovery code → restricted recovery Session → replacement Passkey → fresh Passkey assertion → normal Session → Vault recovery phrase.
2. A recovery-enrollment start creates a short-lived, one-use server record bound to the Account, Session, current recovery generation, current device-registry revision, and an opaque nonce. It returns the current opaque capsule; entering and validating the phrase happens entirely in the browser.
3. After locally opening and validating the capsule, the browser generates a fresh P-256 HPKE transport key pair and a separate P-256 device-assertion signing key pair. It signs an enrollment intent with the recovery-enrollment key. The intent binds the Account, recovery generation, one-use nonce, expected registry revision, exact candidate public keys/device ID, and the digest of the next recovery-capsule metadata.
4. The service verifies that signature using the stored public recovery-verification key, then issues a one-use HPKE possession challenge to the exact candidate transport key. The browser decrypts it locally and signs the challenge with the candidate device-assertion key. This proves possession of both candidate private keys; changing either public key makes the signed intent or challenge fail.
5. The browser also generates a new recovery phrase, salt, and recovery-enrollment key pair, and creates the next opaque capsule containing the unchanged Vault root key plus the new recovery private key. It displays the new phrase after success. If it is not safely recorded, the now-active device can explicitly reissue it; the old phrase is no longer sufficient after a successful rotation.

The final commit requires the live normal Session and recent Passkey assertion, unused/unexpired enrollment record, matching Account/generation/revision, valid recovery signature, valid HPKE/device-possession proof, and exact candidate keys/capsule digest. These checks mean neither an authenticated service nor a stale Session can substitute a device key.

### Atomic state change and revocation boundary

One short D1 transaction consumes the enrollment record; creates the exact candidate Encryption device as active; stores its initial device Key envelope for the Vault root key; advances the Account encryption-device-registry epoch; installs the next capsule/public verification key/generation; and revokes every former Encryption device. Revoked records remain tombstoned with a recovery reason and cannot be reactivated. Their device-targeted Key envelopes become superseded. The transaction also revokes every other Session, creates a fresh normal Session for the recovering browser, and records a bounded Security event without recovery, key, or plaintext material.

Recovery preserves the Vault root key, Directory capabilities, File content keys, and current encrypted representations. It does **not** perform a whole-Vault re-encryption migration in the MVP. Its protection boundary is explicit: an old device may retain plaintext or keys it already cached, but it cannot retrieve future private ciphertext, envelopes, or mutations because private endpoints require both a normal Session and a current device-assertion proof for an active device at the current registry epoch.

After the atomic commit, the replacement device uses the Vault root key and root/recovery envelopes to traverse the Account-owned encrypted hierarchy and creates any remaining device envelopes in bounded, idempotent `crypto_jobs` batches. The UI may show **“Restoring your Files securely…”** while these non-authorizing batches continue; interruption can resume from opaque key IDs/progress and never restores a revoked device.

### Content received through a Grant

Vault recovery never includes a Directory/File Grant capability, its Comment capabilities, or a Key envelope obtained only through another Account. A recovered device can therefore restore the Account’s own content but not shared content by itself.

For each still-active Grant whose recipient device lacks an envelope, the service records only an opaque provisioning need. An active browser that already holds the authorized capability—normally the File or Directory Owner’s browser—automatically HPKE-envelopes the current Grant/Comment capability to the recovered device when it next processes that need. This is device provisioning within the existing Grant, not a new Share or service-side key recovery. Until then, the recipient sees a generic **“Shared content is being securely provisioned”** state without names, plaintext, or a fallback to a URL fragment; they may contact the Owner out of band. A revoked/expired Grant cancels the need and can never provision its old capability.

### Loss, resumability, and abuse controls

- An active Encryption device can explicitly reissue a lost Vault recovery phrase. If an authenticated Account has neither an active device nor the phrase, its encrypted owned data and recovery capsule remain retained and locked rather than reset or deleted. If the person later finds the phrase, they can resume this ceremony. If Account authentication is also missing, they must first regain it with a Passkey or unused recovery code. If the required artifacts are truly lost, there is no support/operator override or factory reset in this MVP.
- `recovery_enrollments`, capsule generation/metadata, device status/epoch, device and recovery Key envelopes, opaque provisioning needs, bounded `crypto_jobs`, Sessions, and minimal Security events are the required persisted state. A started ceremony has no visible new device; stale/failed attempts consume or expire and restart from the current state. Only the final transaction changes authorization.
- The settled D1 recovery-ceremony limits apply to starts and failed proof attempts, using the same purpose-scoped network/recovery-identifier or authenticated-Account counters and global cap. A start permits its own bounded internal challenge steps; retries require a new rate-limited start. There is no recovery proof-of-work, CAPTCHA, tracking, raw-IP retention, or existence-revealing response. Security events retain only the settled bounded action/outcome metadata.

### Acceptance criteria

Cross-browser tests in Chromium, Firefox, and WebKit must prove that:

1. a fresh browser recovers Account-owned Files after the full normal-authentication-plus-phrase ceremony, while the phrase and plaintext keys never appear in requests, server state, logs, or error telemetry;
2. a recovery-code path cannot access encrypted content until replacement Passkey enrollment, fresh assertion, and Vault recovery all complete;
3. a substituted candidate key, stale capsule/generation, replayed nonce, missing transport/signing private key, stale Session, or missing fresh Passkey assertion is rejected without activating a device;
4. the successful commit revokes old devices/Sessions atomically; old cached plaintext remains a stated practical limit, while an old device cannot fetch a new private representation or Key envelope;
5. crashes before commit leave no active replacement device, and crashes after commit resume only idempotent owned-key provisioning without reviving old authority;
6. an active Grant remains authorization-only after recovery, exposes no shared plaintext/capability until an authorized source browser provisions the new device, and never provisions after revocation; and
7. lost-and-later-found Passkey/recovery-code/phrase artifacts follow the specified sequence, while a genuinely lost artifact has no service or operator bypass.
