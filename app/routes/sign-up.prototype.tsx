/**
 * THROWAWAY: three structurally different signup designs on /sign-up?variant=A|B|C.
 * Question: which presentation makes saving two different backups feel clear and worthwhile?
 * All material is fake. No authentication, crypto, storage, analytics, or API calls.
 * Kept only on prototype/signup-onboarding-ux; rewrite the selected design for production.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router";

import "./sign-up.prototype.css";

type Variant = "A" | "B" | "C";
type Step = "intro" | "phrase" | "confirm" | "codes" | "passkey" | "done";
const variants: Variant[] = ["A", "B", "C"];
const names = { A: "Field notes", B: "One thing at a time", C: "Recovery booklet" };
const steps: Step[] = ["intro", "phrase", "confirm", "codes", "passkey", "done"];
const stepNames = {
  intro: "Introduction", phrase: "Save phrase", confirm: "Confirm phrase",
  codes: "Save codes", passkey: "Passkey preview", done: "Completion",
};
// Deliberately non-secret sample material; not a usable recovery phrase or code set.
const phrase = "notebook meadow lantern river pebble window blossom cedar compass linen orchard morning copper harbor ribbon willow pocket canvas feather violet hillside teacup sunset paper".split(" ");
const positions = [3, 10, 20];
const codes = Array.from({ length: 10 }, (_, i) => `DEMO-${String(i + 1).padStart(2, "0")}-NOT-A-REAL-RECOVERY-CODE`);
const groups = ["Protect your files", "Keep account access", "Create your passkey"];
const copy: Record<Step, { eyebrow: string; title: string; description: string }> = {
  intro: {
    eyebrow: "A PRIVATE PLACE FOR YOUR WORDS",
    title: "A fresh page.\nEntirely yours.",
    description: "First, let’s give you a way back in. You’ll save two different backups, then create a passkey. No email. No password.",
  },
  phrase: {
    eyebrow: "01 / PROTECT YOUR FILES",
    title: "Keep a way back\nto your files.",
    description: "Write down all 24 words in this order. Keep your copy somewhere safe and offline. Next, we’ll check three words from it.",
  },
  confirm: {
    eyebrow: "01 / CHECK YOUR SAVED COPY",
    title: "Let’s check\nyour backup.",
    description: "Find these three words in the copy you just saved. This isn’t a memory test—we’ve put the phrase away so you can check your backup.",
  },
  codes: {
    eyebrow: "02 / KEEP ACCOUNT ACCESS",
    title: "A second backup.\nA different purpose.",
    description: "These codes get you back into your account if you lose your passkeys. Save all ten, separately from your recovery phrase. Each code works once.",
  },
  passkey: {
    eyebrow: "03 / CREATE YOUR PASSKEY",
    title: "Your backups are ready.\nNow, your passkey.",
    description: "Your device will help you create a passkey. Next time, it’s how you’ll sign in—without a password.",
  },
  done: {
    eyebrow: "YOU’RE ALL SET",
    title: "Make room\nfor your words.",
    description: "Your account is ready. Keep both backups safe: they won’t be shown again here. Add a second passkey for another way to sign in.",
  },
};

function Arrow({ back = false }: { back?: boolean }) {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d={back ? "M20 12H4m7-7-7 7 7 7" : "M4 12h16m-7-7 7 7-7 7"} /></svg>;
}
function Mark() {
  return <span className="proto-wordmark"><svg aria-hidden="true" viewBox="0 0 32 26" width="29" height="24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 22V5l7 8 7-8v17M25 4v16m-5-5 5 6 5-6" /></svg><span>mdwn</span></span>;
}
function Header({ booklet = false }: { booklet?: boolean }) {
  return <header className="proto-header"><Mark /><span>{booklet ? "THE RECOVERY EDITION" : "A little setup. A space of your own."}</span><span className="proto-header-note">Account setup <span aria-hidden="true">↗</span></span></header>;
}
function group(step: Step) { return step === "codes" ? 1 : step === "passkey" || step === "done" ? 2 : 0; }
function Progress({ step }: { step: Step }) {
  return <ol className="proto-progress" aria-label="Account setup progress">{groups.map((label, index) => <li key={label} className={index === group(step) ? "current" : index < group(step) ? "complete" : ""} aria-current={index === group(step) ? "step" : undefined}><span className="proto-progress-number">{index < group(step) ? "✓" : `0${index + 1}`}</span><span>{label}</span></li>)}</ol>;
}
function Heading({ step }: { step: Step }) {
  const content = copy[step];
  return <div className="proto-heading"><p className="proto-eyebrow">{content.eyebrow}</p><h1 tabIndex={-1} id="prototype-heading">{content.title}</h1><p className="proto-description">{content.description}</p></div>;
}
function ContextNote({ step }: { step: Step }) {
  return <aside className="proto-context"><span className="proto-context-icon" aria-hidden="true">↳</span><div><h2>{step === "codes" ? "Account access ≠ file access" : "Your files. Your keys."}</h2><p>{step === "codes" ? "A recovery code replaces a lost sign-in method. Your recovery phrase is the separate backup for your own encrypted files." : "Your phrase helps unlock your own files on a replacement device. You’ll also need access to your account. We can’t recover the phrase for you."}</p></div></aside>;
}

type LayoutProps = { step: Step; children: ReactNode };

export function VariantA({ step, children }: LayoutProps) {
  return <div className="proto-a"><Header /><div className="proto-a-layout"><aside className="proto-a-sidebar"><p className="proto-eyebrow">YOUR NEXT CHAPTER</p><h2>A space for you.<br />A way back in.</h2><Progress step={step} /><ContextNote step={step} /><p className="proto-sidebar-foot">Private by design.<br />Yours to keep.</p></aside><main className="proto-a-main"><Heading step={step} />{children}</main></div><footer className="proto-page-footer"><span>Small rituals. Lasting peace of mind.</span><span>No account is created until the final step.</span></footer></div>;
}

export function VariantB({ step, children }: LayoutProps) {
  return <div className="proto-b"><Header /><main className="proto-b-main"><Progress step={step} /><Heading step={step} />{children}<ContextNote step={step} /></main><span className="proto-b-folio" aria-hidden="true">{step === "done" ? "✓" : `0${group(step) + 1}`}</span><footer className="proto-page-footer"><span>One thing at a time.</span><span>Your account is created after your backups are saved.</span></footer></div>;
}

export function VariantC({ step, children }: LayoutProps) {
  return <div className="proto-c"><Header booklet /><div className="proto-book"><aside className="proto-book-left"><div className="proto-book-edition"><span>mdwn / getting started</span><span>№ 001</span></div><Heading step={step} /><ContextNote step={step} /><p className="proto-book-colophon">A small guide to keeping<br />what’s yours, yours.</p></aside><main className="proto-book-right"><div className="proto-book-page-label"><span>{stepNames[step]}</span><span>0{steps.indexOf(step) + 1} / 06</span></div>{children}</main></div><div className="proto-book-tabs"><Progress step={step} /></div><footer className="proto-page-footer"><span>Keep the backups. Close the booklet. Begin.</span><span>Account creation happens at the end.</span></footer></div>;
}

export default function SignupPrototype() {
  const [params, setParams] = useSearchParams();
  const rawVariant = params.get("variant");
  const variant: Variant = variants.find((value) => value === rawVariant) ?? "A";
  const step: Step = steps.find((value) => value === params.get("step")) ?? "phrase";
  const [answers, setAnswers] = useState(["", "", ""]);
  const [mismatch, setMismatch] = useState(false);
  const [phraseSaved, setPhraseSaved] = useState(false);
  const [phraseVerified, setPhraseVerified] = useState(false);
  const [codesSaved, setCodesSaved] = useState(false);
  const [passkeyCancelled, setPasskeyCancelled] = useState(false);
  const [nextNote, setNextNote] = useState(false);

  function go(next: Step) {
    setAnswers(["", "", ""]);
    setMismatch(false);
    setPasskeyCancelled(false);
    setNextNote(false);
    if (next === "intro" || next === "phrase") { setPhraseSaved(false); setPhraseVerified(false); setCodesSaved(false); }
    setParams({ variant, step: next }, { replace: true, preventScrollReset: true });
  }
  function cycle(direction: number) {
    const next = variants[(variants.indexOf(variant) + direction + variants.length) % variants.length]!;
    setParams({ variant: next, step }, { replace: true, preventScrollReset: true });
  }
  useEffect(() => {
    document.getElementById("prototype-heading")?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [step, variant]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); cycle(event.key === "ArrowLeft" ? -1 : 1); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const state = { variant, screen: step, phraseSaved, phraseVerified, codesSaved, passkeyCancelled, realAccountCreated: false };
  useEffect(() => { console.info("[THROWAWAY signup prototype]", state); }, [variant, step, phraseSaved, phraseVerified, codesSaved, passkeyCancelled]);

  function verify(event: FormEvent) {
    event.preventDefault();
    if (!positions.every((position, index) => answers[index]!.trim().toLowerCase() === phrase[position])) { setMismatch(true); return; }
    setPhraseVerified(true);
    go("codes");
  }
  const next = (label: string, destination: Step, disabled = false) => <button type="button" className="proto-primary" disabled={disabled} onClick={() => go(destination)}>{label}<Arrow /></button>;

  let content: ReactNode;
  if (step === "intro") {
    content = <div className="proto-intro"><div className="proto-intro-list"><div><span>01</span><h2>A backup for your files</h2><p>A 24-word recovery phrase. Save it, then check your copy.</p></div><div><span>02</span><h2>A backup for your account</h2><p>Ten one-use codes, in case you lose access to your passkeys.</p></div><div><span>03</span><h2>A simpler way to sign in</h2><p>A passkey, created and kept by your device or password manager.</p></div></div><div className="proto-actions">{next("Let’s get started", "phrase")}<p className="proto-small">Have somewhere safe to write down your backups.</p></div></div>;
  } else if (step === "phrase") {
    content = <div><div className="proto-material-header"><h2>Your recovery phrase</h2><span>24 words · keep in order</span></div><ol className="proto-phrase" aria-label="Example recovery phrase">{phrase.map((word, index) => <li key={index}><span>{String(index + 1).padStart(2, "0")}</span><strong>{word}</strong></li>)}</ol><p className="proto-material-note"><span aria-hidden="true">↳</span> Keep your copy private. We won’t ask you to send it to us.</p><div className="proto-actions"><button className="proto-primary" onClick={() => { setPhraseSaved(true); go("confirm"); }}>I’ve saved these words<Arrow /></button><p className="proto-small">Next: check three words from your saved copy.</p></div></div>;
  } else if (step === "confirm") {
    content = <form className="proto-confirm" onSubmit={verify}><div className="proto-backup-away"><svg aria-hidden="true" width="24" height="28" viewBox="0 0 24 28" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="3" y="2" width="18" height="24" rx="2" /><path d="M7 8h10M7 12h10M7 16h5M16 20l2 2 4-4" /></svg><div><strong>Your phrase is put away.</strong><p>Use the copy you saved, wherever you kept it.</p></div></div><div className="proto-word-inputs">{positions.map((position, index) => <label key={position} htmlFor={`proto-word-${position}`}><span>Word {position + 1}</span><input id={`proto-word-${position}`} autoComplete="off" autoCapitalize="none" spellCheck={false} required value={answers[index]} aria-invalid={mismatch || undefined} aria-describedby={mismatch ? "proto-word-error" : undefined} onChange={(event) => setAnswers((current) => current.map((value, i) => i === index ? event.target.value : value))} /></label>)}</div>{mismatch && <p className="proto-error" role="alert" id="proto-word-error">Those words don’t match. Check their positions in your saved copy and try again.</p>}<div className="proto-actions"><button type="submit" className="proto-primary">Confirm my saved phrase<Arrow /></button><button className="proto-text-button" type="button" onClick={() => go("phrase")}><Arrow back />Go back and review the phrase</button></div></form>;
  } else if (step === "codes") {
    content = <div><div className="proto-material-header"><h2>Your account recovery codes</h2><span>Use each code once</span></div><ol className="proto-codes" aria-label="Example recovery codes">{codes.map((code, index) => <li key={code}><span>{String(index + 1).padStart(2, "0")}</span><code>{code}</code></li>)}</ol><label className="proto-check"><input type="checkbox" checked={codesSaved} onChange={(event) => setCodesSaved(event.target.checked)} /><span>I’ve saved these codes separately from my recovery phrase.</span></label><div className="proto-actions">{next("Create account with a passkey", "passkey", !codesSaved)}<p className="proto-small">Your device will guide you through the final step.</p></div></div>;
  } else if (step === "passkey") {
    content = <div className="proto-passkey"><div className="proto-passkey-symbol" aria-hidden="true"><svg width="58" height="58" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="19" cy="18" r="10" /><circle cx="17" cy="16" r="2" /><path d="m26 25 13 13h5v-5l-4-1-1-4-4-1-2-3" /></svg></div><h2>{passkeyCancelled ? "No rush. Try again when you’re ready." : "A passkey for mdwn"}</h2><p>{passkeyCancelled ? "This preview simulates cancelling the device prompt. No account or credential was created." : "In the real flow, your browser’s passkey prompt appears here. This preview never opens your authenticator."}</p><div className="proto-prompt-preview"><span className="proto-eyebrow">SIMULATED DEVICE PROMPT</span><strong>Save a passkey for mdwn?</strong><span>Use your device or password manager.</span><button className="proto-primary" onClick={() => go("done")}>Simulate passkey saved<Arrow /></button><button className="proto-text-button" onClick={() => setPasskeyCancelled(true)}>Simulate cancellation</button></div></div>;
  } else {
    content = <div className="proto-done"><div className="proto-done-check" aria-hidden="true">✓</div><div className="proto-done-receipt"><p><span>File recovery phrase</span><strong>Saved & checked</strong></p><p><span>Account recovery codes</span><strong>Saved separately</strong></p><p><span>Your first passkey</span><strong>Ready</strong></p></div><div className="proto-actions"><button className="proto-primary" onClick={() => setNextNote(true)}>Add a second passkey<Arrow /></button>{nextNote && <p className="proto-small" role="status">The real flow opens Account security. That screen is outside this mockup.</p>}<button className="proto-text-button" onClick={() => go("intro")}>Restart this preview</button></div></div>;
  }
  const Layout = variant === "B" ? VariantB : variant === "C" ? VariantC : VariantA;
  return <div className={`signup-prototype variant-${variant.toLowerCase()}`}><div className="proto-disclaimer"><span>DESIGN STUDY / 35</span><span>Fake examples only. No account, real keys, or network signup.</span></div><Layout step={step}>{content}</Layout><PrototypeSwitcher variant={variant} step={step} cycle={cycle} go={go} state={state} /></div>;
}

function PrototypeSwitcher({ variant, step, cycle, go, state }: {
  variant: Variant; step: Step; cycle: (direction: number) => void; go: (step: Step) => void; state: object;
}) {
  if (!import.meta.env.DEV) return null;
  return <nav className="proto-switcher" aria-label="Prototype controls"><span className="proto-switcher-label">MOCKUP</span><button aria-label="Previous design" onClick={() => cycle(-1)}><Arrow back /></button><span className="proto-switcher-name"><b>{variant}</b><span>{names[variant]}</span></span><button aria-label="Next design" onClick={() => cycle(1)}><Arrow /></button><span className="proto-switcher-separator" /><label><span className="sr-only">Preview screen</span><select value={step} onChange={(event) => go(event.target.value as Step)}>{steps.map((value) => <option key={value} value={value}>{stepNames[value]}</option>)}</select></label><details className="proto-state"><summary>State</summary><pre>{JSON.stringify(state, null, 2)}</pre></details></nav>;
}
