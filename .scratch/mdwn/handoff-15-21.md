# Handoff: finish tickets 15–21 (session 3 → session 4)

Repo `/Users/diurivj/coding/mdwn`, written 2026-09-27. Read `AGENTS.md`, `CONTEXT.md`, `docs/sharing-server.md`, `docs/adr/0008-*`, `docs/enc-v1.md` and tickets `.scratch/mdwn/issues/15-*` … `21-*` first.

## Rules from the user (do not relitigate)

- **Stay local.** Work on local branch `feat/15-21-private-workspace`. No push, no PR, until 15–21 are finished and reviewed; then one Standards/Spec/RR8 review and one PR. Ask before any push.
- Keep every `pi-agent-*`/`work/*` branch and both `/private/tmp/mdwn-*` worktrees. `work/diagnose-remaining-browser-flakes-20260928` still holds the two dropped `[probe:*]` commits; leave it.
- Only spawn subagents if the user asks. Commit small, verified checkpoints.

## State of the branch

| Commit | What |
|---|---|
| `2177776` | 16 server: migration 0018, move/reorder/delete routes, `structure-client.ts`, Worker tests |
| `24a1e42` | 16 UI (`StructureActions.tsx`, own row under the title), e2e spec; 15 legacy-save guard |
| `ca11599` | 21 WIP: schema + server + crypto + client |
| `5032a66` | 21 lifecycle under revoke/move/delete, thread key-state route, registry-stale provisioning, `tests/worker/comments.test.ts` |
| after `5032a66` | 21 `CommentsPanel` UI, pagination, `e2e/private-comments.spec.ts`, ticket 21 ticked, docs |

Session 3 baseline (at `ca11599`): typecheck clean, 105 node + 244 Worker tests, full Playwright 302 passed / 1 failed (known WebKit QR flake `device-enrollment.spec.ts:314`).

## Ticket status

| Ticket | State |
|---|---|
| 15 | All boxes ticked; needs only the final review. |
| 16 | All boxes ticked; Comment follow-ups done in `5032a66`. |
| 17 | All boxes ticked with evidence (session 3); needs only the final review. Handle *claiming* has no ticket. |
| 18 | All boxes ticked with evidence (session 3); needs only the final review. |
| 19 | All boxes ticked with evidence (session 3); needs only the final review. |
| 20 | ~20%: fulfillment not started beyond direct-File current-key retry; must include waiting direct thread devices. |
| 21 | All boxes ticked with evidence; needs only the final review. |

## Key facts learned this session (not obvious from the code)

- SQLite enforces `ON DELETE RESTRICT` **immediately even on DEFERRABLE keys**. `vault_nodes`<->`directory_entries` and `files`<->current representation reference each other that way, so moves and deletions run `PRAGMA defer_foreign_keys = on` as the first statement of their D1 batch (works in workerd; verified in local sqlite too). Any new batch that deletes nodes, representations or edges needs the same pragma.
- Node/File/Directory-namespace deletion requires a `tree_teardown_nodes` marker row inserted in the same batch (migration 0018 triggers). Direct `DELETE FROM vault_nodes` now always fails.
- The invocation-witness helpers `begin/marker/spent/proofTime/finish` in `app/sharing/sharing.server.ts` are reused by tree and comment mutations (table `sharing_write_witnesses`).
- A v2 File move **always** rotates the receiving key pair (same-revision `receiving-rotation` head transition). A Directory move is refused if a Directory-Grant recipient on the source's ancestors has no Directory Grant covering the destination (`sharedScopeRetained`). Legacy (v1) File moves need no rekey (future keys are wrapped under the destination).
- `LoadedFile.v2.receiving` now carries the verified receiving `CryptoKeyPair` (used to open comment thread keys).
- `/api/private/bootstrap` now also returns `profileEpoch`/`profileRevision` (trusted coordinates for opening the Account profile / Public pseudonym).
- Firefox can throw `NS_BINDING_ABORTED` on a `page.goto` whose document did load; `e2e/tree-structure.spec.ts` retries once (`open()` helper).
- Header layout: extra header buttons pushed the right-anchored Share panel (`SharingUI.tsx`, `absolute right-0 w-80`) under the Files tree. Keep new header controls out of the title row.

## Ticket 21 (done, pending review)

Design and wire contract live in `docs/sharing-server.md` § Private Comment threads and the ticket 21 comments. Things the next tickets must reuse:

- Ticket 19: any receiving-pair rotation must also rotate the thread epoch in the same batch with `parseThreadRotation`/`threadRotationGuard`/`threadRotationStatements` (`app/comments/comments.server.ts`); the browser side is `loadThreadKeySource` + `prepareThreadRotation` (`app/comments/client.ts`), as `prepareTreeMove` does.
- Ticket 20: waiting direct thread devices are provisioned only when a reader opens the Comments pane (`provisionThreadDevices`); the Owner's fulfillment loop should call the same route.
- Public keys fed to HPKE must be imported extractable (workerd refuses non-extractable; browsers ignore the flag). `app/tree/editor-client.ts` `recipientKeys` still imports `false` and only works because browsers treat public keys as extractable.

## Known WebKit flake: POST on a connection workerd is closing (mitigated in the signup fixture)

