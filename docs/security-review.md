# Independent security review brief

Ticket [33](../.scratch/mdwn/issues/33-mvp-acceptance-suite.md). This document
prepares the independent security review required before any end-to-end-security
claim ([buildable spec §3.6](buildable-spec.md#36-security-posture), [§12.6](buildable-spec.md#126-delivery-quality)).
It is a brief, not a substitute for the review: the review is commissioned by
the maintainer against a pinned commit and completed by a reviewer independent
of this repository's authors. Until then, describe mdwn as
end-to-end-encrypted **by design with an automated acceptance suite**, never as
independently verified.

## What to review

The system is a React Router v8 Framework Mode application on Cloudflare
Workers with D1, where all private content is encrypted and decrypted only in
the browser. The review should attack the claims that matter most:

1. **Trust boundary and honest-client limits.** The browser client is the
   trusted computing base. Verify that no plaintext (Markdown, front matter,
   names, ordering, Comment bodies, pseudonyms, recovery phrase, capabilities,
   fragments) is sent to or persisted by the Worker or D1, and that the stated
   limits (compromised browser, malicious extension/XSS, a service serving
   altered JavaScript, downloaded plaintext) are honestly disclosed.
2. **Cryptography.** `mdwn/enc-v1` envelope framing, HPKE
   `DHKEM(P-256, HKDF-SHA-256)`/`HKDF-SHA-256`/`AES-256-GCM`, nonce discipline,
   canonical authenticated contexts, epoch handling (including
   `unexpected-epoch` failing closed), downgrade/malformed rejection, and the
   key hierarchy and rotation semantics. Review `docs/enc-v1.md`,
   [ADR-0003](adr/0003-client-held-content-keys-and-capabilities.md), and
   [ADR-0008](adr/0008-parent-free-file-capabilities.md).
3. **Authentication and recovery.** WebAuthn registration/assertion binding,
   one-use proof of work, signup bootstrap atomicity, session binding to an
   Encryption device, Device proofs, routine/recovery enrollment, device
   removal, and recovery-code/Vault-recovery separation. Review
   `docs/serving-and-security.md`, [ADR-0001](adr/0001-end-to-end-content-privacy.md),
   and the ticket-27/22/24 artifacts referenced in the spec.
4. **Authorization.** The effective-access matrix, direct File vs. Directory
   Grants, Grant revocation and rotation seals, Publication and Public Comment
   audience epochs, unpublished/sealed teardown, and hard-deletion completeness.
   Review [ADR-0004](adr/0004-owner-controlled-sharing.md) and `docs/sharing.md`.
5. **Abuse controls and operational data.** Rate limits, Network buckets,
   no raw IP persistence, Security-event allowlists, retention purge, Public
   participation suspension, and the no-analytics/no-third-party invariants.
   Review [ADR-0005](adr/0005-privacy-preserving-abuse-controls.md) and
   `docs/operations.md`.
6. **Import/export.** Visible-atomic staged Import, bounds/`CHECK` enforcement,
   the fragment-free public link model, browser-only export, and the disposable
   remote Worker Free/D1 proof. Review [ADR-0006](adr/0006-visible-atomic-staged-imports.md),
   `docs/import.md`, `docs/export.md`.
7. **Delivery.** CSP and security headers, secret handling, D1 foreign-key and
   query-plan posture, migration rollback, and build/deploy separation. Review
   `docs/serving-and-security.md`, `.github/workflows/ci.yml`, and
   `.github/workflows/deploy.yml`.

## Evidence to reproduce

The reviewer should be able to reproduce the automated claims on the pinned
commit:

```sh
npm ci
npm run verify                                   # CI-equivalent checks + all three browsers
node scripts/import-proof.mjs                    # disposable Free Workers + D1 release gate
npm run db:operations -- --output /tmp/plans.md  # FK + reviewed EXPLAIN QUERY PLAN
```

`docs/acceptance.md` maps every §12 criterion to the suite that proves it.
`CONTEXT.md` is the normative glossary; `docs/buildable-spec.md` is the
normative specification. Record the reviewed commit, tool versions
(Node 24, Wrangler, Playwright), and any skipped/waived check in the review
report.

## Scope boundaries the review should confirm as disclosed

- No account deletion, account-wide export, or jurisdiction-specific privacy
  notice in the MVP (spec §1.1).
- Hard deletion leaves no app-visible copy but cannot recall already-downloaded
  data or promise provider-backup erasure timing.
- Workers Free + D1 Free capacity fails closed; there is no automatic paid
  spend.
- The donation page is anonymous and static; it embeds no third-party script.
- D1 Time Travel is the primary recovery posture; production-sized export
  restoration is still open ([ticket 38](../.scratch/mdwn/issues/38-d1-export-database-restoration.md)).

## Commissioning

The maintainer arranges the review: choose a reviewer independent of the
project, pin the candidate commit, provide this brief plus `docs/acceptance.md`,
`docs/buildable-spec.md`, `CONTEXT.md`, and `docs/adr/`, and scope the
engagement to the claims above. After the review, link its report from the
release ticket and only then use an end-to-end-security-verified claim. No
reviewer identity, contact, or schedule is recorded here because it is a
maintainer decision outside this repository.
