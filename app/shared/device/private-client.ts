import { PUBLIC_PARTICIPATION_SUSPENDED } from "~/shared/security/public-participation";
import { signDeviceProof, type DeviceProof } from "./proof";
import { getDevice, type StoredDevice, updateRegistryEpoch } from "./store";

export type PrivateAccessState = "signed-out" | "unprovisioned" | "device-lost" | "stale" | "denied" | "unavailable";

export class PrivateAccessError extends Error {
  constructor(readonly state: PrivateAccessState) {
    super("private access unavailable");
  }
}

/**
 * A fixed application policy denial returned by a private route. It stays an
 * access error for every generic caller, but names the policy and its bounded
 * metadata so a participating surface can explain the exact restriction (for
 * example a Public-participation suspension) instead of a generic failure.
 */
export class PrivatePolicyError extends PrivateAccessError {
  constructor(
    readonly policy: string,
    readonly detail: { readonly suspendedUntil: number | null },
  ) {
    super("denied");
    this.name = "PrivatePolicyError";
  }
}

/** The one fixed policy denial a participating surface currently explains. */
export { PUBLIC_PARTICIPATION_SUSPENDED };

export function isPublicParticipationSuspended(error: unknown): error is PrivatePolicyError {
  return error instanceof PrivatePolicyError && error.policy === PUBLIC_PARTICIPATION_SUSPENDED;
}

/** Recognize only the fixed policy-denial body; every other 403 stays a
 * device-proof denial. The response body is cloned, never consumed. */
async function policyDenial(response: Response): Promise<PrivatePolicyError | null> {
  try {
    const body = (await response.clone().json()) as { error?: unknown; suspendedUntil?: unknown };
    if (body.error !== PUBLIC_PARTICIPATION_SUSPENDED) return null;
    const suspendedUntil =
      typeof body.suspendedUntil === "number" && Number.isSafeInteger(body.suspendedUntil) && body.suspendedUntil > 0
        ? body.suspendedUntil
        : null;
    return new PrivatePolicyError(PUBLIC_PARTICIPATION_SUSPENDED, { suspendedUntil });
  } catch {
    return null;
  }
}

type RegistryState = {
  accountId: string;
  deviceId: string | null;
  registryEpoch: number;
  sessionBinding: string;
};

/** Validate a `/api/device/state` answer or an `X-Mdwn-Device-State` header alike. */
function registryState(value: unknown): RegistryState | null {
  const state = value as Partial<RegistryState> | null;
  if (
    !state ||
    typeof state !== "object" ||
    typeof state.accountId !== "string" ||
    !state.accountId ||
    !Number.isSafeInteger(state.registryEpoch) ||
    state.registryEpoch! < 1 ||
    typeof state.sessionBinding !== "string" ||
    !state.sessionBinding ||
    (state.deviceId !== null && typeof state.deviceId !== "string")
  ) {
    return null;
  }
  return {
    accountId: state.accountId,
    deviceId: state.deviceId,
    registryEpoch: state.registryEpoch!,
    sessionBinding: state.sessionBinding,
  };
}

function sameState(a: RegistryState, b: RegistryState): boolean {
  return a.sessionBinding === b.sessionBinding && a.registryEpoch === b.registryEpoch && a.deviceId === b.deviceId;
}

/**
 * Settled device state an operation may sign with when it starts within
 * `REUSE_MS` of `at` (ticket 57). Memory only, never persisted. The Worker
 * still verifies every proof against the Session's current state, so reused
 * state that has gone stale fails closed and is retried once, below.
 */
const REUSE_MS = 10_000;
let reusable: { state: RegistryState; at: number } | null = null;
/** Bumped by every discard, so a read or header from before it never revives old state. */
let generation = 0;

/** Forget reusable device state. Call on sign-in, sign-out and recovery. */
export function discardDeviceState(): void {
  reusable = null;
  generation++;
}

/** Changes with every discard, so a caller keeping another per-Session fact
 * in memory (such as a finished background check) can tell it is outdated. */
export function deviceStateGeneration(): number {
  return generation;
}

function adopt(state: RegistryState, since: number) {
  if (generation === since && state.deviceId) reusable = { state, at: Date.now() };
}

function reusableState(): RegistryState | null {
  if (!reusable) return null;
  const age = Date.now() - reusable.at;
  return age >= 0 && age < REUSE_MS ? reusable.state : null;
}

type RegistryRead = { status: number; state: unknown };
const registryReads = new Map<AbortSignal | undefined, Promise<RegistryRead>>();

/**
 * Parallel operations in the same request lifetime share an in-flight read.
 * A new Router navigation has a new signal and must not inherit a cancelled
 * loader's Session binding: in-flight reads are never shared across signals.
 * Operations without a signal share only with other unscoped operations.
 */
function readRegistryState(signal?: AbortSignal): Promise<RegistryRead> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const pending = registryReads.get(signal);
  if (pending) return pending;
  const read = fetch("/api/device/state", { cache: "no-store", signal })
    .then(async (response) => ({ status: response.status, state: response.ok ? await response.json() : null }))
    .finally(() => {
      if (registryReads.get(signal) === read) registryReads.delete(signal);
    });
  registryReads.set(signal, read);
  return read;
}

/** A fresh, validated state read, then kept as reusable state. */
async function freshState(signal?: AbortSignal): Promise<RegistryState> {
  const since = generation;
  let read: RegistryRead;
  try {
    read = await readRegistryState(signal);
  } catch {
    throw new PrivateAccessError("unavailable");
  }
  if (read.status === 401) {
    discardDeviceState();
    throw new PrivateAccessError("signed-out");
  }
  const state = read.status >= 200 && read.status <= 299 ? registryState(read.state) : null;
  if (!state) throw new PrivateAccessError("unavailable");
  if (!signal?.aborted) adopt(state, since);
  return state;
}

