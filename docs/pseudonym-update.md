# Public pseudonym update (ticket 24)

Every Account has one generated, non-identifying **Public pseudonym** inside its
encrypted `account_profiles` ciphertext. It is displayed through separately
encrypted `attribution` contexts: one `thread_attributions` row per Private or
Public Comment thread the Account has authored in, and one `publication_authors`
declaration per active Publication link that credits it. Changing the pseudonym
is one exclusive, resumable, browser-driven **Pseudonym-update job** that
re-seals every context and swaps the Account profile in a single commit. Until
that commit, every view keeps the old pseudonym; afterwards every view shows the
new one. The service never sees a plaintext pseudonym, capability, or key, and
cached copies and screenshots cannot be recalled.

## Data model

- `account_profiles.pseudonym_changed_at` records the last committed change. It
  is `NULL` until the first change; the cooldown is enforced from this value and
  never from client input.
- `crypto_jobs` gains the `pseudonym_update` kind, anchored by the partial
  unique index `crypto_jobs_pseudonym_pending_idx` on `account_id` where
  `kind = 'pseudonym_update' AND state = 'pending'`, so an Account has at most
  one pending job. The target/epoch columns stay `NULL`; the initiating device
  is the job's device.
- `pseudonym_update_profiles` holds the staged replacement profile ciphertext,
  epoch and revision. `pseudonym_update_items` holds one staged row per context:
  `kind` is `thread` or `publication`, `record_id` names the attribution or
  declaration, `revision` is the sealed next revision, and a thread row also
  carries the re-wrapped content key and its capability epoch. `CHECK`
  constraints mirror the 4,096-byte attribution and 16,384-byte wrapper bounds,
  and reviewed triggers require every staged row to belong to a
  `pseudonym_update` job.
- Commit deletes the job's staged rows and profile in the same transaction;
  cancel deletes staging and leaves `pseudonym_changed_at` untouched, so a
  cancelled attempt consumes no cooldown.

## Required contexts

A context is required when the Account can still open and rewrite it:

- a `thread_attributions` row whose thread capability is available through the
  Account's own `vault-recovery` envelope (thread Owner) or an active, live Grant
  envelope on this device (`can_read_private_comments`), and
- a `publication_authors` declaration that is `ciphertext IS NOT NULL`,
  `link_id = publications.current_link_id` on an `active` Publication, and
  covered by current File-read access.

Live File-read access is re-derived inside the context query itself, exactly as
Comment reads derive it. A context whose access is gone — for example a
Collaborator's attribution after its last Grant is revoked — can no longer be
opened by any of that Account's devices, so it is not required and keeps the old
displayed pseudonym. It is the live-context analogue of a cached copy. A
Publication link rotation also retires a declaration (the row is served only for
its own link), so it is not required until the ordinary re-declaration path
writes a current-link declaration.

## Envelope shape and revisions

A thread attribution is two `attribution` envelopes: the pseudonym under a fresh
per-record content key, and that content key under the thread capability
(Private) or the epoch capability (Public). A publication declaration is one
HPKE `publication-attribution` envelope to the Publication link. New
declarations seal at revision 1; a pseudonym update re-seals each layer at the
stored `revision + 1`, keeps the record and epoch identity, and uses a fresh
`enc-v1` writer. No nonce state is stored or restored.

## API

All routes require the same origin, a device-bound Session and a current Device
proof. Reads are bodyless POSTs; responses are `no-store`.

| Request | Operation |
| --- | --- |
| `POST /api/private/pseudonym-updates` | The pending job (if any) and the cooldown's `nextChangeAt` |
| `PUT /api/private/pseudonym-updates` | Start the one job, pinned to the current profile revision |
| `POST /api/private/pseudonym-updates/:job/next` | The staged profile plus a bounded page of contexts to seal, or `commit`/`complete`/`cancelled` |
| `PUT /api/private/pseudonym-updates/:job/items/:recordId` | Stage one re-sealed context |
| `PATCH /api/private/pseudonym-updates/:job/step` | `commit` or `cancel` |

`next` returns up to 20 contexts with everything the browser needs: for a thread
context, the scope identity, the next revision, the capability identity and the
complete signed capability envelope (`vault-recovery` for an Owner device, or
the grant envelope for a Collaborator device); for a Publication declaration,
the Publication, link, public key, declaration ID and next revision. The staged
profile ciphertext is returned so any enrolled device can open the new pseudonym
with its own Vault-root enrollment envelope and resume the job.

Staging validates the exact envelope framing: the scope (Owner Vault for a
Private thread, logical Publication for a Public thread or declaration), the
record, the next revision, and the current capability identity and epoch. A
crossed, malformed or stale submission is rejected without changing state. A
staged item is device-independent, so interrupted staging resumes from any
enrolled device.

## Atomic commit

The commit anchor updates `account_profiles` only when the staged profile epoch
still matches, the required-context set has no unstaged member at its current
revision and capability epoch, and the cooldown is still open. Its dependents
then copy every staged thread attribution and publication declaration in the
same D1 transaction, mark the job `complete`, and delete the staging rows. A
context that changed revision, rotated capability, or appeared after staging
blocks commit; the next pass reports it and the browser restages it. Because
readers resolve displayed pseudonyms only from these rows, the visible state is
all-old before the transaction and all-new after it — never a mixed rename.

## Cooldown

A change is allowed at most once every 30 days. Start rejects a change while
`pseudonym_changed_at + 30 days` is in the future with `409 pseudonym_cooldown`
and `nextChangeAt`; the profile read also returns `pseudonymChangedAt` and
`nextChangeAt`, so the UI can state the date before the user tries. The commit
anchor re-checks the same condition, so a lost race cannot bypass it. The first
change after signup is immediate because signup leaves `pseudonym_changed_at`
`NULL`.

## Blocked normal work

While a job is pending, every mutation that would mint a new attribution context
is refused with `409 pseudonym_update_pending` before any counter or proof is
consumed: creating a Private or Public Comment and writing a Publication
declaration (including self-selection by the Owner). The workspace composer
names the pending update and points at the Public pseudonym page instead of a
generic conflict. Comment edits and hard deletions, key rotation, hard
deletion, export, and session operations stay available. The block is per
Account: a Collaborator's Comments on a shared File are unaffected. The UI keeps
the workspace path visible but its own new Comments wait for the job to commit
or be cancelled.

## Trust limits

HPKE base mode and the honest-client boundary are unchanged: the service can
withhold, substitute, or replay staged ciphertext, and a client cannot detect it
without the capability. The update cannot reach contexts the Account can no
longer open, already-downloaded plaintext, cached copies, or screenshots, and
the UI says so.

## Verification

`tests/worker/pseudonym-update.test.ts` drives the signed API and the real
browser driver against migrated D1: an Owner's Private thread attribution, a
Public epoch attribution read back through the anonymous link wrapper, and an
owner-authored Publication declaration move from all-old to all-new together; a
Collaborator's update resumes through its signed Grant envelope and leaves the
Owner's rows untouched; staged pages persist across an interruption and a
second enrolled device, with its own Grant envelope, finishes the job; malformed
or stale staging is rejected; cancel consumes no cooldown; idempotent start
retries do not create a second job; and the pending job blocks only the changing
Account's new attribution contexts. `e2e/pseudonym-update.spec.ts` authors a
real Comment in Chromium, changes the pseudonym from `/account/pseudonym`,
states the cooldown, and reads the new label back in the workspace.

See [enc-v1](enc-v1.md), [comments](comments.md), [publications](publications.md)
and [sharing](sharing.md).
