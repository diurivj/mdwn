# Share-handle addressing v1

An Account has an opaque share identifier and may have a unique share handle. Neither is its Public pseudonym or an authentication identity. Resolution is exact-match only; there is no Account directory or fuzzy lookup (see [spec §5.1](buildable-spec.md#51-account-identity), [spec §6.3](buildable-spec.md#63-shares-and-grants), and [data model](../.scratch/mdwn/wayfinder/09-data-model-and-schema.md)).

## `sh1:` lookup-token contract

`deriveShareHandleLookupToken(handleWithoutAt)` accepts a **string of 1–64 ASCII characters**, each in `[A-Za-z0-9_-]`. No `@` belongs in this input. It rejects whitespace (including leading/trailing whitespace), non-ASCII text, lone surrogates, and every character outside the grammar; it does not trim, apply NFC/NFKC, transliterate, or use locale-sensitive folding. Unlike a filename, `CON` is a valid handle. Canonicalization changes only ASCII `A`–`Z` to `a`–`z`; hyphen and underscore are different.

The bytes hashed are **UTF-8** of the literal `mdwn/share-handle-lookup/v1\0` (a real `0x00` NUL separator after `v1`), immediately followed by the canonical ASCII handle, with no other separator or terminator. SHA-256 over those bytes produces 32 bytes. The token is the literal `sh1:` followed by canonical **unpadded base64url** of the digest (`+` → `-`, `/` → `_`, no `=`): exactly **47 ASCII characters**. The implementation uses native public WebCrypto; this deterministic digest has no secret, salt, or per-Account state.

Frozen examples (independently computed with Node's `node:crypto`, not the application helper):

| Input (without `@`) | Lookup token |
| --- | --- |
| `a` | `sh1:dEJNvN34AzDnzPFa8DdfgRsEoj8mFHIetJVLuu-U7Mw` |
| `ALICE`, `Alice`, `alice` | `sh1:sYgK0eW6DfzVCUcNDlphPgu7BCqXpp9jXpWA5cu2zC0` |
| `a-b` | `sh1:fxXfqzjRu7wThiP75ReTfPtGMQuY2hZZviCMSTyXVZY` |
| `a_b` | `sh1:ZEUH5rT9z6heDKfeZ786EQ5qJmDlg_v8QGT3zFHGzKI` |
| `CON` | `sh1:NV784cOyCN9St1rvVGuK0th4YmANXLTKmidv78FgRH0` |
| 64 lowercase `z` characters | `sh1:_9I0AxruYnhlm2XPoLfCuyhISo4YSId2VHHaZBm4FFg` |

## Privacy and compatibility boundary

The optional `accounts.share_handle_lookup_token` stores this token, **never a plaintext handle**. A later handle-assignment operation must write precisely the same token as the invitation lookup. Its existing `UNIQUE` index arbitrates canonical duplicates: a collision means unavailable, never overwrite another Account. Do not assume old or absent tokens can be reconstructed or migrated from service data; no plaintext fallback is allowed. The `sh1:` version prefix describes this encoding but **does not guarantee cross-version uniqueness**. Any future normalization change requires an explicit migration/uniqueness plan. Domain separation avoids accidental reuse of a digest in another protocol; it is **not confidentiality**: low-entropy public handles are cheaply guessable offline from their deterministic tokens.

The Worker already compares an exact supplied value against the handle-token column (or the unchanged opaque share-ID column). A subsequent invitation adapter must remove **exactly one** leading `@` and pass the remainder to this helper before sending a `kind: "handle"` lookup. It must leave opaque share IDs unchanged. The current `app/sharing/client.ts` does *not* yet perform this derivation; this file and helper do not change that behavior. Handle assignment/profile format is deferred; ticket 24 concerns Public-pseudonym updates, not handle assignment.

The Node, workerd, and three-engine browser tests here exercise only the independently bundled **public helper contract**, with identical literal vectors. They do **not** exercise token-only HTTP resolution, assigned-slot/`UNIQUE`-index behavior, or opaque-ID UI workflows: those need subsequent browser/Worker integration after the invitation and assignment adapters exist. No production test endpoint is installed.
