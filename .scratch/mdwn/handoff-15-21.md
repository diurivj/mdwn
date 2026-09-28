# Handoff: finish tickets 15–21 (session 2 → session 3)

Repo `/Users/diurivj/coding/mdwn`, written 2026-09-27. Read `AGENTS.md`, `CONTEXT.md`, `docs/sharing-server.md`, `docs/adr/0008-*`, `docs/enc-v1.md` and tickets `.scratch/mdwn/issues/15-*` … `21-*` first.

## Rules from the user (do not relitigate)

- **Stay local.** Work on local branch `feat/15-21-private-workspace`. No push, no PR, until 15–21 are finished and reviewed; then one Standards/Spec/RR8 review and one PR. Ask before any push.
- Keep every `pi-agent-*`/`work/*` branch and both `/private/tmp/mdwn-*` worktrees. `work/diagnose-remaining-browser-flakes-20260928` still holds the two dropped `[probe:*]` commits; leave it.
- Only spawn subagents if the user asks. Commit small, verified checkpoints.

## State of the branch

`0558f43` (last real commit from session 1) + this session's commits:

| Commit | What |
|---|---|
| `2177776` | 16 server: migration 0018, move/reorder/delete routes, `structure-client.ts`, Worker tests |
| `24a1e42` | 16 UI (`StructureActions.tsx`, own row under the title), e2e spec; 15 legacy-save guard |
| next commit | **WIP ticket 21** (see below) + ticket 15/16 evidence + this handoff |

Verified at the WIP commit: `npm run typecheck` passes; `npm test` 105 node + 244 Worker pass. Full `playwright test` ran once after the 16 server/UI change: 299 passed, 4 failed. Three of those were one real regression (the Share panel slid under the Files tree, so `sharing-browser.spec.ts:54` timed out), fixed in `24a1e42` and re-verified in Chromium only. The fourth was the known WebKit QR flake (`device-enrollment.spec.ts:314`, ticket 12). **Rerun the whole browser suite early next session.**

## Ticket status

| Ticket | State |
|---|---|
| 15 | All boxes ticked; needs only the final review. |
| 16 | All boxes ticked with evidence in the ticket. Two follow-ups belong to 21 (below). |
| 17 | ~70%: Comment/Import permission-matrix rows and box ticking remain. |
| 18 | ~60%: Private Comment thread capability envelopes (now designed, see 21) and box ticking. |
| 19 | ~15%: rotation executor not started (design below). |
| 20 | ~20%: fulfillment not started beyond direct-File current-key retry. |
| 21 | ~35%: schema + server + crypto + client written, **untested, no UI** (WIP commit). |

## Key facts learned this session (not obvious from the code)

- SQLite enforces `ON DELETE RESTRICT` **immediately even on DEFERRABLE keys**. `vault_nodes`<->`directory_entries` and `files`<->current representation reference each other that way, so moves and deletions run `PRAGMA defer_foreign_keys = on` as the first statement of their D1 batch (works in workerd; verified in local sqlite too). Any new batch that deletes nodes, representations or edges needs the same pragma.
- Node/File/Directory-namespace deletion requires a `tree_teardown_nodes` marker row inserted in the same batch (migration 0018 triggers). Direct `DELETE FROM vault_nodes` now always fails.
- The invocation-witness helpers `begin/marker/spent/proofTime/finish` in `app/sharing/sharing.server.ts` are reused by tree and comment mutations (table `sharing_write_witnesses`).
- A v2 File move **always** rotates the receiving key pair (same-revision `receiving-rotation` head transition). A Directory move is refused if a Directory-Grant recipient on the source's ancestors has no Directory Grant covering the destination (`sharedScopeRetained`). Legacy (v1) File moves need no rekey (future keys are wrapped under the destination).
- `LoadedFile.v2.receiving` now carries the verified receiving `CryptoKeyPair` (used to open comment thread keys).
- `/api/private/bootstrap` now also returns `profileEpoch`/`profileRevision` (trusted coordinates for opening the Account profile / Public pseudonym).
- Firefox can throw `NS_BINDING_ABORTED` on a `page.goto` whose document did load; `e2e/tree-structure.spec.ts` retries once (`open()` helper).
- Header layout: extra header buttons pushed the right-anchored Share panel (`SharingUI.tsx`, `absolute right-0 w-80`) under the Files tree. Keep new header controls out of the title row.

## Ticket 21: design as implemented (WIP)

