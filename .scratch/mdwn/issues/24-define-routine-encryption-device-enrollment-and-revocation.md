# Define routine Encryption-device enrollment and revocation

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by: 13, 22

## Question

[Define encrypted-content and capability model](13-define-encrypted-content-capability-model.md) requires an existing approved Encryption device to approve a normal new device, while [Define Vault recovery and replacement-device enrollment](22-define-vault-recovery-device-enrollment.md) defines only the no-usable-device recovery ceremony. The MVP still lacks the routine device-lifecycle contract needed to implement private endpoints without inventing security behavior.

Lock the normal (non-recovery) device flow:

- How an Account with an active approved device starts and approves enrollment of a new browser/device, including the exact candidate key pairs, approved-device authorization statement, possession proofs, binding to Account/device-registry revision, expiry/replay handling, and protection against service key substitution.
- Which Session/fresh-Passkey and active-device assertion requirements apply to enrollment and every private endpoint; whether recovery-enrolled and routine-enrolled devices use the same assertion model; and how the server validates an active device at the current registry epoch.
- The required device records, Key envelopes, Account-owned and Grant-derived capability provisioning, resumability, and UI while a newly approved device is not fully provisioned.
- The normal removal/revocation ceremony for an active device: authorization, Session/device-envelope/key-epoch effects, what rotates, which authority remains, failure/retry behavior, and the practical boundary for previously cached data.
- The required persistence constraints, transaction boundaries, cross-browser tests, and user-facing confirmations/errors.

Do not reopen passkeys-only authentication, the client-held encryption/capability model, the recovery-phrase ceremony, sharing/revocation limits, or the rule that the service never receives plaintext keys or capabilities.

## Answer

**Resolution — QR-approved, multi-device Encryption-device lifecycle.** Routine enrollment adds an Encryption device; it never replaces other active devices. A synced passkey may authenticate the same Account on another supported browser, but it grants no encrypted-content authority by itself. The newly authenticated browser is an unprovisioned normal Session until this ceremony completes. Recovery enrollment remains the distinct all-device cutover for an Account with no usable active Encryption device.

### Candidate and approval ceremony

1. The candidate browser establishes a normal Session with a fresh Passkey assertion, then locally generates an opaque device ID, a P-256 HPKE transport key pair, a separate P-256 device-assertion signing key pair, and a 256-bit random pairing secret. Before the QR is shown, the person may choose an optional device label.
2. A `device_enrollments` record stores the Account, candidate Session binding, opaque device ID, exact canonical public keys/transcript digest, pairing-secret hash, expected device-registry epoch, expiry, and one-use lifecycle state. It holds no plaintext label, private key, Vault key, or capability. It expires within ten minutes; an expired, failed, replayed, or stale start activates no device and must restart.
3. The QR transfers the canonical candidate transcript, including the raw pairing secret, directly to an existing active Encryption device. The service never receives the raw secret. The approving browser fetches the pending record and rejects it unless every Account, device ID, key, transcript digest, and secret hash matches the QR byte-for-byte. This local comparison prevents the service from substituting a candidate key.
4. The approver must have a normal Session, a fresh Passkey assertion, and a current Device proof. It HPKE-envelopes the Vault root to the exact candidate transport public key with `device-enrollment` purpose and signs a canonical `mdwn/device-enrollment-approval/v1` statement. The statement binds the Account, enrollment ID, pairing-secret hash, candidate device ID and both keys/digest, device-enrollment-envelope digest, approving device ID, expected registry epoch, and expiry.
5. The service verifies the approving device is active at that epoch, then issues a one-use HPKE challenge to the exact candidate transport key. The candidate decrypts it locally and signs the challenge/transcript with its candidate device-assertion private key. The service accepts neither changed candidate keys nor a replayed challenge, approval, pairing secret, or registry epoch.

### Sessions and private endpoints

- A private-capable normal Session is bound to exactly one active Encryption device and current device-registry epoch. An unprovisioned Session may use only authentication, account-security, and enrollment routes; it cannot read or mutate private material, envelopes, Grants, Comments, or Publications.
- Routine- and recovery-enrolled devices use the same assertion model. Every private read or mutation requires the Session, its matching active device, and a `mdwn/device-proof/v1` signature from that device’s assertion key. The canonical proof binds a session-binding digest, device ID, current registry epoch, HTTP method and canonical path/query, body digest, issued/expiry time (at most five minutes), and a random proof ID.
- The service verifies the signature and current device status/epoch before doing any private work. It atomically consumes proof IDs for mutations and security-sensitive actions—including enrollment, removal, and export—alongside that action’s expected revision/idempotency state. Read-only proofs expire and are request-bound but are not persistently consumed: replay cannot alter state and retaining every workspace-read proof would impose a D1 write per load.
- Any active-device membership change advances the Account’s monotonic device-registry epoch. Existing devices retain their Sessions but must refresh the public registry state and sign a new proof before another private operation. A stale proof returns no private material; an in-flight enrollment fails and restarts instead of racing the change. Existing normal-Session and fresh-authentication abuse controls apply without retaining new identifying metadata.

