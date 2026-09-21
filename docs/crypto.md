# Content cryptography

`app/crypto` is the shared `mdwn/enc-v1` implementation used by browser and
Worker code. It deliberately exposes only Web Crypto primitives plus the
maintained [`@hpke/core` 1.9.0](https://github.com/dajiaji/hpke-js) RFC 9180
implementation. The direct dependency is exact-pinned in `package.json` and
`package-lock.json`.

## Suites and binary envelope

The suite identifiers are fixed in `app/crypto/envelope.ts`:

| ID | Suite |
| ---: | --- |
| `0x01` | AES-256-GCM with a 128-bit tag |
| `0x02` | HPKE base mode: DHKEM(P-256, HKDF-SHA-256), HKDF-SHA-256, AES-256-GCM |

Every encoded envelope is a canonical binary value. Its fields, in order, are:

1. the ASCII magic `mdwn/enc-v1`;
2. version, suite ID, and authenticated-context presence flags;
3. length-prefixed ASCII purpose, Vault ID, protected object ID, protected key
   ID, and an unsigned 64-bit key epoch;
4. optional length-prefixed recipient and Publication IDs, in that order;
5. a 96-bit AES-GCM nonce **or** a 65-byte uncompressed P-256 HPKE
   encapsulated public key; and
6. a 32-bit ciphertext length followed by ciphertext (including the 16-byte
   authentication tag).

The decoder rejects unknown versions/suites, unknown flags, invalid lengths,
non-ASCII identifiers, trailing bytes, non-canonical re-encodings, and
algorithm-specific fields in the wrong suite.

The authenticated context uses a separate fixed binary prefix,
`mdwn/enc-v1/aad`, followed by version, suite ID, presence flags, and the same
canonical context fields. AES-GCM authenticates this value as AAD. HPKE uses it
as AAD and uses `mdwn/enc-v1/hpke-info || SHA-256(aad)` as its bounded HPKE
`info` value. Thus a changed Vault/object/key ID, purpose, epoch, recipient,
Publication, version, or suite cannot be accepted with the old ciphertext.

Opening requires the caller to provide the expected context and suite. Callers
may additionally provide a minimum epoch and a replay guard. A stale epoch,
context substitution, suite downgrade, malformed value, failed tag, or replay
is rejected before plaintext is returned.

## Nonce allocation

AES-GCM production sealing requires a `NonceAllocator`; the library does not
silently fall back to random nonces. A nonce is:

```
96 bits = 48-bit device namespace || 48-bit per-key counter
```

The namespace is an opaque value allocated uniquely to an Encryption device by
the device-registry layer; this library never invents or reuses one. The
counter is stored per `(key ID, namespace)`. `IndexedDbNonceCounterStore`
reserves it in one read/write IndexedDB transaction, so tabs in one browser
profile serialize allocation. A reservation is committed before encryption:
a retry, crash, or interrupted job leaves a gap rather than reusing a nonce.
Different registered devices use different namespaces and therefore cannot
collide for a shared key. Counter exhaustion fails closed and requires key
rotation.

`InMemoryNonceCounterStore` is the deterministic test seam. The browser store
and the replay guard use the same versioned IndexedDB database but separate
object stores. `InMemoryReplayGuard` and `IndexedDbReplayGuard` atomically
consume an envelope digest once; callers that need a replay decision pass one
to `openAesGcm` or `openHpke`.

The explicit `nonce` argument exists only for fixed vectors/imported test
fixtures. Production code must pass a durable allocator.

## Key material

AES keys can be generated/imported as non-extractable Web Crypto keys. HPKE
public keys are serialized with the package's KEM serializer. Generated HPKE
private keys are immediately re-imported through the package's non-extractable
deserializer before being returned to application code; private keys remain
`CryptoKey` handles suitable for IndexedDB structured cloning.

`hkdfSha256` length-delimits a caller label and canonical context under the
`mdwn/hkdf-sha256/v1` domain. No application derivation uses an unlabelled
HKDF invocation.

The Node and Workers tests use the same fixed AES vector. The browser suite
runs the same Web Crypto vector through the cross-engine harness; future
browser-facing crypto flows should use these exported seal/open seams rather
than reimplementing framing or context authentication.
