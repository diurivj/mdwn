import { describe, expect, it } from "vitest";

import {
  ALGORITHM_SUITE,
  AlgorithmDowngradeError,
  ContextMismatchError,
  EnvelopeAuthenticationError,
  MalformedEnvelopeError,
  ReplayDetectedError,
  StaleEpochError,
  canonicalAuthenticatedContext,
  createNonceAllocator,
  decodeEnvelope,
  encodeEnvelope,
  generateAes256Key,
  generateHpkeKeyPair,
  hkdfSha256,
  importHpkePrivateKey,
  InMemoryNonceCounterStore,
  InMemoryReplayGuard,
  openAesGcm,
  openHpke,
  sealAesGcm,
  sealHpke,
} from "../../app/crypto";
import {
  ENC_V1_VECTOR_CONTEXT,
  ENC_V1_VECTOR_KEY,
  ENC_V1_VECTOR_NONCE,
  ENC_V1_VECTOR_PLAINTEXT,
  ENC_V1_VECTOR_CIPHERTEXT_HEX,
  HPKE_VECTOR_EPHEMERAL_KEY_MATERIAL,
  HPKE_VECTOR_ENVELOPE_HEX,
  HPKE_VECTOR_PRIVATE_KEY,
  HPKE_VECTOR_PUBLIC_KEY,
} from "../support/enc-v1-vector";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0) throw new Error("odd hexadecimal input");
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

const NAMESPACE_A = Uint8Array.from([0, 1, 2, 3, 4, 5]);
const NAMESPACE_B = Uint8Array.from([0, 1, 2, 3, 4, 6]);

describe("mdwn/enc-v1 canonical context", () => {
  it("has a deterministic binary representation that includes suite and optional bindings", () => {
    const first = canonicalAuthenticatedContext({
      suite: ALGORITHM_SUITE.AES_256_GCM,
      context: ENC_V1_VECTOR_CONTEXT,
    });
    const second = canonicalAuthenticatedContext({
      suite: ALGORITHM_SUITE.AES_256_GCM,
      context: { ...ENC_V1_VECTOR_CONTEXT },
    });

    expect(hex(first)).toBe(hex(second));
    expect(hex(first)).toBe(
      "6d64776e2f656e632d76312f616164010103000c66696c652d636f6e74656e7400087661756c742d303100096f626a6563742d303100066b65792d3031000000000000000700096465766963652d3031000e7075626c69636174696f6e2d3031",
    );
  });
});

