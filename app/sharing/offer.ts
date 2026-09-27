import { inspectEnvelope } from "../crypto/enc-v1";
import { HPKE_SUITE, SYMMETRIC_SUITE } from "../crypto/enc-v1/format";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const DOMAIN = "mdwn/share-offer/v1";
const opaqueId = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestHex = /^[a-f0-9]{64}$/;
const validId = (value: unknown): value is string => typeof value === "string" && opaqueId.test(value);
const positiveCounter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const validDigest = (value: unknown): value is string => typeof value === "string" && digestHex.test(value);
const offerFields = ["shareId", "grantId", "ownerId", "recipientId", "targetId", "kind", "permission",
  "materialRevision", "targetKeyId", "targetEpoch", "contentRevision", "headDigest", "labelId",
  "ownerCopyDigest", "registryEpoch", "devices", "candidateDigest", "signerDeviceId"];
const deviceFields = ["accountId", "deviceId", "registryEpoch", "publicKeyDigest", "contentDigest", "labelDigest"];
const exactFields = (value: object, fields: string[]) =>
  Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
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
  if (!offer || typeof offer !== "object" || Array.isArray(offer) || !exactFields(offer, offerFields) ||
      ![offer.shareId, offer.grantId, offer.ownerId, offer.recipientId, offer.targetId,
        offer.targetKeyId, offer.labelId, offer.signerDeviceId].every(validId) ||
      offer.ownerId === offer.recipientId ||
      (offer.kind !== "directory" && offer.kind !== "file") ||
      (offer.permission !== "read_only" && offer.permission !== "read_write") ||
      (offer.kind === "directory" && (offer.targetKeyId !== offer.targetId || offer.candidateDigest !== null)) ||
      (offer.kind === "file" && !validDigest(offer.candidateDigest)) ||
      !positiveCounter(offer.materialRevision) || !positiveCounter(offer.targetEpoch) ||
      !positiveCounter(offer.registryEpoch) || !positiveCounter(offer.contentRevision) ||
      !validDigest(offer.headDigest) || !validDigest(offer.ownerCopyDigest) ||
      !Array.isArray(offer.devices) || offer.devices.length > 256 ||
      offer.devices.some((d) => !d || typeof d !== "object" || Array.isArray(d) ||
        !exactFields(d, deviceFields) || d.accountId !== offer.recipientId || !validId(d.deviceId) ||
        !positiveCounter(d.registryEpoch) || d.registryEpoch !== offer.registryEpoch ||
        !validDigest(d.publicKeyDigest) || !validDigest(d.contentDigest) || !validDigest(d.labelDigest)) ||
      new Set(offer.devices.map((d) => d.deviceId)).size !== offer.devices.length) {
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
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 131072) throw new Error("invalid share offer");
  const a: unknown = JSON.parse(decoder.decode(bytes));
  if (!Array.isArray(a) || a.length !== 19 || a[0] !== DOMAIN || !Array.isArray(a[16]) || a[16].length > 256) {
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
  if (!sameBytes(offerBytes(offer), bytes)) throw new Error("invalid share offer");
  return offer;
}

export async function signOffer(offer: Offer, privateKey: CryptoKey) {
  const bytes = offerBytes(offer);
  return { bytes, digest: await digestBytes(bytes), signature: new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, privateKey, new Uint8Array(bytes))) };
}
export async function verifyOffer(bytes: Uint8Array, digest: Uint8Array, signature: Uint8Array,
  signerPublicKey: Uint8Array): Promise<Offer> {
  if (!(bytes instanceof Uint8Array) || bytes.length > 131072 ||
      !(digest instanceof Uint8Array) || digest.length !== 32 ||
      !(signature instanceof Uint8Array) || signature.length !== 64 ||
      !(signerPublicKey instanceof Uint8Array) || signerPublicKey.length !== 65) {
    throw new Error("invalid share offer");
  }
  // All four caller-owned byte arrays must be pinned before the first await. In
  // particular, return only the offer parsed from the bytes actually signed.
  const offerSnapshot = new Uint8Array(bytes);
  const digestSnapshot = new Uint8Array(digest);
  const signatureSnapshot = new Uint8Array(signature);
  const signerSnapshot = new Uint8Array(signerPublicKey);
  const parsed = parseOffer(offerSnapshot);
  if (!sameBytes(await digestBytes(offerSnapshot), digestSnapshot)) throw new Error("invalid share offer");
  const key = await crypto.subtle.importKey("raw", signerSnapshot,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key,
    signatureSnapshot, offerSnapshot)) throw new Error("invalid share offer");
  return parsed;
}

/** Server structural validation does not prove encrypted plaintext equality. */
export function inspectOfferEnvelope(bytes: Uint8Array, context: { purpose: "grant" | "share-root-label";
  vaultId: string; objectId: string; keyId: string; keyEpoch: number; revision: number; recipientId?: string },
  suite: typeof HPKE_SUITE | typeof SYMMETRIC_SUITE = HPKE_SUITE): void {
  const label = context?.purpose === "share-root-label";
  if (!context || (context.purpose !== "grant" && !label) ||
      !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > (label ? 4096 : 16384) ||
      !validId(context.vaultId) || !validId(context.objectId) || !validId(context.keyId) ||
      !positiveCounter(context.keyEpoch) || !positiveCounter(context.revision) ||
      (context.recipientId !== undefined && !validId(context.recipientId)) ||
      Object.keys(context).length !== (context.recipientId === undefined ? 6 : 7) ||
      (label && (context.keyEpoch !== 1 || context.revision !== 1)) ||
      (suite !== HPKE_SUITE && (!label || suite !== SYMMETRIC_SUITE)) ||
      (suite === HPKE_SUITE && !context.recipientId) ||
      (suite === SYMMETRIC_SUITE && context.recipientId !== undefined)) {
    throw new Error("invalid offer envelope");
  }
  const found = inspectEnvelope(bytes);
  if (found.suite !== suite || Object.keys(found.context).length !== Object.keys(context).length ||
      Object.entries(context).some(([key, value]) => found.context[key as keyof typeof found.context] !== value)) {
    throw new Error("invalid offer envelope");
  }
}

