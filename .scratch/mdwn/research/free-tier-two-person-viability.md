# Cloudflare Free viability for a two-person mdwn vault

## Scope

This note assesses ordinary use by one Account owner and one Collaborator on the
settled Workers Free + D1 Free stack. It does not establish a maximum atomic
import size; that remains a separate schema-specific proof obligation.

## Finding

**Free is likely adequate for normal two-person use**, assuming browser-side
Markdown encryption, parsing, and archive preparation; small documents; indexed
D1 queries; and low public-reader traffic. This is a workload judgement rather
than a provider guarantee.

## Current documented limits

- Workers Free permits 100,000 dynamic requests per day, 10 ms CPU time per
  HTTP invocation, and 128 MB isolate memory. Large server-side parsing,
  encryption, or buffered archive handling is therefore unsuitable.
  [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
  and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- D1 Free permits 5 million rows read per day, 100,000 rows written per day,
  5 GB account storage, 10 databases per account, 500 MB per database, and 50
  D1 queries per Worker invocation. Exceeding a daily read/write limit makes
  later queries fail until the UTC reset.
  [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and
  [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- D1 bills/limits reads by rows scanned rather than rows returned. Indexed
  per-File reads are therefore important; indexes reduce scans but add write
  work. A D1 row/BLOB is limited to 2 MB, SQL statements to 100 KB, bound
  parameters to 100, and a query/batch to 30 seconds.
  [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and
  [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

## Operational interpretation

Hundreds to low thousands of daily requests for two people are far below the
Workers request quota, and ordinary indexed browse/edit/share/comment traffic
should be far below D1's daily row budgets. Public reads and abusive Comment
attempts are the material exception because they are externally driven; cache
public reads, enforce the settled abuse limits, surface quota failures, and
inspect Cloudflare operational metrics plus D1 `rows_read`/`rows_written`.

D1's single-threaded database is unlikely to constrain two ordinary users.
Browser-side cryptography and import preparation are required by Workers Free's
tight CPU/memory envelope.

## Separate atomic-import constraint

A useful no-visible-partial import cannot be inferred from normal-use capacity.
`D1Database.batch()` is atomic, but Workers Free permits only 50 D1 queries per
invocation. The actual import schema must prove its multi-row statement plan,
payloads, and retry behavior fit that limit at the chosen product cap. If it
does not, private bounded staging plus one atomic committed-import visibility
marker preserves the product's all-or-nothing user experience without requiring
a Paid plan.
