import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  CROSS_ENGINE_ROUTE,
  CROSS_ENGINE_VECTOR,
  toHex,
} from "../support/cross-engine-vector";

const encoder = new TextEncoder();

async function encryptCrossEngineVector(): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(CROSS_ENGINE_VECTOR.key),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );

  return crypto.subtle.encrypt(
    { name: "AES-GCM", iv: new Uint8Array(CROSS_ENGINE_VECTOR.iv) },
    key,
    encoder.encode(CROSS_ENGINE_VECTOR.plaintext),
  );
}

describe("Worker cross-engine contract", () => {
  it("serves the application route from the Workers test target", async () => {
    const response = await SELF.fetch("https://mdwn.test/");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(`<title>${CROSS_ENGINE_ROUTE.title}</title>`);
    expect(body).toContain(CROSS_ENGINE_ROUTE.heading);
  });

  it("performs the shared WebCrypto AES-GCM vector", async () => {
    expect(toHex(await encryptCrossEngineVector())).toBe(
      CROSS_ENGINE_VECTOR.ciphertext,
    );
  });
});
