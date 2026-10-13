# Browser-driven secure access updates (ticket 19)

## Authority before cryptography

Grant revoke, recipient leave, and every permission change first change server authority in a short Device-proof-guarded transaction. That same transaction advances the target's safety fence, cancels superseded same-target work, and creates an Owner-authorized `key_rotation` job. Reads by removed recipients are denied immediately. Encrypted and structural writes beneath the root remain blocked until safe completion; hard deletion remains available. Shared-scope exits still return `409 key_rotation_required`: no move publishes a replacement beneath an old capability.

The fence is the **minimum next capability epoch**, separate from the installed source epoch. Directory listings/bootstrap and File responses describe their actual installed ciphertext; Grant envelope authority uses the current installed/fenced root context. Old source material can therefore be opened for maintenance without advertising it as new material or permitting writes. Directory child edges, metadata, signed heads, bootstrap/recovery, and ordinary create/rename/reorder/move all carry the installed Directory epoch. Existing epoch-1 wire shapes remain accepted. Superseded envelope epochs fail `stale-epoch`; future header epochs fail `unexpected-epoch` and never trigger an advance or a new job.

## Public protocol seams

`app/sharing/rotation.server.ts` implements thin resource actions registered under `app/routes/api/`. All calls require the same origin, the Owner's current device-bound Session, and an active enrolled Device proof; recipient possession of a Grant is not rotation authority. The initiating device/account is provenance, not an exclusive execution lease. Reads are empty-body POSTs, `no-store`, and do not consume proofs or update activity.

| Request | Work |
| --- | --- |
| `POST /api/private/key-rotations[?cursor=…]` | Up to 20 pending Owner jobs, progress, runnable/queued status, next cursor |
| `POST /api/private/key-rotations/:job/next` | One current source/item and the next bounded operation |
| `PATCH /api/private/key-rotations/:job/step` | `start`, `stage`, `promote`, `restart`, `advance`, or `finish` |
| `POST /api/private/key-rotations/:job/items/:object/entries[?cursor=…][&staged=1]` | Up to 20 encrypted Directory edges |
| `POST /api/private/key-rotations/:job/comments/:object` | Current scoped Owner Comment source |
| `POST /api/private/key-rotations/:job/grants/:grant/keys[?cursor=…]` | Up to 20 missing current recipient-device root targets |
| `PUT /api/private/key-rotations/:job/grants/:grant/keys` | Signed current root envelopes |
| `POST /api/private/key-rotations/:job/grants/:grant/comment-keys/:object[?cursor=…]` | Up to 20 missing current Comment targets |
| `PUT /api/private/key-rotations/:job/grants/:grant/comment-keys/:object` | Signed current Comment envelopes |

`resumeRotation` is the injectable browser/API seam; `resumeKeyRotation` obtains browser device handles and the unchanged Vault root key. One pass executes at most 20 operations by default (explicit bounds 1–100). `/account/key-rotations` uses native `clientLoader`, `clientAction`, and `fetcher.Form` to resume a pass and revalidate persisted progress. Its server-rendered document is only a public hydration shell, never job identities, keys, names, or plaintext.

## Top-down, atomic cutover

Replacement proceeds top-down: a child replacement is wrapped only beneath an already replaced affected parent. A later ancestor revocation preempts an older descendant job. Among ancestor-unblocked jobs, the oldest ID runs first; preempted descendants never block unrelated eligible work or deadlock their ancestor. An installed source changed by deletion or overlapping work restarts its staging, and a root already at the job's fence advances the fence before a new replacement. Per-node epochs need not equal the job's minimum root epoch.

- A fresh random replacement key is checkpointed as a job/object/epoch-bound `enc-v1` envelope under the Owner's Vault root key. This is not an ordinary recovery source. Other enrolled Owner devices reopen it and the currently installed hierarchy.
- Directory pages verify the original signed member commitments, decrypt metadata and child wrappers only in the browser, and stage ciphertext under the replacement key. Promotion replaces the Directory key/epoch/head and its parent edge/head atomically. The hidden root updates its Owner recovery envelope instead of a parent edge.
- File promotion creates a fresh immutable representation identity/head and content-key wrapper under the replacement File capability, retaining unchanged content ciphertext, content key, data epoch, and File revision. The old representation is removed, not mutated into history. A legacy File is converted within that promotion. Normal future saves generate fresh representation content keys.
- Root capability changes invalidate pending/active old-epoch envelopes and advance directly targeted relationship epochs. Final delivery uses only currently active recipient devices and current retained Grant/Comment coverage, including overlapping ancestor Grants. Normal delivery cannot bypass a seal; job-scoped delivery opens only after all replacement items complete. The final CAS rechecks full current coverage before unsealing.

