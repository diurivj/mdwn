import { Link, useFetcher } from "react-router";
import { PrivateAccessError, privateRequest } from "~/device/private-client";
import { resumeKeyRotation } from "~/sharing/rotation-client";
import type { RotationJob } from "~/sharing/rotation-wire";
import { isV7 } from "~/tree/wire";
import type { Route } from "./+types/account-key-rotations";

export function meta() { return [{ title: "Secure access updates — mdwn" }]; }

/** Job identities/progress and all cryptography remain in browser-only data APIs. */
export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const cursor = new URL(request.url).searchParams.get("cursor");
  try {
    if (cursor !== null && !isV7(cursor)) throw new Error("Invalid cursor");
    const response = await privateRequest(`/api/private/key-rotations${cursor ? `?cursor=${cursor}` : ""}`, { method: "POST", signal: request.signal });
    if (!response.ok) throw new Error("Updates unavailable");
    const page = await response.json() as { jobs: RotationJob[]; nextCursor: string | null };
    return { state: "ready" as const, ...page };
  } catch (error) {
    if (request.signal.aborted) throw error;
    return { state: error instanceof PrivateAccessError ? error.state : "failed", jobs: [], nextCursor: null };
  }
}

/** A fetcher submission runs one bounded browser pass, then native revalidation
 * reloads stored progress. Navigating away never unseals an unfinished job. */
export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData(), jobId = form.get("jobId");
  if (!isV7(jobId)) return { state: "failed" as const };
  try {
    const complete = await resumeKeyRotation(jobId, { signal: request.signal });
    return { state: complete ? "complete" as const : "paused" as const };
  } catch (error) {
    if (request.signal.aborted) throw error;
    return { state: "failed" as const };
  }
}

export function HydrateFallback() {
  return <main className="mx-auto max-w-xl px-4 py-12" role="status">Loading secure access updates…</main>;
}

function Update({ job }: { job: RotationJob }) {
  const fetcher = useFetcher<typeof clientAction>();
  const busy = fetcher.state !== "idle";
  return <li className="rounded-md border border-stone-200 bg-white p-4">
    <p>{job.progress} {job.progress === 1 ? "capability updated" : "capabilities updated"}</p>
    <fetcher.Form method="post" className="mt-3">
      <input type="hidden" name="jobId" value={job.jobId} />
      <button type="submit" disabled={busy || job.runnable === false} className="rounded-md border border-stone-300 px-3 py-2 disabled:opacity-60">
        {busy ? "Updating secure access…" : "Resume update"}
      </button>
    </fetcher.Form>
    {job.runnable === false && <p className="mt-3 text-sm">Queued. Finish the earlier affected folder update first.</p>}
    {fetcher.data?.state === "paused" && <p role="status" className="mt-3 text-sm">Progress saved. Resume to continue the next bounded batch.</p>}
    {fetcher.data?.state === "failed" && <p role="alert" className="mt-3 text-sm">The update paused safely. Refresh and resume from an enrolled Owner device. Writes remain blocked until the update finishes.</p>}
  </li>;
}

export default function KeyRotations({ loaderData }: Route.ComponentProps) {
  return <main className="mx-auto max-w-xl px-4 py-12">
    <Link to="/" className="text-sm underline">mdwn</Link>
    <h1 className="mt-8 text-2xl font-semibold">Secure access updates</h1>
    <p className="mt-3 text-sm">Removed permissions take effect immediately. New writes beneath affected Files and folders wait until their secure access update finishes.</p>
    <p className="mt-3 text-sm">This cannot recall previously downloaded plaintext, ciphertext, or keys.</p>
    <p className="mt-3 text-sm">You can leave and resume from another enrolled Owner device. No plaintext keys or content are stored in the job.</p>
    <p className="mt-3 text-sm">Expired Shares must finish <Link to="/account/shared-access" className="underline">shared access cleanup</Link> before queued updates can resume.</p>
    {loaderData.state === "ready" ? <>
      {loaderData.jobs.length ? <ul className="mt-6 space-y-3">{loaderData.jobs.map((job) => <Update key={job.jobId} job={job} />)}</ul>
        : <p role="status" className="mt-6">No secure access updates are waiting.</p>}
      {loaderData.nextCursor && <Link to={`?cursor=${loaderData.nextCursor}`} className="mt-5 block underline">More updates</Link>}
    </> : <p role="alert" className="mt-6">Use an enrolled Owner device to load and resume secure access updates.</p>}
  </main>;
}