- Symptom: `openEditor` signup times out waiting for `/api/signup/verify`; the one captured trace shows `POST /api/signup/options` failing with "The network connection was lost". It hits about one WebKit test every one to two full runs.
- Cause: the test harness is served by workerd directly (`lsof` on the harness port), which closes idle HTTP/1.1 keep-alive connections after 5.0s without a `Keep-Alive` header. A request sent on that socket in the last ~2ms fails. Chromium and Firefox transparently retry it; WebKit does not. Signup is exposed because the proof of work leaves a variable 0.3–50s idle gap before `/options`, but any POST whose idle gap lands at ~5.0s can fail the same way.
- Tight loop (kept in the session scratchpad as `zz-keepalive-race.spec.ts`): in a page, `fetch` POST, wait 4996–5002ms, POST again. WebKit failed 29/80 with `Load failed`; Chromium 0/80; Firefox 0/80. `workerd.capnp` has no HTTP idle-timeout setting.
- Fix (user decision: test setup only): `openEditor`'s `signUp` retries once, only after a network-level failure of an `/api/signup/*` request, and uses the successful `/verify` response's transcript; an HTTP refusal still fails. Verified with a throwaway spec that aborts or 400s the first `/options` on all engines; the full suite then passed 309/309. Inline signups in other specs (device-enrollment, vault/auth recovery, private-tree-flow, signup-integrity) are still exposed, rarely; no app code changed.
- Never run two Playwright invocations at once here: they share `test-results/` and one wipes the other's traces (ENOENT failures).

## Ticket 19 design (agreed direction, not started)

- `sharing_rotation_jobs` needs a `mode` (`rekey` for revoke/leave, `reprovision` for a permission change; upsert keeps the stronger). Add it by migration and set it in `updateGrant`.
- Executor runs in the Owner's browser, with a resumable cursor, one bounded step per request:
  - **File target, recipient removed:** a same-revision `recipient-set-update` head without the removed devices, plus a thread-epoch rotation.
  - **File target, permission change:** a head recipient-set update (new Grant generation).
  - **Directory target, permission change:** re-seal the capability to the recipient's devices at the new generation.
  - **Directory target, recipient removed:** top-down subtree rekey, one Directory per step. The step installs a new capability, re-encrypts its entries, updates its entry in the parent, and rotates receiving pairs and thread epochs of its Files. Legacy File keys are rewrapped. Grant envelopes are re-sealed for remaining grants in the subtree.
  - Finish: delete the job, then the barrier, only after verification.
- **Decision (user, 2026-09-27): thread the real Directory capability epoch** through all Directory contexts (listing heads, `directory-metadata`, `directory-capability`). Land it first as a behaviour-preserving refactor with every epoch still 1. The child's epoch comes from its committed `directory-capability` envelope header in the parent's signed listing (as legacy File keys already do), a granted root's from the Grant envelope `targetEpoch` (owned root: 1); the server checks `directories.capability_epoch`. No listing-format change.
- **Executor protocol (session 3, being implemented):**
  - Done: migration 0020 (`sharing_rotation_jobs.mode`, forward-only `capability_epoch`), `updateGrant` sets mode, hidden root never shared, epoch threaded through all Directory contexts.
  - Directory Grant readiness is proven by the Owner-signed offer's per-device `contentDigest` (`roots`). Any re-sealed Directory capability therefore needs a **re-signed offer** (same share/grant/label IDs, `materialRevision + 1`, current `targetEpoch`/permission, new content digests, existing current label digests), replacing `grant_labels.offer_*`. Add an UPDATE trigger on `grant_labels` mirroring the INSERT signer rule. Devices without a current label delivery stay as provisioning needs (ticket 20). File Grants are proven by the signed File head, so File steps need no new offer.
  - Routes `/api/private/rotations/*` (own resource route, Owner only, larger body limit): list pending jobs; `next` step for a job; one `PATCH` per step, CAS'd on `barrier_epoch` and `cursor`, allowed under the job's own barrier; the final step deletes the job, then the barrier.
  - Steps: **File target** (either mode): same-revision `recipient-set-update` head for the live recipients, plus a thread-epoch rotation in `rekey`. **Directory `reprovision`**: re-seal the capability for the target's Grants + re-signed offers. **Directory `rekey`**: nodes of the frozen subtree in `(depth, id)` order, cursor = last done. A Directory step installs K' at epoch+1, re-seals every entry (names/orders at the new epoch, child/legacy/receiving wrappers re-wrapped unchanged), re-signs its listing and its wrapper in the parent listing, and re-seals Grants on it. A receiving-File step rotates the receiving pair like a move without namespace change (entry + parent listing + `receiving-rotation` head + thread epoch). Legacy Files need no own step.

- UI copy must say rotation cannot recall already-downloaded content.

## For ticket 20 (next)

- **Decision (user, 2026-09-29): only the Owner's browser fulfills needs.** A recipient's devices never fulfill, and the ticket 18 direct-File holder completion stays as it is. Session 4 (orchestrator) runs ticket 20 as Sonnet implementer `work/20-grant-fulfillment`, branched from `feat/15-21-private-workspace`.
- **Ticket 07 open criteria (user, 2026-09-29):** Network-bucket rotation and 24 h physical deletion go to 31. The Public Comment 429 with draft survival, and the honeypot, go to 23 (criteria added there).
- Re-sealing a Directory capability for a device needs a **re-signed offer** listing that device (see `prepareGrantSeals`/`parseGrantSeals`/`grantSealStatements` in `app/sharing/rotation-{client,server}.ts`); a device without a current `grant_label_deliveries` row also needs its Shared-as label re-sealed. The Owner can open the label from `grant_labels.owner_copy` with the Vault root.
- Direct File devices need a same-revision recipient-set update (`prepareFileTargetRotation` does this for the live set) plus Private thread envelopes (`provisionThreadDevices`).
- `RotationStatus` already runs in the Owner's browser on owned Files pages; a fulfillment loop can share its runner pattern.

## Then

20 fulfillment (Owner browser processes `provisioning_needs`, including thread device envelopes; cancel on revoke) → full `npm run test:all` → code review against a pinned diff → RR8 gate (`.agents/skills/rr8-post-review/SKILL.md`) → report Standards/Spec/RR8 separately → ask the user before pushing or opening the PR.
