/** Optional share handles use exact ASCII case-insensitive equality, never search.
 * No trimming, prefix matching, or fuzzy repair. Only this domain-separated
 * SHA-256 lookup token is stored in accounts; the handle is not an auth identity.
 */
export async function shareHandleLookupToken(handle: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(handle)) throw new Error("invalid_share_handle");
  const normalized = handle.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`mdwn/share-handle/v1\u0000${normalized}`)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
