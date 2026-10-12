import { PUBLIC_PARTICIPATION_SUSPENDED } from "~/shared/security/public-participation";
import { DEVICE_STATE_HEADER, type DeviceState, parseDeviceState } from "./device-state";
import { DEVICE_PROOF_REQUIRED } from "./proof-denials";
import { clearPrivateTabMemory, registerPrivateTabMemory } from "./private-tab-memory";
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

/** A 403's JSON body, read from a clone so the response stays unconsumed. */
async function denialBody(response: Response): Promise<{ error?: unknown; suspendedUntil?: unknown }> {
  try {
    const body: unknown = await response.clone().json();
    return body && typeof body === "object" ? (body as { error?: unknown; suspendedUntil?: unknown }) : {};
  } catch {
    return {};
  }
}

/** Recognize only the fixed policy-denial body; every other 403 stays a
 * device-proof denial. */
function policyDenial(body: { error?: unknown; suspendedUntil?: unknown }): PrivatePolicyError | null {
  if (body.error !== PUBLIC_PARTICIPATION_SUSPENDED) return null;
  const suspendedUntil =
    typeof body.suspendedUntil === "number" && Number.isSafeInteger(body.suspendedUntil) && body.suspendedUntil > 0
      ? body.suspendedUntil
      : null;
  return new PrivatePolicyError(PUBLIC_PARTICIPATION_SUSPENDED, { suspendedUntil });
}

function sameState(a: DeviceState, b: DeviceState): boolean {
  return a.sessionBinding === b.sessionBinding && a.registryEpoch === b.registryEpoch && a.deviceId === b.deviceId;
}

/**
 * Settled device state an operation may sign with when it starts within
 * `REUSE_MS` of `at` (ticket 57). Memory only, never persisted. The Worker
 * still verifies every proof against the Session's current state, so reused
 * state that has gone stale fails closed and is retried once, below.
 */
const REUSE_MS = 10_000;
let reusable: { state: DeviceState; at: number } | null = null;
/** The last adopted state, kept past the reuse window: a change in it is a Session, device or registry change. */
let settled: DeviceState | null = null;
/** Bumped by every discard, so a read or header from before it never revives old state. */
let generation = 0;

// Device state is the first private tab-memory holder: clearing tab memory
// discards it, and discarding it clears every other holder.
registerPrivateTabMemory(() => {
  reusable = null;
  settled = null;
  generation++;
});

/**
 * Forget reusable device state and, with it, all private tab memory such as
 * verified listings and keys. Call on sign-in, sign-out and recovery.
 */
export function discardDeviceState(): void {
  clearPrivateTabMemory();
}

/** Changes with every discard, so a caller keeping another per-Session fact
 * in memory (such as a finished background check) can tell it is outdated. */
export function deviceStateGeneration(): number {
  return generation;
}

/** The Account and Encryption device of the last adopted state, until the next discard. */
export function deviceStateScope(): { accountId: string; deviceId: string } | null {
  return settled?.deviceId ? { accountId: settled.accountId, deviceId: settled.deviceId } : null;
}

/**
 * The one way a private-access error is raised: this Session, device or
 * registry can no longer open what the tab remembers, so all private tab
 * memory is cleared first. A temporary failure (`unavailable`) never is.
 */
export function loseAccess(state: Exclude<PrivateAccessState, "unavailable">): never {
  clearPrivateTabMemory();
  throw new PrivateAccessError(state);
}

function adopt(state: DeviceState, generationAtStart: number) {
  if (generation !== generationAtStart) return;
  // A Session with no Encryption device can open nothing remembered.
  if (!state.deviceId) {
    clearPrivateTabMemory();
    return;
  }
  // A different Account, Session, device or registry epoch makes everything
  // this tab remembers outdated; the new state itself is still the current one.
  if (settled && (settled.accountId !== state.accountId || !sameState(settled, state))) clearPrivateTabMemory();
  settled = state;
  reusable = { state, at: Date.now() };
}