/** The validated `X-Mdwn-Device-State` of a response for the same Account, or null. */
function responseState(response: Response, accountId: string): RegistryState | null {
  const header = response.headers.get("X-Mdwn-Device-State");
  if (header === null) return null;
  let state: RegistryState | null;
  try {
    state = registryState(JSON.parse(header));
  } catch {
    return null;
  }
  if (!state) return null;
  if (state.accountId !== accountId) {
    // This Session now belongs to another Account; never sign with the old one.
    discardDeviceState();
    return null;
  }
  return state.deviceId ? state : null;
}

type Signing = { state: RegistryState; device: StoredDevice };

/**
 * The local device that signs for `state`. Reused state older than the local
 * record's registry epoch is refreshed; freshly read state that is older is
 * `stale`. An epoch change refreshes only cached authority, never the
 * non-extractable device keys.
 */
async function signingDevice(state: RegistryState, reused: boolean, signal?: AbortSignal): Promise<Signing> {
  if (!state.deviceId) throw new PrivateAccessError("unprovisioned");
  let device = await getDevice(state.accountId);
  if (!device || device.deviceId !== state.deviceId) {
    discardDeviceState();
    throw new PrivateAccessError("device-lost");
  }
  if (device.registryEpoch > state.registryEpoch) {
    if (reused) return signingDevice(await freshState(signal), false, signal);
    throw new PrivateAccessError("stale");
  }
  if (device.registryEpoch < state.registryEpoch) {
    try {
      await updateRegistryEpoch(state.accountId, state.registryEpoch);
      device = await getDevice(state.accountId);
    } catch {
      throw new PrivateAccessError("device-lost");
    }
    if (!device || device.deviceId !== state.deviceId || device.registryEpoch !== state.registryEpoch) {
      throw new PrivateAccessError("device-lost");
    }
  }
  return { state, device };
}

type PrivateOptions = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: string | Uint8Array;
  signal?: AbortSignal;
};

/** Sign a new request-bound proof for `signing` and send the request once. */
async function send(url: URL, options: PrivateOptions, { state, device }: Signing): Promise<Response> {
  let proof: DeviceProof;
  try {
    proof = await signDeviceProof(device.assertionKeyPair.privateKey, {
      sessionBinding: state.sessionBinding,
      deviceId: state.deviceId!,
      registryEpoch: state.registryEpoch,
      method: options.method,
      url: url.href,
      body: options.body,
    });
  } catch {
    throw new PrivateAccessError("device-lost");
  }
  try {
    return await fetch(url.href, {
      method: options.method,
      body: options.body === undefined ? undefined : (options.body as BodyInit),
      signal: options.signal,
      headers: {
        "X-Mdwn-Device-Proof": JSON.stringify(proof),
        ...(options.body === undefined
          ? {}
          : { "Content-Type": typeof options.body === "string" ? "application/json" : "application/octet-stream" }),
      },
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new PrivateAccessError("unavailable");
  }
}

/** A private response with the Account and device its proof was bound to. */
export type PrivateExchange = { response: Response; accountId: string; device: StoredDevice };

/**
 * Fetch an authenticated private resource with a new, request-bound proof.
 * It signs with device state settled in the last few seconds, or reads it
 * first; each response returns the next state. A lost handle prevents the
 * request entirely; the caller renders enrollment/recovery UI.
 */
export async function privateRequest(path: string, options: PrivateOptions): Promise<Response> {
  return (await privateExchange(path, options)).response;
}

/** `privateRequest`, also returning the device whose proof the request carried. */
export async function privateExchange(path: string, options: PrivateOptions): Promise<PrivateExchange> {
  const url = new URL(path, location.origin);
  if (
    url.origin !== location.origin ||
    !url.pathname.startsWith("/api/") ||
    url.hash ||
    (options.method === "GET" && options.body !== undefined)
  ) {
    throw new PrivateAccessError("unavailable");
  }
  if (options.signal?.aborted) throw new PrivateAccessError("unavailable");

  const since = generation;
  const reused = reusableState();
  let signing = await signingDevice(reused ?? (await freshState(options.signal)), reused !== null, options.signal);
  let reusedSigning = reused !== null && signing.state === reused;
  for (let retried = false; ; retried = true) {
    const response = await send(url, options, signing);
    if (response.status === 401) {
      discardDeviceState();
      throw new PrivateAccessError("signed-out");
    }
    const current = responseState(response, signing.state.accountId);
    if (current) adopt(current, since);
    if (response.status !== 403) return { response, accountId: signing.state.accountId, device: signing.device };
    const policy = await policyDenial(response);
    if (policy) throw policy;
    // Retry a proof denial once, and only when the Session's current state
    // differs from the state this proof was signed with. The Worker verifies
    // every proof against the current Session binding, device and registry
    // epoch, and each mutation's commit predicate rechecks them, so a proof
    // signed with other state was refused before anything committed. A
    // same-state denial may follow a commit (a spent or expired Publication
    // proof, for example), so it is final, as is a second denial.
    const next = retried ? null : (current ?? (reusedSigning ? await freshState(options.signal) : null));
    if (!next || next.accountId !== signing.state.accountId || sameState(next, signing.state)) {
      if (!current && !(next && sameState(next, signing.state))) discardDeviceState();
      throw new PrivateAccessError("denied");
    }
    signing = await signingDevice(next, false, options.signal);
    reusedSigning = false;
  }
}
