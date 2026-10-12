# 57: Private request latency: decisions before the next speed-ups

**What to build:** Nothing yet. Record what makes private pages slow after [56](56-pre-launch-polish.md) and the options that need the maintainer's decision, because each one changes a protocol rule, data freshness, the privacy story or Cloudflare configuration.

**Type:** decision

**Status:** needs-triage

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

## Comments
