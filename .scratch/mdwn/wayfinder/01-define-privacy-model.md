# Define the privacy model

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by:

## Question

"Privacy is the core of this project." Pin down what that means *concretely*, because the answer forks the entire architecture. Candidate meanings, not mutually exclusive:

- (a) **No passwords**: passkeys/WebAuthn only, credentials never leave the device.
- (b) **No surveillance**: no analytics, no tracking, no ads, minimal logs; open signup without behavioural profiling.
- (c) **Encryption at rest**: server-side disk/DB encryption; the operator can still read content.
- (d) **End-to-end encryption**: the server cannot read file content.
- (e) **Data ownership**: full export and hard deletion on demand.
- (f) **Reader anonymity**: a public publish link reveals nothing about the reader.

The hard tension: (d) is incompatible with server-rendered public links for anonymous readers, with cheap full-text search, and with simple comments — unless content is decrypted client-side. Decide whether (d) holds. If it does, most other tickets inherit a client-heavy architecture; if it doesn't, say so plainly so nobody silently assumes it.

Record an ADR if the decision survives the three tests (hard to reverse, surprising without context, a real trade-off).

## Answer

**Resolution — End-to-end content privacy.** mdwn's private Markdown is encrypted and decrypted in the browser. The application service, its operators, and its managed database store opaque ciphertext and must not be able to read plaintext content. This is the core privacy boundary, not merely encryption at rest.

mdwn is passkeys-first with no passwords; it has no tracking, analytics, advertising, or behavioural profiling. It may keep narrowly scoped operational security and abuse logs only when they exclude content, decryption keys, and public-link fragments and have bounded retention. Browser-side export and hard deletion are required privacy guarantees. Public links are anonymous and non-indexed by default, require no account, and use no cookies except those strictly necessary to function; publishers may later opt in to indexing.

The resulting constraints are recorded in [ADR 0001: End-to-end content privacy](../../../docs/adr/0001-end-to-end-content-privacy.md) and the shared language in [CONTEXT.md](../../../CONTEXT.md). [Define encrypted-content and capability model](13-define-encrypted-content-capability-model.md) now decides the key lifecycle and metadata boundary that this choice requires.