- Migration **0019**: `comment_threads` (one `audience='private'` per File, `current_epoch`), `comment_thread_epochs` (per-epoch `key_id`, HPKE `receiving_wrapper` to the File receiving key, `previous_wrapper` = previous epoch key sealed under this one), `comment_thread_device_envelopes` (current-epoch HPKE envelopes for direct-File-Grant devices only), `comments` (ciphertext, `author_id`, `epoch`, `revision`), `thread_attributions` (author's pseudonym per thread under an epoch key). Triggers enforce current-epoch writes, forward-only epochs, revision+1 edits, and direct-Grant/active-device/current-registry for device envelopes.
- Key hierarchy: the Owner and Directory readers reach the thread key through the receiving private key (which follows the Directory capability). Direct readers use per-device envelopes. Any current reader can provision missing direct devices, and until then a direct reader sees "secure access is being prepared". Legacy v1 Files have no thread until migrated; the owned browser migrates on first edit.
- Crypto (`app/comments/crypto.ts`): purposes `private-comment-thread` (HPKE to receiving key with `recipientId=receivingKeyId`, or to device `recipientId=deviceId`; symmetric for the previous-epoch chain), `comment-content` (plaintext `["mdwn/private-comment/v1", authorId, text]`, context objectId=commentId, revision=comment revision), `attribution` (plaintext `["mdwn/attribution/v1", accountId, pseudonym]`, objectId=accountId). Text: CRLF→LF, no other controls, ≤2,000 code points, ciphertext ≤9,216 bytes.
- Server `app/comments/comments.server.ts` + route `app/routes/api/private-comments.ts` (metered budget): `POST /api/private/comments/files/:fileId` read (optional `{cursor}`), `PUT …/thread` create, `PATCH …/thread/devices` provision, `PUT …/comments` post, `PATCH /api/private/comments/comments/:id` edit own, `DELETE …/comments/:id` delete (author with read access, or Owner). Every ciphertext SELECT/CAS rechecks `fileAccessGuard`. Writes (not deletes) are blocked by rotation barriers.
- Client `app/comments/client.ts`: `loadPrivateThread`, `createPrivateThread`, `provisionThreadDevices`, `postPrivateComment`, `editPrivateComment`, `deletePrivateComment`, `loadOwnPseudonym`.

### Remaining for 21 (do these first)

1. Worker tests (new `tests/worker/comments.test.ts`, reuse `tests/worker/tree-fixtures.ts`): thread create race, read-only participation, direct-reader device envelope and provisioning, author-only edit/delete, Owner delete-any but never edit, epoch/attribution rules, and a revoked device getting 404 with no ciphertext. Also budget headers.
2. Revocation cleanup: `updateGrant` (`app/sharing/lifecycle.server.ts`) must delete `comment_thread_device_envelopes` for a removed direct-File recipient.
3. Ticket-16 follow-ups: `deleteNode` must drain `comments`, `thread_attributions`, `comment_thread_device_envelopes`, `comment_thread_epochs`, `comment_threads` (in that order) before `files`. A v2 File move must re-wrap the thread key to the new receiving key. Recommended: rotate the thread epoch on move (new key, `previous_wrapper`, device envelopes for current direct devices); server requires it when a thread exists.
4. UI: `CommentsPanel` in `FileEditor` (wide: right pane toggles Preview/Comments; narrow: third view "Comments"; "Private" thread label; composer at the bottom with an x/2000 counter; edit/delete own; Owner delete-any). Subject for hierarchy readers comes from `file.v2.receiving`; for direct readers use `LoadedDirectFile` plus device keys. Keep "Read-only — you can comment".
5. e2e spec on all three engines; tick ticket 21 boxes with evidence.

## Ticket 19 design (agreed direction, not started)

- `sharing_rotation_jobs` needs a `mode` (`rekey` for revoke/leave, `reprovision` for a permission change; upsert keeps the stronger). Add it by migration and set it in `updateGrant`.
- Executor runs in the Owner's browser, with a resumable cursor, one bounded step per request:
  - **File target, recipient removed:** a same-revision `recipient-set-update` head without the removed devices, plus a thread-epoch rotation.
  - **File target, permission change:** a head recipient-set update (new Grant generation).
  - **Directory target, permission change:** re-seal the capability to the recipient's devices at the new generation.
  - **Directory target, recipient removed:** top-down subtree rekey, one Directory per step. The step installs a new capability, re-encrypts its entries, updates its entry in the parent, and rotates receiving pairs and thread epochs of its Files. Legacy File keys are rewrapped. Grant envelopes are re-sealed for remaining grants in the subtree.
  - Finish: delete the job, then the barrier, only after verification.
- **Open decision:** thread a real capability epoch through all Directory contexts (listing heads, `directory-metadata`, `directory-capability`; many call sites, and `loadDirectory` currently requires `capabilityEpoch === 1`), or keep context epoch 1 and only replace the random key while bumping `directories.capability_epoch` for Grant envelopes. Decide before coding; the first is more faithful to the spec.
- UI copy must say rotation cannot recall already-downloaded content.

## Then

17/18 matrix rows and ticks → 20 fulfillment (Owner browser processes `provisioning_needs`, including thread device envelopes; cancel on revoke) → full `npm run test:all` → code review against a pinned diff → RR8 gate (`.agents/skills/rr8-post-review/SKILL.md`) → report Standards/Spec/RR8 separately → ask the user before pushing or opening the PR.