Every mutation pins live proof/registry authority, job generation/order, source pointer/epoch/revision, and parent heads. Invocation-token-gated dependents run in one transactional D1 batch; deferred reciprocal File/tree foreign keys must agree at commit. Exact request-byte receipts permit harmless retries without rewinding progress or rewriting stored ciphertext. Changed bytes under the same operation identity conflict. Every new encryption pass creates a fresh writer namespace; no nonce counter, writer salt/state, plaintext key, or content is persisted as job metadata. A stored ciphertext retry reuses those bytes, not reconstructed nonce state.

Browser reads reuse the ordinary signed-listing verification and revision/digest checkpoints; paginated source heads and signed File heads obey the same rollback/fork checks. Successful promotions advance the affected Directory/parent and File checkpoints only after the Worker acknowledges the atomic step. Checkpoints contain only opaque identities, versions, and digests, not keys or content.

The encrypted listing retains the existing 512-KiB bound. Promotion constructs its one signed member commitment from paginated ciphertext; a listing exceeding the format limit remains sealed rather than being truncated. Backend mutation packets are bounded at 1.5 MiB. A full staging page obtains all child contexts in one bounded query rather than one per entry, keeping the complete request below D1 Free's 50-query invocation budget.

## Comment and lifecycle integration

Ticket 18's opaque requirement registry is the current Comment integration seam. Private thread capabilities receive fresh keys/epochs; retained Public-history capabilities keep their existing historical keys/epochs and receive renewed device envelopes. An owned Private thread requires an authenticated current Owner `vault-recovery` source; an imported Historical thread uses its `import_comment_envelopes` row under the installed File capability key as the Owner source. Missing source material leaves work sealed. A File promotion first re-wraps every imported thread envelope under the replacement File capability key in the same transaction, and its CAS requires the complete set, so the thread stays readable until its own item rotates the capability and installs a fresh import envelope. Rotation does not publish/unpublish, change an anonymous link, recall historical bodies, or change Public audiences.

Private Comment bodies and attributions are now integrated (ticket 21, [comments](comments.md)): the browser stages each per-record content-key wrapper in bounded pages through the item's `comment-items` endpoint, and promotion requires a staged wrapper at the current revision for every live record before rewrapping all wrappers, advancing the thread epoch and installing the replacement recovery or import envelope in one transaction. Body and pseudonym ciphertext never change. Public lifecycle producers remain in tickets 23–25; they must distinguish retained history from the current Collaborators-only audience epoch and fork that current epoch on loss of the last File-read path, as required by ADR-0003; retained keys may not be reused for new unauthorized audience writes. Producers must also pin registry lifecycle changes and remove sealed requirements/envelopes at irreversible teardown as documented in [sharing.md](sharing.md).

Hard deletion explicitly cancels targeted jobs and removes traversal/staging/receipts for deleted objects; a surviving staged parent restarts against its updated signed listing. Routine Device removal does not rotate Vault/content/Grant keys or mark a job complete just because its initiating device was removed. Recovery/enrollment owned-source selection excludes rotation jobs and uses proof-guarded current identity/epoch metadata, never header hints; Grant-derived capabilities never enter that flow. Migrations preserve existing owned-job cursors and tree constraints/triggers, and backfill pre-upgrade safety seals with Owner-resumable jobs without relabeling source ciphertext.

## Limits and verification

Rotation cannot recall previously downloaded plaintext, ciphertext, or keys. The progress UI says this explicitly. Content already encrypted under a downloaded key is not made secret retroactively; fresh future writes are protected after safe completion. Interrupted or failed work remains sealed and can be resumed, not silently expired or completed.

`tests/worker/key-rotation.test.ts` uses `SELF.fetch` and real D1 migrations for immediate denial, write seals, permission/leave, current envelope coverage, retained Comment keys, missing sources, two enrolled Owner devices/initiator removal, exact retries, wide paging, deletion restarts, overlapping ancestor precedence, inner/unrelated/ancestor scheduling, and supersession. `e2e/key-rotation.spec.ts` exercises real browser cryptography, Directory/File rollback and fork detection, accepted-promotion checkpoints, interrupted progress UI, SSR privacy, post-rotation owned provisioning, future File saves, and structural operations across Chromium, Firefox, and WebKit.

References: [enc-v1](enc-v1.md), [sharing](sharing.md), [tree operations](tree-structure.md), [D1 transactional batch](https://developers.cloudflare.com/d1/worker-api/d1-database/), [D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
