import { describe, expect, it } from "vitest";

import {
  decodeEnvelope,
  openAesGcm,
  sealAesGcm,
} from "../../app/crypto";
import {
  ENC_V1_VECTOR_CONTEXT,
  ENC_V1_VECTOR_KEY,
  ENC_V1_VECTOR_NONCE,
  ENC_V1_VECTOR_PLAINTEXT,
  ENC_V1_VECTOR_CIPHERTEXT_HEX,
} from "../support/enc-v1-vector";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("mdwn/enc-v1 in the Workers runtime", () => {
  it("matches the browser/Node AES-GCM vector", async () => {
    const envelope = await sealAesGcm({
      context: ENC_V1_VECTOR_CONTEXT,
      key: ENC_V1_VECTOR_KEY,
      plaintext: ENC_V1_VECTOR_PLAINTEXT,
      nonce: ENC_V1_VECTOR_NONCE,
    });

    expect(hex(decodeEnvelope(envelope).ciphertext)).toBe(
      ENC_V1_VECTOR_CIPHERTEXT_HEX,
    );
    await expect(
      openAesGcm({
        envelope,
        key: ENC_V1_VECTOR_KEY,
        expectedContext: ENC_V1_VECTOR_CONTEXT,
      }),
    ).resolves.toEqual(ENC_V1_VECTOR_PLAINTEXT);
  });
});
