import { describe, expect, it } from "vitest";

import {
  ACCOUNT_PROFILE_KEY_ID,
  ACCOUNT_PROFILE_OBJECT_ID,
  accountProfileContext,
  openAccountProfile,
  sealAccountProfile,
} from "../app/shared/crypto/account-profile";
import { inspectEnvelope } from "../app/shared/crypto/enc-v1";
import { PURPOSES } from "../app/shared/crypto/enc-v1/format";

const rootKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const expected = {
  accountId: "019950d7-98c0-7000-8000-000000000006",
  epoch: 1,
  revision: 1,
};

describe("encrypted Account profiles", () => {
  it("pins account-profile as purpose 17 and appends device purposes without renumbering", () => {
    expect(PURPOSES).toEqual([
      "directory-capability",
      "file-content-key",
      "file-content",
      "directory-metadata",
      "grant",
      "device-enrollment",
      "vault-recovery",
      "recovery-capsule",
      "public-representation",
      "private-comment-thread",
      "public-comment-audience-epoch",
      "comment-content",
      "attribution",
      "archive-manifest",
      "import-staging-manifest",
      "import-chunk",
      "account-profile",
      "owned-device",
      "device-label",
      "file-capability",
      "publication-attribution",
      "public-comment-epoch-link",
    ]);
    expect(accountProfileContext(expected)).toEqual({
      purpose: "account-profile",
      vaultId: expected.accountId,
      objectId: ACCOUNT_PROFILE_OBJECT_ID,
      keyId: ACCOUNT_PROFILE_KEY_ID,
      keyEpoch: expected.epoch,
      revision: expected.revision,
    });
  });

  it("encrypts a Public pseudonym and opens only against caller-supplied current metadata", async () => {
    const record = await sealAccountProfile(rootKey, { publicPseudonym: "Cobalt Wren" }, expected);

    expect(record).toMatchObject({ epoch: 1, revision: 1 });
    expect(inspectEnvelope(record.ciphertext)).toMatchObject({
      suite: "AES-256-GCM/HKDF-SHA-256",
      context: accountProfileContext(expected),
    });
    await expect(openAccountProfile(record.ciphertext, rootKey, expected)).resolves.toEqual({
      publicPseudonym: "Cobalt Wren",
    });
    await expect(
      openAccountProfile(record.ciphertext, rootKey, {
        ...expected,
        accountId: "019950d7-98c0-7000-8000-000000000007",
      }),
    ).rejects.toMatchObject({ code: "context-mismatch" });
    await expect(
      openAccountProfile(record.ciphertext, rootKey, {
        ...expected,
        revision: 2,
      }),
    ).rejects.toMatchObject({ code: "context-mismatch" });
  });
});
