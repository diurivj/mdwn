import { describe, expect, it, vi } from "vitest";

import {
  createSymmetricWriter,
  digestEnvelope,
  inspectEnvelope,
  openSymmetric,
  openForRecipient,
  sealToRecipient,
  type EnvelopeContext,
} from "../app/crypto/enc-v1";

const key = Uint8Array.from({ length: 32 }, (_, i) => i);
const plaintext = new TextEncoder().encode("Private Markdown");
const context: EnvelopeContext = {
  purpose: "file-content",
  vaultId: "vault-1",
  objectId: "file-1",
  keyId: "key-1",
  keyEpoch: 2,
  revision: 3,
};

describe("mdwn/enc-v1 HPKE envelopes", () => {
  it("requires explicit recipient/Publication bindings and the pinned transport key algorithm", async () => {
    const recipient = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    await expect(sealToRecipient(key, recipient.publicKey, context)).rejects.toMatchObject({ code: "malformed" });
    await expect(sealToRecipient(key, recipient.publicKey, { ...context, purpose: "public-representation", recipientId: "link-1" }))
      .rejects.toMatchObject({ code: "malformed" });
    const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    await expect(sealToRecipient(key, signing.publicKey, { ...context, recipientId: "device-1" }))
      .rejects.toMatchObject({ code: "malformed" });
  });

  it("transports a Grant key to a device with a non-extractable P-256 private key", async () => {
    const recipient = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const grantContext: EnvelopeContext = { ...context, purpose: "grant", recipientId: "device-1" };
    const envelope = await sealToRecipient(key, recipient.publicKey, grantContext);
    expect(recipient.privateKey.extractable).toBe(false);
    expect(inspectEnvelope(envelope)).toMatchObject({
      suite: "HPKE-P256/HKDF-SHA-256/AES-256-GCM", context: grantContext,
    });
    expect(inspectEnvelope(envelope).enc?.length).toBe(65);
    expect(await openForRecipient(envelope, recipient, { context: grantContext })).toEqual(key);
    await expect(openSymmetric(envelope, key, { context: grantContext })).rejects.toMatchObject({ code: "unsupported-suite" });
  });
});

