import { useEffect, useRef } from "react";
import { Link, useFetcher } from "react-router";
import type { clientAction, clientLoader } from "~/routes/account-shared-access";
import { ShareIcon } from "~/ui/icons";

/** Visiting Files processes bounded passes through the route's browser action.
 * No worker queue, plaintext job state, custom fetch lifecycle, or SSR data. */
export function SharedProvisioning() {
  const fetcher = useFetcher<typeof clientLoader | typeof clientAction>();
  const started = useRef(false);
  const { load, submit, state, data } = fetcher;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // A no-work visit is a read, not an action that needlessly revalidates Files.
    void load("/account/shared-access");
  }, [load]);
  useEffect(() => {
    if (state !== "idle" || !data) return;
    const more = "available" in data ? data.ready && data.available : data.state === "ready" && !data.complete;
    if (!more) return;
    // The action returns current provisioning status itself. Background upkeep
    // must not reload Files and unmount an unsaved draft if that reload fails.
    const timer = setTimeout(() => {
      void submit({}, { method: "post", action: "/account/shared-access", defaultShouldRevalidate: false });
    }, 250);
    return () => clearTimeout(timer);
  }, [state, data, submit]);
  // The initial idle render precedes the first load; it is not a completed check.
  return (
    <section
      className="space-y-2 text-sm"
      aria-label="Shared access provisioning"
      aria-busy={state !== "idle" || data === undefined}
    >
      {data?.pending && (
        <p role="status" className="flex items-start gap-2 text-ink-soft">
          <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
          Shared content is being securely provisioned
        </p>
      )}
      {data && "state" in data && data.state === "failed" && (
        <p className="text-warning">Shared provisioning paused safely.</p>
      )}
      <Link to="/account/shared-access" className="flex items-center gap-2 text-ink-soft transition hover:text-ink">
        <ShareIcon className="text-muted" />
        Shared access
      </Link>
    </section>
  );
}
