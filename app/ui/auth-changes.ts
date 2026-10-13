import { clearPrivateMemoryInAllTabs } from "~/shared/device/private-tab-memory";
import { markSignedIn, markSignedOut } from "./session-presence";

/**
 * A completed authentication change: the header learns it without a request,
 * and this tab and every other tab forget the previous Session's private
 * memory, its reusable device state and verified listings and keys (ticket
 * 57). Kept apart from `session-presence` so the public shell's header does
 * not load the private tab-memory module.
 */
export function afterSignIn(): void {
  clearPrivateMemoryInAllTabs();
  markSignedIn();
}

export function afterSignOut(): void {
  clearPrivateMemoryInAllTabs();
  markSignedOut();
}
