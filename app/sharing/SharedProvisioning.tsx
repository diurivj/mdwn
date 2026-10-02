import { useEffect, useRef } from "react";
import { Link, useFetcher } from "react-router";
import type { clientAction, clientLoader } from "~/routes/account-shared-access";

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
    const timer = setTimeout(() => { void submit({}, { method: "post", action: "/account/shared-access" }); }, 250);
    return () => clearTimeout(timer);
  }, [state, data, submit]);
  return <div className="mt-4 text-sm">
    {data?.pending && <p role="status">Shared content is being securely provisioned</p>}
    {data && "state" in data && data.state === "failed" && <p>Shared provisioning paused safely.</p>}
    <Link to="/account/shared-access" className="underline">Shared access</Link>
  </div>;
}
