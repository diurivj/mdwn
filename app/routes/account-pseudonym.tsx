import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";
import {
  cancelAccountPseudonymUpdate,
  changeAccountPseudonym,
  loadAccountPseudonymState,
  PseudonymChangedError,
  PseudonymCooldownError,
  PseudonymInvalidError,
  PseudonymPendingError,
  PseudonymPreparingError,
  resumeAccountPseudonymUpdate,
  type PseudonymJob,
} from "~/account/pseudonym-client";
import {
  PSEUDONYM_MAX_CHARACTERS,
  PSEUDONYM_PROBLEMS,
  type PseudonymProblem,
  pseudonymProblem,
  suggestPseudonym,
} from "~/shared/account/pseudonym";
import { PrivateAccessError } from "~/shared/device/private-client";
import { isV7 } from "~/shared/tree/wire";

import type { ChromeHandle } from "~/ui/chrome";
import { cx } from "~/ui/cx";
import { RefreshIcon } from "~/ui/icons";
import { AccountLayout, PageIntro, SettingsSection, SkeletonLines } from "~/ui/page-layouts";
import { buttonClass, fieldClass, labelClass, noticeClass } from "~/ui/styles";

import type { Route } from "./+types/account-pseudonym";

export const handle: ChromeHandle = { chrome: "account" };

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

type ActionState =
  | "complete"
  | "paused"
  | "cooldown"
  | "pending"
  | "preparing"
  | "changed"
  | "cancelled"
  | "invalid"
  | "failed";

/** A fetcher submission runs one bounded browser pass; native revalidation then
 * reloads stored progress. Leaving the page never discards staging. */
export async function clientAction({ request }: Route.ClientActionArgs): Promise<{
  state: ActionState;
  nextChangeAt?: number;
  problem?: PseudonymProblem | "unchanged";
}> {
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
      return { state: (await resumeAccountPseudonymUpdate(jobId, { signal: request.signal })) ? "complete" : "paused" };
    }
    const pseudonym = form.get("pseudonym");
    if (typeof pseudonym !== "string") return { state: "invalid", problem: "empty" };
    return { state: (await changeAccountPseudonym({ pseudonym, signal: request.signal })) ? "complete" : "paused" };
  } catch (error) {
    if (request.signal.aborted) throw error;
    if (error instanceof PseudonymInvalidError) return { state: "invalid", problem: error.problem };
    if (error instanceof PseudonymCooldownError) return { state: "cooldown", nextChangeAt: error.nextChangeAt };
    if (error instanceof PseudonymPendingError) return { state: "pending" };
    if (error instanceof PseudonymPreparingError) return { state: "preparing" };
    if (error instanceof PseudonymChangedError) return { state: "changed" };
    return { state: "failed" };
  }
}

export function HydrateFallback() {
  return (
    <AccountLayout busy>
      <PageIntro eyebrow="Identity" title="Public pseudonym" />
      <p role="status" className="mt-6 text-sm text-muted">
        Loading Public pseudonym…
      </p>
      <SkeletonLines className="mt-6 max-w-xl" />
    </AccountLayout>
  );
}

