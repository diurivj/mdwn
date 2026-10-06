import { describe, expect, it } from "vitest";
import {
  attributionContext,
  attributionKeyContext,
  commentBodyContext,
  commentCharacters,
  commentKeyContext,
  MAX_COMMENT_CHARS,
  normalizeCommentText,
  openAttribution,
  openCommentBody,
  openCommentRecord,
  sealAttribution,
  sealCommentBody,
  validCommentText,
} from "../app/shared/comments/content";

const vaultId = "0198c0de-0000-7000-8000-000000000001";
const commentId = "0198c0de-0000-7000-8000-000000000002";
const capabilityId = "0198c0de-0000-7000-8000-000000000003";
const attributionId = "0198c0de-0000-7000-8000-000000000004";
const threadKey = new Uint8Array(32).fill(7);
const otherKey = new Uint8Array(32).fill(8);

describe("private comment content", () => {
  it("round-trips encrypted historical display metadata under the same content key", async () => {
    const sealed = await sealCommentBody(threadKey, {
      vaultId,
      commentId,
      capabilityId,
      keyEpoch: 1,
      revision: 1,
      text: "historical",
      meta: { createdAt: 1_700_000_000_000, updatedAt: 1_700_000_001_000 },
    });
    expect(sealed.metaCiphertext).toBeTruthy();
    const opened = await openCommentRecord(threadKey, {
      vaultId,
      commentId,
      revision: 1,
      capabilityId,
      keyEpoch: 1,
      bodyCiphertext: sealed.bodyCiphertext,
      contentKeyEnvelope: sealed.contentKeyEnvelope,
      metaCiphertext: sealed.metaCiphertext,
    });
    expect(opened.text).toBe("historical");
    expect(opened.meta).toEqual({ createdAt: 1_700_000_000_000, updatedAt: 1_700_000_001_000 });
    await expect(
      sealCommentBody(threadKey, {
        vaultId,
        commentId,
        capabilityId,
        keyEpoch: 1,
        revision: 1,
        text: "bad",
        meta: { createdAt: 2, updatedAt: 1 },
      }),
    ).rejects.toThrow();
  });

  it("round-trips plain text and normalizes CRLF and lone CR line breaks", async () => {
    const sealed = await sealCommentBody(threadKey, {
      vaultId,
      commentId,
      capabilityId,
      keyEpoch: 1,
      revision: 1,
      text: "First\r\nSecond\rThird",
    });
    const opened = await openCommentBody(threadKey, {
      vaultId,
      commentId,
      revision: 1,
      capabilityId,
      keyEpoch: 1,
      bodyCiphertext: sealed.bodyCiphertext,
      contentKeyEnvelope: sealed.contentKeyEnvelope,
    });
    expect(opened).toBe("First\nSecond\nThird");
    expect(normalizeCommentText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("opens only under the matching thread capability, epoch and revision", async () => {
    const sealed = await sealCommentBody(threadKey, {
      vaultId,
      commentId,
      capabilityId,
      keyEpoch: 1,
      revision: 1,
      text: "Context-bound",
    });
    const open = (key: Uint8Array, keyEpoch: number, revision: number) =>
      openCommentBody(key, {
        vaultId,
        commentId,
        revision,
        capabilityId,
        keyEpoch,
        bodyCiphertext: sealed.bodyCiphertext,
        contentKeyEnvelope: sealed.contentKeyEnvelope,
      });
    await expect(open(otherKey, 1, 1)).rejects.toThrow();
    await expect(open(threadKey, 2, 1)).rejects.toThrow();
    await expect(open(threadKey, 1, 2)).rejects.toThrow();
  });

  it("treats a 2,000-character body as valid and a 2,001-character body as invalid", async () => {
    const atLimit = "a".repeat(MAX_COMMENT_CHARS);
    expect(validCommentText(atLimit)).toBe(true);
    expect(commentCharacters(atLimit)).toBe(MAX_COMMENT_CHARS);
    expect(validCommentText(atLimit + "a")).toBe(false);
    await expect(
      sealCommentBody(threadKey, { vaultId, commentId, capabilityId, keyEpoch: 1, revision: 1, text: atLimit + "a" }),
    ).rejects.toThrow("comment_too_long");
    // A 2,000-character body still fits the bounded ciphertext column.
    const sealed = await sealCommentBody(threadKey, {
      vaultId,
      commentId,
      capabilityId,
      keyEpoch: 1,
      revision: 1,
      text: atLimit,
    });
    expect(sealed.bodyCiphertext.length).toBeLessThan(16_384);
  });

  it("round-trips a pseudonym attribution and rejects tampering", async () => {
    const sealed = await sealAttribution(threadKey, {
      vaultId,
      attributionId,
      pseudonym: "Member Quiet Pine",
      capabilityId,
      keyEpoch: 1,
    });
    const opened = await openAttribution(threadKey, {
      vaultId,
      attributionId,
      revision: 1,
      capabilityId,
      keyEpoch: 1,
      ciphertext: sealed.ciphertext,
      contentKeyEnvelope: sealed.contentKeyEnvelope,
    });
    expect(opened).toBe("Member Quiet Pine");
    const tampered = new Uint8Array(Buffer.from(sealed.ciphertext, "base64url"));
    tampered[tampered.length - 1] ^= 1;
    await expect(
      openAttribution(threadKey, {
        vaultId,
        attributionId,
        revision: 1,
        capabilityId,
        keyEpoch: 1,
        ciphertext: Buffer.from(tampered).toString("base64url"),
        contentKeyEnvelope: sealed.contentKeyEnvelope,
      }),
    ).rejects.toThrow();
  });

  it("keeps every context purpose-bound and never reuses another purpose's ciphertext", async () => {
    const body = await sealCommentBody(threadKey, {
      vaultId,
      commentId,
      capabilityId,
      keyEpoch: 1,
      revision: 1,
      text: "Body",
    });
    const attribution = await sealAttribution(threadKey, {
      vaultId,
      attributionId,
      pseudonym: "Member",
      capabilityId,
      keyEpoch: 1,
    });
    expect(commentBodyContext(vaultId, commentId, 1).purpose).toBe("comment-content");
    expect(commentKeyContext(vaultId, commentId, capabilityId, 1, 1).purpose).toBe("comment-content");
    expect(attributionContext(vaultId, attributionId, 1).purpose).toBe("attribution");
    expect(attributionKeyContext(vaultId, attributionId, capabilityId, 1, 1).purpose).toBe("attribution");
    await expect(
      openAttribution(threadKey, {
        vaultId,
        attributionId,
        revision: 1,
        capabilityId,
        keyEpoch: 1,
        ciphertext: body.bodyCiphertext,
        contentKeyEnvelope: attribution.contentKeyEnvelope,
      }),
    ).rejects.toThrow();
  });
});
