import { record } from "~/auth/request.server";
import { digestEnvelope } from "~/crypto/enc-v1";
import type { AuthorizedDevice } from "~/device/proof.server";
import { decodeTreeBytes, treeEnvelope } from "./wire";
import { MAX_LISTING_BYTES, validEpoch, verifyListingSignature, type ListingHead, type ListingVersion } from "./listing";

/** The Directory being re-signed, as currently stored; `epoch` is `directories.capability_epoch`. */
export type ListingTarget = { directoryId: string; expectedRevision: number; ownerId: string;
  version: ListingVersion; epoch: number };

/**
 * Verify the signed ciphertext head before allowing a conditional parent revision advance.
 * The caller's `entries_revision` CAS also pins the epoch: every rotation writes a new revision.
 */
export async function signedListing(value: unknown, auth: AuthorizedDevice,
  { directoryId, expectedRevision, ownerId, version, epoch }: ListingTarget
): Promise<{ ciphertext: Uint8Array; digest: Uint8Array; signature: Uint8Array }> {
  if (!validEpoch(epoch)) throw new Error("invalid listing head");
  const input = record(value);
  if (!input || Object.keys(input).length !== 3 ||
      !["ciphertext", "digest", "signature"].every((key) => Object.hasOwn(input, key))) {
    throw new Error("invalid listing head");
  }
  const revision = expectedRevision + 1;
  const ciphertext = treeEnvelope(input.ciphertext, MAX_LISTING_BYTES, {
    purpose: "directory-metadata", vaultId: ownerId, objectId: directoryId,
    keyId: directoryId, keyEpoch: epoch, revision,
  });
  const digest = decodeTreeBytes(input.digest, 32);
  const signature = decodeTreeBytes(input.signature, 64);
  const computed = await digestEnvelope(ciphertext);
  if (digest.length !== 32 || signature.length !== 64 ||
      !computed.every((byte, i) => byte === digest[i]) ||
      !await verifyListingSignature(input as ListingHead, {
        vaultId: ownerId, directoryId, deviceId: auth.deviceId, revision,
        publicKey: auth.assertionPublicKey, version,
      })) throw new Error("invalid listing head");
  return { ciphertext, digest, signature };
}