function reusableState(): DeviceState | null {
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
function readDeviceState(signal?: AbortSignal): Promise<RegistryRead> {
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
async function freshState(signal?: AbortSignal): Promise<DeviceState> {
  const generationAtStart = generation;
  let read: RegistryRead;
  try {
    read = await readDeviceState(signal);
  } catch {
    throw new PrivateAccessError("unavailable");
  }
  if (read.status === 401) loseAccess("signed-out");
  const state = read.status >= 200 && read.status <= 299 ? parseDeviceState(read.state) : null;
  if (!state) throw new PrivateAccessError("unavailable");
  if (!signal?.aborted) adopt(state, generationAtStart);
  return state;
}

/** The validated `X-Mdwn-Device-State` of a response for the same Account, or null. */
function responseState(response: Response, accountId: string): DeviceState | null {
  const header = response.headers.get(DEVICE_STATE_HEADER);
  if (header === null) return null;
  let state: DeviceState | null;
  try {
    state = parseDeviceState(JSON.parse(header));
  } catch {
    return null;
  }
  if (!state) return null;
  if (state.accountId !== accountId) {
    // This Session now belongs to another Account; never sign with the old one.
    discardDeviceState();
    return null;
  }
  if (!state.deviceId) {
    // The Session now has no Encryption device, exactly as a state read naming none.
    clearPrivateTabMemory();
    return null;
  }
  return state;
}

type Signing = { state: DeviceState; device: StoredDevice };

/**
 * The local device that signs for `state`. Reused state older than the local
 * record's registry epoch is refreshed; freshly read state that is older is
 * `stale`. An epoch change refreshes only cached authority, never the
 * non-extractable device keys.
 */
async function signingDevice(state: DeviceState, reused: boolean, signal?: AbortSignal): Promise<Signing> {
  if (!state.deviceId) loseAccess("unprovisioned");
  let device = await getDevice(state.accountId);
  if (!device || device.deviceId !== state.deviceId) loseAccess("device-lost");
  if (device.registryEpoch > state.registryEpoch) {
    if (reused) return signingDevice(await freshState(signal), false, signal);
    loseAccess("stale");
  }
  if (device.registryEpoch < state.registryEpoch) {
    try {
      await updateRegistryEpoch(state.accountId, state.registryEpoch);
      device = await getDevice(state.accountId);
    } catch {
      loseAccess("device-lost");
    }
    if (!device || device.deviceId !== state.deviceId || device.registryEpoch !== state.registryEpoch) {
      loseAccess("device-lost");
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
    loseAccess("device-lost");
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

  const generationAtStart = generation;
  const reused = reusableState();
  let signing = await signingDevice(reused ?? (await freshState(options.signal)), reused !== null, options.signal);
  let reusedSigning = reused !== null && signing.state === reused;
  for (let retried = false; ; retried = true) {
    const response = await send(url, options, signing);
    if (response.status === 401) loseAccess("signed-out");
    const current = responseState(response, signing.state.accountId);
    if (current) adopt(current, generationAtStart);
    if (response.status !== 403) return { response, accountId: signing.state.accountId, device: signing.device };
    const body = await denialBody(response);
    const policy = policyDenial(body);
    if (policy) throw policy;
    const next = await denialOutcome(body, signing.state, current, { retried, reusedSigning }, options.signal);
    signing = await signingDevice(next, false, options.signal);
    reusedSigning = false;
  }
}

/**
 * The whole rule for a proof denial (`403` that is not a named policy
 * denial): the state to retry with once, or the final error.
 *
 * - Only `DEVICE_PROOF_REQUIRED` is retried — the request committed nothing —
 *   and only once, when the Session's current state differs from the state
 *   the proof was signed with (Session binding, registry epoch or device).
 *   One retry with demonstrably different state cannot apply a change twice.
 *   The current state is the denial's own header or, when the request was
 *   signed with reused state and the denial carries none, a fresh read
 *   (whose `401` means the Session is gone: signed out).
 * - A final `DEVICE_PROOF_REQUIRED` denial means this device cannot sign for
 *   the Session: a private-access error, which clears tab memory.
 * - Any other denial (`DEVICE_PROOF_SPENT`, or an unknown body) is final and
 *   only stops reusing state that no current state for the Account confirmed.
 */
async function denialOutcome(
  body: { error?: unknown },
  signing: DeviceState,
  current: DeviceState | null,
  attempt: { retried: boolean; reusedSigning: boolean },
  signal?: AbortSignal,
): Promise<DeviceState> {
  if (body.error !== DEVICE_PROOF_REQUIRED) {
    if (!current) reusable = null;
    throw new PrivateAccessError("denied");
  }
  if (attempt.retried) loseAccess("denied");
  const state = current ?? (attempt.reusedSigning ? await freshState(signal) : null);
  if (!state || state.accountId !== signing.accountId || sameState(state, signing)) loseAccess("denied");
  return state;
}
