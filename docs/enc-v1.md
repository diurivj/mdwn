# `mdwn/enc-v1` envelope contract

Ticket [03](../.scratch/mdwn/issues/03-enc-v1-envelope-library.md) selects this
binary representation and `@hpke/core` **1.9.0** (hpke-js, with its transitive
version pinned in `package-lock.json`). This is an application envelope around
WebCrypto and RFC 9180, not a new ECDH protocol. It does not replace the
independent security review required by ADR-0003.

## Public interface and trust

Import from `app/crypto/enc-v1`:

- `createSymmetricWriter(baseKey, { maxMessages?, maxAuthenticatedBytes? })`
  returns an ephemeral writer with `seal(plaintext, context)`. The base key must
  be **32 random secret bytes**, never a password. Use this for content and
  symmetric Key envelopes alike.
- `createSymmetricWriter` accepts an optional `infoLabel` only for a new,
  explicitly domain-separated key family. The writer still owns a fresh random
  256-bit salt and all nonce state; callers cannot restore or supply a salt.
  `openSymmetricWithLabel` opens a capsule or other explicitly labelled family
  with the matching label. The default remains
  `mdwn/enc-v1/aes-256-gcm`.
- `openSymmetric(envelope, baseKey, expected)` opens only the symmetric suite.
- `sealToRecipient(plaintext, recipientPublicKey, context)` and
  `openForRecipient(envelope, recipientKeyPair, expected)` use only the pinned
  HPKE suite. Supply an independently approved recipient public key. Transport
  keys are WebCrypto ECDH P-256 handles; a private key must permit `deriveBits`.
  Pass **both** handles to open: the private handle may be non-extractable.
- `inspectEnvelope(envelope)` validates framing and returns **unauthenticated**
  metadata. It is suitable for Worker structural validation, never authorization
  or establishing the expected context. The parser is also available from the
  dependency-free `app/crypto/enc-v1/format` module.
- `digestEnvelope(envelope)` returns SHA-256 of the entire canonical envelope,
  after structural validation. It is a byte-exact ciphertext identity, not a
  plaintext hash or an authenticity claim.

Every open requires an **external expected context**: purpose, Vault ID, object
ID, protected key ID, exact current key epoch and representation revision, plus
recipient and Publication IDs where applicable. An older envelope epoch fails as
`stale-epoch`; a newer-than-current epoch fails as `unexpected-epoch`, so a
caller cannot mistake an impossible future epoch for ordinary staleness and
"fix" it by re-keying. There is no “decrypt using the
header's own context” convenience. The chosen open method pins the suite: no
algorithm negotiation, downgrade, or fallback. IDs are opaque, case-sensitive
values, not file names or paths. The library does not infer authorization from
an ID, key epoch, or successful decryption.

`archive-manifest`, `import-staging-manifest`, and self-addressed Directory
listing envelopes (`directory-metadata` with `objectId === keyId`) additionally require
`expected.manifestDigest`, the exact current 32-byte digest from a trusted head.
Individual child-entry `directory-metadata` envelopes have distinct object/key IDs
and do not act as listing heads.
Old revisions and same-revision different ciphertext both fail. Reading the
same **current** head repeatedly is permitted; this is rollback detection, not
single-use consumption. Persisting/advancing the head and distributing it to
other devices belongs to the caller's authenticated manifest/registry protocol.
Never initialize it from the envelope or from unauthenticated server claims.
**Currently implemented v1 Directory listing (ticket 14):** the Directory
protocol persists the head in the same proof-guarded D1 transaction as the
parent revision and entry mutations. The browser signs the head's ciphertext
digest with its non-extractable Device assertion key, binding Account,
Directory, Device, and revision under `mdwn/directory-listing/v1`. The
encrypted head commits to every child ID, kind, and **complete encrypted entry
bytes**, including encrypted name/order and each File entry's `keyEnvelope`
for its current File content key. On read the browser verifies the signature against
the approved Device registry public key supplied by the authenticated private
resource, then passes that verified digest as `expected.manifestDigest` and
compares the opened member commitment with the returned entries. Initial empty
revision 1 has no head. Browser-local revision/digest checkpoints reject old
and same-revision forks across subsequent reads; D1 refuses same-revision head
rewrites. The registry-key source is still the service's approved-device
registry, not an offline independent trust root. A fresh device with no trusted
checkpoint cannot detect a server replaying its entire history or a malicious
service forging both a registry key and its head; a stateless envelope library
cannot solve that problem. Content
key epochs and Device registry epochs are distinct; callers bind the applicable
current content authority, not merely a number supplied beside ciphertext.

