import { Link, useFetcher } from "react-router";
import { PrivateAccessError, privateRequest } from "~/shared/device/private-client";
import { resumeKeyRotation } from "~/shared/sharing/rotation-client";
import type { RotationJob } from "~/shared/sharing/rotation-wire";
import { isV7 } from "~/shared/tree/wire";
import type { ChromeHandle } from "~/ui/chrome";
import { cx } from "~/ui/cx";
import { ArrowRightIcon, CheckIcon, KeyIcon } from "~/ui/icons";
import { AccountLayout, PageIntro, SkeletonLines } from "~/ui/page-layouts";
import { buttonClass, linkClass, noticeClass } from "~/ui/styles";
import type { Route } from "./+types/account-key-rotations";

export const handle: ChromeHandle = { chrome: "account" };

export function meta() {
  return [{ title: "Secure access updates — mdwn" }];
}

/** Job identities/progress and all cryptography remain in browser-only data APIs. */
export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const cursor = new URL(request.url).searchParams.get("cursor");
  try {
    if (cursor !== null && !isV7(cursor)) throw new Error("Invalid cursor");
    const response = await privateRequest(`/api/private/key-rotations${cursor ? `?cursor=${cursor}` : ""}`, {
      method: "POST",
      signal: request.signal,
    });
    if (!response.ok) throw new Error("Updates unavailable");
    const page = (await response.json()) as { jobs: RotationJob[]; nextCursor: string | null };
    return { state: "ready" as const, ...page };
  } catch (error) {
    if (request.signal.aborted) throw error;
    return { state: error instanceof PrivateAccessError ? error.state : "failed", jobs: [], nextCursor: null };
  }
}

/** A fetcher submission runs one bounded browser pass, then native revalidation
 * reloads stored progress. Navigating away never unseals an unfinished job. */
export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData(),
    jobId = form.get("jobId");
  if (!isV7(jobId)) return { state: "failed" as const };
  try {
    const complete = await resumeKeyRotation(jobId, { signal: request.signal });
    return { state: complete ? ("complete" as const) : ("paused" as const) };
  } catch (error) {
    if (request.signal.aborted) throw error;
    return { state: "failed" as const };
  }
}

export function HydrateFallback() {
  return (
    <AccountLayout busy>
      <PageIntro eyebrow="Sharing" title="Secure access updates" />
      <p role="status" className="mt-6 text-sm text-muted">
        Loading secure access updates…
      </p>
      <SkeletonLines className="mt-6 max-w-xl" />
    </AccountLayout>
  );
}

function Update({ job }: { job: RotationJob }) {
  const fetcher = useFetcher<typeof clientAction>();
  const busy = fetcher.state !== "idle";
  return (
    <li className="rounded-3xl bg-paper p-6 ring-1 ring-line">
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-full bg-cream text-accent ring-1 ring-line">
          <KeyIcon />
        </span>
        <p className="font-medium">
          {job.progress} {job.progress === 1 ? "capability updated" : "capabilities updated"}
        </p>
      </div>
      <fetcher.Form method="post" className="mt-5">
        <input type="hidden" name="jobId" value={job.jobId} />
        <button type="submit" disabled={busy || job.runnable === false} className={buttonClass("primary", "sm")}>
          {busy ? "Updating secure access…" : "Resume update"}
        </button>
      </fetcher.Form>
      {job.runnable === false && (
        <p className="mt-3 text-sm text-muted">Queued. Finish the earlier affected folder update first.</p>
      )}
      {fetcher.data?.state === "paused" && (
        <p role="status" className={cx(noticeClass("info"), "mt-4")}>
          Progress saved. Resume to continue the next bounded batch.
        </p>
      )}
      {fetcher.data?.state === "failed" && (
        <p role="alert" className={cx(noticeClass("danger"), "mt-4")}>
          The update paused safely. Refresh and resume from an enrolled Owner device. Writes remain blocked until the
          update finishes.
        </p>
      )}
    </li>
  );
}

export default function KeyRotations({ loaderData }: Route.ComponentProps) {
  return (
    <AccountLayout>
      <PageIntro eyebrow="Sharing" title="Secure access updates">
        <p>
          Removed permissions take effect immediately. New writes beneath affected Files and folders wait until their
          secure access update finishes.
        </p>
      </PageIntro>
      <div className="mt-6 max-w-2xl space-y-2 text-sm leading-relaxed text-ink-soft">
        <p>This cannot recall previously downloaded plaintext, ciphertext, or keys.</p>
        <p>
          You can leave and resume from another enrolled Owner device. No plaintext keys or content are stored in the
          job.
        </p>
        <p>
          Expired Shares must finish{" "}
          <Link to="/account/shared-access" className={linkClass}>
            shared access cleanup
          </Link>{" "}
          before queued updates can resume.
        </p>
      </div>
      {loaderData.state === "ready" ? (
        <>
          {loaderData.jobs.length ? (
            <ul className="mt-8 grid gap-4 md:grid-cols-2">
              {loaderData.jobs.map((job) => (
                <Update key={job.jobId} job={job} />
              ))}
            </ul>
          ) : (
            <p role="status" className={cx(noticeClass("success"), "mt-8 flex max-w-xl items-center gap-2")}>
              <CheckIcon />
              No secure access updates are waiting.
            </p>
          )}
          {loaderData.nextCursor && (
            <Link to={`?cursor=${loaderData.nextCursor}`} className={cx(buttonClass("secondary", "sm"), "mt-6")}>
              More updates
              <ArrowRightIcon />
            </Link>
          )}
        </>
      ) : (
        <p role="alert" className={cx(noticeClass("warning"), "mt-8 max-w-xl")}>
          Use an enrolled Owner device to load and resume secure access updates.
        </p>
      )}
    </AccountLayout>
  );
}
