# Budgeted Workers Paid adoption

Status: ready-for-agent — specification, not implemented.

This specification records the maintainer's decision to fund Workers Paid while keeping mdwn inexpensive and implementation work proportionate. It replaces the Free-only operating assumption, not the privacy model. The agreed order is budget safeguards, larger practical Imports, then autonomous Public-material cleanup. Each change must be independently useful; this is not one large implementation ticket.

## Problem Statement

mdwn was designed around Workers Free and D1 Free. The project has observed CPU-limit failures during large-Import proofs and exhausted daily D1 write capacity during restore rehearsals. Conservative product bounds also make initial Imports and some maintenance awkward.

The maintainer is willing to pay approximately $5 per month, with $10 as the maximum intended monthly spend, but does not want an open-ended infrastructure bill. Paying should buy reliability and useful product improvements, not a new platform, recurring rehearsal burden, or elaborate billing subsystem.

Workers Paid is metered. Neither alerts nor application limits can guarantee that an invoice never exceeds $10. This limitation must remain explicit: do not relabel an estimate, warning, or application rejection as a provider-enforced spending cap.

## Solution

Keep React Router, Workers, D1, browser-held keys, and the existing staged Import and deletion contracts. Adopt Paid as the supported operating baseline, add inexpensive safeguards, and use the resulting headroom selectively.

1. Establish a small operating policy using existing Cloudflare billing/usage views, early warnings, bounded execution, and scoped capacity controls. Preserve current product bounds until the relevant safeguards are in place.
2. Raise the practical Import envelope only as far as focused evidence supports. The discussed 500–1,000-node range is an investigation target, not an approved limit or release promise.
3. Let an already-authorized Unpublishing operation finish its irreversible Public-material cleanup through the existing scheduled maintenance mechanism, even after the initiating browser closes.

Use existing test suites and operational tools. Add regression coverage for changed behavior, not a duplicate acceptance framework. This effort adds no recurring remote rehearsal, automatic benchmark job, billing poller, or new Cloudflare resource by default.

## User Stories

1. As the maintainer, I want normal operation to target $5 per month, so that hosting remains affordable.
2. As the maintainer, I want warnings and an intervention plan before the intended $10 ceiling, so that I can respond before costs grow further.
3. As the maintainer, I want the absence of a hard provider spending cap stated clearly, so that I do not mistake safeguards for a billing guarantee.
4. As the maintainer, I want fixed fees, usage overages, taxes, and domain costs distinguished, so that the reported operating estimate is not mistaken for my complete invoice.
5. As the maintainer, I want production, preview, maintenance, rehearsals, and other account projects included in capacity planning, so that shared allowances are not counted repeatedly.
6. As the maintainer, I want to use the existing Cloudflare dashboards and alerts, so that cost visibility does not require another hosted service.
7. As the maintainer, I want a measured execution ceiling, so that a runaway invocation cannot freely consume the default Paid CPU allowance.
8. As the maintainer, I want bounded storage growth and expensive operations, so that larger Imports do not quietly remove existing cost protection.
9. As an Account, I want capacity errors to preserve my current Files and unsaved work, so that an operating restriction does not cause data loss.
10. As an Owner, I want export, Hard deletion, Unpublishing, and Session revocation to remain available under application growth limits, so that I retain control of my data and access.
11. As an Account, I want larger ordinary Markdown collections to fit one Import, so that I do not unnecessarily split an initial collection into many selections.
12. As an Account, I want the accepted Import limits displayed consistently, so that the browser and service do not disagree about what is allowed.
13. As an Account, I want an oversized selection rejected with useful guidance before upload where possible, so that I can correct it without leaving a partial hierarchy.
14. As an Account, I want an Import to become visible all at once, so that other views never expose a partially imported collection.
15. As an Account, I want cancellation, retries, stale-target conflicts, and uncertain commit outcomes to retain their existing meaning, so that increased capacity does not weaken safety.
16. As a Collaborator with a read/write Directory Grant, I want larger Imports to preserve target eligibility and ownership, so that increased capacity grants no new authority.
17. As an Account, I want Import preparation to remain responsive and cancellable, so that a larger allowed selection does not make the browser unusable.
18. As an Account, I want names, Markdown, Comments, keys, and capabilities to remain protected by the existing browser-only cryptographic boundary, so that paying for hosting changes no privacy promise.
19. As an Owner, I want confirmed Unpublishing to stop Public access immediately, so that cleanup duration does not extend Public exposure.
20. As an Owner, I want Public-material cleanup to finish without an open browser, so that I do not need to babysit deletion.
21. As an Owner, I want interrupted cleanup to resume safely, so that a maintenance failure does not leave Public material indefinitely dependent on my next visit.
22. As an Owner, I want cleanup to preserve the File, its Private comment thread, and unrelated content, so that Unpublishing deletes only the intended material.
23. As an Owner, I want overlapping browser and scheduled cleanup attempts to be harmless, so that retries cannot corrupt progress or remove a later Publication.
24. As an Owner, I want the UI to distinguish sealed access, pending cleanup, and completed deletion, so that it never claims physical deletion before it finishes.
25. As the maintainer, I want existing retention work to continue reliably, so that new cleanup does not starve security-material expiry.
26. As the maintainer, I want the Paid recovery window documented accurately, so that I understand both rollback options and provider backup retention after live-data deletion.
27. As the maintainer, I want ordinary implementation and tests to run locally without Cloudflare credentials, so that development is inexpensive and repeatable.
28. As the maintainer, I want only focused, explicitly approved remote measurements when necessary, so that capacity validation does not become repeated resource provisioning.
29. As the maintainer, I want to reuse existing test and restore evidence where behavior is unchanged, so that payment alone does not require rebuilding the verification system.
30. As the maintainer, I want small dependency-ordered implementation tickets, so that a fresh agent can complete one useful change without taking on the entire effort.
31. As the maintainer, I want future services and product expansions kept separate, so that this upgrade does not silently authorize more subscriptions or scope.
32. As an Account, I want mdwn to remain free to use without tracking or paid feature tiers, so that the maintainer's hosting subscription does not change the product's funding or privacy model.

