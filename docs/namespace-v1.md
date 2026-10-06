# `mdwn/namespace-v1`

`app/shared/namespace-v1` is the only implementation of private File and Directory
name canonicalization. It is browser-private: callers decrypt a name, run
`canonicalizeSegment`, and retain the returned display spelling and comparison
bytes locally. The Worker has no endpoint that accepts either value and must
never receive a plaintext name or deterministic equality token.

The package vendors the Unicode 17.0.0 UCD snapshot under
[`vendor/unicode/17.0.0/ucd`](../vendor/unicode/17.0.0/ucd). The generator reads
only that snapshot and emits the normalization, full/default case-folding, and
`Bidi_Control` tables in `app/shared/namespace-v1/generated.ts`. Runtime code does not
call host `String.prototype.normalize`, `toLowerCase`, or locale-sensitive
case APIs. `NAMESPACE_IMPLEMENTATION_VERSION`, `UNICODE_VERSION`, the source
file list, and the aggregate UCD SHA-256 are exported from
`app/shared/namespace-v1/data-version.ts`.

Run `npm run check:namespace` after changing the vendored data or generator. It
regenerates the expected output in memory and fails when either generated file
drifts. The Node test suite also runs this check and executes the complete
Unicode `NormalizationTest.txt` NFC/NFD corpus. The same public package vectors
run unchanged in Node, workerd, Chromium, Firefox, and WebKit.

`canonicalizeSegment(input)` returns `display` as NFC_17 and `comparisonKey`
as UTF-8 bytes of NFC_17(default-full-case-fold_17(NFD_17(display))). The
validation profile permits international text, ordinary whitespace, combining
marks, punctuation, emoji, variation selectors, joiners, and unassigned
scalars. It rejects malformed scalars, empty/dot segments, C0/C1 controls,
listed path and Windows-invalid characters, trailing ASCII spaces/dots,
`Bidi_Control`, and Windows device stems.

`allocateKeepBothNames` operates on one decrypted Directory namespace. It
reserves direct source names first, then orders generated candidates by NFC
source-relative path and NFC requested display bytes. It starts at `(2)`, splits
only at the last non-leading/non-trailing ASCII dot, validates every candidate,
and reports an explicit generated-name conflict when the profile or byte cap
would be exceeded.
