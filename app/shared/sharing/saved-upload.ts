import { PrivateAccessError, privateRequest } from "~/shared/device/private-client";

type PutRequest = (path: string, init: { method: "PUT"; body: string; signal?: AbortSignal }) => Promise<Response>;

/**
 * Send saved envelope-packet bytes. An uncertain response (the request may
 * have committed) is retried once with the same bytes and a fresh Device
 * proof: never re-seal an HPKE envelope or restore its sender context or
 * nonce state for a retry. Shared-content provisioning and share preparation
 * both upload this way.
 */
export async function uploadSaved(
  path: string,
  body: string,
  signal?: AbortSignal,
  request: PutRequest = privateRequest,
): Promise<Response> {
  try {
    return await request(path, { method: "PUT", body, signal });
  } catch (error) {
    if (signal?.aborted || !(error instanceof PrivateAccessError && error.state === "unavailable")) throw error;
    return request(path, { method: "PUT", body, signal });
  }
}