## Implementation Decisions

### 1. Budget policy before capacity expansion

- Workers Paid is the intended baseline; first establish whether the account has actually been upgraded and which usage model it uses. A decision to pay is not evidence of an active subscription. Spec publication and implementation do not themselves authorize account changes.
- Target the included $5 operating envelope. Treat $10 as the intended maximum and an intervention boundary, not an enforced limit. If the maintainer needs an absolute billing guarantee, stop capacity expansion and surface the platform mismatch instead of claiming the application can provide it.
- Keep account-wide totals separate from mdwn-only attribution. Included allowances are not per Worker or database. Account for storage/index overhead, temporary Import staging, preview activity, scheduled work, and any other subscriptions consuming the budget.
- Reuse the provider's billing/usage views and alerts. Early $1 and $3 overage warnings are the researched starting point; fixed subscriptions are additional. Adjust the available margin for actual taxes and other charges rather than presenting $6/$8 as universal invoice totals. Setup is a short operator task, not an automated billing integration.
- Select an explicit CPU ceiling using available workload evidence, covering authentication, ordinary routes, worst-case Import requests, and scheduled work as applicable. Do not adopt the large Paid default merely because it is available, and do not arbitrarily choose a low cap that recreates Free-tier failures. Existing aggregate observations may suffice; no mandatory benchmark suite is introduced.
- Retain existing anti-abuse and payload limits. Before higher Import bounds ship, address any missing scoped storage/admission guard needed to bound per-Account growth and concurrent staging. Use ciphertext sizes and existing ownership metadata, not plaintext inspection. Include temporary reservations and headroom rather than treating a successful preflight as authoritative capacity enforcement. Do not build a generic quota platform or financial ledger.
- Admission decisions must remain safe under concurrent mutations and retries. Failed, cancelled, and expired work must not leak capacity reservations; shared-target Imports retain the target Owner's ownership. Capacity rejection must not expose partial content, silently discard a draft, or block export, Hard deletion, Unpublishing, or revocation through application growth limits. These exemptions cannot bypass a provider outage or resource limit.
- Keep a short intervention runbook: inspect the affected meter, stop optional proofs/rehearsals and other discretionary work, restrict growth-producing operations as appropriate, and preserve security/data-exit operations where the platform remains available. No automatic global spending controller or claim that an early rejection is unbilled.

### 2. Selective removal of Free-only assumptions

