import { useFetcher } from "react-router";
import { readNextProvisioning, resumeGrantProvisioning } from "~/shared/sharing/provisioning-client";
import type { ChromeHandle } from "~/ui/chrome";
import { cx } from "~/ui/cx";
import { ShareIcon } from "~/ui/icons";
import { AccountLayout, PageIntro, SkeletonLines } from "~/ui/page-layouts";
import { buttonClass, noticeClass } from "~/ui/styles";
import type { Route } from "./+types/account-shared-access";

export const handle: ChromeHandle = { chrome: "account" };

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
    <AccountLayout busy>
      <PageIntro eyebrow="Sharing" title="Shared access" />
      <p role="status" className="mt-6 text-sm text-muted">
        Checking shared access…
      </p>
      <SkeletonLines className="mt-6 max-w-xl" />
    </AccountLayout>
  );
}

export default function SharedAccess({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof clientAction>();
  return (
    <AccountLayout>
      <PageIntro eyebrow="Sharing" title="Shared access">
        <p>
          An authorized browser securely provisions current shared capabilities to enrolled devices. You can leave and
          resume later.
        </p>
      </PageIntro>
      {loaderData.pending && (
        <p className={cx(noticeClass("info"), "mt-6 max-w-xl")} role="status">
          Shared content is being securely provisioned
        </p>
      )}
      {loaderData.ready ? (
        <fetcher.Form method="post" className="mt-8">
          <button type="submit" disabled={fetcher.state !== "idle"} className={buttonClass("primary")}>
            <ShareIcon />
            Provision shared content
          </button>
        </fetcher.Form>
      ) : (
        <p role="alert" className={cx(noticeClass("warning"), "mt-8 max-w-xl")}>
          Use an enrolled device to check shared access.
        </p>
      )}
      {fetcher.data?.state === "ready" && (
        <p role="status" className={cx(noticeClass("success"), "mt-6 max-w-xl")}>
          {fetcher.data.complete
            ? "Shared access pass complete. Unavailable capabilities still wait for an authorized source browser."
            : "Progress saved. Resume to process the next bounded batch."}
        </p>
      )}
      {fetcher.data?.state === "failed" && (
        <p role="alert" className={cx(noticeClass("danger"), "mt-6 max-w-xl")}>
          Provisioning paused safely. Refresh and resume from an authorized enrolled device.
        </p>
      )}
    </AccountLayout>
  );
}
