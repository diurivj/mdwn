const MIN_HMAC_KEY_BYTES = 32;

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export class InvalidEdgeAddressError extends Error {
  constructor() {
    super("invalid edge address");
    this.name = "InvalidEdgeAddressError";
  }
}

function parseIPv4(value: string): string[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets.map(String);
}

function parseIPv6(value: string): number[] | null {
  if (!value.includes(":") || value.includes("%")) return null;

  let address = value.toLowerCase();
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    if (lastColon < 0) return null;
    const ipv4 = parseIPv4(address.slice(lastColon + 1));
    if (!ipv4) return null;
    const first = (Number(ipv4[0]) << 8) | Number(ipv4[1]);
    const second = (Number(ipv4[2]) << 8) | Number(ipv4[3]);
    address = `${address.slice(0, lastColon + 1)}${first.toString(16)}:${second.toString(16)}`;
  }

  const compressed = address.includes("::");
  if (compressed && address.indexOf("::") !== address.lastIndexOf("::")) return null;

  const halves = compressed ? address.split("::") : [address];
  const left = halves[0] ? halves[0].split(":") : [];
  const right = compressed && halves[1] ? halves[1].split(":") : [];
  const parts = [...left, ...right];
  if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;

  const words = parts.map((part) => Number.parseInt(part, 16));
  if (compressed) {
    const zerosToInsert = 8 - words.length;
    if (zerosToInsert < 1) return null;
    return [
      ...words.slice(0, left.length),
      ...Array<number>(zerosToInsert).fill(0),
      ...words.slice(left.length),
    ];
  }
  return words.length === 8 ? words : null;
}

/** Normalize a trusted Cloudflare edge address without retaining it. */
export function normalizeEdgeIp(input: string): string {
  const value = input.trim();
  const ipv4 = parseIPv4(value);
  if (ipv4) return ipv4.join(".");

  const words = parseIPv6(value);
  if (!words) throw new InvalidEdgeAddressError();

  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < words.length;) {
    if (words[start] !== 0) {
      start++;
      continue;
    }
    let end = start;
    while (end < words.length && words[end] === 0) end++;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }

  const encoded = words.map((word) => word.toString(16));
  if (bestStart < 0) return encoded.join(":");
  const left = encoded.slice(0, bestStart).join(":");
  const right = encoded.slice(bestStart + bestLength).join(":");
  return `${left}::${right}`;
}

/**
 * Return a purpose- and time-epoch-scoped HMAC identifier, never the address.
 * Callers must pass an epoch broad enough to cover a policy window and must
 * check every live overlapping epoch when a window crosses rotation.
 */
export async function deriveNetworkBucket(
  edgeIp: string,
  purpose: string,
  timeEpoch: number,
  secret: string,
): Promise<string> {
  const keyBytes = new TextEncoder().encode(secret);
  if (!purpose || !Number.isSafeInteger(timeEpoch) || timeEpoch < 0 || keyBytes.length < MIN_HMAC_KEY_BYTES) {
    throw new Error("abuse-control key unavailable");
  }

  const normalizedIp = normalizeEdgeIp(edgeIp);
  return signBucket(keyBytes, "network", normalizedIp, purpose, timeEpoch);
}

/** Pseudonymize scope keys that must not persist verbatim (Session/recovery IDs). */
export async function deriveOpaqueScopeBucket(
  scope: "session" | "recovery_identifier" | "account_publication",
  value: string,
  purpose: string,
  timeEpoch: number,
  secret: string,
): Promise<string> {
  const keyBytes = new TextEncoder().encode(secret);
  if (
    !value || value.length > 1024 || !purpose
    || !Number.isSafeInteger(timeEpoch) || timeEpoch < 0
    || keyBytes.length < MIN_HMAC_KEY_BYTES
  ) {
    throw new Error("abuse-control key unavailable");
  }
  return signBucket(keyBytes, scope, value, purpose, timeEpoch);
}

async function signBucket(
  keyBytes: Uint8Array,
  scope: string,
  value: string,
  purpose: string,
  timeEpoch: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    copyToArrayBuffer(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = new TextEncoder().encode(`${scope}\u0000${purpose}\u0000${timeEpoch}\u0000${value}`);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, copyToArrayBuffer(message)));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${scope}:${hex}`;
}
