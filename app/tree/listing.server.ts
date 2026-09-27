import { record } from "~/auth/request.server";
import { digestEnvelope } from "~/crypto/enc-v1";
import type { AuthorizedDevice } from "~/device/proof.server";
import { decodeTreeBytes, treeEnvelope } from "./wire";
import { MAX_LISTING_BYTES, verifyListingSignature, type ListingHead } from "./listing";

/** Verify the signed ciphertext head before allowing a conditional parent revision advance. */
export async function signedListing(value: unknown, auth: AuthorizedDevice, directoryId: string,
  expectedRevision: number): Promise<{ ciphertext: Uint8Array; digest: Uint8Array; signature: Uint8Array }> {
  const input = record(value);
  if (!input || Object.keys(input).length !== 3 ||
      !["ciphertext", "digest", "signature"].every((key) => Object.hasOwn(input, key))) {
    throw new Error("invalid listing head");
  }
  const revision = expectedRevision + 1;
  const ciphertext = treeEnvelope(input.ciphertext, MAX_LISTING_BYTES, {
    purpose: "directory-metadata", vaultId: auth.accountId, objectId: directoryId,
    keyId: directoryId, keyEpoch: 1, revision,
  });
  const digest = decodeTreeBytes(input.digest, 32);
  const signature = decodeTreeBytes(input.signature, 64);
  const computed = await digestEnvelope(ciphertext);
  if (digest.length !== 32 || signature.length !== 64 ||
      !computed.every((byte, i) => byte === digest[i]) ||
      !await verifyListingSignature(input as ListingHead, {
        vaultId: auth.accountId, directoryId, deviceId: auth.deviceId, revision,
        publicKey: auth.assertionPublicKey,
      })) throw new Error("invalid listing head");
  return { ciphertext, digest, signature };
}