### Activation, records, and provisioning

One short D1 transaction checks the live candidate Session/fresh assertion, unused unexpired enrollment and challenge, approval signature, candidate possession signature, exact keys/envelope digest, active approver, and expected current registry epoch. It then consumes the records; creates the active `encryption_devices` record with opaque approval provenance; persists the initial `device-enrollment` Vault-root Key envelope; stores the label only as Vault-root-encrypted device metadata; advances the registry epoch; and replaces the candidate’s unbound Session with a new device-bound normal Session. It also creates opaque, idempotent provisioning work. A crash before commit leaves no active candidate; a crash after commit resumes only that non-authorizing work.

The initial Vault-root envelope lets the new device restore Account-owned material through the established owned hierarchy/recovery envelopes. Remaining Account-owned device envelopes are created in bounded, resumable `crypto_jobs` batches; the UI may show **“Setting up your Files securely…”** while that work continues. Grant-derived Directory/File/Comment capabilities are never put in the Vault-root envelope. An active device that already holds a currently authorized Grant capability may HPKE-envelope it to the new device; otherwise the service records only an opaque provisioning need and the UI says **“Shared content is being securely provisioned”** without names, plaintext, or a fallback capability. A revoked/expired Grant cancels its need and can never provision afterward.

Device inventory records contain only opaque ID, public keys, active/revoked state, approval provenance, registry epoch, encrypted optional label, creation time, and coarse last-successful-device-proof time. No browser/OS, user-agent, IP, or fingerprint data is stored. The browser decrypts labels; the service never receives them in plaintext.

### Normal removal

Normal removal is targeted containment, not recovery. It may be initiated only by a *different* active Encryption device with a normal Session, fresh Passkey assertion, current Device proof, an explicit destructive confirmation naming the decrypted device label, target device ID, and expected registry epoch. A device cannot remove itself or the last active Encryption device; ordinary sign-out is the alternative. A person with no other active device uses Recovery enrollment.

Its short transaction rechecks all authority/current-state conditions, tombstones the target, revokes every Session bound to it, supersedes every target-device Key envelope, cancels its pending enrollment/challenge records, advances the registry epoch, and writes a bounded Security event. Other active devices and their Sessions remain usable after their proof refresh. It does not rotate the Vault root, Directory/File capabilities, Grant epochs, or current representations: the removed device may retain plaintext, keys, or ciphertext it already cached, but cannot fetch future private material or mutate anything because its Session/device proof and all new envelopes fail current-state checks. A completed removal is idempotent; a concurrent registry change requires refresh and renewed confirmation.

### User states and acceptance criteria

The UI distinguishes **Scan this QR code**, **Waiting for approval**, **Setting up your Files securely…**, and **Shared content is being securely provisioned**. It provides generic restart guidance for expired/replayed/stale enrollment and never exposes a pending Account or key value in an error. The device-management view displays only decrypted optional labels, status, creation time, and coarse last-use time; it provides sign-out separately from destructive removal.

Chromium, Firefox, and WebKit acceptance tests must prove that:

1. a synced passkey can authenticate an Account on another browser yet cannot access private content before QR approval; multiple normally enrolled devices and their device-bound Sessions then coexist with ordinary Account-owned and provisioned Grant authority;
2. QR/server-record mismatch, substituted candidate key, altered approval/envelope digest, stale epoch, expired/replayed enrollment/challenge, missing fresh Passkey, inactive approver, or missing candidate private key is rejected without activation;
3. every private endpoint rejects a missing, mismatched, expired, stale, or invalid Device proof; mutations/security actions consume their proof atomically while replayed read proofs cannot change state;
4. final activation is all-or-nothing, preserves other active devices, replaces only the candidate’s unbound Session, and resumes interrupted provisioning without adding authority before commit;
5. Account-owned provisioning resumes safely; active Grant holders can provision the candidate; and missing/revoked Grant material remains unavailable without metadata/plaintext exposure;
6. ordinary removal rejects self/last-device attempts, atomically cuts off only the target’s Sessions/envelopes, preserves other active devices, and leaves cached data as the stated limit; and
7. Recovery enrollment, unlike routine enrollment/removal, still tombstones all former Encryption devices and revokes other Sessions.
