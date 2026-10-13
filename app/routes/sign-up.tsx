import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Link, redirect, useNavigate } from "react-router";

import { hasActiveDeviceSession } from "~/device/proof.server";
import { getEnv } from "~/context/env";
import { RecoveryDownload } from "~/recovery/recovery-download";
import { recoveryCodesText, recoveryPhraseText } from "~/shared/account/recovery-text";
import {
  PSEUDONYM_MAX_CHARACTERS,
  PSEUDONYM_PROBLEMS,
  pseudonymProblem,
  suggestPseudonym,
} from "~/shared/account/pseudonym";
import {
  confirmSignupRecovery,
  prepareSignup,
  SignupCommitError,
  signupCommit,
  type PreparedSignup,
} from "~/signup/bootstrap";
import { PasskeyStep, type PasskeyProgress } from "~/signup/passkey-step";
import { HoneypotField } from "~/shared/security/honeypot-field";
import { HONEYPOT_FIELD_NAME } from "~/shared/security/honeypot";
import { cx } from "~/ui/cx";
import { CheckIcon, KeyIcon, LockIcon, RefreshIcon, ShieldIcon } from "~/ui/icons";
import { FocusLayout, PageIntro } from "~/ui/page-layouts";
import { afterSignIn } from "~/ui/auth-changes";
import { buttonClass, fieldClass, labelClass, linkClass, noticeClass } from "~/ui/styles";

import type { Route } from "./+types/sign-up";

export function meta() {
  return [{ title: "Sign up — mdwn" }];
}

/** A device-bound Session already has an Account here; it reads nothing else. */
export async function loader({ request, context }: Route.LoaderArgs) {
  if (await hasActiveDeviceSession(request, getEnv(context)).catch(() => false)) return redirect("/files");
  return null;
}

type Stage = "ready" | "working" | "phrase" | "codes" | "passkey" | "failed";

