# Assemble the buildable spec

Type: task
Status: resolved
Assignee: diurivj
Blocked by: 04, 05, 06, 07, 08, 09, 10, 11, 14, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27

## Question

The destination for this map. Once every decision ticket is resolved, assemble them into **one buildable spec** — scope, domain model, architecture, schema, flows — that an implementer (human or agent) can execute without re-deciding anything.

This ticket does no deciding; if assembling surfaces a gap, that's a new ticket, not a silent assumption.

## Progress

Assembly ran against decisions 01–26 and is complete except for one surfaced gap.

- [`docs/buildable-spec.md`](../../../docs/buildable-spec.md) was updated to incorporate [Lock normal File size and representation storage](23-lock-normal-file-size-and-storage.md), [Define routine Encryption-device enrollment and revocation](24-define-routine-encryption-device-enrollment-and-revocation.md), [Lock canonical namespace normalization and import collision naming](25-lock-canonical-namespace-normalization-and-import-collision-naming.md), and [Lock encrypted import payload and chunk bounds](26-lock-encrypted-import-payload-and-chunk-bounds.md): the Unicode-17 canonical namespace profile and collision allocation, the record-bounded encrypted Import staging envelope with every canonical field cap, and the exact and one-unit-over proof obligations now appear in the relevant sections. The stale "blocked by 25 and 26" status and the unimplemented Import field/chunk placeholder are gone, and the source list includes both.
- Two underdetermined wordings were reconciled as clarification, not new decisions: (1) the abstract "Account encryption identity" from 13/ADR-0003 is realized as per-device envelope recipients with holder-driven provisioning, per 21/22/24 — no separate account-wide decryption key exists; (2) posting to a public Comment epoch requires a private-capable, device-bound Session that holds the local fragment, because the displayed pseudonym and attribution material are device-held, so 24's unprovisioned-Session bar governs.
- One genuine gap surfaced and is now [Define first Encryption-device bootstrap at signup](27-define-first-encryption-device-bootstrap.md): no resolved decision specifies how the first Encryption device is created, trusted, and bound when there is no existing device to approve it. This ticket therefore stays open and is blocked by it; the spec is drafted but cannot be finalized until that decision lands.

## Answer

Assembly is complete. Every decision on the map is folded into [`docs/buildable-spec.md`](../../../docs/buildable-spec.md), now marked **buildable**. The gap that kept this ticket open — [Define first Encryption-device bootstrap at signup](27-define-first-encryption-device-bootstrap.md) — landed and is now in the spec:

- **Section 4.1**: signup is named as the one exception to existing-device approval; the account-creation transaction is the first device's trust anchor.
- **Section 5.2**: the signup flow generates all local bootstrap material before the challenge, binds the WebAuthn registration challenge to the canonical transcript, verifies the `mdwn/signup-device-binding/v1` statement, commits the whole bootstrap set in one all-or-nothing transaction, gates content creation on recovery-phrase verification, and defines failure/retry and the no-`crypto_jobs` provisioning posture.
- **Section 5.3**: bind-on-sign-in, and the device-key persistence contract (non-extractable keys in IndexedDB, best-effort persistence, detected device loss).
- **Section 8.2**: `encryption_devices` approval provenance admits `signup` for the first device.
- **Section 8.3**: a Signup bootstrap transaction boundary.
- **Section 12.2**: decision 27's proof obligations as acceptance criteria.
- **Sections 13–14**: bootstrap added to the dependency order, and ticket 27 added to the source list.

No gap surfaced in this pass; no new ticket was needed. The destination is reached: an implementer can execute the spec without re-deciding any product-level question. The choices left open are explicitly labelled implementation discretion (HPKE package, source layout, breakpoints, physical table factoring, public-route prefix).
