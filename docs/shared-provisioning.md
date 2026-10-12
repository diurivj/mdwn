# Shared-content provisioning (ticket 20)

A new or replacement Encryption device restores **owned** material from its `device-enrollment` Vault-root envelope. That envelope contains no Grant or Grant-derived Comment capability. An active Grant's missing device coverage is represented by the existing opaque `(grant_id, device_id, grant_key_epoch)` need, created inside the enrollment/recovery cutover. Provisioning is subsequent non-authorizing work: it never enrolls a device, binds a Session, or changes recovery material.

## Source authority

An active Owner device may provision its owned capability. An active recipient device may forward a **current, already-delivered** Grant or Comment capability only to another active device of the **same recipient Account and same Grant**. This is not resharing. A device with server authorization but no current envelope cannot become a source, even if it supplies structurally valid HPKE ciphertext. Other Accounts and devices possessing cached keys after losing authority cannot provision.

Both root and Comment uploads check live relationship authority, exact capability/Grant epochs, both registry snapshots, target membership, current source coverage, write seals and the request's Device proof in the committing transaction. Delivery signatures bind the actual source device; historical accepted signatures remain verifiable after an unrelated registry addition or signer removal. Pending Share acceptance remains Owner-signed and pinned to complete current registries.

## Bounded browser protocol

- `POST /api/private/grant-provisioning/next` is an empty-body, proof-bound, `no-store` read. It returns at most one missing root or Comment/device item that this browser can provision, plus whether this device is waiting. No read consumes a mutation proof or records device activity.
- Source material is either the Owner's installed signed hierarchy, an owned current Comment recovery envelope, or the requesting recipient device's current signed Grant/Comment envelope. No plaintext key reaches the Worker, and no Public-link fragment is accepted as a source. Owner sources are opened by `app/shared/sharing/owned-capabilities.ts`, which pending-Share preparation ([sharing](sharing.md)) uses unchanged.
- The browser uses the existing signed `PUT /api/private/grants/:id/keys` or `comment-keys/:objectId` delivery protocol. Each packet remains bounded to 20 envelopes; automatic fulfillment submits one at a time.
- `resumeGrantProvisioning` performs at most 20 items per pass by default, with explicit bounds of 1–100. Current persisted coverage selects the next item, so another authorized enrolled device can resume after interruption without any local progress/key checkpoint.
- An uncertain network response retries the same saved request/envelope bytes with a fresh Device proof. A later visit discovers already-stored coverage before encrypting. Re-sealing an uncommitted item creates a fresh HPKE sender context; no nonce state is persisted or restored.
- The first current delivery wins. Exact retries and concurrent re-seals never overwrite already-current accepted envelope bytes. Pending Share staging remains replaceable; a new capability/Grant epoch explicitly supersedes prior material.
- A need retires only after complete current root **and retained Private/Public Comment capability** coverage. Missing Owner Comment recovery sources are skipped, not guessed or falsely marked complete. Comments and Publication lifecycle producers remain responsible for their requirement registry and owned recovery sources (tickets 21–25).

`/account/shared-access` uses native React Router `clientLoader`, `clientAction` and `fetcher.Form` for status and explicit resumption. Visiting a ready Files or device-access page starts bounded passes through that same browser action; failures pause safely and a later visit/action resumes. Automatic submissions use RR8's `defaultShouldRevalidate: false`: the action returns current provisioning status itself, without reloading Files and risking an unsaved draft on a failed background read. Explicit shared-access submissions retain ordinary revalidation. Private data, keys, names and job identities never enter the server-rendered hydration shell.

Until root coverage arrives, a shared File/Directory view shows **Shared content is being securely provisioned**, no names or plaintext, and a **Check shared access** revalidation button. Missing Comment-only coverage does not withhold an independently provisioned File; the Comment endpoint remains ciphertext-free `409 secure_access_preparing`.

## Cutover and revocation

Routine enrollment retains other active devices, including a source holder. Vault recovery tombstones every former device and supersedes their device envelopes; the replacement cannot source shared material from the recovered Vault root. It waits for an authorized source, normally the content Owner.

