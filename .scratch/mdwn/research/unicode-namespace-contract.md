# Canonical namespace normalization and import collision naming

Researched 2026-09-16 for Wayfinder ticket “Lock canonical namespace
normalization and import collision naming”. This is research only. It does not
change the map or tickets.

## Recommendation

Make each user-visible path component a **Unicode 17.0.0 NFC display segment**
and make its directory-local collision key a separately stored, opaque
**Unicode 17.0.0 `NFC(full-default-case-fold(NFD(segment)))`** value. Pin the
implementation and its UCD inputs in one shared TypeScript/WASM package used
by browser and Worker; do not define the database contract in terms of the
host's `normalize`, `toLowerCase`, or locale APIs. NFC preserves ordinary
international names and collapses canonical spelling variants; deliberately
do **not** use NFKC/NFKC_Casefold, which also collapses compatibility variants
(e.g. full-width forms) and removes default-ignorables.

The collision key is an equality/security token, not a display name. In an
end-to-end-encrypted design, derive and persist a keyed, fixed-length token
from it on the client (scoped to the parent directory); do not put plaintext
normalized names, paths, or failed-import diagnostics in Worker/D1 logs. The
unique index is on `(parent_id, collision_token)`. This leaves the server able
to enforce no duplicate entry while disclosing only equality/length/timing
metadata. If the Worker must independently recompute the key, it necessarily
receives the name or its key material; call that out as a product privacy
trade-off.

## Why this is a contract, not a native-API convenience

