import { useEffect, useState } from "react";
import { useNavigation } from "react-router";

/**
 * A thin accent bar while a route's loader runs, so a click is acknowledged at
 * once instead of the page appearing frozen. Purely visual: it carries no role
 * or live text, and a navigation shorter than its fade-in delay never shows it.
 */
export function NavigationProgress() {
  const busy = useNavigation().state !== "idle";
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  useEffect(() => {
    if (busy) {
      setState("loading");
      return;
    }
    setState((previous) => (previous === "loading" ? "done" : previous));
    const timer = setTimeout(() => setState("idle"), 400);
    return () => clearTimeout(timer);
  }, [busy]);
  return <div aria-hidden="true" className="navigation-progress" data-state={state} />;
}
