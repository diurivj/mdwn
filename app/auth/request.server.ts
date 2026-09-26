export class AuthRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: "bad_request" | "forbidden",
  ) {
    super(code);
  }
}

/**
 * SameSite=Lax is defense in depth. Cookie-authenticated mutations also need
 * an explicit origin check so cross-site forms and fetches fail closed.
 */
export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const expectedOrigin = new URL(request.url).origin;
  const fetchSite = request.headers.get("sec-fetch-site");

  if (origin !== expectedOrigin || fetchSite === "cross-site") {
    throw new AuthRequestError(403, "forbidden");
  }
}

/** Read-only POST resources accept no body without buffering an arbitrary upload. */
export async function hasEmptyBody(request: Request): Promise<boolean> {
  if (!request.body) return true;
  const reader = request.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return true;
      if (value.byteLength) return false;
    }
  } catch { return false; }
  finally { await reader.cancel(); }
}

/** WebAuthn JSON is bounded protocol input, never an arbitrary upload. */
export async function readAuthJsonText(request: Request): Promise<{ raw: string; value: unknown }> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    throw new AuthRequestError(400, "bad_request");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  const maxBytes = 64 * 1024;
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AuthRequestError(400, "bad_request");
  }

  const reader = request.body?.getReader();
  if (!reader) throw new AuthRequestError(400, "bad_request");

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new AuthRequestError(400, "bad_request");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) throw new AuthRequestError(400, "bad_request");

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { raw, value: JSON.parse(raw) as unknown };
  } catch {
    throw new AuthRequestError(400, "bad_request");
  }
}

export async function readAuthJson(request: Request): Promise<unknown> {
  return (await readAuthJsonText(request)).value;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
