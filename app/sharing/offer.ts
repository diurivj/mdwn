import { inspectEnvelope } from "~/crypto/enc-v1";
import { HPKE_SUITE, SYMMETRIC_SUITE } from "~/crypto/enc-v1/format";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DOMAIN = "mdwn/share-offer/v1";
export type OfferDevice = { accountId: string; deviceId: string; registryEpoch: number;
  publicKeyDigest: string; contentDigest: string; labelDigest: string };
export type Offer = { shareId: string; grantId: string; ownerId: string; recipientId: string;
  targetId: string; kind: "directory" | "file"; permission: "read_only" | "read_write";
  materialRevision: number; targetKeyId: string; targetEpoch: number;
  contentRevision: number; headDigest: string; labelId: string; ownerCopyDigest: string;
  registryEpoch: number; devices: OfferDevice[]; candidateDigest: string | null; signerDeviceId: string };

export const digestBytes = async (bytes: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
export const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((n, i) => n === b[i]);

/** Canonical detached signature; HPKE base mode does not identify the sender. */
export function offerBytes(offer: Offer): Uint8Array {
  if (!offer || !Number.isSafeInteger(offer.materialRevision) || offer.materialRevision < 1 ||
      !Number.isSafeInteger(offer.targetEpoch) || offer.targetEpoch < 1 ||
      !Number.isSafeInteger(offer.registryEpoch) || offer.registryEpoch < 1 ||
      !Number.isSafeInteger(offer.contentRevision) || offer.contentRevision < 1 ||
      offer.devices.length > 256 || new Set(offer.devices.map((d) => d.deviceId)).size !== offer.devices.length ||
      offer.devices.some((d) => [d.publicKeyDigest, d.contentDigest, d.labelDigest]
        .some((hash) => !/^[a-f0-9]{64}$/.test(hash))) ||
      [offer.headDigest, offer.ownerCopyDigest, ...(offer.candidateDigest ? [offer.candidateDigest] : [])]
        .some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error("invalid share offer");
  }
  const members = [...offer.devices].sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  const bytes = encoder.encode(JSON.stringify([DOMAIN, offer.shareId, offer.grantId, offer.ownerId,
    offer.recipientId, offer.targetId, offer.kind, offer.permission, offer.materialRevision,
    offer.targetKeyId, offer.targetEpoch, offer.contentRevision, offer.headDigest, offer.labelId,
    offer.ownerCopyDigest, offer.registryEpoch, members.map((d) => [d.accountId, d.deviceId,
      d.registryEpoch, d.publicKeyDigest, d.contentDigest, d.labelDigest]),
    offer.candidateDigest, offer.signerDeviceId]));
  if (bytes.length > 131072) throw new Error("invalid share offer");
  return bytes;
}

export function parseOffer(bytes: Uint8Array): Offer {
  if (bytes.length > 131072) throw new Error("invalid share offer");
  const a: unknown = JSON.parse(decoder.decode(bytes));
  if (!Array.isArray(a) || a.length !== 19 || a[0] !== DOMAIN || !Array.isArray(a[16])) {
    throw new Error("invalid share offer");
  }
  const devices: OfferDevice[] = a[16].map((value: unknown) => {
    if (!Array.isArray(value) || value.length !== 6) throw new Error("invalid share offer");
    return { accountId: value[0], deviceId: value[1], registryEpoch: value[2],
      publicKeyDigest: value[3], contentDigest: value[4], labelDigest: value[5] };
  });
  const offer: Offer = { shareId: a[1], grantId: a[2], ownerId: a[3], recipientId: a[4],
    targetId: a[5], kind: a[6], permission: a[7], materialRevision: a[8],
    targetKeyId: a[9], targetEpoch: a[10], contentRevision: a[11], headDigest: a[12],
    labelId: a[13], ownerCopyDigest: a[14], registryEpoch: a[15], devices,
    candidateDigest: a[17], signerDeviceId: a[18] };
  if (offer.kind !== "directory" && offer.kind !== "file" ||
      offer.permission !== "read_only" && offer.permission !== "read_write" ||
      !sameBytes(offerBytes(offer), bytes)) throw new Error("invalid share offer");
  return offer;
}

export async function signOffer(offer: Offer, privateKey: CryptoKey) {
  const bytes = offerBytes(offer);
  return { bytes, digest: await digestBytes(bytes), signature: new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, privateKey, new Uint8Array(bytes))) };
}
export async function verifyOffer(bytes: Uint8Array, digest: Uint8Array, signature: Uint8Array,
  signerPublicKey: Uint8Array): Promise<Offer> {
  const parsed = parseOffer(bytes);
  if (!sameBytes(await digestBytes(bytes), digest) || signature.length !== 64 || signerPublicKey.length !== 65) {
    throw new Error("invalid share offer");
  }
  const key = await crypto.subtle.importKey("raw", new Uint8Array(signerPublicKey),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key,
    new Uint8Array(signature), new Uint8Array(bytes))) throw new Error("invalid share offer");
  return parsed;
}

/** Server structural validation does not prove encrypted plaintext equality. */
export function inspectOfferEnvelope(bytes: Uint8Array, context: { purpose: "grant" | "share-root-label";
  vaultId: string; objectId: string; keyId: string; keyEpoch: number; revision: number; recipientId?: string },
  suite: typeof HPKE_SUITE | typeof SYMMETRIC_SUITE = HPKE_SUITE): void {
  const found = inspectEnvelope(bytes);
  if (found.suite !== suite || Object.keys(found.context).length !== Object.keys(context).length ||
      Object.entries(context).some(([key, value]) => found.context[key as keyof typeof found.context] !== value)) {
    throw new Error("invalid offer envelope");
  }
}

