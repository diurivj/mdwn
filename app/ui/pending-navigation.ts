import { useEffect, useState } from "react";
import { type Location, useNavigation } from "react-router";

/** Placeholders wait this long, so a navigation too quick to notice never flashes one. */
export const PLACEHOLDER_DELAY_MS = 90;

/**
 * Where a link navigation is going while its loaders run. Form submissions,
 * their redirects and revalidations are not destinations to preview: their
 * pages own their own progress.
 */
export function usePendingLocation(): Location | null {
  const navigation = useNavigation();
  return navigation.state === "loading" && navigation.formMethod === undefined ? navigation.location : null;
}

/** True once `active` has stayed true for `delay` milliseconds. */
export function useDelayedFlag(active: boolean, delay = PLACEHOLDER_DELAY_MS): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    setElapsed(false);
    if (!active) return;
    const timer = setTimeout(() => setElapsed(true), delay);
    return () => clearTimeout(timer);
  }, [active, delay]);
  return active && elapsed;
}
