import { useSyncExternalStore } from "react";

/**
 * Whether this browser currently has a Session, for choosing navigation only.
 * It reads the boolean `/api/auth/session` answer once after hydration, when
 * the tab regains focus or becomes visible, and after authentication changes;
 * not on every navigation (ticket 57). It never reads Account data, so the
 * server-rendered shell stays identical for every visitor. Every private page
 * still authorizes its own requests.
 */
export type SessionPresence = "unknown" | "signed-in" | "signed-out";

let presence: SessionPresence = "unknown";
let pending: Promise<void> | null = null;
let revision = 0;
let hydrated = false;
const listeners = new Set<() => void>();

function publish(next: SessionPresence) {
  if (presence === next) return;
  presence = next;
  for (const listener of listeners) listener();
}

/** Re-read the Session boolean; call after signing in, out or recovering. */
export function refreshSessionPresence(): Promise<void> {
  if (pending) return pending;
  const startedAt = revision;
  const read: Promise<void> = fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" })
    .then(async (response) => {
      if (!response.ok) return; // A transient service failure does not mean signed out.
      const body = (await response.json()) as { authenticated?: unknown };
      // A completed authentication change is newer authority than this read,
      // even if its response was held in the network until after sign-out.
      if (revision === startedAt) publish(body?.authenticated === true ? "signed-in" : "signed-out");
    })
    .catch(() => {
      // Offline or interrupted: keep the last known navigation.
    })
    .finally(() => {
      if (pending === read) pending = null;
    });
  pending = read;
  return read;
}

function invalidateRead() {
  revision++;
  pending = null;
}

/** A completed sign-in or sign-out needs no request to know the answer.
 * Routes call these through `auth-changes`, which also discards device state. */
export function markSignedIn() {
  invalidateRead();
  publish("signed-in");
}

export function markSignedOut() {
  invalidateRead();
  publish("signed-out");
}

function refreshOnReturn() {
  if (document.visibilityState !== "visible") return;
  // Another tab may have changed the cookie while this tab was away. Supersede
  // any earlier read rather than let its old answer win after returning.
  invalidateRead();
  void refreshSessionPresence();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
  }
  // The first subscriber after hydration reads once. A later layout that
  // remounts the header keeps the known answer; focus and visibility returns
  // pick up another tab's change.
  if (!hydrated) {
    hydrated = true;
    void refreshSessionPresence();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    }
  };
}

export function useSessionPresence(): SessionPresence {
  return useSyncExternalStore(
    subscribe,
    () => presence,
    () => "unknown" as const,
  );
}
