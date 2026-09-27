import { expect, it } from "vitest";

import { createListingHead, openListingHead } from "../../app/tree/listing";

it("opens only a device-signed current Directory listing and rejects old and same-revision forks", async () => {
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", signing.publicKey));
  const directoryKey = crypto.getRandomValues(new Uint8Array(32));
  const vaultId = "019950d7-98c0-7000-8000-000000000114";
  const directoryId = "019950d7-98c0-7000-8000-000000000115";
  const deviceId = "019950d7-98c0-7000-8000-000000000116";
  const entries = [{ nodeId: "019950d7-98c0-7000-8000-000000000117", kind: "directory" as const,
    nameCiphertext: "opaque-name", orderCiphertext: "opaque-order", keyEnvelope: "opaque-capability" }];
  const first = await createListingHead(directoryKey, signing.privateKey, {
    vaultId, directoryId, deviceId, revision: 2, entries,
  });
  const trusted = { ...first, signerDeviceId: deviceId, signerPublicKey: publicKey };
  await expect(openListingHead(directoryKey, { vaultId, directoryId, revision: 2, entries, head: trusted }))
    .resolves.toBeUndefined();
  await expect(openListingHead(directoryKey, { vaultId, directoryId, revision: 3, entries, head: trusted }))
    .rejects.toMatchObject({ code: "replayed-manifest" });
  await expect(openListingHead(directoryKey, { vaultId, directoryId, revision: 2,
    entries: [{ ...entries[0]!, nameCiphertext: "substituted" }], head: trusted }))
    .rejects.toMatchObject({ code: "replayed-manifest" });
  await expect(openListingHead(directoryKey, { vaultId, directoryId, revision: 2, entries,
    head: { ...trusted, digest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } }))
    .rejects.toMatchObject({ code: "replayed-manifest" });
});
