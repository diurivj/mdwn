import { Link, useFetcher } from "react-router";
import {
  cancelAccountPseudonymUpdate,
  changeAccountPseudonym,
  loadAccountPseudonymState,
  PseudonymChangedError,
  PseudonymCooldownError,
  PseudonymPendingError,
  PseudonymPreparingError,
  resumeAccountPseudonymUpdate,
  type PseudonymJob,
} from "~/account/pseudonym-client";
import { PrivateAccessError } from "~/device/private-client";
import { isV7 } from "~/tree/wire";

import type { Route } from "./+types/account-pseudonym";

export function meta() {
  return [{ title: "Public pseudonym — mdwn" }];
}

type PseudonymData =
  | { state: "ready"; publicPseudonym: string; nextChangeAt: number | null; job: PseudonymJob | null }
  | { state: "signed-out" | "unprovisioned" | "device-lost" | "stale" | "denied" | "unavailable" | "failed" };

/** No server loader: the pseudonym is opened only in this browser. */
export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<PseudonymData> {
  try {
    const state = await loadAccountPseudonymState(request.signal);
    return { state: "ready", ...state };
  } catch (error) {
    if (request.signal.aborted) throw error;
    return { state: error instanceof PrivateAccessError ? error.state : "failed" };
  }
}

type ActionState = "complete" | "paused" | "cooldown" | "pending" | "preparing" | "changed" | "cancelled" | "failed";

/** A fetcher submission runs one bounded browser pass; native revalidation then
 * reloads stored progress. Leaving the page never discards staging. */
export async function clientAction({ request }: Route.ClientActionArgs): Promise<{ state: ActionState; nextChangeAt?: number }> {
  const form = await request.formData();
  const intent = form.get("intent");
  try {
    if (intent === "resume" || intent === "cancel") {
      const jobId = form.get("jobId");
      if (!isV7(jobId)) return { state: "failed" };
      if (intent === "cancel") {
        await cancelAccountPseudonymUpdate(jobId);
        return { state: "cancelled" };
      }
      return { state: await resumeAccountPseudonymUpdate(jobId, { signal: request.signal }) ? "complete" : "paused" };
    }
    return { state: await changeAccountPseudonym({ signal: request.signal }) ? "complete" : "paused" };
  } catch (error) {
    if (request.signal.aborted) throw error;
    if (error instanceof PseudonymCooldownError) return { state: "cooldown", nextChangeAt: error.nextChangeAt };
    if (error instanceof PseudonymPendingError) return { state: "pending" };
    if (error instanceof PseudonymPreparingError) return { state: "preparing" };
    if (error instanceof PseudonymChangedError) return { state: "changed" };
    return { state: "failed" };
  }
}

export function HydrateFallback() {
  return <main className="mx-auto max-w-xl px-4 py-12" role="status">Loading Public pseudonym…</main>;
}