function cooldownDate(nextChangeAt: number): string {
  return new Date(nextChangeAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export default function AccountPseudonym({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof clientAction>();
  const busy = fetcher.state !== "idle";
  const [draft, setDraft] = useState("");
  const [placeholder] = useState(suggestPseudonym);
  const problem = draft ? pseudonymProblem(draft) : null;
  const completed = fetcher.state === "idle" && fetcher.data?.state === "complete";
  useEffect(() => {
    if (completed) setDraft("");
  }, [completed]);
  if (loaderData.state !== "ready") {
    return (
      <AccountLayout>
        <PageIntro eyebrow="Identity" title="Public pseudonym" />
        <p role="alert" className={cx(noticeClass("warning"), "mt-8 max-w-xl")}>
          Use an enrolled device to view or change your Public pseudonym.
        </p>
        <Link to="/account/security" className={cx(buttonClass("secondary", "sm"), "mt-6")}>
          Account security
        </Link>
      </AccountLayout>
    );
  }
  const { job, nextChangeAt, publicPseudonym } = loaderData;
  const coolingDown = nextChangeAt !== null && nextChangeAt > Date.now();
  return (
    <AccountLayout>
      <PageIntro eyebrow="Identity" title="Public pseudonym">
        <p>
          The name shown on every Comment you author and on Publications where an Owner credits you. It doesn’t have to
          be your real name, and it is separate from your share identifier and any share handle.
        </p>
      </PageIntro>
      <section
        aria-label="Current Public pseudonym"
        className="mt-8 max-w-xl border border-ink bg-sand px-7 py-8 font-display text-4xl font-light leading-tight tracking-tight text-ink sm:text-5xl"
      >
        {publicPseudonym}
      </section>

      {job ? (
        <SettingsSection
          className="mt-6"
          aria-label="Pseudonym update in progress"
          title="Update in progress"
          description={
            <p>
              {job.progress} {job.progress === 1 ? "attribution" : "attributions"} staged. Until every context is staged
              and the update commits, every view keeps the old pseudonym and creating new Comments or Publication
              declarations is paused.
            </p>
          }
        >
          <div className="mt-5 flex flex-wrap gap-2">
            <fetcher.Form method="post">
              <input type="hidden" name="jobId" value={job.jobId} />
              <button
                disabled={busy}
                name="intent"
                value="resume"
                type="submit"
                className={buttonClass("primary", "sm")}
              >
                {busy ? "Updating…" : "Resume update"}
              </button>
            </fetcher.Form>
            <fetcher.Form method="post">
              <input type="hidden" name="jobId" value={job.jobId} />
              <button
                disabled={busy}
                name="intent"
                value="cancel"
                type="submit"
                className={buttonClass("secondary", "sm")}
              >
                Cancel update
              </button>
            </fetcher.Form>
          </div>
          <p className="mt-4 text-sm text-ink-soft">
            You can leave and resume from another enrolled device. No plaintext pseudonym or key is stored in the
            update.
          </p>
        </SettingsSection>
      ) : (
        <SettingsSection
          className="mt-6"
          title="Change your pseudonym"
          description={
            coolingDown && nextChangeAt !== null ? (
              <p>You can change it again on {cooldownDate(nextChangeAt)} (at most once every 30 days).</p>
            ) : (
              <p>Choose any name you like. You can change it at most once every 30 days.</p>
            )
          }
        >
          <fetcher.Form method="post" className="mt-5">
            <label className={labelClass} htmlFor="new-pseudonym">
              New pseudonym
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              <div className="min-w-0 flex-1 basis-56">
                <input
                  id="new-pseudonym"
                  name="pseudonym"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  disabled={busy || coolingDown}
                  maxLength={PSEUDONYM_MAX_CHARACTERS * 2}
                  placeholder={placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={problem ? true : undefined}
                  aria-describedby={problem ? "new-pseudonym-problem" : undefined}
                  className={fieldClass()}
                />
              </div>
              <button
                type="button"
                disabled={busy || coolingDown}
                onClick={() => setDraft(suggestPseudonym())}
                className={buttonClass("secondary")}
              >
                <RefreshIcon />
                Suggest one
              </button>
            </div>
            {problem && (
              <p id="new-pseudonym-problem" role="alert" className="mt-2 text-sm text-danger">
                {PSEUDONYM_PROBLEMS[problem]}
              </p>
            )}
            <button
              disabled={busy || coolingDown || !draft || problem !== null}
              name="intent"
              value="change"
              type="submit"
              className={cx(buttonClass("primary", "sm"), "mt-4")}
            >
              {busy ? "Changing…" : "Change pseudonym"}
            </button>
          </fetcher.Form>
          <div className="mt-5 space-y-2 text-sm leading-relaxed text-ink-soft">
            <p>
              The change updates every encrypted attribution this Account can currently rewrite in one exclusive
              operation: all its Comment attributions across every thread, and its Publication declarations on active
              links. Existing views keep the old pseudonym until the whole update commits.
            </p>
            <p>Cached copies and screenshots cannot be changed.</p>
            <p>
              Threads or Publications you can no longer open keep the label their readers already have, because this
              Account no longer holds a key for them.
            </p>
          </div>
        </SettingsSection>
      )}

      {!busy && fetcher.data?.state === "complete" && (
        <p role="status" className={cx(noticeClass("success"), "mt-6 max-w-xl")}>
          Your Public pseudonym was updated everywhere it can be changed.
        </p>
      )}
      {!busy && fetcher.data?.state === "paused" && (
        <p role="status" className={cx(noticeClass("info"), "mt-6 max-w-xl")}>
          Progress saved. Resume to continue the next bounded batch.
        </p>
      )}
      {!busy && fetcher.data?.state === "cancelled" && (
        <p role="status" className={cx(noticeClass("info"), "mt-6 max-w-xl")}>
          Update cancelled. The old pseudonym is unchanged.
        </p>
      )}
      {!busy && fetcher.data?.state === "cooldown" && (
        <p role="alert" className={cx(noticeClass("warning"), "mt-6 max-w-xl")}>
          You can change your pseudonym again on {cooldownDate(fetcher.data.nextChangeAt ?? 0)}.
        </p>
      )}
      {!busy && fetcher.data?.state === "pending" && (
        <p role="alert" className={cx(noticeClass("warning"), "mt-6 max-w-xl")}>
          An update is already in progress. Refresh to resume it.
        </p>
      )}
      {!busy && fetcher.data?.state === "preparing" && (
        <p role="alert" className={cx(noticeClass("warning"), "mt-6 max-w-xl")}>
          Secure access to one of your Comment threads is still being prepared on this device. Open that File, then
          resume the update.
        </p>
      )}
      {!busy && fetcher.data?.state === "changed" && (
        <p role="alert" className={cx(noticeClass("warning"), "mt-6 max-w-xl")}>
          The update changed while you worked. Refresh and resume it.
        </p>
      )}
      {!busy && fetcher.data?.state === "invalid" && (
        <p role="alert" className={cx(noticeClass("warning"), "mt-6 max-w-xl")}>
          {fetcher.data.problem === "unchanged"
            ? "That is already your Public pseudonym."
            : PSEUDONYM_PROBLEMS[fetcher.data.problem ?? "empty"]}
        </p>
      )}
      {!busy && fetcher.data?.state === "failed" && (
        <p role="alert" className={cx(noticeClass("danger"), "mt-6 max-w-xl")}>
          The update paused safely. Refresh and try again.
        </p>
      )}
    </AccountLayout>
  );
}
