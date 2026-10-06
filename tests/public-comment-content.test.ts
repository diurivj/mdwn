import { describe, expect, it } from "vitest";
import {
  derivePublicationCapabilityKey,
  isCommentEpochLink,
  openCommentEpochLink,
  openPublicAttribution,
  openPublicCommentBody,
  sealCommentEpochLink,
  sealPublicAttribution,
  sealPublicCommentBody,
} from "../app/shared/comments/public-content";
import { inspectEnvelope, sealToRecipient } from "../app/shared/crypto/enc-v1";
import { createPublicationKeyPair, newPublicationIdentifier } from "../app/shared/publications/capability";
import { encodeTreeBytes } from "../app/shared/tree/wire";

const publicationId = newPublicationIdentifier(),
  linkId = newPublicationIdentifier();
const epochId = crypto.randomUUID(),
  capabilityId = crypto.randomUUID();
const capability = crypto.getRandomValues(new Uint8Array(32));

describe("public Comment audience epochs", () => {
  it("wraps an epoch to the Publication capability and opens it only with the fragment", async () => {
    const keys = await createPublicationKeyPair();
    const wrapper = await sealCommentEpochLink(keys.privateKey, keys.publicKey, {
      publicationId,
      linkId,
      epochId,
      capabilityId,
      keyEpoch: 1,
      capability,
    });
    expect(isCommentEpochLink(wrapper, { publicationId, linkId, epochId, capabilityId, keyEpoch: 1 })).toBe(true);
    expect(inspectEnvelope(wrapper).context.purpose).toBe("public-comment-epoch-link");
    expect(inspectEnvelope(wrapper).suite).toBe("AES-256-GCM/HKDF-SHA-256");
    expect(
      await openCommentEpochLink(keys.privateKey, keys.publicKey, {
        publicationId,
        linkId,
        epochId,
        capabilityId,
        keyEpoch: 1,
        ciphertext: encodeTreeBytes(wrapper),
      }),
    ).toEqual(capability);
    // Another fragment derives another key; the stored public point is bound too.
    const other = await createPublicationKeyPair();
    await expect(
      openCommentEpochLink(other.privateKey, other.publicKey, {
        publicationId,
        linkId,
        epochId,
        capabilityId,
        keyEpoch: 1,
        ciphertext: encodeTreeBytes(wrapper),
      }),
    ).rejects.toThrow();
    await expect(
      openCommentEpochLink(keys.privateKey, other.publicKey, {
        publicationId,
        linkId,
        epochId,
        capabilityId,
        keyEpoch: 1,
        ciphertext: encodeTreeBytes(wrapper),
      }),
    ).rejects.toThrow();
    // The derived key is domain-separated from the raw scalar.
    expect(await derivePublicationCapabilityKey(keys.privateKey, keys.publicKey)).not.toEqual(keys.privateKey);
  });

  it("rejects a crossed link, epoch or capability binding", async () => {
    const keys = await createPublicationKeyPair();
    const wrapper = await sealCommentEpochLink(keys.privateKey, keys.publicKey, {
      publicationId,
      linkId,
      epochId,
      capabilityId,
      keyEpoch: 1,
      capability,
    });
    for (const crossed of [
      { publicationId: newPublicationIdentifier() },
      { linkId: newPublicationIdentifier() },
      { epochId: crypto.randomUUID() },
      { capabilityId: crypto.randomUUID() },
      { keyEpoch: 2 },
    ]) {
      expect(
        isCommentEpochLink(wrapper, { publicationId, linkId, epochId, capabilityId, keyEpoch: 1, ...crossed }),
      ).toBe(false);
      await expect(
        openCommentEpochLink(keys.privateKey, keys.publicKey, {
          publicationId,
          linkId,
          epochId,
          capabilityId,
          keyEpoch: 1,
          ...crossed,
          ciphertext: encodeTreeBytes(wrapper),
        }),
      ).rejects.toThrow();
    }
    // A device HPKE envelope is never accepted as a link wrapper.
    const device = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const hpke = await sealToRecipient(capability, device.publicKey, {
      purpose: "public-comment-audience-epoch",
      vaultId: publicationId,
      objectId: epochId,
      keyId: capabilityId,
      keyEpoch: 1,
      revision: 1,
      recipientId: "device-1",
      publicationId,
    });
    expect(isCommentEpochLink(hpke, { publicationId, linkId, epochId, capabilityId, keyEpoch: 1 })).toBe(false);
  });

  it("binds Comment bodies and pseudonyms to the logical Publication", async () => {
    const commentId = crypto.randomUUID(),
      attributionId = crypto.randomUUID();
    const body = await sealPublicCommentBody(capability, {
      publicationId,
      commentId,
      capabilityId,
      keyEpoch: 1,
      revision: 1,
      text: "Public line\r\nTwo",
    });
    expect(
      await openPublicCommentBody(capability, {
        publicationId,
        commentId,
        revision: 1,
        capabilityId,
        keyEpoch: 1,
        bodyCiphertext: body.bodyCiphertext,
        contentKeyEnvelope: body.contentKeyEnvelope,
      }),
    ).toBe("Public line\nTwo");
    const crossed = await sealPublicCommentBody(capability, {
      publicationId: newPublicationIdentifier(),
      commentId,
      capabilityId,
      keyEpoch: 1,
      revision: 1,
      text: "Other Publication",
    });
    expect(crossed.bodyCiphertext).not.toBe(body.bodyCiphertext);
    await expect(
      openPublicCommentBody(capability, {
        publicationId,
        commentId,
        revision: 1,
        capabilityId,
        keyEpoch: 1,
        bodyCiphertext: crossed.bodyCiphertext,
        contentKeyEnvelope: crossed.contentKeyEnvelope,
      }),
    ).rejects.toThrow();
    const attribution = await sealPublicAttribution(capability, {
      publicationId,
      attributionId,
      pseudonym: "Member Sage",
      capabilityId,
      keyEpoch: 1,
    });
    expect(
      await openPublicAttribution(capability, {
        publicationId,
        attributionId,
        revision: 1,
        capabilityId,
        keyEpoch: 1,
        ciphertext: attribution.ciphertext,
        contentKeyEnvelope: attribution.contentKeyEnvelope,
      }),
    ).toBe("Member Sage");
    expect(
      (
        await sealPublicCommentBody(capability, {
          publicationId,
          commentId,
          capabilityId,
          keyEpoch: 1,
          revision: 2,
          text: "Longer text",
        })
      ).bodyCiphertext,
    ).not.toBe(body.bodyCiphertext);
  });

  it("stores no fragment or plaintext capability in a link wrapper", async () => {
    const keys = await createPublicationKeyPair();
    const wrapper = await sealCommentEpochLink(keys.privateKey, keys.publicKey, {
      publicationId,
      linkId,
      epochId,
      capabilityId,
      keyEpoch: 1,
      capability,
    });
    const text = new TextDecoder().decode(wrapper);
    expect(text).not.toContain(encodeTreeBytes(keys.privateKey));
    expect(text).not.toContain(encodeTreeBytes(capability));
  });
});
