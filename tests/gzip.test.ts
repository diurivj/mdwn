import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { recoveryCodesText, recoveryPhraseText } from "../app/shared/account/recovery-text";
import { gzip } from "../app/shared/archive/gzip";

const encoder = new TextEncoder();
const created = new Date("2026-10-12T12:00:00Z");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gzip-compressed recovery downloads", () => {
  it("make one gzip member that standard tools restore to the exact text", async () => {
    for (const text of [
      recoveryPhraseText(Array.from({ length: 24 }, (_, index) => `word${index + 1}`).join(" "), created),
      recoveryCodesText(["ÁBC-123", "DEF-456"], "019950d7-98c0-7000-8000-000000000001", created),
    ]) {
      const compressed = await gzip(encoder.encode(text));
      expect(compressed).not.toBeNull();
      // RFC 1952 magic bytes, then DEFLATE as the compression method.
      expect([...compressed!.subarray(0, 3)]).toEqual([0x1f, 0x8b, 8]);
      expect(gunzipSync(compressed!).toString("utf8")).toBe(text);
    }
  });

  it("returns null where the platform cannot compress, so the plain file remains", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    expect(await gzip(encoder.encode("words"))).toBeNull();
  });
});
