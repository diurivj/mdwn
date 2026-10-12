import { isPlainRecord } from "~/shared/plain-record";

/**
 * Private data this tab keeps in memory between operations (ticket 57):
 * reusable device state, verified Directory listings and keys, and any later
 * per-Session cache. Each holder registers how to forget itself, and
 * `clearPrivateTabMemory` forgets them all at once. Nothing here is ever
 * persisted or posted.
 *
 * Device state registers first (`private-client.ts`), so discarding it — on
 * sign-in, sign-out, recovery, enrollment, a private-access error, or an
 * Account, Session, device or registry change — clears every other holder
 * too, and clearing any holder through this entry point discards device state.
 *
 * Other tabs are told to clear on the `mdwn-private-memory` BroadcastChannel,
 * whose only message is `{ type: "clear" }`. A tab hears it as soon as any
 * holder registers, whether or not it ever loaded the tree.
 */
const holders = new Set<() => void>();
const listeners = new Set<(reason: ClearReason) => void>();
let hidden: HiddenWatch | null = null;
let channel: BroadcastChannel | null = null;

/** Why memory was cleared, for an open page that should show what is current again. */
export type ClearReason = "remote" | "expired";
const MEMORY_CHANNEL = "mdwn-private-memory";

/** Register a holder's clear function; the returned function unregisters it. */
export function registerPrivateTabMemory(clear: () => void): () => void {
  holders.add(clear);
  if (!hidden && typeof document !== "undefined") {
    hidden = clearWhenHidden(document, { clear: clearPrivateTabMemory, returned: () => notify("expired") });
  }
  openChannel();
  return () => {
    holders.delete(clear);
  };
}

/** The tab's memory channel, opened on first use in a page; Node tooling opens none. */
function openChannel(): BroadcastChannel | null {
  if (!channel && typeof window !== "undefined" && typeof BroadcastChannel === "function") {
    channel = new BroadcastChannel(MEMORY_CHANNEL);
    channel.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!parseMemoryMessage(event.data)) return;
      clearPrivateTabMemory();
      notify("remote");
    });
  }
  return channel;
}

/** Forget every holder's private data in this tab. */
export function clearPrivateTabMemory(): void {
  for (const clear of [...holders]) {
    try {
      clear();
    } catch {
      // One holder's failure must not keep another holder's data.
    }
  }
}

/** Forget private memory here and in every other tab, as after sign-in, sign-out or a key-rotation pass. */
export function clearPrivateMemoryInAllTabs(): void {
  clearPrivateTabMemory();
  try {
    openChannel()?.postMessage({ type: "clear" });
  } catch {
    // Other tabs then clear on their own next private-access error.
  }
}

/** Whether the tab is still hidden after its hidden-timeout clear: nothing may refill memory until it returns. */
export function privateTabMemorySuspended(): boolean {
  return hidden?.expired() ?? false;
}

/** Hear another tab's clear, or a return to this tab after the hidden-timeout clear. */
export function onPrivateTabMemoryCleared(listener: (reason: ClearReason) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(reason: ClearReason): void {
  for (const listener of [...listeners]) {
    try {
      listener(reason);
    } catch {
      // A listener's failure must not stop the others.
    }
  }
}

/** Strictly validate a received memory message: exactly `{ type: "clear" }`. */
export function parseMemoryMessage(value: unknown): { type: "clear" } | null {
  return isPlainRecord(value) && Object.keys(value).length === 1 && value.type === "clear" ? { type: "clear" } : null;
}

/** A tab hidden this long forgets its private memory. */
export const HIDDEN_CLEAR_MS = 10 * 60_000;

type VisibilitySource = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
type HiddenWatch = { stop(): void; expired(): boolean };

/**
 * Call `clear` once the page has stayed hidden for `HIDDEN_CLEAR_MS`, measured
 * from `visibilitychange`. Browsers throttle timers in background tabs, so a
 * return to the tab also clears when the timer has not fired yet. The page
 * stays expired until it is visible again, and `returned` then runs once.
 */
export function clearWhenHidden(page: VisibilitySource, on: { clear: () => void; returned: () => void }): HiddenWatch {
  let hiddenAt: number | null = null;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expire = () => {
    expired = true;
    on.clear();
  };
  const changed = () => {
    clearTimeout(timer);
    if (page.visibilityState === "hidden") {
      if (expired) return;
      hiddenAt ??= Date.now();
      timer = setTimeout(expire, Math.max(0, hiddenAt + HIDDEN_CLEAR_MS - Date.now()));
      return;
    }
    if (!expired && hiddenAt !== null && Date.now() - hiddenAt >= HIDDEN_CLEAR_MS) expire();
    hiddenAt = null;
    if (expired) {
      expired = false;
      on.returned();
    }
  };
  page.addEventListener("visibilitychange", changed);
  if (page.visibilityState === "hidden") changed();
  return {
    stop() {
      clearTimeout(timer);
      page.removeEventListener("visibilitychange", changed);
    },
    expired: () => expired,
  };
}
