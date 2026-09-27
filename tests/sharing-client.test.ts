import { describe, expect, it } from "vitest";

import { encodeRecipientAddress } from "../app/sharing/client";

describe("exact Share addressing", () => {
  it("removes one leading @ and sends the reviewed canonical handle token", async () => {
    await expect(encodeRecipientAddress("@ALICE")).resolves.toEqual({
      kind: "handle",
      value: "sh1:sYgK0eW6DfzVCUcNDlphPgu7BCqXpp9jXpWA5cu2zC0",
    });
  });

  it("preserves an opaque UUIDv7 share identifier byte-for-byte", async () => {
    const shareId = "018f0000-0000-7000-8000-000000000001";
    await expect(encodeRecipientAddress(shareId)).resolves.toEqual({
      kind: "share-id",
      value: shareId,
    });
  });

  it.each([
    "",
    " ",
    "@",
    "@@alice",
    "@alice ",
    "@ alice",
    "@al\nice",
    "@álîce",
    "@Ａlice",
    "@alice@other",
    "018f0000-0000-7000-8000-00000000000 ",
    "018f0000-0000-7000-8000-00000000000é",
    "not-an-opaque-share-id",
  ])("rejects malformed address %j before it can be looked up", async (address) => {
    await expect(encodeRecipientAddress(address)).rejects.toThrow();
  });
});