function cooldownDate(nextChangeAt: number): string {
  return new Date(nextChangeAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export default function AccountPseudonym({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof clientAction>();
  const busy = fetcher.state !== "idle";
  if (loaderData.state !== "ready") {
    return <main className="mx-auto max-w-xl px-4 py-12">
      <Link to="/account/security" className="text-sm underline">Account security</Link>
      <h1 className="mt-8 text-2xl font-semibold">Public pseudonym</h1>
      <p role="alert" className="mt-6">Use an enrolled device to view or change your Public pseudonym.</p>
    </main>;
  }
  const { job, nextChangeAt, publicPseudonym } = loaderData;
  const coolingDown = nextChangeAt !== null && nextChangeAt > Date.now();
  return <main className="mx-auto max-w-xl px-4 py-12">
    <Link to="/account/security" className="text-sm underline">Account security</Link>
    <h1 className="mt-8 text-2xl font-semibold">Public pseudonym</h1>
    <p className="mt-3 text-sm">This generated label appears on every Comment you author and on Publications where an Owner credits you. It is separate from your share identifier and any share handle.</p>
    <p className="mt-4 rounded-md border border-stone-200 bg-white p-4 font-medium" aria-label="Current Public pseudonym">{publicPseudonym}</p>

    {job ? <section className="mt-8 rounded-md border border-stone-200 bg-white p-4" aria-label="Pseudonym update in progress">
      <h2 className="font-medium">Update in progress</h2>
      <p className="mt-2 text-sm">{job.progress} {job.progress === 1 ? "attribution" : "attributions"} staged. Until every context is staged and the update commits, every view keeps the old pseudonym and creating new Comments or Publication declarations is paused.</p>
      <div className="mt-3 flex flex-wrap gap-3">
        <fetcher.Form method="post">
          <input type="hidden" name="jobId" value={job.jobId} />
          <button disabled={busy} name="intent" value="resume" type="submit" className="rounded-md border border-stone-300 px-4 py-2 text-sm font-medium disabled:opacity-60">{busy ? "Updating…" : "Resume update"}</button>
        </fetcher.Form>
        <fetcher.Form method="post">
          <input type="hidden" name="jobId" value={job.jobId} />
          <button disabled={busy} name="intent" value="cancel" type="submit" className="rounded-md border border-stone-300 px-4 py-2 text-sm font-medium disabled:opacity-60">Cancel update</button>
        </fetcher.Form>
      </div>
      <p className="mt-3 text-sm">You can leave and resume from another enrolled device. No plaintext pseudonym or key is stored in the update.</p>
    </section> : <section className="mt-8">
      <h2 className="font-medium">Change your pseudonym</h2>
      {coolingDown && nextChangeAt !== null
        ? <p className="mt-2 text-sm">You can change it again on {cooldownDate(nextChangeAt)} (at most once every 30 days).</p>
        : <p className="mt-2 text-sm">You can change it at most once every 30 days. The new label is generated for you.</p>}
      <fetcher.Form method="post" className="mt-3">
        <button disabled={busy || coolingDown} name="intent" value="change" type="submit" className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">{busy ? "Changing…" : "Change pseudonym"}</button>
      </fetcher.Form>
      <p className="mt-3 text-sm">The change updates every encrypted attribution this Account can currently rewrite in one exclusive operation: all its Comment attributions across every thread, and its Publication declarations on active links. Existing views keep the old pseudonym until the whole update commits.</p>
      <p className="mt-3 text-sm">Cached copies and screenshots cannot be changed.</p>
      <p className="mt-3 text-sm">Threads or Publications you can no longer open keep the label their readers already have, because this Account no longer holds a key for them.</p>
    </section>}

    {!busy && fetcher.data?.state === "complete" && <p role="status" className="mt-6">Your Public pseudonym was updated everywhere it can be changed.</p>}
    {!busy && fetcher.data?.state === "paused" && <p role="status" className="mt-6">Progress saved. Resume to continue the next bounded batch.</p>}
    {!busy && fetcher.data?.state === "cancelled" && <p role="status" className="mt-6">Update cancelled. The old pseudonym is unchanged.</p>}
    {!busy && fetcher.data?.state === "cooldown" && <p role="alert" className="mt-6">You can change your pseudonym again on {cooldownDate(fetcher.data.nextChangeAt ?? 0)}.</p>}
    {!busy && fetcher.data?.state === "pending" && <p role="alert" className="mt-6">An update is already in progress. Refresh to resume it.</p>}
    {!busy && fetcher.data?.state === "preparing" && <p role="alert" className="mt-6">Secure access to one of your Comment threads is still being prepared on this device. Open that File, then resume the update.</p>}
    {!busy && fetcher.data?.state === "changed" && <p role="alert" className="mt-6">The update changed while you worked. Refresh and resume it.</p>}
    {!busy && fetcher.data?.state === "failed" && <p role="alert" className="mt-6">The update paused safely. Refresh and try again.</p>}
  </main>;
}
