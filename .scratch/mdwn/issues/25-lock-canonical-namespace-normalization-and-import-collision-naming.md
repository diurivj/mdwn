# Lock canonical namespace normalization and import collision naming

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by: 14, 18

## Question

[Lock editor and file interaction behavior](14-lock-editor-and-file-interaction.md) and [Lock import operational bounds](18-lock-import-operational-bounds.md) require a case-insensitive normalized File/Directory namespace, browser preflight of duplicate paths, and deterministic **Keep both** collision handling. The assembled spec cannot leave the canonical algorithm to each browser: differing Unicode normalization or case handling could make the same encrypted namespace collide differently on different devices.

Lock the interoperable namespace contract:

- the exact locale-independent Unicode normalization and case-folding algorithm/version or pinned shared implementation used by browser and Worker for every private name and imported path segment;
- validation of unsafe, empty, or otherwise non-canonical path segments without exposing plaintext names to the service;
- the exact deterministic **Keep both** naming algorithm, including suffix placement, starting/incrementing number, extension behavior, and normalized-namespace availability test; and
- client/Worker/cross-browser test vectors and conflict behavior when a concurrent change takes an otherwise available name.

Do not reopen encrypted names, the private browser-side namespace check, the 100-node import envelope, or the settled choice that Directories never silently merge.

## Answer

**Resolution — pinned, browser-private canonical namespace.** Supporting facts and primary-source citations are in [Canonical namespace normalization and import collision naming](../research/unicode-namespace-contract.md). This preserves the settled encrypted-name and browser-side namespace boundary: the service never receives a private name or a deterministic name-equality token.

### Canonical form and privacy boundary

- Every File and Directory display segment is `NFC_17(input)`, using Unicode **17.0.0**. A sibling comparison key is `NFC_17(default-full-case-fold_17(NFD_17(display)))`. `default-full-case-fold` uses the Unicode 17.0.0 full/default CaseFolding mappings, including multi-code-point mappings and excluding the optional Turkic (`T`) mappings. It is locale-independent: `toLowerCase`, `toLocaleLowerCase`, host ICU data, and host `normalize()` behavior are never the contract.
- This intentionally uses NFC rather than NFKC/NFKC_Casefold. Canonically equivalent spellings and case variants collide; compatibility variants such as full-width `Ａ` and ASCII `A` remain distinct.
- A vendored, versioned `mdwn/namespace-v1` implementation and its Unicode 17.0.0 data are the sole source of this calculation. Browser code runs it before displaying/encrypting any private name or import segment. The same package must run unchanged in the Worker test target, but Worker request handlers receive neither a display segment nor its comparison key; they do not recompute or persist either.
- No D1 table, request, error, or log stores plaintext names or a deterministic equality token. The existing browser-side duplicate check plus conditional Directory revision remains the enforcement boundary. A Unicode-data upgrade is a separate namespace-migration decision, never an incidental dependency or runtime upgrade.

### Segment and path profile

- A segment is a valid Unicode scalar-value string whose NFC display form is **1–255 UTF-8 bytes**. NFC is canonicalization, not trimming: the browser displays the resulting NFC form in import review, while every other rejected input is rejected rather than silently repaired.
- Reject an empty display form; `.` or `..`; C0/C1 controls; `/`, `\\`, `<`, `>`, `:`, `"`, `|`, `?`, or `*`; an ASCII space or `.` at the end; and any Unicode `Bidi_Control` code point (including U+061C, U+200E–U+200F, U+202A–U+202E, and U+2066–U+2069). Reject malformed scalar strings, including unpaired UTF-16 surrogates.
- Reject Windows device stems case-insensitively: `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, and `LPT1`–`LPT9`. The check uses the text before the first ASCII `.`, after stripping ASCII spaces and dots from that stem’s end, so `CON.txt` is also invalid.
- Ordinary international letters, combining marks, ordinary whitespace, punctuation not listed above, and emoji remain valid. In particular, variation selectors and joiners are not rejected merely for being format-related. The app does not trim, collapse, transliterate, or confusable-fold a name.
- Importers split an archive path into source components before validation, reject absolute/traversing/empty path components, validate every component independently, and never split a segment after it has passed validation. An invalid item names only the local selection and reason; nothing uploads.

### Deterministic **Keep both** allocation

- The browser first rejects two source paths whose component comparison keys are equal. **Keep both** never repairs a duplicate source path. It then reserves every non-colliding requested sibling name before allocating generated names, so an explicit source `report (2).md` keeps that name even when a colliding source `report.md` needs a suffix.
- For a colliding requested display name, split at the last ASCII `.` only when it is neither first nor last. The suffix includes that dot; otherwise the whole name is the base. For the smallest unused decimal integer `n` beginning at **2**, propose `base + " (" + n + ")" + extension`, NFC-normalize and validate it, and test its comparison key against decrypted existing siblings, direct source reservations, and earlier generated names in the same planned Directory.
- Collision candidates for one target Directory are allocated in bytewise ascending order of their NFC source-relative path, then NFC requested display name, so drag-and-drop or archive enumeration order cannot change the result. A generated name that exceeds the segment profile is not truncated: the review requires Rename, Skip, or an allowed File Replace instead.
- Therefore `draft.md` becomes `draft (2).md`, `archive.tar.gz` becomes `archive.tar (2).gz`, `.env` becomes `.env (2)`, and `draft.` becomes `draft. (2)`. An existing literal suffix has no special meaning: a colliding `draft (2).md` becomes `draft (2) (2).md`. Directories receive a different name or are skipped; they never silently merge. Existing File-only Replace authority is unchanged.

### Concurrent changes and clear user feedback

- Every create, rename, move, delete, and final Import commit conditionally advances the target Directory’s `entries_revision`. If another structural change won first, the service makes no mutation and returns a nameless `409 namespace_changed`; it never picks a suffix or overwrites an entry.
- Before an Import uploads, a duplicate or destination collision is explained in the browser as a name conflict—not a generic failure. The review identifies the local source and authorized sibling, explains that Files treats case and canonically equivalent Unicode spelling as the same name, previews any **Keep both** result, and offers the already-authorized Keep both, Skip, or File Replace choices.
- On `namespace_changed`, the browser says **“This folder changed on another device. Nothing was added, replaced, or overwritten.”** It refreshes and decrypts the current Directory, revalidates the plan, and highlights changed collisions. An Import returns to review and requires confirmation again; a create, rename, or move preserves the requested name and offers refresh/retry, rename, or cancel. No suffix is chosen silently.
- These detailed names and explanations exist only in an authorized browser. The Worker’s response and operational logs remain nameless.

### Required vectors and compatibility tests

- The immutable fixture suite asserts display and comparison-key bytes in Chromium, Firefox, WebKit, and the Worker runtime using the identical `mdwn/namespace-v1` package. It includes composed/decomposed `Amélie`, `Straße`/`STRASSE`, Greek sigma/final-sigma, default `I`/`i` versus distinct `İ`, and intentionally distinct full-width `Ａ` versus ASCII `A`.
- It rejects each segment/profile boundary above, including path traversal, slash/backslash, bidi controls, a device stem, an unpaired surrogate, and a one-byte-over-limit name. Unicode 17.0.0 normalization conformance vectors run in CI.
- It covers every extension example above, literal suffix handling, folded collisions, source-duplicate rejection, direct-name reservation before generated names, and a generated name that would exceed the limit.
- A same-revision two-client test proves exactly one structural mutation commits; the loser receives `409 namespace_changed`, makes no visible partial Import, refreshes, shows the changed conflict, and can only proceed after the user reviews it again. A package/UCD version mismatch fails CI rather than changing the namespace contract.
