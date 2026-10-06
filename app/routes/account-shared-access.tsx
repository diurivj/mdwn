import { Link, useFetcher } from "react-router";
import { readNextProvisioning, resumeGrantProvisioning } from "~/shared/sharing/provisioning-client";
import type { Route } from "./+types/account-shared-access";

export function meta() {
  return [{ title: "Shared access — mdwn" }];
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  try {
    const next = await readNextProvisioning(request.signal);
    return { ready: true, available: next.item !== null || !!next.expirationPending, pending: next.pending };
  } catch (error) {
    if (request.signal.aborted) throw error;
    return { ready: false, available: false, pending: false };
  }
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  try {
    return { state: "ready" as const, ...(await resumeGrantProvisioning({ signal: request.signal })) };
  } catch (error) {
    if (request.signal.aborted) throw error;
    return { state: "failed" as const, complete: false, pending: false, processed: 0 };
  }
}

export function HydrateFallback() {
  return (
    <main className="mx-auto max-w-xl px-4 py-12" role="status">
      Checking shared access…
    </main>
  );
}

export default function SharedAccess({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof clientAction>();
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <Link to="/account/device-access" className="underline">
        Files access
      </Link>
      <h1 className="mt-8 text-2xl font-semibold">Shared access</h1>
      <p className="mt-4">
        An authorized browser securely provisions current shared capabilities to enrolled devices. You can leave and
        resume later.
      </p>
      {loaderData.pending && (
        <p className="mt-4" role="status">
          Shared content is being securely provisioned
        </p>
      )}
      {loaderData.ready ? (
        <fetcher.Form method="post" className="mt-4">
          <button disabled={fetcher.state !== "idle"} className="rounded border px-3 py-2">
            Provision shared content
          </button>
        </fetcher.Form>
      ) : (
        <p role="alert">Use an enrolled device to check shared access.</p>
      )}
      {fetcher.data?.state === "ready" && (
        <p role="status" className="mt-4">
          {fetcher.data.complete
            ? "Shared access pass complete. Unavailable capabilities still wait for an authorized source browser."
            : "Progress saved. Resume to process the next bounded batch."}
        </p>
      )}
      {fetcher.data?.state === "failed" && (
        <p role="alert" className="mt-4">
          Provisioning paused safely. Refresh and resume from an authorized enrolled device.
        </p>
      )}
    </main>
  );
}
