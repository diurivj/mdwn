export type AuthFailure = "signed-out" | "restricted" | "failed";

export class AuthClientError extends Error {
  constructor(readonly state: AuthFailure) {
    super("authentication request failed");
  }
}

/** Classify resource-route failures once, without assuming every failed assertion expires a Session. */
export async function authJson<T>(
  response: Response,
  unauthorized: "signed-out" | "failed" = "signed-out",
): Promise<T> {
  if (response.status === 401) throw new AuthClientError(unauthorized);
  if (response.status === 403) throw new AuthClientError("restricted");
  if (!response.ok) throw new AuthClientError("failed");
  return response.json() as Promise<T>;
}

export function authFailure(error: unknown, signal: AbortSignal): AuthFailure {
  if (signal.aborted) throw error;
  return error instanceof AuthClientError ? error.state : "failed";
}

export async function authGet<T>(path: string, signal: AbortSignal): Promise<T> {
  return authJson<T>(await fetch(path, { signal }));
}

export async function authPost<T>(
  path: string,
  body: object,
  signal: AbortSignal,
  unauthorized: "signed-out" | "failed" = "signed-out",
): Promise<T> {
  return authJson<T>(await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  }), unauthorized);
}