export default function SignUp() {
  const [stage, setStage] = useState<Stage>("ready");
  const navigate = useNavigate();
  const [hydrated, setHydrated] = useState(false);
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    setHydrated(true);
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const [prepared, setPrepared] = useState<PreparedSignup | null>(null);
  const secrets = prepared?.secrets ?? null;
  const honeypot = useRef("");
  const [indices, setIndices] = useState<number[]>([]);
  const [words, setWords] = useState(["", "", ""]);
  const [mismatch, setMismatch] = useState(false);
  // Suggested after hydration, so the server-rendered page is the same for everyone.
  const [pseudonym, setPseudonym] = useState("");
  useEffect(() => {
    setPseudonym(suggestPseudonym());
  }, []);
  const pseudonymIssue = hydrated ? pseudonymProblem(pseudonym) : null;
  const busy = useRef(false);
  const commit = useRef<ReturnType<typeof signupCommit> | null>(null);
  const [progress, setProgress] = useState<PasskeyProgress>("check");
  const [failure, setFailure] = useState<SignupCommitError | null>(null);
  // Each step replaces the one whose button was just pressed, often far down the page: start it at its heading.
  useLayoutEffect(() => {
    if (stage === "phrase" || stage === "codes" || stage === "passkey") window.scrollTo(0, 0);
  }, [stage]);
  // The library's code loads while recovery is being saved, so opening it after the commit
  // waits only for its data. A failed load costs only that head start, never the signup in progress.
  useEffect(() => {
    if (stage === "phrase") void import("~/tree/library-preload").catch(() => undefined);
  }, [stage]);

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || pseudonymProblem(pseudonym)) return;
    busy.current = true;
    setStage("working");
    setPrepared(null);
    try {
      honeypot.current = String(new FormData(event.currentTarget).get(HONEYPOT_FIELD_NAME) ?? "");
      const created = await prepareSignup(pseudonym);
      if (!mounted.current) return;
      const positions = Array.from({ length: 24 }, (_, index) => index);
      for (let i = positions.length - 1; i > 0; i--) {
        const random = new Uint32Array(1);
        crypto.getRandomValues(random);
        const j = random[0]! % (i + 1);
        [positions[i], positions[j]] = [positions[j]!, positions[i]!];
      }
      setIndices(positions.slice(0, 3).sort((a, b) => a - b));
      setWords(["", "", ""]);
      setPrepared(created);
      setStage("phrase");
    } catch {
      if (mounted.current) setStage("failed");
    } finally {
      busy.current = false;
    }
  }

  function checkWords(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!secrets || indices.length !== 3) return;
    const phraseWords = secrets.phrase.split(" ");
    if (!indices.every((index, position) => words[position]!.trim().toLowerCase() === phraseWords[index])) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setStage("codes");
  }

  function confirmCodes() {
    if (!prepared || busy.current) return;
    try {
      // Do not start the one-use ceremony until recovery has been saved. If
      // the commit response is lost (even across a reload), the gate is clear
      // and both the phrase and codes have already been shown and confirmed.
      confirmSignupRecovery();
    } catch {
      // Storage must be writable.
      setStage("failed");
      return;
    }
    // The commit keeps only what it sends; the phrase and codes leave memory with the page state.
    commit.current = signupCommit(prepared, honeypot.current);
    setPrepared(null);
    setWords(["", "", ""]);
    setProgress("check");
    setStage("passkey");
    void finishSignup();
  }

  /** Called from a click on retries, so a passkey prompt that can reopen at once stays in that click. */
  async function finishSignup() {
    const attempt = commit.current;
    if (!attempt || busy.current) return;
    busy.current = true;
    setFailure(null);
    const current = new AbortController();
    controller.current = current;
    try {
      await attempt(current.signal, setProgress);
    } catch (error) {
      // An unclassified failure might have followed a commit, so it is never retried with this material.
      if (mounted.current)
        setFailure(error instanceof SignupCommitError ? error : new SignupCommitError("unconfirmed"));
      return;
    } finally {
      controller.current = null;
      busy.current = false;
    }
    afterSignIn();
    if (!mounted.current) return;
    setProgress("done");
    // Signed in: the new library is home. Its recovery material has been shown for the last time.
    navigate("/files", { replace: true });
  }

  /** New recovery material for a new Account ID: the saved phrase and codes no longer apply. */
  function startOver() {
    commit.current = null;
    setFailure(null);
    setStage("ready");
  }

  const step = stage === "phrase" ? 1 : stage === "codes" ? 2 : stage === "passkey" ? 3 : null;
  return (
    <FocusLayout width={step ? "wide" : "narrow"}>
      <PageIntro eyebrow={step ? `Step ${step} of 3` : "Create account"} title="Create your account">
        {(stage === "ready" || stage === "working" || stage === "failed") && (
          <p>{stage === "working" ? "Creating your account…" : "Create a private account with a passkey."}</p>
        )}
      </PageIntro>
      {(stage === "ready" || stage === "working" || stage === "failed") && (
        <>
          <form className="mt-8" onSubmit={createAccount}>
            <div className="border border-line bg-cream p-6 sm:p-7">
              <label className={labelClass} htmlFor="signup-pseudonym">
                Public pseudonym
              </label>
              <div className="mt-2 flex flex-wrap gap-2">
                <div className="min-w-0 flex-1 basis-48">
                  <input
                    id="signup-pseudonym"
                    value={pseudonym}
                    onChange={(event) => setPseudonym(event.target.value)}
                    disabled={!hydrated || stage === "working"}
                    maxLength={PSEUDONYM_MAX_CHARACTERS * 2}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={pseudonymIssue ? true : undefined}
                    aria-describedby={pseudonymIssue ? "signup-pseudonym-problem" : "signup-pseudonym-help"}
                    className={fieldClass()}
                  />
                </div>
                <button
                  type="button"
                  disabled={!hydrated || stage === "working"}
                  onClick={() => setPseudonym(suggestPseudonym())}
                  className={buttonClass("secondary")}
                >
                  <RefreshIcon />
                  Suggest
                </button>
              </div>
              {pseudonymIssue ? (
                <p id="signup-pseudonym-problem" role="alert" className="mt-2 text-sm text-danger">
                  {PSEUDONYM_PROBLEMS[pseudonymIssue]}
                </p>
              ) : (
                <p id="signup-pseudonym-help" className="mt-2 text-xs leading-relaxed text-muted">
                  The name others see on your comments and on pages that credit you. It doesn’t have to be your real
                  name, and you can change it later.
                </p>
              )}
            </div>
            <ul className="mt-6 divide-y divide-line border-y border-line bg-paper text-sm">
              {(
                [
                  [LockIcon, "Your recovery phrase", "24 words that can restore your Files. mdwn never receives them."],
                  [ShieldIcon, "Ten recovery codes", "One-time codes that let you add a passkey if you lose them all."],
                  [KeyIcon, "Your passkey", "Your browser creates it last. There is no password, ever."],
                ] as const
              ).map(([Icon, title, body]) => (
                <li key={title} className="flex gap-4 py-5">
                  <span className="grid size-10 shrink-0 place-items-center border border-line bg-cream text-ink">
                    <Icon />
                  </span>
                  <span>
                    <span className="block font-medium text-ink">{title}</span>
                    <span className="mt-0.5 block leading-relaxed text-ink-soft">{body}</span>
                  </span>
                </li>
              ))}
            </ul>
            {stage === "failed" && (
              <p role="alert" className={cx(noticeClass("danger"), "mt-6")}>
                We could not create your account in this browser. Try again. If it keeps failing, check that this
                browser allows sites to save data.
              </p>
            )}
            <HoneypotField />
            <button
              type="submit"
              disabled={!hydrated || stage === "working" || pseudonymIssue !== null}
              className={cx(buttonClass("primary", "lg"), "mt-8 w-full")}
            >
              {stage === "working" ? "Creating your account…" : "Create account"}
            </button>
          </form>
          {stage !== "working" && (
            <p className="mt-6 text-center text-sm text-ink-soft">
              Already have an account?{" "}
              <Link className={linkClass} to="/sign-in">
                Sign in
              </Link>
            </p>
          )}
        </>
      )}
      {stage === "phrase" && secrets && (
        <section className="mt-10">
          <h2 className="font-display text-3xl font-light leading-tight tracking-tight">Save your recovery phrase</h2>
          <p className="mt-2 text-ink-soft">
            Write these 24 words down, or save them as a text file you keep offline. They cannot be recovered for you.
          </p>
          <ol className="mt-6 grid grid-cols-2 gap-x-6 border border-line bg-cream px-6 py-4 sm:grid-cols-3 md:grid-cols-4">
            {secrets.phrase.split(" ").map((word, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the phrase is a fixed, never-reordered list, and duplicate words are possible.
              <li key={index} className="flex items-baseline gap-2 border-b border-line/70 py-2 font-mono text-[15px]">
                <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted">{index + 1}.</span> {word}
              </li>
            ))}
          </ol>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            <RecoveryDownload
              name="mdwn-recovery-phrase"
              text={recoveryPhraseText(secrets.phrase)}
              label="Download phrase"
            />
            <p className="text-xs text-muted">
              Saved by your browser only. A .gz opens with a double-click; keep it apart from your recovery codes.
            </p>
          </div>
          <form onSubmit={checkWords} className="mt-8 border border-line bg-sand p-6 sm:p-8">
            <p className="font-medium">Verify your copy by entering these words:</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              {indices.map((index, position) => (
                <label key={index} className="block">
                  <span className="text-sm font-medium text-ink-soft">Word {index + 1}</span>
                  <input
                    required
                    autoComplete="off"
                    spellCheck={false}
                    className={cx(fieldClass("sm"), "mt-1.5 font-mono")}
                    value={words[position]}
                    onChange={(event) => {
                      const updated = [...words];
                      updated[position] = event.target.value;
                      setWords(updated);
                    }}
                  />
                </label>
              ))}
            </div>
            {mismatch && (
              <p role="alert" className={cx(noticeClass("danger"), "mt-4")}>
                Those words do not match. Check your copy and try again.
              </p>
            )}
            <button type="submit" className={cx(buttonClass("primary"), "mt-6")}>
              <CheckIcon />
              Verify phrase
            </button>
          </form>
        </section>
      )}
      {stage === "codes" && secrets && (
        <section className="mt-10">
          <h2 className="font-display text-3xl font-light leading-tight tracking-tight">Save your recovery codes</h2>
          <p className="mt-2 text-ink-soft">
            These ten one-time codes are shown only now. Store them separately from your recovery phrase and passkey.
            Add a second passkey in Account security when you finish.
          </p>
          <p className="mt-4 text-sm text-ink-soft">
            Save this non-secret recovery identifier alongside your codes:{" "}
            <span className="break-all bg-cream px-1.5 py-0.5 font-mono text-ink">
              {prepared?.transcriptBase.accountId}
            </span>
          </p>
          <ol className="mt-6 grid gap-x-6 border border-line bg-cream px-6 py-4 sm:grid-cols-2">
            {secrets.recoveryCodes.map((code, index) => (
              <li key={code} className="flex items-baseline gap-2 border-b border-line/70 py-2 font-mono text-sm">
                <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted">{index + 1}.</span>{" "}
                <span className="break-all">{code}</span>
              </li>
            ))}
          </ol>
          <div className="mt-4">
            <RecoveryDownload
              name="mdwn-recovery-codes"
              text={recoveryCodesText(secrets.recoveryCodes, prepared?.transcriptBase.accountId)}
              label="Download codes"
            />
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
            <button type="button" onClick={confirmCodes} className={buttonClass("primary", "lg")}>
              I saved my phrase and codes
            </button>
            <p className="text-sm text-muted">Next, your browser creates your passkey.</p>
          </div>
        </section>
      )}
      {stage === "passkey" && (
        <PasskeyStep progress={progress} failure={failure} onRetry={finishSignup} onStartOver={startOver} />
      )}
    </FocusLayout>
  );
}