### Approved listing v2 and File receiving keys — not implemented by ticket 03/14

[ADR-0008](adr/0008-file-scoped-receiving-keys-and-signed-file-heads.md) amends the
*listing protocol*, not `mdwn/enc-v1` binary framing. A `directory-metadata`
self-addressed listing still needs the externally authenticated exact current
`manifestDigest`; a v2 signed encrypted structural head uses a distinct
`mdwn/directory-listing/v2` signing/context domain and commits membership, kind,
complete encrypted names/order, and stable parent-wrapped File receiving-key
material. Its explicitly tagged unmigrated v1 File entries remain byte-complete
in the commitment, including `keyEnvelope`. There is no v1 decoder fallback,
removed v1 commitment field, or implicit change to an existing v1 ciphertext.

A v2 File has one independent P-256 HPKE receiving key pair per File/capability
epoch. A symmetric `file-receiving-key` envelope (appended purpose 20 below)
under its containing Directory capability carries the private key; its
`keyEpoch` names the receiving-key epoch and its envelope revision is the
creation/rewrap revision authenticated by the structural entry, **not** the
revision of each later File save. The public key, opaque File-scoped receiving
key identity/epoch, and authenticated write target are available to authorized
File editors; no Directory-wide receiving target or parent capability is given
to direct File editors. Each successful save generates a fresh random File
content key: `file-content-key` now has a v2 **HPKE** envelope to the File
receiving public key (`recipientId` binds the receiving-key identity, `keyEpoch`
binds the new content-key epoch, `revision` binds the new File revision). Each
currently eligible direct-Grant device gets a separate constrained device
`grant` envelope for that same current File key, bound to the protected File/key
and device recipient. The signed current File head binds both receiving-key
identity/**epoch** and content-key identity/**epoch**, the public-key digest,
representation and every relevant envelope digest, and the exact recipient-set
version/commitment. An inherited Directory reader opens the private-key wrapper
and the changing HPKE envelope, verifying the private key matches the signed
public target; a direct File reader opens only its authorized device envelope. `inspectEnvelope` cannot authenticate a target, recipient set,
head or plaintext equality; the Worker can validate the signed bytes and exact
current descriptors but **cannot prove** opaque envelopes carry equal keys.

The File head has its own Device signature domain and File revision/digest
checkpoint, separate from the Directory structural checkpoint. A same-File-
revision head update requires a guarded monotonic receiving-key epoch advance
(rotation) or recipient-set version advance (including Grant/device changes);
a different digest at the same File revision, receiving-key epoch and
recipient-set version is a fork. Directory readers verify both signed heads
and committed bytes; direct File readers see only File-scoped head/material.
The service checks the signer's **effective authority at commit** for that
transition (write authority on save); retain approved signing-key provenance
so later revocation does not invalidate an otherwise authentic historical
committed head. The previously documented
fresh-device/service-registry trust limit still applies. First removing
Directory-scope authority and blocking writes, then replacing an exposed
receiving **pair** through a bounded resumable rotation, is required before
future writes. Account-owned recovery traverses the owned hierarchy (or uses
strictly owned auxiliary recovery for unreachable keys), never a recipient's
Vault-root/recovery/enrollment envelope for Grant-derived material.

Only a write-authorized parent-capability browser can atomically migrate an existing
v1 File before direct-write sharing. It verifies the v1 complete-entry
commitment and structural/File revisions, installs the private wrapper and
public target, current-key HPKE/device envelopes, a new structural listing and
File head, and establishes a one-time version-transition checkpoint. It may
keep the current representation/key/File revision during this guarded
transition; later v2 saves advance revision with a new random key, and
same-revision heads without a guarded recipient-set or receiving-key epoch
advance fail. Unmigrated v1 remains readable. Purpose
20 and these v2 rules are **approved pending work**, not assertions that the
current parser, Directory routes or save flow already implement them.

Inputs used across an asynchronous operation are snapshotted. The module does
not persist, log, send, or SSR keys/plaintext. It provides no export of derived
writer keys or their nonce state. `EnvelopeError.code` provides bounded failure
categories without content or crypto-library exceptions in open failures.

## Nonce allocation: new key domains, not distributed random IVs

For symmetric encryption:

1. Each writer obtains a fresh 256-bit CSPRNG **salt** (public namespace).
2. Derive its AES-256 key from the 32-byte base key using HKDF-SHA-256, that salt,
   and UTF-8 `mdwn/enc-v1/aes-256-gcm` as `info`. The base key never directly
   encrypts a message.
3. Allocate a 96-bit big-endian counter nonce starting at zero. Allocation is
   synchronous, before the first encryption await; an exception or abandoned
   operation burns the counter. A writer never wraps: its hard budget is
   `2^32` messages, and it also refuses to exceed `2^30` cumulative
   authenticated bytes (AAD and plaintext each padded to an AES block, plus the
   16-byte tag), which bounds GCM's aggregate forgery risk. `maxMessages` and
   `maxAuthenticatedBytes` may lower, never raise, those budgets; exhaustion
   fails closed as `nonce-exhausted`.
4. A new writer (another tab, device, retry after restart, or interrupted/offline
   work resumed later) always generates a new salt and therefore a new AES key
   domain. It does **not** restore the old salt/counter. Within one writer, even
   concurrent calls use distinct counter values. No server, IndexedDB counter,
   cross-tab lock, or online reservation service is needed.

The default HKDF `info` label remains `mdwn/enc-v1/aes-256-gcm` for the content-key
domain. [Ticket 04](../.scratch/mdwn/issues/04-key-hierarchy-phrase-capsule.md)
adds the Recovery capsule domain through `infoLabel`. Its canonical `info` is
UTF-8 `mdwn/vault-recovery-capsule/v1`, followed by the Account ID's u16 byte
length, its UTF-8 bytes, and the recovery generation as u64 (all integers big-endian).
`app/crypto/vault.ts` supplies the 32-byte Vault recovery secret as the HKDF input
and records the writer's fresh public salt. It does not feed an already-derived
capsule key into the default content-key domain or restore a writer's salt.

Recovery capsule opens and reissues require an external expected Account ID and
current generation; callers may also supply the trusted current recovery salt.
Successful decryption does not establish the current generation or authorize
enrollment. Persisting current recovery state and atomically superseding it belong
to the signup and recovery ceremonies. Only `RecoveryMaterial.record` is suitable
for service persistence; the surrounding material contains browser-local secrets.

The guarantee is deterministic nonce uniqueness **within each derived key
 domain**, conditional on the standard CSPRNG/HKDF key-separation assumptions.
It does not claim mathematically impossible random key collisions: for `w`
writers, the salt-collision bound is approximately `w*(w-1)/2^257`, before HKDF
key-collision considerations. This is 256-bit key-domain separation, **not**
assuming 96-bit random nonces will not collide. A cloned/rolled-back live JS/VM
snapshot, broken RNG, compromised browser, or manually restoring internal key
state is outside this contract. Ordinary browser restarts/storage eviction need
no persisted allocation state and cannot rewind an old writer's counter.

A retry can resend the **same envelope bytes** without invoking encryption. If
it re-encrypts, it consumes a new nonce (or uses a new writer domain), producing
different bytes. Import's exact sequence/digest retry rule must reuse the saved
bytes, not encrypt again and call it the same retry.

HPKE uses fresh RFC 9180 **base-mode** sender contexts, exactly one message per
context, with KEM `0x0010` (DHKEM P-256/HKDF-SHA-256), KDF `0x0001`
(HKDF-SHA-256), and AEAD `0x0002` (AES-256-GCM). The library owns its ephemeral
key and nonce schedule. No context, custom ECDH construction, optional PSK,
caller-provided ephemeral key, or alternate suite is exposed. Base mode does not
identify the sender; any sender can encrypt to a public key. Sender authority
comes from the authenticated device/Grant/Publication protocols, not HPKE alone.

## Canonical binary representation (v1)

All integers are **unsigned big-endian**; no varints, JSON, base64, optional field
maps, padding, or trailing bytes. Whole envelopes are bounded to 512 KiB;
callers must enforce narrower object/import limits (e.g. 16 KiB Key envelopes).
Epochs and revisions are u64 on the wire but restricted to non-negative JS safe
integers (`0` through `2^53-1`).

| Order | Field | Encoding |
| --- | --- | --- |
| 1 | Version | 12 bytes, UTF-8 `mdwn/enc-v1` followed by NUL |
| 2 | Suite | u8: `1` symmetric; `2` HPKE |
| 3 | Purpose | u8 from the table below |
| 4 | Key epoch | u64 |
| 5 | Representation/manifest revision | u64 |
| 6–8 | Vault ID, object ID, protected key ID | each: u16 byte length + UTF-8 |
| 9–10 | Recipient ID, Publication ID | same; zero length means absent |
| 11a | Symmetric parameters | 32-byte HKDF salt, then 12-byte GCM nonce |
| 11b | HPKE parameters | 65-byte SEC1 uncompressed P-256 encapsulated public key (`04 || X || Y`) |
| 12 | Ciphertext length | u32, includes 16-byte authentication tag |
| 13 | Ciphertext | exact bytes, authentication tag last |

Required IDs contain 1–256 UTF-8 bytes. Present optional IDs obey the same rule;
empty strings are invalid. UTF-8 decoding is fatal on malformed input, encoding
rejects lone UTF-16 surrogates, and a BOM is preserved as data. No Unicode
normalization is applied to opaque IDs. Unknown fields in a caller's context
are rejected rather than silently left unauthenticated.

The entire header (everything preceding the ciphertext, **including** salt,
nonce or encapsulated key, and ciphertext length) is AEAD additional authenticated
data. HPKE `info` is the header prefix through the context (fields 1–10), providing
application/suite/context domain separation within RFC 9180. The tag is always
128 bits. A change to framing, suite semantics, or this field order needs a new
version, not a permissive v1 decoder.

| Purpose ID | Purpose |
| --- | --- |
| 1 | `directory-capability` |
| 2 | `file-content-key` |
| 3 | `file-content` |
| 4 | `directory-metadata` |
| 5 | `grant` |
| 6 | `device-enrollment` |
| 7 | `vault-recovery` |
| 8 | `recovery-capsule` |
| 9 | `public-representation` |
| 10 | `private-comment-thread` |
| 11 | `public-comment-audience-epoch` |
| 12 | `comment-content` |
| 13 | `attribution` |
| 14 | `archive-manifest` |
| 15 | `import-staging-manifest` |
| 16 | `import-chunk` |
| 17 | `account-profile` |
| 18 | `owned-device` |
| 19 | `device-label` |
| 20 | `file-receiving-key` (v2 receiving private-key wrapper) |
| 21 | `share-root-label` (immutable per-Grant Shared-as snapshot; HPKE device delivery or symmetric Owner copy) |

Names follow the `CONTEXT.md` glossary (`Directory capability`, `File content
 key`, `File receiving key pair`, `Comment audience epoch`); only the numeric ID
is serialized. Every HPKE envelope, `grant`, and `device-enrollment` requires a
recipient ID. Purposes 20 and 21 are appended; older purpose IDs and framing do not change. Purpose 21 carries a versioned canonical `namespace-v1` snapshot segment under an explicit Owner/target/random-label-ID/epoch-1/revision-1 context, with a recipient device ID for HPKE. It is metadata, **not** a 32-byte content capability. Owner recovery keeps a symmetric copy under the Owner's own Vault root; recipient Vault recovery/enrollment never receives it.
`public-representation` and `public-comment-audience-epoch` require a Publication ID.
Callers must supply the optional bindings for all other cases where applicable;
for example a public Comment's content must bind its Publication, whereas a
Private Comment has none. Purpose IDs must never be renumbered.

## Account profile (purpose 17)

Ticket 06 stores the current Account profile as an encrypted `account-profile`
envelope. Its compact canonical plaintext contains the generated Public
pseudonym; the service persists only the opaque ciphertext, Account-profile
revision, and Vault-root epoch. No Account-profile key or plaintext reaches a
Worker route, D1, logs, or a test-only production endpoint.

`app/crypto/account-profile` binds its envelope context to caller-supplied,
trusted current metadata: `vaultId` is the opaque Account ID, `objectId` is
`account-profile`, `keyId` is `vault-root`, and `keyEpoch` and `revision` are
the expected externally stored current epoch and profile revision. Opening
requires that same expected context; it never treats an envelope header's
Account, epoch, or revision as authority. The helper uses the ordinary
symmetric writer with the Account-owned 32-byte Vault-root key, so the profile
inherits the envelope's random salt and nonce allocation contract.

`owned-device` (purpose 18) wraps Account-owned recovery-envelope capabilities
for an active device during bounded provisioning. `device-label` (purpose 19)
protects an optional device label under the Vault root key; its context binds
the Account and exact device ID. Neither purpose carries a Grant capability.

## Consumers and open decisions

Future tickets that build envelopes must use this module rather than a new format.
Their purpose names are pinned here:

| Ticket | Purposes |
| --- | --- |
| 04 Vault key hierarchy and Recovery capsule | `vault-recovery`, `recovery-capsule`, `device-enrollment` |
| 06 Accounts, Passkeys, and Sessions | `account-profile` |
| 08 Signup bootstrap | `device-enrollment`, `vault-recovery` |
| 11 Vault recovery | `owned-device` |
| 12 Routine device enrollment | `device-enrollment`, `owned-device`, `device-label` |
| 14 Private tree (implemented v1) | `directory-capability`, `file-content-key`, `directory-metadata` |
| 17–19 direct-write amendment (approved, pending) | `file-receiving-key`; v2 HPKE `file-content-key`, device `grant`, v2 structural/File heads |
| 18 Grant envelopes | `grant`, `private-comment-thread`, `public-comment-audience-epoch` |
| 19 Key rotation, 20 Provisioning fulfillment | any affected purpose |
| 21 Private comment threads | `private-comment-thread`, `comment-content`, `attribution` |
| 22 Publish a File | `public-representation` |
| 23 Public comment threads, 25 Link rotation and unpublish | `public-comment-audience-epoch` (see below) |
| 24 Public pseudonym update | `attribution` |
| 29, 30 Import | `archive-manifest`, `import-staging-manifest`, `import-chunk` |

Two decisions stay open, and later tickets own them:

1. **Public audience epoch needs two purposes.** Ticket 23 needs a symmetric
   wrapper for the Publication capability and an HPKE envelope for each device,
   so one `public-comment-audience-epoch` purpose is not enough. Split it and keep
   the two distinguishable in the authenticated context.
2. **Purpose-to-suite enforcement.** The module does not stop a producer sealing
   any purpose with either suite. Tickets 18, 21, 22, and 23 should add a
   protocol-version/purpose-to-suite policy: `file-content-key` is symmetric
   for v1 parent entries but HPKE for v2 File receiving targets. Do not assume
   every numeric purpose has exactly one suite across listing versions.

## Sources

- [RFC 9180](https://www.rfc-editor.org/rfc/rfc9180) — HPKE construction, suites,
  base-mode security limits, and test vectors.
- [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869) — HKDF extract/expand and `info`.
- [NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final) — GCM, IV uniqueness.
- [hpke-js](https://github.com/dajiaji/hpke-js) — maintained implementation;
  [selection notes](../.scratch/mdwn/research/enc-v1-hpke.md).
