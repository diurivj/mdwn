import { useEffect, useSyncExternalStore } from "react";
import { useLocation } from "react-router";

/**
 * Whether this browser currently has a Session, for choosing navigation only.
 * It reads the boolean `/api/auth/session` answer after hydration, never Account
 * data, so the server-rendered shell stays identical for every visitor. Every
 * private page still authorizes its own requests.
 */
export type SessionPresence = "unknown" | "signed-in" | "signed-out";

let presence: SessionPresence = "unknown";
let pending: Promise<void> | null = null;
let revision = 0;
let locationKey: string | undefined;
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

/** A completed sign-in or sign-out needs no request to know the answer. */
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
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      locationKey = undefined;
      invalidateRead();
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    }
  };
}

export function useSessionPresence(): SessionPresence {
  const { key } = useLocation();
  const value = useSyncExternalStore(
    subscribe,
    () => presence,
    () => "unknown" as const,
  );
  useEffect(() => {
    // A new location must not join a read from before another tab changed the
    // cookie. Header and Account subscribers at the same location still share.
    if (locationKey !== key) {
      locationKey = key;
      invalidateRead();
    }
    void refreshSessionPresence();
  }, [key]);
  return value;
}
