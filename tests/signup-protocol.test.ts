import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import {
  bindingMessage,
  decodeBytes,
  encodeBytes,
  solveProofOfWork,
  transcriptDigest,
  verifyProofOfWork,
  type SignupTranscript,
} from "../app/shared/signup/protocol";

const b64 = (length: number, fill: number) => encodeBytes(new Uint8Array(length).fill(fill));
const key = (fill: number) => encodeBytes(Uint8Array.of(4, ...new Uint8Array(64).fill(fill)));
const transcript: SignupTranscript = {
  accountId: "account-1",
  rootDirectoryId: "root-1",
  deviceId: "device-1",
  transportPublicKey: key(1),
  assertionPublicKey: key(2),
  capsuleGeneration: 1,
  capsuleDigest: b64(32, 3),
  recoverySalt: b64(32, 4),
  recoveryVerificationPublicKey: key(5),
  rootRecoveryEnvelopeDigest: b64(32, 6),
  enrollmentEnvelopeDigest: b64(32, 7),
  profileDigest: b64(32, 8),
  recoveryCodeHashes: Array.from({ length: 10 }, (_, i) => b64(32, i + 10)),
  registrationChallenge: b64(32, 9),
  proofNonce: b64(8, 10),
  registryEpoch: 1,
};

describe("signup wire protocol", () => {
  it("rejects padded, noncanonical, invalid and oversized base64url", () => {
    expect(decodeBytes("AA")).toEqual(new Uint8Array([0]));
    for (const bad of ["AA=", "AB", "A", "AA+", "AA/", "AA\n", "A".repeat(90_000)]) {
      expect(() => decodeBytes(bad)).toThrow();
    }
    expect(() => decodeBytes("AAAA", 1)).toThrow();
    expect(decodeBytes("AAA", 2)).toEqual(new Uint8Array(2));
    expect(() => encodeBytes(new Uint8Array(65_537))).toThrow();
  });

  it("binds every field and every recovery code hash independent of object insertion order", async () => {
    const baseline = await transcriptDigest(transcript);
    const binding = await bindingMessage(transcript);
    expect(new TextDecoder().decode(binding.subarray(0, -32))).toBe("mdwn/signup-device-binding/v1\0");
    expect(encodeBytes(binding.subarray(-32))).toBe(baseline);
    expect(
      await transcriptDigest(Object.fromEntries(Object.entries(transcript).reverse()) as unknown as SignupTranscript),
    ).toBe(baseline);
    for (let i = 0; i < 10; i++) {
      const hashes = [...transcript.recoveryCodeHashes];
      hashes[i] = b64(32, 99);
      expect(await transcriptDigest({ ...transcript, recoveryCodeHashes: hashes }), `hash ${i}`).not.toBe(baseline);
    }
    for (const name of Object.keys(transcript) as (keyof SignupTranscript)[]) {
      const changed = {
        ...transcript,
        [name]:
          name === "capsuleGeneration" || name === "registryEpoch"
            ? 2
            : name === "recoveryCodeHashes"
              ? [...transcript.recoveryCodeHashes.slice(0, 9), b64(32, 99)]
              : name.endsWith("Id")
                ? "different-id"
                : name.endsWith("PublicKey")
                  ? key(99)
                  : name === "proofNonce"
                    ? b64(8, 99)
                    : b64(32, 99),
      } as SignupTranscript;
      if (name === "capsuleGeneration" || name === "registryEpoch") {
        await expect(transcriptDigest(changed)).rejects.toThrow();
        await expect(bindingMessage(changed)).rejects.toThrow();
      } else {
        expect(await transcriptDigest(changed), name).not.toBe(baseline);
        expect(await bindingMessage(changed), name).not.toEqual(binding);
      }
    }
  });

  it("rejects missing, extra, malformed and oversized transcript values", async () => {
    for (const changed of [
      { ...transcript, accountId: "\ud800" },
      { ...transcript, accountId: "x".repeat(257) },
      { ...transcript, transportPublicKey: b64(65, 1) },
      { ...transcript, recoverySalt: b64(31, 1) },
      { ...transcript, capsuleDigest: "AB" },
      { ...transcript, recoveryCodeHashes: transcript.recoveryCodeHashes.slice(1) },
      { ...transcript, unexpected: "ignored?" },
      { ...transcript, accountId: undefined, unexpected: "replacement" },
    ])
      await expect(transcriptDigest(changed as SignupTranscript)).rejects.toThrow();
  });

  it("verifies a fixed, independently calculated SHA-256 challenge/nonce vector", async () => {
    // node:crypto SHA-256(32 zero bytes || uint64be(136353)) =
    // 00002da3932342c055ce3faf694cd9acaa66e24c9b58cfc6c353ad6364735857
    const challenge = b64(32, 0);
    expect(await verifyProofOfWork(challenge, "AAAAAAACFKE")).toBe(true);
    expect(await verifyProofOfWork(challenge, "AAAAAAACFKI")).toBe(false);
    await expect(verifyProofOfWork(challenge, "AAAAAAACFKE=")).rejects.toThrow();
    await expect(verifyProofOfWork("AA", "AAAAAAACFKE")).rejects.toThrow();
  });

  it("solves from a random starting nonce and respects cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(solveProofOfWork(b64(32, 0), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    const random = startingAt(new Uint8Array(8));
    try {
      expect(await solveProofOfWork(b64(32, 0))).toBe("AAAAAAACFKE");
    } finally {
      random.mockRestore();
    }
  }, 30_000);

  it("finds the first qualifying nonce across the nonce's word boundary and the 64-bit wrap", async () => {
    // Independently found by scanning upward from each start with node:crypto SHA-256.
    for (const [fill, start, first] of [
      [3, [0, 0, 0, 1, 0xff, 0xff, 0xff, 0xf0], "AAAAAgAAFks"],
      [5, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00], "AAAAAAABLnE"],
    ] as const) {
      const random = startingAt(Uint8Array.from(start));
      try {
        expect(await solveProofOfWork(b64(32, fill))).toBe(first);
      } finally {
        random.mockRestore();
      }
    }
  });

  it("agrees with node:crypto SHA-256 on random challenges and starting nonces", async () => {
    for (let run = 0; run < 3; run++) {
      const challenge = randomBytes(32);
      const start = randomBytes(8);
      const candidate = Buffer.concat([challenge, start]);
      let nonce = candidate.readBigUInt64BE(32);
      for (;;) {
        const digest = createHash("sha256").update(candidate).digest();
        if (digest[0] === 0 && digest[1] === 0 && (digest[2]! & 0xc0) === 0) break;
        nonce = BigInt.asUintN(64, nonce + 1n);
        candidate.writeBigUInt64BE(nonce, 32);
      }
      const random = startingAt(new Uint8Array(start));
      try {
        expect(await solveProofOfWork(encodeBytes(new Uint8Array(challenge)))).toBe(
          encodeBytes(new Uint8Array(candidate.subarray(32))),
        );
      } finally {
        random.mockRestore();
      }
    }
  }, 30_000);

  it("yields between slices and stops at the next slice once aborted mid-search", async () => {
    const controller = new AbortController();
    let reads = 0;
    // Each clock read moves a second on, so every slice runs one batch of 1,024 candidates.
    // The abort on the fourth read, the end of the second slice, comes mid-search: the zero
    // challenge's first answer from nonce 0 is 133 batches away.
    const clock = vi.spyOn(performance, "now").mockImplementation(() => {
      if (++reads === 4) controller.abort();
      return reads * 1_000;
    });
    const random = startingAt(new Uint8Array(8));
    try {
      await expect(solveProofOfWork(b64(32, 0), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clock.mockRestore();
      random.mockRestore();
    }
  });
});

/** Makes the solver's random starting nonce `start`. */
function startingAt(start: Uint8Array) {
  return vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
    (array as Uint8Array).set(start);
    return array;
  });
}
