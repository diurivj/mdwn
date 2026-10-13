# 64: Scoped Import storage and admission guard

**What to build:** Before any Import bound is raised, add the missing scoped guard that limits each Account's concurrent Import staging and encrypted growth. It uses ciphertext sizes and existing ownership metadata, and holds reservations that failed, cancelled or expired work releases.

**Type:** feature

**Status:** wontfix

**Blocked by:** none technically. Do it only when the maintainer decides to pursue [65](65-larger-import-envelope.md).

**Related:** [53](53-workers-paid-plan-spec.md); [`docs/workers-paid-plan.md`](../../../docs/workers-paid-plan.md) §1 (admission decisions) and §3; [`docs/import.md`](../../../docs/import.md); [ADR-0006](../../../docs/adr/0006-visible-atomic-staged-imports.md).

## Scope

- Check whether the current per-Account staging, chunk and expiry rules already bound concurrent staging. Add only what is missing.
- Admission stays safe under concurrent requests and retries. Rejections expose no partial content and never block export, Hard deletion, Unpublishing or revocation. Shared-target Imports keep counting against the target Owner.
- No generic quota platform, financial ledger or plaintext inspection.

## Acceptance criteria

- [ ] Workers tests with real D1 cover admission at and above the bound, concurrent and retried admission, and reservations released after rejection, cancellation and expiry.
- [ ] Browser and Worker limits and guidance stay consistent.

## Comments

- 2026-10-12: Published as a child of 53. It waits for the maintainer to decide to pursue larger Imports.
- 2026-10-12: Closed as **wontfix** with [65](65-larger-import-envelope.md): the maintainer decided the current 100-node Import envelope is fine, so the guard for a raised bound is not needed. Reopen only if a larger Import envelope is pursued again.
