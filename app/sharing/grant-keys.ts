import { inspectEnvelope, openForRecipient, sealToRecipient, type EnvelopeContext } from "~/crypto/enc-v1";
import { decodeTreeBytes, encodeTreeBytes, isV7 } from "~/tree/wire";

export type GrantKeyContext = {
  relationshipId: string; ownerId: string; recipientId: string; targetId: string;
  targetKind: "directory" | "file"; capabilityId: string; capabilityEpoch: number;
  grantKeyEpoch: number; ownerRegistryEpoch: number; recipientRegistryEpoch: number;
};
type AddressedContext = GrantKeyContext & { deviceId: string; signerDeviceId: string };
type SignedEnvelope = AddressedContext & { ciphertext: string; signature: string };

function validate(context: AddressedContext) {
  if (![context.relationshipId, context.ownerId, context.recipientId, context.targetId, context.capabilityId,
    context.deviceId, context.signerDeviceId].every(isV7) ||
    ![context.capabilityEpoch, context.grantKeyEpoch, context.ownerRegistryEpoch, context.recipientRegistryEpoch]
      .every((epoch) => Number.isSafeInteger(epoch) && epoch > 0) ||
    (context.targetKind !== "directory" && context.targetKind !== "file")) throw new Error("invalid grant context");
}
function hpkeContext(context: AddressedContext): EnvelopeContext {
  return { purpose: "grant", vaultId: context.ownerId, objectId: context.targetId,
    keyId: context.capabilityId, keyEpoch: context.capabilityEpoch,
    revision: context.grantKeyEpoch, recipientId: context.deviceId };
}
async function transcript(context: AddressedContext, ciphertext: Uint8Array) {
  validate(context);
  const digest = encodeTreeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(ciphertext))));
  return new TextEncoder().encode(JSON.stringify(["mdwn/grant-key-envelope", 1,
    context.relationshipId, context.ownerId, context.recipientId, context.targetId, context.targetKind,
    context.capabilityId, context.capabilityEpoch, context.grantKeyEpoch, context.ownerRegistryEpoch,
    context.recipientRegistryEpoch, context.deviceId, context.signerDeviceId, digest]));
}

/** Structural HPKE context and an independent source-device signature are both
 * required. The endpoint establishes Owner or current recipient-holder authority. */
export async function verifyGrantKeySignature(record: SignedEnvelope, signerPublicKey: string): Promise<boolean> {
  try {
    const ciphertext = decodeTreeBytes(record.ciphertext, 16_384), signature = decodeTreeBytes(record.signature, 64);
    const envelope = inspectEnvelope(ciphertext), expected = hpkeContext(record);
    if (signature.length !== 64 || envelope.suite !== "HPKE-P256/HKDF-SHA-256/AES-256-GCM" ||
        Object.keys(envelope.context).length !== Object.keys(expected).length ||
        Object.entries(expected).some(([key, value]) => envelope.context[key as keyof EnvelopeContext] !== value)) return false;
    const key = await crypto.subtle.importKey("raw", decodeTreeBytes(signerPublicKey, 65),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, await transcript(record, ciphertext));
  } catch { return false; }
}

export async function createGrantKeyEnvelope(key: Uint8Array, recipientPublicKey: CryptoKey,
  assertionPrivateKey: CryptoKey, context: AddressedContext): Promise<{ deviceId: string; ciphertext: string; signature: string }> {
  validate(context);
  if (key.length !== 32) throw new Error("invalid grant key");
  const ciphertext = await sealToRecipient(new Uint8Array(key), recipientPublicKey, hpkeContext(context));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" },
    assertionPrivateKey, await transcript(context, ciphertext)));
  return { deviceId: context.deviceId, ciphertext: encodeTreeBytes(ciphertext), signature: encodeTreeBytes(signature) };
}

export async function openGrantKeyEnvelope(record: SignedEnvelope & {
  signerPublicKey: string; recipient: CryptoKeyPair;
}): Promise<Uint8Array<ArrayBuffer>> {
  if (!await verifyGrantKeySignature(record, record.signerPublicKey)) throw new Error("invalid grant signature");
  const key = await openForRecipient(decodeTreeBytes(record.ciphertext, 16_384), record.recipient,
    { context: hpkeContext(record) });
  if (key.length !== 32) throw new Error("invalid grant key");
  return key;
}
