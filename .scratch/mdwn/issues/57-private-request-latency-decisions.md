# 57: Private request latency: decisions before the next speed-ups

**What to build:** The speed-ups and the privacy fix the maintainer approved on 2026-10-12 (see **Decisions** below): reuse settled device state for a short window, return the next device state with every proof-guarded response, keep verified listings and keys in the tab's memory with background revalidation, enable Smart Placement, start background upkeep less often, and stop Cloudflare injecting its Web Analytics beacon into HTML. This ticket first recorded what makes private pages slow after [56](56-pre-launch-polish.md) and the options that needed the maintainer's decision.

**Type:** feature (was decision)

**Status:** ready-for-agent

**Blocked by:** none.

**Related:** [54: Laboratorio redesign](54-editorial-redesign.md) (per-operation registry reads), [`docs/serving-and-security.md`](../../../docs/serving-and-security.md), [ADR-0002](../../../docs/adr/0002-cloudflare-workers-and-d1.md).

## Where the time goes

Measured on 2026-10-11:

- From the maintainer's network, production requests are served by the DFW colo and a small API response takes about 150 ms (`/api/auth/session` TTFB 147–157 ms on a warm connection). Production D1 (`mdwn-db-production`) runs in WNAM with read replication disabled, so every D1 query from DFW crosses regions.
- Every private operation is two sequential browser round trips: `/api/device/state`, then the proof-guarded request whose proof binds that state's Session binding and registry epoch. Ticket 54 deliberately kept a fresh registry read for every operation that starts after the previous one settles.
- A library navigation is two dependent private operations, so four sequential round trips before content: device state → bootstrap with the path; device state → listings with the File. With 100 ms emulated latency per API request: library root from another page 433 ms (681 ms before 56), root → File 490 ms.
- Each navigation also starts background requests in parallel with the content: Session presence, shared-access provisioning (`grant-provisioning/next`), owned-key provisioning and, for Files, the Comment thread upkeep.
- Before 56, every hashed asset was served `max-age=0, must-revalidate` and revalidated on each load (150–870 ms TTFB per asset from the maintainer's network).

Done in 56: immutable caching for `/assets/*`; `/files` renders the root without a redirect and a second bootstrap (six sequential round trips to four); remembered expanded folders are fetched with the selected path; each private request and `/api/device/state` read the Session and its device/registry in parallel rather than one after the other (one fewer sequential D1 round trip per request); navigation shows the destination at once; opening a Directory listing canonicalizes each name once instead of re-canonicalizing both names of every pair to find duplicates (500 entries: about 280 ms of that check in Node, removed).

## Decisions needed

1. **Reuse registry state across operations.** Keep a settled `/api/device/state` answer for a short window (seconds), retrying once with a fresh read when the Worker rejects a stale epoch or binding. This removes one of the two round trips per operation (four to three, or two with request chaining) at the cost of the rule from 54. The Worker still verifies every proof, so a stale read fails closed.
2. **Return the next registry state with each private response**, so chained operations need no separate read. A wire-protocol change to every private route.
3. **Keep verified listings and keys for the tab.** Revisit the library from memory and revalidate in the background by listing revision. Most in-library navigation would become instant; decrypted names and keys would live longer in page memory, and invalidation must follow other tabs and devices.
4. **Worker placement and D1 location.** Smart Placement for D1-heavy routes, D1 read replication with the Sessions API (bookmarks for read-your-writes), or a primary closer to most people. Cloudflare configuration and consistency decisions.
5. **Background request frequency.** Check Session presence on focus and visibility rather than every location change, and run shared provisioning at most once per interval per tab. Trades cross-tab sign-out detection and provisioning promptness for fewer requests.
6. **Cloudflare Web Analytics is injected into production pages.** The HTML served for `https://mdwn.me/` carries `static.cloudflareinsights.com/beacon.min.js` (with the page's CSP nonce), which posts to `/cdn-cgi/rum`. The footer promises "No passwords, ads, trackers, or analytics." Either turn off Web Analytics' automatic setup for the zone in the Cloudflare dashboard, or send `Cache-Control: no-transform` on HTML so Cloudflare cannot inject it (Cloudflare documents that no-transform prevents injection), or change the claim.

## Decisions (2026-10-12)

The maintainer approved items 1, 2, 3, 5 and 6 and the Smart Placement part of item 4.

1. **Reuse device state — approved.** A settled `/api/device/state` answer, or one refreshed by item 2, signs operations that start within 10 seconds of it. A proof denial (`403` that is not a named policy denial) on a request signed with reused state retries once with fresh state: the denial's own state header when present, otherwise a fresh read. A second denial is final. In-flight reads are still never shared across navigation abort signals (ticket 54). A local device record with a newer registry epoch than the reused state forces a fresh read instead of a `stale` error. A `401`, an Account or device mismatch, signing in or out, and recovery all discard reused state.
2. **Return device state with private responses — approved.** Every response to a request that carries a Device proof includes an `X-Mdwn-Device-State` header with the `/api/device/state` fields (`accountId`, `deviceId`, `registryEpoch`, `sessionBinding`). The Worker reads it for the request's Session at its boundary, in parallel with the handler, and omits it when there is no normal Session. Route bodies do not change. The browser validates the header exactly like a state read and adopts it as fresh reused state. The Worker still verifies every proof, so stale state still fails closed.
3. **Keep verified listings and keys for the tab — approved.** Verified Directory listings, opened Directory keys and root or Grant-root access stay in the tab's memory only. They are never persisted, and their size is bounded. Revisiting part of the library renders from memory at once and then revalidates in the background by listing revision. Invalidation: this tab's own mutations update or drop the affected entries. Other tabs hear id-only `BroadcastChannel` messages, never names or keys. Changes from other devices and Collaborators arrive through background revalidation on navigation and on focus. Everything is cleared on sign-out (in any tab), on Session or device change, on private-access errors, and once the tab has been hidden for 10 minutes. File content is still fetched each time a File opens.
4. **Placement — Smart Placement approved** for the preview and production Workers. It affects only fetch handlers, and the scheduled handler is unchanged. **D1 read replication is deferred**: it needs replication enabled on the production database (a remote configuration change), and a design for consistent authorization, because a lagging replica could still serve reads after a revocation or device removal. Moving the D1 primary would need a new database and is out of scope.
5. **Background request frequency — approved.** Session presence is read after hydration, when the tab regains focus or becomes visible, and after authentication changes, not on every navigation. Background shared and owned provisioning upkeep starts at most once a minute per tab. The explicit **Provision shared content** action stays immediate, and a pass that reports more work continues as it does today.
6. **Web Analytics injection — approved.** HTML responses carry `Cache-Control: no-store, no-transform`, so Cloudflare cannot inject its Web Analytics beacon. This also means Cloudflare no longer compresses HTML, a cost the maintainer accepted. Non-HTML responses keep `no-store`. Operator step: turn off Web Analytics automatic setup for `mdwn.me` in the Cloudflare dashboard.

## Acceptance criteria

- [ ] Sequential private operations within the reuse window send no extra `/api/device/state` request. A stale epoch or binding retries once and then succeeds or fails closed. Cancelled-navigation isolation from ticket 54 still holds.
- [ ] Proof-guarded responses carry a validated `X-Mdwn-Device-State`. Requests without a normal Session get none, and no route body changes.
- [ ] Revisiting a cached part of the library renders before any network response and then reflects changes made in another tab or on another device. Sign-out in another tab clears cached names and keys. No decrypted name or key is ever persisted or broadcast.
- [ ] Smart Placement is configured for preview and production, with verification and rollback steps documented.
- [ ] Navigation no longer re-reads Session presence on every location change. Background provisioning upkeep starts at most once a minute per tab.
- [ ] HTML responses carry `no-store, no-transform` and other responses keep `no-store`. The operator step is documented.
- [ ] Focused Node, Workers and browser tests cover the changed behavior. `npm run verify` passes.

## Comments

- 2026-10-12: The maintainer chose items 1, 2, 3, 5 and 6 and the Smart Placement part of item 4, and asked for this ticket to be delivered together with 53 (its first slices) and 58 in one pull request. D1 read replication is deferred for the reasons recorded under Decisions. Ticket 59 stays out of that pull request.
