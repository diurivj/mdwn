/** Canonical device possession statements shared by the browser and Worker. */
import { decodeBytes, encodeBytes } from "~/signup/protocol";

const encoder = new TextEncoder();
const MAX_PROOF_AGE_MS = 5 * 60_000;

export type DeviceProof = {
  sessionBinding: string;
  deviceId: string;
  registryEpoch: number;
  method: string;
  path: string;
  bodyDigest: string;
  issuedAt: number;
  expiresAt: number;
  proofId: string;
  signature: string;
};

type UnsignedProof = Omit<DeviceProof, "signature">;

export async function digestBody(body: string): Promise<string> {
  return encodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(body))));
}

export async function sessionBindingDigest(sessionId: string): Promise<string> {
  return digestBody(`mdwn/session-binding/v1\0${sessionId}`);
}

/** The query is sorted and normalized, with fragments excluded. */
export function canonicalPath(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.sort();
  const search = parsed.searchParams.toString();
  return `${parsed.pathname}${search ? `?${search}` : ""}`;
}

function statement(proof: UnsignedProof): Uint8Array {
  return encoder.encode(JSON.stringify([
    "mdwn/device-proof/v1", proof.sessionBinding, proof.deviceId,
    proof.registryEpoch, proof.method, proof.path, proof.bodyDigest,
    proof.issuedAt, proof.expiresAt, proof.proofId,
  ]));
}

export async function signDeviceProof(
  privateKey: CryptoKey,
  input: {
    sessionBinding: string;
    deviceId: string;
    registryEpoch: number;
    method: string;
    url: string;
    body?: string;
    now?: number;
  },
): Promise<DeviceProof> {
  if (privateKey.type !== "private" || privateKey.extractable ||
      privateKey.algorithm.name !== "ECDSA") throw new Error("device key unavailable");
  const issuedAt = input.now ?? Date.now();
  const proof: UnsignedProof = {
    sessionBinding: input.sessionBinding,
    deviceId: input.deviceId,
    registryEpoch: input.registryEpoch,
    method: input.method.toUpperCase(),
    path: canonicalPath(input.url),
    bodyDigest: await digestBody(input.body ?? ""),
    issuedAt,
    expiresAt: issuedAt + MAX_PROOF_AGE_MS,
    proofId: crypto.randomUUID(),
  };
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new Uint8Array(statement(proof)));
  return { ...proof, signature: encodeBytes(new Uint8Array(signature)) };
}

export async function verifyDeviceProof(
  proof: unknown,
  publicKeyBytes: Uint8Array,
  expected: {
    sessionBinding: string;
    deviceId: string;
    registryEpoch: number;
    method: string;
    url: string;
    body?: string;
    now?: number;
  },
): Promise<boolean> {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false;
  const data = proof as Record<string, unknown>;
  const now = expected.now ?? Date.now();
  if (Object.keys(data).sort().join(",") !==
    "bodyDigest,deviceId,expiresAt,issuedAt,method,path,proofId,registryEpoch,sessionBinding,signature" ||
    typeof data.signature !== "string" || data.signature.length > 100 ||
    typeof data.proofId !== "string" || !/^[0-9a-f-]{36}$/.test(data.proofId) ||
    !Number.isSafeInteger(data.issuedAt) || !Number.isSafeInteger(data.expiresAt) ||
    (data.issuedAt as number) > now || (data.expiresAt as number) <= now ||
    (data.expiresAt as number) <= (data.issuedAt as number) ||
    (data.expiresAt as number) - (data.issuedAt as number) > MAX_PROOF_AGE_MS ||
    data.sessionBinding !== expected.sessionBinding || data.deviceId !== expected.deviceId ||
    data.registryEpoch !== expected.registryEpoch || data.method !== expected.method.toUpperCase() ||
    data.path !== canonicalPath(expected.url) || data.bodyDigest !== await digestBody(expected.body ?? "")) {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey(
      "raw", new Uint8Array(publicKeyBytes), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key,
      decodeBytes(data.signature as string, 64), new Uint8Array(statement(data as UnsignedProof)),
    );
  } catch {
    return false;
  }
}