- UAX #15 defines NFC as canonical decomposition followed by composition; it
  gives canonically equivalent strings one result and makes normalization
  idempotent. Its stability guarantee applies across Unicode versions for
  strings containing only characters assigned in both versions; new/unassigned
  characters are the important exception. [UAX #15 §§1, 3,
  7](https://www.unicode.org/reports/tr15/tr15-58.html)
- Case folding is not lowercasing. The UCD's `CaseFolding.txt` defines full
  folding (C+F), permits length growth (`Fuß` and `FUSS` match), specifies
  Turkic T mappings as optional/non-default, and warns that folding does not
  preserve normalization. Thus fold then NFC (and use the non-Turkic default)
  is explicit and locale-free. [Unicode 17.0.0
  CaseFolding.txt](https://www.unicode.org/Public/17.0.0/ucd/CaseFolding.txt)
- ECMAScript exposes NFC/NFD/NFKC/NFKD through `String.prototype.normalize()`
  (NFC default), and specifies `toLowerCase()` separately. It does not expose
  Unicode full case folding or a selected Unicode-data version. `toLowerCase`
  therefore cannot implement this key (`ß` remains `ß`); `toLocaleLowerCase`
  is expressly locale-sensitive, so Turkish/Azeri `I` behavior must never
  participate in a global namespace. [ECMA-262 `normalize`](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.normalize)
  [ECMA-262 `toLowerCase`](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.tolowercase)
  [ECMA-262 `toLocaleLowerCase`](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.tolocalelowercase)
- Workers aims at standards-compliant, web-interoperable APIs and has a
  configurable compatibility date, but that is not a promise that its V8/ICU
  Unicode tables match every browser release. A native-only key can therefore
  drift at the Unicode-version boundary. [Workers runtime
  APIs](https://developers.cloudflare.com/workers/runtime-apis/)

**Implementation shape.** Vendor the Unicode 17.0.0 source-data snapshot and
generator (including `CaseFolding.txt` and the normalization data), commit the
generated tables/WASM and a data-version constant, and publish exactly one
`canonicalizeSegment()` package. Full case folding needs string mappings, not
one-code-point JS lowercasing. ICU's `Normalizer2` API documents explicit NFC
normalization; ICU4X/WASM with pinned data is a viable compact alternative if
its exact Unicode data release and byte artifact are locked. [Unicode 17.0.0
UCD](https://www.unicode.org/Public/17.0.0/ucd/)
[ICU `Normalizer2` source](https://github.com/unicode-org/icu/blob/main/icu4c/source/common/unicode/normalizer2.h)
[Normalization conformance corpus](https://www.unicode.org/Public/17.0.0/ucd/NormalizationTest.txt)

Do not silently change this contract when dependencies/runtime upgrade. A
future Unicode bump is a namespace migration: retain the old version for old
entries, dual-check/reindex under a migration lock, and report newly created
collisions for resolution. New code points should be rejected until a planned
version bump, rather than accidentally becoming differently comparable.

## Segment acceptance profile

This is a filesystem-like *name*, not a programming-language identifier: do
not use an ASCII or `XID_Start` allow-list, which would unnecessarily reject
spaces, combining marks, CJK, Arabic, Indic, and other real names. UAX #31
also says a profile must state its normalization and folding precisely, and
notes invisible/confusable/bidirectional spoofing risks. [UAX #31 §5](https://www.unicode.org/reports/tr31/tr31-45.html)
[UTS #39](https://www.unicode.org/reports/tr39/tr39-34.html)

After NFC, reject deterministically:

1. empty segments; `.` and `..` exactly;
2. U+0000; `/` and `\\` (path separators); and a documented cap in UTF-8 bytes
   and scalar values (not JS UTF-16 length);
3. surrogate code points, noncharacters, code points unassigned in Unicode
   17.0.0, C0/C1 controls, line/paragraph separators, and bidirectional
   controls; and
4. default-ignorable format characters unless a future, explicitly tested
   language exception is added.

Keep ordinary whitespace, punctuation, letters, numbers, emoji code points
that do not require a rejected format/variation control, and combining marks. Apply the same profile to an import's every supplied component *before*
joining: no separator splitting after acceptance, no absolute paths, no drive
prefixes, and no trimming/collapsing whitespace. This prevents traversal and
invisible-name surprises without treating Latin spelling as the default. UTS
#39 confusable checks are appropriate for a warning/review UI, not for silently
merging unrelated names.

## “Keep both” is an allocation rule

On collision with requested leaf `s`, preserve `s` as the source base. Split
only at the **last `.` that is neither first nor last**; prefix receives
`base`, suffix receives that dot through end. Candidate `n` is
`base + " (" + decimal(n) + ")" + suffix`, for the smallest positive `n` whose
collision token is unused in that parent. The decimal digits are ASCII, no
leading zero, and start at 1. Validate and canonicalize every candidate; if a
cap is exceeded, return an explicit conflict rather than truncating into a
new collision.

| Requested leaf | First candidate |
| --- | --- |
| `draft.md` | `draft (1).md` |
| `archive.tar.gz` | `archive.tar (1).gz` |
| `.env` | `.env (1)` |
| `draft.` | `draft. (1)` |
| `a..b` | `a. (1).b` |

This avoids platform-dependent `extname` behavior and keeps hidden files and
trailing dots unambiguous. Do not strip an existing ` (n)`—`draft (1).md`
colliding becomes `draft (1) (1).md`. For several equal imported source names,
allocate in the manifest's immutable entry-ID byte order after sorting each
collision group by its normalized requested display UTF-8 bytes; record the
chosen display name/token in the encrypted manifest. This makes import output
reproducible rather than dependent on browser directory enumeration.

## Concurrent imports and tests

A client preflight is advisory. Commit the parent revision expected by the
manifest and insert all entries with the unique collision-token constraint in
one transaction. If the conditional revision update affects zero rows or the
unique insert fails, return `409 namespace changed`; refetch, recompute the
smallest suffix from the authoritative namespace, and retry with a bounded
idempotency key. Never reuse a stale proposed suffix. D1 documents `batch()`
as sequential, transactional execution that rolls back the sequence on a
failure, making it suitable for this bounded compare/allocate/insert commit.
[D1 `batch`](https://developers.cloudflare.com/d1/worker-api/d1-database/)

The shared package test suite should run unchanged in Chromium, Firefox,
WebKit, and `workerd`/Miniflare, and assert both display NFC and key bytes for
at least:

- `Amélie` and `Ame\u0301lie` collide; `Straße` and `STRASSE` collide.
- `Σ`, `σ`, and final `ς` collide; `I` and `i` collide, but `İ` folds to `i` +
  U+0307 and does **not** collide with `i` under default folding.
- `Ａ` and `A` remain distinct (NFC policy); record this as the intentional
  NFKC trade-off. Reject U+202E, U+0000, slash/backslash, dot segments, an
  unpaired surrogate, and a format-control case.
- all four extension examples above; an already occupied `(1)` selects `(2)`;
  a collision that arises only after folding selects the next suffix.
- two same-revision commits: exactly one wins; the loser gets 409, retries from
  the committed list, and deterministically chooses the next available suffix;
  replaying the winning idempotency key creates no extra entry.

Run the pinned UCD `NormalizationTest.txt` corpus in CI and retain these
contract vectors forever. Test native APIs only as a non-authoritative
compatibility check; native agreement today is not the namespace definition.

## Sources (primary)

- Unicode UAX #15, Unicode Normalization Forms — https://www.unicode.org/reports/tr15/tr15-58.html
- Unicode UAX #31, Unicode Identifiers and Syntax — https://www.unicode.org/reports/tr31/tr31-45.html
- Unicode 17.0.0 UCD, `CaseFolding.txt` and `NormalizationTest.txt` — https://www.unicode.org/Public/17.0.0/ucd/
- Unicode UTS #39, Unicode Security Mechanisms — https://www.unicode.org/reports/tr39/tr39-34.html
- ECMA-262 text-processing algorithms — https://tc39.es/ecma262/multipage/text-processing.html
- Cloudflare Workers runtime APIs — https://developers.cloudflare.com/workers/runtime-apis/
- Cloudflare D1 Database binding (`batch`) — https://developers.cloudflare.com/d1/worker-api/d1-database/
- ICU `Normalizer2` API source — https://github.com/unicode-org/icu/blob/main/icu4c/source/common/unicode/normalizer2.h
