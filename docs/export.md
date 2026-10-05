# Owned Files export

Ticket 28 adds a browser-only **Owned Files export**: the Owner decrypts
everything they own and receives one ZIP they can hold themselves. The archive
is Markdown-first, mirrors the Directory hierarchy, and carries historical
Private Comment display data for a later Import. It transfers no live
authority and never leaves the browser as plaintext.

## Ownership boundary

- **Export my Files** includes every File the current Account owns. A selected
  owned File or Directory can also be exported from the Files chrome.
- Content reached through a Share is never included, even as a static copy.
  Export is offered only while the current access is the actor's own Vault
  (`access.vaultId === access.actorAccountId`); a Grant-root page shows no
  Export command, and the collector refuses a non-owned scope before it reads
  anything (`ExportError code "not_owned"`).
- Publication state, Public Comments, Shares, Grants, capabilities, keys,
  credentials and recovery material, sessions, internal service IDs, and local
  drafts are neither read nor serialized. Export calls only the existing
  proof-guarded tree and Private Comment reads; every response is ciphertext,
  every read is bodyless, and there is no export-specific endpoint or write.
- Export is available to the Owner regardless of Public-participation state.
  A suspension restricts Public Comment and Publication mutations only.
- The UI states that the download is a copy held by this browser and cannot
  remove or recall copies already downloaded elsewhere.

## Archive layout

The archive is a standard ZIP (`mdwn/zip`, STORE or raw DEFLATE, UTF-8 member
names, CRC-32 verified on read; ZIP64, encryption, data descriptors, and
multi-disk archives are rejected). Metadata is written first, then content
paths in bytewise-ascending order, so the same tree always produces the same
archive bytes.

```
.mdwn/manifest.json
.mdwn/private-comments.json     # only when a File has Comments
notes/                          # explicit Directory entries preserve empty folders
notes/draft.md
README.md
```

- A Directory keeps its exact display name; Directories never merge or rename.
- A File name already ending in `.md` or `.markdown` keeps its name; otherwise
  `.md` is appended. Explicit names are reserved before generated ones, so a
  Vault containing `a`, `a.md`, and `a (2).md` exports them as `a.md`,
  `a (2).md`, and `a (3).md`. Every generated name uses the locked
  `mdwn/namespace-v1` Keep-both suffix; a mapping that would exceed the 255-byte
  segment profile falls back to the exact name rather than truncating.
- File bytes are the exact UTF-8 Markdown source. YAML front matter is part of
  the source and is never interpreted or rewritten. A legacy source above the
  256 KiB source limit still exports; it simply cannot pass the Import archive
  preflight.
- A top-level Directory named `.mdwn` conflicts with the metadata directory
  and fails the export with a visible name error (`ExportError code
  "reserved_name"`).

### Manifest

```json
{
  "format": "mdwn-export",
  "version": 1,
  "createdAt": "2026-10-04T12:00:00.000Z",
  "roots": [{ "kind": "directory", "path": "" }]
}
```

`roots` identifies the archive's logical top level: `path: ""` means the
archive top level is the exported Directory (the whole Vault), a Directory
path means that Directory is a child of the archive root, and a File path means
one File was exported. The manifest carries no account, capability,
collaboration, or recovery authority.

### Private-Comment sidecar

```json
{
  "format": "mdwn-private-comments",
  "version": 1,
  "files": [
    { "path": "notes/draft.md", "comments": [
      { "sequence": 1, "text": "First comment", "pseudonym": "Member Quiet Pine",
        "createdAt": 1759000000000, "updatedAt": 1759000000000 }
    ]}
  ]
}
```

The sidecar preserves each owned File's Private Comment plain text, thread
order (`sequence`), timestamps, and the displayed Public pseudonym. The
collector pages the Private thread to its end (the workspace inspector stops
after ten pages; export does not). A File whose Comment history could not be
read completely on this device contributes **no** sidecar entry — a partial set
is never presented as the File's thread — and is counted in the UI result
instead of failing the download.

## Import preflight interaction (ticket 29)

`app/archive/format.ts` exposes `inspectArchive`, the archive-level half of the
Import preflight: exact metadata set, safe normalized `mdwn/namespace-v1`
paths, duplicate detection (including folded case and equivalent Unicode),
resolvable manifest roots, sidecar references to real Files, and the settled
node/depth/source/expanded/Historical-Comment bounds. `checkArchiveCompressedSize`
applies the 8 MiB recognized-archive bound at the ZIP byte boundary before a
read, exactly as ticket 29 will. Collision choices, Import targets, and the
encrypted staging plan remain the Import flow's work.
`tests/export-collect.test.ts` feeds a produced archive through
`readZip` and `inspectArchive` to prove export output is Import-ready;
`tests/archive.test.ts` pins the exact-boundary and one-over rejections.

A defensive 256-Directory walk ceiling (well above the service's own
100-Directory ancestry bound) turns a malformed or cyclic listing into a
visible error instead of a runaway walk; a real Vault cannot reach it.

## UI and failure behavior

The Files chrome shows **Export** for the Owner: **Export my Files** always,
plus **Export this File** or **Export this folder** when a non-root object is
selected. Progress reports the number of Files collected; the operation can be
cancelled; a completed export reports File, folder, and Comment counts, and
names any File whose Comment history was unreadable. A failure states that no
content left the browser so the person can retry.

## Verification seams

`tests/archive.test.ts` covers ZIP round-trips, UTF-8 names, deflate, CRC and
truncation failure, the manifest and sidecar schemas and bounds, and archive
preflight acceptance/rejection for each normalized-path and size bound.
`tests/export-collect.test.ts` covers hierarchy mirroring, exact source and
front matter, extension/collision allocation, the ownership refusal, the
reserved metadata Directory, incomplete Comment reporting, aborts, and the
export-to-preflight round trip. `e2e/export-owned-files.spec.ts` exercises the
real browser across Chromium, Firefox, and WebKit: exact source and Comment
history in a downloaded ZIP, zero request bodies during export, nested
hierarchy and selected File/folder exports, export under a live
Public-participation suspension, and a Collaborator who is never offered
shared-content export and whose own export excludes it.
