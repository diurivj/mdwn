/**
 * Private data this tab keeps in memory between operations (ticket 57):
 * reusable device state, verified Directory listings and keys, and any later
 * per-Session cache. Each holder registers how to forget itself, and
 * `clearPrivateTabMemory` forgets them all at once. Nothing here is ever
 * persisted or posted.
 *
 * Device state registers first (`private-client.ts`), so discarding it — on
 * sign-in, sign-out, recovery, enrollment, a `401`, or an Account, device or
 * registry change — clears every other holder too, and clearing any holder
 * through this entry point discards device state.
 */
const holders = new Set<() => void>();
let watching = false;

/** Register a holder's clear function; the returned function unregisters it. */
export function registerPrivateTabMemory(clear: () => void): () => void {
  holders.add(clear);
  if (!watching && typeof document !== "undefined") {
    watching = true;
    clearWhenHidden(document, clearPrivateTabMemory);
  }
  return () => {
    holders.delete(clear);
  };
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

/** A tab hidden this long forgets its private memory. */
export const HIDDEN_CLEAR_MS = 10 * 60_000;

type VisibilitySource = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

/**
 * Call `clear` once the page has stayed hidden for `HIDDEN_CLEAR_MS`, measured
 * from `visibilitychange`. Browsers throttle timers in background tabs, so a
 * return to the tab also clears when the timer has not fired yet.
 */
export function clearWhenHidden(page: VisibilitySource, clear: () => void): () => void {
  let hiddenAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expire = () => {
    hiddenAt = null;
    clear();
  };
  const changed = () => {
    clearTimeout(timer);
    if (page.visibilityState === "hidden") {
      hiddenAt ??= Date.now();
      timer = setTimeout(expire, Math.max(0, hiddenAt + HIDDEN_CLEAR_MS - Date.now()));
    } else if (hiddenAt !== null) {
      const expired = Date.now() - hiddenAt >= HIDDEN_CLEAR_MS;
      hiddenAt = null;
      if (expired) clear();
    }
  };
  page.addEventListener("visibilitychange", changed);
  if (page.visibilityState === "hidden") changed();
  return () => {
    clearTimeout(timer);
    page.removeEventListener("visibilitychange", changed);
  };
}