- Retain Workers, D1, SQLite-compatible persistence, indexed queries, bounded transactions, and the current environment separation. No database migration to another provider and no new service binding is needed for the baseline.
- Update the current operating contract to supersede the Free-only and zero-overage assumptions in ADR-0002, ADR-0005, ADR-0006, and the relevant funding/capacity language in ADR-0007. Preserve the historical decisions and identify what is superseded; do not erase their rationale.
- Preserve browser-only cryptography, private SSR restrictions, Public-link fragment handling, no blanket invocation logs, no tracking, existing authorization, and no monetization. Paid infrastructure is not a reason to add Turnstile, weaken abuse controls, or move content processing to the service.
- Record the Paid D1 capacity and 30-day Time Travel window, including that only the shared included storage allowance is covered by the base price. Time Travel is operational recovery, not user-visible File history or immediate erasure from provider backups. Do not add a new backup system or repeat a full restore rehearsal solely because the plan changed.

### 3. Larger practical Imports

- Preserve the existing browser preflight, review, encryption, bounded chunk upload, and visible-atomic commit design. Do not replace staging with a giant transaction simply because Paid permits more queries.
- Select a coherent node/expanded-byte/staging envelope from evidence. The current 100-node, 8 MiB compressed, 16 MiB expanded, and 20 MiB encrypted-staging limits remain authoritative until their replacements are verified and documented. The 500–1,000-node range is a candidate for measurement, not an instruction to maximize every dimension.
- Keep normal File source and per-representation limits unchanged in this effort. Larger collections do not imply larger individual Files. Increase only the aggregate bounds and dependent constraints necessary for the selected envelope; preserve small chunks where practical.
- Keep browser validation, Worker validation, persistence constraints, public guidance, and boundary tests consistent. Preserve collision review, target ownership, Grant checks, conditional Replace, paired Publication updates, and encrypted Historical Comments.
- Preserve existing cancellation, retry, conflict, and unconfirmed-commit semantics. Failed or rejected work creates no visible partial hierarchy. Browser responsiveness, temporary staging growth, transaction duration, and Worker memory remain constraints even on Paid.
- A capacity increase needs evidence beyond a constants change. Reuse existing measurements and proof tooling; if they do not support the proposed bound, perform the smallest authorized targeted check or retain the current bound. Do not claim Paid production capacity from local execution alone.

### 4. Autonomous Public-material cleanup

- Use the existing scheduled maintenance mechanism first. Queues, Workflows, Durable Objects, new Workers, and new databases are not prerequisites for this feature.
- Only a committed, Owner-authorized irreversible Unpublishing seal permits autonomous cleanup. An unacknowledged request is not proof that a seal exists. The scheduler processes durable sealed state; it does not simulate a user's Session or acquire browser keys.
- Public access ends at the seal, independently of later cleanup success. Scheduled work removes only that Publication's existing Public-dependent graph through the established bounded deletion behavior, leaving the File and its Private material untouched.
- Cleanup must be idempotent and safe against browser retries, multiple scheduled attempts, and concurrent File deletion. An older cleanup must never delete a fresh Publication. A failed batch remains retryable without reopening access or claiming completion.
- Bound both work per Publication and work per scheduled invocation. Make progress across a backlog without starving the existing retention duties. Completion means all required Public dependents are removed, not merely that the Comment count reached zero.
- Browser progress remains useful but is no longer necessary to drive completion. Closing the browser after a confirmed seal must not prevent eventual completion on successful scheduled runs. Do not promise an exact wall-clock deletion deadline; show pending cleanup accurately and retain content-free operational failure visibility.
- Directory deletion beyond its current 500-node bound is a separate lifecycle change, not part of this cleanup feature. No server-side Key rotation, provisioning, encryption, or export is added.

### 5. Delivery and effort limits

- Decompose this parent specification before implementation. Budget safeguards gate raised capacity; implementation order does not create artificial dependencies between otherwise independent product changes.
- Prefer the smallest complete vertical changes and existing interfaces. Do not create a new framework, monitoring dashboard, accounting service, recurring benchmark, or matrix of remote environments.
- Preserve repository review, local preflight, and current-head CI requirements. This specification adds no repeated full-suite run on every edit and no mandatory remote rehearsal on every ticket or PR.
- Changes to subscriptions, alerts, deployments, databases, or other remote configuration need explicit operational authorization. Ordinary tests and spec publication create no Cloudflare resources and require no account credentials.

## Testing Decisions

The maintainer confirmed the existing test boundaries with an explicit constraint: avoid unnecessary suites, rehearsals, runtime, and resource requests. Reuse the highest existing boundary that proves each changed behavior. Test observable behavior, not internal call order or private helper structure.

### Primary application boundary: Worker requests and scheduled execution with real D1

Extend existing Import, Publication lifecycle, retention, and authorization tests rather than creating parallel suites. Add focused cases for the behavior actually changed:

