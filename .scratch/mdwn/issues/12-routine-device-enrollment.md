# 12: Routine Encryption-device enrollment (QR approval)

**What to build:** A person already signed in on one device adds a second Encryption device by scanning a QR code with the first, so the new browser becomes private-capable without any other device losing access — and the service cannot substitute its own key.

**Blocked by:** 09 (Device proofs and registry epochs).

**Status:** done

- [x] The candidate browser establishes an unprovisioned normal Session with a fresh Passkey assertion and generates an opaque device ID, P-256 HPKE transport and separate P-256 device-assertion signing key pairs, a 256-bit random pairing secret, and an optional encrypted device label; it shows **Scan this QR code**.
- [x] The service stores a `device_enrollments` record bound to that candidate Session with the exact canonical public-key transcript/digest, pairing-secret hash, expected device-registry epoch, one-use lifecycle state, and an expiry of at most ten minutes, and stores no raw pairing secret, private key, Vault key, capability, or plaintext label.
- [x] The QR code transfers the canonical candidate transcript and raw pairing secret directly to an existing active Encryption device; the service never receives the raw secret.
- [x] The approving browser fetches the pending record and rejects it unless Account, device ID, both public keys, transcript digest, and secret hash match the QR byte-for-byte, so a service key substitution cannot pass.
- [x] The approver needs its own normal Session, a fresh Passkey assertion, and a current Device proof; it encrypts a Vault-root Key envelope to the exact candidate transport public key with `device-enrollment` purpose, then signs a canonical `mdwn/device-enrollment-approval/v1` statement binding the Account, enrollment ID, pairing-secret hash, candidate device ID and both keys/digest, enrollment-envelope digest, approving device ID, expected registry epoch, and expiry.
- [x] After verifying the approver remains active at that epoch, the service issues a one-use HPKE challenge to the exact candidate transport key; the candidate decrypts it locally and signs the challenge/transcript with its candidate assertion private key (the candidate shows **Waiting for approval** in the meantime).
- [x] One short D1 transaction verifies all live, unused, and current conditions, consumes the enrollment and challenge, creates the active device with opaque approval provenance, persists the initial Vault-root envelope and encrypted label metadata, advances the registry epoch, replaces the candidate's unbound Session with a new device-bound normal Session, and creates opaque idempotent provisioning work.
- [x] Changed keys, altered approval or envelope digests, stale epochs, expired or replayed enrollment/challenge material, a missing fresh Passkey assertion, an inactive approver, and missing candidate private keys all fail without activating a device; a crash before commit activates no candidate and a crash after it may resume only non-authorizing provisioning.
- [x] The candidate restores Account-owned material through the existing hierarchy and recovery envelopes; remaining Account-owned device envelopes are created in bounded resumable `crypto_jobs` with **Setting up your Files securely…**.
- [x] Grant-derived Directory/File/Comment capabilities are never put in the Vault-root envelope: an active device that already holds a current Grant capability may envelope it to the candidate, otherwise the service creates an opaque provisioning need and the UI says **Shared content is being securely provisioned** (fulfilled by ticket 20).
- [x] The UI distinguishes **Scan this QR code**, **Waiting for approval**, **Setting up your Files securely…**, and **Shared content is being securely provisioned**; expired, replayed, or stale enrollment gives generic restart guidance without revealing a pending Account or key value.

## Comments

- 2026-09-26: Routine enrollment is implemented in PR #16 and passed the ticket review and CI. **Done refers to the routine enrollment flow.** The two unchecked bullets include Grant capability fulfillment and its shared-content UI state, which ticket 20 owns after tickets 17 and 18 provide the Grant model. The QR, waiting, Account-owned setup, and generic restart states are implemented here.
- 2026-10-08: The two deferred bullets are now checked: ticket 20 implemented Grant provisioning at `d70128e` and merged via PR #25 (`a03737e`). `docs/shared-provisioning.md`, `e2e/grant-provisioning.spec.ts`, and the enrollment/device-access/shared-provisioning UI evidence cover separate owned/Grant capability delivery and the remaining shared-content state. The original comment above records the situation before ticket 20; it is no longer pending.
