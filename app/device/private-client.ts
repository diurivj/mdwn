import { signDeviceProof } from "./proof";
import { getDevice, updateRegistryEpoch } from "./store";

export type PrivateAccessState = "signed-out" | "unprovisioned" | "device-lost" | "stale" | "denied" | "unavailable";

export class PrivateAccessError extends Error {
  constructor(readonly state: PrivateAccessState) {
    super("private access unavailable");
  }
}

type RegistryState = {
  accountId: string;
  deviceId: string | null;
  registryEpoch: number | null;
  sessionBinding: string;
};

/**
 * Fetch an authenticated private resource with a new, request-bound proof.
 * Registry state is read before every operation, so an epoch change refreshes
 * only cached authority, never the non-extractable device keys. A lost handle
 * prevents the request entirely; the caller renders enrollment/recovery UI.
 */
export async function privateRequest(
  path: string,
  options: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: string; signal?: AbortSignal },
): Promise<Response> {
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin || !url.pathname.startsWith("/api/") || url.hash ||
      (options.method === "GET" && options.body !== undefined)) {
    throw new PrivateAccessError("unavailable");
  }

  let state: RegistryState;
  try {
    const response = await fetch("/api/device/state", { cache: "no-store", signal: options.signal });
    if (response.status === 401) throw new PrivateAccessError("signed-out");
    if (!response.ok) throw new PrivateAccessError("unavailable");
    state = await response.json() as RegistryState;
  } catch (error) {
    if (error instanceof PrivateAccessError) throw error;
    throw new PrivateAccessError("unavailable");
  }
  if (!state || typeof state.accountId !== "string" || !state.accountId ||
      !Number.isSafeInteger(state.registryEpoch) || state.registryEpoch! < 1 ||
      typeof state.sessionBinding !== "string" || !state.sessionBinding ||
      (state.deviceId !== null && typeof state.deviceId !== "string")) {
    throw new PrivateAccessError("unavailable");
  }
  if (!state.deviceId) throw new PrivateAccessError("unprovisioned");

  let device = await getDevice(state.accountId);
  if (!device || device.deviceId !== state.deviceId) throw new PrivateAccessError("device-lost");
  if (device.registryEpoch > state.registryEpoch!) throw new PrivateAccessError("stale");
  if (device.registryEpoch < state.registryEpoch!) {
    try {
      await updateRegistryEpoch(state.accountId, state.registryEpoch!);
      device = await getDevice(state.accountId);
    } catch {
      throw new PrivateAccessError("device-lost");
    }
    if (!device || device.deviceId !== state.deviceId || device.registryEpoch !== state.registryEpoch) {
      throw new PrivateAccessError("device-lost");
    }
  }

  let proof;
  try {
    proof = await signDeviceProof(device.assertionKeyPair.privateKey, {
      sessionBinding: state.sessionBinding, deviceId: state.deviceId,
      registryEpoch: state.registryEpoch!, method: options.method, url: url.href,
      body: options.body,
    });
  } catch {
    throw new PrivateAccessError("device-lost");
  }
  try {
    const response = await fetch(url.href, {
      method: options.method, body: options.body, signal: options.signal,
      headers: { "X-Mdwn-Device-Proof": JSON.stringify(proof) },
      cache: "no-store", redirect: "error",
    });
    if (response.status === 401) throw new PrivateAccessError("signed-out");
    if (response.status === 403) throw new PrivateAccessError("denied");
    return response;
  } catch (error) {
    if (error instanceof PrivateAccessError) throw error;
    throw new PrivateAccessError("unavailable");
  }
}