- Capacity admission at and above the selected bound, concurrency/retry safety where accounting changes, and no partial writes or lost reservations after rejection or cancellation.
- Larger Import acceptance, one-over rejection, and preserved atomic visibility. Reuse existing collision, Replace, shared-ownership, retry, and uncertain-outcome regressions; do not duplicate their entire matrix for every new size.
- A real authorized Unpublishing seal followed by scheduled cleanup without further browser calls; bounded progress, retry after failure, and preservation of Private material. Extend existing deletion/race cases where necessary to prove the new scheduler cannot remove unrelated or later content.
- Continued security retention and availability of data-exit/security operations under application growth restrictions.

Use committed migrations and the actual runtime. No mock D1 and no test-only production endpoint. Direct D1 inspection may verify physical deletion and transaction invariants; it supplements, rather than replaces, request-boundary authorization coverage.

### Browser boundary: a small set of changed journeys

Reuse the current three-engine harness and fixtures. Extend the Import flow for the chosen envelope and actionable capacity errors, and the Unpublishing flow for leaving after confirmation and observing eventual cleanup. Keep existing privacy, cancellation, draft, and lifecycle regressions. Assertions solely about storage belong in the Worker tests, not an additional slow browser matrix.

### Operational boundary: only for tooling actually changed

Reuse existing command-level fault injection, configuration checks, and synthetic inputs if a script changes. Add calculation tests only if executable cost calculations are introduced; a short runbook and provider alerts do not require a new calculator. No tests need real credentials or billable resource creation. Unchanged restore machinery does not require a new rehearsal because Paid was enabled.

### Production-capacity evidence: narrow and opt-in

Inspect existing aggregate metrics or retained representative evidence first. If a proposed capacity increase still needs a remote check, adapt the existing proof tool to just the changed limits and relevant failure case. Prefer an explicitly designated isolated preview/test target with synthetic data; create a disposable target only when isolation requires it and the maintainer authorizes it. Never use production as a synthetic load-test target.

Before any such run, state the workload, target, resource ownership/cleanup, rough request/write footprint, and stop condition. Do not loop retries, run the entire historical proof matrix by default, or schedule recurring checks. If authorization or safe isolation is unavailable, retain the old limit and report the remaining evidence gap. Local tests prove behavior, not a production CPU allowance or an invoice ceiling.

## Out of Scope

- A guaranteed $5/$10 invoice cap, automated billing reconciliation, an account-wide real-time cost controller, or a generic quota platform.
- New Cloudflare subscriptions, service bindings, or environments by default; new always-running processes or recurring remote test jobs.
- Larger individual Files, resumable Directory deletion above 500 nodes, new Import resume/status protocols, or a rewrite of the staged Import design.
- Automatic increases to signup, Publication, or public Comment rate limits. Those policies remain in force until a separate evidence-backed change selects and approves new values.
- Attachment/image storage, AI features, full real-time collaborative editing, Comment notifications, user-visible version history, or server-side plaintext search.
- A new off-site backup system, automated scheduled database exports, or a full disaster-recovery program.
- Any relaxation of end-to-end privacy, hard-deletion semantics, no tracking, or no monetization.

## Further Notes

- Source research: [Workers Paid: mdwn's $5 target and $10 ceiling](../.scratch/mdwn/research/workers-paid-budget.md), checked 2026-10-11. It includes future options as well as current scope; this specification controls the implementation scope.
- This is a targeted follow-on to the [MVP buildable specification](buildable-spec.md), not a replacement for its unaffected contracts. Implementation must reconcile the affected normative text rather than silently override it.
- Relevant decisions: [Workers and D1](adr/0002-cloudflare-workers-and-d1.md), [privacy-preserving abuse controls](adr/0005-privacy-preserving-abuse-controls.md), [visible-atomic Imports](adr/0006-visible-atomic-staged-imports.md), and [no monetization](adr/0007-no-monetization-anonymous-support.md). Only their Free-only/fixed-zero-overage premises change here.
- Existing verification and behavior references: [testing](testing.md), [Import](import.md), [Publications](publications.md), [operations](operations.md), and [tree operations](tree-structure.md).
- Actual account subscription, current usage, tax treatment, selected CPU ceiling, storage headroom, and the replacement Import envelope have not been measured or configured by this planning work. They are explicit implementation inputs, not hidden assumptions. No increase ships while its relevant evidence is missing.
- Larger individual Files, larger Directory deletion, relaxed public-participation limits, protected off-site exports, attachments, and live notifications remain recorded opportunities in the research. They are not silently bundled into this effort.