describe("AES-256-GCM envelopes", () => {
  it("seals the shared vector and opens it with the exact context", async () => {
    const envelope = await sealAesGcm({
      context: ENC_V1_VECTOR_CONTEXT,
      key: ENC_V1_VECTOR_KEY,
      plaintext: ENC_V1_VECTOR_PLAINTEXT,
      nonce: ENC_V1_VECTOR_NONCE,
    });
    const decoded = decodeEnvelope(envelope);

    expect(decoded.suite).toBe(ALGORITHM_SUITE.AES_256_GCM);
    expect(decoded.context).toEqual(ENC_V1_VECTOR_CONTEXT);
    expect(hex(decoded.nonce!)).toBe(hex(ENC_V1_VECTOR_NONCE));
    expect(hex(decoded.ciphertext)).toBe(ENC_V1_VECTOR_CIPHERTEXT_HEX);
    expect(hex(encodeEnvelope(decoded))).toBe(hex(envelope));

    await expect(
      openAesGcm({
        envelope,
        key: ENC_V1_VECTOR_KEY,
        expectedContext: ENC_V1_VECTOR_CONTEXT,
      }),
    ).resolves.toEqual(ENC_V1_VECTOR_PLAINTEXT);
  });

  it("requires an explicit nonce allocator for non-vector encryption", async () => {
    const key = await generateAes256Key();

    await expect(
      sealAesGcm({
        context: ENC_V1_VECTOR_CONTEXT,
        key,
        plaintext: ENC_V1_VECTOR_PLAINTEXT,
      }),
    ).rejects.toThrow("nonce allocator");
  });

  it("uses the allocator without reusing a nonce across concurrent callers", async () => {
    const store = new InMemoryNonceCounterStore();
    const allocatorA = createNonceAllocator({ namespace: NAMESPACE_A, store });
    const allocatorAInAnotherTab = createNonceAllocator({ namespace: NAMESPACE_A, store });
    const allocatorB = createNonceAllocator({ namespace: NAMESPACE_B, store });

    const allocated = await Promise.all([
      allocatorA.allocate("shared-key"),
      allocatorAInAnotherTab.allocate("shared-key"),
      allocatorA.allocate("shared-key"),
      allocatorAInAnotherTab.allocate("shared-key"),
    ]);
    const resumedAfterInterruptedWork = await allocatorA.allocate("shared-key");
    const otherDevice = await allocatorB.allocate("shared-key");

    expect(new Set(allocated.map(hex)).size).toBe(allocated.length);
    expect(hex(resumedAfterInterruptedWork)).toBe(hex(Uint8Array.from([...NAMESPACE_A, 0, 0, 0, 0, 0, 4])));
    expect(hex(otherDevice)).toBe(hex(Uint8Array.from([...NAMESPACE_B, 0, 0, 0, 0, 0, 0])));
    expect(new Set([...allocated, resumedAfterInterruptedWork, otherDevice].map(hex)).size).toBe(6);
  });

  it("rejects context changes, stale epochs, tampering, and replayed envelopes", async () => {
    const envelope = await sealAesGcm({
      context: ENC_V1_VECTOR_CONTEXT,
      key: ENC_V1_VECTOR_KEY,
      plaintext: ENC_V1_VECTOR_PLAINTEXT,
      nonce: ENC_V1_VECTOR_NONCE,
    });
    const replayGuard = new InMemoryReplayGuard();

    await expect(
      openAesGcm({
        envelope,
        key: ENC_V1_VECTOR_KEY,
        expectedContext: { ...ENC_V1_VECTOR_CONTEXT, objectId: "other-object" },
      }),
    ).rejects.toBeInstanceOf(ContextMismatchError);

    await expect(
      openAesGcm({
        envelope,
        key: ENC_V1_VECTOR_KEY,
        expectedContext: ENC_V1_VECTOR_CONTEXT,
        minimumEpoch: 8,
      }),
    ).rejects.toBeInstanceOf(StaleEpochError);

    const tampered = decodeEnvelope(envelope);
    tampered.ciphertext[0] ^= 0x80;
    await expect(
      openAesGcm({
        envelope: encodeEnvelope(tampered),
        key: ENC_V1_VECTOR_KEY,
        expectedContext: ENC_V1_VECTOR_CONTEXT,
      }),
    ).rejects.toBeInstanceOf(EnvelopeAuthenticationError);

    await expect(
      openAesGcm({
        envelope,
        key: ENC_V1_VECTOR_KEY,
        expectedContext: ENC_V1_VECTOR_CONTEXT,
        replayGuard,
      }),
    ).resolves.toEqual(ENC_V1_VECTOR_PLAINTEXT);
    await expect(
      openAesGcm({
        envelope,
        key: ENC_V1_VECTOR_KEY,
        expectedContext: ENC_V1_VECTOR_CONTEXT,
        replayGuard,
      }),
    ).rejects.toBeInstanceOf(ReplayDetectedError);
  });

  it("rejects non-canonical or malformed binary input", async () => {
    const envelope = await sealAesGcm({
      context: ENC_V1_VECTOR_CONTEXT,
      key: ENC_V1_VECTOR_KEY,
      plaintext: ENC_V1_VECTOR_PLAINTEXT,
      nonce: ENC_V1_VECTOR_NONCE,
    });

    expect(() => decodeEnvelope(Uint8Array.from([...envelope, 0]))).toThrow(
      MalformedEnvelopeError,
    );
    expect(() => decodeEnvelope(bytesFromHex("6d64776e2f656e632d763101ff00"))).toThrow(
      /suite|malformed/i,
    );
  });
});

