import { discardDeviceState } from "~/shared/device/private-client";
import { markSignedIn, markSignedOut } from "./session-presence";

/**
 * A completed authentication change: the header learns it without a request,
 * and private requests stop reusing the previous Session's device state
 * (ticket 57). Kept apart from `session-presence` so the public shell's
 * header does not load the private-request module.
 */
export function afterSignIn(): void {
  discardDeviceState();
  markSignedIn();
}

export function afterSignOut(): void {
  discardDeviceState();
  markSignedOut();
}
