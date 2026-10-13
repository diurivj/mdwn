import { useEffect, useRef, type ComponentType } from "react";
import { Link } from "react-router";

import { cx } from "~/ui/cx";
import { CheckIcon, KeyIcon, LockIcon, RefreshIcon, ShieldIcon, UserIcon } from "~/ui/icons";
import { buttonClass, noticeClass } from "~/ui/styles";

import type { SignupCommitError, SignupFailure, SignupStep } from "./bootstrap";

export type PasskeyProgress = SignupStep | "done";

type Icon = ComponentType<{ className?: string }>;

const ORDER: readonly PasskeyProgress[] = ["check", "passkey", "save", "done"];

const ROWS: readonly { step: SignupStep | null; Icon: Icon; title: string; body: string }[] = [
  {
    step: null,
    Icon: LockIcon,
    title: "Recovery phrase and codes",
    body: "You saved them. mdwn never receives your phrase.",
  },
  {
    step: "check",
    Icon: ShieldIcon,
    title: "Signup check",
    body: "Your browser does a short calculation that makes creating accounts in bulk costly, so mdwn needs no CAPTCHA or tracking.",
  },
  {
    step: "passkey",
    Icon: KeyIcon,
    title: "Passkey",
    body: "Confirm in your browser’s prompt with Touch ID, Face ID, Windows Hello, your phone or a security key.",
  },
  { step: "save", Icon: UserIcon, title: "Your account", body: "mdwn saves your encrypted account and signs you in." },
];

const STATUS: Record<PasskeyProgress, string> = {
  check: "Running the signup check…",
  passkey: "Waiting for your passkey…",
  save: "Saving your account…",
  done: "Opening your library…",
};

/** Signup's last step: what runs once recovery is confirmed, and what the person can do if it stops. */
export function PasskeyStep({
  progress,
  failure,
  onRetry,
  onStartOver,
}: {
  progress: PasskeyProgress;
  failure: SignupCommitError | null;
  onRetry: () => void;
  onStartOver: () => void;
}) {
  const current = ORDER.indexOf(progress);
  return (
    <section className="mt-10">
      <h2 className="font-display text-3xl font-light leading-tight tracking-tight">Create your passkey</h2>
      <p className="mt-2 text-ink-soft">
        Your passkey is how you sign in to mdwn. There is no password. Your browser or password manager asks you to
        create it.
      </p>
      <ol aria-label="Signup progress" className="mt-6 divide-y divide-line border-y border-line bg-paper text-sm">
        {ROWS.map(({ step, Icon, title, body }) => {
          const index = step ? ORDER.indexOf(step) : -1;
          const state = index < current ? "done" : index === current && !failure ? "active" : "pending";
          return (
            <li key={title} className="flex gap-4 py-5" aria-current={state === "active" ? "step" : undefined}>
              <span
                className={cx(
                  "grid size-10 shrink-0 place-items-center border",
                  state === "done" && "border-ink bg-ink text-paper",
                  state === "active" && "border-ink bg-cream text-ink",
                  state === "pending" && "border-line bg-cream text-muted",
                )}
              >
                {state === "done" ? <CheckIcon /> : <Icon className={cx(state === "active" && "animate-pulse")} />}
              </span>
              <span>
                <span className={cx("block font-medium", state === "pending" ? "text-ink-soft" : "text-ink")}>
                  {title}
                  <span className="sr-only">
                    {state === "done" ? " (done)" : state === "active" ? " (in progress)" : ""}
                  </span>
                </span>
                <span className="mt-0.5 block leading-relaxed text-ink-soft">{body}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {/* Kept mounted, so each step's text is announced as it changes, including after a retry. */}
      <p role="status" className={cx("text-sm text-ink-soft", !failure && "mt-6")}>
        {failure ? "" : STATUS[progress]}
      </p>
      {failure && <FailureNotice failure={failure} onRetry={onRetry} onStartOver={onStartOver} />}
    </section>
  );
}

const RETRY: Partial<Record<SignupFailure, { Icon: Icon; label: string }>> = {
  request: { Icon: RefreshIcon, label: "Try again" },
  limited: { Icon: RefreshIcon, label: "Try again" },
  passkey: { Icon: KeyIcon, label: "Create passkey" },
};

function FailureNotice({
  failure,
  onRetry,
  onStartOver,
}: {
  failure: SignupCommitError;
  onRetry: () => void;
  onStartOver: () => void;
}) {
  const actions = useRef<HTMLDivElement>(null);
  // The control that started the attempt is gone; focus moves to what can continue it.
  useEffect(() => {
    actions.current?.querySelector<HTMLElement>("a, button")?.focus();
  }, []);
  const retry = RETRY[failure.failure];
  // A dismissed prompt or a rate limit only asks the person to try again; nothing went wrong.
  const tone = failure.failure === "passkey" || failure.failure === "limited" ? "warning" : "danger";
  return (
    <div role="alert" className={cx(noticeClass(tone), "mt-6")}>
      <p>{failureMessage(failure)}</p>
      {failure.failure !== "refused" && (
        <div ref={actions} className="mt-4 flex flex-wrap gap-3">
          {retry ? (
            <button type="button" onClick={onRetry} className={buttonClass("primary", "sm")}>
              <retry.Icon />
              {retry.label}
            </button>
          ) : (
            <>
              {failure.failure === "unconfirmed" && (
                <Link to="/sign-in" className={buttonClass("primary", "sm")}>
                  <KeyIcon />
                  Sign in
                </Link>
              )}
              <button
                type="button"
                onClick={onStartOver}
                className={buttonClass(failure.failure === "unconfirmed" ? "secondary" : "primary", "sm")}
              >
                Start over
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function failureMessage({ failure, retryAfterSeconds }: SignupCommitError): string {
  switch (failure) {
    case "request":
      return "Signup stopped before your passkey was created. The recovery phrase and codes you saved still apply. Check your connection, then try again.";
    case "limited":
      return `Too many signups have started recently. Try again ${inAbout(retryAfterSeconds)}, and keep this page open: the recovery phrase and codes you saved still apply.`;
    case "passkey":
      return "Your passkey wasn’t created. The prompt may have been closed or timed out. The recovery phrase and codes you saved still apply.";
    case "device":
      return "We could not create your account: this browser no longer has the keys it made for it. Start over to get a new recovery phrase and codes. The ones you saved won’t work.";
    case "refused":
      // The cap may be global or this network's; the copy names neither.
      return `Too many accounts have been created recently, so yours wasn’t created and the passkey you just made won’t work. Come back ${inAbout(retryAfterSeconds)} to start over with a new recovery phrase and codes.`;
    case "unconfirmed":
      return "We could not confirm that your account was created. If it was, sign in with the passkey you just made. If signing in doesn’t work, start over with a new recovery phrase and codes.";
  }
}

function inAbout(seconds: number | null): string {
  if (seconds === null) return "later";
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= 1) return "in about a minute";
  if (minutes < 60) return `in about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "in about an hour" : `in about ${hours} hours`;
}