describe("HPKE envelopes", () => {
  it("uses the pinned RFC 9180 suite and round-trips through raw public-key transport", async () => {
    const recipientPrivateKey = await importHpkePrivateKey(HPKE_VECTOR_PRIVATE_KEY);
    const envelope = await sealHpke({
      context: ENC_V1_VECTOR_CONTEXT,
      plaintext: ENC_V1_VECTOR_PLAINTEXT,
      recipientPublicKey: HPKE_VECTOR_PUBLIC_KEY,
      // Deterministic only for the test vector; production calls omit it.
      ephemeralKeyMaterial: HPKE_VECTOR_EPHEMERAL_KEY_MATERIAL,
    });
    const decoded = decodeEnvelope(envelope);

    expect(recipientPrivateKey.extractable).toBe(false);
    expect(hex(envelope)).toBe(HPKE_VECTOR_ENVELOPE_HEX);
    expect(decoded.suite).toBe(ALGORITHM_SUITE.HPKE_P256_HKDF_SHA256_AES_256_GCM);
    expect(decoded.enc).toHaveLength(65);
    expect(decoded.nonce).toBeUndefined();

    await expect(
      openHpke({
        envelope,
        recipientPrivateKey,
        recipientPublicKey: HPKE_VECTOR_PUBLIC_KEY,
        expectedContext: ENC_V1_VECTOR_CONTEXT,
      }),
    ).resolves.toEqual(ENC_V1_VECTOR_PLAINTEXT);

    await expect(
      openAesGcm({
        envelope,
        key: ENC_V1_VECTOR_KEY,
        expectedContext: ENC_V1_VECTOR_CONTEXT,
      }),
    ).rejects.toBeInstanceOf(AlgorithmDowngradeError);
  });

  it("fails closed when an encapsulated key or context is substituted", async () => {
    const recipient = await generateHpkeKeyPair();
    const envelope = await sealHpke({
      context: ENC_V1_VECTOR_CONTEXT,
      plaintext: ENC_V1_VECTOR_PLAINTEXT,
      recipientPublicKey: recipient.publicKey,
      ephemeralKeyMaterial: Uint8Array.from(
        Array.from({ length: 32 }, (_, index) => 0x40 + index),
      ),
    });
    const tampered = decodeEnvelope(envelope);
    tampered.enc![0] ^= 1;

    await expect(
      openHpke({
        envelope: encodeEnvelope(tampered),
        recipientPrivateKey: recipient,
        expectedContext: ENC_V1_VECTOR_CONTEXT,
      }),
    ).rejects.toThrow();

    await expect(
      openHpke({
        envelope,
        recipientPrivateKey: recipient,
        expectedContext: { ...ENC_V1_VECTOR_CONTEXT, publicationId: "other-publication" },
      }),
    ).rejects.toBeInstanceOf(ContextMismatchError);
  });
});

describe("domain-separated HKDF", () => {
  it("is deterministic for the same label/context and separates labels", async () => {
    const input = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const first = await hkdfSha256({
      inputKeyMaterial: input,
      label: "content-key",
      context: ENC_V1_VECTOR_CONTEXT,
    });
    const repeat = await hkdfSha256({
      inputKeyMaterial: input,
      label: "content-key",
      context: ENC_V1_VECTOR_CONTEXT,
    });
    const otherLabel = await hkdfSha256({
      inputKeyMaterial: input,
      label: "recovery-key",
      context: ENC_V1_VECTOR_CONTEXT,
    });

    expect(hex(first)).toBe(hex(repeat));
    expect(hex(first)).not.toBe(hex(otherLabel));
    expect(first).toHaveLength(32);
  });
});
