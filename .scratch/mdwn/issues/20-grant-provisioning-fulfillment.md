# 20: Grant provisioning fulfillment for new or replacement Encryption devices

**What to build:** A device that joined by routine enrollment or Vault recovery eventually receives the shared content it is authorized for, provisioned by an already-authorized browser — and a revoked or expired Grant can never be provisioned after the fact.

**Blocked by:** 11 (Vault recovery and replacement-device enrollment), 12 (Routine Encryption-device enrollment), 18 (Grant capability envelopes and shared-content provisioning).

**Status:** ready-for-agent

- [x] When an active Grant lacks an envelope for a new or replacement device, the service records only an opaque provisioning need — no object name, plaintext, or capability.
- [x] An already authorized source browser — normally the File or Directory Owner's browser — provisions the current Grant/Comment capability when it next processes that need.
- [x] Until the need is fulfilled, the recipient sees **Shared content is being securely provisioned** with no names, plaintext, or URL-fragment fallback.
- [x] A revoked or expired Grant cancels its need, and a need can never provision an old capability or resurrect access that has been withdrawn.
- [x] Fulfillment is idempotent and bounded, and interrupted provisioning resumes from an enrolled device.
- [x] The flow works after Vault recovery (ticket 11) and after routine enrollment (ticket 12) without weakening either cutover's rules.
- [x] Tests prove only active Grant holders can provision, a recovered device receives nothing through its Vault-root envelope, revocation before fulfillment leaves the recipient without access, and no provisioning happens after revocation.

## Comments

- 2026-09-21: Dependency note from ticket 03: resumed fulfillment must reuse the stored envelope bytes on an exact retry. If it re-seals instead, it uses a fresh writer or HPKE context; it never restores nonce state. See `docs/enc-v1.md`.
- 2026-10-02: Maintainer approved real-D1 signed API and actual browser enrollment/recovery test seams, branch `issue/20-grant-provisioning-fulfillment`, review baseline `64ae66a6d920067c5c4021783712e1ddcbf0fbee`, and explicitly adding timed Grant expiry now. Implementation and protocol are documented in `docs/shared-provisioning.md`. Focused checks pass: typecheck; 40 delivery/needs/provisioning/expiry Workers tests; 30 sharing/rotation/expiry Workers tests; and 21 fulfillment/enrollment/recovery/expiry browser scenarios across Chromium, Firefox and WebKit. A lost-response test caught the browser transport's normalized unavailable error; retries now reuse exact saved ciphertext bytes with a fresh proof. At this checkpoint, full-suite verification and review were pending.
- 2026-10-02: Implementation checkpoint `d70128e`. Fresh/idempotent D1 migration smoke, build and client-bundle secret scan passed. The full suite passed 88 unit and 215 Workers tests plus 277/282 browser tests; five browser timeouts are under investigation. Initial Spec review found no issues; Standards identified unbounded superseded-rotation cleanup during expiry handoff. Three signed-API regressions reproduced it, then passed after bounding staging/traversal/receipt cleanup to 20 rows per table and pinning empty dependencies in the handoff CAS. The focused expiry/provisioning/rotation run now passes 30 tests and typecheck passes. Final review and separate RR8 gate remain required before publication.
