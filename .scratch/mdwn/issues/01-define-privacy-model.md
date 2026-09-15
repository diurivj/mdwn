# Define the privacy model

Type: grilling
Status: open
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