Revocation/leave cancels the need and removes the relationship's envelopes before any deferred upload can commit. Permission or capability changes invalidate old work; rotation seals prevent forwarding old capabilities while replacements are incomplete. Provisioning checks current authority again even when ciphertext has already been prepared. Cached plaintext and keys cannot be recalled.

## Timed Grant expiry

The Owner can set or clear a deadline on an accepted, still-live Grant with `PATCH /api/private/grants/:id` and `{ expectedRevision, expiresAt }`. `expiresAt` is a future safe-integer Unix timestamp in milliseconds, or `null` for no deadline. It may accompany `permission`. An expiry-only change advances the relationship revision without rotating keys; a permission change retains the existing rotation protocol. Existing and newly accepted Grants default to no deadline. The sharing-management UI remains outside this ticket; the deadline is exposed through the signed API and relationship listings.

D1 statement-time millisecond predicates enforce expiry in final access/envelope SELECTs and mutation CAS conditions. Neither a stale browser clock, prepared ciphertext, a new proof, nor delayed cron can extend access beyond the stored deadline. Expired Grants cannot be extended/reactivated. Their received-list entries and provisioning needs become inaccessible immediately; overlapping live Grants still supply their independent authority.

An expired retained Grant is also an immediate write seal on its target/subtree. Physical cleanup does not lift it:

- The scheduled Worker deletes at most 20 rows from each of the selected expired Grant's need/root-envelope/Comment-envelope tables. It retains the Grant seal and skips already-drained Grants on subsequent runs. It does not invent device authority or create cryptographic jobs.
- `PATCH /api/private/grant-provisioning/expire` accepts only `{}` and the Owner's current Device proof. Each pass drains the same bounded dependencies and at most 20 rows per staging/traversal/receipt table from any superseded same-target rotation. Traversal items remain until their staged edges are gone. Once all dependencies are empty, the handoff CAS pins that emptiness and the current fence, then atomically replaces the expired Grant seal with the existing Owner-device-provenance rotation fence/job.
- Browser provisioning passes prioritize this cleanup/handoff. They count each cleanup pass toward the same operation bound. Rotation remains browser-driven through **Secure access updates**, not an unbounded service job.
- An Owner's rotation jobs pause while any expired Grant still awaits handoff, preventing an older delivery/promotion from bypassing the new seal. Normal writes outside affected subtrees and owned reads are not blocked by that pause. The updates page links to shared access cleanup.

Migration `0018_handy_bishop.sql` adds the nullable deadline and covering/cleanup indexes, and replaces the Directory-head and provisioning-need triggers with expiry-aware variants. It does not change encryption formats, recovery envelopes, or either enrollment cutover.

## Verification seams

`tests/worker/grant-provisioning.test.ts` and `grant-expiry.test.ts` exercise signed, same-origin resource requests against real migrated D1: missing/foreign Origin and cross-site rejection, source possession/authority, same-Account forwarding, 20-device packets, byte-preserving retries, Comment coverage, revocation, expired access and write seals, non-reactivation, overlapping Grants, bounded cleanup/cron and rotation handoff (including more than one page of superseded staging, traversal items and receipts). The migration constraint test independently checks an expired Collaborator cannot sign a new Directory head.

`e2e/grant-provisioning.spec.ts` exercises actual QR enrollment and phrase recovery, holder/Owner root plus retained Comment fulfillment, an acknowledged-but-lost upload response, interrupted bounded resumption and revocation of a prepared upload. `e2e/shared-file.spec.ts` covers automatic Files-visit fulfillment, nameless pending/SSR state with an actual fragment capability, and timed-expiry handoff. `e2e/provisioning-editor.spec.ts` verifies that automatic cleanup cannot unmount an unsaved draft when private reloads fail. These use Chromium, Firefox and WebKit. Comment producers remain fixture-seeded until their own tickets implement the producer lifecycle.

See [sharing](sharing.md), [key rotation](key-rotation.md), and [enc-v1](enc-v1.md) for the signed contexts, owned/Grant separation and nonce rules.
