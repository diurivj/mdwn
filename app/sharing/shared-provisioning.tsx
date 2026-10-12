import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { clientAction, clientLoader } from "~/routes/account-shared-access";
import { createUpkeepThrottle } from "~/shared/device/upkeep-throttle";
import { cx } from "~/ui/cx";
import { ShareIcon } from "~/ui/icons";

type Status = NonNullable<ReturnType<typeof useFetcher<typeof clientLoader | typeof clientAction>>["data"]>;

/**
 * Background upkeep starts at most once a minute per tab (ticket 57); the
 * explicit action on the Shared access page is never throttled. The last
 * status (booleans and counts only) is kept in memory so a remounted Files
 * page still shows it and continues a pass that reported more work. Both
 * reset with device state, so they never carry into another Session.
 */
const sharedUpkeep = createUpkeepThrottle<Status>();

/** Visiting Files processes bounded passes through the route's browser action.
 * No worker queue, plaintext job state, custom fetch lifecycle, or SSR data.
 * A caller that lists the Shared access page itself omits the link. */
export function SharedProvisioning({ link = true, className }: { link?: boolean; className?: string }) {
  const fetcher = useFetcher<typeof clientLoader | typeof clientAction>();
  const started = useRef(false);
  const [recent, setRecent] = useState(false);
  const { load, submit, state, data } = fetcher;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!sharedUpkeep.due()) {
      setRecent(true);
      return;
    }
    sharedUpkeep.start();
    // A no-work visit is a read, not an action that needlessly revalidates Files.
    void load("/account/shared-access");
  }, [load]);
  useEffect(() => {
    if (data) sharedUpkeep.remember(data);
  }, [data]);
  const status = data ?? (recent ? sharedUpkeep.status() : undefined);
  useEffect(() => {
    if (state !== "idle" || !status) return;
    const more =
      "available" in status ? status.ready && status.available : status.state === "ready" && !status.complete;
    if (!more) return;
    // The action returns current provisioning status itself. Background upkeep
    // must not reload Files and unmount an unsaved draft if that reload fails.
    const timer = setTimeout(() => {
      void submit({}, { method: "post", action: "/account/shared-access", defaultShouldRevalidate: false });
    }, 250);
    return () => clearTimeout(timer);
  }, [state, status, submit]);
  // The initial idle render precedes the first load; it is not a completed check.
  return (
    <section
      className={cx("space-y-2 text-sm", className)}
      aria-label="Shared access provisioning"
      aria-busy={state !== "idle" || (data === undefined && !recent)}
    >
      {status?.pending && (
        <p role="status" className="flex items-start gap-2 text-ink-soft">
          <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
          Shared content is being securely provisioned
        </p>
      )}
      {status && "state" in status && status.state === "failed" && (
        <p className="text-warning">Shared provisioning paused safely.</p>
      )}
      {link && (
        <Link to="/account/shared-access" className="flex items-center gap-2 text-ink-soft transition hover:text-ink">
          <ShareIcon className="text-muted" />
          Shared access
        </Link>
      )}
    </section>
  );
}
