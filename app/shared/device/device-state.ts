/**
 * The device state a Session's private requests are signed with: the
 * `/api/device/state` fields, also returned with every proof-guarded response
 * in `X-Mdwn-Device-State` (ticket 57). Shared by the Worker, which writes the
 * header, and the browser, which validates both forms alike.
 */
export const DEVICE_STATE_HEADER = "X-Mdwn-Device-State";

export type DeviceState = {
  accountId: string;
  deviceId: string | null;
  registryEpoch: number;
  sessionBinding: string;
};

/** The compact header value, with exactly these four fields. */
export function encodeDeviceState(state: DeviceState): string {
  return JSON.stringify({
    accountId: state.accountId,
    deviceId: state.deviceId,
    registryEpoch: state.registryEpoch,
    sessionBinding: state.sessionBinding,
  });
}

/** Validate a `/api/device/state` answer or a parsed header; anything else is null. */
export function parseDeviceState(value: unknown): DeviceState | null {
  const state = value as Partial<DeviceState> | null;
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
