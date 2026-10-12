import { Link, useFetcher } from "react-router";

import { forgetRecoveryPhrase, loadVaultRecovery, runVaultRecovery } from "~/recovery/ceremony-client";
import { useOwnedProvisioning } from "~/device/owned-provision-hook";
import type { ChromeHandle } from "~/ui/chrome";
import { cx } from "~/ui/cx";
import { ArrowRightIcon, CheckIcon, KeyIcon } from "~/ui/icons";
import { FocusLayout, PageIntro, SkeletonLines } from "~/ui/page-layouts";
import { buttonClass, fieldClass, labelClass, linkClass, noticeClass } from "~/ui/styles";

import type { Route } from "./+types/recover-files";

export const handle: ChromeHandle = { chrome: "account" };

export function meta() {
  return [{ title: "Recover your Files — mdwn" }];
}

export function clientLoader({ request }: Route.ClientLoaderArgs) {
  return loadVaultRecovery(request.signal);
}

export function HydrateFallback() {
  return (
    <FocusLayout>
      <PageIntro eyebrow="Files recovery" title="Preparing recovery…" />
      <SkeletonLines className="mt-10" />
    </FocusLayout>
  );
}

export function clientAction({ request }: Route.ClientActionArgs) {
  return runVaultRecovery(request);
}

export default function RecoverFiles({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof clientAction>();
  const needsRestoration = loaderData.restoring || (fetcher.data?.state === "success" && fetcher.data.restoring);
  const restoring = useOwnedProvisioning(Boolean(needsRestoration));
  const busy = fetcher.state !== "idle";
  const phrase = fetcher.data?.state === "success" ? fetcher.data.phrase : loaderData.phrase;
  return (
    <FocusLayout>
      <PageIntro eyebrow="Files recovery" title="Recover your Files" />
      {loaderData.state === "signed-out" ? (
        <p className="mt-6 text-ink-soft">
          <Link to="/sign-in" className={linkClass}>
            Sign in with a passkey
          </Link>{" "}
          first.
        </p>
      ) : loaderData.state === "restricted" ? (
        <p className={cx(noticeClass("warning"), "mt-6")}>
          Finish replacing your passkey, then sign in with it before recovering your Files.
        </p>
      ) : loaderData.state === "failed" ? (
        <p className={cx(noticeClass("danger"), "mt-6")}>Recovery is unavailable. Please try again.</p>
      ) : (
        <>
          <p className="mt-4 max-w-2xl leading-relaxed text-ink-soft">
            Confirm with a passkey and enter your current 24-word Files recovery phrase. Your phrase stays in this
            browser. Recovery replaces every previous Encryption device and signs out other Sessions.
          </p>
          {!phrase && (
            <fetcher.Form method="post" className="mt-8 border border-line bg-cream p-6 sm:p-8">
              <label className={labelClass} htmlFor="phrase">
                Current recovery phrase
              </label>
              <textarea
                id="phrase"
                name="phrase"
                required
                autoComplete="off"
                spellCheck={false}
                placeholder="word word word …"
                className={cx(fieldClass(), "mt-2 min-h-32 resize-y font-mono text-sm leading-relaxed")}
              />
              <button type="submit" disabled={busy} className={cx(buttonClass("primary", "lg"), "mt-5 w-full")}>
                <KeyIcon />
                Recover Files
              </button>
            </fetcher.Form>
          )}
          {busy && (
            <p role="status" className={cx(noticeClass("info"), "mt-6 flex items-center gap-3")}>
              <span aria-hidden="true" className="size-2 shrink-0 animate-pulse rounded-full bg-accent" />
              Restoring your Files securely…
            </p>
          )}
          {!busy && fetcher.data?.state === "failed" && (
            <p role="alert" className={cx(noticeClass("danger"), "mt-6")}>
              Recovery could not be completed. Start again with your current phrase.
            </p>
          )}
          {!busy && fetcher.data?.state === "uncertain" && (
            <p role="alert" className={cx(noticeClass("warning"), "mt-6")}>
              We could not confirm the result.{" "}
              <Link to="/sign-in" className={linkClass}>
                Sign in with a passkey
              </Link>{" "}
              to check whether this device was activated before starting again.
            </p>
          )}
          {phrase && (
            <section className="mt-8 border-y border-ink bg-sand p-6 text-ink sm:p-8" role="status">
              <p className="eyebrow text-muted">Write it down now</p>
              <h2 className="mt-2 font-display text-3xl font-light leading-tight tracking-tight">
                Save your new recovery phrase
              </h2>
              <p className="mt-2 text-sm text-ink-soft">
                Your previous phrase no longer works. Keep these 24 words offline.
              </p>
              <p className="mt-5 break-words border-y border-line bg-cream p-4 font-mono text-[15px] leading-loose [word-spacing:0.35em]">
                {phrase}
              </p>
              <button
                type="button"
                className={cx(buttonClass("secondary", "sm"), "mt-5")}
                onClick={forgetRecoveryPhrase}
              >
                <CheckIcon />I saved this phrase
              </button>
            </section>
          )}
          {fetcher.data?.state === "success" && restoring && (
            <p role="status" className={cx(noticeClass("info"), "mt-6")}>
              Restoring your Files securely…
            </p>
          )}
          {restoring && fetcher.data?.state !== "success" && (
            <p role="status" className={cx(noticeClass("info"), "mt-6")}>
              Restoring your Files securely…
            </p>
          )}
          {phrase && (
            <Link to="/account/device-access" className={cx(buttonClass("primary"), "mt-6")}>
              Open your Files
              <ArrowRightIcon />
            </Link>
          )}
        </>
      )}
    </FocusLayout>
  );
}
