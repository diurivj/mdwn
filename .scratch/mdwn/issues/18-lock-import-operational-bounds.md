# Lock import operational bounds

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by: 17

## Question

Using [Research: D1-backed encrypted import envelope](17-research-d1-import-envelope.md), turn the settled preflight-and-atomic import policy into a buildable MVP contract:

- Set maximum new nodes, Directory depth, source bytes per File, and total archive/input bytes for one import.
- Decide whether atomic import must work on the Workers Free query budget. If it must, require a schema-specific multi-row/batch proof before choosing the cap; otherwise explicitly accept a Paid Worker as an import prerequisite.
- Confirm whether the limit applies equally to loose Markdown/folders and a recognized mdwn Import archive.
- Specify the exact user-facing behavior for an unsupported, invalid, or oversized selection, including review and retry/splitting guidance.
- If the research shows one transaction is not viable, choose the smallest staging/commit protocol that leaves no partial imported tree visible.

This ticket does not reopen the owned-data boundary, Markdown-first archive format, collision policy, or historical Private Comment handling settled by [Import/export format & flow](11-import-export.md).

## Answer

**Resolution — Free-tier, visible-atomic imports.** mdwn keeps imports on Workers Free + D1 Free; a Paid Worker is not an import prerequisite. That is likely adequate for ordinary two-person use when encryption and archive preparation stay in the browser, as assessed in [Cloudflare Free viability for a two-person mdwn vault](../research/free-tier-two-person-viability.md). It does not promise that a 100-node import fits one literal D1 batch. Instead, the MVP uses private staging and one atomic visibility commit; a later one-batch fast path may be added only if it preserves this contract.

### Bounds and accounting

- One selection may contain at most **100 normalized source File or Directory nodes**. Every source node counts, including a candidate that the review later marks Skip or Replace; no collision path can bypass the cap.
- A source path may contain at most **32 Directory segments** after separator/path normalization. A 33rd Directory segment is over-depth.
- Each Markdown source is at most **256 KiB (262,144 UTF-8 bytes)**.
- A recognized mdwn Import archive is at most **8 MiB (8,388,608 bytes)** compressed. Every accepted selection is at most **16 MiB (16,777,216 bytes)** after expansion: archive manifests and historical-Private-Comment sidecars count as well as Markdown. Loose Markdown/folder input has no compressed-archive allowance but uses the same 16 MiB expanded-input cap.
- The same node, depth, Markdown-source, and expanded-input limits apply to loose `.md`/`.markdown` files/folders and recognized Import archives. Archive recognition does not grant a larger envelope.

### Browser review and failure contract

- The browser validates and normalizes the complete local selection before it sends any imported record: supported type/manifest, UTF-8, path safety, duplicate normalized paths, node count, depth, byte limits, and the settled collision choices. It encrypts only after successful preflight.
- A successful preflight shows a review with source-node count, planned creates/replaces/skips, maximum depth, and compressed/expanded sizes. The user explicitly confirms it before upload.
- Unsupported input identifies the local item and accepted format; invalid input identifies the safe local validation failure; oversized input identifies the measured dimension and configured limit. Each produces no upload and no File, with guidance to remove/fix, re-export, or split and retry. mdwn never imports a valid subset automatically.
- A cancelled, disconnected, failed, or stale import creates no visible File or Directory. The browser retains the local selection/review when it can, so the user can retry; it must revalidate before a retry or commit.

### Private staging and atomic visibility

- Confirmation creates an unguessable, initiating-Account-bound **Import session** with a 24-hour expiry, target Directory ID, expected target Owner ID, target/review revision, expected encrypted-manifest digest, and expected chunk/node/byte counts. It stores no plaintext path, name, Markdown, or capability.
- Authenticated uploads store bounded encrypted chunks scoped to that Import session. A retry is idempotent only for the same import ID, sequence, and digest. Cancelled or expired sessions become unreachable and are cleaned up; they are not a partial vault.
- Before commit, the service verifies the initiating Account, target’s current Owner, current import authority (the Owner or an active read/write Directory Grant; direct File and read-only Grants do not qualify), expiry, all expected chunks exactly once, digests/counts, structural references, row/payload bounds, selected collision actions, and the reviewed destination revisions. If the destination, Grant, or Owner changed, it creates no commit marker and returns the user to review with the changed conflicts highlighted; normal editing is never frozen during upload.
- The final small D1 transaction records the immutable committed-import marker. Every new imported node receives the target Directory Owner’s `owner_account_id`; imported canonical records carry their import ID, and every normal File/tree/direct-read/Share/export/count/background query must require either a non-import record or a matching committed marker. Thus the full hierarchy becomes reachable together and a failed final transaction leaves it entirely unreachable.
- Implementation must prove the chosen chunk plan on a disposable remote Workers Free + D1 deployment for the 100-node envelope, including failure/retry/expiry and no-visible-partial-tree cases. A failed proof reduces the bounded chunk plan or cap; it never silently requires a Paid plan.

The hard-to-reverse staging/read-invariant trade-off is recorded in [ADR 0006: Visible-atomic staged imports on the Free tier](../../../docs/adr/0006-visible-atomic-staged-imports.md).
