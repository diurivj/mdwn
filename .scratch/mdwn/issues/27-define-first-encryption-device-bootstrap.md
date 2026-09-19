# Define first Encryption-device bootstrap at signup

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by: 04, 13, 22, 24

## Question

[Design authentication: passkeys, recovery, open signup](04-design-auth.md) settles the open-signup ceremony but not the first Encryption device. [Define encrypted-content and capability model](13-define-encrypted-content-capability-model.md) requires a client-held encryption identity and an authenticated device registry in which existing devices approve new ones. [Define Vault recovery and replacement-device enrollment](22-define-vault-recovery-device-enrollment.md) covers only the no-usable-device ceremony on an existing Account, and [Define routine Encryption-device enrollment and revocation](24-define-routine-encryption-device-enrollment-and-revocation.md) requires an already active device to approve a new one and treats a freshly authenticated browser as unprovisioned until that ceremony completes. Nothing specifies how the Account's very first Encryption device — the browser that creates the Account — is created, trusted, and bound, so an implementer must invent the trust anchor of the whole device registry.

Lock the bootstrap contract:

- What exact ceremony and transaction create the Account, first passkey, hidden root Directory, first Encryption-device record (transport and device-assertion key pairs), its Vault-root/recovery Key envelopes, the initial device-registry epoch, the Recovery capsule and its public verification key, and the passkey/Session state — and which parts must be atomic together?
- What makes the first device trustworthy when there is no existing device to approve it? Is the account-creation transaction itself the trust anchor, or must the candidate device keys be bound into the signup ceremony — for example, a signed statement, a possession proof, or a challenge tied to the WebAuthn registration?
- How does the signup browser's normal Session become private-capable and device-bound, and what proof (if any) does its first private operation require?
- Are the Account-owned capability envelopes, Private Comment threads, and attribution material provisioned in bounded `crypto_jobs` as in routine enrollment, and what UI state applies while that runs?
- What failure, retry, and abuse behavior applies if signup fails between account creation and device activation, and can a partially created Account be resumed rather than duplicated?

Do not reopen the settled key hierarchy, envelope format, recovery-ceremony contract, routine-enrollment contract, or the passkeys-only/open-signup policy.

## Answer

**Resolution — signup is the trust anchor: one atomic commit creates the Account, its first passkey, and its first active Encryption device, with recovery material committed alongside.**

### Trust anchor and first-device binding

- There is no prior Encryption device to approve the first one, so the Account-creation transaction itself is the trust anchor under the honest-client boundary. Signup has no QR approval, pairing secret, or second ceremony.
- The signup browser proves it holds the exact candidate keys it registers: it signs a canonical `mdwn/signup-device-binding/v1` statement with the candidate device-assertion private key. The statement binds the Account ID, device ID, both candidate public keys/transcript digest, capsule generation/metadata digest, recovery-verification public key, registration challenge material, and initial registry epoch. The service verifies it before activation and records opaque approval provenance `signup`.
- The first passkey is cryptographically bound to the same transcript: the WebAuthn registration challenge is a domain-separated digest of the canonical signup transcript, so `clientDataJSON.challenge` cannot match if any candidate key, capsule digest, or proof-of-work material changes. The client generates every piece of local material before requesting the challenge. A registration response from another transcript, a substituted candidate key, a replayed challenge, or a swapped capsule digest fails without creating an Account.
- This binds the ceremony for correctness, crash safety, and post-hoc verifiability; a malicious service serving altered JavaScript remains outside the honest-client boundary already stated in the capability model.

### One atomic commit

The signup browser generates locally, before the commit:

- opaque Account ID, hidden root Directory node ID, and device ID (UUIDv7) — client-minted, so every ciphertext can be bound to its object before either exists;
- a P-256 HPKE transport key pair and a separate P-256 device-assertion signing key pair, both non-extractable;
- the Vault root key, the root Directory capability key, and its `vault-recovery` Key envelope under the Vault root key;
- the first device's `device-enrollment` Key envelope carrying the Vault root key;
- the 256-bit Vault recovery secret and its phrase, the public recovery salt, a recovery-enrollment key pair, the generation-1 Recovery capsule, and the matching recovery-verification public key;
- the encrypted Account profile carrying the generated Public pseudonym, protected under Account-owned Vault root material; and
- ten authentication recovery-code hashes for the first code set.

One short D1 transaction then creates, all-or-nothing: the Account, the first passkey, the Account encryption identity/device registry at epoch 1, the first Encryption device in `active` state with `signup` approval provenance, both initial Key envelopes, the generation-1 capsule, the recovery-code set, and a normal Session already bound to that exact device. Because the phrase only opens the capsule while the root Directory capability is reachable only through its `vault-recovery` envelope, those artifacts must commit together: no Account may exist whose capsule or root-capability envelope is missing or deferred to a job.

The signup Session is never unprovisioned: it is born bound to the first device, and the browser's first private operation requires the ordinary `mdwn/device-proof/v1` at the current registry epoch, exactly as any later operation does. There is no grace period and no special bootstrap credential.

