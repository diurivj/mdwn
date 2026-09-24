import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";

import { commitSignup, confirmSignupRecovery, prepareSignup, type PreparedSignup } from "~/signup/bootstrap";
import { HoneypotField } from "~/security/HoneypotField";
import { HONEYPOT_FIELD_NAME } from "~/security/honeypot";

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
    return () => { mounted.current = false; controller.current?.abort(); };
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
      if (mounted.current) setStage("done");
    } catch {
      // Storage must be writable; network failures may still follow a commit.
      if (mounted.current) setStage("failed");
    } finally {
      controller.current = null;
      busy.current = false;
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center px-4 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Create your account</h1>
      {(stage === "ready" || stage === "working" || stage === "failed") && (
        <>
          <p className="mt-3 text-stone-600">
            {stage === "working" ? "Creating your account…" : "Create a private account with a passkey."}
          </p>
          {stage === "failed" && (
            <p role="alert" className="mt-4 text-red-700">
              We could not create your account. Try again, or sign in if your passkey was saved.
            </p>
          )}
          <form className="mt-8" onSubmit={createAccount}>
            <HoneypotField />
            <button type="submit" disabled={!hydrated || stage === "working"} className="rounded-md bg-stone-900 px-4 py-2 text-white disabled:opacity-60">
              {stage === "working" ? "Creating your account…" : "Create account"}
            </button>
          </form>
          {stage !== "working" && <Link className="mt-4 text-sm underline" to="/sign-in">Sign in</Link>}
        </>
      )}
      {stage === "phrase" && secrets && (
        <section className="mt-8">
          <h2 className="text-xl font-semibold">Save your recovery phrase</h2>
          <p className="mt-2">Write these 24 words down and keep them somewhere safe. They cannot be recovered for you.</p>
          <ol className="mt-4 grid grid-cols-2 gap-2 rounded-md border p-4 sm:grid-cols-3">
            {secrets.phrase.split(" ").map((word, index) => (
              <li key={index} className="font-mono text-sm"><span className="text-stone-500">{index + 1}. </span>{word}</li>
            ))}
          </ol>
          <form onSubmit={checkWords} className="mt-6 flex flex-col gap-3">
            <p>Verify your copy by entering these words:</p>
            {indices.map((index, position) => (
              <label key={index} className="flex items-center gap-3">
                <span className="w-20">Word {index + 1}</span>
                <input required autoComplete="off" spellCheck={false} className="min-w-0 flex-1 rounded border px-2 py-1"
                  value={words[position]} onChange={(event) => {
                    const updated = [...words];
                    updated[position] = event.target.value;
                    setWords(updated);
                  }} />
              </label>
            ))}
            {mismatch && <p role="alert" className="text-red-700">Those words do not match. Check your copy and try again.</p>}
            <button type="submit" className="self-start rounded-md bg-stone-900 px-4 py-2 text-white">Verify phrase</button>
          </form>
        </section>
      )}
      {stage === "codes" && secrets && (
        <section className="mt-8">
          <h2 className="text-xl font-semibold">Save your recovery codes</h2>
          <p className="mt-2">These ten one-time codes are shown only now. Store them separately from your recovery phrase and passkey. Add a second passkey in Account security when you finish.</p>
          <ol className="mt-4 space-y-2 rounded-md border p-4">
            {secrets.recoveryCodes.map((code, index) => <li key={index} className="break-all font-mono text-sm">{index + 1}. {code}</li>)}
          </ol>
          <button type="button" onClick={confirmCodes} className="mt-6 rounded-md bg-stone-900 px-4 py-2 text-white">
            I saved my phrase and codes
          </button>
        </section>
      )}
      {stage === "done" && <p className="mt-6">Your account is ready. Your recovery material will not be shown again. <Link to="/account/security" className="underline">Add a second passkey</Link>.</p>}
    </main>
  );
}