describe("mdwn/enc-v1 symmetric envelopes", () => {
  it("rejects context values that cannot be represented canonically", async () => {
    const writer = await createSymmetricWriter(key);
    for (const invalid of [
      { ...context, vaultId: "" },
      { ...context, objectId: "\ud800" },
      { ...context, keyId: "x".repeat(257) },
      { ...context, recipientId: "" },
      { ...context, keyEpoch: -1 },
      { ...context, keyEpoch: Number.MAX_SAFE_INTEGER + 1 },
      { ...context, revision: 1.5 },
      { ...context, revision: NaN },
      { ...context, unprotectedExtra: "must-not-be-silently-ignored" },
    ]) {
      await expect(writer.seal(plaintext, invalid)).rejects.toMatchObject({ code: "malformed" });
    }
  });

  it("burns a bounded sequence of nonces under concurrency and fails closed at exhaustion", async () => {
    const writer = await createSymmetricWriter(key, { maxMessages: 2 });
    const envelopes = await Promise.all([
      writer.seal(plaintext, context), writer.seal(plaintext, context),
    ]);
    const headers = envelopes.map(inspectEnvelope);
    expect(headers[0].salt).toEqual(headers[1].salt);
    expect(headers.map((item) => Array.from(item.nonce!))).toEqual([
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    ]);
    await expect(writer.seal(plaintext, context)).rejects.toMatchObject({ code: "nonce-exhausted" });
  });

  it("bounds aggregate authenticated data as well as message count per derived key", async () => {
    // This literal follows the pinned framing: ceil(106/16)*16 + ceil(16/16)*16 + 16.
    const writer = await createSymmetricWriter(key, { maxAuthenticatedBytes: 144 });
    await writer.seal(plaintext, context);
    await expect(writer.seal(plaintext, context)).rejects.toMatchObject({ code: "nonce-exhausted" });
    await expect(createSymmetricWriter(key, { maxAuthenticatedBytes: 2 ** 30 + 1 }))
      .rejects.toMatchObject({ code: "malformed" });
  });

  it("rejects old and same-revision substituted manifests against a trusted head", async () => {
    const writer = await createSymmetricWriter(key);
    const head: EnvelopeContext = { ...context, purpose: "archive-manifest" };
    const current = await writer.seal(plaintext, head);
    const old = await writer.seal(plaintext, { ...head, revision: head.revision - 1 });
    const fork = await writer.seal(new TextEncoder().encode("other manifest"), head);
    const expected = { context: head, manifestDigest: await digestEnvelope(current) };

    expect(await openSymmetric(current, key, expected)).toEqual(plaintext);
    // Reading the current head twice is not a replay attack or one-use consumption.
    expect(await openSymmetric(current, key, expected)).toEqual(plaintext);
    for (const replay of [old, fork]) {
      await expect(openSymmetric(replay, key, expected)).rejects.toMatchObject({ code: "replayed-manifest" });
    }
    await expect(openSymmetric(current, key, { context: head })).rejects.toMatchObject({ code: "replayed-manifest" });
  });

  it("fails closed on malformed framing, unknown versions/suites, and tampering", async () => {
    const writer = await createSymmetricWriter(key);
    const envelope = await writer.seal(plaintext, context);
    const changed = (offset: number, byte: number) => {
      const copy = envelope.slice();
      copy[offset] = byte;
      return copy;
    };
    for (const [input, code] of [
      [envelope.slice(0, 8), "malformed"],
      [envelope.slice(0, -1), "malformed"],
      [new Uint8Array([...envelope, 0]), "malformed"],
      [changed(10, 50), "unsupported-version"],
      [changed(12, 255), "unsupported-suite"],
      [changed(13, 0), "malformed"],
      [changed(14, 255), "malformed"],
      [changed(30, 255), "malformed"],
      [changed(32, 192), "malformed"],
      [changed(envelope.length - 1, envelope[envelope.length - 1] ^ 1), "authentication-failed"],
    ] as const) {
      await expect(openSymmetric(input, key, { context })).rejects.toMatchObject({ code });
    }
    // Even when the caller expects the tampered revision, the header is authenticated.
    await expect(openSymmetric(changed(29, 4), key, { context: { ...context, revision: 4 } }))
      .rejects.toMatchObject({ code: "authentication-failed" });
    await expect(writer.seal(new Uint8Array(512 * 1024), context)).rejects.toMatchObject({ code: "malformed" });
  });

  it("binds every context field and refuses stale key epochs", async () => {
    const protectedContext = { ...context, recipientId: "device-1", publicationId: "publication-1" };
    const writer = await createSymmetricWriter(key);
    const envelope = await writer.seal(plaintext, protectedContext);
    for (const field of ["vaultId", "objectId", "keyId", "recipientId", "publicationId"] as const) {
      await expect(openSymmetric(envelope, key, { context: { ...protectedContext, [field]: "substituted" } }))
        .rejects.toMatchObject({ code: "context-mismatch" });
    }
    // A stale (older) envelope is distinguishable from an impossible future epoch.
    await expect(openSymmetric(envelope, key, { context: { ...protectedContext, keyEpoch: 3 } }))
      .rejects.toMatchObject({ code: "stale-epoch" });
    await expect(openSymmetric(envelope, key, { context: { ...protectedContext, keyEpoch: 1 } }))
      .rejects.toMatchObject({ code: "unexpected-epoch" });
    await expect(openSymmetric(envelope, key, { context: { ...protectedContext, purpose: "file-content-key" } }))
      .rejects.toMatchObject({ code: "context-mismatch" });
    await expect(openSymmetric(envelope, new Uint8Array(32), { context: protectedContext }))
      .rejects.toMatchObject({ code: "authentication-failed" });
  });

  it("never resumes a writer key domain and burns a nonce when encryption fails", async () => {
    const writer = await createSymmetricWriter(key);
    const failure = vi.spyOn(crypto.subtle, "encrypt").mockRejectedValueOnce(new Error("interrupted"));
    try {
      await expect(writer.seal(plaintext, context)).rejects.toThrow();
    } finally {
      failure.mockRestore();
    }
    const afterFailure = await writer.seal(plaintext, context);
    const restarted = await (await createSymmetricWriter(key)).seal(plaintext, context);
    expect(inspectEnvelope(afterFailure).nonce).toEqual(Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1));
    expect(inspectEnvelope(restarted).nonce).toEqual(new Uint8Array(12));
    expect(inspectEnvelope(restarted).salt).not.toEqual(inspectEnvelope(afterFailure).salt);
    expect(await openSymmetric(afterFailure, key, { context })).toEqual(plaintext);
  });

  it("pins canonical bytes independently of JS property order and snapshots mutable inputs", async () => {
    const writer = await createSymmetricWriter(key);
    const message = plaintext.slice();
    const actualContext = { ...context };
    const pending = writer.seal(message, actualContext);
    message.fill(0);
    actualContext.objectId = "mutated-during-encryption";
    const envelope = await pending;
    const input = envelope.slice();
    const openKey = key.slice();
    const expectedContext = { revision: 3, keyEpoch: 2, keyId: "key-1", objectId: "file-1", vaultId: "vault-1", purpose: context.purpose };
    const opening = openSymmetric(input, openKey, { context: expectedContext });
    input.fill(0);
    openKey.fill(0);
    expectedContext.objectId = "mutated-during-decryption";
    expect(await opening).toEqual(plaintext);
  });

  it("seals a File representation with its protected context and opens it", async () => {
    const writer = await createSymmetricWriter(key);
    const envelope = await writer.seal(plaintext, context);

    expect(inspectEnvelope(envelope)).toMatchObject({
      version: "mdwn/enc-v1",
      suite: "AES-256-GCM/HKDF-SHA-256",
      context,
    });
    expect(await openSymmetric(envelope, key, { context })).toEqual(plaintext);
  });
});
