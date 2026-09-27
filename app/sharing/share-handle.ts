export type ShareHandleLookupToken = `sh1:${string}`;

/** Derive the versioned exact-match lookup token for a share handle (without @). */
export async function deriveShareHandleLookupToken(handleWithoutAt: string): Promise<ShareHandleLookupToken> {
  if (typeof handleWithoutAt !== "string" || handleWithoutAt.length < 1 || handleWithoutAt.length > 64 ||
      /[^A-Za-z0-9_-]/.test(handleWithoutAt)) {
    throw new TypeError("Invalid share handle");
  }
  const canonical = handleWithoutAt.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const bytes = new TextEncoder().encode(`mdwn/share-handle-lookup/v1\0${canonical}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sh1:${btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}
