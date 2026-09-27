/* File-only, parent/path/name-free protocol for a holder of a retained current key.
 * All byte strings are canonical base64url via tree/wire. A bootstrap is not a
 * File read: the signed head carries commitments, never representation ciphertext.
 */
export type RecipientWire = { accountId: string; deviceId: string; registryEpoch: number;
  publicKey: string; grants: { id: string; generation: number }[] };
export type SignedHeadWire = { bytes: string; digest: string; signature: string;
  signerDeviceId: string; signerPublicKey: string };
export type FileProvisioningBootstrap = { ownerId: string; fileId: string;
  currentHead: SignedHeadWire; recipients: RecipientWire[];
  retained: { ciphertext: string; digest: string; contentKeyId: string;
    contentEpoch: number; revision: number } };
export type FileProvisioningCompletion = { expectedHeadDigest: string;
  expectedRevision: number; expectedRecipientSetVersion: number;
  signedHead: { bytes: string; digest: string; signature: string };
  recipientEnvelopes: { deviceId: string; ciphertext: string }[] };
