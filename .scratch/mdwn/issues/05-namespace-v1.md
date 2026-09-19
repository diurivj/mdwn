# 05: `mdwn/namespace-v1` canonical names and collision naming

**What to build:** An immutable, vendored name canonicalization contract so two people's browsers agree byte-for-byte on which names collide, which are valid, and what a deterministic Keep-both name is — without any plaintext name or name-equality token ever reaching the Worker.

**Blocked by:** 02 (Cross-engine test harness).

**Status:** ready-for-agent

- [ ] `mdwn/namespace-v1` is vendored with Unicode **17.0.0** data; its versioned code and data run unchanged in Chromium, Firefox, WebKit, and the Worker test target, and a Unicode-data or package-version mismatch fails CI.
- [ ] A display segment is `NFC_17(input)`; its sibling comparison key is `NFC_17(default-full-case-fold_17(NFD_17(display)))`, including multi-code-point mappings and excluding optional Turkic (`T`) mappings. Locale-sensitive `toLowerCase`/`toLocaleLowerCase`, host ICU behaviour, and host `normalize()` are not the contract.
- [ ] NFC is deliberate, not NFKC: canonically equivalent spellings and case variants collide, while compatibility variants such as full-width `Ａ` and ASCII `A` remain distinct.
- [ ] The valid-segment profile rejects empty names; `.` and `..`; C0/C1 controls; `/`, `\`, `<`, `>`, `:`, `"`, `|`, `?`, `*`; a trailing ASCII space or `.`; Unicode `Bidi_Control` code points; malformed scalar strings such as unpaired UTF-16 surrogates; and case-insensitive Windows device stems (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, checked before the first ASCII `.` after stripping trailing ASCII spaces/dots).
- [ ] A valid segment is 1–255 UTF-8 bytes in NFC display form; nothing is trimmed, collapsed, transliterated, confusable-folded, or otherwise repaired; international letters, combining marks, ordinary whitespace, other punctuation, emoji, variation selectors, and joiners stay valid.
- [ ] Required CI fixtures pass in all three engines and the Worker test target: composed/decomposed `Amélie`, `Straße`/`STRASSE`, Greek sigma/final-sigma, default `I`/`i` versus distinct `İ`, and intentionally distinct full-width `Ａ` versus ASCII `A`; Unicode 17 normalization conformance vectors run in CI.
- [ ] Collision allocation is deterministic: candidates in one Directory are ordered by bytewise ascending NFC source-relative path then NFC requested display name; split at the last ASCII `.` only when it is neither first nor last; start at the smallest unused decimal `n` of 2 and propose `base (n)extension`; NFC-normalize and validate before testing the comparison key against decrypted existing siblings, direct source reservations, and earlier generated names. `draft.md` → `draft (2).md`, `archive.tar.gz` → `archive.tar (2).gz`, `.env` → `.env (2)`, `draft.` → `draft. (2)`.
- [ ] Every non-colliding requested sibling name is reserved before generated names are allocated, so an explicit source name such as `report (2).md` wins over a generated suffix for `report.md`.
- [ ] A generated name that fails the segment profile, including one over 255 bytes, is never truncated; the review requires Rename, Skip, or an authorized File Replace.
- [ ] Importers split a source path before validation, reject absolute, traversing, or empty components, validate each component independently, and never split a validated segment; Worker request handlers receive neither a display segment nor its comparison key.