### Recovery-phrase gate

- The phrase is displayed after the commit, with a mandatory verification step (re-entering three words).
- Until confirmation, a client-local gate blocks every content-creating private operation (File/Directory creation and Import). The Account is empty at that point, so the cost is zero and the state "device lost before the phrase was ever recorded" can no longer contain content to lose. The gate is client-side only; no server flag records it.
- An active device may reissue the phrase later through the settled recovery-material rules, and the latest displayed phrase supersedes prior ones.

### Failure, retry, and session binding

- A failed or interrupted signup leaves no partial Account: the single transaction either creates the full bootstrap set or nothing, never a half-provisioned registry entry or an Account without recovery material.
- If the commit succeeded but its response was lost, the person signs in: the persisted device and the passkey both exist. If the commit never happened, signup restarts; an authenticator credential orphaned by the failed attempt is the only residue and has no server state.
- This ticket completes the device-lifecycle contract with **bind-on-sign-in**: a normal Session created by a fresh Passkey assertion may present a `mdwn/device-proof/v1` from an already-active Encryption device whose keys are persisted in that browser, and the Session becomes bound to it. Bind-on-sign-in:
  - applies only at Session creation and only to an existing active device at the current registry epoch;
  - never activates a device, changes the registry epoch, or replaces or approves anything;
  - leaves the Session unprovisioned if the proof fails or the device is revoked or tombstoned;
  - is how a single-device Account returns after sign-out, idle expiry, or a lost signup response, and complements [Define routine Encryption-device enrollment and revocation](24-define-routine-encryption-device-enrollment-and-revocation.md): a browser that holds no active device still has no path to private access except routine enrollment or recovery.
- No idempotency cache, signup-outcome table, or resumable partial account is required; a retry is either a fresh signup or an ordinary sign-in.
- Settled signup abuse controls apply unchanged: registration-challenge and successful-registration limits, proof of work consumed atomically with submission, honeypot, and generic failures. A failed commit consumes the challenge material and requires a fresh rate-limited start; the bootstrap adds no identifying metadata and no new counters.

### Provisioning and UI

- Signup creates no `crypto_jobs`: an empty Account owns exactly one capability, the hidden root Directory, and the commit already envelopes it. There are no Files, Private Comment threads, or attribution contexts to provision.
- The only bootstrap UI states are **Creating your account…**, the phrase display and verification gate, and generic retry guidance on failure. **Setting up your Files securely…** and **Shared content is being securely provisioned** never appear during signup; they remain states for later enrollment and recovery.
- Later-created material — the first File or Directory, Comment threads, pseudonym changes — provisions through the settled ordinary flows. None of it is pre-created at signup.

### Device-key persistence

- Both private keys are generated with `extractable: false` and persisted as WebCrypto `CryptoKey` handles by structured clone into IndexedDB, alongside the opaque device ID and cached registry epoch. They survive tab close, sign-out, and full browser restart in Chromium, Firefox, and WebKit. Keys are never self-wrapped: `crypto.subtle.wrapKey` rejects a non-extractable key, so direct generation plus IndexedDB storage is the only supported path.
- Persistence is best-effort by default: the app requests `navigator.storage.persist()` and treats a missing, replaced, or unreadable device as device loss. WebKit's seven-day script-writable-storage eviction, private windows, quota eviction, and "clear site data" can destroy the device; an Account with no other device then uses Vault recovery, which the phrase gate guarantees is possible for an empty Account.
- Losing device keys is never silent: the browser detects the missing device before private operations and shows the recovery/enrollment path instead of a failed private request.

### Proof obligations

Chromium, Firefox, and WebKit must prove that:

1. signup creates the Account, first passkey, registry epoch 1, first active device, both initial Key envelopes, generation-1 capsule, recovery-code set, and a device-bound Session in one transaction, and no failure mode leaves an Account without its capsule or root-capability envelope;
2. a substituted candidate key, altered transcript/capsule digest, replayed or mismatched registration challenge, replayed proof of work, missing candidate private key, or invalid binding statement is rejected without creating an Account;
3. the first private operation from the signup browser fails without a current `mdwn/device-proof/v1` and succeeds with it, and no unprovisioned signup Session ever exists on the origin browser;
4. the phrase gate blocks content creation until verification, and an empty Account survives device loss through phrase recovery or device reissue without ever exposing the phrase or plaintext keys to requests, service state, logs, or telemetry;
5. a lost commit response followed by passkey sign-in plus Device proof binds the Session with no QR, no registry-epoch change, and no duplicate Account, while a failed proof leaves the Session unprovisioned;
6. non-extractable keys persisted in IndexedDB still prove possession after a full browser restart in all three engines, and eviction or private-mode loss routes to recovery rather than an unrecoverable error; and
7. signup creates no `crypto_jobs` row, provisioning need, or **Setting up your Files securely…** state.

This ticket adds the bootstrap that precedes the settled recovery and routine-enrollment contracts; it does not reopen the key hierarchy, envelope format, recovery ceremony, routine enrollment/removal, or the passkeys-only open-signup policy.
