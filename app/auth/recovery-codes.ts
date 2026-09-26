import { encodeBytes } from "~/signup/protocol";

const encoder = new TextEncoder();

/** Authentication recovery codes are 192 random bits; only their hashes reach D1. */
export async function prepareRecoveryCodeSet(): Promise<{ codes: string[]; hashes: string[] }> {
  const codes = Array.from({ length: 10 }, () =>
    encodeBytes(crypto.getRandomValues(new Uint8Array(24))));
  const hashes = await Promise.all(codes.map(async (code) =>
    encodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(code))))));
  return { codes, hashes };
}
