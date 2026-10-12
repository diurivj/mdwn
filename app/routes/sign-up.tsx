import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";

import { commitSignup, confirmSignupRecovery, prepareSignup, type PreparedSignup } from "~/signup/bootstrap";
import { HoneypotField } from "~/shared/security/honeypot-field";
import { HONEYPOT_FIELD_NAME } from "~/shared/security/honeypot";
import { cx } from "~/ui/cx";
import { ArrowRightIcon, CheckIcon, FolderIcon, KeyIcon, LockIcon, ShieldIcon } from "~/ui/icons";
import { FocusLayout, PageIntro } from "~/ui/page-layouts";
import { markSignedIn } from "~/ui/session-presence";
import { buttonClass, fieldClass, linkClass, noticeClass } from "~/ui/styles";

export function meta() {
  return [{ title: "Sign up — mdwn" }];
}

type Stage = "ready" | "working" | "phrase" | "codes" | "done" | "failed";

export default function SignUp() {
  const [stage, setStage] = useState<Stage>("ready");
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
  const busy = useRef(false);

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setStage("working");
    setPrepared(null);
    try {
      honeypot.current = String(new FormData(event.currentTarget).get(HONEYPOT_FIELD_NAME) ?? "");
      const created = await prepareSignup();
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

  async function confirmCodes() {
    if (!prepared || busy.current) return;
    busy.current = true;
    try {
      // Do not start the one-use ceremony until recovery has been saved. If
      // the commit response is lost (even across a reload), the gate is clear
      // and both the phrase and codes have already been shown and confirmed.
      confirmSignupRecovery();
      setPrepared(null);
      setWords(["", "", ""]);
      setStage("working");
      const current = new AbortController();
      controller.current = current;
      await commitSignup(prepared, honeypot.current, current.signal);
      markSignedIn();
      if (mounted.current) setStage("done");
    } catch {
      // Storage must be writable; network failures may still follow a commit.
      if (mounted.current) setStage("failed");
    } finally {
      controller.current = null;
      busy.current = false;
    }
  }

  const step = stage === "phrase" ? 1 : stage === "codes" ? 2 : null;
  return (
    <FocusLayout width={step ? "wide" : "narrow"}>
      <PageIntro eyebrow={step ? `Step ${step} of 3` : "Create account"} title="Create your account">
        {(stage === "ready" || stage === "working" || stage === "failed") && (
          <p>{stage === "working" ? "Creating your account…" : "Create a private account with a passkey."}</p>
        )}
      </PageIntro>
      {(stage === "ready" || stage === "working" || stage === "failed") && (
        <>
          <ul className="mt-8 divide-y divide-line border-y border-line bg-paper text-sm">
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
              We could not create your account. Try again, or sign in if your passkey was saved.
            </p>
          )}
          <form className="mt-8" onSubmit={createAccount}>
            <HoneypotField />
            <button
              type="submit"
              disabled={!hydrated || stage === "working"}
              className={cx(buttonClass("primary", "lg"), "w-full")}
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
            Write these 24 words down and keep them somewhere safe. They cannot be recovered for you.
          </p>
          <ol className="mt-6 grid grid-cols-2 gap-x-6 border border-line bg-cream px-6 py-4 sm:grid-cols-3 md:grid-cols-4">
            {secrets.phrase.split(" ").map((word, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the phrase is a fixed, never-reordered list, and duplicate words are possible.
              <li key={index} className="flex items-baseline gap-2 border-b border-line/70 py-2 font-mono text-[15px]">
                <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted">{index + 1}.</span> {word}
              </li>
            ))}
          </ol>
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
          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
            <button type="button" onClick={confirmCodes} className={buttonClass("primary", "lg")}>
              I saved my phrase and codes
            </button>
            <p className="text-sm text-muted">Next, your browser creates your passkey.</p>
          </div>
        </section>
      )}
      {stage === "done" && (
        <div className={cx(noticeClass("success"), "mt-8 animate-rise")}>
          <p>
            <span className="font-medium">Your account is ready.</span> Your recovery material will not be shown again.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to="/files" className={buttonClass("primary", "sm")}>
              <FolderIcon />
              Open your Files
            </Link>
            <Link to="/account/device-access" className={buttonClass("secondary", "sm")}>
              Check private access
            </Link>
            <Link to="/account/security" className={buttonClass("ghost", "sm")}>
              Add a second passkey
              <ArrowRightIcon />
            </Link>
          </div>
        </div>
      )}
    </FocusLayout>
  );
}
