# 20: Grant provisioning fulfillment for new or replacement Encryption devices

**What to build:** A device that joined by routine enrollment or Vault recovery eventually receives the shared content it is authorized for, provisioned by an already-authorized browser — and a revoked or expired Grant can never be provisioned after the fact.

**Blocked by:** 11 (Vault recovery and replacement-device enrollment), 12 (Routine Encryption-device enrollment), 18 (Grant capability envelopes and shared-content provisioning).

**Status:** ready-for-agent

- [ ] When an active Grant lacks an envelope for a new or replacement device, the service records only an opaque provisioning need — no object name, plaintext, or capability.
- [ ] An already authorized source browser — normally the File or Directory Owner's browser — provisions the current Grant/Comment capability when it next processes that need.
- [ ] Until the need is fulfilled, the recipient sees **Shared content is being securely provisioned** with no names, plaintext, or URL-fragment fallback.
- [ ] A revoked or expired Grant cancels its need, and a need can never provision an old capability or resurrect access that has been withdrawn.
- [ ] Fulfillment is idempotent and bounded, and interrupted provisioning resumes from an enrolled device.
- [ ] The flow works after Vault recovery (ticket 11) and after routine enrollment (ticket 12) without weakening either cutover's rules.
- [ ] Tests prove only active Grant holders can provision, a recovered device receives nothing through its Vault-root envelope, revocation before fulfillment leaves the recipient without access, and no provisioning happens after revocation.

## Comments

- 2026-09-21: Dependency note from ticket 03: resumed fulfillment must reuse the stored envelope bytes on an exact retry. If it re-seals instead, it uses a fresh writer or HPKE context; it never restores nonce state. See `docs/enc-v1.md`.
- 2026-09-29: User decision: **only the Owner's browser fulfills needs.** It processes provisioning needs after pending rotation jobs, from the same runner on owned Files pages, and handles Directory capabilities under re-signed offers, Shared-as label deliveries, direct-File recipient sets and Private thread device envelopes. A recipient's own devices do not fulfill; that would need a new recipient-signed proof format. The existing ticket 18 direct-File holder completion (`PATCH /direct-files/:fileId/complete`) stays as it is and is not extended.
